import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LiveTranscriptResult, SummaryResult, TranscriptResult } from "../src/shared/types";

const editorMock = vi.hoisted(() => ({
  markdown: "",
  editable: false,
  onChange: () => {},
  showMarkdown: vi.fn(),
  setEditable: vi.fn(),
  command: vi.fn(),
  destroy: vi.fn(),
}));
vi.mock("../src/pages/summary-editor", () => ({
  createSummaryEditor: (_container: HTMLElement, onChange: () => void) => {
    editorMock.onChange = onChange;
    editorMock.showMarkdown.mockImplementation((markdown: string) => {
      editorMock.markdown = markdown.replace(/__([^_]+)__/g, "**$1**");
      onChange();
    });
    editorMock.setEditable.mockImplementation((editable: boolean) => {
      editorMock.editable = editable;
    });
    return {
      ...editorMock,
      getMarkdown: () => editorMock.markdown,
      hasText: () => editorMock.markdown.trim().length > 0,
      isActive: () => false,
    };
  },
}));
const generatedSummary = {
  content: "Новое саммари",
  model: "new-model",
  createdAt: "2026-10-08T12:00:00Z",
  chunked: false,
};
vi.mock("../src/shared/llm-client", () => ({
  generateSummary: vi.fn(async () => generatedSummary),
}));
vi.mock("../src/shared/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/shared/config")>()),
  fetchModelInfo: vi.fn(async () => ({ modelId: "new-model", contextWindow: 8000 })),
}));
const savedSummary: SummaryResult = {
  content: "## Решения\n\n__Сделать__ задачу",
  model: "original-model",
  createdAt: "2026-03-15T14:40:00Z",
  chunked: true,
};

const mockTranscript: TranscriptResult = {
  sessionId: "test-1",
  date: "2026-03-15",
  callUrl: "https://stream.wb.ru/room/1",
  recordingStarted: "2026-03-15T14:30:00Z",
  duration: "5:00",
  participants: [
    { speakerId: "alice", name: "Alice" },
    { speakerId: "bob", name: "<img src=x onerror=alert(1)>" },
  ],
  segments: [
    { speakerId: "local", speaker: "Alice", start: "00:01", end: "00:05", text: "Привет" },
    {
      speakerId: "remote-123",
      speaker: "<script>alert(1)</script>",
      start: "00:06",
      end: "00:10",
      text: "Ответ",
    },
  ],
};

async function loadTranscriptModule(
  apiResponse: TranscriptResult | LiveTranscriptResult = mockTranscript,
  summary: SummaryResult = savedSummary,
) {
  document.body.innerHTML = `
    <h1 id="title"></h1>
    <p id="info"></p>
    <div id="live-indicator" class="live-indicator hidden">
      <span id="live-indicator-text"></span>
    </div>
    <div class="tabs">
      <button class="tab active" data-tab="transcript">Транскрипт</button>
      <button class="tab disabled" data-tab="summary" id="tab-summary" disabled>Саммари</button>
    </div>
    <div id="panel-transcript" class="tab-panel">
      <div id="filters"></div>
      <div id="segments"></div>
    </div>
    <div id="panel-summary" class="tab-panel hidden">
      <div id="summary-content"><div id="summary-edited"></div><div id="summary-toolbar"></div><div id="summary-editor"></div></div>
    </div>
    <div id="banner" class="banner hidden">
      <span id="banner-text"></span>
      <button id="banner-close"></button>
    </div>
    <button id="btn-top" class="scroll-top"></button>
    <footer id="footer-transcript">
      <button id="btn-summary" disabled></button>
      <button id="btn-download"></button>
      <button id="btn-copy"></button>
    </footer>
    <footer id="footer-summary" class="hidden">
      <button id="btn-copy-summary"></button>
      <button id="btn-regenerate"></button>
      <button id="btn-edit-summary"></button>
      <button id="btn-save-summary" class="hidden"></button>
      <button id="btn-cancel-summary" class="hidden"></button>
    </footer>
  `;
  Object.defineProperty(window, "location", {
    value: { search: "?sessionId=test-1", href: "", origin: "https://stream.wb.ru" },
    writable: true,
    configurable: true,
  });
  vi.mocked(chrome.storage.local.get).mockImplementation(async (key) => {
    if (key === "config") return { config: { sttServiceUrl: "http://localhost:9876" } };
    if (key === "sessionTitles") return {};
    return {};
  });
  globalThis.fetch = vi.fn().mockImplementation(async (url) => ({
    ok: true,
    json: async () => (String(url).endsWith("/summary") ? summary : apiResponse),
  }));
  vi.resetModules();
  await import("../src/pages/transcript");
  await new Promise((r) => setTimeout(r, 50));
}

describe("transcript page (module integration)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(window, "addEventListener");
    vi.spyOn(document, "addEventListener");
    vi.spyOn(window, "confirm").mockReturnValue(true);
  });

  afterEach(() => {
    window.dispatchEvent(new Event("pagehide"));
    for (const [name, callback] of vi.mocked(window.addEventListener).mock.calls) {
      window.removeEventListener(name, callback);
    }
    for (const [name, callback, options] of vi.mocked(document.addEventListener).mock.calls) {
      document.removeEventListener(name, callback, options);
    }
    vi.restoreAllMocks();
  });

  it("renders segments without XSS from malicious speaker names", async () => {
    await loadTranscriptModule();
    expect(document.querySelector("script")).toBeNull();
    expect(document.querySelector("#filters img")).toBeNull();
    const speakers = document.querySelectorAll(".segment-speaker");
    expect(speakers.length).toBe(2);
    expect(speakers[1].textContent).toBe("<script>alert(1)</script>");
  });

  it("renders filter checkboxes for each participant", async () => {
    await loadTranscriptModule();
    const checkboxes = document.querySelectorAll("#filters input[type=checkbox]");
    expect(checkboxes.length).toBe(3); // 2 спикера + "Все"
  });

  it("renders segment text via textContent (not innerHTML)", async () => {
    await loadTranscriptModule();
    const texts = document.querySelectorAll(".segment-text");
    expect(texts.length).toBe(2);
    expect(texts[0].textContent).toBe("Привет");
  });

  it("не даёт править текст реплики", async () => {
    await loadTranscriptModule();
    const text = document.querySelector<HTMLElement>(".segment-text")!;
    text.click();
    expect(text.isContentEditable).toBe(false);
  });

  it("правит название встречи от видимого значения и не оставляет его пустым", async () => {
    await loadTranscriptModule();
    const title = document.getElementById("title")!;
    expect(title.textContent).toBe("Звонок 2026-03-15");

    title.click();
    expect(title.textContent).toBe("Звонок 2026-03-15");

    title.dispatchEvent(new Event("blur"));
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(title.textContent).toBe("Звонок 2026-03-15");
  });

  it("возвращает страницу наверх по кнопке", async () => {
    await loadTranscriptModule();
    const scrollTo = vi.fn();
    Object.defineProperty(window, "scrollTo", { value: scrollTo, configurable: true });

    document.getElementById("btn-top")!.click();

    expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({ top: 0 }));
  });

  it("participant filter label shows name as text, not HTML", async () => {
    await loadTranscriptModule();
    const labels = document.querySelectorAll("#filters label");
    const maliciousLabel = Array.from(labels).find(
      (l) => l.textContent === "<img src=x onerror=alert(1)>",
    );
    expect(maliciousLabel).toBeDefined();
  });

  it("renders an updating, read-only transcript while recording", async () => {
    const liveTranscript: LiveTranscriptResult = {
      ...mockTranscript,
      status: "recording",
      isFinal: false,
      processedChunks: 1,
      totalChunks: 2,
    };

    await loadTranscriptModule(liveTranscript);

    const indicator = document.getElementById("live-indicator")!;
    expect(indicator.classList.contains("hidden")).toBe(false);
    expect(indicator.textContent).toContain("2 реплики");
    expect(document.querySelectorAll(".segment.live-segment")).toHaveLength(2);

    const text = document.querySelector<HTMLElement>(".segment-text")!;
    text.click();
    expect(text.classList.contains("editing")).toBe(false);
    expect((document.getElementById("btn-summary") as HTMLButtonElement).disabled).toBe(true);

    window.dispatchEvent(new Event("beforeunload"));
  });

  it("переименовывает участника и обновляет транскрипт", async () => {
    await loadTranscriptModule();
    const requests = vi.mocked(globalThis.fetch);
    requests.mockClear();

    const speakerEl = document.querySelector<HTMLElement>(".segment-speaker")!;
    speakerEl.click();
    expect(speakerEl.classList.contains("editing")).toBe(true);
    speakerEl.textContent = "  Вера Лапина  ";
    speakerEl.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    );
    await new Promise((r) => setTimeout(r, 20));

    const [speakersUrl, speakersInit] = requests.mock.calls.find(([url]) =>
      String(url).endsWith("/speakers"),
    )!;
    expect(String(speakersUrl)).toContain("/sessions/test-1/speakers");
    expect(JSON.parse(String(speakersInit?.body))).toEqual({
      speakerId: "local",
      name: "Вера Лапина",
    });

    expect(document.querySelector(".segment-speaker")?.textContent).toBe("Вера Лапина");
    // Имя подставляется сервером по speakerId, транскрипт не переписываем.
    expect(
      requests.mock.calls.some(
        ([url, init]) => String(url).endsWith("/transcript") && init?.method === "PUT",
      ),
    ).toBe(false);
  });

  it("показывает баннер, когда имя сохранить не удалось", async () => {
    await loadTranscriptModule();
    vi.mocked(globalThis.fetch).mockResolvedValue({ ok: false, status: 500 } as Response);

    const speakerEl = document.querySelector<HTMLElement>(".segment-speaker")!;
    speakerEl.click();
    speakerEl.textContent = "Анна";
    speakerEl.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    );
    await new Promise((r) => setTimeout(r, 20));

    const banner = document.getElementById("banner")!;
    expect(banner.classList.contains("hidden")).toBe(false);
    expect(banner.textContent).toContain("Не удалось сохранить имя");
  });
  it("включает правку и панель, без нормализованных изменений выходит без запроса", async () => {
    await loadTranscriptModule();
    button("btn-edit-summary").click();
    expect(editorMock.editable).toBe(true);
    expect(button("summary-toolbar").classList.contains("hidden")).toBe(false);
    expect(document.querySelectorAll('[aria-pressed="false"]')).toHaveLength(6);
    expect(button("btn-regenerate").classList.contains("hidden")).toBe(true);
    button("btn-save-summary").click();
    expect(editorMock.editable).toBe(false);
    expect(summaryWrites()).toHaveLength(0);
  });

  it("сохраняет markdown и editedAt, сохраняя метаданные генерации", async () => {
    await loadTranscriptModule();
    button("btn-edit-summary").click();
    changeSummary();
    button("btn-save-summary").click();
    expect(button("btn-save-summary").disabled).toBe(true);
    expect(button("btn-save-summary").classList.contains("btn-spinner")).toBe(true);
    await vi.waitFor(() => expect(editorMock.editable).toBe(false));
    await vi.waitFor(() =>
      expect(button("summary-edited").textContent).toContain("Отредактировано вручную"),
    );
    const body = JSON.parse(String(summaryWrites()[0][1]?.body));
    expect(body).toEqual({
      ...savedSummary,
      content: "Дополненное саммари",
      editedAt: expect.any(String),
    });
    expect(new Date(body.editedAt).toISOString()).toBe(body.editedAt);
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    button("btn-copy-summary").click();
    expect(writeText).toHaveBeenCalledWith(body.content);
  });

  it("подтверждает отмену и возвращает сохранённый markdown", async () => {
    await loadTranscriptModule();
    button("btn-edit-summary").click();
    changeSummary();
    vi.mocked(window.confirm).mockReturnValueOnce(false);
    button("btn-cancel-summary").click();
    expect(window.confirm).toHaveBeenCalledWith("Отменить правки?");
    expect(editorMock.editable).toBe(true);
    expect(editorMock.markdown).toBe("Дополненное саммари");
    button("btn-cancel-summary").click();
    expect(editorMock.showMarkdown).toHaveBeenLastCalledWith(savedSummary.content);
    expect(editorMock.editable).toBe(false);
    expect(summaryWrites()).toHaveLength(0);
  });

  it("после ошибки сохранения оставляет текст и режим правки", async () => {
    await loadTranscriptModule();
    vi.mocked(fetch).mockResolvedValue({ ok: false, status: 500 } as Response);
    button("btn-edit-summary").click();
    changeSummary();
    button("btn-save-summary").click();
    await vi.waitFor(() =>
      expect(button("banner").textContent).toContain("Не удалось сохранить саммари"),
    );
    expect(editorMock.editable).toBe(true);
    expect(editorMock.markdown).toBe("Дополненное саммари");
    expect(button("btn-save-summary").disabled).toBe(false);
  });

  it("перед перегенерацией подтверждает потерю правок и сбрасывает editedAt", async () => {
    await loadTranscriptModule(mockTranscript, {
      ...savedSummary,
      editedAt: "2026-10-08T10:00:00Z",
    });
    vi.mocked(window.confirm).mockReturnValueOnce(false);
    button("btn-regenerate").click();
    expect(window.confirm).toHaveBeenCalledWith(
      "Саммари отредактировано вручную. Перегенерировать и потерять правки?",
    );
    expect(summaryWrites()).toHaveLength(0);
    button("btn-regenerate").click();
    await vi.waitFor(() => expect(summaryWrites()).toHaveLength(1));
    expect(JSON.parse(String(summaryWrites()[0][1]?.body))).toEqual(generatedSummary);
    expect(button("summary-edited").classList.contains("hidden")).toBe(true);
  });

  it("не сохраняет пустой документ ни кнопкой, ни сочетанием клавиш", async () => {
    await loadTranscriptModule();
    button("btn-edit-summary").click();
    changeSummary("   ");
    expect(button("btn-save-summary").disabled).toBe(true);
    button("btn-save-summary").click();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true }));
    expect(summaryWrites()).toHaveLength(0);
    expect(editorMock.editable).toBe(true);
  });

  it.each([
    "metaKey",
    "ctrlKey",
  ])("сохраняет по %s+Enter, Esc оставляет текст", async (modifier) => {
    await loadTranscriptModule();
    button("btn-edit-summary").click();
    changeSummary();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(editorMock.editable).toBe(true);
    expect(editorMock.markdown).toBe("Дополненное саммари");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", [modifier]: true }));
    await vi.waitFor(() => expect(summaryWrites()).toHaveLength(1));
  });

  it("предупреждает при уходе только с несохранёнными изменениями", async () => {
    await loadTranscriptModule();
    button("btn-edit-summary").click();
    const clean = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(clean);
    expect(clean.defaultPrevented).toBe(false);
    changeSummary();
    const dirty = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(dirty);
    expect(dirty.defaultPrevented).toBe(true);
    button("btn-cancel-summary").click();
    const cancelled = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(cancelled);
    expect(cancelled.defaultPrevented).toBe(false);
  });
});

function button(id: string): HTMLButtonElement {
  return document.getElementById(id) as HTMLButtonElement;
}
function changeSummary(markdown = "Дополненное саммари") {
  editorMock.markdown = markdown;
  editorMock.onChange();
}
function summaryWrites() {
  return vi
    .mocked(fetch)
    .mock.calls.filter(([url, init]) => String(url).endsWith("/summary") && init?.method === "PUT");
}
