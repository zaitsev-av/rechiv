const SHOW_AFTER = 620;

export function setupScrollTop(button: HTMLElement): void {
  window.addEventListener(
    "scroll",
    () => button.classList.toggle("visible", window.scrollY > SHOW_AFTER),
    { passive: true },
  );
  button.addEventListener("click", () => {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    window.scrollTo({ top: 0, behavior: reduced ? "auto" : "smooth" });
  });
}
