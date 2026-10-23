import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Главное — полнота записи: однажды обрезка payload испортила весь замер. */

type Listener = (event: { data: unknown }) => void;

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static sent: unknown[] = [];
  private _listeners: Listener[] = [];

  constructor(readonly url: string | URL) {
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, handler: Listener) {
    if (type === "message") this._listeners.push(handler);
  }

  send(data: unknown) {
    FakeWebSocket.sent.push(data);
  }

  receive(data: unknown) {
    for (const handler of this._listeners) handler({ data });
  }
}

type DiagApi = {
  save(): number;
  stats(): Record<string, number>;
  stop(): void;
  audioSlots(count?: number): number;
  audio(): Record<string, { samples: number; ssrc: number[] }>;
};

function diag(): DiagApi {
  return (globalThis as unknown as { __rechivDiag: DiagApi }).__rechivDiag;
}

async function loadDiagnostics() {
  vi.resetModules();
  return import("../src/content/platforms/diagnostics");
}

let originalWebSocket: typeof WebSocket;

beforeEach(() => {
  FakeWebSocket.instances = [];
  FakeWebSocket.sent = [];
  originalWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => {
  globalThis.WebSocket = originalWebSocket;
  diag()?.stop();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("диагностика сигналинга", () => {
  it("пишет payload целиком, без обрезки", async () => {
    const { watchWebSockets } = await loadDiagnostics();
    watchWebSockets();

    const huge = JSON.stringify({ slots: Array.from({ length: 400 }, (_, i) => ({ id: i })) });
    expect(huge.length).toBeGreaterThan(1000);

    new (globalThis.WebSocket as unknown as new (url: string) => unknown)(
      "wss://goloom.strm.yandex.net/join",
    );
    FakeWebSocket.instances.at(-1)?.receive(huge);

    const saved = capture();
    const message = saved.find((entry) => entry.type === "ws" && entry.dir === "in");
    expect(message?.payload).toHaveLength(huge.length);
    expect(String(message?.payload)).not.toContain("…");
  });

  it("записывает исходящие сообщения, а не только входящие", async () => {
    const { watchWebSockets } = await loadDiagnostics();
    watchWebSockets();

    const socket = new (
      globalThis.WebSocket as unknown as new (
        url: string,
      ) => { send(d: string): void }
    )("wss://goloom.strm.yandex.net/join");
    socket.send('{"subscribe":{"slot":1}}');

    const saved = capture();
    const outgoing = saved.find((entry) => entry.type === "ws" && entry.dir === "out");
    expect(outgoing?.payload).toBe('{"subscribe":{"slot":1}}');
    expect(FakeWebSocket.sent).toEqual(['{"subscribe":{"slot":1}}']);
  });
});

describe("подмена audioSlotsCount", () => {
  function openSocket() {
    return new (globalThis.WebSocket as unknown as new (url: string) => { send(d: string): void })(
      "wss://goloom.strm.yandex.net/join",
    );
  }

  const setSlots = (audioSlotsCount: number) =>
    JSON.stringify({
      uid: "u-1",
      setSlots: {
        slots: [{ width: 1584, height: 891 }],
        audioSlotsCount,
        key: 7,
        withSelfView: true,
        gridConfig: {},
      },
    });

  it("по умолчанию не трогает сообщение", async () => {
    const { watchWebSockets } = await loadDiagnostics();
    watchWebSockets();

    const original = setSlots(0);
    openSocket().send(original);

    expect(FakeWebSocket.sent[0]).toBe(original);
  });

  it("просит отдельные аудиослоты вместо нуля, когда попросили из консоли", async () => {
    const { watchWebSockets } = await loadDiagnostics();
    watchWebSockets();
    diag().audioSlots(8);
    openSocket().send(setSlots(0));

    const sent = JSON.parse(String(FakeWebSocket.sent[0]));
    expect(sent.setSlots.audioSlotsCount).toBe(8);
    expect(sent.uid).toBe("u-1");
    expect(sent.setSlots.key).toBe(7);
    expect(sent.setSlots.slots).toEqual([{ width: 1584, height: 891 }]);
    expect(sent.setSlots.withSelfView).toBe(true);
  });

  it("выключается через audioSlots(0) и пропускает сообщение как есть", async () => {
    const { watchWebSockets } = await loadDiagnostics();
    watchWebSockets();
    diag().audioSlots(8);
    diag().audioSlots(0);

    const original = setSlots(0);
    openSocket().send(original);

    expect(FakeWebSocket.sent[0]).toBe(original);
  });

  it("не трогает другие сообщения сигналинга", async () => {
    const { watchWebSockets } = await loadDiagnostics();
    watchWebSockets();

    const hello = JSON.stringify({ uid: "u-2", hello: { participantMeta: { name: "Кто-то" } } });
    openSocket().send(hello);

    expect(FakeWebSocket.sent[0]).toBe(hello);
  });

  it("переживает бинарный и битый payload", async () => {
    const { watchWebSockets } = await loadDiagnostics();
    watchWebSockets();
    const socket = openSocket();

    expect(() => socket.send("не json, но со словом setSlots")).not.toThrow();
    expect(FakeWebSocket.sent[0]).toBe("не json, но со словом setSlots");
  });

  it("записывает факт подмены, чтобы это было видно в файле", async () => {
    const { watchWebSockets } = await loadDiagnostics();
    watchWebSockets();
    diag().audioSlots(3);
    openSocket().send(setSlots(0));

    const patched = capture().find((entry) => entry.type === "setSlotsPatched");
    expect(patched).toMatchObject({ from: 0, to: 3 });
  });
});

describe("диагностика RTP", () => {
  it("снимает SSRC, CSRC и уровень по аудиоприёмникам", async () => {
    vi.useFakeTimers();
    const { watchPeerConnection, watchWebSockets } = await loadDiagnostics();
    watchWebSockets();

    const receiver = {
      track: { kind: "audio" },
      getSynchronizationSources: () => [{ source: 111, audioLevel: 0.42 }],
      getContributingSources: () => [{ source: 222, audioLevel: 0.1 }],
    };
    const pc = {
      getReceivers: () => [receiver, { track: { kind: "video" } }],
      getTransceivers: () => [{ receiver, mid: "audio_AA" }],
      addEventListener: () => undefined,
    } as unknown as RTCPeerConnection;

    watchPeerConnection(pc);
    vi.advanceTimersByTime(250);

    const samples = capture().filter((entry) => entry.type === "rtp");
    expect(samples.length).toBeGreaterThan(0);
    expect(samples[0]).toMatchObject({
      mid: "audio_AA",
      sync: [[111, 0.42]],
      csrc: [[222, 0.1]],
    });
  });

  it("переживает приёмник, который не отдаёт источники", async () => {
    vi.useFakeTimers();
    const { watchPeerConnection, watchWebSockets } = await loadDiagnostics();
    watchWebSockets();

    const pc = {
      getReceivers: () => [
        {
          track: { kind: "audio" },
          getSynchronizationSources: () => {
            throw new Error("not supported");
          },
        },
      ],
      getTransceivers: () => {
        throw new Error("not supported");
      },
      addEventListener: () => undefined,
    } as unknown as RTCPeerConnection;

    watchPeerConnection(pc);
    expect(() => vi.advanceTimersByTime(250)).not.toThrow();
  });
});

function capture(): Record<string, unknown>[] {
  const lines: string[] = [];
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  URL.createObjectURL = ((blob: any) => {
    lines.push(...String(blob.__text ?? "").split("\n"));
    return "blob:test";
  }) as typeof URL.createObjectURL;
  URL.revokeObjectURL = (() => undefined) as typeof URL.revokeObjectURL;

  // jsdom не читает Blob синхронно, поэтому запоминаем текст при создании.
  const OriginalBlob = globalThis.Blob;
  globalThis.Blob = class extends OriginalBlob {
    __text: string;
    constructor(parts: any[], options?: BlobPropertyBag) {
      super(parts, options);
      this.__text = parts.join("");
    }
  } as any;

  try {
    diag().save();
  } finally {
    globalThis.Blob = OriginalBlob;
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
  }

  return lines
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}
