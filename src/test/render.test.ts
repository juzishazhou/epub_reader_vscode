import { strict as assert } from "node:assert";
import { test } from "node:test";
import { openEpub } from "../epub/book";
import { RenderChapterOptions, chapterText, renderChapter } from "../epub/render";
import { createEpub3, EXPECTED_PATHS } from "./helpers/fixtures";

function fixture() {
  const book = openEpub(createEpub3());
  const render = (index: number, extra: Partial<RenderChapterOptions> = {}) =>
    renderChapter(book, index, {
      uriFor: (path) => `webview:///${path}`,
      resolveChapterPath: (path) => {
        const found = book.chapterIndexForPath(path);
        return found === undefined ? undefined : book.chapters[found].path;
      },
      readText: (path) => book.zip.tryReadText(path),
      ...extra,
    });
  return { book, render };
}

test("strips scripts, event handlers and rewrites asset urls", () => {
  const { render } = fixture();
  const chapter = render(0);

  assert.ok(!chapter.body.includes("<script"));
  assert.ok(!chapter.body.includes("alert("));
  assert.ok(!chapter.body.includes("onclick"));
  assert.ok(!chapter.body.includes("evil()"));
  assert.ok(chapter.body.includes(`src="webview:///${EXPECTED_PATHS.epub3.diagram}"`));
  assert.ok(chapter.body.includes('<h1 id="c1">第一章 起点</h1>'));
  assert.ok(chapter.body.includes("&amp; 符号"));
  assert.ok(!chapter.body.includes("<head"));
  assert.ok(!chapter.body.includes("<title>"));
  assert.ok(chapter.assets.includes(EXPECTED_PATHS.epub3.diagram));
});

test("annotates internal, fragment and external links", () => {
  const { render } = fixture();
  const chapter = render(0);

  assert.ok(chapter.body.includes(`data-epub-chapter="${EXPECTED_PATHS.epub3.chapter2}"`));
  assert.ok(chapter.body.includes('data-epub-fragment="mark"'));
  assert.ok(chapter.body.includes('data-epub-external="https://example.com/x"'));
  assert.ok(!chapter.body.includes('href="https://example.com/x"'));
  assert.ok(chapter.body.includes('data-epub-fragment="c1"'));
});

test("inlines stylesheets, resolves @import and rewrites css urls", () => {
  const { render } = fixture();
  const chapter = render(0);

  assert.equal(chapter.css.length, 2, "one linked stylesheet plus one inline <style>");
  const linked = chapter.css[0];
  assert.ok(linked.includes(".note {"), "@import must be inlined");
  assert.ok(
    linked.includes(`url("webview:///${EXPECTED_PATHS.epub3.cover}")`),
    "url() inside the imported sheet resolves against that sheet",
  );
  assert.ok(linked.includes("font-family: serif"));
  assert.ok(chapter.css[1].includes(`url("webview:///${EXPECTED_PATHS.epub3.diagram}")`));
  assert.ok(chapter.assets.includes(EXPECTED_PATHS.epub3.extraCss));
  assert.ok(!chapter.body.includes("<link"));
  assert.ok(!chapter.body.includes("<style"));
});

test("rewrites imported css urls exactly once", () => {
  const book = openEpub(createEpub3());
  const chapter = renderChapter(book, 0, {
    uriFor: (path) => `assets/${path}`,
    resolveChapterPath: () => undefined,
    readText: (path) => book.zip.tryReadText(path),
  });
  const all = chapter.css.join("\n");

  assert.ok(!all.includes("assets/OPS/styles/assets/"), "imported urls must not be re-resolved");
  assert.equal(all.split('url("assets/OPS/images/cover.png")').length - 1, 1);
  // extra.css is imported twice by main.css and once more by the inline <style>.
  assert.equal(all.split('url("assets/OPS/images/diagram.svg")').length - 1, 3);
});

test("resolves relative paths from a nested chapter directory", () => {
  const { render } = fixture();
  const chapter = render(2);

  assert.ok(chapter.body.includes(`src="webview:///${EXPECTED_PATHS.epub3.cover}"`));
  assert.equal(chapter.css.length, 1);
  assert.ok(chapter.css[0].includes(`url("webview:///${EXPECTED_PATHS.epub3.cover}")`));
});

test("drops asset attributes that cannot be resolved", () => {
  const book = openEpub(createEpub3());
  const chapter = renderChapter(book, 0, {
    uriFor: () => undefined,
    resolveChapterPath: () => undefined,
    readText: (path) => book.zip.tryReadText(path),
  });
  assert.ok(!chapter.body.includes("src="), "an unresolvable image must not keep its src");
  assert.ok(chapter.body.includes("<img"), "the element itself is kept, just neutered");
});

test("plain text matches the rendered markup and excludes scripts", () => {
  const { book, render } = fixture();
  const chapter = render(0);
  const text = chapterText(book, 0);

  assert.equal(chapter.text, text);
  assert.ok(text.includes("正文段落，包含 强调 与 & 符号。"));
  assert.ok(!text.includes("alert"));
  assert.ok(!text.includes("<"));
  assert.ok(!text.includes("font-family"));
});

test("highlights the requested occurrence and reports misses", () => {
  const { render } = fixture();

  const second = render(1, { highlight: { query: "关键词", occurrence: 2 } });
  assert.equal(second.highlightFound, true);
  assert.ok(second.body.includes('<mark class="reader-hit">关键词</mark>'));
  const beforeMark = second.body.slice(0, second.body.indexOf("<mark"));
  assert.ok(beforeMark.includes("关键词"), "the first occurrence must be left alone");

  const missing = render(1, { highlight: { query: "不存在的词", occurrence: 1 } });
  assert.equal(missing.highlightFound, false);
  assert.ok(!missing.body.includes("<mark"));

  const outOfRange = render(1, { highlight: { query: "关键词", occurrence: 9 } });
  assert.equal(outOfRange.highlightFound, false);
});

test("highlight occurrences line up with the chapter text", () => {
  const { book, render } = fixture();
  const text = chapterText(book, 1);
  const occurrences: number[] = [];
  let from = 0;
  while (true) {
    const at = text.indexOf("关键词", from);
    if (at < 0) {
      break;
    }
    occurrences.push(at);
    from = at + 3;
  }
  assert.equal(occurrences.length, 2);

  const first = render(1, { highlight: { query: "关键词", occurrence: 1 } });
  assert.equal(first.highlightFound, true);
  const prefix = first.body.slice(0, first.body.indexOf("<mark"));
  assert.ok(!prefix.includes("关键词"), "occurrence 1 must be the first match in the chapter");
});
