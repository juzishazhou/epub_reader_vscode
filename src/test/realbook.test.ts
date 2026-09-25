import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import { findSampleEpub, requireSampleEpub } from "./helpers/sample";
import { test } from "node:test";
import { openEpub } from "../epub/book";
import { chapterText, renderChapter } from "../epub/render";
import { SearchIndex } from "../epub/search";

/** The sample book lives next to the extension checkout, not inside it. */
const REAL_BOOK = findSampleEpub();
const available = REAL_BOOK !== undefined;
const skip = available ? false : "未提供示例电子书（设置 EPUB_READER_SAMPLE，或把 EPUB 放进 fixtures/）";

test("opens and indexes a real ~10MB, 1600+ chapter epub", { skip }, () => {
  const data = fs.readFileSync(requireSampleEpub());

  const openStarted = Date.now();
  const book = openEpub(data);
  const openMs = Date.now() - openStarted;

  assert.equal(book.metadata.title, "玄鉴仙族");
  assert.equal(book.metadata.language, "zh");
  assert.ok(book.chapters.length >= 1500, `expected a long book, got ${book.chapters.length}`);
  assert.ok(book.toc.length >= 1500, `expected a long toc, got ${book.toc.length}`);
  assert.equal(book.chapters[0].path, "OEBPS/chapter_0.xhtml");
  assert.equal(book.chapters[0].title, "感谢大佬们");
  assert.equal(book.chapterIndexForPath("OEBPS/chapter_10.xhtml"), 10);

  const text = chapterText(book, 0);
  assert.ok(text.includes("感谢大佬们"));
  assert.ok(text.includes("百里彤云"));
  assert.ok(!text.includes("<"));

  const indexStarted = Date.now();
  const index = new SearchIndex(book);
  index.build();
  const buildMs = Date.now() - indexStarted;

  assert.equal(index.builtChapters, book.chapters.length);
  assert.ok(index.search("百里彤云").totalMatches >= 1);
  assert.ok(index.search("感谢大佬们").totalMatches >= 1);
  const protagonist = index.search("陆江仙");

  const rendered = renderChapter(book, 10, {
    uriFor: () => undefined,
    resolveChapterPath: (target) => {
      const found = book.chapterIndexForPath(target);
      return found === undefined ? undefined : book.chapters[found].path;
    },
    readText: (target) => book.zip.tryReadText(target),
  });
  assert.ok(rendered.body.length > 100);
  assert.ok(!rendered.body.includes("<script"));
  assert.equal(rendered.title.length > 0, true);

  // eslint-disable-next-line no-console
  console.log(
    `[real epub] chapters=${book.chapters.length} toc=${book.toc.length} open=${openMs}ms ` +
      `fullTextIndex=${buildMs}ms 陆江仙=${protagonist.totalMatches} chapter10=${rendered.title}`,
  );
});

test("opens a real epub within a reasonable time budget", { skip }, () => {
  const data = fs.readFileSync(requireSampleEpub());
  const started = Date.now();
  openEpub(data);
  assert.ok(Date.now() - started < 5000, "opening a book must not block for seconds");
});
