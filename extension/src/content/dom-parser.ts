import { pickDomAdapter } from "./platforms/registry";
import type { DomAdapter } from "./platforms/types";

export class DomParser implements DomAdapter {
  private readonly adapter: DomAdapter;

  constructor(host = location.host) {
    this.adapter = pickDomAdapter(host);
  }

  findParticipantName(streamId: string): string | null {
    return this.adapter.findParticipantName(streamId);
  }

  getAllParticipantNames(): string[] {
    return this.adapter.getAllParticipantNames();
  }

  getLocalParticipantName(): string | null {
    return this.adapter.getLocalParticipantName();
  }

  static slugify(name: string): string {
    const translitMap: Record<string, string> = {
      а: "a",
      б: "b",
      в: "v",
      г: "g",
      д: "d",
      е: "e",
      ё: "yo",
      ж: "zh",
      з: "z",
      и: "i",
      й: "y",
      к: "k",
      л: "l",
      м: "m",
      н: "n",
      о: "o",
      п: "p",
      р: "r",
      с: "s",
      т: "t",
      у: "u",
      ф: "f",
      х: "kh",
      ц: "ts",
      ч: "ch",
      ш: "sh",
      щ: "shch",
      ъ: "",
      ы: "y",
      ь: "",
      э: "e",
      ю: "yu",
      я: "ya",
    };
    return name
      .toLowerCase()
      .split("")
      .map((c) => translitMap[c] ?? c)
      .join("")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
  }
}

declare global {
  var __rechivDomParser: DomParser | undefined;
}

// Отдельный content script и bundle injector используют один парсер в isolated world.
globalThis.__rechivDomParser ??= new DomParser();
export const domParser = globalThis.__rechivDomParser;
