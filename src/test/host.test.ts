import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import { findSampleEpub, requireSampleEpub } from "./helpers/sample";
import { test } from "node:test";
import type { BookmarkDto, ChapterPayload, ProgressDto, SearchResultsDto } from "../editor/protocol";
import type { TocEntry } from "../epub/book";
import { createBrokenEpub, createEpub3 } from "./helpers/fixtures";
import { openPanel } from "./helpers/hostHarness";
import {
  configurationStore,
  extractedAssets,
  globalState,
  openedExternal,
  registeredCommands,
  resetHostState,
} from "./helpers/vscodeMock";

interface InitMessage {
  type: "init";
  book: { title: string; creator?: string; chapterCount: number; coverUri?: string };
  toc: TocEntry[];
  bookmarks: BookmarkDto[];
  progress?: ProgressDto;
  startChapter: number;
}

interface ChapterMessage {
  type: "chapter";
  chapter: ChapterPayload;
}

interface BookmarksMessage {
  type: "bookmarks";
  bookmarks: BookmarkDto[];
  addedId?: string;
}

test("activates commands and serves a fixture book end to end", async () => {
  resetHostState();
  const { panel } = await openPanel("D:/books/fixture.epub", createEpub3());

  assert.ok(registeredCommands.has("epubReader.open"));
  assert.ok(registeredCommands.has("epubReader.continueReading"));
  assert.ok(registeredCommands.has("epubReader.clearHistory"));

  assert.match(panel.title, /测试之书/);
  assert.match(panel.webview.html, /Content-Security-Policy/);
  assert.match(panel.webview.html, /script-src 'nonce-/);
  assert.match(panel.webview.html, /media\/reader\.js/);
  assert.match(panel.webview.html, /media\/reader\.css/);
  assert.ok(panel.webview.html.includes("reading-surface"));

  let mark = panel.webview.count();
  await panel.webview.send({ type: "ready" });

  const init = await panel.webview.waitFor<InitMessage>("init", { after: mark });
  assert.equal(init.book.title, "测试之书");
  assert.equal(init.book.creator, "测试作者 / 第二作者");
  assert.equal(init.book.chapterCount, 3);
  assert.equal(init.toc.length, 3);
  assert.equal(init.startChapter, 0);
  assert.equal(init.progress, undefined);
  assert.match(init.book.coverUri ?? "", /^webview:.*OPS\/images\/cover\.png$/);

  const first = await panel.webview.waitFor<ChapterMessage>("chapter", { after: mark });
  assert.equal(first.chapter.index, 0);
  assert.equal(first.chapter.title, "第一章 起点");
  assert.equal(first.chapter.css.length, 2);
  assert.ok(!first.chapter.body.includes("<script"));
  assert.ok(!first.chapter.body.includes("onclick"));
  assert.match(first.chapter.body, /src="webview:.*OPS\/images\/diagram\.svg"/);
  assert.match(first.chapter.body, /data-epub-chapter="OPS\/text\/chapter2\.xhtml"/);
  assert.ok(first.chapter.body.includes("回到顶部"));

  const assets = extractedAssets();
  assert.ok(
    assets.some((asset) => asset.endsWith("/OPS/images/diagram.svg")),
    `expected the referenced asset on disk, saw ${assets.join(", ")}`,
  );

  mark = panel.webview.count();
  await panel.webview.send({ type: "openChapter", index: 2 });
  const third = await panel.webview.waitFor<ChapterMessage>("chapter", { after: mark });
  assert.equal(third.chapter.index, 2);
  assert.equal(third.chapter.title, "第三章 深入");
  assert.match(third.chapter.body, /src="webview:.*OPS\/images\/cover\.png"/);

  mark = panel.webview.count();
  await panel.webview.send({ type: "search", requestId: 7, query: "关键词" });
  const results = await panel.webview.waitFor<{ results: SearchResultsDto }>("searchResults", {
    after: mark,
  });
  assert.equal(results.results.requestId, 7);
  assert.equal(results.results.totalMatches, 2);
  assert.equal(results.results.hits.length, 2);
  assert.equal(results.results.hits[0].chapter, 1);
  assert.match(results.results.hits[0].snippet, /关键词/);

  mark = panel.webview.count();
  await panel.webview.send({
    type: "openChapter",
    index: 1,
    highlight: { query: "关键词", occurrence: 2 },
  });
  const highlighted = await panel.webview.waitFor<ChapterMessage>("chapter", { after: mark });
  assert.equal(highlighted.chapter.index, 1);
  assert.equal(highlighted.chapter.highlight?.found, true);
  assert.ok(highlighted.chapter.body.includes('<mark class="reader-hit">关键词</mark>'));

  mark = panel.webview.count();
  await panel.webview.send({
    type: "addBookmark",
    chapter: 1,
    scrollRatio: 0.25,
    label: "2. 第二章 转折",
    excerpt: "第二章的正文",
  });
  const bookmarkMessage = await panel.webview.waitFor<BookmarksMessage>("bookmarks", { after: mark });
  assert.equal(bookmarkMessage.bookmarks.length, 1);
  assert.equal(bookmarkMessage.addedId, bookmarkMessage.bookmarks[0].id);
  assert.equal(bookmarkMessage.bookmarks[0].scrollRatio, 0.25);
  await panel.webview.waitFor("toast", { after: mark });

  const storedBookmarks = globalState.get<Record<string, BookmarkDto[]>>("epubReader.bookmarks", {});
  assert.equal(Object.keys(storedBookmarks).length, 1);
  assert.equal(Object.values(storedBookmarks)[0][0].excerpt, "第二章的正文");

  mark = panel.webview.count();
  await panel.webview.send({ type: "removeBookmark", id: bookmarkMessage.addedId });
  const afterRemoval = await panel.webview.waitFor<BookmarksMessage>("bookmarks", { after: mark });
  assert.equal(afterRemoval.bookmarks.length, 0);

  await panel.webview.send({ type: "updateSetting", key: "fontSize", value: 22 });
  await panel.webview.send({ type: "updateSetting", key: "pageTheme", value: "sepia" });
  assert.equal(configurationStore.get("fontSize"), 22);
  assert.equal(configurationStore.get("pageTheme"), "sepia");

  await panel.webview.send({ type: "openExternal", url: "https://example.com/x" });
  assert.equal(openedExternal.length, 1);
  await panel.webview.send({ type: "openExternal", url: "javascript:alert(1)" });
  assert.equal(openedExternal.length, 1, "non-http links must never reach the OS");

  const recents = globalState.get<{ title: string; chapter: number }[]>("epubReader.recents", []);
  assert.equal(recents.length, 1);
  assert.equal(recents[0].title, "测试之书");
  assert.equal(recents[0].chapter, 1);

  await panel.webview.send({ type: "saveProgress", chapter: 1, scrollRatio: 0.4 });
  await new Promise((resolve) => setTimeout(resolve, 900));
  const progress = globalState.get<Record<string, ProgressDto>>("epubReader.progress", {});
  const stored = Object.values(progress);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].chapter, 1);
  assert.equal(stored[0].scrollRatio, 0.4);

  panel.dispose();
  assert.doesNotThrow(() => panel.dispose(), "disposing twice must be harmless");
});

test("shows a readable page when the epub cannot be parsed", async () => {
  resetHostState();
  const { panel } = await openPanel("D:/books/broken.epub", createBrokenEpub());

  assert.match(panel.webview.html, /无法打开/);
  assert.match(panel.webview.html, /OPF/);
  assert.match(panel.title, /broken/);
});

test("resumes at the stored position on the next visit", async () => {
  resetHostState();
  const bytes = createEpub3();
  const first = await openPanel("D:/books/resume.epub", bytes);
  const firstMark = first.panel.webview.count();
  await first.panel.webview.send({ type: "ready" });
  await first.panel.webview.waitFor<ChapterMessage>("chapter", { after: firstMark });
  await first.panel.webview.send({ type: "saveProgress", chapter: 2, scrollRatio: 0.6 });
  await new Promise((resolve) => setTimeout(resolve, 900));
  first.panel.dispose();

  const second = await openPanel("D:/books/resume.epub", bytes);
  const secondMark = second.panel.webview.count();
  await second.panel.webview.send({ type: "ready" });
  const init = await second.panel.webview.waitFor<InitMessage>("init", { after: secondMark });
  assert.equal(init.startChapter, 2);
  assert.equal(init.progress?.scrollRatio, 0.6);
  const chapter = await second.panel.webview.waitFor<ChapterMessage>("chapter", { after: secondMark });
  assert.equal(chapter.chapter.index, 2);
  second.panel.dispose();
});

const REAL_BOOK = findSampleEpub();
const realSkip = REAL_BOOK ? false : "未提供示例电子书（设置 EPUB_READER_SAMPLE，或把 EPUB 放进 fixtures/）";

test("serves a real 1600+ chapter book through the editor provider", { skip: realSkip }, async () => {
  resetHostState();
  const { panel } = await openPanel("D:/books/real.epub", fs.readFileSync(requireSampleEpub()));
  const mark = panel.webview.count();
  await panel.webview.send({ type: "ready" });

  const init = await panel.webview.waitFor<InitMessage>("init", { after: mark });
  assert.equal(init.book.title, "玄鉴仙族");
  assert.equal(init.book.chapterCount, 1660);
  assert.equal(init.toc.length, 1660);

  const chapter = await panel.webview.waitFor<ChapterMessage>("chapter", { after: mark });
  assert.ok(chapter.chapter.body.includes("百里彤云"));

  const jumpMark = panel.webview.count();
  await panel.webview.send({ type: "openChapter", index: 100 });
  const next = await panel.webview.waitFor<ChapterMessage>("chapter", { after: jumpMark });
  assert.equal(next.chapter.index, 100);

  const searchMark = panel.webview.count();
  await panel.webview.send({ type: "search", requestId: 3, query: "陆江仙" });
  const results = await panel.webview.waitFor<{ results: SearchResultsDto }>("searchResults", {
    after: searchMark,
  });
  assert.equal(results.results.requestId, 3);
  assert.ok(results.results.totalMatches > 0);
  assert.equal(results.results.indexedChapters, 1660);

  const pathMark = panel.webview.count();
  await panel.webview.send({ type: "openChapter", path: "OEBPS/chapter_10.xhtml" });
  const byPath = await panel.webview.waitFor<ChapterMessage>("chapter", { after: pathMark });
  assert.equal(byPath.chapter.index, 10);

  const warnMark = panel.webview.count();
  await panel.webview.send({ type: "openChapter", path: "OEBPS/does-not-exist.xhtml" });
  const toast = await panel.webview.waitFor<{ level: string }>("toast", { after: warnMark });
  assert.equal(toast.level, "warn");

  panel.dispose();
});
