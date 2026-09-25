import { EpubBook } from "./book";
import {
  attr,
  createElement,
  firstDescendant,
  isElement,
  localName,
  parseXml,
  removeAttr,
  serializeChildren,
  setAttr,
  textContent,
  XmlElement,
  XmlNode,
  XmlRaw,
} from "./xml";
import { dirname, resolveRelative, splitHref } from "./util";

/** Elements that never make sense (or are unsafe) inside the reading surface. */
const DROP_ELEMENTS = new Set([
  "applet",
  "audio",
  "base",
  "button",
  "canvas",
  "embed",
  "form",
  "frame",
  "frameset",
  "head",
  "iframe",
  "input",
  "meta",
  "noscript",
  "object",
  "param",
  "script",
  "select",
  "source",
  "template",
  "textarea",
  "title",
  "track",
  "video",
]);

const URL_RE = /url\(\s*(?:'([^']*)'|"([^"]*)"|([^)'"]*))\s*\)/gi;
const IMPORT_RE = /@import\s+(?:url\(\s*(?:'([^']*)'|"([^"]*)"|([^)'"]*))\s*\)|'([^']*)'|"([^"]*)")\s*([^;]*);/gi;

const MAX_CSS_DEPTH = 5;

export interface ChapterHighlight {
  query: string;
  /** 1-based index of the occurrence to mark. */
  occurrence: number;
}

export interface RenderedChapter {
  index: number;
  title: string;
  /** Sanitized chapter markup, ready to be placed inside the reading iframe. */
  body: string;
  /** EPUB stylesheets, inlined and with every `url()` rewritten. */
  css: string[];
  /** Plain text of the chapter, identical to what the search index sees. */
  text: string;
  /** In-zip paths of every asset the markup references. */
  assets: string[];
  /** True when a requested highlight was actually placed. */
  highlightFound: boolean;
}

export interface RenderChapterOptions {
  /** Absolute webview URI for an in-zip asset; `undefined` drops the reference. */
  uriFor: (path: string) => string | undefined;
  /** Canonical spine path for a target, when it is a readable chapter. */
  resolveChapterPath: (path: string) => string | undefined;
  readText: (path: string) => string | undefined;
  highlight?: ChapterHighlight;
}

interface WalkOptions {
  baseDir: string;
  readText: (path: string) => string | undefined;
  resolveChapterPath: (path: string) => string | undefined;
  onAsset?: (path: string) => void;
  uri?: (path: string) => string | undefined;
  css?: string[];
  skipCss?: boolean;
}

/** Turn one spine document into a safe, self-contained reading payload. */
export function renderChapter(
  book: EpubBook,
  index: number,
  options: RenderChapterOptions,
): RenderedChapter {
  const chapter = book.chapters[index];
  if (!chapter) {
    throw new Error(`章节序号越界：${index}`);
  }
  const root = parseXml(book.zip.readText(chapter.path));
  const bodyElement = firstDescendant(root, "body");
  const body = bodyElement ?? root;
  const css: string[] = [];
  const assets = new Set<string>();
  const walkOptions: WalkOptions = {
    baseDir: dirname(chapter.path),
    readText: options.readText,
    resolveChapterPath: options.resolveChapterPath,
    onAsset: (path) => assets.add(path),
    uri: options.uriFor,
    css,
  };

  // Stylesheets normally live in the head, which is not part of the body walk.
  if (bodyElement) {
    const head = firstDescendant(root, "head");
    if (head) {
      collectHeadStyles(head, walkOptions);
    }
  }
  transformChildren(body, walkOptions);

  let highlightFound = false;
  if (options.highlight && options.highlight.query.length > 0) {
    highlightFound = applyHighlight(body, options.highlight);
  }

  return {
    index,
    title: chapter.title || deriveTitle(body) || `第 ${index + 1} 节`,
    body: serializeChildren(body),
    css,
    text: textContent(body),
    assets: Array.from(assets),
    highlightFound,
  };
}

/**
 * Plain text of a chapter, produced by the same transformation the renderer
 * uses, so search offsets always line up with the reading surface.
 */
export function chapterText(book: EpubBook, index: number): string {
  const chapter = book.chapters[index];
  if (!chapter) {
    return "";
  }
  const root = parseXml(book.zip.readText(chapter.path));
  const body = resolveBody(root);
  transformChildren(body, {
    baseDir: dirname(chapter.path),
    readText: () => undefined,
    resolveChapterPath: () => undefined,
    skipCss: true,
  });
  return textContent(body).replace(/\u00a0/g, " ");
}

function resolveBody(root: XmlElement): XmlElement {
  return firstDescendant(root, "body") ?? root;
}

/**
 * Pull `<link rel="stylesheet">` and `<style>` out of the document head. The
 * body walk never reaches the head, so this runs separately for full documents.
 */
function collectHeadStyles(head: XmlElement, options: WalkOptions): void {
  for (const node of head.children) {
    if (!isElement(node)) {
      continue;
    }
    if (node.local === "style") {
      if (!options.skipCss) {
        const cssText = rawTextOf(node);
        if (cssText.trim().length > 0) {
          const processed = processCss(cssText, options.baseDir, options, 0);
          if (options.css) {
            options.css.push(processed);
          }
        }
      }
      continue;
    }
    if (node.local === "link") {
      if (!options.skipCss) {
        const rel = (attr(node, "rel") ?? "").toLowerCase().split(/\s+/);
        const href = attr(node, "href");
        if (href && rel.includes("stylesheet")) {
          const target = resolveTarget(href, options.baseDir);
          const text = target ? options.readText(target) : undefined;
          if (target && text !== undefined) {
            options.onAsset?.(target);
            const processed = processCss(text, dirname(target), options, 0);
            if (options.css) {
              options.css.push(processed);
            }
          }
        }
      }
      continue;
    }
    collectHeadStyles(node, options);
  }
}

function deriveTitle(body: XmlElement): string {
  for (const name of ["h1", "h2", "h3"]) {
    const heading = firstDescendant(body, name);
    if (heading) {
      const text = textContent(heading).replace(/\s+/g, " ").trim();
      if (text.length > 0) {
        return text.length > 80 ? `${text.slice(0, 80)}…` : text;
      }
    }
  }
  return "";
}

function transformChildren(parent: XmlElement, options: WalkOptions): void {
  const out: XmlNode[] = [];
  for (const node of parent.children) {
    if (!isElement(node)) {
      out.push(node);
      continue;
    }
    const local = node.local;

    if (local === "style") {
      if (!options.skipCss) {
        const cssText = rawTextOf(node);
        if (cssText.trim().length > 0) {
          const processed = processCss(cssText, options.baseDir, options, 0);
          if (options.css) {
            options.css.push(processed);
          }
        }
      }
      continue;
    }

    if (local === "link") {
      if (!options.skipCss) {
        const rel = (attr(node, "rel") ?? "").toLowerCase().split(/\s+/);
        const href = attr(node, "href");
        if (href && rel.includes("stylesheet")) {
          const target = resolveTarget(href, options.baseDir);
          const text = target ? options.readText(target) : undefined;
          if (target && text !== undefined) {
            options.onAsset?.(target);
            const processed = processCss(text, dirname(target), options, 0);
            if (options.css) {
              options.css.push(processed);
            }
          }
        }
      }
      continue;
    }

    if (DROP_ELEMENTS.has(local)) {
      continue;
    }

    transformAttributes(node, options);
    transformChildren(node, options);
    out.push(node);
  }
  parent.children = out;
}

function rawTextOf(node: XmlElement): string {
  return node.children
    .filter((childNode): childNode is XmlRaw => childNode.kind === "raw")
    .map((childNode) => childNode.value)
    .join("");
}

function transformAttributes(node: XmlElement, options: WalkOptions): void {
  for (const key of Object.keys(node.attrs)) {
    const local = localName(key).toLowerCase();
    const value = node.attrs[key] ?? "";
    if (local.startsWith("on") || /^\s*(javascript|vbscript):/i.test(value)) {
      delete node.attrs[key];
    }
  }

  switch (node.local) {
    case "img":
      rewriteAssetAttribute(node, "src", options);
      removeAttr(node, "srcset");
      removeAttr(node, "longdesc");
      break;
    case "image":
    case "use":
      rewriteAssetAttribute(node, "href", options);
      break;
    case "source":
      rewriteAssetAttribute(node, "src", options);
      break;
    case "a":
    case "area":
      rewriteAnchor(node, options);
      break;
    default:
      break;
  }

  const background = attr(node, "background");
  if (background) {
    rewriteAssetAttribute(node, "background", options);
  }

  const inlineStyle = attr(node, "style");
  if (inlineStyle && !options.skipCss) {
    setAttr(node, "style", processCss(inlineStyle, options.baseDir, options, 0));
  }
}

function rewriteAssetAttribute(node: XmlElement, name: string, options: WalkOptions): void {
  const value = attr(node, name);
  if (!value) {
    return;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(trimmed)) {
    return;
  }
  const target = resolveTarget(trimmed, options.baseDir);
  if (!target) {
    return;
  }
  options.onAsset?.(target);
  if (options.uri) {
    const uri = options.uri(target);
    if (uri) {
      setAttr(node, name, uri);
    } else {
      removeAttr(node, name);
    }
  }
}

function rewriteAnchor(node: XmlElement, options: WalkOptions): void {
  removeAttr(node, "target");
  removeAttr(node, "download");
  removeAttr(node, "rel");
  const href = attr(node, "href");
  if (!href) {
    return;
  }
  const trimmed = href.trim();

  if (trimmed.startsWith("#")) {
    if (options.uri) {
      setAttr(node, "href", "#");
      setAttr(node, "data-epub-fragment", trimmed.slice(1));
    }
    return;
  }

  if (/^(https?|mailto):/i.test(trimmed)) {
    if (options.uri) {
      setAttr(node, "href", "#");
      setAttr(node, "data-epub-external", trimmed);
      if (!attr(node, "title")) {
        setAttr(node, "title", trimmed);
      }
    }
    return;
  }

  const { path, fragment } = splitHref(trimmed);
  if (path.trim().length === 0) {
    return;
  }
  const target = resolveTarget(path, options.baseDir);
  if (!target) {
    return;
  }
  const chapterPath = options.resolveChapterPath(target);
  if (chapterPath && options.uri) {
    setAttr(node, "href", "#");
    setAttr(node, "data-epub-chapter", chapterPath);
    if (fragment) {
      setAttr(node, "data-epub-fragment", fragment);
    }
    return;
  }
  if (options.uri) {
    // Points at something that is not a readable spine document: keep it inert.
    setAttr(node, "href", "#");
  }
}

/** Resolve a relative reference to a normalized in-zip path. */
function resolveTarget(reference: string, baseDir: string): string | undefined {
  const { path } = splitHref(reference.trim());
  if (path.length === 0) {
    return undefined;
  }
  const decoded = path
    .split("/")
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    })
    .join("/");
  const resolved = resolveRelative(baseDir, decoded);
  return resolved.length === 0 ? undefined : resolved;
}

/**
 * Inline `@import` chains and rewrite every `url()` exactly once.
 *
 * Imports are expanded segment by segment: each segment's `url()` values are
 * resolved against the directory of the sheet they came from, and imported
 * sheets recurse at their own depth. Rewriting after inlining would resolve
 * already-rewritten urls a second time, which is why the two passes are
 * interleaved rather than sequential. Media queries on `@import` are dropped.
 */
function processCss(cssText: string, cssDir: string, options: WalkOptions, depth: number): string {
  if (cssText.indexOf("url(") < 0 && cssText.indexOf("@import") < 0) {
    return cssText;
  }
  if (depth >= MAX_CSS_DEPTH) {
    const withoutImports = cssText.replace(new RegExp(IMPORT_RE.source, "gi"), "");
    return sanitizeStyleText(rewriteCssUrls(withoutImports, cssDir, options));
  }

  const importRe = new RegExp(IMPORT_RE.source, "gi");
  let out = "";
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = importRe.exec(cssText)) !== null) {
    out += rewriteCssUrls(cssText.slice(lastIndex, match.index), cssDir, options);
    lastIndex = match.index + match[0].length;

    const reference = (match[1] ?? match[2] ?? match[3] ?? match[4] ?? match[5] ?? "").trim();
    if (reference.length === 0 || /^[a-z][a-z0-9+.-]*:/i.test(reference)) {
      continue;
    }
    const target = resolveTarget(reference, cssDir);
    if (!target) {
      continue;
    }
    options.onAsset?.(target);
    const imported = options.readText(target);
    if (imported !== undefined) {
      out += processCss(imported, dirname(target), options, depth + 1);
    }
  }

  out += rewriteCssUrls(cssText.slice(lastIndex), cssDir, options);
  return sanitizeStyleText(out);
}

function rewriteCssUrls(cssText: string, cssDir: string, options: WalkOptions): string {
  if (cssText.indexOf("url(") < 0) {
    return cssText;
  }
  const urlRe = new RegExp(URL_RE.source, "gi");
  return cssText.replace(urlRe, (match, g1, g2, g3) => {
    const reference = (g1 ?? g2 ?? g3 ?? "").trim();
    if (
      reference.length === 0 ||
      reference.startsWith("#") ||
      /^[a-z][a-z0-9+.-]*:/i.test(reference)
    ) {
      return match;
    }
    const target = resolveTarget(reference, cssDir);
    if (!target) {
      return match;
    }
    options.onAsset?.(target);
    if (!options.uri) {
      return match;
    }
    const uri = options.uri(target);
    return uri ? `url("${uri}")` : match;
  });
}

/** Keep CSS from breaking out of the `<style>` element it is injected into. */
function sanitizeStyleText(cssText: string): string {
  return cssText.replace(/<\/(style)/gi, "<\\/$1");
}

/**
 * Wrap the `occurrence`-th match of `query` in a `<mark>` so the reader can
 * scroll to it. Uses the same non-overlapping counting as the search index.
 */
export function applyHighlight(body: XmlElement, highlight: ChapterHighlight): boolean {
  const needle = highlight.query;
  if (needle.length === 0 || highlight.occurrence < 1) {
    return false;
  }
  const lowerNeedle = needle.toLowerCase();
  let seen = 0;
  let marked = false;

  const visit = (parent: XmlElement): void => {
    const nextChildren: XmlNode[] = [];
    for (const node of parent.children) {
      if (marked) {
        nextChildren.push(node);
        continue;
      }
      if (node.kind === "text") {
        const haystack = node.value.toLowerCase();
        let from = 0;
        let lastIndex = 0;
        const parts: XmlNode[] = [];
        while (from <= haystack.length - lowerNeedle.length) {
          const at = haystack.indexOf(lowerNeedle, from);
          if (at < 0) {
            break;
          }
          seen++;
          if (seen === highlight.occurrence) {
            if (at > lastIndex) {
              parts.push({ kind: "text", value: node.value.slice(lastIndex, at) });
            }
            const mark = createElement("mark");
            mark.attrs["class"] = "reader-hit";
            mark.children.push({ kind: "text", value: node.value.slice(at, at + needle.length) });
            parts.push(mark);
            lastIndex = at + needle.length;
            marked = true;
            break;
          }
          from = at + needle.length;
        }
        if (parts.length > 0) {
          const tail = node.value.slice(lastIndex);
          if (tail.length > 0) {
            parts.push({ kind: "text", value: tail });
          }
          nextChildren.push(...parts);
        } else {
          nextChildren.push(node);
        }
        continue;
      }
      if (node.kind === "element") {
        visit(node);
        nextChildren.push(node);
        continue;
      }
      nextChildren.push(node);
    }
    parent.children = nextChildren;
  };

  visit(body);
  return marked;
}
