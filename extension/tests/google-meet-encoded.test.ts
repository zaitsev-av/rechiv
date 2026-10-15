import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  authorOf,
  type EncodedAudioDeps,
  EncodedAudioTap,
  type EncodedStreams,
  PlayoutClock,
} from "../src/content/platforms/google-meet/encoded-audio";

type FakeDecoder = {
  init: AudioDecoderInit;
  state: string;
  chunks: { timestamp: number }[];
  configure: () => void;
  decode: (chunk: { timestamp: number }) => void;
  close: () => void;
};

const frame = (sources: number[], size = 10) => ({
  data: new ArrayBuffer(size),
  getMetadata: () => ({ contributingSources: sources }),
});

const audio = () => ({
  numberOfFrames: 960,
  sampleRate: 48_000,
  copyTo: vi.fn(),
  close: vi.fn(),
});

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("authorOf", () => {
  it("skips the service CSRC", () => {
    expect(authorOf([42, 111])).toBe(111);
    expect(authorOf([111, 42])).toBe(111);
    expect(authorOf([42])).toBeNull();
    expect(authorOf(undefined)).toBeNull();
  });
});

describe("PlayoutClock", () => {
  it("keeps pauses and puts reordered frames in place", () => {
    const clock = new PlayoutClock();
    expect(clock.place(1000, 10)).toBeCloseTo(10.15);
    expect(clock.place(1000 + 48_000 * 0.5, 10.01)).toBeCloseTo(10.65);
    expect(clock.place(1000 + 960, 10.02)).toBeCloseTo(10.17);
  });

  it("drops a late frame but resyncs when the network delay grows", () => {
    const clock = new PlayoutClock();
    clock.place(0, 10);
    for (let i = 1; i < 5; i++) expect(clock.place(960 * i, 10.5)).toBeNull();
    expect(clock.place(960 * 5, 10.5)).toBeCloseTo(10.65);
  });

  it("resyncs at once after a long break and survives RTP wraparound", () => {
    const clock = new PlayoutClock();
    clock.place(0xffff_fc40, 10);
    expect(clock.place(0x0000_0000, 10.01)).toBeCloseTo(10.17);
    expect(clock.place(960, 60)).toBeCloseTo(60.15);
  });
});

describe("EncodedAudioTap", () => {
  let decoders: FakeDecoder[];
  let played: { destination: string; at: number }[];
  let deps: EncodedAudioDeps;
  let streamsByAuthor: Map<number, MediaStream>;

  beforeEach(() => {
    decoders = [];
    played = [];
    streamsByAuthor = new Map();
    vi.stubGlobal(
      "EncodedAudioChunk",
      class {
        timestamp: number;
        constructor(init: { timestamp: number }) {
          this.timestamp = init.timestamp;
        }
      },
    );

    let destinations = 0;
    const context = {
      state: "running",
      currentTime: 5,
      createMediaStreamDestination: () => {
        const id = `destination-${++destinations}`;
        return { id, stream: { id } };
      },
      createBuffer: (_: number, length: number, rate: number) => ({
        duration: length / rate,
        getChannelData: () => new Float32Array(length),
      }),
      createBufferSource: () => {
        const source = {
          buffer: null,
          target: "",
          connect: (destination: { id: string }) => {
            source.target = destination.id;
          },
          start: (at: number) => played.push({ destination: source.target, at }),
        };
        return source;
      },
    };

    deps = {
      createDecoder: (init) => {
        const decoder: FakeDecoder = {
          init,
          state: "unconfigured",
          chunks: [],
          configure: () => {
            decoder.state = "configured";
          },
          decode: (chunk) => decoder.chunks.push(chunk),
          close: () => {
            decoder.state = "closed";
          },
        };
        decoders.push(decoder);
        return decoder as unknown as AudioDecoder;
      },
      createContext: () => context as unknown as AudioContext,
    };
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const tapFrames = (tap: EncodedAudioTap, frames: ReturnType<typeof frame>[]) => {
    const source: EncodedStreams = {
      readable: new ReadableStream({
        start(controller) {
          // Поток не закрываем: на закрытии декодер закрывается вместе с ним.
          for (const f of frames) controller.enqueue(f);
        },
      }),
      writable: new WritableStream(),
    };
    return tap.tap("track-1", source);
  };

  const readAll = async ({ readable }: EncodedStreams, count: number) => {
    const out: unknown[] = [];
    const reader = readable.getReader();
    while (out.length < count) out.push((await reader.read()).value);
    return out;
  };

  const newTap = () =>
    new EncodedAudioTap((csrc, stream) => streamsByAuthor.set(csrc, stream), deps);

  it("passes every frame to the page and creates one stream per author", async () => {
    const tap = newTap();
    const frames = [frame([111, 42]), frame([42]), frame([222]), frame([111])];

    const page = tapFrames(tap, frames);

    expect(await readAll(page, frames.length)).toEqual(frames);
    await flush();
    expect([...streamsByAuthor.keys()]).toEqual([111, 222]);
    expect(tap.ownsTrack("track-1")).toBe(true);
    expect(tap.ownsTrack("track-2")).toBe(false);
  });

  it("does not decode while not recording", async () => {
    const tap = newTap();

    await readAll(tapFrames(tap, [frame([111]), frame([111])]), 2);
    await flush();

    expect(decoders).toHaveLength(0);
  });

  it("plays decoded audio into the stream of its author, back to back", async () => {
    const tap = newTap();
    tap.active = true;

    await readAll(tapFrames(tap, [frame([111]), frame([222]), frame([111])]), 3);
    await flush();
    const [decoder] = decoders;
    for (let i = 0; i < 3; i++) decoder.init.output(audio() as unknown as AudioData);

    expect(played.map(({ destination, at }) => [destination, at.toFixed(2)])).toEqual([
      ["destination-1", "5.15"],
      ["destination-2", "5.17"],
      ["destination-1", "5.19"],
    ]);
  });

  it("opens a new decoder after an error and keeps authors aligned", async () => {
    const tap = newTap();
    tap.active = true;

    await readAll(tapFrames(tap, [frame([111]), frame([111])]), 2);
    await flush();
    decoders[0].init.error(new DOMException("Decoding error", "EncodingError"));
    decoders[0].state = "closed";
    // Запоздалый выход закрытого декодера не должен попасть ни к кому.
    const late = audio();
    decoders[0].init.output(late as unknown as AudioData);

    await readAll(tapFrames(tap, [frame([222])]), 1);
    await flush();
    decoders[1].init.output(audio() as unknown as AudioData);

    expect(late.close).toHaveBeenCalled();
    expect(played).toEqual([{ destination: "destination-2", at: 5.15 }]);
  });

  it("skips empty and DTX frames", async () => {
    const tap = newTap();
    tap.active = true;

    await readAll(tapFrames(tap, [frame([111], 0), frame([111], 2)]), 2);
    await flush();

    expect(streamsByAuthor.has(111)).toBe(true);
    expect(decoders).toHaveLength(0);
  });
});
