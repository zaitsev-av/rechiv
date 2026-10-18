import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HistoryFolders } from "../src/pages/history-folders";
import { SttApiClient } from "../src/shared/api-client";
import type { Folder, SessionInfo } from "../src/shared/types";

const folders: Folder[] = [
  { id: "daily", name: "Дейли", color: 1, rules: [] },
  { id: "retro", name: "Ретро", color: 2, rules: [] },
];
function session(id: string, folderId = ""): SessionInfo {
  return {
    sessionId: id,
    folderId,
    folderByRule: !!folderId,
    title: `Созвон ${id}`,
    callUrl: "https://meet.google.com/room?x=1",
    callKey: "meet.google.com/room",
    createdAt: "2026-10-15T10:00:00Z",
    finishedAt: null,
    participants: [],
    chunksCount: 0,
    status: "completed",
  };
}
let api: SttApiClient;
let view: HistoryFolders;
let refresh: ReturnType<typeof vi.fn>;
let sessions: SessionInfo[];
function render() {
  const list = document.getElementById("sessions")!;
  list.replaceChildren();
  for (const s of view.visible()) {
    const card = document.createElement("div");
    card.className = "session-card";
    card.dataset.id = s.sessionId;
    const details = document.createElement("div");
    card.append(details);
    view.decorate(s, details, card);
    list.append(card);
  }
  view.afterRender();
}
function click(text: string) {
  const node = Array.from(document.querySelectorAll("button")).find((b) => b.textContent === text);
  expect(node, text).toBeDefined();
  node!.click();
}
function open(id = "s1") {
  document.querySelector<HTMLButtonElement>(`[data-id="${id}"] .session-more`)!.click();
}
async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}
function transfer() {
  const data = new Map<string, string>();
  return {
    get types() {
      return [...data.keys()];
    },
    effectAllowed: "uninitialized",
    dropEffect: "none",
    setData: (type: string, value: string) => data.set(type, value),
    getData: (type: string) => data.get(type) ?? "",
    setDragImage: vi.fn(),
  };
}
function drag(
  node: Element,
  type: string,
  dataTransfer: ReturnType<typeof transfer>,
  relatedTarget: EventTarget | null = null,
) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    dataTransfer: { value: dataTransfer },
    relatedTarget: { value: relatedTarget },
  });
  node.dispatchEvent(event);
  return event;
}

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML =
    '<aside class="folder-sidebar"><nav id="folders"></nav><button id="new-folder">Новая папка</button></aside><h1 id="history-title"></h1><p id="history-eyebrow"></p><button id="folder-actions"></button><div id="folder-banner"></div><p id="history-error" hidden></p><div id="sessions"></div>';
  api = new SttApiClient("");
  sessions = [session("s1", "daily"), session("s2"), session("s3", "orphan")];
  refresh = vi.fn(async () => {
    view.update(folders, sessions);
    render();
  });
  view = new HistoryFolders(api, refresh);
  view.update(folders, sessions);
  render();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("history folders", () => {
  it.each([
    "retro",
    "inbox",
  ])("drops a session into %s and refreshes counts and list", async (id) => {
    view.current = "daily";
    view.update(folders, sessions);
    render();
    const move = vi.spyOn(api, "moveSession").mockImplementation(async (sessionId, folderId) => {
      const moved = sessions.find((s) => s.sessionId === sessionId)!;
      moved.folderId = folderId;
      moved.folderByRule = false;
      return moved;
    });
    const card = document.querySelector('[data-id="s1"]')!;
    const target = document.querySelector(`[data-folder="${id}"]`)!;
    const data = transfer();
    drag(card, "dragstart", data);
    expect(data.getData("application/x-rechiv-session")).toBe("s1");
    expect(data.getData("text/plain")).toBe("s1");
    expect(data.effectAllowed).toBe("move");
    expect(card.classList.contains("dragging")).toBe(true);
    expect(drag(target, "dragover", data).defaultPrevented).toBe(true);
    expect(data.dropEffect).toBe("move");
    expect(target.classList.contains("drag-over")).toBe(true);
    expect(drag(target, "drop", data).defaultPrevented).toBe(true);
    expect(target.classList.contains("drag-over")).toBe(false);
    drag(card, "dragend", data);
    await settle();
    expect(move).toHaveBeenCalledExactlyOnceWith("s1", id === "inbox" ? "" : id);
    expect(sessions[0].folderByRule).toBe(false);
    expect(refresh).toHaveBeenCalledOnce();
    expect(document.querySelector('[data-id="s1"]')).toBeNull();
    expect(document.querySelector('[data-folder="daily"] .folder-count')?.textContent).toBe("0");
    expect(document.querySelector(`[data-folder="${id}"] .folder-count`)?.textContent).toBe(
      id === "inbox" ? "3" : "1",
    );
    expect(card.classList.contains("dragging")).toBe(false);
    expect(view.paused).toBe(false);
  });

  it.each([
    ["s1", "all"],
    ["s1", "daily"],
    ["s2", "inbox"],
    ["s3", "inbox"],
  ])("rejects moving %s into %s", (sessionId, folderId) => {
    const move = vi.spyOn(api, "moveSession");
    const card = document.querySelector(`[data-id="${sessionId}"]`)!;
    const target = document.querySelector(`[data-folder="${folderId}"]`)!;
    const data = transfer();
    drag(card, "dragstart", data);
    expect(drag(target, "dragover", data).defaultPrevented).toBe(false);
    expect(data.dropEffect).toBe("none");
    expect(target.classList.contains("drag-over")).toBe(false);
    expect(drag(target, "drop", data).defaultPrevented).toBe(false);
    expect(move).not.toHaveBeenCalled();
    drag(card, "dragend", data);
  });

  it("marks the panel and denied targets for the whole drag", () => {
    const card = document.querySelector('[data-id="s1"]')!;
    const data = transfer();
    const marked = (cls: string) =>
      [...document.querySelectorAll<HTMLElement>(`.${cls}`)].map((n) => n.dataset.folder);
    drag(card, "dragstart", data);
    expect(document.querySelector(".folder-sidebar")?.classList.contains("drop-ready")).toBe(true);
    expect(marked("drop-denied")).toEqual(["all", "daily"]);
    drag(card, "dragend", data);
    expect(document.querySelector(".drop-ready, .drop-denied")).toBeNull();
  });

  it("drags a compact title chip instead of the whole card", async () => {
    const card = document.querySelector('[data-id="s1"]')!;
    const data = transfer();
    drag(card, "dragstart", data);
    const [ghost] = data.setDragImage.mock.calls[0];
    expect(ghost.className).toBe("drag-ghost");
    expect(ghost.querySelector(".drag-ghost-title")?.textContent).toBe("Созвон s1");
    expect(ghost.querySelector(".drag-ghost-date")?.textContent).toMatch(/^\d{2}\.\d{2}\.\d{4}$/);
    await new Promise((resolve) => setTimeout(resolve));
    expect(document.querySelector(".drag-ghost")).toBeNull();
    drag(card, "dragend", data);
  });

  it("keeps the highlight within a button and clears it on leave and canceled drag", () => {
    const card = document.querySelector('[data-id="s1"]')!;
    const target = document.querySelector('[data-folder="retro"]')!;
    const child = target.querySelector("span")!;
    const data = transfer();
    drag(card, "dragstart", data);
    drag(target, "dragenter", data);
    drag(target, "dragleave", data, child);
    expect(target.classList.contains("drag-over")).toBe(true);
    drag(target, "dragleave", data);
    expect(target.classList.contains("drag-over")).toBe(false);
    drag(child, "dragover", data);
    expect(target.classList.contains("drag-over")).toBe(true);
    drag(card, "dragend", data);
    expect(document.querySelector(".drag-over, .dragging")).toBeNull();
  });

  it("closes the menu on drag and suppresses the following card click", () => {
    open();
    const card = document.querySelector('[data-id="s1"]')!;
    const click = vi.fn();
    card.addEventListener("click", click);
    const data = transfer();
    drag(card, "dragstart", data);
    expect(document.querySelector(".folder-menu")).toBeNull();
    expect(view.paused).toBe(true);
    drag(card, "dragend", data);
    card.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(click).not.toHaveBeenCalled();
    card.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    card.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(click).toHaveBeenCalledOnce();
  });

  it("does not start dragging from buttons or a disabled card", () => {
    const card = document.querySelector<HTMLElement>('[data-id="s1"]')!;
    const more = card.querySelector("button")!;
    const data = transfer();
    expect(drag(more, "dragstart", data).defaultPrevented).toBe(true);
    more.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(drag(card, "dragstart", data).defaultPrevented).toBe(true);
    card.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    card.draggable = false;
    expect(drag(card, "dragstart", data).defaultPrevented).toBe(true);
    expect(view.paused).toBe(false);
  });

  it("rejects external and mismatched payloads", () => {
    const move = vi.spyOn(api, "moveSession");
    const target = document.querySelector('[data-folder="retro"]')!;
    const data = transfer();
    data.setData("text/plain", "s1");
    expect(drag(target, "dragover", data).defaultPrevented).toBe(false);
    drag(target, "drop", data);
    const card = document.querySelector('[data-id="s1"]')!;
    drag(card, "dragstart", data);
    data.setData("application/x-rechiv-session", "s2");
    drag(target, "drop", data);
    expect(move).not.toHaveBeenCalled();
    drag(card, "dragend", data);
  });

  it("reports drop failures through the same error notification as the menu", async () => {
    vi.spyOn(api, "moveSession").mockRejectedValue(new Error("move failed"));
    const data = transfer();
    const card = document.querySelector('[data-id="s1"]')!;
    const target = document.querySelector('[data-folder="retro"]')!;
    drag(card, "dragstart", data);
    drag(target, "dragover", data);
    drag(target, "drop", data);
    drag(card, "dragend", data);
    await settle();
    expect(document.getElementById("history-error")?.hidden).toBe(false);
    expect(document.getElementById("history-error")?.textContent).toBe("move failed");
    expect(refresh).not.toHaveBeenCalled();
    expect(document.querySelector('[data-id="s1"]')).not.toBeNull();
    expect(document.querySelector(".drag-over, .dragging")).toBeNull();
  });

  it("filters folders and counts orphan sessions as inbox", () => {
    expect(document.querySelector('[data-folder="inbox"]')?.textContent).toContain("2");
    document.querySelector<HTMLButtonElement>('[data-folder="inbox"]')!.click();
    expect(view.visible().map((s) => s.sessionId)).toEqual(["s2", "s3"]);
    expect(document.getElementById("folder-banner")?.textContent).toContain(
      "Здесь созвоны без папки",
    );
    document.querySelector<HTMLButtonElement>('[data-folder="daily"]')!.click();
    expect(view.visible().map((s) => s.sessionId)).toEqual(["s1"]);
    expect(document.getElementById("history-eyebrow")?.hidden).toBe(true);
    expect(document.getElementById("history-title")?.textContent).toBe("Дейли");
    expect(document.getElementById("sessions")?.textContent).toContain("по правилу");
    expect(localStorage.getItem("history-folder")).toBe("daily");
  });

  it("restores selection and resets an unknown folder", () => {
    localStorage.setItem("history-folder", "retro");
    const restored = new HistoryFolders(api, refresh);
    restored.update(folders, sessions);
    expect(restored.current).toBe("retro");
    restored.update([], sessions);
    expect(restored.current).toBe("all");
    expect(localStorage.getItem("history-folder")).toBe("all");
  });

  it("moves a session manually and closes the menu", async () => {
    const move = vi.spyOn(api, "moveSession").mockResolvedValue(session("s1", "retro"));
    open();
    click("Ретро");
    await settle();
    expect(move).toHaveBeenCalledWith("s1", "retro");
    expect(document.querySelector(".folder-menu")).toBeNull();
    expect(refresh).toHaveBeenCalled();
  });

  it("shows the API callKey and disables rules in inbox", () => {
    open("s2");
    expect(document.querySelector<HTMLInputElement>(".rule-toggle input")?.disabled).toBe(true);
    expect(document.querySelector(".rule-toggle code")?.textContent).toBe("meet.google.com/room");
  });

  it("keeps the open menu across refresh, closes on Esc and returns focus", async () => {
    open();
    const menu = document.querySelector(".folder-menu");
    await refresh();
    expect(document.querySelector(".folder-menu")).toBe(menu);
    expect(
      document.querySelector('[data-id="s1"] .session-more')?.getAttribute("aria-expanded"),
    ).toBe("true");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(document.querySelector(".folder-menu")).toBeNull();
    expect(document.activeElement).toBe(document.querySelector('[data-id="s1"] .session-more'));
  });

  it("enables a rule, preserves the dialog across refresh and moves matching calls", async () => {
    const add = vi
      .spyOn(api, "addFolderRule")
      .mockResolvedValue({ folder: folders[0], matching: ["s2", "s3"] });
    const move = vi.spyOn(api, "moveFolderSessions").mockResolvedValue();
    open();
    document.querySelector<HTMLInputElement>(".rule-toggle input")!.click();
    await settle();
    expect(add).toHaveBeenCalledWith("daily", "meet.google.com/room");
    const dialog = document.querySelector("dialog");
    expect(dialog?.open).toBe(true);
    expect(dialog?.textContent).toContain("Созвон s2");
    expect(dialog?.textContent).toContain("Созвон s3");
    await refresh();
    expect(document.querySelector("dialog")).toBe(dialog);
    click("Перенести 2 созвона");
    await settle();
    expect(move).toHaveBeenCalledWith("daily", ["s2", "s3"], true);
    expect(document.querySelector("dialog")).toBeNull();
  });

  it("only new calls leaves past sessions untouched", async () => {
    vi.spyOn(api, "addFolderRule").mockResolvedValue({ folder: folders[0], matching: ["s2"] });
    const move = vi.spyOn(api, "moveFolderSessions");
    open();
    document.querySelector<HTMLInputElement>(".rule-toggle input")!.click();
    await settle();
    click("Только новые");
    expect(move).not.toHaveBeenCalled();
    expect(document.querySelector("dialog")).toBeNull();
  });

  it("can claim a rule from another folder and remove a current rule", async () => {
    const ruled = structuredClone(folders);
    ruled[1].rules = [{ url: "meet.google.com/room" }];
    view.update(ruled, sessions);
    const add = vi
      .spyOn(api, "addFolderRule")
      .mockResolvedValue({ folder: ruled[0], matching: [] });
    open();
    expect(document.querySelector<HTMLInputElement>(".rule-toggle input")?.checked).toBe(false);
    expect(document.querySelector(".rule-toggle")?.textContent).toContain(
      "Сейчас правило ведёт в «Ретро»",
    );
    document.querySelector<HTMLInputElement>(".rule-toggle input")!.click();
    await settle();
    expect(add).toHaveBeenCalledWith("daily", "meet.google.com/room");
    ruled[0].rules = ruled[1].rules;
    ruled[1].rules = [];
    view.update(ruled, sessions);
    const remove = vi.spyOn(api, "deleteFolderRule").mockResolvedValue();
    open();
    expect(document.querySelector<HTMLInputElement>(".rule-toggle input")?.checked).toBe(true);
    document.querySelector<HTMLInputElement>(".rule-toggle input")!.click();
    await settle();
    expect(remove).toHaveBeenCalledWith("daily", "meet.google.com/room");
  });

  it("creates a folder through a named dialog without prompt", async () => {
    const create = vi.spyOn(api, "createFolder").mockResolvedValue(folders[1]);
    click("Новая папка");
    const input = document.querySelector<HTMLInputElement>(".folder-name-input")!;
    input.value = "Ретро";
    document
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await settle();
    expect(create).toHaveBeenCalledWith("Ретро");
    expect(view.current).toBe("retro");
  });

  it("keeps errors visible and never renders names as HTML", async () => {
    vi.spyOn(api, "moveSession").mockRejectedValue(new Error("move failed"));
    view.update([{ ...folders[0], name: '<img src=x onerror="alert(1)">' }], sessions);
    render();
    expect(document.querySelector("img")).toBeNull();
    open();
    click("Входящие");
    await settle();
    expect(document.getElementById("history-error")?.textContent).toBe("move failed");
  });
});

it("removes a folder rule through the banner without moving sessions", async () => {
  const ruled = [{ ...folders[0], rules: [{ url: "meet.google.com/room" }] }];
  view.current = "daily";
  view.update(ruled, sessions);
  const remove = vi.spyOn(api, "deleteFolderRule").mockResolvedValue();
  const move = vi.spyOn(api, "moveFolderSessions");
  document.querySelector<HTMLButtonElement>(".remove-rule")!.click();
  await settle();
  expect(remove).toHaveBeenCalledWith("daily", "meet.google.com/room");
  expect(move).not.toHaveBeenCalled();
});

it("renames a folder and confirms its deletion", async () => {
  view.current = "daily";
  view.update(folders, sessions);
  const rename = vi
    .spyOn(api, "renameFolder")
    .mockResolvedValue({ ...folders[0], name: "Стендапы" });
  document.getElementById("folder-actions")!.click();
  click("Переименовать");
  const input = document.querySelector<HTMLInputElement>(".folder-name-input")!;
  expect(input.value).toBe("Дейли");
  input.value = "Стендапы";
  document
    .querySelector("form")!
    .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  await settle();
  expect(rename).toHaveBeenCalledWith("daily", "Стендапы");
  const remove = vi.spyOn(api, "deleteFolder").mockResolvedValue();
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  document.getElementById("folder-actions")!.click();
  click("Удалить папку");
  expect(remove).not.toHaveBeenCalled();
  confirm.mockReturnValue(true);
  click("Удалить папку");
  await settle();
  expect(remove).toHaveBeenCalledWith("daily");
  expect(view.current).toBe("all");
});

it("keeps a failed bulk move dialog open for retry", async () => {
  vi.spyOn(api, "addFolderRule").mockResolvedValue({ folder: folders[0], matching: ["s2"] });
  vi.spyOn(api, "moveFolderSessions").mockRejectedValue(new Error("offline"));
  open();
  document.querySelector<HTMLInputElement>(".rule-toggle input")!.click();
  await settle();
  click("Перенести 1 созвон");
  await settle();
  expect(document.querySelector("dialog")?.open).toBe(true);
  expect(document.querySelector('dialog [role="alert"]')?.textContent).toBe("offline");
  expect(document.querySelector<HTMLButtonElement>("dialog .primary")?.disabled).toBe(false);
});

describe("folder settings", () => {
  function settings(template = "Дейли {date}", retentionDays = 0) {
    view.current = "daily";
    view.update(
      [{ ...folders[0], settings: { titleTemplate: template, retentionDays } }, folders[1]],
      sessions,
    );
    document.getElementById("folder-actions")!.click();
    expect(document.querySelector(".folder-menu button")?.textContent).toBe("Настройки папки");
    click("Настройки папки");
    return document.querySelector<HTMLInputElement>(".folder-template-input")!;
  }
  function input(node: HTMLInputElement, value: string) {
    node.value = value;
    node.dispatchEvent(new Event("input", { bubbles: true }));
  }
  function submit() {
    document
      .querySelector("dialog form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  }

  it("previews local date, time and weekday and disables duplicate chips on every edit", async () => {
    const field = settings();
    expect(document.activeElement).toBe(field);
    const dateChip = document.querySelector<HTMLButtonElement>('[data-token="{date}"]')!;
    expect(dateChip.disabled).toBe(true);
    expect(document.querySelector(".folder-preview-value")?.textContent).toBe(
      `Дейли ${new Date().toLocaleDateString("ru-RU")}`,
    );
    input(field, "{date} {time} {weekday}");
    expect(
      [...document.querySelectorAll<HTMLButtonElement>(".folder-template-chip")].every(
        (chip) => chip.disabled,
      ),
    ).toBe(true);
    const now = new Date();
    expect(document.querySelector(".folder-preview-value")?.textContent).toBe(
      `${now.toLocaleDateString("ru-RU")} ${now.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })} ${now.toLocaleDateString("ru-RU", { weekday: "long" })}`,
    );
    input(field, "НачалоКонец");
    expect(dateChip.disabled).toBe(false);
    field.setSelectionRange(6, 6);
    dateChip.click();
    expect(field.value).toBe("Начало {date} Конец");
    expect(field.selectionStart).toBe(14);
    expect(dateChip.disabled).toBe(true);
    const dialog = document.querySelector("dialog");
    await refresh();
    expect(document.querySelector("dialog")).toBe(dialog);
    expect(field.value).toBe("Начало {date} Конец");
    input(field, "");
    expect(document.querySelector(".folder-preview-value")?.textContent).toContain(
      "название не ставится",
    );
    dialog!.close();
    expect(document.activeElement).toBe(document.getElementById("folder-actions"));
  });

  it("previews changes and lists manual titles, applies only after confirmation", async () => {
    const preview = vi
      .spyOn(api, "previewFolderTitles")
      .mockResolvedValue({ renamed: ["s1"], manual: ["s2"] });
    const apply = vi.spyOn(api, "applyFolderTitles").mockResolvedValue({ renamed: 1 });
    sessions[1].folderId = "daily";
    settings();
    click("Применить к созвонам папки");
    await settle();
    expect(preview).toHaveBeenCalledWith("daily");
    expect(apply).not.toHaveBeenCalled();
    expect(document.querySelector(".folder-notice.info")?.textContent).toContain(
      "Изменится 1 из 2 созвонов",
    );
    expect(document.querySelector(".folder-manual-titles")?.textContent).toContain("Созвон s2");
    document
      .querySelector<HTMLButtonElement>(".folder-notice.info .dialog-actions button:last-child")!
      .click();
    expect(document.querySelector<HTMLElement>(".folder-notice.info")!.hidden).toBe(true);
    click("Применить к созвонам папки");
    await settle();
    click("Переименовать 1");
    await settle();
    expect(apply).toHaveBeenCalledExactlyOnceWith("daily");
    expect(document.querySelector(".folder-notice.info")?.textContent).toContain(
      "Переименовано созвонов: 1",
    );
    expect(document.querySelector("dialog")?.open).toBe(true);
  });

  it("shows nothing to rename and requires saving an edited template first", async () => {
    const preview = vi
      .spyOn(api, "previewFolderTitles")
      .mockResolvedValue({ renamed: [], manual: [] });
    const field = settings();
    click("Применить к созвонам папки");
    await settle();
    expect(document.querySelector(".folder-notice.info")?.textContent).toContain("Менять нечего");
    input(field, "Другой {date}");
    click("Применить к созвонам папки");
    expect(preview).toHaveBeenCalledOnce();
    expect(document.querySelector("dialog")?.textContent).toContain("Сначала сохраните шаблон");
    document.querySelector("dialog")!.close();
  });

  it("debounces retention previews, warns before saving and ignores stale results", async () => {
    vi.useFakeTimers();
    try {
      let resolveOld!: (value: { sessions: string[] }) => void;
      const preview = vi
        .spyOn(api, "previewFolderRetention")
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              resolveOld = resolve;
            }),
        )
        .mockResolvedValue({ sessions: ["s1", "s2"] });
      const save = vi.spyOn(api, "setFolderSettings").mockResolvedValue(folders[0]);
      settings();
      const toggle = document.querySelector<HTMLButtonElement>('[role="switch"]')!;
      const days = document.querySelector<HTMLInputElement>(".folder-retention-days input")!;
      expect(days.disabled).toBe(true);
      toggle.click();
      expect(toggle.getAttribute("aria-checked")).toBe("true");
      expect(days.disabled).toBe(false);
      await vi.advanceTimersByTimeAsync(300);
      expect(preview).toHaveBeenCalledWith("daily", 30);
      input(days, "14");
      input(days, "7");
      await vi.advanceTimersByTimeAsync(299);
      expect(preview).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1);
      expect(preview).toHaveBeenLastCalledWith("daily", 7);
      expect(document.querySelector(".folder-notice.warn")?.textContent).toContain(
        "сразу удалится 2 созвона старше 7 дней",
      );
      resolveOld({ sessions: [] });
      await vi.advanceTimersByTimeAsync(0);
      expect(document.querySelector(".folder-notice.warn")?.textContent).toContain(
        "сразу удалится 2",
      );
      submit();
      await vi.advanceTimersByTimeAsync(0);
      expect(save).toHaveBeenCalledExactlyOnceWith("daily", {
        titleTemplate: "Дейли {date}",
        retentionDays: 7,
      });
      expect(document.querySelector("dialog")).toBeNull();
      expect(refresh).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores a titles preview if the template changed while loading", async () => {
    let resolve!: (value: { renamed: string[]; manual: string[] }) => void;
    vi.spyOn(api, "previewFolderTitles").mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const field = settings();
    click("Применить к созвонам папки");
    input(field, "Новый {date}");
    resolve({ renamed: ["s1"], manual: [] });
    await settle();
    expect(document.querySelector<HTMLElement>(".folder-notice.info")!.hidden).toBe(true);
    document.querySelector("dialog")!.close();
  });

  it("saves disabled retention as zero and leaves failed saves open for retry", async () => {
    const save = vi
      .spyOn(api, "setFolderSettings")
      .mockRejectedValueOnce(new Error("invalid template"))
      .mockResolvedValue(folders[0]);
    const field = settings("{date}", 30);
    document.querySelector<HTMLButtonElement>('[role="switch"]')!.click();
    input(field, "Новый {time}");
    submit();
    await settle();
    expect(document.querySelector("dialog")?.open).toBe(true);
    expect(document.querySelector('dialog [role="alert"]')?.textContent).toBe("invalid template");
    expect(
      document.querySelector<HTMLButtonElement>('dialog button[type="submit"]')!.disabled,
    ).toBe(false);
    submit();
    await settle();
    expect(save).toHaveBeenLastCalledWith("daily", {
      titleTemplate: "Новый {time}",
      retentionDays: 0,
    });
    expect(document.querySelector("dialog")).toBeNull();
  });
});
