import { build } from "vite";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { viteStaticCopy } from "vite-plugin-static-copy";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const r = (p) => resolve(root, p);

// Диагностика включается только явно: RECHIV_DIAG=1 npm run build
const diagnostics = process.env.RECHIV_DIAG === "1";
const define = { __RECHIV_DIAG__: JSON.stringify(diagnostics) };
if (diagnostics) {
  console.log("⚠ Диагностическая сборка: включён полный лог сигналинга.");
}

console.log("Building ES modules...");
await build({
  configFile: false,
  root,
  plugins: [
    viteStaticCopy({
      targets: [
        { src: "src/manifest.json", dest: "." },
        { src: "src/shared/theme.css", dest: "shared" },
        { src: "src/shared/theme-tokens.css", dest: "shared" },
        { src: "src/popup/popup.html", dest: "popup" },
        { src: "src/popup/popup.css", dest: "popup" },
        { src: "src/pages/transcript.html", dest: "pages" },
        { src: "src/pages/transcript.css", dest: "pages" },
        { src: "src/pages/history.html", dest: "pages" },
        { src: "src/pages/settings.html", dest: "pages" },
        { src: "src/pages/history.css", dest: "pages" },
        { src: "src/pages/settings.css", dest: "pages" },
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
        "pages/transcript": r("src/pages/transcript.ts"),
        "pages/history": r("src/pages/history.ts"),
        "pages/settings": r("src/pages/settings.ts"),
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
});

const iifeBundles = [
  ["shared/theme-boot", "src/shared/theme-boot.ts"],
  ["content/interceptor", "src/content/interceptor.ts"],
  ["content/injector", "src/content/injector.ts"],
  ["content/dom-parser", "src/content/dom-parser.ts"],
  ["content/presence", "src/content/presence.ts"],
];

for (const [name, entry] of iifeBundles) {
  console.log(`Building IIFE: ${name}...`);
  await build({
    configFile: false,
    root,
    build: {
      outDir: "dist",
      emptyOutDir: false,
      rollupOptions: {
        input: { [name]: r(entry) },
        output: {
          entryFileNames: "[name].js",
          format: "iife",
        },
      },
    },
    define,
    resolve: { alias: { "@shared": r("src/shared") } },
    logLevel: "warn",
  });
}

console.log("Build complete!");
