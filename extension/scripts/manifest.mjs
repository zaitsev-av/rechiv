import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export function generateManifest(source, platforms) {
  const matches = platforms.flatMap(({ hosts }) => hosts.map((host) => `https://${host}/*`));
  return {
    ...source,
    host_permissions: [...matches, "http://rechiv.localhost:9876/*"],
    content_scripts: source.content_scripts.map((script) =>
      script.matches.length === 0 ? { ...script, matches: [...matches] } : script,
    ),
  };
}

export function manifestPlugin(root) {
  const manifestPath = resolve(root, "src/manifest.json");
  const platformsPath = resolve(root, "src/platforms.json");
  return {
    name: "rechiv-manifest",
    buildStart() {
      this.addWatchFile(manifestPath);
      this.addWatchFile(platformsPath);
    },
    generateBundle() {
      const source = JSON.parse(readFileSync(manifestPath, "utf8"));
      const platforms = JSON.parse(readFileSync(platformsPath, "utf8"));
      this.emitFile({
        type: "asset",
        fileName: "manifest.json",
        source: `${JSON.stringify(generateManifest(source, platforms), null, 2)}\n`,
      });
    },
  };
}
