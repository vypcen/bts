// Минимальный разбор XML для импорта из других TMS (TestRail, TestLink): элементы, атрибуты, текст, CDATA, сущности.
// DTD и внешние сущности не обрабатываются вовсе — XXE невозможна. Пространства имён остаются частью имени.
const ENT = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };
const decode = (s) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) =>
    e[0] === "#" ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENT[e] ?? m
  );

// → {name, attrs, children: [узлы], text}; text — весь непосредственный текст элемента
function parse(xml) {
  const root = { name: "#root", attrs: {}, children: [], text: "" };
  const stack = [root];
  const re = /<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*(?:\[[\s\S]*?\])?\s*>|<\/\s*([\w:.-]+)\s*>|<([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/gi;
  let m;
  while ((m = re.exec(xml))) {
    const top = stack[stack.length - 1];
    if (m[1] !== undefined) top.text += m[1];
    else if (m[2]) {
      if (stack.length > 1 && top.name === m[2]) stack.pop();
    } else if (m[3]) {
      const attrs = {};
      for (const a of m[4].matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[a[1]] = decode(a[2] ?? a[3]);
      const node = { name: m[3], attrs, children: [], text: "" };
      top.children.push(node);
      if (!m[5]) stack.push(node);
    } else if (m[6] !== undefined) top.text += decode(m[6]);
  }
  return root;
}

const child = (n, name) => n?.children.find((c) => c.name === name);
const children = (n, name) => (n ? n.children.filter((c) => c.name === name) : []);
const text = (n, name) => (name ? child(n, name) : n)?.text.trim() ?? "";

// HTML из полей TMS (TestLink, TestRail) → обычный текст с переносами строк
function htmlToText(s) {
  return decode(
    String(s || "")
      .replace(/<\s*br\s*\/?>/gi, "\n")
      .replace(/<\s*\/(p|div|li|tr|h\d)\s*>/gi, "\n")
      .replace(/<\s*li[^>]*>/gi, "• ")
      .replace(/<[^>]+>/g, "")
  )
    .replace(/ /g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

module.exports = { parse, child, children, text, htmlToText, decode };
