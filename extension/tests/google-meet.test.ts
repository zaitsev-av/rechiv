import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GoogleMeetPageAdapter } from "../src/content/platforms/google-meet/page";
import {
  decodeCollectionsMessage,
  decodeRpcResponse,
  requestDeviceId,
} from "../src/content/platforms/google-meet/protocol";

const varint = (value: number): number[] => {
  const out: number[] = [];
  let rest = value;
  while (rest >= 0x80) {
    out.push((rest % 0x80) | 0x80);
    rest = Math.floor(rest / 0x80);
  }
  out.push(rest);
  return out;
};
const num = (field: number, value: number) => [...varint(field * 8), ...varint(value)];
const bytes = (field: number, value: number[] | string) => {
  const data = typeof value === "string" ? [...new TextEncoder().encode(value)] : value;
  return [...varint(field * 8 + 2), ...varint(data.length), ...data];
};
const nest = (path: number[], inner: number[]) =>
  path.reduceRight((acc, field) => bytes(field, acc), inner);

const device = (n: string) => `spaces/space1/devices/${n}`;
const audioSource = (csrc: number, deviceId: string, muted: boolean) => [
  ...num(1, 1),
  ...num(2, 1),
  ...bytes(4, String(csrc)),
  ...bytes(6, device(deviceId)),
  ...bytes(8, num(1, csrc)),
  ...bytes(10, num(1, muted ? 1 : 0)),
];
const videoSource = (ssrc: number, deviceId: string) => [
  ...num(1, 1),
  ...num(2, 2),
  ...bytes(4, String(ssrc)),
  ...bytes(6, device(deviceId)),
];
const deviceRecord = (deviceId: string, name: string) => [
  ...bytes(1, device(deviceId)),
  ...bytes(2, name),
  ...bytes(3, "https://example.test/avatar"),
  ...num(4, 3),
];
const message = (records: number[][], gzip = true) => {
  const raw = Uint8Array.from(
    nest(
      [1, 2, 3],
      records.flatMap((record) => bytes(2, record)),
    ),
  );
  const data = gzip ? new Uint8Array(gzipSync(raw)) : raw;
  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
};

const toBuffer = (data: Uint8Array) =>
  data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
const syncResponse = (devices: [string, string][]) =>
  Buffer.from(
    Uint8Array.from(
      nest(
        [1, 2],
        devices.flatMap(([id, name]) => bytes(2, deviceRecord(id, name))),
      ),
    ),
  ).toString("base64");
const updateRequest = (deviceId: string) =>
  Uint8Array.from(nest([1], [...bytes(1, device(deviceId)), ...num(4, 1)]));
const RPC = "https://meet.google.com/$rpc/google.rtc.meetings.v1.";

describe("Google Meet protocol", () => {
  it("decodes audio sources with CSRC above int32 and skips video", async () => {
    const update = await decodeCollectionsMessage(
      message([audioSource(2499224740, "415", true), videoSource(2141037218, "415")]),
    );
    expect(update.sources).toEqual([{ csrc: 2499224740, deviceId: "415", muted: true }]);
  });

  it("decodes device names", async () => {
    const update = await decodeCollectionsMessage(
      message([nest([13, 1], [...bytes(1, num(1, 44)), ...bytes(2, deviceRecord("407", "Анна"))])]),
    );
    expect(update.devices).toEqual([{ deviceId: "407", name: "Анна" }]);
  });

  it("reads devices from a base64 RPC response", () => {
    const body = new TextEncoder().encode(
      syncResponse([
        ["413", "Анна"],
        ["414", "Я"],
      ]),
    );
    expect(decodeRpcResponse(toBuffer(body)).devices).toEqual([
      { deviceId: "413", name: "Анна" },
      { deviceId: "414", name: "Я" },
    ]);
  });

  it("reads the device of an UpdateMeetingDevice request", () => {
    expect(requestDeviceId(updateRequest("414"))).toBe("414");
    expect(requestDeviceId(Uint8Array.from([1, 2, 3]))).toBeNull();
  });

  it("ignores garbage", async () => {
    const update = await decodeCollectionsMessage(Uint8Array.from([0xff, 0xff, 0x01]).buffer);
    expect(update).toEqual({ sources: [], devices: [] });
  });
});

describe("GoogleMeetPageAdapter", () => {
  let now: number;
  let contributing: Map<string, { source: number; audioLevel: number; timestamp: number }[]>;

  const peerConnection = () => {
    const listeners: Record<string, ((event: unknown) => void)[]> = {};
    const transceiver = (mid: string) => ({
      mid,
      receiver: {
        track: { kind: "audio" },
        getSynchronizationSources: () => [{ timestamp: now }],
        getContributingSources: () => contributing.get(mid) ?? [],
      },
    });
    return {
      connectionState: "connected",
      addEventListener: (type: string, fn: (event: unknown) => void) => {
        listeners[type] = [...(listeners[type] ?? []), fn];
      },
      getTransceivers: () => [transceiver("3"), transceiver("4")],
      emit: (type: string, event: unknown) => {
        for (const fn of listeners[type] ?? []) fn(event);
      },
    };
  };

  const openCollections = (pc: ReturnType<typeof peerConnection>) => {
    const channelListeners: ((event: { data: ArrayBuffer }) => void)[] = [];
    pc.emit("datachannel", {
      channel: {
        label: "collections",
        addEventListener: (_: string, fn: (event: { data: ArrayBuffer }) => void) =>
          channelListeners.push(fn),
      },
    });
    return async (data: ArrayBuffer) => {
      for (const fn of channelListeners) fn({ data });
      await vi.waitFor(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 20));
    };
  };

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "performance"] });
    now = 0;
    contributing = new Map();
    document.body.innerHTML = "";
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const speak = (mid: string, csrc: number, level: number, ms: number) => {
    for (let t = 0; t < ms; t += 100) {
      now += 100;
      contributing.set(mid, [{ source: csrc, audioLevel: level, timestamp: now }]);
      vi.advanceTimersByTime(100);
    }
  };

  it("attributes a slot chunk to the device behind the CSRC", async () => {
    const adapter = new GoogleMeetPageAdapter();
    const pc = peerConnection();
    adapter.notePeerConnection(pc as unknown as RTCPeerConnection);
    adapter.noteRemoteTrack("6666", "3");
    const send = openCollections(pc);
    await send(message([audioSource(111, "407", false), deviceRecord("407", "Анна")]));

    adapter.startVadCapture();
    const start = performance.now();
    speak("3", 111, 0.2, 1000);

    expect(adapter.attributeChunk(start, performance.now(), "remote-6666")).toEqual({
      participantId: "meet-device-407",
      name: "Анна",
    });
  });

  it("names a stream assembled from encoded frames by its CSRC", async () => {
    const adapter = new GoogleMeetPageAdapter();
    const pc = peerConnection();
    adapter.notePeerConnection(pc as unknown as RTCPeerConnection);
    await openCollections(pc)(
      message([audioSource(3868207654, "449", false), deviceRecord("449", "Анна")]),
    );

    expect(adapter.attributeChunk(0, 1000, "remote-meet-3868207654")).toEqual({
      participantId: "meet-device-449",
      name: "Анна",
    });
    expect(adapter.attributeChunk(0, 1000, "remote-meet-1")).toBeNull();
  });

  it("refuses chunks with two comparable speakers", async () => {
    const adapter = new GoogleMeetPageAdapter();
    const pc = peerConnection();
    adapter.notePeerConnection(pc as unknown as RTCPeerConnection);
    adapter.noteRemoteTrack("6667", "4");
    await openCollections(pc)(
      message([
        audioSource(222, "408", false),
        audioSource(333, "409", false),
        deviceRecord("408", "Борис"),
        deviceRecord("409", "Вера"),
      ]),
    );

    adapter.startVadCapture();
    const start = performance.now();
    speak("4", 222, 0.2, 1000);
    expect(adapter.attributeChunk(start, performance.now(), "remote-6667")?.name).toBe("Борис");

    speak("4", 333, 0.2, 1000);
    expect(adapter.attributeChunk(start, performance.now(), "remote-6667")).toBeNull();
  });

  describe("RPC", () => {
    let originalFetch: typeof fetch;

    beforeEach(() => {
      originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn(
        async (input: RequestInfo | URL) =>
          new Response(
            String(input).includes("SyncMeetingSpaceCollections")
              ? syncResponse([
                  ["413", "Анна"],
                  ["414", "Я"],
                ])
              : "",
          ),
      ) as typeof fetch;
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

    it("names everyone present and finds the local device by the first update", async () => {
      const adapter = new GoogleMeetPageAdapter();
      adapter.install();

      await fetch(`${RPC}MeetingSpaceService/SyncMeetingSpaceCollections`, { body: "x" });
      await fetch(`${RPC}MeetingDeviceService/UpdateMeetingDevice`, { body: updateRequest("414") });
      await fetch(`${RPC}MeetingDeviceService/UpdateMeetingDevice`, { body: updateRequest("413") });
      await settle();

      expect(adapter.getSpeakerMap()).toEqual({ local: "Я" });
    });

    it("passes the page response through untouched", async () => {
      new GoogleMeetPageAdapter().install();
      const response = await fetch(`${RPC}MeetingSpaceService/SyncMeetingSpaceCollections`);
      expect(await response.text()).toBe(
        syncResponse([
          ["413", "Анна"],
          ["414", "Я"],
        ]),
      );
    });
  });
});
