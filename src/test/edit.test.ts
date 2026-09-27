import { strict as assert } from "node:assert";
import { test } from "node:test";
import { openEpub } from "../epub/book";
import {
  isEditableTextEntry,
  listEditableEntries,
  normalizeWrittenText,
  restoreEditedMarkup,
  spliceBody,
} from "../epub/edit";
import { renderChapter } from "../epub/render";
import { parseXml, serializeChildren } from "../epub/xml";
import { createEpub2, createEpub3, EXPECTED_PATHS } from "./helpers/fixtures";

const EPUB3 = createEpub3();
const BOOK = openEpub(EPUB3);
const CHAPTER = EXPECTED_PATHS.epub3.chapter1;

/** Render a chapter the way the edit panel does. */
function renderForEdit(path: string, index: number): string {
  const rendered = renderChapter(BOOK, index, {
    uriFor: (target) => `webview://asset/${target}`,
    resolveChapterPath: (target) => {
      const found = BOOK.chapterIndexForPath(target);
      return found === undefined ? undefined : BOOK.chapters[found].path;
    },
    readText: (target) => BOOK.zip.tryReadText(target),
    fidelity: "edit",
  });
  assert.equal(BOOK.chapters[index].path, path);
  return rendered.body;
}

/**
 * Stand-in for the browser round trip: the client serializes its editable DOM
 * back to markup, which we then parse with the same lenient parser the host
 * uses. A real browser lowercases attribute names and re-escapes entities; the
 * parse/serialize pair below is the closest thing available without a browser.
 */
function browserRoundTrip(markup: string): string {
  return serializeChildren(parseXml(markup));
}

test("classifies editable entries", () => {
  assert.equal(isEditableTextEntry("OPS/text/chapter1.xhtml"), true);
  assert.equal(isEditableTextEntry("OPS/styles/main.css"), true);
  assert.equal(isEditableTextEntry("OPS/package.opf"), true);
  assert.equal(isEditableTextEntry("OEBPS/toc.ncx"), true);
  assert.equal(isEditableTextEntry("OPS/images/cover.png"), false);
  assert.equal(isEditableTextEntry("mimetype"), false);
  assert.equal(isEditableTextEntry("META-INF/container.xml"), false);

  const entries = listEditableEntries(BOOK);
  const chapter = entries.find((entry) => entry.path === CHAPTER);
  assert.ok(chapter, "the chapter must be listed");
  assert.equal(chapter!.isChapter, true);
  assert.match(chapter!.label, /第一章 起点/);
  const css = entries.find((entry) => entry.path === EXPECTED_PATHS.epub3.mainCss);
  assert.ok(css, "the stylesheet must be listed");
  assert.equal(css!.isChapter, false);
  assert.ok(!entries.some((entry) => entry.path.endsWith(".png")));
});

test("edit rendering keeps what the reader drops, with annotations", () => {
  const body = renderForEdit(CHAPTER, 0);

  // Insecure elements are kept (hidden), so they can be written back.
  assert.match(body, /<script[^>]*class="epub-keep"|class="epub-keep"[^>]*>alert/);
  assert.match(body, /alert\('should never run'\)/);
  assert.match(body, /onclick="evil\(\)"/);
  // Rewritten references remember their original value.
  assert.match(body, /src="webview:\/\/asset\/OPS\/images\/diagram\.svg"/);
  assert.match(body, /data-epub-orig-src="\.\.\/images\/diagram\.svg"/);
  // Anchors stay exactly as the book wrote them.
  assert.match(body, /href="chapter2\.xhtml#mark"/);
  assert.match(body, /href="https:\/\/example\.com\/x"/);
  assert.ok(!body.includes("data-epub-chapter"), "edit mode does not rewrite anchors");
  // Body stylesheets stay in place instead of being hoisted into the css array.
  assert.ok(!body.includes("<style>"), "the fixture only has head styles");
});

test("writing a visually edited chapter back preserves everything else", () => {
  const body = renderForEdit(CHAPTER, 0);
  const edited = browserRoundTrip(body).replace("正文段落", "正文被改写了");

  const original = BOOK.zip.readText(CHAPTER);
  const restored = restoreEditedMarkup(edited);
  const next = spliceBody(original, restored);

  // The edit itself landed.
  assert.match(next, /正文被改写了/);
  assert.ok(!next.includes("正文段落"));
  // Nothing outside <body> moved: declaration, doctype and head are verbatim.
  assert.ok(next.startsWith(original.slice(0, original.indexOf("<body"))));
  assert.match(next, /<link rel="stylesheet" type="text\/css" href="\.\.\/styles\/main\.css"\/>/);
  assert.match(next, /p\.lead \{ color: red; background: url\(\.\.\/images\/diagram\.svg\); \}/);
  // Dropped-elements came back, and rewritten attributes went back to original.
  assert.match(next, /<script>alert\('should never run'\)<\/script>/);
  assert.match(next, /onclick="evil\(\)"/);
  assert.match(next, /src="\.\.\/images\/diagram\.svg"/);
  assert.match(next, /href="chapter2\.xhtml#mark"/);
  assert.ok(!next.includes("webview://"), "no webview URI may reach the book");
  assert.ok(!next.includes("data-epub-orig-"), "annotations must be stripped");
  assert.ok(!next.includes("epub-keep"), "the marker class must be stripped");
  assert.ok(!next.includes("contenteditable"));
});

test("spliceBody only touches the inside of <body>", () => {
  const original = '<html><head><title>标题</title></head><body class="x">旧</body></html>';
  assert.equal(
    spliceBody(original, "<p>新</p>"),
    '<html><head><title>标题</title></head><body class="x"><p>新</p></body></html>',
  );

  const withoutClose = "<html><body>旧";
  assert.equal(spliceBody(withoutClose, "新"), "<html><body>新");

  assert.throws(() => spliceBody("<html><head></head></html>", "新"), /没有 <body>/);
});

test("restoreEditedMarkup drops annotations and marker classes only", () => {
  const markup =
    '<p class="lead epub-keep" data-epub-orig-src="../a.png" src="webview://x/a.png">文字</p>' +
    '<div class="epub-keep">隐藏</div>';
  const restored = restoreEditedMarkup(markup);
  assert.match(restored, /class="lead"/);
  assert.match(restored, /src="\.\.\/a\.png"/);
  assert.ok(!restored.includes("data-epub-orig-"));
  assert.ok(!restored.includes("epub-keep"));
  assert.match(restored, /<div>隐藏<\/div>/);
});

test("normalizeWrittenText keeps line endings and fixes a lying declaration", () => {
  const crlf = '<html>\r\n<body>a</body>\r\n</html>';
  assert.equal(
    normalizeWrittenText(crlf, "<html>\n<body>b</body>\n</html>"),
    '<html>\r\n<body>b</body>\r\n</html>',
  );

  const gbk = '<?xml version="1.0" encoding="GBK"?>\n<html><body>旧</body></html>';
  const next = normalizeWrittenText(gbk, '<?xml version="1.0" encoding="GBK"?>\n<html><body>新</body></html>');
  assert.match(next, /encoding="utf-8"/);
  assert.ok(!next.includes("GBK"), "a GBK declaration would break utf-8 bytes");

  // A declared utf-8 file is left alone.
  const utf8 = '<?xml version="1.0" encoding="utf-8"?>\n<html><body>旧</body></html>';
  const kept = normalizeWrittenText(
    utf8,
    '<?xml version="1.0" encoding="utf-8"?>\n<html><body>新</body></html>',
  );
  assert.equal(kept, '<?xml version="1.0" encoding="utf-8"?>\n<html><body>新</body></html>');
});

test("editing an EPUB 2 chapter keeps its nc2 structure intact", () => {
  const book = openEpub(createEpub2());
  const path = EXPECTED_PATHS.epub2.chapter0;
  const rendered = renderChapter(book, 0, {
    uriFor: () => undefined,
    resolveChapterPath: () => undefined,
    readText: (target) => book.zip.tryReadText(target),
    fidelity: "edit",
  });
  const edited = browserRoundTrip(rendered.body).replace("第一段", "改过的第一段");
  const next = spliceBody(book.zip.readText(path), restoreEditedMarkup(edited));
  assert.match(next, /改过的第一段/);
  assert.match(next, /id="extra"/);
  assert.equal(openEpub(createEpub2()).chapters[0].path, path);
});
