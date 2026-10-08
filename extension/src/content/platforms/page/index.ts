import { platformForHost } from "@shared/platform";
import type { PageAdapter } from "../types";
import { GenericPageAdapter } from "./generic";
import { LiveKitPageAdapter } from "./livekit";
import { TelemostPageAdapter } from "./telemost";

export function pickPageAdapter(host: string): PageAdapter {
  switch (platformForHost(host)?.id) {
    case "wb-stream":
      return new LiveKitPageAdapter();
    case "telemost":
      return new TelemostPageAdapter();
    default:
      return new GenericPageAdapter();
  }
}
