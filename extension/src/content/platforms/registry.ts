import { type PlatformCapabilities, platformForHost } from "@shared/platform";
import { GenericDomAdapter } from "./generic/dom";
import { GenericPageAdapter } from "./generic/page";
import { TelemostDomAdapter } from "./telemost/dom";
import { TelemostPageAdapter } from "./telemost/page";
import type { DomAdapter, PageAdapter } from "./types";
import { WbStreamDomAdapter } from "./wb-stream/dom";
import { LiveKitPageAdapter } from "./wb-stream/page";

const pageAdapters: Record<string, () => PageAdapter> = {
  telemost: () => new TelemostPageAdapter(),
  "wb-stream": () => new LiveKitPageAdapter(),
};
const domAdapters: Record<string, () => DomAdapter> = {
  telemost: () => new TelemostDomAdapter(),
  "wb-stream": () => new WbStreamDomAdapter(),
};
const genericCapabilities: PlatformCapabilities = { audio: "per-participant" };

export function capabilitiesForHost(host: string): PlatformCapabilities {
  return platformForHost(host)?.capabilities ?? genericCapabilities;
}

export function pickPageAdapter(host: string): PageAdapter {
  const id = platformForHost(host)?.id;
  return (id && pageAdapters[id]?.()) || new GenericPageAdapter();
}

export function pickDomAdapter(host: string): DomAdapter {
  const id = platformForHost(host)?.id;
  return (id && domAdapters[id]?.()) || new GenericDomAdapter();
}
