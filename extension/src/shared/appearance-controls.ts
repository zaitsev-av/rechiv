import type { Config } from "./config";
import { applyPalette, applyTheme, isPalette } from "./theme";

type Appearance = Pick<Config, "theme" | "palette">;

export function readAppearanceControls(root: ParentNode): Appearance {
  const theme = root.querySelector<HTMLInputElement>('input[name="theme"]:checked')?.value;
  const palette = root.querySelector<HTMLInputElement>('input[name="palette"]:checked')?.value;
  return {
    theme: theme === "dark" ? "dark" : "light",
    palette: isPalette(palette) ? palette : "graphite",
  };
}

export function setAppearanceControls(root: ParentNode, config: Appearance): void {
  for (const [name, value] of Object.entries(config)) {
    const input = root.querySelector<HTMLInputElement>(`input[name="${name}"][value="${value}"]`);
    if (input) input.checked = true;
  }
}

export function bindAppearanceControls(
  root: ParentNode,
  onChange?: (patch: Partial<Appearance>) => void,
): void {
  for (const input of root.querySelectorAll<HTMLInputElement>('input[name="theme"]')) {
    input.addEventListener("change", () => {
      const { theme } = readAppearanceControls(root);
      applyTheme(theme);
      onChange?.({ theme });
    });
  }
  for (const input of root.querySelectorAll<HTMLInputElement>('input[name="palette"]')) {
    input.addEventListener("change", () => {
      const { palette } = readAppearanceControls(root);
      applyPalette(palette);
      onChange?.({ palette });
    });
  }
}
