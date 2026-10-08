import { resolve } from "path";
import { defineConfig } from "vite";
import { viteStaticCopy } from "vite-plugin-static-copy";

export default defineConfig({
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
        "background/service-worker": resolve(__dirname, "src/background/service-worker.ts"),
        "shared/theme-boot": resolve(__dirname, "src/shared/theme-boot.ts"),
        "content/injector": resolve(__dirname, "src/content/injector.ts"),
        "content/interceptor": resolve(__dirname, "src/content/interceptor.ts"),
        "content/dom-parser": resolve(__dirname, "src/content/dom-parser.ts"),
        "popup/popup": resolve(__dirname, "src/popup/popup.ts"),
        "pages/transcript": resolve(__dirname, "src/pages/transcript.ts"),
        "pages/history": resolve(__dirname, "src/pages/history.ts"),
        "pages/settings": resolve(__dirname, "src/pages/settings.ts"),
      },
      output: {
        entryFileNames: "[name].js",
        format: "iife",
        inlineDynamicImports: false,
      },
    },
  },
  resolve: {
    alias: {
      "@shared": resolve(__dirname, "src/shared"),
    },
  },
});
