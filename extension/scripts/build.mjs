import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { extensionConfig } from "./extension-config.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
await build(extensionConfig(root));
console.log("Build complete!");
