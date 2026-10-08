import { defineConfig } from "vite";
import { extensionConfig } from "./scripts/extension-config.mjs";

export default defineConfig(extensionConfig(__dirname));
