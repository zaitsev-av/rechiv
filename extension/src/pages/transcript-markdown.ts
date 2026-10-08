export function markdownToHtml(md: string): string {
  const lines = md.split("\n");
  const html: string[] = [];
  let listTag: "ul" | "ol" | null = null;

  const closeList = () => {
    if (listTag) {
      html.push(`</${listTag}>`);
      listTag = null;
    }
  };

  for (const line of lines) {
    const trimmed = line.trim();

    if (!trimmed) {
      closeList();
      continue;
    }

    const escaped = trimmed
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");

    if (/^### /.test(escaped)) {
      closeList();
      html.push(`<h3>${escaped.slice(4)}</h3>`);
    } else if (/^## /.test(escaped)) {
      closeList();
      html.push(`<h2>${escaped.slice(3)}</h2>`);
    } else if (/^# /.test(escaped)) {
      closeList();
      html.push(`<h1>${escaped.slice(2)}</h1>`);
    } else if (/^- \[ \] /.test(escaped)) {
      if (!listTag) {
        html.push("<ul>");
        listTag = "ul";
      }
      html.push(`<li>☐ ${escaped.slice(6)}</li>`);
    } else if (/^- \[x\] /.test(escaped)) {
      if (!listTag) {
        html.push("<ul>");
        listTag = "ul";
      }
      html.push(`<li>☑ ${escaped.slice(6)}</li>`);
    } else if (/^- /.test(escaped)) {
      if (!listTag) {
        html.push("<ul>");
        listTag = "ul";
      }
      html.push(`<li>${escaped.slice(2)}</li>`);
    } else if (/^\d+\. /.test(escaped)) {
      if (!listTag) {
        html.push("<ol>");
        listTag = "ol";
      }
      html.push(`<li>${escaped.replace(/^\d+\. /, "")}</li>`);
    } else {
      closeList();
      html.push(`<p>${escaped}</p>`);
    }
  }

  closeList();
  return html.join("\n");
}
