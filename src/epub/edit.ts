import { EpubBook } from "./book";
import {
  XmlElement,
  findTagEnd,
  parseXml,
  serializeChildren,
} from "./xml";

/**
 * The write side of edit mode.
 *
 * Visual editing happens on the *rendered* chapter, which the reader pipeline
 * has transformed (asset URIs rewritten, insecure elements hidden, CSS
 * collected). To write those edits back without corrupting the book, the edit
 * render annotates every transformation with a `data-epub-orig-*` attribute
 * that carries the original value verbatim; this module reverses exactly those
 * annotations and splices the result into the chapter's original text,
 * replacing only the inside of `<body>`. The XML declaration, doctype, `<head>`
 * and every other file in the archive stay untouched.
 */

/** `data-epub-orig-X` → the attribute it restores. */
const ORIG_ATTR_PREFIX = "data-epub-orig-";

/** Elements the reader hides (but keeps) in edit mode so they round-trip. */
export const EPUB_KEEP_CLASS = "epub-keep";

const EDITABLE_EXTENSIONS = new Set([
  "css",
  "htm",
  "html",
  "js",
  "json",
  "ncx",
  "opf",
  "svg",
  "text",
  "txt",
  "xhtml",
  "xml",
]);

/** True for in-zip entries that are safe to edit as text. */
export function isEditableTextEntry(name: string): boolean {
  const lowered = name.toLowerCase();
  if (lowered === "mimetype" || lowered.startsWith("meta-inf/")) {
    // `mimetype` must stay stored and byte-exact; the container is not worth
    // the footgun.
    return false;
  }
  const dot = lowered.lastIndexOf(".");
  if (dot < 0) {
    return false;
  }
  return EDITABLE_EXTENSIONS.has(lowered.slice(dot + 1));
}

export interface EditableEntry {
  path: string;
  /** True when the entry is a spine chapter (visual editing is offered). */
  isChapter: boolean;
  /** Display label: toc title for chapters, file name for the rest. */
  label: string;
}

/** Every text file in the book that the edit panel may open. */
export function listEditableEntries(book: EpubBook): EditableEntry[] {
  const out: EditableEntry[] = [];
  for (const path of book.zip.names()) {
    if (!isEditableTextEntry(path)) {
      continue;
    }
    const chapterIndex = book.chapterIndexForPath(path);
    out.push({
      path,
      isChapter: chapterIndex !== undefined,
      label:
        chapterIndex !== undefined
          ? `${chapterIndex + 1}. ${book.chapters[chapterIndex].title || `第 ${chapterIndex + 1} 节`}`
          : path,
    });
  }
  return out;
}

/**
 * Reverse the edit-render annotations inside a serialized DOM tree:
 * `data-epub-orig-src="/images/x.png"` becomes `src`, the `epub-keep` marker
 * class is dropped again. Returns XHTML for the inside of a `<body>`.
 */
export function restoreEditedMarkup(html: string): string {
  const root = parseXml(html);
  visit(root);
  return serializeChildren(root, { xhtml: true, keepXmlns: true });
}

function visit(node: XmlElement): void {
  const keys = Object.keys(node.attrs);
  for (const key of keys) {
    if (key.startsWith(ORIG_ATTR_PREFIX)) {
      const target = key.slice(ORIG_ATTR_PREFIX.length);
      const value = node.attrs[key];
      delete node.attrs[key];
      if (target.length > 0 && value !== undefined) {
        // Overwrite whatever the display rewrite put there.
        node.attrs[target] = value;
      }
    }
  }
  const cls = node.attrs["class"];
  if (cls !== undefined) {
    const cleaned = cls
      .split(/\s+/)
      .filter((token) => token.length > 0 && token !== EPUB_KEEP_CLASS)
      .join(" ");
    if (cleaned.length > 0) {
      node.attrs["class"] = cleaned;
    } else {
      delete node.attrs["class"];
    }
  }
  for (const child of node.children) {
    if (child.kind === "element") {
      visit(child);
    }
  }
}

/**
 * Replace the inside of `<body>…</body>` in `original` with `newInnerHtml`,
 * keeping everything before and after — declaration, doctype, `<head>`, body
 * attributes — byte-for-byte.
 */
export function spliceBody(original: string, newInnerHtml: string): string {
  const bodyStart = original.search(/<body[\s>]/i);
  if (bodyStart < 0) {
    throw new Error("原文档中没有 <body> 标签，无法回写正文。");
  }
  const openEnd = findTagEnd(original, bodyStart + 1);
  if (openEnd < 0) {
    throw new Error("原文档的 <body> 标签不完整，无法回写正文。");
  }
  const contentStart = openEnd + 1;
  const closeRel = original.slice(contentStart).search(/<\/body\b/i);
  const contentEnd = closeRel >= 0 ? contentStart + closeRel : original.length;
  return original.slice(0, contentStart) + newInnerHtml + original.slice(contentEnd);
}

/** True when the file's XML declaration names a non-UTF-8 encoding. */
function declaresNonUtf8(text: string): boolean {
  const head = text.slice(0, Math.min(text.length, 512));
  const match = /<\?xml[^>]*?encoding\s*=\s*(["'])(.*?)\1/i.exec(head);
  if (!match) {
    return false;
  }
  const encoding = match[2].toLowerCase().replace(/[\s-]/g, "");
  return encoding !== "utf8";
}

/**
 * Prepare an edited file for writing back as UTF-8: keep the original file's
 * dominant line ending style and, when the declaration promised something
 * else, retarget it to UTF-8 so the bytes and the declaration agree.
 */
export function normalizeWrittenText(previous: string, next: string): string {
  let out = next;
  if (/\r\n/.test(previous)) {
    out = out.replace(/\r?\n/g, "\r\n");
  } else {
    out = out.replace(/\r\n/g, "\n");
  }
  if (declaresNonUtf8(previous)) {
    // Rewrite the declaration's encoding token only.
    out = out.replace(
      /(<\?xml[^>]*?encoding\s*=\s*)(["'])[^"']*\2/i,
      (_all, before: string, quote: string) => `${before}${quote}utf-8${quote}`,
    );
  }
  return out;
}
