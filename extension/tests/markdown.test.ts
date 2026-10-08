import { describe, expect, it } from "vitest";

import { markdownToHtml } from "../src/pages/transcript-markdown";

describe("markdownToHtml", () => {
  it("рендерит заголовок ##", () => {
    expect(markdownToHtml("## Hello")).toBe("<h2>Hello</h2>");
  });

  it("рендерит bold через **", () => {
    expect(markdownToHtml("text **bold** end")).toBe("<p>text <strong>bold</strong> end</p>");
  });

  it("эскейпит HTML", () => {
    expect(markdownToHtml("a <script>")).toBe("<p>a &lt;script&gt;</p>");
  });

  it("рендерит unordered list", () => {
    expect(markdownToHtml("- one\n- two")).toBe("<ul>\n<li>one</li>\n<li>two</li>\n</ul>");
  });

  it("рендерит чекбокс - [ ]", () => {
    expect(markdownToHtml("- [ ] task")).toBe("<ul>\n<li>☐ task</li>\n</ul>");
  });

  it("рендерит чекбокс - [x]", () => {
    expect(markdownToHtml("- [x] done")).toBe("<ul>\n<li>☑ done</li>\n</ul>");
  });

  it("рендерит ordered list", () => {
    expect(markdownToHtml("1. one\n2. two")).toBe("<ol>\n<li>one</li>\n<li>two</li>\n</ol>");
  });

  it("закрывает список при пустой строке", () => {
    expect(markdownToHtml("- a\n\nparagraph")).toBe("<ul>\n<li>a</li>\n</ul>\n<p>paragraph</p>");
  });
});
