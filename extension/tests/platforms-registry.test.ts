import { beforeEach, describe, expect, it } from "vitest";
import { GenericDomAdapter } from "../src/content/platforms/generic/dom";
import { GenericPageAdapter } from "../src/content/platforms/generic/page";
import {
  capabilitiesForHost,
  pickDomAdapter,
  pickPageAdapter,
} from "../src/content/platforms/registry";
import { TelemostDomAdapter } from "../src/content/platforms/telemost/dom";
import { TelemostPageAdapter } from "../src/content/platforms/telemost/page";
import { WbStreamDomAdapter } from "../src/content/platforms/wb-stream/dom";
import { LiveKitPageAdapter } from "../src/content/platforms/wb-stream/page";
import { PLATFORMS } from "../src/shared/platform";

describe("platform capabilities", () => {
  it.each([
    ["telemost.yandex.ru", "mixed"],
    ["stream.wb.ru", "per-participant"],
    ["unknown.example", "per-participant"],
  ])("selects audio behavior for %s", (host, audio) => {
    expect(capabilitiesForHost(host)).toEqual({ audio });
  });

  it("has capabilities and both adapters for every registered host", () => {
    for (const platform of PLATFORMS) {
      expect(["mixed", "per-participant"]).toContain(platform.capabilities.audio);
      expect(platform.hosts.length).toBeGreaterThan(0);
      for (const host of platform.hosts) {
        expect(capabilitiesForHost(host)).toEqual(platform.capabilities);
        expect(pickPageAdapter(host).constructor).not.toBe(GenericPageAdapter);
        expect(pickDomAdapter(host).constructor).not.toBe(GenericDomAdapter);
      }
    }
  });
});

describe("adapter selection", () => {
  it.each([
    ["telemost.yandex.ru", TelemostPageAdapter, TelemostDomAdapter],
    ["stream.wb.ru", LiveKitPageAdapter, WbStreamDomAdapter],
    ["unknown.example", GenericPageAdapter, GenericDomAdapter],
    ["stream.wb.ru.evil.example", GenericPageAdapter, GenericDomAdapter],
  ])("selects page and DOM adapters for %s", (host, page, dom) => {
    expect(pickPageAdapter(host).constructor).toBe(page);
    expect(pickDomAdapter(host).constructor).toBe(dom);
  });
});

describe("platform DOM selectors", () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <section><div><div><div><div><div data-test="participant-view-block"><span class="name">Анна (Вы)</span></div></div></div></div></div></section>
      <div class="lk-participant-tile" data-lk-local-participant="true">
        <span data-lk-participant-name>Борис (You)</span>
      </div>
      <div><video></video><span class="participant-name">Вера</span></div>
    `;
  });

  it("uses Telemost tiles and generic video fallback", () => {
    const adapter = pickDomAdapter("telemost.yandex.ru");
    expect(adapter.getAllParticipantNames()).toEqual(["Анна", "Вера"]);
    expect(adapter.getLocalParticipantName()).toBe("Анна");
  });

  it("uses WB Stream tiles and generic video fallback", () => {
    const adapter = pickDomAdapter("stream.wb.ru");
    expect(adapter.getAllParticipantNames()).toEqual(["Борис", "Вера"]);
    expect(adapter.getLocalParticipantName()).toBe("Борис");
  });

  it("uses only generic guesses for an unknown host", () => {
    const adapter = pickDomAdapter("unknown.example");
    expect(adapter.getAllParticipantNames()).toEqual(["Вера"]);
    expect(adapter.getLocalParticipantName()).toBeNull();
  });
});
