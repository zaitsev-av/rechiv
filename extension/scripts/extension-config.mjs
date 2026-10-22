import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { build } from "vite";
import { viteStaticCopy } from "vite-plugin-static-copy";
import { manifestPlugin } from "./manifest.mjs";

export function extensionConfig(root) {
  const r = (p) => resolve(root, p);

  // Диагностика включается только явно: RECHIV_DIAG=1 npm run build
  const diagnostics = process.env.RECHIV_DIAG === "1";
  const define = { __RECHIV_DIAG__: JSON.stringify(diagnostics) };
  if (diagnostics) {
    console.log("⚠ Диагностическая сборка: включён полный лог сигналинга.");
  }

  return {
    configFile: false,
    root,
    plugins: [
      manifestPlugin(root),
      contentScriptsPlugin(root, define),
      viteStaticCopy({
        targets: [
          { src: "src/shared/theme.css", dest: "shared" },
          { src: "src/shared/theme-tokens.css", dest: "shared" },
          { src: "src/popup/popup.html", dest: "popup" },
          { src: "src/popup/popup.css", dest: "popup" },
          // Страницы отдаёт desktop; прежние адреса переадресуют туда.
          { src: "src/pages/redirect.html", dest: "pages", rename: "history.html" },
          { src: "src/pages/redirect.html", dest: "pages", rename: "transcript.html" },
          { src: "src/pages/redirect.html", dest: "pages", rename: "settings.html" },
          { src: "public/icons", dest: "." },
        ],
      }),
    ],
    build: {
      outDir: "dist",
      emptyOutDir: true,
      rollupOptions: {
        input: {
          "background/service-worker": r("src/background/service-worker.ts"),
          "popup/popup": r("src/popup/popup.ts"),
          "pages/redirect": r("src/pages/redirect.ts"),
        },
        output: {
          entryFileNames: "[name].js",
          chunkFileNames: "chunks/[name].js",
          format: "es",
        },
      },
    },
    define,
    resolve: { alias: { "@shared": r("src/shared") } },
  };
}

const iifeBundles = [
  ["shared/theme-boot", "src/shared/theme-boot.ts"],
  ["content/interceptor", "src/content/interceptor.ts"],
  ["content/injector", "src/content/injector.ts"],
  ["content/dom-parser", "src/content/dom-parser.ts"],
  ["content/presence", "src/content/presence.ts"],
];

function contentScriptsPlugin(root, define) {
  return {
    name: "rechiv-content-scripts",
    buildStart() {
      const watchDirectory = (directory) => {
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
          const path = resolve(directory, entry.name);
          if (entry.isDirectory()) watchDirectory(path);
          else this.addWatchFile(path);
        }
      };
      watchDirectory(resolve(root, "src/content"));
      watchDirectory(resolve(root, "src/shared"));
    },
    async writeBundle() {
      for (const [name, entry] of iifeBundles) {
        console.log(`Building IIFE: ${name}...`);
        await build({
          configFile: false,
          root,
          build: {
            outDir: "dist",
            emptyOutDir: false,
            rollupOptions: {
              input: { [name]: resolve(root, entry) },
              output: {
                entryFileNames: "[name].js",
                format: "iife",
              },
            },
          },
          define,
          resolve: { alias: { "@shared": resolve(root, "src/shared") } },
          logLevel: "warn",
        });
      }
    },
  };
}
