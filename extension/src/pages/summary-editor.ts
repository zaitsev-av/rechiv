import { Editor } from "@tiptap/core";
import { Markdown } from "@tiptap/markdown";
import StarterKit from "@tiptap/starter-kit";

export type SummaryCommand =
  | "bold"
  | "italic"
  | "heading2"
  | "heading3"
  | "bulletList"
  | "orderedList"
  | "undo"
  | "redo";

export interface SummaryEditor {
  showMarkdown(markdown: string): void;
  setEditable(editable: boolean): void;
  getMarkdown(): string;
  hasText(): boolean;
  command(command: SummaryCommand): void;
  isActive(command: SummaryCommand): boolean;
  destroy(): void;
}

export function createSummaryEditor(container: HTMLElement, onChange: () => void): SummaryEditor {
  const editor = new Editor({
    element: container,
    editable: false,
    injectCSS: false,
    extensions: [
      StarterKit.configure({
        link: {
          openOnClick: false,
          HTMLAttributes: { target: "_blank", rel: "noopener noreferrer nofollow" },
        },
      }),
      Markdown.extend({
        onBeforeCreate(event) {
          this.parent?.(event);
          // HTML из LLM остаётся текстом, в том числе теги, известные StarterKit.
          this.editor.markdown!.instance.use({
            tokenizer: { html: () => undefined, tag: () => undefined },
          });
        },
      }),
    ],
    content: "",
    contentType: "markdown",
    editorProps: {
      attributes: {
        "aria-label": "Саммари созвона",
        role: "textbox",
        "aria-multiline": "true",
        "aria-readonly": "true",
      },
      handleClick: (_view, _pos, event) => {
        const link = (event.target as Element).closest("a");
        if (!link || !editor.isEditable) return false;
        event.preventDefault();
        return true;
      },
    },
    onSelectionUpdate: onChange,
    onTransaction: onChange,
  });

  return {
    showMarkdown(markdown) {
      // Загрузка не должна попадать в историю: иначе «Отменить» стирает саммари целиком.
      editor
        .chain()
        .setMeta("addToHistory", false)
        .setContent(markdown, { contentType: "markdown" })
        .run();
    },
    setEditable(editable) {
      editor.setEditable(editable);
      editor.view.dom.setAttribute("aria-readonly", String(!editable));
      if (editable) editor.commands.focus("start", { scrollIntoView: false });
    },
    getMarkdown: () => editor.getMarkdown().trimEnd(),
    hasText: () => editor.getText().trim().length > 0,
    command(command) {
      const chain = editor.chain().focus();
      switch (command) {
        case "bold":
          chain.toggleBold().run();
          break;
        case "italic":
          chain.toggleItalic().run();
          break;
        case "heading2":
          chain.toggleHeading({ level: 2 }).run();
          break;
        case "heading3":
          chain.toggleHeading({ level: 3 }).run();
          break;
        case "bulletList":
          chain.toggleBulletList().run();
          break;
        case "orderedList":
          chain.toggleOrderedList().run();
          break;
        case "undo":
          chain.undo().run();
          break;
        case "redo":
          chain.redo().run();
          break;
      }
    },
    isActive(command) {
      if (command === "heading2" || command === "heading3") {
        return editor.isActive("heading", { level: command === "heading2" ? 2 : 3 });
      }
      return editor.isActive(command);
    },
    destroy: () => editor.destroy(),
  };
}
