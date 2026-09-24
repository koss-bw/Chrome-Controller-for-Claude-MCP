// Minimal markdown renderer for assistant messages.
//
// Builds DOM nodes directly and never touches innerHTML. That is a security
// property, not a style preference: this runs in an extension page that holds
// chrome.storage / chrome.tabs / chrome.runtime, so model output must never
// reach an HTML parser. With no parsing step there is nothing for a crafted
// string to inject — the worst case is text that looks wrong.
//
// Hand-written rather than vendored (marked + DOMPurify would be ~100KB of
// third-party code) to match a codebase that has no bundler and no dependencies
// — the SSE reader next door is hand-rolled for the same reason.
//
// Covers what Claude actually emits: headings, emphasis, inline code, fenced
// code, ordered/unordered lists with nesting, links, blockquotes, tables, and
// horizontal rules. Not a spec-complete CommonMark implementation; unsupported
// syntax degrades to the literal text, which is exactly what the panel showed
// before this existed.

const H_RE = /^(#{1,6})\s+(.*)$/;
const HR_RE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const FENCE_RE = /^\s{0,3}(`{3,}|~{3,})\s*([\w+-]*)\s*$/;
const QUOTE_RE = /^\s{0,3}>\s?(.*)$/;
const UL_RE = /^(\s*)([-*+])\s+(.*)$/;
const OL_RE = /^(\s*)(\d{1,9})[.)]\s+(.*)$/;
const TABLE_DIV_RE = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)+\|?\s*$/;

// Only these schemes become real links. Anything else (javascript:, data:)
// renders as plain text rather than being silently dropped, so nothing the
// model wrote disappears from view.
const SAFE_HREF = /^(https?:|mailto:)/i;

export function renderMarkdown(src) {
  const frag = document.createDocumentFragment();
  const lines = String(src == null ? "" : src)
    .replace(/\r\n?/g, "\n")
    .split("\n");
  for (const node of parseBlocks(lines, 0, lines.length)) frag.appendChild(node);
  return frag;
}

// --- Block level -----------------------------------------------------------

function parseBlocks(lines, from, to) {
  const out = [];
  let i = from;

  while (i < to) {
    const line = lines[i];

    if (!line.trim()) {
      i++;
      continue;
    }

    const fence = FENCE_RE.exec(line);
    if (fence) {
      const [, marker, lang] = fence;
      const body = [];
      i++;
      // An unclosed fence runs to the end — common mid-stream, and better than
      // dumping the rest of the message as paragraphs.
      while (i < to && !(FENCE_RE.exec(lines[i]) || [])[1]?.startsWith(marker[0])) {
        body.push(lines[i]);
        i++;
      }
      if (i < to) i++; // consume the closing fence
      out.push(codeBlock(body.join("\n"), lang));
      continue;
    }

    if (HR_RE.test(line)) {
      out.push(document.createElement("hr"));
      i++;
      continue;
    }

    const heading = H_RE.exec(line);
    if (heading) {
      const el = document.createElement("h" + heading[1].length);
      inline(heading[2], el);
      out.push(el);
      i++;
      continue;
    }

    if (QUOTE_RE.test(line)) {
      const inner = [];
      while (i < to && QUOTE_RE.test(lines[i])) {
        inner.push(QUOTE_RE.exec(lines[i])[1]);
        i++;
      }
      const el = document.createElement("blockquote");
      for (const node of parseBlocks(inner, 0, inner.length)) el.appendChild(node);
      out.push(el);
      continue;
    }

    if (isTableStart(lines, i, to)) {
      const [el, next] = parseTable(lines, i, to);
      out.push(el);
      i = next;
      continue;
    }

    if (UL_RE.test(line) || OL_RE.test(line)) {
      const [el, next] = parseList(lines, i, to);
      out.push(el);
      i = next;
      continue;
    }

    // Paragraph: run until a blank line or the start of another block.
    const buf = [];
    while (i < to && lines[i].trim() && !startsBlock(lines, i, to)) {
      buf.push(lines[i]);
      i++;
    }
    if (buf.length) {
      const p = document.createElement("p");
      inline(buf.join("\n"), p);
      out.push(p);
    } else {
      i++; // defensive: never spin on a line nothing consumed
    }
  }

  return out;
}

function startsBlock(lines, i, to) {
  const line = lines[i];
  return (
    FENCE_RE.test(line) ||
    HR_RE.test(line) ||
    H_RE.test(line) ||
    QUOTE_RE.test(line) ||
    UL_RE.test(line) ||
    OL_RE.test(line) ||
    isTableStart(lines, i, to)
  );
}

function codeBlock(text, lang) {
  const pre = document.createElement("pre");
  pre.className = "md-code";
  const code = document.createElement("code");
  if (lang) {
    code.className = "lang-" + lang;
    pre.dataset.lang = lang;
  }
  code.textContent = text;
  pre.appendChild(code);
  return pre;
}

// --- Lists -----------------------------------------------------------------

function itemMatch(line) {
  const ul = UL_RE.exec(line);
  if (ul) return { indent: ul[1].length, ordered: false, text: ul[3], start: null };
  const ol = OL_RE.exec(line);
  if (ol) return { indent: ol[1].length, ordered: true, text: ol[3], start: Number(ol[2]) };
  return null;
}

function parseList(lines, from, to) {
  const first = itemMatch(lines[from]);
  const ordered = first.ordered;
  const baseIndent = first.indent;
  const list = document.createElement(ordered ? "ol" : "ul");
  list.className = "md-list";
  if (ordered && first.start !== 1) list.start = first.start;

  let i = from;
  let current = null; // lines belonging to the item being accumulated

  const flush = () => {
    if (!current) return;
    const li = document.createElement("li");
    const blocks = parseBlocks(current, 0, current.length);
    // Unwrap a leading <p> so the item's own text sits directly in the <li>.
    // Otherwise every bullet carries paragraph margins, which reads as a blank
    // line between each one — and an item with a nested list under it gets a
    // gap between its text and the sub-list.
    for (const node of blocks) {
      if (node === blocks[0] && node.tagName === "P") {
        while (node.firstChild) li.appendChild(node.firstChild);
      } else {
        li.appendChild(node);
      }
    }
    list.appendChild(li);
    current = null;
  };

  while (i < to) {
    const line = lines[i];

    if (!line.trim()) {
      // A blank line ends the list unless the next line continues it.
      const next = i + 1 < to ? lines[i + 1] : "";
      const nextItem = itemMatch(next);
      const continues =
        (nextItem && nextItem.indent >= baseIndent) ||
        (next.trim() && next.search(/\S/) > baseIndent);
      if (!continues) break;
      if (current) current.push("");
      i++;
      continue;
    }

    const m = itemMatch(line);
    if (m && m.indent <= baseIndent + 1) {
      if (m.ordered !== ordered) break; // a different list type starts here
      flush();
      current = [m.text];
      i++;
      continue;
    }

    // Deeper item, or a lazy continuation line: hand it to the item's own
    // block parse, de-indented so nested lists see their own base.
    if (m || line.search(/\S/) > baseIndent) {
      if (!current) break;
      current.push(line.slice(Math.min(line.search(/\S/), baseIndent + 2)));
      i++;
      continue;
    }

    break;
  }

  flush();
  return [list, i];
}

// --- Tables ----------------------------------------------------------------

function isTableStart(lines, i, to) {
  return (
    i + 1 < to && lines[i].includes("|") && TABLE_DIV_RE.test(lines[i + 1]) && lines[i].trim() !== ""
  );
}

function splitRow(line) {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  // Split on unescaped pipes only.
  return s.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
}

function parseTable(lines, from, to) {
  const aligns = splitRow(lines[from + 1]).map((c) => {
    const left = c.startsWith(":");
    const right = c.endsWith(":");
    if (left && right) return "center";
    if (right) return "right";
    if (left) return "left";
    return "";
  });

  const table = document.createElement("table");
  table.className = "md-table";

  const thead = document.createElement("thead");
  thead.appendChild(row(splitRow(lines[from]), "th", aligns));
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  let i = from + 2;
  while (i < to && lines[i].trim() && lines[i].includes("|")) {
    tbody.appendChild(row(splitRow(lines[i]), "td", aligns));
    i++;
  }
  table.appendChild(tbody);

  // The panel is narrow; let a wide table scroll inside its own box rather
  // than stretching the message column.
  const wrap = document.createElement("div");
  wrap.className = "md-table-wrap";
  wrap.appendChild(table);
  return [wrap, i];
}

function row(cells, tag, aligns) {
  const tr = document.createElement("tr");
  cells.forEach((cell, idx) => {
    const el = document.createElement(tag);
    if (aligns[idx]) el.style.textAlign = aligns[idx];
    inline(cell, el);
    tr.appendChild(el);
  });
  return tr;
}

// --- Inline ----------------------------------------------------------------

// One alternation, matched left-to-right, so the earliest construct in the
// string always wins regardless of which kind it is.
const INLINE_RE = new RegExp(
  [
    "(`+)([\\s\\S]*?)\\1", // 1,2  code span
    "\\*\\*([\\s\\S]+?)\\*\\*", // 3    bold
    "__([\\s\\S]+?)__", // 4    bold
    "~~([\\s\\S]+?)~~", // 5    strikethrough
    "\\*([^*\\n]+?)\\*", // 6    italic
    "(?<![A-Za-z0-9_])_([^_\\n]+?)_(?![A-Za-z0-9_])", // 7 italic, not snake_case
    // The URL allows one level of balanced parens, so Wikipedia-style
    // "..._(disambiguation)" links survive and a rejected "javascript:alert(1)"
    // is consumed whole instead of leaving a stray ")" behind.
    "!\\[([^\\]]*)\\]\\(\\s*((?:[^()\\s]|\\([^()\\s]*\\))+)[^)]*\\)", // 8,9  image
    "\\[([^\\]]*)\\]\\(\\s*((?:[^()\\s]|\\([^()\\s]*\\))+)[^)]*\\)", // 10,11 link
    "(https?://[^\\s<>()\\[\\]]+)" // 12   bare url
  ].join("|")
);

function inline(text, parent) {
  let rest = String(text);

  for (;;) {
    const m = INLINE_RE.exec(rest);
    if (!m) break;

    if (m.index > 0) parent.appendChild(document.createTextNode(rest.slice(0, m.index)));

    if (m[1] !== undefined) {
      // Code span content is literal — no recursion, or `**` inside code would
      // render as bold.
      const code = document.createElement("code");
      code.className = "md-inline-code";
      code.textContent = m[2].replace(/^ | $/g, "");
      parent.appendChild(code);
    } else if (m[3] !== undefined || m[4] !== undefined) {
      parent.appendChild(wrap("strong", m[3] ?? m[4]));
    } else if (m[5] !== undefined) {
      parent.appendChild(wrap("del", m[5]));
    } else if (m[6] !== undefined || m[7] !== undefined) {
      parent.appendChild(wrap("em", m[6] ?? m[7]));
    } else if (m[8] !== undefined) {
      // Images aren't fetched — remote loads from an extension page are a
      // privacy leak and would be CSP-blocked anyway. Show the alt text.
      parent.appendChild(link(m[9], m[8] || m[9]));
    } else if (m[10] !== undefined) {
      parent.appendChild(link(m[11], m[10] || m[11]));
    } else if (m[12] !== undefined) {
      parent.appendChild(link(m[12], m[12]));
    }

    rest = rest.slice(m.index + m[0].length);
  }

  if (rest) parent.appendChild(document.createTextNode(rest));
}

function wrap(tag, content) {
  const el = document.createElement(tag);
  inline(content, el);
  return el;
}

function link(href, text) {
  if (!SAFE_HREF.test(href)) {
    // Unsafe scheme: keep the text visible, drop the navigation.
    return document.createTextNode(text);
  }
  const a = document.createElement("a");
  a.href = href;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  a.textContent = text;
  return a;
}
