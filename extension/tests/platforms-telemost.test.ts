import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TelemostPageAdapter } from "../src/content/platforms/telemost/page";

const LOCAL_ID = "b42be91e-f9db-4f67-a9fc-fe582918ec3f";
const REMOTE_ID = "1ecaeaa3-2a8d-432b-9292-80ba70d24912";
const REMOTE_STREAM = "aec9a68a-b15e-49be-b3ac-1720a05b9a94";
const SECOND_ID = "2f0bd7c1-1111-2222-3333-444455556666";
const SECOND_STREAM = "4a418a7e-a0f8-4f8b-bc61-524ab0120bf8";

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  private _listeners: ((event: { data: unknown }) => void)[] = [];
  sent: unknown[] = [];

  constructor(readonly url: string | URL) {
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, handler: (event: { data: unknown }) => void) {
    if (type === "message") this._listeners.push(handler);
  }

  receive(data: unknown) {
    for (const handler of this._listeners) handler({ data });
  }

  send(data: unknown) {
    this.sent.push(data);
  }
}

let originalWebSocket: typeof WebSocket;

function openSignalingSocket(url = "wss://goloom.strm.yandex.net/join"): FakeWebSocket {
  new (globalThis.WebSocket as unknown as new (url: string) => unknown)(url);
  return FakeWebSocket.instances.at(-1) as FakeWebSocket;
}

function describeMessage(id: string, name: string) {
  return JSON.stringify({
    uid: "any",
    updateDescription: { description: [{ id, meta: { name, role: "SPEAKER" } }] },
  });
}

function helloMessage(id: string, name: string) {
  return JSON.stringify({
    uid: "u",
    hello: { participantId: id, participantMeta: { name, role: "SPEAKER" } },
  });
}

/** sendAudio лежит и в корне, и в meta. */
function micMessage(id: string, name: string, sendAudio: boolean) {
  return JSON.stringify({
    uid: "any",
    upsertDescription: {
      description: [{ id, meta: { name, role: "SPEAKER", sendAudio }, sendAudio }],
    },
  });
}

/** slots[0] — selfView. Слот бывает `participant` (вдвоём) и `participantVideoByMid` (группа). */
function slotsMessage(
  participantIds: (string | null)[],
  shape: "direct" | "grid" = "direct",
  activeIds: string[] = [],
) {
  return JSON.stringify({
    uid: "any",
    slotsConfig: {
      key: 1,
      videoSlots: [],
      audioSlots: [],
      slots: [
        { selfView: {}, vad: false, pinned: false, label: "" },
        ...participantIds.map((id, index) => {
          if (!id) return { empty: {}, vad: false, pinned: false, label: "" };
          if (shape === "grid") {
            return {
              participantVideoByMid: {
                participantId: id,
                mid: `video_A${String.fromCharCode(65 + index)}`,
                limitationReason: "NO_LIMITATION",
              },
              vad: activeIds.includes(id),
              pinned: false,
              label: "Камера",
            };
          }
          return {
            participant: { participantId: id },
            vad: activeIds.includes(id),
            pinned: false,
            label: "",
          };
        }),
      ],
      offset: 0,
    },
  });
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  originalWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
});

afterEach(() => {
  vi.restoreAllMocks();
  globalThis.WebSocket = originalWebSocket;
});

describe("TelemostPageAdapter", () => {
  it("names the stream when the only remote participant is known", () => {
    const adapter = new TelemostPageAdapter();
    adapter.install();
    const socket = openSignalingSocket();

    socket.receive(describeMessage(REMOTE_ID, "Борис Ковалёв"));
    socket.receive(slotsMessage([REMOTE_ID]));
    adapter.noteRemoteTrack(REMOTE_STREAM, "audio_AA");

    expect(adapter.getSpeakerMap()).toEqual({ [`remote-${REMOTE_STREAM}`]: "Борис Ковалёв" });
  });

  it("names both audio slots: only one person can be in either", () => {
    const adapter = new TelemostPageAdapter();
    adapter.install();
    const socket = openSignalingSocket();

    socket.receive(describeMessage(REMOTE_ID, "Борис Ковалёв"));
    socket.receive(slotsMessage([REMOTE_ID]));
    adapter.noteRemoteTrack(REMOTE_STREAM, "audio_AA");
    adapter.noteRemoteTrack(SECOND_STREAM, "audio_AB");

    expect(adapter.getSpeakerMap()).toEqual({
      [`remote-${REMOTE_STREAM}`]: "Борис Ковалёв",
      [`remote-${SECOND_STREAM}`]: "Борис Ковалёв",
    });
  });

  it("gives no names once there are two remote participants", () => {
    const adapter = new TelemostPageAdapter();
    adapter.install();
    const socket = openSignalingSocket();

    socket.receive(describeMessage(REMOTE_ID, "Борис Ковалёв"));
    socket.receive(describeMessage(SECOND_ID, "Вера Лапина"));
    socket.receive(slotsMessage([REMOTE_ID, SECOND_ID]));
    adapter.noteRemoteTrack(REMOTE_STREAM, "audio_AA");
    adapter.noteRemoteTrack(SECOND_STREAM, "audio_AB");

    expect(adapter.getSpeakerMap()).toBeNull();
  });

  it("reads the grid slot shape sent on group calls", () => {
    const adapter = new TelemostPageAdapter();
    adapter.install();
    const socket = openSignalingSocket();

    socket.receive(describeMessage(REMOTE_ID, "Борис Ковалёв"));
    socket.receive(describeMessage(SECOND_ID, "Вера Лапина"));
    socket.receive(slotsMessage([REMOTE_ID, SECOND_ID], "grid"));
    adapter.noteRemoteTrack(REMOTE_STREAM, "audio_AA");

    expect(adapter.getSpeakerMap()).toBeNull();
  });

  it("stays silent while nobody is named yet", () => {
    const adapter = new TelemostPageAdapter();
    adapter.install();
    const socket = openSignalingSocket();

    socket.receive(slotsMessage([REMOTE_ID]));
    adapter.noteRemoteTrack(REMOTE_STREAM, "audio_AA");

    expect(adapter.getSpeakerMap()).toBeNull();
  });

  it("follows the participant when the server reassigns the slot", () => {
    const adapter = new TelemostPageAdapter();
    adapter.install();
    const socket = openSignalingSocket();

    socket.receive(describeMessage(REMOTE_ID, "Борис Ковалёв"));
    socket.receive(describeMessage(SECOND_ID, "Вера Лапина"));
    socket.receive(slotsMessage([REMOTE_ID]));
    adapter.noteRemoteTrack(REMOTE_STREAM, "audio_AA");
    socket.receive(slotsMessage([SECOND_ID]));

    expect(adapter.getSpeakerMap()).toEqual({ [`remote-${REMOTE_STREAM}`]: "Вера Лапина" });
  });

  it("takes names from a peers_state notification as a fallback", () => {
    const adapter = new TelemostPageAdapter();
    adapter.install();
    const socket = openSignalingSocket();

    socket.receive(
      JSON.stringify({
        notification: {
          payload: JSON.stringify({
            type: "peers_state",
            payload: {
              peers: [
                { peer_id: REMOTE_ID, state: { user_data: { display_name: "Борис Ковалёв" } } },
              ],
            },
          }),
        },
      }),
    );
    socket.receive(slotsMessage([REMOTE_ID]));
    adapter.noteRemoteTrack(REMOTE_STREAM, "audio_AA");

    expect(adapter.getSpeakerMap()).toEqual({ [`remote-${REMOTE_STREAM}`]: "Борис Ковалёв" });
  });

  it("ignores sockets that are not the call signaling", () => {
    const adapter = new TelemostPageAdapter();
    adapter.install();
    const socket = openSignalingSocket("wss://mc.yandex.ru/metrika");

    socket.receive(describeMessage(REMOTE_ID, "Борис Ковалёв"));
    socket.receive(slotsMessage([REMOTE_ID]));
    adapter.noteRemoteTrack(REMOTE_STREAM, "audio_AA");

    expect(adapter.getSpeakerMap()).toBeNull();
  });

  it("returns null until the stream for a slot is known", () => {
    const adapter = new TelemostPageAdapter();
    adapter.install();
    const socket = openSignalingSocket();

    socket.receive(describeMessage(REMOTE_ID, "Борис Ковалёв"));
    socket.receive(slotsMessage([REMOTE_ID]));

    expect(adapter.getSpeakerMap()).toBeNull();
  });

  it("ignores video mids and malformed payloads", () => {
    const adapter = new TelemostPageAdapter();
    adapter.install();
    const socket = openSignalingSocket();

    socket.receive("не json");
    socket.receive(describeMessage(REMOTE_ID, "Борис Ковалёв"));
    socket.receive(slotsMessage([REMOTE_ID]));
    adapter.noteRemoteTrack("video-stream", "video_AA");

    expect(adapter.getSpeakerMap()).toBeNull();
  });

  it("does not patch WebSocket twice", () => {
    const adapter = new TelemostPageAdapter();
    adapter.install();
    const patched = globalThis.WebSocket;
    adapter.install();

    expect(globalThis.WebSocket).toBe(patched);
  });

  it("reads the local participant from outgoing hello without changing the payload", () => {
    const adapter = new TelemostPageAdapter();
    adapter.install();
    const socket = openSignalingSocket();
    const hello = JSON.stringify({
      hello: {
        participantId: "ede3e460-local",
        participantMeta: { name: "Олег Ветров" },
      },
    });

    socket.send(hello);

    expect(socket.sent).toEqual([hello]);
    expect(adapter.getVadTimeline()).toMatchObject({
      localParticipantId: "ede3e460-local",
      participants: [{ participantId: "ede3e460-local", name: "Олег Ветров" }],
    });
  });

  it("collects VAD from both real slot shapes on the recording clock", () => {
    const now = vi.spyOn(performance, "now");
    const adapter = new TelemostPageAdapter();
    adapter.install();
    const socket = openSignalingSocket();
    adapter.startVadCapture(1_000);

    now.mockReturnValue(1_250);
    socket.receive(slotsMessage([REMOTE_ID], "direct", [REMOTE_ID]));
    now.mockReturnValue(2_500);
    socket.receive(slotsMessage([SECOND_ID], "grid", [SECOND_ID]));

    expect(adapter.getVadTimeline().events).toEqual([
      { at: 0, active: [] },
      { at: 0.25, active: [REMOTE_ID] },
      { at: 1.5, active: [SECOND_ID] },
    ]);
  });

  it("does not duplicate unchanged VAD states", () => {
    const now = vi.spyOn(performance, "now");
    const adapter = new TelemostPageAdapter();
    adapter.install();
    const socket = openSignalingSocket();
    adapter.startVadCapture(1_000);

    now.mockReturnValue(1_100);
    socket.receive(slotsMessage([REMOTE_ID], "direct", [REMOTE_ID]));
    now.mockReturnValue(1_900);
    socket.receive(slotsMessage([REMOTE_ID], "grid", [REMOTE_ID]));

    expect(adapter.getVadTimeline().events).toEqual([
      { at: 0, active: [] },
      { at: 0.1, active: [REMOTE_ID] },
    ]);
  });

  it("opens the timeline with the state known when recording started", () => {
    const now = vi.spyOn(performance, "now");
    const adapter = new TelemostPageAdapter();
    adapter.install();
    const socket = openSignalingSocket();

    now.mockReturnValue(100);
    socket.receive(slotsMessage([REMOTE_ID], "direct", [REMOTE_ID]));
    adapter.startVadCapture(500);
    now.mockReturnValue(800);
    socket.receive(slotsMessage([SECOND_ID], "grid", [SECOND_ID]));

    expect(adapter.getVadTimeline().events).toEqual([
      { at: 0, active: [REMOTE_ID] },
      { at: 0.3, active: [SECOND_ID] },
    ]);
  });

  it("opens the timeline empty when nobody was speaking at the start", () => {
    const now = vi.spyOn(performance, "now");
    const adapter = new TelemostPageAdapter();
    adapter.install();
    openSignalingSocket();

    now.mockReturnValue(100);
    adapter.startVadCapture(500);

    expect(adapter.getVadTimeline().events).toEqual([{ at: 0, active: [] }]);
  });
});

describe("одиночный созвон", () => {
  it("узнаёт своё имя из hello, когда в созвоне больше никого нет", () => {
    const adapter = new TelemostPageAdapter();
    adapter.install();
    const socket = openSignalingSocket();

    socket.send(
      JSON.stringify({
        uid: "u-1",
        hello: {
          participantId: "ede3e460-6489-444a-a432-a9f44ef987ed",
          participantMeta: { name: "Олег Ветров", role: "SPEAKER" },
        },
      }),
    );
    socket.receive(
      JSON.stringify({
        uid: "u-2",
        slotsConfig: { key: 1, slots: [{ selfView: {}, vad: false }] },
      }),
    );
    adapter.startVadCapture(0);

    const timeline = adapter.getVadTimeline();
    expect(timeline.localParticipantId).toBe("ede3e460-6489-444a-a432-a9f44ef987ed");
    expect(timeline.participants).toContainEqual({
      participantId: "ede3e460-6489-444a-a432-a9f44ef987ed",
      name: "Олег Ветров",
    });
  });
});

describe("имя в живом транскрипте", () => {
  it("отдаёт своё имя сразу, ещё до конца записи", () => {
    const adapter = new TelemostPageAdapter();
    adapter.install();
    const socket = openSignalingSocket();

    socket.send(helloMessage(LOCAL_ID, "Олег Ветров"));

    expect(adapter.getSpeakerMap()).toEqual({ local: "Олег Ветров" });
  });

  it("не путает своё имя с комнатным миксом, когда собеседников несколько", () => {
    const adapter = new TelemostPageAdapter();
    adapter.install();
    const socket = openSignalingSocket();

    socket.send(helloMessage(LOCAL_ID, "Олег Ветров"));
    socket.receive(describeMessage(REMOTE_ID, "Борис Ковалёв"));
    socket.receive(describeMessage(SECOND_ID, "Вера Лапина"));
    socket.receive(slotsMessage([REMOTE_ID, SECOND_ID]));
    adapter.noteRemoteTrack(REMOTE_STREAM, "audio_AA");

    expect(adapter.getSpeakerMap()).toEqual({ local: "Олег Ветров" });
  });

  it("вместе со своим отдаёт и единственного собеседника", () => {
    const adapter = new TelemostPageAdapter();
    adapter.install();
    const socket = openSignalingSocket();

    socket.send(helloMessage(LOCAL_ID, "Олег Ветров"));
    socket.receive(describeMessage(REMOTE_ID, "Борис Ковалёв"));
    socket.receive(slotsMessage([REMOTE_ID]));
    adapter.noteRemoteTrack(REMOTE_STREAM, "audio_AA");

    expect(adapter.getSpeakerMap()).toEqual({
      local: "Олег Ветров",
      [`remote-${REMOTE_STREAM}`]: "Борис Ковалёв",
    });
  });
});

describe("состояние микрофонов", () => {
  // Имя потока — на всю запись: единственный размьюченный в паузе подписал бы собой весь разговор.
  it("не называет микс по микрофону, даже когда размьючен один", () => {
    const adapter = new TelemostPageAdapter();
    adapter.install();
    const socket = openSignalingSocket();

    socket.send(helloMessage(LOCAL_ID, "Олег Ветров"));
    socket.receive(micMessage(REMOTE_ID, "Борис Ковалёв", true));
    socket.receive(micMessage(SECOND_ID, "Вера Лапина", false));
    socket.receive(slotsMessage([REMOTE_ID, SECOND_ID]));
    adapter.noteRemoteTrack(REMOTE_STREAM, "audio_AA");

    expect(adapter.getSpeakerMap()).toEqual({ local: "Олег Ветров" });
  });

  it("кладёт состояние микрофонов в таймлайн на часах записи", () => {
    const now = vi.spyOn(performance, "now");
    const adapter = new TelemostPageAdapter();
    adapter.install();
    const socket = openSignalingSocket();

    now.mockReturnValue(100);
    socket.receive(micMessage(REMOTE_ID, "Борис Ковалёв", true));
    adapter.startVadCapture(500);
    now.mockReturnValue(1_500);
    socket.receive(micMessage(SECOND_ID, "Вера Лапина", true));

    expect(adapter.getVadTimeline().micEvents).toEqual([
      { at: 0, unmuted: [REMOTE_ID] },
      { at: 1, unmuted: [REMOTE_ID, SECOND_ID].sort() },
    ]);
  });

  it("не пишет в таймлайн повтор того же состояния", () => {
    const now = vi.spyOn(performance, "now");
    const adapter = new TelemostPageAdapter();
    adapter.install();
    const socket = openSignalingSocket();

    adapter.startVadCapture(0);
    now.mockReturnValue(1_000);
    socket.receive(micMessage(REMOTE_ID, "Борис Ковалёв", true));
    now.mockReturnValue(2_000);
    socket.receive(describeMessage(REMOTE_ID, "Борис Ковалёв"));

    expect(adapter.getVadTimeline().micEvents).toEqual([
      { at: 0, unmuted: [] },
      { at: 1, unmuted: [REMOTE_ID] },
    ]);
  });
});

function selfMicMessage(key: "hello" | "updateMe", sendAudio: boolean) {
  return JSON.stringify({
    uid: "u",
    [key]: {
      ...(key === "hello" ? { participantId: LOCAL_ID } : {}),
      participantMeta: { name: "Олег Ветров", role: "SPEAKER", sendAudio },
      sendAudio,
    },
  });
}

// Микрофон остаётся открытым и при выключенной кнопке: шум даёт выдуманные реплики.
describe("свой микрофон", () => {
  it("считает микрофон выключенным, если вошли с выключенным", () => {
    const adapter = new TelemostPageAdapter();
    adapter.install();
    openSignalingSocket().send(selfMicMessage("hello", false));

    expect(adapter.isLocalMuted()).toBe(true);
  });

  it("сообщает о каждом переключении кнопки, но не о повторах", () => {
    const adapter = new TelemostPageAdapter();
    adapter.install();
    const socket = openSignalingSocket();
    const changes: boolean[] = [];
    adapter.syncMuteSubscription((muted) => changes.push(muted));

    socket.send(selfMicMessage("hello", false));
    socket.send(selfMicMessage("updateMe", true));
    socket.send(selfMicMessage("updateMe", true));
    socket.send(selfMicMessage("updateMe", false));

    expect(changes).toEqual([true, false, true]);
    expect(adapter.isLocalMuted()).toBe(true);
  });

  it("не принимает чужой sendAudio за свой", () => {
    const adapter = new TelemostPageAdapter();
    adapter.install();
    const socket = openSignalingSocket();

    socket.send(selfMicMessage("hello", true));
    socket.receive(micMessage(REMOTE_ID, "Борис Ковалёв", false));

    expect(adapter.isLocalMuted()).toBe(false);
  });

  it("после teardown не зовёт старый колбэк, но состояние помнит", () => {
    const adapter = new TelemostPageAdapter();
    adapter.install();
    const socket = openSignalingSocket();
    const onChange = vi.fn();
    adapter.syncMuteSubscription(onChange);

    adapter.teardown();
    socket.send(selfMicMessage("hello", false));

    expect(onChange).not.toHaveBeenCalled();
    expect(adapter.isLocalMuted()).toBe(true);
  });
});

describe("атрибуция фрагмента", () => {
  function adapterWithSignaling() {
    const adapter = new TelemostPageAdapter();
    adapter.install();
    return { adapter, socket: openSignalingSocket() };
  }

  it("называет единственного размьюченного на фрагменте", () => {
    const now = vi.spyOn(performance, "now");
    const { adapter, socket } = adapterWithSignaling();

    now.mockReturnValue(0);
    adapter.startVadCapture(0);
    socket.receive(micMessage(REMOTE_ID, "Борис Ковалёв", true));
    socket.receive(micMessage(SECOND_ID, "Вера Лапина", false));

    expect(adapter.attributeChunk(1_000, 4_000)).toEqual({
      participantId: REMOTE_ID,
      name: "Борис Ковалёв",
    });
  });

  it("при нескольких микрофонах отдаёт фрагмент тому, у кого был vad", () => {
    const now = vi.spyOn(performance, "now");
    const { adapter, socket } = adapterWithSignaling();

    now.mockReturnValue(0);
    adapter.startVadCapture(0);
    socket.receive(micMessage(REMOTE_ID, "Борис Ковалёв", true));
    socket.receive(micMessage(SECOND_ID, "Вера Лапина", true));
    now.mockReturnValue(1_500);
    socket.receive(slotsMessage([REMOTE_ID, SECOND_ID], "direct", [SECOND_ID]));

    expect(adapter.attributeChunk(1_000, 4_000)).toEqual({
      participantId: SECOND_ID,
      name: "Вера Лапина",
    });
  });

  it("молчит, когда на фрагменте звучали двое", () => {
    const now = vi.spyOn(performance, "now");
    const { adapter, socket } = adapterWithSignaling();

    now.mockReturnValue(0);
    adapter.startVadCapture(0);
    socket.receive(micMessage(REMOTE_ID, "Борис Ковалёв", true));
    socket.receive(micMessage(SECOND_ID, "Вера Лапина", true));
    now.mockReturnValue(1_200);
    socket.receive(slotsMessage([REMOTE_ID, SECOND_ID], "direct", [REMOTE_ID]));
    now.mockReturnValue(2_500);
    socket.receive(slotsMessage([REMOTE_ID, SECOND_ID], "direct", [SECOND_ID]));

    expect(adapter.attributeChunk(1_000, 4_000)).toBeNull();
  });

  // Флаг до выключения микрофона гаснет с запозданием — это хвост реплики.
  it("не отдаёт фрагмент замьюченному по хвосту его vad", () => {
    const now = vi.spyOn(performance, "now");
    const { adapter, socket } = adapterWithSignaling();

    now.mockReturnValue(0);
    adapter.startVadCapture(0);
    socket.receive(micMessage(REMOTE_ID, "Борис Ковалёв", true));
    socket.receive(micMessage(SECOND_ID, "Вера Лапина", true));
    now.mockReturnValue(500);
    socket.receive(slotsMessage([REMOTE_ID, SECOND_ID], "direct", [SECOND_ID]));
    now.mockReturnValue(800);
    socket.receive(micMessage(SECOND_ID, "Вера Лапина", false));

    expect(adapter.attributeChunk(1_000, 4_000)).toEqual({
      participantId: REMOTE_ID,
      name: "Борис Ковалёв",
    });
  });

  // Созвон 29 сентября: sendAudio=false держался минутами, пока человек говорил.
  it("отдаёт фрагмент тому, чей vad зажёгся при выключенном микрофоне", () => {
    const now = vi.spyOn(performance, "now");
    const { adapter, socket } = adapterWithSignaling();

    now.mockReturnValue(0);
    adapter.startVadCapture(0);
    socket.receive(micMessage(REMOTE_ID, "Борис Ковалёв", false));
    socket.receive(micMessage(SECOND_ID, "Вера Лапина", true));
    now.mockReturnValue(1_500);
    socket.receive(slotsMessage([REMOTE_ID, SECOND_ID], "direct", [REMOTE_ID]));

    expect(adapter.attributeChunk(1_000, 4_000)).toEqual({
      participantId: REMOTE_ID,
      name: "Борис Ковалёв",
    });
  });

  it("молчит, пока имя участника неизвестно", () => {
    const now = vi.spyOn(performance, "now");
    const { adapter, socket } = adapterWithSignaling();

    now.mockReturnValue(0);
    adapter.startVadCapture(0);
    socket.receive(
      JSON.stringify({
        uid: "any",
        upsertDescription: { description: [{ id: REMOTE_ID, sendAudio: true }] },
      }),
    );

    expect(adapter.attributeChunk(1_000, 4_000)).toBeNull();
  });

  it("молчит на пустом фрагменте", () => {
    const { adapter } = adapterWithSignaling();
    adapter.startVadCapture(0);

    expect(adapter.attributeChunk(2_000, 2_000)).toBeNull();
  });
});
