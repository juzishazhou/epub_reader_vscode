import { escapeAttr, escapeHtml } from "./util";

export interface XmlElement {
  readonly kind: "element";
  /** Qualified name exactly as written, e.g. `opf:item`. */
  name: string;
  /** Lower-cased local name without prefix, e.g. `item`. */
  local: string;
  attrs: Record<string, string>;
  children: XmlNode[];
}

export interface XmlText {
  readonly kind: "text";
  value: string;
}

/** Verbatim content of a raw-text element such as `<style>` or `<script>`. */
export interface XmlRaw {
  readonly kind: "raw";
  value: string;
}

export type XmlNode = XmlElement | XmlText | XmlRaw;

const VOID_ELEMENTS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

const RAW_TEXT_ELEMENTS = new Set(["script", "style"]);

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: "\u00a0",
  shy: "\u00ad",
  copy: "\u00a9",
  reg: "\u00ae",
  trade: "\u2122",
  hellip: "\u2026",
  mdash: "\u2014",
  ndash: "\u2013",
  lsquo: "\u2018",
  rsquo: "\u2019",
  ldquo: "\u201c",
  rdquo: "\u201d",
  bull: "\u2022",
  middot: "\u00b7",
  laquo: "\u00ab",
  raquo: "\u00bb",
  times: "\u00d7",
  divide: "\u00f7",
  deg: "\u00b0",
  plusmn: "\u00b1",
  sect: "\u00a7",
  para: "\u00b6",
  dagger: "\u2020",
  permil: "\u2030",
  euro: "\u20ac",
  pound: "\u00a3",
  yen: "\u00a5",
  cent: "\u00a2",
  larr: "\u2190",
  rarr: "\u2192",
  harr: "\u2194",
  infin: "\u221e",
};

const ENTITY_RE = /&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);/g;

export function decodeEntities(text: string): string {
  if (text.indexOf("&") < 0) {
    return text;
  }
  return text.replace(ENTITY_RE, (match, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isFinite(code) ? safeFromCodePoint(code, match) : match;
    }
    if (body.startsWith("#")) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? safeFromCodePoint(code, match) : match;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match;
  });
}

function safeFromCodePoint(code: number, fallback: string): string {
  if (code <= 0 || code > 0x10ffff) {
    return fallback;
  }
  try {
    return String.fromCodePoint(code);
  } catch {
    return fallback;
  }
}

export function localName(name: string): string {
  const colon = name.indexOf(":");
  return colon < 0 ? name : name.slice(colon + 1);
}

export function createElement(name: string): XmlElement {
  return { kind: "element", name, local: localName(name).toLowerCase(), attrs: {}, children: [] };
}

export function isElement(node: XmlNode): node is XmlElement {
  return node.kind === "element";
}

export function isText(node: XmlNode): node is XmlText {
  return node.kind === "text";
}

/** Attribute lookup by local name, ignoring any namespace prefix. */
export function attr(node: XmlElement, name: string): string | undefined {
  const target = name.toLowerCase();
  for (const key of Object.keys(node.attrs)) {
    if (localName(key).toLowerCase() === target) {
      return node.attrs[key];
    }
  }
  return undefined;
}

/** Attribute key (qualified) that matches a local name. */
export function attrKey(node: XmlElement, name: string): string | undefined {
  const target = name.toLowerCase();
  for (const key of Object.keys(node.attrs)) {
    if (localName(key).toLowerCase() === target) {
      return key;
    }
  }
  return undefined;
}

/** Set an attribute by local name, replacing an existing prefixed variant. */
export function setAttr(node: XmlElement, name: string, value: string): void {
  const existing = attrKey(node, name);
  if (existing !== undefined) {
    node.attrs[existing] = value;
    return;
  }
  node.attrs[name] = value;
}

export function removeAttr(node: XmlElement, name: string): void {
  const existing = attrKey(node, name);
  if (existing !== undefined) {
    delete node.attrs[existing];
  }
}

export function elementChildren(node: XmlElement): XmlElement[] {
  return node.children.filter(isElement);
}

/** First direct child element with the given local name. */
export function child(node: XmlElement, name: string): XmlElement | undefined {
  const target = name.toLowerCase();
  for (const node2 of node.children) {
    if (isElement(node2) && node2.local === target) {
      return node2;
    }
  }
  return undefined;
}

export function children(node: XmlElement, name: string): XmlElement[] {
  const target = name.toLowerCase();
  return node.children.filter((n): n is XmlElement => isElement(n) && n.local === target);
}

/** Depth-first search for descendant elements with the given local name. */
export function descendants(node: XmlElement, name: string, out: XmlElement[] = []): XmlElement[] {
  const target = name.toLowerCase();
  for (const node2 of node.children) {
    if (!isElement(node2)) {
      continue;
    }
    if (target === "*" || node2.local === target) {
      out.push(node2);
    }
    descendants(node2, name, out);
  }
  return out;
}

/** First descendant (depth-first) with the given local name. */
export function firstDescendant(node: XmlElement, name: string): XmlElement | undefined {
  const target = name.toLowerCase();
  for (const node2 of node.children) {
    if (!isElement(node2)) {
      continue;
    }
    if (node2.local === target) {
      return node2;
    }
    const found = firstDescendant(node2, name);
    if (found) {
      return found;
    }
  }
  return undefined;
}

/** Concatenated text of a subtree, skipping raw-text elements. */
export function textContent(node: XmlNode): string {
  if (node.kind === "text") {
    return node.value;
  }
  if (node.kind === "raw") {
    return "";
  }
  let out = "";
  for (const childNode of node.children) {
    out += textContent(childNode);
  }
  return out;
}

/** Text of a direct child element, e.g. `<text>` inside `<navLabel>`. */
export function childText(node: XmlElement, name: string): string {
  const target = child(node, name);
  return target ? textContent(target).trim() : "";
}

export function isWhitespaceOnly(text: string): boolean {
  return text.trim().length === 0;
}

/**
 * A deliberately forgiving XML/HTML parser.
 *
 * EPUB content comes from a thousand different generators, so this parser is
 * lenient in the ways that matter: mismatched end tags unwind to the nearest
 * matching ancestor, bare `<` in text stays text, void HTML elements do not
 * swallow their siblings and unknown declarations are skipped. Namespaces are
 * preserved verbatim, because comparing on local names is what EPUB needs.
 */
export function parseXml(source: string): XmlElement {
  const root = createElement("#document");
  const stack: XmlElement[] = [root];
  const length = source.length;
  let i = 0;

  const top = (): XmlElement => stack[stack.length - 1];
  const pushText = (raw: string): void => {
    if (raw.length > 0) {
      top().children.push({ kind: "text", value: decodeEntities(raw) });
    }
  };
  const closeElement = (rawName: string): void => {
    const target = localName(rawName).toLowerCase();
    for (let k = stack.length - 1; k > 0; k--) {
      if (stack[k].local === target) {
        stack.length = k;
        return;
      }
    }
  };

  while (i < length) {
    const lt = source.indexOf("<", i);
    if (lt < 0) {
      pushText(source.slice(i));
      break;
    }
    if (lt > i) {
      pushText(source.slice(i, lt));
    }
    const next = source[lt + 1];
    if (next === undefined) {
      pushText("<");
      break;
    }

    if (next === "!") {
      if (source.startsWith("<!--", lt)) {
        const end = source.indexOf("-->", lt + 4);
        i = end < 0 ? length : end + 3;
      } else if (source.startsWith("<![CDATA[", lt)) {
        const end = source.indexOf("]]>", lt + 9);
        const value = source.slice(lt + 9, end < 0 ? length : end);
        top().children.push({ kind: "text", value });
        i = end < 0 ? length : end + 3;
      } else {
        let depth = 0;
        let j = lt + 2;
        for (; j < length; j++) {
          const c = source[j];
          if (c === "[") {
            depth++;
          } else if (c === "]") {
            depth--;
          } else if (c === ">" && depth <= 0) {
            break;
          }
        }
        i = j + 1;
      }
      continue;
    }

    if (next === "?") {
      const end = source.indexOf("?>", lt + 2);
      i = end < 0 ? length : end + 2;
      continue;
    }

    if (next === "/") {
      const end = source.indexOf(">", lt + 2);
      const raw = (end < 0 ? source.slice(lt + 2) : source.slice(lt + 2, end)).trim();
      closeElement(raw.split(/[\s>]/)[0] ?? raw);
      i = end < 0 ? length : end + 1;
      continue;
    }

    if (!/[A-Za-z_:]/.test(next)) {
      pushText("<");
      i = lt + 1;
      continue;
    }

    const end = findTagEnd(source, lt + 1);
    if (end < 0) {
      pushText(source.slice(lt));
      break;
    }
    const parsed = parseStartTag(source.slice(lt + 1, end));
    if (!parsed) {
      i = end + 1;
      continue;
    }
    const element = parsed.element;
    top().children.push(element);

    if (parsed.selfClosing || VOID_ELEMENTS.has(element.local)) {
      i = end + 1;
      continue;
    }

    if (RAW_TEXT_ELEMENTS.has(element.local)) {
      const closeRe = new RegExp(`</${escapeRegExp(element.name)}\\s*>`, "i");
      const rest = source.slice(end + 1);
      const match = closeRe.exec(rest);
      const value = match ? rest.slice(0, match.index) : rest;
      element.children.push({ kind: "raw", value });
      i = match ? end + 1 + match.index + match[0].length : length;
      continue;
    }

    stack.push(element);
    i = end + 1;
  }

  return root;
}

/** Index of the `>` that closes a tag starting at `from`, or -1. */
function findTagEnd(source: string, from: number): number {
  let quote = "";
  for (let i = from; i < source.length; i++) {
    const c = source[i];
    if (quote) {
      if (c === quote) {
        quote = "";
      }
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
    } else if (c === ">") {
      return i;
    }
  }
  return -1;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface ParsedStartTag {
  element: XmlElement;
  selfClosing: boolean;
}

function parseStartTag(raw: string): ParsedStartTag | undefined {
  const length = raw.length;
  let p = 0;
  const isWs = (c: string): boolean => c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f";

  while (p < length && isWs(raw[p])) {
    p++;
  }
  const nameStart = p;
  while (p < length && !isWs(raw[p]) && raw[p] !== "/") {
    p++;
  }
  const name = raw.slice(nameStart, p);
  if (name.length === 0) {
    return undefined;
  }
  const element = createElement(name);
  let selfClosing = false;

  while (p < length) {
    while (p < length && isWs(raw[p])) {
      p++;
    }
    if (p >= length) {
      break;
    }
    if (raw[p] === "/") {
      selfClosing = true;
      p++;
      continue;
    }
    const attrStart = p;
    while (p < length && !isWs(raw[p]) && raw[p] !== "=" && raw[p] !== "/") {
      p++;
    }
    const attrName = raw.slice(attrStart, p);
    while (p < length && isWs(raw[p])) {
      p++;
    }
    let value = "";
    if (raw[p] === "=") {
      p++;
      while (p < length && isWs(raw[p])) {
        p++;
      }
      const quote = raw[p];
      if (quote === '"' || quote === "'") {
        p++;
        const valueStart = p;
        while (p < length && raw[p] !== quote) {
          p++;
        }
        value = raw.slice(valueStart, p);
        p++;
      } else {
        const valueStart = p;
        while (p < length && !isWs(raw[p])) {
          p++;
        }
        value = raw.slice(valueStart, p);
      }
    }
    if (attrName.length > 0) {
      element.attrs[attrName] = decodeEntities(value);
    }
  }

  return { element, selfClosing };
}

const RAW_SERIALIZE_SKIP = new Set(["xmlns"]);

function serializeAttributes(node: XmlElement): string {
  let out = "";
  for (const key of Object.keys(node.attrs)) {
    const local = localName(key).toLowerCase();
    if (RAW_SERIALIZE_SKIP.has(local)) {
      continue;
    }
    const value = node.attrs[key];
    if (value === undefined) {
      continue;
    }
    out += ` ${key}="${escapeAttr(value)}"`;
  }
  return out;
}

export function serialize(node: XmlNode): string {
  if (node.kind === "text") {
    return escapeHtml(node.value);
  }
  if (node.kind === "raw") {
    return node.value;
  }
  const open = `<${node.name}${serializeAttributes(node)}>`;
  if (VOID_ELEMENTS.has(node.local)) {
    return open;
  }
  let out = open;
  for (const childNode of node.children) {
    out += serialize(childNode);
  }
  return `${out}</${node.name}>`;
}

export function serializeChildren(node: XmlElement): string {
  let out = "";
  for (const childNode of node.children) {
    out += serialize(childNode);
  }
  return out;
}
