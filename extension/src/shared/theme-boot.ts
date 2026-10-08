import { readCachedPalette, readCachedTheme } from "./theme-cache";

// Обычный <script> в <head>: тема ставится до отрисовки, без мигания.
const theme = readCachedTheme();
if (theme) document.documentElement.dataset.theme = theme;
const palette = readCachedPalette();
if (palette) document.documentElement.dataset.palette = palette;
