import { beforeEach, describe, expect, it, vi } from "vitest";
import { getConfig, isLlmConfigured } from "../src/shared/config";
import { chromeMock } from "./setup";

const FILLED_LLM = {
  llmUrl: "https://example.test/v1",
  llmModel: "some-model",
  llmApiKey: "token",
};

async function loadSettingsPage(
  config: Record<string, unknown> = {},
  health: Record<string, unknown> = { status: "ok", engine: { status: "ready" } },
) {
  document.body.innerHTML = `
    <div id="health" class="health">
      <p id="health-title"></p>
      <p id="health-detail"></p>
      <button id="btn-recheck"></button>
    </div>
    <form id="settings-form">
      <input id="input-llm-url" type="url">
      <input id="input-llm-model" type="text">
      <div class="input-wrap">
        <input id="input-llm-api-key" type="password">
        <button id="btn-toggle-key" type="button" aria-pressed="false">Показать</button>
      </div>
      <button id="btn-check-llm" type="button"></button>
      <p id="llm-status" class="check-status"></p>
      <input type="radio" name="theme" value="light" checked>
      <input type="radio" name="theme" value="dark">
      <button id="btn-save" type="submit"></button>
      <p id="save-status"></p>
    </form>
  `;
  chromeMock.storage.local.get.mockImplementation(async (key) => {
    if (key === "config") return { config };
    return {};
  });
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve(health),
  });
  vi.resetModules();
  await import("../src/pages/settings");
  await new Promise((resolve) => setTimeout(resolve, 30));
}

function submit() {
  document
    .getElementById("settings-form")!
    .dispatchEvent(new Event("submit", { cancelable: true }));
}

describe("settings page", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("не подставляет адрес и модель LLM, когда их не задавали", async () => {
    await loadSettingsPage();

    expect((document.getElementById("input-llm-url") as HTMLInputElement).value).toBe("");
    expect((document.getElementById("input-llm-model") as HTMLInputElement).value).toBe("");
    expect(document.getElementById("input-stt-url")).toBeNull();
  });

  it("показывает готовность локального приложения", async () => {
    await loadSettingsPage();

    expect(document.getElementById("health")!.className).toContain("ready");
    expect(document.getElementById("health-title")!.textContent).toBe("Приложение готово к записи");
  });

  it("сообщает, что движок распознавания не поднялся", async () => {
    await loadSettingsPage({}, { status: "ok", engine: { status: "error", error: "нет torch" } });

    expect(document.getElementById("health")!.className).toContain("warning");
    expect(document.getElementById("health-detail")!.textContent).toBe("нет torch");
  });

  it("не сохраняет наполовину заполненный LLM", async () => {
    await loadSettingsPage();
    (document.getElementById("input-llm-url") as HTMLInputElement).value = FILLED_LLM.llmUrl;

    submit();
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(chrome.storage.local.set).not.toHaveBeenCalled();
    expect(document.getElementById("save-status")!.className).toContain("error");
    expect(document.getElementById("input-llm-model")!.className).toContain("invalid");
  });

  it("сохраняет, когда заполнены все три поля LLM", async () => {
    await loadSettingsPage();
    (document.getElementById("input-llm-url") as HTMLInputElement).value = FILLED_LLM.llmUrl;
    (document.getElementById("input-llm-model") as HTMLInputElement).value = FILLED_LLM.llmModel;
    (document.getElementById("input-llm-api-key") as HTMLInputElement).value = FILLED_LLM.llmApiKey;

    submit();
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(chrome.storage.local.set).toHaveBeenCalledWith({
      config: expect.objectContaining(FILLED_LLM),
    });
    expect(document.getElementById("save-status")!.textContent).toBe("Сохранено");
  });

  it("проверяет подключение по тому, что сейчас в полях", async () => {
    await loadSettingsPage();
    for (const [id, value] of Object.entries({
      "input-llm-url": FILLED_LLM.llmUrl,
      "input-llm-model": FILLED_LLM.llmModel,
      "input-llm-api-key": FILLED_LLM.llmApiKey,
    })) {
      (document.getElementById(id) as HTMLInputElement).value = value;
    }
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ data: [{ id: FILLED_LLM.llmModel }] }),
    });

    document.getElementById("btn-check-llm")!.click();
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(globalThis.fetch).toHaveBeenCalledWith(
      `${FILLED_LLM.llmUrl}/models`,
      expect.objectContaining({ headers: { Authorization: `Bearer ${FILLED_LLM.llmApiKey}` } }),
    );
    expect(document.getElementById("llm-status")!.className).toContain("ok");
    expect(chrome.storage.local.set).not.toHaveBeenCalled();
  });

  it("не проверяет подключение с пустыми полями", async () => {
    await loadSettingsPage();
    const fetchCalls = vi.mocked(globalThis.fetch).mock.calls.length;

    document.getElementById("btn-check-llm")!.click();
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(vi.mocked(globalThis.fetch).mock.calls.length).toBe(fetchCalls);
    expect(document.getElementById("llm-status")!.className).toContain("error");
  });

  it("показывает и прячет токен", async () => {
    await loadSettingsPage(FILLED_LLM);
    const key = document.getElementById("input-llm-api-key") as HTMLInputElement;
    const toggle = document.getElementById("btn-toggle-key")!;

    toggle.click();
    expect(key.type).toBe("text");
    expect(toggle.getAttribute("aria-pressed")).toBe("true");

    toggle.click();
    expect(key.type).toBe("password");
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
  });

  it("сохраняет полностью очищенный LLM", async () => {
    await loadSettingsPage(FILLED_LLM);
    for (const id of ["input-llm-url", "input-llm-model", "input-llm-api-key"]) {
      (document.getElementById(id) as HTMLInputElement).value = "";
    }

    submit();
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(chrome.storage.local.set).toHaveBeenCalledWith({
      config: expect.objectContaining({ llmUrl: "", llmModel: "", llmApiKey: "" }),
    });
  });
});

describe("isLlmConfigured", () => {
  it("требует адрес, модель и токен разом", async () => {
    chromeMock.storage.local.get.mockResolvedValue({ config: {} });
    expect(isLlmConfigured(await getConfig())).toBe(false);

    chromeMock.storage.local.get.mockResolvedValue({
      config: { llmUrl: "https://example.test/v1", llmModel: "m" },
    });
    expect(isLlmConfigured(await getConfig())).toBe(false);

    chromeMock.storage.local.get.mockResolvedValue({ config: FILLED_LLM });
    expect(isLlmConfigured(await getConfig())).toBe(true);
  });
});
