import { marked } from "./vendor/marked.esm.js";

// Build DOM nodes from Marked tokens. Raw HTML is always displayed as text.
function inline(tokens = []) {
  const fragment = document.createDocumentFragment();
  for (const token of tokens) {
    let node;
    switch (token.type) {
      case "strong": node = document.createElement("strong"); node.append(inline(token.tokens)); break;
      case "em": node = document.createElement("em"); node.append(inline(token.tokens)); break;
      case "del": node = document.createElement("del"); node.append(inline(token.tokens)); break;
      case "codespan": node = document.createElement("code"); node.textContent = token.text; break;
      case "link": {
        const url = String(token.href || "");
        if (/^(https?:|mailto:)/i.test(url)) {
          node = document.createElement("a"); node.href = url; node.target = "_blank"; node.rel = "noopener noreferrer"; node.append(inline(token.tokens));
        } else { node = document.createTextNode(token.text || url); }
        break;
      }
      case "br": node = document.createElement("br"); break;
      case "image": node = document.createTextNode(token.text || "[图片]"); break;
      case "text":
        if (token.tokens) { node = inline(token.tokens); break; }
        node = document.createTextNode(token.text || ""); break;
      default: node = document.createTextNode(token.raw || token.text || "");
    }
    fragment.append(node);
  }
  return fragment;
}

function blocks(tokens = []) {
  const fragment = document.createDocumentFragment();
  for (const token of tokens) {
    let node;
    switch (token.type) {
      case "space": continue;
      case "heading": node = document.createElement(`h${Math.min(6, Math.max(1, token.depth))}`); node.append(inline(token.tokens)); break;
      case "paragraph": node = document.createElement("p"); node.append(inline(token.tokens)); break;
      case "text": node = document.createElement("p"); node.append(inline(token.tokens || [{ type: "text", text: token.text }])); break;
      case "code": {
        node = document.createElement("pre"); const code = document.createElement("code"); code.textContent = token.text || "";
        if (token.lang) code.dataset.lang = token.lang;
        node.append(code); break;
      }
      case "list": {
        node = document.createElement(token.ordered ? "ol" : "ul");
        if (token.ordered && token.start) node.start = token.start;
        for (const item of token.items || []) { const li = document.createElement("li"); li.append(blocks(item.tokens)); node.append(li); }
        break;
      }
      case "blockquote": node = document.createElement("blockquote"); node.append(blocks(token.tokens)); break;
      case "hr": node = document.createElement("hr"); break;
      case "html": node = document.createElement("p"); node.textContent = token.text || token.raw || ""; break;
      case "table": {
        node = document.createElement("table"); const head = document.createElement("thead"); const heading = document.createElement("tr");
        for (const cell of token.header || []) { const th = document.createElement("th"); th.append(inline(cell.tokens)); heading.append(th); }
        head.append(heading); node.append(head);
        const body = document.createElement("tbody");
        for (const row of token.rows || []) { const tr = document.createElement("tr"); for (const cell of row) { const td = document.createElement("td"); td.append(inline(cell.tokens)); tr.append(td); } body.append(tr); }
        node.append(body); break;
      }
      default: node = document.createElement("p"); node.textContent = token.raw || token.text || "";
    }
    fragment.append(node);
  }
  return fragment;
}

export function renderMarkdown(root, source) {
  root.replaceChildren(blocks(marked.lexer(String(source || ""), { gfm: true })));
}
