import { beforeEach, describe, expect, it, vi } from "vitest";
import { SttApiClient } from "../src/shared/api-client";
import type { SummaryResult } from "../src/shared/types";

describe("SttApiClient — summary", () => {
  let client: SttApiClient;

  beforeEach(() => {
    client = new SttApiClient("http://localhost:9876");
    vi.restoreAllMocks();
  });

  it("getSummary возвращает данные при 200", async () => {
    const summary: SummaryResult = {
      content: "# Саммари",
      createdAt: "2026-03-31T10:00:00",
      model: "glm-4.5-air",
      chunked: false,
    };
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(summary), { status: 200 }),
    );

    const result = await client.getSummary("abc123");
    expect(result).toEqual(summary);
  });

  it("getSummary возвращает null при 404", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("Not found", { status: 404 }));

    const result = await client.getSummary("abc123");
    expect(result).toBeNull();
  });

  it("putSummary отправляет PUT", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 204 }));

    const summary: SummaryResult = {
      content: "# Саммари",
      createdAt: "2026-03-31T10:00:00",
      model: "glm-4.5-air",
      chunked: false,
    };
    await client.putSummary("abc123", summary);

    expect(fetchSpy).toHaveBeenCalledWith(
      "http://localhost:9876/sessions/abc123/summary",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify(summary),
      }),
    );
  });
  it("автосаммари отправляет If-None-Match и принимает сохранённую вручную версию", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 412 }));
    await expect(
      client.putSummary(
        "abc123",
        { content: "Авто", createdAt: "", model: "model", chunked: false },
        true,
      ),
    ).resolves.toBeUndefined();
    expect(fetchSpy).toHaveBeenCalledWith(
      "http://localhost:9876/sessions/abc123/summary",
      expect.objectContaining({ headers: expect.objectContaining({ "If-None-Match": "*" }) }),
    );
  });
});
