import { beforeEach, describe, expect, it, vi } from "vitest";
import { startInlineEdit } from "../src/shared/inline-edit";

function field(text = "Спикер 1"): HTMLElement {
  document.body.innerHTML = `<div id="field">${text}</div>`;
  return document.getElementById("field")!;
}

function press(el: HTMLElement, key: string): void {
  el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
}

describe("startInlineEdit", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("сохраняет по Enter", async () => {
    const el = field();
    const save = vi.fn().mockResolvedValue(undefined);
    const done = startInlineEdit(el, "Спикер 1", save);

    el.textContent = "Анна";
    press(el, "Enter");
    await done;

    expect(save).toHaveBeenCalledWith("Анна");
    expect(el.isContentEditable).toBe(false);
    expect(el.classList.contains("editing")).toBe(false);
  });

  it("откатывает по Escape", async () => {
    const el = field();
    const save = vi.fn();
    const done = startInlineEdit(el, "Спикер 1", save);

    el.textContent = "Анна";
    press(el, "Escape");
    await done;

    expect(save).not.toHaveBeenCalled();
    expect(el.textContent).toBe("Спикер 1");
  });

  it("сохраняет по потере фокуса", async () => {
    const el = field();
    const save = vi.fn().mockResolvedValue(undefined);
    const done = startInlineEdit(el, "Спикер 1", save);

    el.textContent = "  Анна  ";
    el.dispatchEvent(new Event("blur"));
    await done;

    expect(save).toHaveBeenCalledWith("Анна");
  });

  it("не дёргает сохранение, когда значение не изменилось", async () => {
    const el = field();
    const save = vi.fn();
    const done = startInlineEdit(el, "Спикер 1", save);

    press(el, "Enter");
    await done;

    expect(save).not.toHaveBeenCalled();
  });

  it("не принимает пустое значение без allowEmpty", async () => {
    const el = field();
    const save = vi.fn();
    const done = startInlineEdit(el, "Спикер 1", save);

    el.textContent = "   ";
    press(el, "Enter");
    await done;

    expect(save).not.toHaveBeenCalled();
    expect(el.textContent).toBe("Спикер 1");
  });

  it("разрешает очистить значение с allowEmpty", async () => {
    const el = field("Планёрка");
    const save = vi.fn().mockResolvedValue(undefined);
    const done = startInlineEdit(el, "Планёрка", save, { allowEmpty: true });

    el.textContent = "";
    press(el, "Enter");
    await done;

    expect(save).toHaveBeenCalledWith("");
  });

  it("возвращает прежний текст и зовёт onError, если сохранить не удалось", async () => {
    const el = field();
    const onError = vi.fn();
    const done = startInlineEdit(el, "Спикер 1", vi.fn().mockRejectedValue(new Error("500")), {
      onError,
    });

    el.textContent = "Анна";
    press(el, "Enter");
    await done;

    expect(el.textContent).toBe("Спикер 1");
    expect(onError).toHaveBeenCalled();
  });

  it("сохраняет один раз, даже если blur придёт после Enter", async () => {
    const el = field();
    const save = vi.fn().mockResolvedValue(undefined);
    const done = startInlineEdit(el, "Спикер 1", save);

    el.textContent = "Анна";
    press(el, "Enter");
    el.dispatchEvent(new Event("blur"));
    await done;

    expect(save).toHaveBeenCalledTimes(1);
  });

  it("не даёт клику всплыть на карточку", async () => {
    document.body.innerHTML = `<div id="card"><span id="field">Планёрка</span></div>`;
    const card = document.getElementById("card")!;
    const el = document.getElementById("field")!;
    const cardClick = vi.fn();
    card.addEventListener("click", cardClick);

    const done = startInlineEdit(el, "Планёрка", vi.fn());
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    press(el, "Escape");
    await done;

    expect(cardClick).not.toHaveBeenCalled();
  });
});
