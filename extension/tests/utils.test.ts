import { describe, expect, it, vi } from "vitest";
import { formatDateTime, getErrorMessage, plural, retry } from "../src/shared/utils";

describe("plural", () => {
  it("returns 'one' form for 1", () => {
    expect(plural(1, "участник", "участника", "участников")).toBe("участник");
  });
  it("returns 'few' form for 2-4", () => {
    expect(plural(2, "участник", "участника", "участников")).toBe("участника");
    expect(plural(3, "участник", "участника", "участников")).toBe("участника");
    expect(plural(4, "участник", "участника", "участников")).toBe("участника");
  });
  it("returns 'many' form for 5-20", () => {
    expect(plural(5, "участник", "участника", "участников")).toBe("участников");
    expect(plural(11, "участник", "участника", "участников")).toBe("участников");
    expect(plural(20, "участник", "участника", "участников")).toBe("участников");
  });
  it("returns 'one' form for 21", () => {
    expect(plural(21, "участник", "участника", "участников")).toBe("участник");
  });
  it("handles zero", () => {
    expect(plural(0, "участник", "участника", "участников")).toBe("участников");
  });
});

describe("formatDateTime", () => {
  it("returns date and time strings", () => {
    const date = new Date("2026-03-15T14:30:00Z");
    const result = formatDateTime(date);
    expect(result.date).toMatch(/\d{2}\.\d{2}\.\d{4}/);
    expect(result.time).toMatch(/\d{2}:\d{2}/);
  });
});

describe("retry", () => {
  it("returns result on first success", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const result = await retry(fn, { attempts: 3, delays: [100, 200, 300] });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });
  it("retries on failure and succeeds", async () => {
    const fn = vi.fn().mockRejectedValueOnce(new Error("fail")).mockResolvedValue("ok");
    const result = await retry(fn, { attempts: 3, delays: [10, 20, 30] });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });
  it("throws after all attempts exhausted", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("always fails"));
    await expect(retry(fn, { attempts: 3, delays: [10, 20, 30] })).rejects.toThrow("always fails");
    expect(fn).toHaveBeenCalledTimes(3);
  });
});

describe("getErrorMessage", () => {
  it("extracts message from Error", () => {
    expect(getErrorMessage(new Error("test"))).toBe("test");
  });
  it("converts non-Error to string", () => {
    expect(getErrorMessage("oops")).toBe("oops");
    expect(getErrorMessage(42)).toBe("42");
  });
});
