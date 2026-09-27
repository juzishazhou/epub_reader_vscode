import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import { findSampleEpub, requireSampleEpub } from "./helpers/sample";
import { test } from "node:test";
import { openEpub } from "../epub/book";
import { restoreEditedMarkup, spliceBody } from "../epub/edit";
import { chapterText, renderChapter } from "../epub/render";
import { SearchIndex } from "../epub/search";
import { ZipArchive } from "../epub/zip";
import { rewriteZip } from "../epub/zipwrite";

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

test("edits a chapter of a real book and writes it back losslessly", { skip }, () => {
  const data = fs.readFileSync(requireSampleEpub());
  const book = openEpub(data);
  const index = 10;
  const path = book.chapters[index].path;
  const original = book.zip.readText(path);

  const rendered = renderChapter(book, index, {
    uriFor: (target) => `webview://asset/${target}`,
    resolveChapterPath: (target) => {
      const found = book.chapterIndexForPath(target);
      return found === undefined ? undefined : book.chapters[found].path;
    },
    readText: (target) => book.zip.tryReadText(target),
    fidelity: "edit",
  });
  assert.ok(rendered.body.length > 100);
  assert.match(rendered.body, /data-epub-orig-|epub-keep/, "the real book exercises annotations");

  // Play the browser: serialize the editable DOM back to markup, change text.
  const editedMarkup = rendered.body.replace(/([\u4e00-\u9fa5]{2,})/, "$1【编辑测试】");
  const next = spliceBody(original, restoreEditedMarkup(editedMarkup));
  assert.match(next, /【编辑测试】/);
  assert.ok(!next.includes("webview://"), "no webview URI may reach the book");
  assert.ok(!next.includes("data-epub-orig-"));
  assert.ok(!next.includes("epub-keep"));
  // Everything outside the body is byte-identical.
  assert.equal(next.slice(0, original.indexOf("<body")), original.slice(0, original.indexOf("<body")));

  // Rewriting the archive edits one entry and keeps every other one intact.
  const rewritten = ZipArchive.open(data);
  rewritten.setOverride(path, next);
  const bytes = rewriteZip(rewritten);
  const after = openEpub(bytes);
  assert.equal(after.chapters.length, book.chapters.length);
  assert.match(after.zip.readText(path), /【编辑测试】/);
  assert.equal(after.metadata.title, book.metadata.title);

  const before = ZipArchive.open(data);
  const afterZip = ZipArchive.open(bytes);
  assert.deepEqual(afterZip.names(), before.names(), "no entry may be added or dropped");
  let compared = 0;
  for (const name of before.names()) {
    if (name === path) {
      continue;
    }
    compared++;
    assert.ok(
      before.read(name).equals(afterZip.read(name)),
      `${name} must be byte-identical after the rewrite`,
    );
    assert.ok(
      Buffer.from(before.rawEntry(name)!.bytes).equals(Buffer.from(afterZip.rawEntry(name)!.bytes)),
      `${name} must keep its exact compressed payload`,
    );
  }
  assert.ok(compared > 1000, `expected to compare the whole book, compared ${compared}`);

  // Optional ZIP header fields are normalized away, so the file may shrink a
  // little; content-wise nothing changed. Only the edited chapter differs.
  const growth = Math.abs(bytes.length - data.length) / data.length;
  assert.ok(growth < 0.05, `rewriting one chapter changed the file size by ${(growth * 100).toFixed(1)}%`);

  // eslint-disable-next-line no-console
  console.log(
    `[real epub edit] path=${path} chapterBytes=${original.length}->${next.length} ` +
      `zip=${data.length}->${bytes.length} entries=${compared + 1}`,
  );
});
