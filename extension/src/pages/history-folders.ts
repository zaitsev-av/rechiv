import type { SttApiClient } from "@shared/api-client";
import type { Folder, SessionInfo } from "@shared/types";
import { formatDateTime, plural } from "@shared/utils";

const linkIcon =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/></svg>';
const STORAGE_KEY = "history-folder";
const SESSION_MIME = "application/x-rechiv-session";
const folderIcon =
  '<svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M3 7.5A2.5 2.5 0 0 1 5.5 5h3.6l2 2.2h7.4A2.5 2.5 0 0 1 21 9.7v7.8a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z"/></svg>';

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text = "") {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
}
function button(text: string, action: () => void, className = "folder-menu-item") {
  const node = element("button", className, text);
  node.type = "button";
  node.addEventListener("click", action);
  return node;
}
function color(node: HTMLElement, folder: Pick<Folder, "color">) {
  node.style.setProperty("--folder-fg", `var(--speaker-${folder.color}-fg)`);
  node.style.setProperty("--folder-bg", `var(--speaker-${folder.color}-bg)`);
}

export class HistoryFolders {
  current = "all";
  folders: Folder[] = [];
  sessions: SessionInfo[] = [];
  private menu: HTMLElement | null = null;
  private trigger: HTMLButtonElement | null = null;
  private menuSession = "";
  private restoreTriggerFocus = false;
  private dialog: HTMLDialogElement | null = null;
  private draggedSession: SessionInfo | null = null;
  private dropTarget: HTMLElement | null = null;

  constructor(
    private api: SttApiClient,
    private refresh: () => Promise<void>,
    private interactionChanged: () => void = () => undefined,
  ) {
    try {
      this.current = localStorage.getItem(STORAGE_KEY) || "all";
    } catch {
      /* Хранилище может быть отключено. */
    }
    document.getElementById("new-folder")?.addEventListener("click", () => this.nameDialog());
    document.getElementById("folder-actions")?.addEventListener("click", (event) => {
      const folder = this.folder(this.current);
      if (folder) this.folderMenu(event.currentTarget as HTMLButtonElement, folder);
    });
    document.addEventListener("click", (event) => {
      const target = event.target as Node;
      if (this.menu && !this.menu.contains(target) && !this.trigger?.contains(target))
        this.closeMenu(false);
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && this.menu) {
        event.preventDefault();
        this.closeMenu();
      }
    });
    window.addEventListener("resize", () => this.positionMenu());
    window.addEventListener("scroll", () => this.positionMenu(), true);
  }

  folder(id?: string) {
    return this.folders.find((folder) => folder.id === id);
  }
  get paused() {
    return !!this.draggedSession || !!this.menu;
  }
  visible() {
    return this.sessions.filter(
      (session) =>
        this.current === "all" ||
        (this.current === "inbox"
          ? !this.folder(session.folderId)
          : session.folderId === this.current),
    );
  }
  update(folders: Folder[], sessions: SessionInfo[]) {
    this.restoreTriggerFocus = !!this.trigger && document.activeElement === this.trigger;
    this.folders = folders;
    this.sessions = sessions;
    if (this.current !== "all" && this.current !== "inbox" && !this.folder(this.current))
      this.select("all", false);
    this.renderNavigation();
    this.renderHead();
  }
  private select(id: string, refresh = true) {
    this.current = id;
    try {
      localStorage.setItem(STORAGE_KEY, id);
    } catch {
      /* Хранилище может быть отключено. */
    }
    this.closeMenu(false);
    if (refresh) void this.refresh();
  }
  private renderNavigation() {
    const nav = document.getElementById("folders");
    if (!nav) return;
    const focused = (document.activeElement as HTMLElement | null)?.dataset.folder;
    nav.replaceChildren();
    const items = [
      { id: "all", name: "Все созвоны" },
      { id: "inbox", name: "Входящие" },
      ...this.folders,
    ];
    for (const item of items) {
      const f = this.folder(item.id);
      const node = button("", () => this.select(item.id), "folder-nav-item");
      node.dataset.folder = item.id;
      this.setupDrop(node, item.id);
      if (this.current === item.id) node.setAttribute("aria-current", "page");
      const name = element("span", "folder-name");
      name.append(element("span", "folder-dot"), document.createTextNode(item.name));
      if (f) color(node, f);
      if (f?.rules.length) {
        const rule = element("span", "folder-rule-icon");
        rule.innerHTML = linkIcon;
        rule.title = "Есть правило по ссылке";
        name.append(rule);
      }
      const count = this.sessions.filter(
        (s) =>
          item.id === "all" ||
          (item.id === "inbox" ? !this.folder(s.folderId) : s.folderId === item.id),
      ).length;
      node.append(name, element("span", "folder-count", String(count)));
      nav.append(node);
      if (focused === item.id) node.focus();
    }
  }
  private renderHead() {
    const folder = this.folder(this.current);
    const title = document.getElementById("history-title");
    if (title) {
      title.replaceChildren();
      if (folder) {
        const icon = element("span", "folder-title-icon");
        icon.innerHTML = folderIcon;
        color(icon, folder);
        title.append(icon);
      }
      title.append(
        document.createTextNode(
          folder?.name ?? (this.current === "inbox" ? "Входящие" : "Все созвоны"),
        ),
      );
    }
    const eyebrow = document.getElementById("history-eyebrow");
    if (eyebrow) eyebrow.hidden = !!folder;
    const copy = document.querySelector<HTMLElement>(".hero-copy");
    if (copy) copy.hidden = !!folder;
    const actions = document.getElementById("folder-actions");
    if (actions) actions.hidden = !folder;
    const banner = document.getElementById("folder-banner");
    if (!banner) return;
    banner.replaceChildren();
    if (folder) {
      const rules = element("section", "folder-rules");
      rules.setAttribute("aria-label", "Правила папки");
      rules.append(element("span", "rules-label", "↗ Новые записи по ссылке попадают сюда сами"));
      for (const rule of folder.rules) {
        const chip = element("span", "folder-rule", rule.url);
        const remove = button(
          "×",
          () =>
            this.run(async () => {
              await this.api.deleteFolderRule(folder.id, rule.url);
            }),
          "remove-rule",
        );
        remove.setAttribute("aria-label", `Удалить правило ${rule.url}`);
        chip.append(remove);
        rules.append(chip);
      }
      if (!folder.rules.length)
        rules.append(
          element("span", "folder-hint", "Правил нет. Включите его в меню «⋯» у созвона."),
        );
      banner.append(rules);
    } else if (this.current === "inbox") {
      banner.append(
        element(
          "div",
          "inbox-note",
          "Здесь созвоны без папки. Перенесите созвон через «⋯», там же можно включить правило для его ссылки.",
        ),
      );
    }
  }
  decorate(session: SessionInfo, details: HTMLElement, card: HTMLElement) {
    this.setupDrag(card, session);
    const folder = this.folder(session.folderId);
    if (this.current === "all") {
      const chip = element("span", "folder-chip", folder?.name ?? "Входящие");
      if (folder) color(chip, folder);
      details.append(chip);
    } else if (folder && session.folderByRule)
      details.append(element("span", "folder-hint", "↗ по правилу"));
    const more = button("⋯", () => this.sessionMenu(more, session), "session-more");
    more.dataset.sessionMenu = session.sessionId;
    more.setAttribute("aria-label", "Действия с созвоном");
    more.setAttribute("aria-haspopup", "menu");
    more.setAttribute("aria-expanded", String(this.menuSession === session.sessionId));
    more.addEventListener("click", (event) => event.stopPropagation());
    card.append(more);
    if (this.menu && this.menuSession === session.sessionId) {
      this.trigger = more;
      card.classList.add("menu-open");
    }
  }
  afterRender() {
    if (this.restoreTriggerFocus) {
      this.trigger?.focus();
      this.restoreTriggerFocus = false;
    }
    if (this.menu && !this.trigger?.isConnected) this.closeMenu(false);
    this.positionMenu();
  }
  private setupDrag(card: HTMLElement, session: SessionInfo) {
    card.draggable = true;
    let blocked = false;
    let suppressClick = false;
    const isControl = (target: EventTarget | null) =>
      target instanceof Element &&
      !!target.closest('button, input, textarea, select, a, [contenteditable="true"]');
    // У dragstart целью бывает карточка, даже если мышь нажали на кнопку.
    card.addEventListener("mousedown", (event) => {
      blocked = isControl(event.target);
      suppressClick = false;
    });
    card.addEventListener("keydown", () => {
      suppressClick = false;
    });
    card.addEventListener(
      "click",
      (event) => {
        if (!suppressClick) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        suppressClick = false;
      },
      true,
    );
    card.addEventListener("dragstart", (event) => {
      if (!card.draggable || blocked || isControl(event.target) || !event.dataTransfer) {
        event.preventDefault();
        return;
      }
      this.draggedSession = session;
      suppressClick = true;
      event.dataTransfer.setData(SESSION_MIME, session.sessionId);
      event.dataTransfer.setData("text/plain", session.sessionId);
      event.dataTransfer.effectAllowed = "move";
      // Снимок всей карточки закрывает панель папок; за курсором тянется компактная плашка.
      const ghost = element("div", "drag-ghost");
      ghost.append(
        element("span", "drag-ghost-date", formatDateTime(new Date(session.createdAt)).date),
        element(
          "span",
          "drag-ghost-title",
          card.querySelector(".session-title")?.textContent?.trim() ||
            session.title ||
            "Без названия",
        ),
      );
      document.body.append(ghost);
      event.dataTransfer.setDragImage(ghost, 16, ghost.offsetHeight / 2);
      setTimeout(() => ghost.remove());
      card.classList.add("dragging");
      this.markDropTargets(session);
      this.closeMenu(false);
      this.interactionChanged();
    });
    card.addEventListener("dragend", () => {
      if (this.draggedSession !== session) return;
      this.draggedSession = null;
      card.classList.remove("dragging");
      this.markDropTargets(null);
      this.clearDropTarget();
      this.interactionChanged();
    });
  }
  private markDropTargets(session: SessionInfo | null) {
    document.querySelector(".folder-sidebar")?.classList.toggle("drop-ready", !!session);
    const from = session ? (this.folder(session.folderId)?.id ?? "") : "";
    for (const node of document.querySelectorAll<HTMLElement>(".folder-nav-item")) {
      const id = node.dataset.folder ?? "";
      const target = id === "inbox" ? "" : id;
      node.classList.toggle("drop-denied", !!session && (id === "all" || target === from));
    }
  }
  private clearDropTarget() {
    this.dropTarget?.classList.remove("drag-over");
    this.dropTarget = null;
  }
  private setupDrop(node: HTMLButtonElement, id: string) {
    const folderId = id === "inbox" ? "" : id;
    const accepts = (event: DragEvent) =>
      !!this.draggedSession &&
      !!event.dataTransfer?.types.includes(SESSION_MIME) &&
      id !== "all" &&
      (this.folder(this.draggedSession.folderId)?.id ?? "") !== folderId;
    const over = (event: DragEvent) => {
      const accepted = accepts(event);
      if (event.dataTransfer) event.dataTransfer.dropEffect = accepted ? "move" : "none";
      if (!accepted) {
        this.clearDropTarget();
        return;
      }
      event.preventDefault();
      if (this.dropTarget !== node) this.clearDropTarget();
      this.dropTarget = node;
      node.classList.add("drag-over");
    };
    node.addEventListener("dragenter", over);
    node.addEventListener("dragover", over);
    node.addEventListener("dragleave", (event) => {
      if (event.relatedTarget instanceof Node && node.contains(event.relatedTarget)) return;
      if (this.dropTarget === node) this.clearDropTarget();
    });
    node.addEventListener("drop", (event) => {
      this.markDropTargets(null);
      this.clearDropTarget();
      if (!accepts(event)) return;
      event.preventDefault();
      event.stopPropagation();
      const session = this.draggedSession!;
      if (event.dataTransfer!.getData(SESSION_MIME) !== session.sessionId) return;
      this.moveSession(session, folderId);
    });
  }
  private moveSession(session: SessionInfo, folderId: string) {
    this.run(async () => {
      await this.api.moveSession(session.sessionId, folderId);
      this.closeMenu();
    });
  }
  private openMenu(trigger: HTMLButtonElement, sessionID = "") {
    if (this.menu && this.trigger === trigger) {
      this.closeMenu();
      return null;
    }
    this.closeMenu(false);
    this.trigger = trigger;
    this.menuSession = sessionID;
    trigger.setAttribute("aria-expanded", "true");
    trigger.closest(".session-card")?.classList.add("menu-open");
    const menu = element("div", "folder-menu");
    menu.setAttribute("role", "menu");
    menu.setAttribute("aria-label", sessionID ? "Действия с созвоном" : "Действия с папкой");
    menu.addEventListener("keydown", (event) => {
      const items = Array.from(
        menu.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled)"),
      );
      const index = items.indexOf(document.activeElement as HTMLElement);
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        items[(index + (event.key === "ArrowDown" ? 1 : items.length - 1)) % items.length]?.focus();
      }
      if (event.key === "Tab") this.closeMenu(false);
    });
    this.menu = menu;
    document.body.append(menu);
    this.interactionChanged();
    return menu;
  }
  private finishMenu() {
    this.menu?.querySelectorAll("button").forEach((item) => {
      item.setAttribute("role", "menuitem");
    });
    this.positionMenu();
    this.menu?.querySelector<HTMLElement>("button")?.focus();
  }
  private positionMenu() {
    if (!this.menu || !this.trigger) return;
    const rect = this.trigger.getBoundingClientRect();
    const height = this.menu.offsetHeight;
    const width = this.menu.offsetWidth;
    this.menu.style.left = `${Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8))}px`;
    this.menu.style.top = `${Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - height - 8))}px`;
  }
  private closeMenu(focus = true) {
    const wasOpen = !!this.menu;
    this.menu?.remove();
    this.menu = null;
    this.menuSession = "";
    this.trigger?.setAttribute("aria-expanded", "false");
    this.trigger?.closest(".session-card")?.classList.remove("menu-open");
    if (focus) this.trigger?.focus();
    this.trigger = null;
    if (wasOpen) this.interactionChanged();
  }
  private sessionMenu(trigger: HTMLButtonElement, session: SessionInfo) {
    const menu = this.openMenu(trigger, session.sessionId);
    if (!menu) return;
    menu.append(element("div", "eyebrow", "Перенести в папку"));
    const target = this.folder(session.folderId);
    for (const item of [...this.folders, { id: "", name: "Входящие", color: -1 }]) {
      const move = button(`${item.name}${(target?.id ?? "") === item.id ? " ✓" : ""}`, () =>
        this.moveSession(session, item.id),
      );
      const dot = element("span", "folder-dot");
      if (item.color >= 0) color(dot, item);
      move.prepend(dot);
      move.dataset.moveTo = item.id;
      menu.append(move);
    }
    const owner = this.folders.find((f) => f.rules.some((rule) => rule.url === session.callKey));
    const label = element("label", "rule-toggle");
    const toggle = element("input", "");
    toggle.type = "checkbox";
    toggle.checked = !!target && owner?.id === target.id;
    toggle.disabled = !target || !session.callKey;
    toggle.setAttribute("role", "menuitemcheckbox");
    toggle.setAttribute("aria-checked", String(toggle.checked));
    const copy = element("span", "");
    copy.append(
      element(
        "b",
        "",
        `Класть созвоны по этой ссылке ${target ? `в «${target.name}»` : "в папку"}`,
      ),
    );
    copy.append(element("code", "", session.callKey || "Нет корректной ссылки"));
    if (!target) copy.append(element("span", "folder-hint", "Сначала выберите папку"));
    if (owner && owner.id !== target?.id)
      copy.append(element("span", "folder-hint", `Сейчас правило ведёт в «${owner.name}»`));
    label.append(toggle, copy);
    menu.append(label);
    toggle.addEventListener("change", () => {
      if (!target || !session.callKey) return;
      const enabled = toggle.checked;
      toggle.disabled = true;
      this.run(
        async () => {
          if (enabled) {
            const result = await this.api.addFolderRule(target.id, session.callKey!);
            this.closeMenu();
            if (result.matching.length)
              this.askPast(result.folder, session.callKey!, result.matching, trigger);
          } else {
            await this.api.deleteFolderRule(target.id, session.callKey!);
            this.closeMenu();
          }
        },
        () => {
          toggle.checked = !enabled;
          toggle.disabled = false;
        },
      );
    });
    menu.append(
      button(
        "Удалить запись",
        () => {
          if (!confirm("Удалить эту запись?")) return;
          this.run(async () => {
            await this.api.deleteSession(session.sessionId);
            this.closeMenu();
          });
        },
        "folder-menu-item danger",
      ),
    );
    this.finishMenu();
  }
  private folderMenu(trigger: HTMLButtonElement, folder: Folder) {
    const menu = this.openMenu(trigger);
    if (!menu) return;
    menu.append(
      button("Настройки папки", () => {
        this.closeMenu();
        this.settingsDialog(folder);
      }),
    );
    menu.append(
      button("Переименовать", () => {
        this.closeMenu();
        this.nameDialog(folder);
      }),
    );
    menu.append(
      button(
        "Удалить папку",
        () => {
          if (!confirm(`Удалить папку «${folder.name}»? Созвоны останутся во «Входящих».`)) return;
          this.run(async () => {
            await this.api.deleteFolder(folder.id);
            this.select("all", false);
          });
        },
        "folder-menu-item danger",
      ),
    );
    this.finishMenu();
  }
  private createDialog(title: string, trigger?: HTMLElement) {
    const dialog = element("dialog", "folder-dialog");
    const heading = element("h2", "", title);
    heading.id = "folder-dialog-title";
    dialog.setAttribute("aria-labelledby", heading.id);
    dialog.setAttribute("aria-modal", "true");
    dialog.append(heading);
    this.dialog = dialog;
    document.body.append(dialog);
    dialog.addEventListener("close", () => {
      dialog.remove();
      this.dialog = null;
      const sessionTrigger = Array.from(
        document.querySelectorAll<HTMLElement>("[data-session-menu]"),
      ).find((node) => node.dataset.sessionMenu === trigger?.dataset.sessionMenu);
      if (trigger?.isConnected) trigger.focus();
      else if (sessionTrigger) sessionTrigger.focus();
      else document.querySelector<HTMLElement>('.folder-nav-item[aria-current="page"]')?.focus();
    });
    dialog.showModal();
    return dialog;
  }
  private settingsDialog(folder: Folder) {
    if (this.dialog) return;
    const dialog = this.createDialog(
      `Настройки «${folder.name}»`,
      document.getElementById("folder-actions") ?? undefined,
    );
    dialog.classList.add("folder-settings");
    const icon = element("span", "folder-title-icon");
    icon.innerHTML = folderIcon;
    color(icon, folder);
    dialog.querySelector("h2")?.prepend(icon);
    dialog.append(
      element("p", "", "Применяются к созвонам, которые попадают в папку по правилу ссылки."),
    );
    const form = element("form", "");
    const titleSection = element("section", "folder-settings-section");
    const label = element("label", "folder-field", "Шаблон названия новых созвонов");
    const input = element("input", "folder-template-input");
    input.id = "folder-title-template";
    input.autocomplete = "off";
    input.spellcheck = false;
    input.value = folder.settings?.titleTemplate ?? "";
    label.htmlFor = input.id;
    let llmConfigured = false;
    const chips = element("div", "folder-template-chips");
    const llmHint = element(
      "p",
      "folder-hint folder-llm-hint",
      "Тема созвона и автосаммари доступны после подключения LLM — ",
    );
    const settingsLink = element("a", "", "настройки Rechiv");
    settingsLink.href = "settings.html";
    llmHint.append(settingsLink);
    const previewHint = element("p", "folder-hint");
    const preview = element("div", "folder-title-preview");
    const now = new Date();
    const date = now.toLocaleDateString("ru-RU");
    const example = element("span", "folder-preview-value");
    preview.append(element("span", "folder-preview-date", date), example);
    const applyNotice = element("div", "folder-notice info");
    applyNotice.hidden = true;
    applyNotice.setAttribute("aria-live", "polite");
    const savedHint = element("small", "folder-hint");
    const apply = button(
      "Применить к созвонам папки",
      () => {
        apply.disabled = true;
        const template = input.value;
        this.run(async () => {
          const result = await this.api.previewFolderTitles(folder.id);
          if (!dialog.open || input.value !== template) return;
          applyNotice.replaceChildren();
          applyNotice.hidden = false;
          const total = this.sessions.filter((s) => s.folderId === folder.id).length;
          applyNotice.append(
            element(
              "div",
              "",
              result.renamed.length
                ? `Изменится ${result.renamed.length} из ${total} созвонов.`
                : "Менять нечего: автоматические названия уже соответствуют шаблону.",
            ),
          );
          if (result.manual.length) {
            applyNotice.append(
              element("div", "folder-hint", "Названы вручную и останутся как есть:"),
            );
            const list = element("ul", "folder-manual-titles");
            for (const id of result.manual) {
              list.append(
                element("li", "", this.sessions.find((s) => s.sessionId === id)?.title || id),
              );
            }
            applyNotice.append(list);
          }
          if (result.renamed.length) {
            const actions = element("div", "dialog-actions");
            const confirm = button(
              `Переименовать ${result.renamed.length}`,
              () => {
                confirm.disabled = true;
                this.run(
                  async () => {
                    const result = await this.api.applyFolderTitles(folder.id);
                    applyNotice.replaceChildren(
                      element("div", "", `Переименовано созвонов: ${result.renamed}.`),
                    );
                  },
                  () => {
                    confirm.disabled = false;
                  },
                );
              },
              "folder-button primary",
            );
            actions.append(
              confirm,
              button(
                "Отмена",
                () => {
                  applyNotice.hidden = true;
                },
                "folder-button",
              ),
            );
            applyNotice.append(actions);
          }
          syncTemplate();
        }, syncTemplate);
      },
      "folder-button",
    );
    const syncTemplate = () => {
      for (const chip of chips.querySelectorAll<HTMLButtonElement>("button")) {
        const noLlm = chip.dataset.token === "{topic}" && !llmConfigured;
        const used = input.value.includes(chip.dataset.token!);
        chip.disabled = noLlm || used;
        chip.title = noLlm
          ? "Нужно подключить LLM в настройках Rechiv"
          : used
            ? "Уже есть в шаблоне"
            : "";
      }
      const rendered =
        input.value
          .trim()
          .replaceAll("{date}", date)
          .replaceAll(
            "{time}",
            now.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" }),
          )
          .replaceAll("{weekday}", now.toLocaleDateString("ru-RU", { weekday: "long" })) ||
        "— название не ставится —";
      example.replaceChildren();
      const parts = rendered.split("{topic}");
      parts.forEach((part, index) => {
        example.append(document.createTextNode(part));
        if (index < parts.length - 1)
          example.append(element("span", "folder-preview-topic", "релиз 3.2, блокер по API"));
      });
      previewHint.textContent = input.value.includes("{topic}")
        ? "Тема появится после готовности транскрипта; до этого название без неё. Ручные названия не меняются."
        : "Созвоны, переименованные вручную, шаблон не меняет. Пустой шаблон — название не ставится.";
      const unsaved = input.value.trim() !== (folder.settings?.titleTemplate ?? "");
      apply.disabled = unsaved || !input.value.trim();
      savedHint.textContent = unsaved
        ? "Сначала сохраните шаблон, затем примените его к прошлым созвонам."
        : "Только с автоматическим названием";
    };
    for (const [token, text] of [
      ["{date}", "+ дата"],
      ["{time}", "+ время"],
      ["{weekday}", "+ день недели"],
      ["{topic}", "✦ тема созвона"],
    ]) {
      const chip = button(
        text,
        () => {
          const start = input.selectionStart ?? input.value.length;
          const end = input.selectionEnd ?? start;
          const before = input.value.slice(0, start);
          const after = input.value.slice(end);
          let inserted = `${before && !/\s$/.test(before) ? " " : ""}${token}${after && !/^\s/.test(after) ? " " : ""}`;
          if (token === "{topic}") {
            if (before.trim() && !/[—,:-]\s*$/.test(before)) {
              inserted = `${/\s$/.test(before) ? "" : " "}— ${token}${after && !/^\s/.test(after) ? " " : ""}`;
            } else if (!before.trim() && after.trim() && !/^\s*[—,:-]/.test(after)) {
              inserted = `${token} —${/^\s/.test(after) ? "" : " "}`;
            }
          }
          input.value = before + inserted + after;
          input.focus();
          input.setSelectionRange(start + inserted.length, start + inserted.length);
          applyNotice.hidden = true;
          syncTemplate();
        },
        "folder-template-chip",
      );
      chip.dataset.token = token;
      chips.append(chip);
    }
    input.addEventListener("input", () => {
      applyNotice.hidden = true;
      syncTemplate();
    });
    const past = element("div", "folder-settings-row folder-settings-past");
    const pastCopy = element("span", "folder-field", "Прошлые созвоны папки");
    pastCopy.append(savedHint);
    past.append(pastCopy, apply);
    titleSection.append(
      element("h3", "", "Название"),
      label,
      input,
      chips,
      llmHint,
      preview,
      previewHint,
      past,
      applyNotice,
    );

    const recording = element("section", "folder-settings-section");
    const switchRow = (title: string, hint: string, initial: boolean) => {
      let value = initial;
      const row = element("div", "folder-settings-row");
      const copy = element("span", "folder-field", title);
      copy.append(element("small", "folder-hint", hint));
      const toggle = button(
        "",
        () => {
          value = !value;
          toggle.setAttribute("aria-checked", String(value));
        },
        "folder-switch",
      );
      toggle.setAttribute("role", "switch");
      toggle.setAttribute("aria-label", title);
      toggle.setAttribute("aria-checked", String(value));
      row.append(copy, toggle);
      return { row, value: () => value };
    };
    const autoRecord = switchRow(
      "Записывать автоматически",
      folder.rules.length
        ? "При входе в созвон по ссылке папки"
        : "Сработает, когда у папки появится ссылка созвона",
      folder.settings?.autoRecord ?? false,
    );
    const livePanel = switchRow(
      "Показывать live-транскрипт",
      "Панель поверх звонка при начале записи",
      folder.settings?.livePanel ?? false,
    );
    recording.append(element("h3", "", "Запись"), autoRecord.row, livePanel.row);

    const summary = element("section", "folder-settings-section");
    const summaryRow = element("div", "folder-settings-row");
    const summaryCopy = element("span", "folder-field", "Делать саммари автоматически");
    summaryCopy.append(element("small", "folder-hint", "После готовности транскрипта"));
    let autoSummary = folder.settings?.autoSummary ?? false;
    const summaryToggle = button(
      "",
      () => {
        autoSummary = !autoSummary;
        summaryToggle.setAttribute("aria-checked", String(autoSummary));
      },
      "folder-switch",
    );
    summaryToggle.setAttribute("role", "switch");
    summaryToggle.setAttribute("aria-label", "Делать саммари автоматически");
    summaryToggle.setAttribute("aria-checked", String(autoSummary));
    summaryToggle.disabled = true;
    summaryRow.append(summaryCopy, summaryToggle);
    summary.append(element("h3", "", "Саммари"), summaryRow);
    void this.api
      .getLlmSettings()
      .then((llm) => {
        if (!dialog.open) return;
        llmConfigured = llm.configured;
        summaryToggle.disabled = !llmConfigured;
        llmHint.hidden = llmConfigured;
        syncTemplate();
      })
      .catch(() => undefined);

    const retention = element("section", "folder-settings-section");
    const row = element("div", "folder-settings-row");
    const copy = element("span", "folder-field", "Удалять старые записи");
    copy.append(element("small", "folder-hint", "Записи в работе не удаляются"));
    let enabled = (folder.settings?.retentionDays ?? 0) > 0;
    const toggle = button(
      "",
      () => {
        enabled = !enabled;
        syncRetention();
      },
      "folder-switch",
    );
    toggle.setAttribute("role", "switch");
    toggle.setAttribute("aria-label", "Удалять старые записи");
    const daysLabel = element("label", "folder-retention-days", "Старше ");
    const days = element("input", "");
    days.type = "number";
    days.min = "1";
    days.step = "1";
    days.required = true;
    days.value = String(folder.settings?.retentionDays || 30);
    days.setAttribute("aria-label", "Срок хранения в днях");
    daysLabel.append(days, document.createTextNode(" дней"));
    const warning = element("div", "folder-notice warn");
    warning.setAttribute("aria-live", "polite");
    let timer: ReturnType<typeof setTimeout> | undefined;
    let revision = 0;
    const syncRetention = () => {
      toggle.setAttribute("aria-checked", String(enabled));
      days.disabled = !enabled;
      clearTimeout(timer);
      const request = ++revision;
      warning.hidden = !enabled;
      warning.textContent = "";
      if (!enabled || !days.checkValidity()) return;
      const value = Number(days.value);
      warning.textContent = "Проверяем срок хранения…";
      timer = setTimeout(async () => {
        try {
          const result = await this.api.previewFolderRetention(folder.id, value);
          if (request !== revision || !dialog.open) return;
          warning.textContent = result.sessions.length
            ? `После сохранения сразу удалится ${result.sessions.length} ${plural(result.sessions.length, "созвон", "созвона", "созвонов")} старше ${value} ${plural(value, "дня", "дней", "дней")}. Дальше — каждый час.`
            : `Сейчас ничего не удалится. Записи старше ${value} ${plural(value, "дня", "дней", "дней")} будут удаляться каждый час.`;
        } catch (error) {
          if (request !== revision || !dialog.open) return;
          warning.textContent = error instanceof Error ? error.message : String(error);
        }
      }, 300);
    };
    days.addEventListener("input", syncRetention);
    dialog.addEventListener("close", () => {
      clearTimeout(timer);
      revision++;
    });
    row.append(copy, toggle);
    retention.append(element("h3", "", "Хранение"), row, daysLabel, warning);
    const actions = element("div", "dialog-actions folder-settings-footer");
    const save = button("Сохранить", () => undefined, "folder-button primary");
    save.type = "submit";
    actions.append(
      button("Отмена", () => dialog.close(), "folder-button"),
      save,
    );
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (!form.reportValidity()) return;
      save.disabled = true;
      this.run(
        async () => {
          await this.api.setFolderSettings(folder.id, {
            titleTemplate: input.value,
            retentionDays: enabled ? Number(days.value) : 0,
            autoSummary,
            autoRecord: autoRecord.value(),
            livePanel: livePanel.value(),
          });
          dialog.close();
        },
        () => {
          save.disabled = false;
        },
      );
    });
    form.append(titleSection, recording, summary, retention, actions);
    dialog.append(form);
    syncTemplate();
    syncRetention();
    input.focus();
  }
  private nameDialog(folder?: Folder) {
    if (this.dialog) return;
    const trigger = document.getElementById(folder ? "folder-actions" : "new-folder") ?? undefined;
    const dialog = this.createDialog(folder ? "Переименовать папку" : "Новая папка", trigger);
    const form = element("form", "folder-form");
    const input = element("input", "folder-name-input");
    input.setAttribute("aria-label", "Название папки");
    input.required = true;
    input.value = folder?.name ?? "";
    const actions = element("div", "dialog-actions");
    const save = button("Сохранить", () => undefined, "folder-button primary");
    save.type = "submit";
    actions.append(
      button("Отмена", () => dialog.close(), "folder-button"),
      save,
    );
    form.append(input, actions);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (!input.value.trim()) {
        input.focus();
        return;
      }
      save.disabled = true;
      this.run(
        async () => {
          const result = folder
            ? await this.api.renameFolder(folder.id, input.value)
            : await this.api.createFolder(input.value);
          this.select(result.id, false);
          dialog.close();
        },
        () => {
          save.disabled = false;
        },
      );
    });
    dialog.append(form);
    input.focus();
  }
  private askPast(folder: Folder, url: string, ids: string[], trigger: HTMLElement) {
    const dialog = this.createDialog("Правило добавлено", trigger);
    dialog.append(
      element(
        "p",
        "",
        `Новые записи по этой ссылке будут попадать в «${folder.name}». По ней уже есть прошлые созвоны:`,
      ),
      element("span", "folder-rule", url),
    );
    const list = element("ul", "past-sessions");
    for (const id of ids) {
      const session = this.sessions.find((s) => s.sessionId === id);
      const item = element("li", "");
      const when = session ? formatDateTime(new Date(session.createdAt)) : null;
      item.append(
        element(
          "span",
          "",
          session ? `${session.title || "Без названия"} · ${when?.date} ${when?.time}` : id,
        ),
        element("span", "folder-hint", this.folder(session?.folderId)?.name ?? "Входящие"),
      );
      list.append(item);
    }
    const actions = element("div", "dialog-actions");
    const move = button(
      `Перенести ${ids.length} ${plural(ids.length, "созвон", "созвона", "созвонов")}`,
      () => {
        move.disabled = true;
        this.run(
          async () => {
            await this.api.moveFolderSessions(folder.id, ids, true);
            dialog.close();
          },
          () => {
            move.disabled = false;
          },
        );
      },
      "folder-button primary",
    );
    actions.append(
      button("Только новые", () => dialog.close(), "folder-button"),
      move,
    );
    dialog.append(list, actions);
    actions.querySelector("button")?.focus();
  }
  private run(action: () => Promise<void>, onError?: () => void) {
    void (async () => {
      try {
        const error = document.getElementById("history-error");
        if (error) error.hidden = true;
        await action();
        await this.refresh();
      } catch (error) {
        onError?.();
        const message = error instanceof Error ? error.message : String(error);
        const target = this.dialog ?? document.getElementById("history-error");
        if (target instanceof HTMLDialogElement) {
          const alert = element("p", "folder-error", message);
          alert.setAttribute("role", "alert");
          target.append(alert);
        } else if (target) {
          target.hidden = false;
          target.textContent = message;
        }
      }
    })();
  }
}
