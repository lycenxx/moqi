// A small Markdown reader for moqi's answers. It returns plain data, which app.js turns into elements with
// textContent and checked links only: nothing in an answer can become HTML or load anything from outside.
(() => {
  const SAFE = /^https?:\/\//i;
  const FENCE = /^\s*(```|~~~)\s*([\w+-]*)\s*$/;
  const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
  const HR = /^\s*([-*_])(\s*\1){2,}\s*$/;
  const ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
  const QUOTE = /^\s*>\s?(.*)$/;
  const TABLE_SEP = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;
  const BARE = /^https?:\/\/[A-Za-z0-9\-._~:/?#@!$&*+,;=%]+/i;
  const CODE = /^`([^`\n]+)`/;
  const LINK = /^!?\[([^\]\n]*)\]\(([^)\s]+)(?:\s+"[^"\n]*")?\)/;
  const BOLD = /^(\*\*|__)(?=\S)([^\n]*?\S)\1/;
  const ITALIC = /^(\*|_)(?=\S)([^*_\n]*?\S)\1(?![*_])/;

  function inline(src) {
    const out = [];
    let buf = "";
    const flush = () => {
      if (buf) out.push({ t: "text", v: buf });
      buf = "";
    };
    let i = 0;
    while (i < src.length) {
      const rest = src.slice(i);
      const before = src[i - 1] ?? "";
      const code = CODE.exec(rest);
      if (code) {
        flush();
        out.push({ t: "code", v: code[1] });
        i += code[0].length;
        continue;
      }
      const link = LINK.exec(rest);
      if (link) {
        if (SAFE.test(link[2])) {
          flush();
          out.push({ t: "a", href: link[2], c: inline(link[1] || link[2]) });
        } else buf += link[0]; // another scheme stays words
        i += link[0].length;
        continue;
      }
      const bold = BOLD.exec(rest);
      if (bold) {
        flush();
        out.push({ t: "b", c: inline(bold[2]) });
        i += bold[0].length;
        continue;
      }
      const italic = ITALIC.exec(rest);
      if (italic && (italic[1] === "*" || !/\w/.test(before))) {
        flush();
        out.push({ t: "i", c: inline(italic[2]) });
        i += italic[0].length;
        continue;
      }
      const bare = /[\w/]/.test(before) ? null : BARE.exec(rest);
      if (bare) {
        const url = bare[0].replace(/[.,;:!?'"]+$/, "");
        flush();
        out.push({ t: "a", href: url, c: [{ t: "text", v: url }] });
        i += url.length;
        continue;
      }
      if (src[i] === "\n") {
        flush();
        out.push({ t: "br" });
      } else buf += src[i];
      i++;
    }
    flush();
    return out;
  }

  const plain = (nodes) => nodes.map((n) => (n.t === "text" || n.t === "code" ? n.v : n.c ? plain(n.c) : "")).join("");
  const hostOf = (href) => new URL(href).host.toLowerCase().replace(/^www\./, "");
  const soleLink = (c) =>
    c.length === 1 && c[0].t === "a" ? { text: plain(c[0].c), href: c[0].href, host: hostOf(c[0].href) } : undefined;
  const cells = (line) =>
    line
      .trim()
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((s) => s.trim());
  const isTable = (lines, i) => lines[i].includes("|") && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]);
  const startsBlock = (lines, i) =>
    FENCE.test(lines[i]) ||
    HEADING.test(lines[i]) ||
    HR.test(lines[i]) ||
    ITEM.test(lines[i]) ||
    QUOTE.test(lines[i]) ||
    isTable(lines, i);

  function readList(lines, start) {
    const first = ITEM.exec(lines[start]);
    const indent = first[1].length;
    const ordered = /\d/.test(first[2]);
    const list = { t: ordered ? "ol" : "ul", start: ordered ? Number.parseInt(first[2], 10) : 1, items: [] };
    let i = start;
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) {
        const next = i + 1 < lines.length ? ITEM.exec(lines[i + 1]) : null;
        if (next && next[1].length === indent) {
          i++;
          continue;
        }
        break;
      }
      const m = ITEM.exec(line);
      const last = list.items[list.items.length - 1];
      if (m && m[1].length === indent) {
        list.items.push({ c: inline(m[3]) });
        i++;
      } else if (m && m[1].length > indent && last) {
        const [sub, next] = readList(lines, i);
        last.sub = sub;
        i = next;
      } else if (!m && /^\s+\S/.test(line) && last) {
        last.c = last.c.concat({ t: "br" }, inline(line.trim()));
        i++;
      } else break;
    }
    const links = list.items.map((it) => (it.sub ? undefined : soleLink(it.c)));
    if (links.length > 0 && links.every(Boolean)) return [{ t: "cards", links }, i];
    return [list, i];
  }

  function parse(text) {
    const lines = String(text ?? "")
      .replace(/\r\n?/g, "\n")
      .split("\n");
    const blocks = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) {
        i++;
        continue;
      }
      const fence = FENCE.exec(line);
      if (fence) {
        const body = [];
        i++;
        while (i < lines.length && lines[i].trim() !== fence[1]) body.push(lines[i++]);
        i++; // the closing fence, when there is one
        blocks.push({ t: "code", lang: fence[2], text: body.join("\n") });
        continue;
      }
      const heading = HEADING.exec(line);
      if (heading) {
        blocks.push({ t: "h", level: heading[1].length <= 2 ? 1 : 2, c: inline(heading[2]) });
        i++;
        continue;
      }
      if (HR.test(line)) {
        blocks.push({ t: "hr" });
        i++;
        continue;
      }
      if (isTable(lines, i)) {
        const head = cells(line).map(inline);
        const align = cells(lines[i + 1]).map((s) =>
          s.startsWith(":") && s.endsWith(":") ? "center" : s.endsWith(":") ? "right" : "left",
        );
        const rows = [];
        i += 2;
        while (i < lines.length && lines[i].includes("|") && lines[i].trim()) rows.push(cells(lines[i++]).map(inline));
        blocks.push({ t: "table", head, align, rows });
        continue;
      }
      if (QUOTE.test(line)) {
        const body = [];
        while (i < lines.length && QUOTE.test(lines[i])) body.push(QUOTE.exec(lines[i++])[1]);
        blocks.push({ t: "quote", blocks: parse(body.join("\n")) });
        continue;
      }
      if (ITEM.test(line)) {
        const [list, next] = readList(lines, i);
        blocks.push(list);
        i = next;
        continue;
      }
      const para = [lines[i++].trim()];
      while (i < lines.length && lines[i].trim() && !startsBlock(lines, i)) para.push(lines[i++].trim());
      const c = inline(para.join("\n"));
      const card = soleLink(c);
      blocks.push(card ? { t: "cards", links: [card] } : { t: "p", c });
    }
    return blocks;
  }

  globalThis.moqiMarkdown = { parse };
})();
