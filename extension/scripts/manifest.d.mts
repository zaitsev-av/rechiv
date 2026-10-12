import type { Plugin } from "vite";

export function generateManifest<T extends { content_scripts: { matches: string[] }[] }>(
  source: T,
  platforms: readonly { hosts: readonly string[] }[],
): Omit<T, "host_permissions"> & { host_permissions: string[] };

export function manifestPlugin(root: string): Plugin;
