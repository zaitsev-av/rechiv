import { cleanParticipantName } from "../names";
import type { PageAdapter } from "../types";

const PREFIX = "[Rechiv:livekit]";

const MUTE_EVENTS = ["trackMuted", "trackUnmuted", "localTrackPublished", "localTrackUnpublished"];

const PARTICIPANT_NAME_SELECTOR = [
  "[data-lk-participant-name]",
  "[data-testid*='participant-name']",
  "[data-test*='participant-name']",
  "span.ant-typography-ellipsis-single-line",
  "[class*='participant-name']",
  "[class*='participantName']",
].join(", ");

const TILE_SELECTOR = [
  '[data-test="participant-view-block"]',
  "[data-lk-participant-identity]",
  ".lk-participant-tile",
].join(", ");

/** Room достаётся через React Fiber на .lk-room-container. */
// biome-ignore lint/suspicious/noExplicitAny: React internals
export function getLiveKitRoom(): any | null {
  try {
    const lkContainer = document.querySelector(".lk-room-container");
    if (!lkContainer) return null;

    const fiberKey = Object.keys(lkContainer).find((k) => k.startsWith("__reactFiber"));
    if (!fiberKey) return null;

    // biome-ignore lint/suspicious/noExplicitAny: React internals
    let fiber = (lkContainer as any)[fiberKey];
    for (let i = 0; i < 30 && fiber; i++) {
      const props = fiber.memoizedProps || fiber.pendingProps;
      if (props?.room) return props.room;

      let state = fiber.memoizedState;
      for (let j = 0; j < 10 && state; j++) {
        if (state.memoizedState?.room) return state.memoizedState.room;
        state = state.next;
      }
      fiber = fiber.return;
    }
    return null;
  } catch {
    return null;
  }
}

// biome-ignore lint/suspicious/noExplicitAny: LiveKit Participant internals
function participantName(participant: any, domName?: string): string | null {
  const directCandidates = [
    domName,
    participant?.name,
    participant?.displayName,
    participant?.attributes?.displayName,
    participant?.attributes?.display_name,
    participant?.attributes?.name,
    participant?.attributes?.fullName,
    participant?.attributes?.full_name,
  ];
  for (const candidate of directCandidates) {
    const name = cleanParticipantName(candidate);
    if (name) return name;
  }

  if (typeof participant?.metadata === "string" && participant.metadata.trim()) {
    try {
      const metadata = JSON.parse(participant.metadata);
      const metadataCandidates = [
        metadata?.displayName,
        metadata?.display_name,
        metadata?.name,
        metadata?.fullName,
        metadata?.full_name,
        metadata?.user?.displayName,
        metadata?.user?.name,
        metadata?.profile?.displayName,
        metadata?.profile?.name,
      ];
      for (const candidate of metadataCandidates) {
        const name = cleanParticipantName(candidate);
        if (name) return name;
      }
    } catch {
      // Metadata не всегда JSON.
    }
  }

  return cleanParticipantName(participant?.identity);
}

/** В Room имя бывает пустым, а в плитке уже отрисовано. */
function identityNamesFromDom(): Record<string, string> {
  const identityToName: Record<string, string> = {};

  for (const tile of document.querySelectorAll<HTMLElement>(TILE_SELECTOR)) {
    const tileFK = Object.keys(tile).find((k) => k.startsWith("__reactFiber"));
    let identity = tile.dataset.lkParticipantIdentity ?? "";
    if (tileFK) {
      // biome-ignore lint/suspicious/noExplicitAny: React internals
      let tf = (tile as any)[tileFK];
      for (let i = 0; i < 15 && tf; i++) {
        const tfProps = tf.memoizedProps || tf.pendingProps;
        if (tfProps?.participant?.identity) {
          identity = tfProps.participant.identity;
          break;
        }
        tf = tf.return;
      }
    }
    const nameEl = tile.querySelector<HTMLElement>(PARTICIPANT_NAME_SELECTOR);
    const name = cleanParticipantName(nameEl?.textContent);
    if (identity && name) {
      identityToName[identity] = name;
    }
  }

  return identityToName;
}

export class LiveKitPageAdapter implements PageAdapter {
  readonly id = "livekit";

  // biome-ignore lint/suspicious/noExplicitAny: LiveKit Room internals
  private _subscribedLp: any = null;
  private _muteEventCleanup: (() => void) | null = null;

  getSpeakerMap(): Record<string, string> | null {
    try {
      const room = getLiveKitRoom();
      if (!room) return null;

      const identityToName = identityNamesFromDom();
      const result: Record<string, string> = {};

      const lp = room.localParticipant;
      const localDomName = lp?.identity ? identityToName[lp.identity] : undefined;
      const localName = participantName(lp, localDomName);
      if (localName) {
        result.local = localName;
      }

      for (const [, p] of room.remoteParticipants) {
        const name = participantName(p, identityToName[p.identity]);
        if (!name) continue;

        for (const [, pub] of p.trackPublications) {
          if (pub.kind === "audio" && pub.track?.mediaStream?.id) {
            result[`remote-${pub.track.mediaStream.id}`] = name;
          }
        }
      }

      return Object.keys(result).length > 0 ? result : null;
    } catch (e) {
      console.error(PREFIX, "getSpeakerMap error:", e);
      return null;
    }
  }

  isLocalMuted(): boolean {
    const room = getLiveKitRoom();
    if (!room?.localParticipant) return false;
    return room.localParticipant.isMicrophoneEnabled === false;
  }

  syncMuteSubscription(onChange: (muted: boolean) => void): void {
    const room = getLiveKitRoom();
    const lp = room?.localParticipant;
    if (!lp || typeof lp.on !== "function") return;
    if (lp === this._subscribedLp) return;

    this.teardown();

    const handleMuteChange = () => onChange(lp.isMicrophoneEnabled === false);
    for (const event of MUTE_EVENTS) {
      lp.on(event, handleMuteChange);
    }

    this._subscribedLp = lp;
    this._muteEventCleanup = () => {
      for (const event of MUTE_EVENTS) {
        lp.off(event, handleMuteChange);
      }
      this._subscribedLp = null;
    };

    console.log(PREFIX, "subscribed to mute events on localParticipant");
  }

  teardown(): void {
    if (this._muteEventCleanup) {
      this._muteEventCleanup();
      this._muteEventCleanup = null;
    }
  }
}
