import { strict as assert } from "node:assert";
import { test } from "node:test";
import { openEpub } from "../epub/book";
import { createBrokenEpub, createEpub2, createEpub3, EXPECTED_PATHS } from "./helpers/fixtures";

test("parses an EPUB 3 package into metadata, spine and nav toc", () => {
  const book = openEpub(createEpub3());

  assert.equal(book.opfPath, "OPS/package.opf");
  assert.equal(book.opfDir, "OPS");
  assert.equal(book.metadata.title, "测试之书");
  assert.equal(book.metadata.creator, "测试作者 / 第二作者");
  assert.equal(book.metadata.language, "zh-CN");
  assert.equal(book.metadata.publisher, "单元测试出版社");
  assert.equal(book.metadata.description, "一本用于测试的电子书。");
  assert.equal(book.metadata.coverPath, EXPECTED_PATHS.epub3.cover);

  assert.deepEqual(
    book.chapters.map((chapter) => chapter.path),
    [EXPECTED_PATHS.epub3.chapter1, EXPECTED_PATHS.epub3.chapter2, EXPECTED_PATHS.epub3.chapter3],
  );
  assert.deepEqual(
    book.chapters.map((chapter) => chapter.title),
    ["第一章 起点", "第二章 转折", "第三章 深入"],
  );

  assert.equal(book.toc.length, 3);
  assert.equal(book.toc[0].label, "第一章 起点");
  assert.equal(book.toc[0].level, 1);
  assert.equal(book.toc[0].children.length, 1);
  assert.equal(book.toc[0].children[0].label, "第一节 小节");
  assert.equal(book.toc[0].children[0].level, 2);
  assert.equal(book.toc[0].children[0].fragment, "sec1");
  assert.equal(book.toc[0].children[0].chapterIndex, 0);
  assert.equal(book.toc[1].chapterIndex, 1);
  assert.equal(book.toc[2].chapterIndex, 2);

  assert.equal(book.chapterIndexForPath("OPS/TEXT/CHAPTER1.XHTML"), 0);
  assert.equal(book.chapterIndexForPath("OPS/text/nope.xhtml"), undefined);
  assert.equal(book.mediaTypeForPath(EXPECTED_PATHS.epub3.mainCss), "text/css");
  assert.equal(book.mediaTypeForPath("OPS/images/unknown.webp"), "image/webp");
  assert.equal(book.flattenToc().length, 4);
});

test("parses an EPUB 2 package with NCX navigation and percent-encoded hrefs", () => {
  const book = openEpub(createEpub2());

  assert.equal(book.opfDir, "OEBPS");
  assert.equal(book.metadata.title, "古早格式");
  assert.equal(book.metadata.creator, "老作者");
  assert.equal(book.metadata.coverPath, EXPECTED_PATHS.epub2.cover);

  assert.deepEqual(
    book.chapters.map((chapter) => chapter.path),
    [EXPECTED_PATHS.epub2.chapter0, EXPECTED_PATHS.epub2.chapterWithSpace],
  );
  assert.equal(book.chapters[1].path, "OEBPS/text/ch 1.xhtml");
  assert.equal(book.chapters[1].title, "带空格的章节");

  assert.equal(book.toc.length, 2);
  assert.equal(book.toc[0].label, "楔子");
  assert.equal(book.toc[0].children.length, 1);
  assert.equal(book.toc[0].children[0].label, "楔子·补遗");
  assert.equal(book.toc[0].children[0].path, EXPECTED_PATHS.epub2.chapter0);
  assert.equal(book.toc[0].children[0].fragment, "extra");
  assert.equal(book.toc[1].path, "OEBPS/text/ch 1.xhtml");
  assert.equal(book.toc[1].chapterIndex, 1);
});

test("falls back to the spine when a book has no navigation document", () => {
  const book = openEpub(createEpub2());
  assert.ok(book.flattenToc().every((entry) => typeof entry.chapterIndex === "number"));
  assert.ok(book.spinePaths.has(EXPECTED_PATHS.epub2.chapter0));
  assert.equal(book.spinePaths.size, 2);
});

test("throws a readable error when the package file is missing", () => {
  assert.throws(() => openEpub(createBrokenEpub()), /OPF/);
});
