import type { DomAdapter } from "../types";

export class GenericDomAdapter implements DomAdapter {
  protected nameSelector =
    "[data-testid*='participant-name'], [data-test*='participant-name'], span.ant-typography-ellipsis-single-line, [class*='participant-name'], [class*='participantName'], [class*='name'], [class*='title'], [class*='label']";
  protected tileSelector = "";
  protected localSelector =
    '[data-local-participant="true"], [data-is-local="true"], [class*="local-participant"], [class*="localParticipant"]';

  findParticipantName(streamId: string): string | null {
    const mediaElements = document.querySelectorAll<HTMLVideoElement | HTMLAudioElement>(
      "video, audio",
    );
    const rawId = streamId.replace(/^remote-/, "");
    for (const el of mediaElements) {
      // biome-ignore lint/suspicious/noExplicitAny: srcObject not in HTMLElement type
      const srcObj = (el as any).srcObject;
      if (srcObj?.id === rawId || srcObj?.id === streamId) {
        return this._extractNameFromElement(el);
      }
    }
    return null;
  }

  getAllParticipantNames(): string[] {
    const names = new Set<string>();

    // Плитки остаются в DOM и без video, при выключенной камере.
    const tiles = this.tiles();
    for (const tile of tiles) {
      const name = this._extractNameFromContainer(tile);
      if (name) names.add(name);
    }

    const nameEls = document.querySelectorAll<HTMLElement>(this.nameSelector);
    for (const nameEl of nameEls) {
      const text = this._cleanName(nameEl.textContent);
      if (!text) continue;
      let current: HTMLElement | null = nameEl;
      for (let i = 0; i < 5 && current; i++) {
        current = current.parentElement;
        if (current?.querySelector("video")) {
          names.add(text);
          break;
        }
      }
    }
    return [...names];
  }

  getLocalParticipantName(): string | null {
    const localTiles = document.querySelectorAll<HTMLElement>(this.localSelector);
    for (const tile of localTiles) {
      const name = this._extractNameFromContainer(tile);
      if (name) return name;
    }

    for (const tile of this.tiles()) {
      const rawName = tile.querySelector<HTMLElement>(this.nameSelector)?.textContent;
      if (!rawName || !/(?:\((?:вы|you)\)|·\s*(?:вы|you))\s*$/i.test(rawName)) continue;
      const name = this._cleanName(rawName);
      if (name) return name;
    }
    return null;
  }

  private _extractNameFromElement(mediaEl: HTMLElement): string | null {
    let current: HTMLElement | null = mediaEl;
    for (let i = 0; i < 5 && current; i++) {
      current = current.parentElement;
      if (!current) break;
      const name = this._extractNameFromContainer(current);
      if (name) return name;
    }
    return null;
  }

  private _extractNameFromContainer(container: HTMLElement): string | null {
    const nameEl = container.querySelector<HTMLElement>(this.nameSelector);
    return this._cleanName(nameEl?.textContent);
  }

  private _cleanName(value: string | null | undefined): string | null {
    if (!value) return null;
    const name = value
      .replace(/\s+/g, " ")
      .replace(/\s*(?:\((?:вы|you)\)|·\s*(?:вы|you))\s*$/i, "")
      .trim();
    if (!name || name.length > 120) return null;
    return name;
  }

  private tiles(): NodeListOf<HTMLElement> | [] {
    return this.tileSelector ? document.querySelectorAll<HTMLElement>(this.tileSelector) : [];
  }
}
