import { afterEach, describe, expect, it, vi } from "vitest";
import { createSummaryEditor, type SummaryEditor } from "../src/pages/summary-editor";

let editor: SummaryEditor;
function create() {
  const container = document.createElement("div");
  document.body.append(container);
  editor = createSummaryEditor(container, vi.fn());
  return container;
}

afterEach(() => {
  editor?.destroy();
  document.body.innerHTML = "";
});

describe("summary editor with real Tiptap", () => {
  it("round-trips headings, lists, formatting, links, quotes and code", () => {
    const container = create();
    const markdown = `# Итоги встречи

## Решения

- **Важное** решение
- Второй пункт с *курсивом*

1. Первый шаг
2. Второй шаг

[Документ](https://example.com/notes)

> Цитата участника

\`код\`

\`\`\`js
const result = 1;
\`\`\`

---`;
    editor.showMarkdown(markdown);
    expect(container.querySelectorAll("h1, h2")).toHaveLength(2);
    expect(container.querySelectorAll("ul li, ol li")).toHaveLength(4);
    expect(container.querySelector("strong")?.textContent).toBe("Важное");
    expect(container.querySelector("blockquote")?.textContent).toContain("Цитата участника");
    const link = container.querySelector("a")!;
    expect(link.href).toBe("https://example.com/notes");
    expect(link.rel).toContain("noopener");
    expect(link.target).toBe("_blank");
    const result = editor.getMarkdown();
    for (const text of [
      "# Итоги встречи",
      "## Решения",
      "**Важное**",
      "Второй пункт",
      "*курсивом*",
      "1. Первый шаг",
      "2. Второй шаг",
      "[Документ](https://example.com/notes)",
      "> Цитата участника",
      "`код`",
      "const result = 1;",
    ]) {
      expect(result).toContain(text);
    }
    editor.showMarkdown(result);
    expect(editor.getMarkdown()).toBe(result);
    expect(container.querySelector("hr")).not.toBeNull();
    expect(container.querySelector("pre code")?.textContent).toContain("const result = 1;");
  });

  it("treats raw HTML as text, including StarterKit tags", () => {
    const container = create();
    editor.showMarkdown(
      "<h2>HTML heading</h2>\n\ntext <strong>HTML bold</strong>\n\n<img src=x onerror=alert(1)>\n\n<script>alert(1)</script>",
    );
    expect(container.querySelector("h2, strong, img, script")).toBeNull();
    expect(container.textContent).toContain("<h2>HTML heading</h2>");
    expect(container.textContent).toContain("<strong>HTML bold</strong>");
    const serialized = editor.getMarkdown();
    editor.showMarkdown(serialized);
    expect(container.querySelector("h2, strong, img, script")).toBeNull();
  });

  it("switches editing, executes formatting and history, and rejects textless documents", () => {
    const container = create();
    expect(container.querySelector(".ProseMirror")?.getAttribute("contenteditable")).toBe("false");
    editor.showMarkdown("Text");
    editor.setEditable(true);
    expect(container.querySelector(".ProseMirror")?.getAttribute("contenteditable")).toBe("true");
    editor.command("heading2");
    expect(editor.isActive("heading2")).toBe(true);
    expect(editor.getMarkdown()).toBe("## Text");
    editor.command("undo");
    expect(editor.getMarkdown()).toBe("Text");
    editor.command("redo");
    expect(editor.getMarkdown()).toBe("## Text");
    editor.setEditable(false);
    expect(editor.hasText()).toBe(true);
    editor.showMarkdown("---");
    expect(editor.hasText()).toBe(false);
    editor.showMarkdown("");
    expect(editor.hasText()).toBe(false);
  });
});
