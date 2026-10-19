import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PageAdapter } from "../src/content/platforms/types";
import type { VadTimeline } from "../src/shared/types";

let timeline: VadTimeline;
const adapter: PageAdapter = {
  id: "telemost",
  getSpeakerMap: () => null,
  isLocalMuted: () => false,
  syncMuteSubscription: () => undefined,
  teardown: () => undefined,
};
vi.mock("../src/content/platforms/registry", () => ({
  pickPageAdapter: () => adapter,
  capabilitiesForHost: () => ({ localAudio: "microphone" }),
}));

function message(data: Record<string, unknown>) {
  window.dispatchEvent(new MessageEvent("message", { source: window, data }));
}

function start() {
  message({
    type: "RECHIV_START_CAPTURE",
    sessionId: "session-1",
    sttServiceUrl: "http://localhost:9876",
    uploadToken: "upload-token",
  });
}

function updates() {
  return vi
    .mocked(window.postMessage)
    .mock.calls.map(([msg]) => msg)
    .filter((msg) => msg.type === "RECHIV_VAD_TIMELINE");
}

describe("сохранение разметки во время захвата", () => {
  let listeners: [string, EventListenerOrEventListenerObject][];

  beforeEach(() => {
    listeners = [];
    vi.useFakeTimers();
    vi.resetModules();
    timeline = {
      localParticipantId: "local",
      participants: [{ participantId: "guest", name: "Гость" }],
      events: [{ at: 0, active: ["guest"] }],
      micEvents: [{ at: 0, unmuted: ["guest"] }],
    };
    adapter.getVadTimeline = vi.fn(() => structuredClone(timeline));
    vi.stubGlobal("RTCPeerConnection", undefined);
    vi.stubGlobal("navigator", {
      mediaDevices: { getUserMedia: vi.fn() },
      sendBeacon: vi.fn().mockReturnValue(true),
    });
    vi.spyOn(window, "postMessage").mockImplementation(() => undefined);
    const addListener = window.addEventListener.bind(window);
    vi.spyOn(window, "addEventListener").mockImplementation((type, listener, options) => {
      listeners.push([type, listener]);
      addListener(type, listener, options);
    });
  });

  afterEach(() => {
    message({ type: "RECHIV_STOP_CAPTURE" });
    for (const [type, listener] of listeners) window.removeEventListener(type, listener);
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("раз в 30 секунд отправляет только изменившийся снимок, включая имена и микрофоны", async () => {
    await import("../src/content/interceptor");
    vi.advanceTimersByTime(60_000);
    expect(updates()).toHaveLength(0);
    start();
    vi.advanceTimersByTime(29_999);
    expect(updates()).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(updates()).toEqual([{ type: "RECHIV_VAD_TIMELINE", vadTimeline: timeline }]);
    vi.advanceTimersByTime(60_000);
    expect(updates()).toHaveLength(1);

    timeline.events.push({ at: 91, active: [] });
    vi.advanceTimersByTime(30_000);
    expect(updates()).toHaveLength(2);
    timeline.micEvents?.push({ at: 121, unmuted: [] });
    vi.advanceTimersByTime(30_000);
    expect(updates()).toHaveLength(3);
    timeline.participants[0].name = "Новое имя";
    vi.advanceTimersByTime(30_000);
    expect(updates()).toHaveLength(4);
  });

  it("останавливает таймер и сохраняет штатную отправку; новый захват сбрасывает снимок", async () => {
    await import("../src/content/interceptor");
    start();
    vi.advanceTimersByTime(30_000);
    message({ type: "RECHIV_STOP_CAPTURE" });
    expect(window.postMessage).toHaveBeenCalledWith(
      { type: "RECHIV_CAPTURE_STOPPED", vadTimeline: timeline },
      location.origin,
    );
    vi.mocked(adapter.getVadTimeline!).mockClear();
    vi.advanceTimersByTime(60_000);
    expect(adapter.getVadTimeline).not.toHaveBeenCalled();
    expect(updates()).toHaveLength(1);
    start();
    vi.advanceTimersByTime(30_000);
    expect(updates()).toHaveLength(2);
  });

  it("на pagehide отправляет свежий JSON строкой с токеном, даже без аудио", async () => {
    await import("../src/content/interceptor");
    window.dispatchEvent(new Event("pagehide"));
    expect(navigator.sendBeacon).not.toHaveBeenCalled();
    start();
    vi.advanceTimersByTime(30_000);
    timeline.micEvents?.push({ at: 31, unmuted: [] });
    window.dispatchEvent(new Event("pagehide"));
    expect(navigator.sendBeacon).toHaveBeenCalledExactlyOnceWith(
      "http://localhost:9876/sessions/session-1/vad",
      JSON.stringify({ ...timeline, uploadToken: "upload-token" }),
    );
    message({ type: "RECHIV_STOP_CAPTURE" });
    window.dispatchEvent(new Event("pagehide"));
    expect(navigator.sendBeacon).toHaveBeenCalledTimes(1);
  });

  it("без getVadTimeline не отправляет обновления и beacon", async () => {
    delete adapter.getVadTimeline;
    await import("../src/content/interceptor");
    start();
    vi.advanceTimersByTime(90_000);
    window.dispatchEvent(new Event("pagehide"));
    expect(updates()).toHaveLength(0);
    expect(navigator.sendBeacon).not.toHaveBeenCalled();
    message({ type: "RECHIV_STOP_CAPTURE" });
    expect(window.postMessage).toHaveBeenCalledWith(
      { type: "RECHIV_CAPTURE_STOPPED" },
      location.origin,
    );
  });
});
