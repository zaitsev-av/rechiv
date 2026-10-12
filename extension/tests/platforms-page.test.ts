import { afterEach, describe, expect, it, vi } from "vitest";
import { GenericPageAdapter } from "../src/content/platforms/generic/page";
import { pickPageAdapter } from "../src/content/platforms/registry";
import type { PageAdapter } from "../src/content/platforms/types";
import { getLiveKitRoom, LiveKitPageAdapter } from "../src/content/platforms/wb-stream/page";

function mountRoom(room: any): HTMLElement {
  const container = document.createElement("div");
  container.classList.add("lk-room-container");
  (container as any).__reactFiber$test = {
    memoizedProps: { room },
    memoizedState: null,
    return: null,
  };
  document.body.appendChild(container);
  return container;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("pickPageAdapter", () => {
  it("returns the LiveKit adapter for a known platform host", () => {
    expect(pickPageAdapter("stream.wb.ru")).toBeInstanceOf(LiveKitPageAdapter);
  });

  it("falls back to the generic adapter on an unknown host", () => {
    expect(pickPageAdapter("meet.google.com")).toBeInstanceOf(GenericPageAdapter);
  });
});

describe("GenericPageAdapter", () => {
  it("records without speaker names and without mute tracking", () => {
    const adapter: PageAdapter = new GenericPageAdapter();
    const onChange = vi.fn();

    expect(adapter.getSpeakerMap()).toBeNull();
    expect(adapter.isLocalMuted()).toBe(false);
    adapter.syncMuteSubscription(onChange);
    adapter.teardown();

    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("getLiveKitRoom", () => {
  it("returns room from React fiber", () => {
    const mockRoom = { localParticipant: { identity: "user1" } };
    mountRoom(mockRoom);

    expect(getLiveKitRoom()).toBe(mockRoom);
  });

  it("returns null when no lk-room-container", () => {
    expect(getLiveKitRoom()).toBeNull();
  });
});

describe("LiveKitPageAdapter.getSpeakerMap", () => {
  it("maps the local speaker from LiveKit participant.name without a camera tile", () => {
    mountRoom({
      localParticipant: {
        identity: "019fae23-02f9-7d1a-a680-183ec6513338",
        name: "Олег Ветров",
      },
      remoteParticipants: new Map(),
    });

    expect(new LiveKitPageAdapter().getSpeakerMap()).toEqual({ local: "Олег Ветров" });
  });

  it("maps a remote audio stream using the participant metadata name", () => {
    const remoteParticipant = {
      identity: "remote-identity",
      metadata: JSON.stringify({ user: { name: "Вера Лапина" } }),
      trackPublications: new Map([
        [
          "audio",
          {
            kind: "audio",
            track: { mediaStream: { id: "remote-stream-id" } },
          },
        ],
      ]),
    };
    mountRoom({
      localParticipant: null,
      remoteParticipants: new Map([["remote", remoteParticipant]]),
    });

    expect(new LiveKitPageAdapter().getSpeakerMap()).toEqual({
      "remote-remote-stream-id": "Вера Лапина",
    });
  });

  it("returns null when the room is not available", () => {
    expect(new LiveKitPageAdapter().getSpeakerMap()).toBeNull();
  });
});

describe("LiveKitPageAdapter.isLocalMuted", () => {
  it("returns true when mic is disabled", () => {
    mountRoom({ localParticipant: { isMicrophoneEnabled: false, identity: "user1" } });

    expect(new LiveKitPageAdapter().isLocalMuted()).toBe(true);
  });

  it("returns false when mic is enabled", () => {
    mountRoom({ localParticipant: { isMicrophoneEnabled: true, identity: "user1" } });

    expect(new LiveKitPageAdapter().isLocalMuted()).toBe(false);
  });

  it("returns false when room is not available", () => {
    expect(new LiveKitPageAdapter().isLocalMuted()).toBe(false);
  });
});

describe("LiveKitPageAdapter.syncMuteSubscription", () => {
  function participantWithEvents() {
    const handlers = new Map<string, () => void>();
    return {
      isMicrophoneEnabled: true,
      on: vi.fn((event: string, handler: () => void) => handlers.set(event, handler)),
      off: vi.fn((event: string) => handlers.delete(event)),
      emit: (event: string) => handlers.get(event)?.(),
      handlers,
    };
  }

  it("reports mute state changes through the callback", () => {
    const lp = participantWithEvents();
    mountRoom({ localParticipant: lp });
    const adapter = new LiveKitPageAdapter();
    const onChange = vi.fn();

    adapter.syncMuteSubscription(onChange);
    lp.isMicrophoneEnabled = false;
    lp.emit("trackMuted");

    expect(onChange).toHaveBeenCalledWith(true);
  });

  // Вызывается в каждом poll-тике — повторная подписка удвоила бы события.
  it("does not resubscribe to the same participant", () => {
    const lp = participantWithEvents();
    mountRoom({ localParticipant: lp });
    const adapter = new LiveKitPageAdapter();

    adapter.syncMuteSubscription(vi.fn());
    const callsAfterFirst = lp.on.mock.calls.length;
    adapter.syncMuteSubscription(vi.fn());

    expect(lp.on.mock.calls.length).toBe(callsAfterFirst);
  });

  it("resubscribes when the room recreates the participant", () => {
    const first = participantWithEvents();
    const container = mountRoom({ localParticipant: first });
    const adapter = new LiveKitPageAdapter();
    adapter.syncMuteSubscription(vi.fn());

    container.remove();
    const second = participantWithEvents();
    mountRoom({ localParticipant: second });
    adapter.syncMuteSubscription(vi.fn());

    expect(first.off).toHaveBeenCalled();
    expect(second.on).toHaveBeenCalled();
  });

  it("unsubscribes on teardown", () => {
    const lp = participantWithEvents();
    mountRoom({ localParticipant: lp });
    const adapter = new LiveKitPageAdapter();

    adapter.syncMuteSubscription(vi.fn());
    adapter.teardown();

    expect(lp.handlers.size).toBe(0);
  });

  it("does nothing when the room is not available", () => {
    const adapter = new LiveKitPageAdapter();

    expect(() => adapter.syncMuteSubscription(vi.fn())).not.toThrow();
  });
});
