import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureLlmPermission } from "../src/shared/llm-permission";

describe("ensureLlmPermission", () => {
  afterEach(() => {
    delete (chrome as any).permissions;
  });

  it("запрашивает доступ только к origin адреса LLM", async () => {
    const request = vi.fn().mockResolvedValue(true);
    (chrome as any).permissions = { request };
    await expect(ensureLlmPermission("https://llm.example.com/v1")).resolves.toBe(true);
    expect(request).toHaveBeenCalledWith({ origins: ["https://llm.example.com/*"] });
  });

  it("возвращает false при отказе и при некорректном адресе", async () => {
    const request = vi.fn().mockResolvedValue(false);
    (chrome as any).permissions = { request };
    await expect(ensureLlmPermission("https://llm.example.com/v1")).resolves.toBe(false);
    await expect(ensureLlmPermission("не адрес")).resolves.toBe(false);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("без chrome.permissions (веб-интерфейс приложения) не мешает запросу", async () => {
    await expect(ensureLlmPermission("https://llm.example.com/v1")).resolves.toBe(true);
  });
});
