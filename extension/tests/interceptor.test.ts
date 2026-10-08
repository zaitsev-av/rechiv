import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// installInterceptor() вызывается при импорте: модуль импортируем заново после моков.

describe("WebRTC Interceptor", () => {
  let messages: any[];
  let originalRTC: any;
  let originalMR: any;
  let originalMediaDevices: any;

  beforeEach(() => {
    messages = [];
    originalRTC = (globalThis as any).RTCPeerConnection;
    originalMR = (globalThis as any).MediaRecorder;
    originalMediaDevices = navigator.mediaDevices;

    Object.defineProperty(navigator, "mediaDevices", {
      value: { getUserMedia: vi.fn().mockResolvedValue({ getAudioTracks: () => [] }) },
      writable: true,
      configurable: true,
    });

    class MockRTC {
      _listeners: Record<string, Function[]> = {};
      connectionState = "new";

      addEventListener(event: string, fn: Function) {
        if (!this._listeners[event]) this._listeners[event] = [];
        this._listeners[event].push(fn);
      }

      addTrack(_track: any, _stream: any) {}

      addTransceiver(_trackOrKind: any, _init?: any) {
        return { sender: {}, receiver: {}, direction: "sendrecv" };
      }

      _emit(event: string, data?: any) {
        for (const fn of this._listeners[event] || []) fn(data);
      }
    }

    (globalThis as any).RTCPeerConnection = MockRTC;

    (globalThis as any).MediaRecorder = class {
      state = "inactive";
      ondataavailable: any = null;
      static isTypeSupported = () => true;

      constructor(
        public stream: any,
        public options: any,
      ) {}
      start(_timeslice?: number) {
        this.state = "recording";
      }
      stop() {
        this.state = "inactive";
      }
    };

    vi.spyOn(window, "postMessage").mockImplementation((msg) => {
      if (msg?.type?.startsWith("RECHIV_")) messages.push(msg);
    });

    vi.resetModules();
  });

  afterEach(() => {
    (globalThis as any).RTCPeerConnection = originalRTC;
    (globalThis as any).MediaRecorder = originalMR;
    Object.defineProperty(navigator, "mediaDevices", {
      value: originalMediaDevices,
      writable: true,
      configurable: true,
    });
    vi.restoreAllMocks();
  });

  it("detects WebRTC connection", async () => {
    await import("../src/content/interceptor");
    new (globalThis as any).RTCPeerConnection();
    expect(messages).toContainEqual({ type: "RECHIV_WEBRTC_DETECTED" });
  });

  it("notifies on remote track via addEventListener", async () => {
    await import("../src/content/interceptor");
    const pc = new (globalThis as any).RTCPeerConnection();

    const stream = { id: "remote-stream-1", getAudioTracks: () => [{ kind: "audio" }] };
    const track = { kind: "audio" };
    pc._emit("track", { track, streams: [stream] });

    expect(messages).toContainEqual(
      expect.objectContaining({ type: "RECHIV_TRACK_ADDED", kind: "remote" }),
    );
  });

  it("notifies on local track via addTrack", async () => {
    await import("../src/content/interceptor");
    const pc = new (globalThis as any).RTCPeerConnection();

    const track = { kind: "audio" };
    const stream = { id: "local-stream-1", getAudioTracks: () => [{ kind: "audio" }] };
    pc.addTrack(track, stream);

    expect(messages).toContainEqual(
      expect.objectContaining({ type: "RECHIV_TRACK_ADDED", kind: "local" }),
    );
  });

  it("does not notify for non-audio tracks", async () => {
    await import("../src/content/interceptor");
    const pc = new (globalThis as any).RTCPeerConnection();

    const stream = { id: "video-stream-1", getAudioTracks: () => [] };
    const track = { kind: "video" };
    pc._emit("track", { track, streams: [stream] });

    expect(messages.filter((m) => m.type === "RECHIV_TRACK_ADDED")).toHaveLength(0);
  });

  it("notifies on connectionstatechange", async () => {
    await import("../src/content/interceptor");
    const pc = new (globalThis as any).RTCPeerConnection();
    pc.connectionState = "connected";
    pc._emit("connectionstatechange");

    expect(messages).toContainEqual(
      expect.objectContaining({ type: "RECHIV_CONNECTION_STATE", state: "connected" }),
    );
  });

  it("starts recording when START_CAPTURE sent after track added", async () => {
    await import("../src/content/interceptor");
    const pc = new (globalThis as any).RTCPeerConnection();

    const stream = {
      id: "audio-stream-start",
      getTracks: () => [],
      getAudioTracks: () => [{ kind: "audio", readyState: "live" }],
    };
    const track = { kind: "audio" };
    pc._emit("track", { track, streams: [stream] });

    const MR = (globalThis as any).MediaRecorder;
    const instances: any[] = [];
    const OrigMR = MR;
    (globalThis as any).MediaRecorder = class extends OrigMR {
      constructor(s: any, o: any) {
        super(s, o);
        instances.push(this);
      }
    };
    (globalThis as any).MediaRecorder.isTypeSupported = () => true;

    window.dispatchEvent(
      new MessageEvent("message", {
        data: { type: "RECHIV_START_CAPTURE" },
        source: window,
      }),
    );

    expect(instances.length).toBeGreaterThanOrEqual(1);
    expect(instances[0].state).toBe("recording");
  });

  it("flushes buffered audio via sendBeacon on pagehide", async () => {
    const started: number[] = [];
    (globalThis as any).MediaRecorder = class {
      state = "inactive";
      ondataavailable: any = null;
      onstop: any = null;
      static isTypeSupported = () => true;

      constructor(
        public stream: any,
        public options: any,
      ) {}
      start(timeslice?: number) {
        this.state = "recording";
        started.push(timeslice as number);
        // Без timeslice данные приходят только на stop().
        if (timeslice) {
          this.ondataavailable?.({ data: new Blob(["chunk"], { type: "audio/webm" }) });
        }
      }
      stop() {
        this.state = "inactive";
        this.onstop?.();
      }
    };

    const beacon = vi.fn().mockReturnValue(true);
    Object.defineProperty(navigator, "sendBeacon", {
      value: beacon,
      writable: true,
      configurable: true,
    });

    await import("../src/content/interceptor");
    const pc = new (globalThis as any).RTCPeerConnection();
    const stream = {
      id: "audio-stream-beacon",
      getTracks: () => [],
      getAudioTracks: () => [{ kind: "audio", readyState: "live" }],
    };
    pc._emit("track", { track: { kind: "audio" }, streams: [stream] });

    window.dispatchEvent(
      new MessageEvent("message", {
        data: {
          type: "RECHIV_START_CAPTURE",
          sessionId: "session-1",
          sttServiceUrl: "http://localhost:9876",
          uploadToken: "upload-token",
        },
        source: window,
      }),
    );

    expect(started).toContain(1000);

    window.dispatchEvent(new Event("pagehide"));

    expect(beacon).toHaveBeenCalledTimes(1);
    const [url, form] = beacon.mock.calls[0];
    expect(url).toBe("http://localhost:9876/sessions/session-1/chunks");
    expect((form as FormData).get("speakerId")).toBe("remote-audio-stream-beacon");
    expect((form as FormData).get("uploadToken")).toBe("upload-token");
  });

  it("does not send the same audio twice after a beacon flush", async () => {
    const instances: any[] = [];
    (globalThis as any).MediaRecorder = class {
      state = "inactive";
      ondataavailable: any = null;
      onstop: any = null;
      static isTypeSupported = () => true;

      constructor(
        public stream: any,
        public options: any,
      ) {
        instances.push(this);
      }
      start(timeslice?: number) {
        this.state = "recording";
        if (timeslice) {
          this.ondataavailable?.({ data: new Blob(["chunk"], { type: "audio/webm" }) });
        }
      }
      stop() {
        this.state = "inactive";
        this.onstop?.();
      }
    };

    Object.defineProperty(navigator, "sendBeacon", {
      value: vi.fn().mockReturnValue(true),
      writable: true,
      configurable: true,
    });

    await import("../src/content/interceptor");
    const pc = new (globalThis as any).RTCPeerConnection();
    const stream = {
      id: "audio-stream-dup",
      getTracks: () => [],
      getAudioTracks: () => [{ kind: "audio", readyState: "live" }],
    };
    pc._emit("track", { track: { kind: "audio" }, streams: [stream] });

    window.dispatchEvent(
      new MessageEvent("message", {
        data: {
          type: "RECHIV_START_CAPTURE",
          sessionId: "session-1",
          sttServiceUrl: "http://localhost:9876",
        },
        source: window,
      }),
    );
    window.dispatchEvent(new Event("pagehide"));

    const chunksBefore = messages.filter((m) => m.type === "RECHIV_CHUNK").length;
    instances[instances.length - 1].stop();

    expect(messages.filter((m) => m.type === "RECHIV_CHUNK")).toHaveLength(chunksBefore);
  });

  it.each([
    { name: "тишину не отправляет", level: 0, expectedChunks: 0 },
    { name: "речь отправляет", level: 0.3, expectedChunks: 1 },
  ])("VAD: $name", async ({ level, expectedChunks }) => {
    vi.useFakeTimers();
    const instances: any[] = [];
    (globalThis as any).MediaRecorder = class {
      state = "inactive";
      ondataavailable: any = null;
      onstop: any = null;
      static isTypeSupported = () => true;

      constructor(
        public stream: any,
        public options: any,
      ) {
        instances.push(this);
      }
      start(timeslice?: number) {
        this.state = "recording";
        if (timeslice) {
          this.ondataavailable?.({ data: new Blob(["chunk"], { type: "audio/webm" }) });
        }
      }
      stop() {
        this.state = "inactive";
        this.onstop?.();
      }
    };
    (globalThis as any).AudioContext = class {
      createAnalyser() {
        return {
          fftSize: 2048,
          getFloatTimeDomainData: (buffer: Float32Array) => buffer.fill(level),
        };
      }
      createMediaStreamSource() {
        return { connect: () => undefined };
      }
      close() {
        return Promise.resolve();
      }
    };
    (globalThis as any).Audio = class {
      srcObject: unknown = null;
      muted = false;
      play() {
        return Promise.resolve();
      }
      pause() {}
    };

    await import("../src/content/interceptor");
    const pc = new (globalThis as any).RTCPeerConnection();
    const stream = {
      id: `audio-stream-vad-${level}`,
      getTracks: () => [],
      getAudioTracks: () => [{ kind: "audio", readyState: "live", stop: () => undefined }],
    };
    pc._emit("track", { track: { kind: "audio" }, streams: [stream] });

    window.dispatchEvent(
      new MessageEvent("message", {
        data: {
          type: "RECHIV_START_CAPTURE",
          sessionId: "session-1",
          sttServiceUrl: "http://localhost:9876",
        },
        source: window,
      }),
    );
    messages.length = 0;

    await vi.advanceTimersByTimeAsync(21_000);
    // FileReader живёт вне фейковых таймеров.
    vi.useRealTimers();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(messages.filter((m) => m.type === "RECHIV_CHUNK")).toHaveLength(expectedChunks);
  });

  it("does not patch RTCPeerConnection if not present", async () => {
    (globalThis as any).RTCPeerConnection = undefined;
    const { installInterceptor } = await import("../src/content/interceptor");
    expect(() => installInterceptor()).not.toThrow();
  });
});
