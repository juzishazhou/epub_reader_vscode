import { ZipArchive } from "./zip";
import {
  attr,
  child,
  children,
  descendants,
  firstDescendant,
  parseXml,
  textContent,
  XmlElement,
} from "./xml";
import { decodeHref, dirname, resolveRelative, splitHref } from "./util";

export interface EpubMetadata {
  title: string;
  creator?: string;
  publisher?: string;
  language?: string;
  identifier?: string;
  description?: string;
  rights?: string;
  date?: string;
  /** In-zip path of the cover image, when one can be found. */
  coverPath?: string;
}

/** One entry of the OPF manifest. */
export interface ManifestItem {
  id: string;
  /** In-zip path, resolved against the OPF directory. */
  path: string;
  mediaType: string;
  properties: string;
}

export interface EpubChapter {
  index: number;
  id: string;
  /** In-zip path of the chapter document. */
  path: string;
  /** Title taken from the table of contents when available. */
  title: string;
}

export interface TocEntry {
  label: string;
  /** Target in-zip path, when the entry points at a document. */
  path?: string;
  fragment?: string;
  level: number;
  children: TocEntry[];
  /** Spine index of the target, filled in once the spine is known. */
  chapterIndex?: number;
}

interface ManifestEntryInternal extends ManifestItem {
  rawHref: string;
}

const CHAPTER_MEDIA_HINTS = ["html", "xml"];

/**
 * A parsed EPUB publication: metadata, spine order, table of contents and the
 * underlying archive, with helpers to map between toc targets and chapters.
 */
export class EpubBook {
  private readonly pathIndex = new Map<string, number>();

  constructor(
    readonly zip: ZipArchive,
    readonly opfPath: string,
    readonly opfDir: string,
    readonly metadata: EpubMetadata,
    readonly chapters: EpubChapter[],
    readonly toc: TocEntry[],
    readonly manifest: ManifestItem[],
    readonly spinePaths: ReadonlySet<string>,
  ) {
    this.chapters.forEach((chapter, index) => {
      this.pathIndex.set(chapter.path.toLowerCase(), index);
      const real = zip.realName(chapter.path);
      if (real) {
        this.pathIndex.set(real.toLowerCase(), index);
      }
    });
  }

  /** Look up a spine chapter by its in-zip path; tolerates case differences. */
  chapterIndexForPath(path: string): number | undefined {
    const direct = this.pathIndex.get(path.toLowerCase());
    if (direct !== undefined) {
      return direct;
    }
    const real = this.zip.realName(path);
    if (real) {
      return this.pathIndex.get(real.toLowerCase());
    }
    return undefined;
  }

  /** Manifest entry for an in-zip path, when the OPF declares one. */
  manifestForPath(path: string): ManifestItem | undefined {
    const lowered = path.toLowerCase();
    for (const item of this.manifest) {
      if (item.path.toLowerCase() === lowered) {
        return item;
      }
    }
    return undefined;
  }

  /** Media type of an in-zip asset, guessed from the manifest or extension. */
  mediaTypeForPath(path: string): string {
    const declared = this.manifestForPath(path)?.mediaType;
    if (declared) {
      return declared;
    }
    const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
    return GUESSED_MEDIA_TYPES[ext] ?? "application/octet-stream";
  }

  /** Depth-first flattening of the table of contents. */
  flattenToc(entries: TocEntry[] = this.toc, out: TocEntry[] = []): TocEntry[] {
    for (const entry of entries) {
      out.push(entry);
      this.flattenToc(entry.children, out);
    }
    return out;
  }
}

const GUESSED_MEDIA_TYPES: Record<string, string> = {
  css: "text/css",
  gif: "image/gif",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  js: "text/javascript",
  otf: "font/otf",
  png: "image/png",
  svg: "image/svg+xml",
  ttf: "font/ttf",
  webp: "image/webp",
  woff: "font/woff",
  woff2: "font/woff2",
  xhtml: "application/xhtml+xml",
  html: "application/xhtml+xml",
};

/** Parse an EPUB file from its raw bytes. */
export function openEpub(data: Buffer, fallbackTitle = "未命名书籍"): EpubBook {
  const zip = ZipArchive.open(data);
  const opfPath = findOpfPath(zip);
  if (!opfPath) {
    throw new Error("没有在 META-INF/container.xml 中找到 OPF 包文件。");
  }
  const opfDir = dirname(opfPath);
  const opfRoot = parseXml(zip.readText(opfPath));
  const packageEl = firstDescendant(opfRoot, "package") ?? opfRoot;

  const manifest = readManifest(packageEl, opfDir);
  const manifestById = new Map(manifest.map((item) => [item.id, item]));
  const chapters = readSpine(packageEl, manifestById);
  if (chapters.length === 0) {
    throw new Error("EPUB 的 spine 中没有任何可阅读的章节。");
  }

  const toc = readToc(packageEl, opfDir, zip, manifestById, chapters);
  applyTocTitles(chapters, toc);
  const metadata = readMetadata(packageEl, fallbackTitle, manifest, zip, opfDir);

  const spinePaths = new Set(chapters.map((chapter) => chapter.path));
  return new EpubBook(zip, opfPath, opfDir, metadata, chapters, toc, manifest, spinePaths);
}

function findOpfPath(zip: ZipArchive): string | undefined {
  const container = zip.tryReadText("META-INF/container.xml");
  if (container) {
    const root = parseXml(container);
    for (const rootfile of descendants(root, "rootfile")) {
      const fullPath = attr(rootfile, "full-path");
      if (fullPath && fullPath.trim().length > 0) {
        const candidate = decodeHref(fullPath.trim());
        if (zip.has(candidate)) {
          return candidate;
        }
      }
    }
  }
  const opfFiles = zip.names().filter((name) => name.toLowerCase().endsWith(".opf"));
  if (opfFiles.length > 0) {
    return opfFiles.sort((a, b) => a.length - b.length)[0];
  }
  return undefined;
}

function readManifest(packageEl: XmlElement, opfDir: string): ManifestEntryInternal[] {
  const manifestEl = child(packageEl, "manifest");
  if (!manifestEl) {
    return [];
  }
  const out: ManifestEntryInternal[] = [];
  for (const item of children(manifestEl, "item")) {
    const id = attr(item, "id");
    const rawHref = attr(item, "href");
    if (!id || !rawHref) {
      continue;
    }
    const target = splitHref(rawHref).path;
    const decoded = target
      .split("/")
      .map(decodeHref)
      .join("/");
    out.push({
      id,
      rawHref,
      path: resolveRelative(opfDir, decoded),
      mediaType: (attr(item, "media-type") ?? "").trim(),
      properties: (attr(item, "properties") ?? "").trim(),
    });
  }
  return out;
}

function readSpine(packageEl: XmlElement, manifestById: Map<string, ManifestEntryInternal>): EpubChapter[] {
  const spineEl = child(packageEl, "spine");
  if (!spineEl) {
    return [];
  }
  const chapters: EpubChapter[] = [];
  for (const itemref of children(spineEl, "itemref")) {
    const idref = attr(itemref, "idref");
    if (!idref) {
      continue;
    }
    const item = manifestById.get(idref);
    if (!item) {
      continue;
    }
    const mediaType = item.mediaType.toLowerCase();
    const looksLikeDocument =
      mediaType.length === 0 || CHAPTER_MEDIA_HINTS.some((hint) => mediaType.includes(hint));
    if (!looksLikeDocument) {
      continue;
    }
    chapters.push({
      index: chapters.length,
      id: item.id,
      path: item.path,
      title: "",
    });
  }
  return chapters;
}

function readToc(
  packageEl: XmlElement,
  opfDir: string,
  zip: ZipArchive,
  manifestById: Map<string, ManifestEntryInternal>,
  chapters: EpubChapter[],
): TocEntry[] {
  const spineEl = child(packageEl, "spine");
  const ncxId = spineEl ? attr(spineEl, "toc") : undefined;
  if (ncxId) {
    const ncxItem = manifestById.get(ncxId);
    const text = ncxItem ? zip.tryReadText(ncxItem.path) : undefined;
    if (text) {
      const entries = parseNcxToc(text, opfDir);
      if (entries.length > 0) {
        return entries;
      }
    }
  }

  const navItem = Array.from(manifestById.values()).find((item) =>
    item.properties.split(/\s+/).includes("nav"),
  );
  const navText = navItem ? zip.tryReadText(navItem.path) : undefined;
  if (navText) {
    const entries = parseNavToc(navText, opfDir, dirname(navItem!.path));
    if (entries.length > 0) {
      return entries;
    }
  }

  // No navigation document at all: fall back to the spine so the drawer is usable.
  return chapters.map((chapter, index) => ({
    label: chapter.title || `第 ${index + 1} 节`,
    path: chapter.path,
    level: 1,
    children: [],
  }));
}

function resolveTocTarget(src: string, baseDir: string): { path: string; fragment?: string } {
  const { path, fragment } = splitHref(src);
  if (path.trim().length === 0) {
    return { path: "", fragment };
  }
  const decoded = path
    .split("/")
    .map(decodeHref)
    .join("/");
  return { path: resolveRelative(baseDir, decoded), fragment };
}

function parseNcxToc(text: string, opfDir: string): TocEntry[] {
  const root = parseXml(text);
  const navMap = firstDescendant(root, "navMap");
  if (!navMap) {
    return [];
  }
  const parsePoints = (parent: XmlElement, level: number): TocEntry[] => {
    const out: TocEntry[] = [];
    for (const navPoint of children(parent, "navPoint")) {
      const navLabel = child(navPoint, "navLabel");
      const label = (navLabel ? textContent(navLabel) : "").replace(/\s+/g, " ").trim();
      const contentEl = child(navPoint, "content");
      const src = contentEl ? attr(contentEl, "src") : undefined;
      const target = src ? resolveTocTarget(src, opfDir) : undefined;
      out.push({
        label: label.length > 0 ? label : "未命名章节",
        path: target?.path ? target.path : undefined,
        fragment: target?.fragment,
        level,
        children: parsePoints(navPoint, level + 1),
      });
    }
    return out;
  };
  return parsePoints(navMap, 1);
}

function parseNavToc(text: string, opfDir: string, navDir: string): TocEntry[] {
  const root = parseXml(text);
  const navs = descendants(root, "nav");
  if (navs.length === 0) {
    return [];
  }
  const tocNav =
    navs.find((nav) => /(^|\s)toc(\s|$)/.test(attr(nav, "type") ?? "")) ??
    navs.find((nav) => (attr(nav, "role") ?? "").includes("doc-toc")) ??
    navs.find((nav) => child(nav, "ol") !== undefined) ??
    navs[0];
  const list = child(tocNav, "ol");
  if (!list) {
    return [];
  }
  const base = navDir.length > 0 ? navDir : opfDir;
  const parseList = (ol: XmlElement, level: number): TocEntry[] => {
    const out: TocEntry[] = [];
    for (const li of children(ol, "li")) {
      const anchor = child(li, "a") ?? child(li, "span");
      const label = (anchor ? textContent(anchor) : "").replace(/\s+/g, " ").trim();
      const href = anchor ? attr(anchor, "href") : undefined;
      const target = href ? resolveTocTarget(href, base) : undefined;
      const nested = child(li, "ol");
      out.push({
        label: label.length > 0 ? label : "未命名章节",
        path: target?.path ? target.path : undefined,
        fragment: target?.fragment,
        level,
        children: nested ? parseList(nested, level + 1) : [],
      });
    }
    return out;
  };
  return parseList(list, 1);
}

/** Attach toc labels and spine indexes to the chapters and toc entries. */
function applyTocTitles(chapters: EpubChapter[], toc: TocEntry[]): void {
  const byPath = new Map<string, string>();
  const indexByPath = new Map<string, number>();
  for (const chapter of chapters) {
    indexByPath.set(chapter.path.toLowerCase(), chapter.index);
  }
  const visit = (entries: TocEntry[]): void => {
    for (const entry of entries) {
      if (entry.path) {
        const key = entry.path.toLowerCase();
        if (!byPath.has(key) && entry.label.length > 0) {
          byPath.set(key, entry.label);
        }
        const index = indexByPath.get(key);
        if (index !== undefined) {
          entry.chapterIndex = index;
        }
      }
      visit(entry.children);
    }
  };
  visit(toc);
  for (const chapter of chapters) {
    chapter.title = byPath.get(chapter.path.toLowerCase()) ?? "";
  }
}

function readMetadata(
  packageEl: XmlElement,
  fallbackTitle: string,
  manifest: ManifestEntryInternal[],
  zip: ZipArchive,
  opfDir: string,
): EpubMetadata {
  const metadataEl = child(packageEl, "metadata");
  const meta = (name: string): string[] =>
    metadataEl
      ? children(metadataEl, name)
          .map((el) => textContent(el).replace(/\s+/g, " ").trim())
          .filter((value) => value.length > 0)
      : [];

  const titles = meta("title");
  const creators = meta("creator");
  const publisher = meta("publisher")[0];
  const language = meta("language")[0];
  const identifier = meta("identifier")[0];
  const description = meta("description")[0];
  const rights = meta("rights")[0];
  const date = meta("date")[0];

  const metadata: EpubMetadata = {
    title: titles[0] ?? fallbackTitle,
    creator: creators.length > 0 ? creators.join(" / ") : undefined,
    publisher,
    language,
    identifier,
    description,
    rights,
    date,
    coverPath: undefined,
  };
  metadata.coverPath = findCoverPath(packageEl, metadataEl, manifest, zip, opfDir);
  return metadata;
}

function findCoverPath(
  packageEl: XmlElement,
  metadataEl: XmlElement | undefined,
  manifest: ManifestEntryInternal[],
  zip: ZipArchive,
  opfDir: string,
): string | undefined {
  const isImage = (path: string | undefined): path is string =>
    path !== undefined && zip.has(path) && /^image\//i.test(mediaTypeOf(manifest, path));

  // EPUB 2: <meta name="cover" content="cover-image-id" />
  const coverId = metadataEl
    ? children(metadataEl, "meta")
        .filter((el) => (attr(el, "name") ?? "").toLowerCase() === "cover")
        .map((el) => attr(el, "content"))
        .find((value): value is string => Boolean(value))
    : undefined;
  if (coverId) {
    const item = manifest.find((candidate) => candidate.id === coverId);
    if (isImage(item?.path)) {
      return item!.path;
    }
  }

  // EPUB 3: manifest item with properties="cover-image"
  const propertyCover = manifest.find((item) => item.properties.split(/\s+/).includes("cover-image"));
  if (isImage(propertyCover?.path)) {
    return propertyCover!.path;
  }

  // Guide reference (may point at an image or at a cover page document).
  const guide = child(packageEl, "guide");
  if (guide) {
    for (const reference of children(guide, "reference")) {
      const type = (attr(reference, "type") ?? "").toLowerCase();
      if (!type.includes("cover")) {
        continue;
      }
      const href = attr(reference, "href");
      if (!href) {
        continue;
      }
      const target = resolveTocTarget(href, opfDir).path;
      if (!target) {
        continue;
      }
      if (isImage(target)) {
        return target;
      }
      const text = zip.tryReadText(target);
      if (text) {
        const root = parseXml(text);
        for (const image of descendants(root, "img")) {
          const src = attr(image, "src");
          if (!src) {
            continue;
          }
          const resolved = resolveTocTarget(src, dirname(target)).path;
          if (isImage(resolved)) {
            return resolved;
          }
        }
      }
    }
  }

  // Last resort: an image whose path or id mentions "cover".
  const guess = manifest.find(
    (item) => /cover/i.test(item.id) && isImage(item.path),
  );
  if (guess) {
    return guess.path;
  }
  const byName = zip
    .names()
    .filter((name) => /^image\//i.test(mediaTypeOf(manifest, name)) && /cover/i.test(name));
  return byName[0];
}

function mediaTypeOf(manifest: ManifestEntryInternal[], path: string): string {
  const lowered = path.toLowerCase();
  const item = manifest.find((candidate) => candidate.path.toLowerCase() === lowered);
  if (item?.mediaType) {
    return item.mediaType;
  }
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  return GUESSED_MEDIA_TYPES[ext] ?? "";
}
