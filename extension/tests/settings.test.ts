import { beforeEach, describe, expect, it, vi } from "vitest";
import { chromeMock } from "./setup";

const FILLED_LLM = {
  url: "https://example.test/v1",
  model: "some-model",
  apiKey: "token",
};

interface DesktopState {
  health?: Record<string, unknown>;
  llm?: { url: string; model: string; apiKey: string; configured: boolean };
  check?: Record<string, unknown>;
}

let requests: { method: string; path: string; body?: unknown }[] = [];

async function loadSettingsPage(desktop: DesktopState = {}) {
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
  chromeMock.storage.local.get.mockImplementation(async () => ({}));
  requests = [];
  let llm = desktop.llm ?? { url: "", model: "", apiKey: "", configured: false };
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), "http://localhost").pathname;
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ method, path, body });
    if (path === "/health") {
      return Response.json(desktop.health ?? { status: "ok", engine: { status: "ready" } });
    }
    if (path === "/settings/llm" && method === "PUT") {
      llm = { ...body, configured: Boolean(body.url && body.model && body.apiKey) };
      return Response.json(llm);
    }
    if (path === "/settings/llm") return Response.json(llm);
    if (path === "/settings/llm/check") {
      return Response.json(desktop.check ?? { state: "ok", detail: "Модель доступна" });
    }
    return Response.json({});
  }) as typeof fetch;
  vi.resetModules();
  await import("../src/pages/settings");
  await new Promise((resolve) => setTimeout(resolve, 30));
}

const field = (id: string) => document.getElementById(id) as HTMLInputElement;

function fill(values: Partial<typeof FILLED_LLM>) {
  if (values.url !== undefined) field("input-llm-url").value = values.url;
  if (values.model !== undefined) field("input-llm-model").value = values.model;
  if (values.apiKey !== undefined) field("input-llm-api-key").value = values.apiKey;
}

async function submit() {
  document
    .getElementById("settings-form")!
    .dispatchEvent(new Event("submit", { cancelable: true }));
  await new Promise((resolve) => setTimeout(resolve, 10));
}

const llmWrites = () => requests.filter((r) => r.path === "/settings/llm" && r.method === "PUT");

describe("settings page", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("не подставляет адрес и модель LLM, когда их не задавали", async () => {
    await loadSettingsPage();

    expect(field("input-llm-url").value).toBe("");
    expect(field("input-llm-model").value).toBe("");
    expect(document.getElementById("input-stt-url")).toBeNull();
  });

  it("показывает настройку из desktop", async () => {
    await loadSettingsPage({ llm: { ...FILLED_LLM, configured: true } });

    expect(field("input-llm-url").value).toBe(FILLED_LLM.url);
    expect(field("input-llm-model").value).toBe(FILLED_LLM.model);
    expect(field("input-llm-api-key").value).toBe(FILLED_LLM.apiKey);
  });

  it("показывает готовность локального приложения", async () => {
    await loadSettingsPage();

    expect(document.getElementById("health")!.className).toContain("ready");
    expect(document.getElementById("health-title")!.textContent).toBe("Приложение готово к записи");
  });

  it("сообщает, что движок распознавания не поднялся", async () => {
    await loadSettingsPage({
      health: { status: "ok", engine: { status: "error", error: "нет torch" } },
    });

    expect(document.getElementById("health")!.className).toContain("warning");
    expect(document.getElementById("health-detail")!.textContent).toBe("нет torch");
  });

  it("не сохраняет наполовину заполненный LLM", async () => {
    await loadSettingsPage();
    fill({ url: FILLED_LLM.url });

    await submit();

    expect(llmWrites()).toHaveLength(0);
    expect(document.getElementById("save-status")!.className).toContain("error");
    expect(field("input-llm-model").className).toContain("invalid");
  });

  it("сохраняет в desktop, когда заполнены все три поля", async () => {
    await loadSettingsPage();
    fill(FILLED_LLM);

    await submit();

    expect(llmWrites()).toEqual([{ method: "PUT", path: "/settings/llm", body: FILLED_LLM }]);
    expect(document.getElementById("save-status")!.textContent).toBe("Сохранено");
    expect(chrome.storage.local.set).not.toHaveBeenCalled();
  });

  it("проверяет подключение по тому, что сейчас в полях", async () => {
    await loadSettingsPage();
    fill(FILLED_LLM);

    document.getElementById("btn-check-llm")!.click();
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(requests.at(-1)).toEqual({
      method: "POST",
      path: "/settings/llm/check",
      body: FILLED_LLM,
    });
    expect(document.getElementById("llm-status")!.className).toContain("ok");
    expect(llmWrites()).toHaveLength(0);
  });

  it("не проверяет подключение с пустыми полями", async () => {
    await loadSettingsPage();
    const calls = requests.length;

    document.getElementById("btn-check-llm")!.click();
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(requests.length).toBe(calls);
    expect(document.getElementById("llm-status")!.className).toContain("error");
  });

  it("показывает и прячет токен", async () => {
    await loadSettingsPage();
    const key = field("input-llm-api-key");
    const toggle = document.getElementById("btn-toggle-key")!;

    toggle.click();
    expect(key.type).toBe("text");
    expect(toggle.getAttribute("aria-pressed")).toBe("true");

    toggle.click();
    expect(key.type).toBe("password");
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
  });

  it("сохраняет полностью очищенный LLM", async () => {
    await loadSettingsPage({ llm: { ...FILLED_LLM, configured: true } });
    fill({ url: "", model: "", apiKey: "" });

    await submit();

    expect(llmWrites()[0].body).toEqual({ url: "", model: "", apiKey: "" });
    expect(document.getElementById("save-status")!.textContent).toBe("Сохранено");
  });
});
