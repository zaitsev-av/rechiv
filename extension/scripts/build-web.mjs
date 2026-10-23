import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const extensionRoot = resolve(scriptDir, "..");
const outputDir = resolve(extensionRoot, "../build/webui");
const fromExtension = (path) => resolve(extensionRoot, path);

console.log("Building web UI modules...");
await build({
  configFile: false,
  root: extensionRoot,
  publicDir: false,
  build: {
    outDir: outputDir,
    emptyOutDir: true,
    rollupOptions: {
      input: {
        history: fromExtension("src/pages/history.ts"),
        transcript: fromExtension("src/pages/transcript.ts"),
        settings: fromExtension("src/pages/settings.ts"),
        onboarding: fromExtension("src/pages/onboarding.ts"),
      },
      output: {
        entryFileNames: "[name].js",
        chunkFileNames: "chunks/[name].js",
        format: "es",
      },
    },
  },
  resolve: { alias: { "@shared": fromExtension("src/shared") } },
});

console.log("Building web UI theme bootstrap...");
await build({
  configFile: false,
  root: extensionRoot,
  publicDir: false,
  build: {
    outDir: outputDir,
    emptyOutDir: false,
    rollupOptions: {
      input: { "shared/theme-boot": fromExtension("src/shared/theme-boot.ts") },
      output: { entryFileNames: "[name].js", format: "iife" },
    },
  },
  logLevel: "warn",
});

await mkdir(resolve(outputDir, "shared"), { recursive: true });
await cp(fromExtension("public/icons"), resolve(outputDir, "icons"), { recursive: true });
await cp(fromExtension("src/shared/theme.css"), resolve(outputDir, "shared/theme.css"));
await cp(fromExtension("src/shared/theme-tokens.css"), resolve(outputDir, "shared/theme-tokens.css"));

for (const stylesheet of ["history.css", "transcript.css", "settings.css", "onboarding.css"]) {
  await cp(
    fromExtension(`src/pages/${stylesheet}`),
    resolve(outputDir, stylesheet),
  );
}

const htmlPages = [
  ["history.html", "index.html"],
  ["transcript.html", "transcript.html"],
  ["settings.html", "settings.html"],
  ["onboarding.html", "onboarding.html"],
];

for (const [sourceName, outputName] of htmlPages) {
  const source = await readFile(fromExtension(`src/pages/${sourceName}`), "utf8");
  const html = source
    .replaceAll('../shared/', 'shared/')
    .replaceAll('../icons/', 'icons/')
    .replaceAll('href="history.html"', 'href="index.html"');
  await writeFile(resolve(outputDir, outputName), html);
}

console.log(`Web UI build complete: ${outputDir}`);
