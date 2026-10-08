export interface InlineEditOptions {
  allowEmpty?: boolean;
  onError?: (err: unknown) => void;
}

function selectAll(el: HTMLElement): void {
  try {
    const range = document.createRange();
    range.selectNodeContents(el);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  } catch {
    // Выделение необязательно.
  }
}

/** Enter сохраняет, Escape отменяет. */
export function startInlineEdit(
  el: HTMLElement,
  current: string,
  save: (value: string) => Promise<void> | void,
  options: InlineEditOptions = {},
): Promise<void> {
  if (el.isContentEditable) return Promise.resolve();

  el.contentEditable = "true";
  el.classList.add("editing");
  el.textContent = current;
  el.focus();
  selectAll(el);

  return new Promise<void>((resolve) => {
    let finished = false;

    const finish = async (commit: boolean) => {
      if (finished) return;
      finished = true;
      el.removeEventListener("keydown", onKeydown);
      el.removeEventListener("blur", onBlur);
      el.removeEventListener("click", stopClick);
      el.contentEditable = "false";
      el.classList.remove("editing");

      const value = (el.textContent ?? "").trim();
      const unchanged = value === current.trim();
      if (!commit || unchanged || (!value && !options.allowEmpty)) {
        el.textContent = current;
        resolve();
        return;
      }

      try {
        await save(value);
      } catch (err) {
        el.textContent = current;
        options.onError?.(err);
      }
      resolve();
    };

    const onKeydown = (event: KeyboardEvent) => {
      if (event.key === "Enter") {
        event.preventDefault();
        void finish(true);
      } else if (event.key === "Escape") {
        event.preventDefault();
        void finish(false);
      }
    };
    const onBlur = () => void finish(true);
    // Карточка сессии кликабельна целиком.
    const stopClick = (event: MouseEvent) => event.stopPropagation();

    el.addEventListener("keydown", onKeydown);
    el.addEventListener("blur", onBlur);
    el.addEventListener("click", stopClick);
  });
}
