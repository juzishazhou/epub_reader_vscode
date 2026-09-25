import * as crypto from "node:crypto";

/** Stable sha1 hex digest of a buffer or string. */
export function sha1(input: Buffer | string): string {
  return crypto.createHash("sha1").update(input).digest("hex");
}

/** Normalize an in-zip path: forward slashes, no leading `./` or `/`. */
export function normalizeZipPath(path: string): string {
  let p = path.replace(/\\/g, "/");
  while (p.startsWith("./")) {
    p = p.slice(2);
  }
  while (p.startsWith("/")) {
    p = p.slice(1);
  }
  return p;
}

/** Directory part of an in-zip path ("" for a top level entry). */
export function dirname(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

/** Resolve `relative` against `baseDir`, collapsing `.` and `..` segments. */
export function resolveRelative(baseDir: string, relative: string): string {
  const raw = relative.replace(/\\/g, "/");
  const segments = raw.startsWith("/") ? [] : baseDir.split("/").filter((s) => s.length > 0);
  for (const segment of raw.split("/")) {
    if (segment === "" || segment === ".") {
      continue;
    }
    if (segment === "..") {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.join("/");
}

/** Split `path#fragment?query` into its path and fragment parts. */
export function splitHref(href: string): { path: string; fragment?: string } {
  const hash = href.indexOf("#");
  const head = hash < 0 ? href : href.slice(0, hash);
  const fragment = hash < 0 ? undefined : href.slice(hash + 1);
  const query = head.indexOf("?");
  const path = query < 0 ? head : head.slice(0, query);
  return { path, fragment: fragment && fragment.length > 0 ? fragment : undefined };
}

/** Percent-decode a single href fragment, tolerating malformed escapes. */
export function decodeHref(href: string): string {
  try {
    return decodeURIComponent(href);
  } catch {
    return href;
  }
}

/** Decode an href into a normalized in-zip path (no fragment, no query). */
export function decodePath(href: string): string {
  return normalizeZipPath(href.split("/").map(decodeHref).join("/"));
}

const ILLEGAL_SEGMENT_CHARS = /[<>:"|?*\u0000-\u001f]/g;

/** Make a path segment safe for the local file system (Windows included). */
export function sanitizeSegment(segment: string): string {
  const cleaned = segment.replace(ILLEGAL_SEGMENT_CHARS, "_").replace(/[. ]+$/, "");
  return cleaned.length === 0 ? "_" : cleaned;
}

/** Sanitize each segment of an in-zip path for use as a relative file path. */
export function sanitizeZipPath(path: string): string {
  return normalizeZipPath(path)
    .split("/")
    .filter((s) => s.length > 0)
    .map(sanitizeSegment)
    .join("/");
}

export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function escapeAttr(text: string): string {
  return escapeHtml(text).replace(/"/g, "&quot;");
}

const ENCODING_ALIASES: Record<string, string> = {
  "utf8": "utf-8",
  "utf-8": "utf-8",
  "utf 8": "utf-8",
  "ascii": "utf-8",
  "us-ascii": "utf-8",
  "unicode-1-1-utf-8": "utf-8",
  "gb2312": "gbk",
  "gbk": "gbk",
  "gb18030": "gb18030",
  "big5": "big5",
  "big-5": "big5",
  "utf-16": "utf-16le",
  "utf16": "utf-16le",
  "utf-16le": "utf-16le",
  "utf-16be": "utf-16be",
  "ucs-2": "utf-16le",
  "iso-8859-1": "windows-1252",
  "latin1": "windows-1252",
  "latin-1": "windows-1252",
  "windows-1252": "windows-1252",
  "shift_jis": "shift_jis",
  "shift-jis": "shift_jis",
  "sjis": "shift_jis",
  "euc-jp": "euc-jp",
  "euc-kr": "euc-kr",
  "koi8-r": "koi8-r",
  "windows-1251": "windows-1251",
};

function sniffDeclaredEncoding(head: Buffer): string | undefined {
  const ascii = head.toString("latin1");
  const match = /encoding\s*=\s*["']([\w.:-]+)["']/i.exec(ascii);
  if (!match) {
    return undefined;
  }
  return ENCODING_ALIASES[match[1].toLowerCase()] ?? match[1].toLowerCase();
}

/**
 * Decode text content honouring BOM and the `encoding="..."` XML declaration.
 * EPUB files in the wild are mostly UTF-8, but Chinese epubs sometimes ship GBK.
 */
export function decodeText(buffer: Buffer): string {
  if (buffer.length === 0) {
    return "";
  }
  if (buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return stripBom(buffer.toString("utf8"));
  }
  if (buffer[0] === 0xff && buffer[1] === 0xfe) {
    return stripBom(decodeWith("utf-16le", buffer) ?? buffer.toString("utf8"));
  }
  if (buffer[0] === 0xfe && buffer[1] === 0xff) {
    return stripBom(decodeWith("utf-16be", buffer) ?? buffer.toString("utf8"));
  }
  const declared = sniffDeclaredEncoding(buffer.subarray(0, Math.min(buffer.length, 512)));
  if (declared && declared !== "utf-8") {
    const decoded = decodeWith(declared, buffer);
    if (decoded !== undefined) {
      return stripBom(decoded);
    }
  }
  return stripBom(buffer.toString("utf8"));
}

function decodeWith(label: string, buffer: Buffer): string | undefined {
  try {
    return new TextDecoder(label, { fatal: false }).decode(buffer);
  } catch {
    return undefined;
  }
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** True for relative hrefs that stay inside the book (no scheme, no `//`). */
export function isExternalHref(href: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//");
}

/**
 * Non-overlapping occurrences of `needle` in `haystack`.
 * Highlighting and search share this so the occurrence indexes agree.
 */
export function findOccurrences(haystack: string, needle: string, caseSensitive = false): number[] {
  if (needle.length === 0 || haystack.length === 0) {
    return [];
  }
  const text = caseSensitive ? haystack : haystack.toLowerCase();
  const query = caseSensitive ? needle : needle.toLowerCase();
  const out: number[] = [];
  let from = 0;
  while (from <= text.length - query.length) {
    const at = text.indexOf(query, from);
    if (at < 0) {
      break;
    }
    out.push(at);
    from = at + query.length;
  }
  return out;
}

/** Collapse runs of whitespace and trim, for one-line snippets. */
export function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Clamp `value` into the inclusive `[min, max]` range. */
export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, value));
}
