import { describe, expect, it } from "vitest";
import { generateManifest } from "../scripts/manifest.mjs";
import source from "../src/manifest.json";
import platforms from "../src/platforms.json";

describe("generated manifest", () => {
  it("derives permissions and both platform scripts from the registry", () => {
    const matches = platforms.flatMap(({ hosts }) => hosts.map((host) => `https://${host}/*`));
    const manifest = generateManifest(source, platforms);
    expect(manifest.host_permissions).toEqual([...matches, "http://rechiv.localhost:9876/*"]);
    expect(manifest.content_scripts[0].matches).toEqual(matches);
    expect(manifest.content_scripts[1].matches).toEqual(matches);
    expect(manifest.content_scripts[2]).toEqual(source.content_scripts[2]);
    expect({ ...manifest, host_permissions: [], content_scripts: source.content_scripts }).toEqual(
      source,
    );
  });

  it("includes new hosts without mutating the source", () => {
    const original = structuredClone(source);
    const manifest = generateManifest(source, [{ hosts: ["one.example", "two.example"] }]);
    expect(manifest.content_scripts[0].matches).toEqual([
      "https://one.example/*",
      "https://two.example/*",
    ]);
    expect(manifest.content_scripts[1].matches).toEqual(manifest.content_scripts[0].matches);
    expect(source).toEqual(original);
  });

  it("keeps platform host lists out of the manifest source", () => {
    const text = JSON.stringify(source);
    for (const { hosts } of platforms) {
      for (const host of hosts) expect(text).not.toContain(host);
    }
  });
});
