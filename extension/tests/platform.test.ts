import { describe, expect, it } from "vitest";
import {
  ALL_MATCHES,
  ALL_ORIGINS,
  isCallPage,
  platformForHost,
  platformForUrl,
} from "../src/shared/platform";

describe("platform registry", () => {
  it("finds a platform by url", () => {
    expect(platformForUrl("https://stream.wb.ru/room/1")?.id).toBe("wb-stream");
  });

  it("ignores unknown hosts", () => {
    expect(platformForUrl("https://zoom.us/j/123")).toBeNull();
  });

  it("returns null for empty and malformed urls", () => {
    expect(platformForUrl(undefined)).toBeNull();
    expect(platformForUrl("")).toBeNull();
    expect(platformForUrl("не ссылка")).toBeNull();
  });

  it("does not match a lookalike host", () => {
    expect(platformForUrl("https://stream.wb.ru.evil.com/room/1")).toBeNull();
  });

  it("finds a platform by host", () => {
    expect(platformForHost("stream.wb.ru")?.name).toBe("WB Stream");
    expect(platformForHost("wb.ru")).toBeNull();
  });

  it("treats only callPath urls as a call page", () => {
    expect(isCallPage("https://stream.wb.ru/room/1")).toBe(true);
    expect(isCallPage("https://stream.wb.ru/")).toBe(false);
    expect(isCallPage("https://zoom.us/j/1")).toBe(false);
  });

  it("matches callPathPattern for calls without a common prefix", () => {
    expect(isCallPage("https://meet.google.com/abc-defg-hij")).toBe(true);
    expect(isCallPage("https://meet.google.com/abc-defg-hij?authuser=0")).toBe(true);
    expect(isCallPage("https://meet.google.com/")).toBe(false);
    expect(isCallPage("https://meet.google.com/landing")).toBe(false);
  });

  it("builds match patterns and origins for every host", () => {
    expect(ALL_MATCHES).toContain("https://stream.wb.ru/*");
    expect(ALL_ORIGINS).toContain("https://stream.wb.ru");
  });
});
