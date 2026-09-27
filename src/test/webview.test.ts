import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import type { ChapterPayload, ReaderSettings, SearchResultsDto } from "../editor/protocol";
import type { TocEntry } from "../epub/book";
import { createEpub3 } from "./helpers/fixtures";
import { openPanel } from "./helpers/hostHarness";
import { resetHostState } from "./helpers/vscodeMock";

/* eslint-disable @typescript-eslint/no-var-requires, @typescript-eslint/no-explicit-any */
const { JSDOM } = require("jsdom") as {
  JSDOM: new (html: string, options: Record<string, unknown>) => any;
};

const READER_JS = fs.readFileSync(path.resolve(__dirname, "../../../media/reader.js"), "utf8");

interface BookInfo {
  title: string;
  creator?: string;
  chapterCount: number;
  coverUri?: string;
}

interface InitMessage {
  type: "init";
  book: BookInfo;
  toc: TocEntry[];
  settings: ReaderSettings;
  bookmarks: unknown[];
  startChapter: number;
}

/** Messages cross a realm boundary, so compare them as plain JSON. */
function plain(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

/**
 * Background chatter (throttled progress saves) shares the channel, so every
 * assertion looks for the most recent message of the expected type.
 */
function lastOfType(posted: any[], type: unknown): any {
  for (let index = posted.length - 1; index >= 0; index--) {
    if (posted[index].type === type) {
      return posted[index];
    }
  }
  return undefined;
}

function expectMessage(posted: any[], expected: Record<string, unknown>): void {
  const actual = lastOfType(posted, expected.type);
  assert.ok(actual, `expected a "${expected.type}" message, saw [${posted.map((m) => m.type)}]`);
  assert.deepEqual(plain(actual), plain(expected));
}

function expectMessageFields(posted: any[], expected: Record<string, unknown>): void {
  const actual = lastOfType(posted, expected.type);
  assert.ok(actual, `expected a "${expected.type}" message, saw [${posted.map((m) => m.type)}]`);
  for (const [key, value] of Object.entries(expected)) {
    assert.deepEqual(plain(actual[key]), plain(value), `message.${key}`);
  }
}

async function waitForPosted(posted: any[], type: string, timeoutMs = 4000): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = lastOfType(posted, type);
    if (found) {
      return found;
    }
    if (Date.now() > deadline) {
      throw new Error(`no "${type}" message arrived, saw [${posted.map((m) => m.type)}]`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/**
 * Load the real reader client into a real DOM, using the shell HTML the host
 * actually produced. This is the only way to exercise the webview half without
 * a browser window.
 */
async function bootClient(shellHtml: string): Promise<{
  window: any;
  posted: any[];
  send: (message: unknown) => void;
}> {
  const dom = new JSDOM(shellHtml, {
    runScripts: "outside-only",
    pretendToBeVisual: true,
    url: "https://localhost/",
  });
  const window = dom.window;
  const posted: any[] = [];
  window.acquireVsCodeApi = () => ({
    postMessage: (message: unknown) => posted.push(message),
    getState: () => undefined,
    setState: () => undefined,
  });

  assert.equal(typeof window.requestAnimationFrame, "function");
  if (window.document.readyState === "loading") {
    await new Promise((resolve) =>
      window.document.addEventListener("DOMContentLoaded", resolve, { once: true }),
    );
  }
  window.eval(READER_JS);

  return {
    window,
    posted,
    send: (message: unknown) =>
      window.dispatchEvent(new window.MessageEvent("message", { data: message })),
  };
}

function press(window: any, key: string): void {
  window.document.dispatchEvent(
    new window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
  );
}

function shadowOf(window: any): any {
  return window.document.getElementById("reading-surface").shadowRoot;
}

test("the webview client renders the host payload and drives it back", async () => {
  resetHostState();
  const { panel } = await openPanel("D:/books/webview.epub", createEpub3());

  // Real host payloads, produced by the real provider.
  const hostMark = panel.webview.count();
  await panel.webview.send({ type: "ready" });
  const init = await panel.webview.waitFor<InitMessage>("init", { after: hostMark });
  const chapter = await panel.webview.waitFor<{ chapter: ChapterPayload }>("chapter", {
    after: hostMark,
  });
  assert.equal(init.settings.fontSize, 17);
  assert.equal(init.settings.pageTheme, "auto");

  const { window, posted, send } = await bootClient(panel.webview.html);
  const doc = window.document;

  // The client greets the host as soon as it boots.
  expectMessage(posted, { type: "ready" });

  /* ---------------------------------------------------------------- init */

  posted.length = 0;
  send(init);
  assert.equal(doc.getElementById("book-title").textContent, "测试之书");
  assert.equal(doc.getElementById("meta-author").textContent, "测试作者 / 第二作者");
  assert.match(doc.getElementById("meta-extra").textContent, /3 节/);
  assert.equal(doc.getElementById("cover").getAttribute("src"), init.book.coverUri);
  assert.equal(doc.getElementById("theme-select").value, "auto");
  assert.equal(posted.length, 0, "rendering a payload must not call back into the host");

  const tocItems = doc.querySelectorAll("#toc-list .toc-item");
  assert.equal(tocItems.length, 4, "three top level entries plus one nested one");
  assert.equal(tocItems[0].textContent, "第一章 起点");
  assert.equal(tocItems[0].getAttribute("data-level"), "1");
  assert.equal(tocItems[1].textContent, "第一节 小节");
  assert.equal(tocItems[1].getAttribute("data-level"), "2");

  /* ------------------------------------------------------------- chapter */

  send(chapter);
  const shadow = shadowOf(window);
  assert.ok(shadow, "the reading surface must expose a shadow root");
  assert.match(shadow.innerHTML, /class="reader-body"/);
  assert.match(shadow.innerHTML, /第一章 起点/);
  assert.match(shadow.innerHTML, /<style>/);
  assert.match(shadow.innerHTML, /max-width: 46rem/);
  assert.equal(doc.getElementById("chapter-title").textContent, "第一章 起点");
  assert.equal(doc.getElementById("status-chapter").textContent, "1 / 3");
  assert.equal(doc.getElementById("loading").hidden, true);
  assert.ok(
    doc.querySelector('#toc-list .toc-item[data-chapter="0"]').classList.contains("is-active"),
    "the active toc entry must be marked",
  );

  /* ------------------------------------------------------------ clicking */

  posted.length = 0;
  const thirdItem = doc.querySelectorAll("#toc-list .toc-item")[3];
  assert.equal(thirdItem.textContent, "第三章 深入");
  thirdItem.click();
  expectMessage(posted, { type: "openChapter", index: 2, scrollRatio: 0 });

  posted.length = 0;
  const link = shadow.querySelector("a[data-epub-chapter]");
  assert.ok(link, "the fixture chapter has an internal link");
  link.click();
  expectMessage(posted, {
    type: "openChapter",
    path: "OPS/text/chapter2.xhtml",
    fragment: "mark",
    scrollRatio: 0,
  });

  posted.length = 0;
  shadow.querySelector("a[data-epub-external]").click();
  expectMessage(posted, { type: "openExternal", url: "https://example.com/x" });

  /* ------------------------------------------------------------ keyboard */

  posted.length = 0;
  press(window, "]");
  expectMessage(posted, { type: "openChapter", index: 1, scrollRatio: 0 });

  // The host answers with the chapter; feed it back so the client advances.
  const secondMark = panel.webview.count();
  await panel.webview.send({ type: "openChapter", index: 1 });
  const second = await panel.webview.waitFor<{ chapter: ChapterPayload }>("chapter", {
    after: secondMark,
  });
  send(second);
  assert.equal(doc.getElementById("status-chapter").textContent, "2 / 3");
  assert.equal(doc.getElementById("chapter-title").textContent, "第二章 转折");

  posted.length = 0;
  press(window, "[");
  expectMessage(posted, { type: "openChapter", index: 0, scrollRatio: 0 });

  assert.equal(doc.getElementById("app").getAttribute("data-drawer-open"), "true");
  press(window, "t");
  assert.equal(doc.getElementById("app").getAttribute("data-drawer-open"), "false");
  press(window, "t");
  assert.equal(doc.getElementById("app").getAttribute("data-drawer-open"), "true");

  posted.length = 0;
  press(window, "b");
  expectMessageFields(posted, {
    type: "addBookmark",
    chapter: 1,
    scrollRatio: 0,
    label: "2. 第二章 转折",
  });

  assert.equal(doc.getElementById("help").hidden, true);
  press(window, "?");
  assert.equal(doc.getElementById("help").hidden, false);
  press(window, "Escape");
  assert.equal(doc.getElementById("help").hidden, true);

  /* -------------------------------------------------------------- search */

  posted.length = 0;
  const input = doc.getElementById("search-input");
  input.value = "关键词";
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
  const searchMessage = await waitForPosted(posted, "search");
  expectMessageFields(posted, { type: "search", query: "关键词" });
  const requestId = searchMessage.requestId;
  assert.ok(typeof requestId === "number");

  // Ask the real host for results, then feed them to the client.
  const searchMark = panel.webview.count();
  await panel.webview.send({ type: "search", requestId, query: "关键词" });
  const results = await panel.webview.waitFor<{ results: SearchResultsDto }>("searchResults", {
    after: searchMark,
  });
  assert.equal(results.results.hits.length, 2);

  send(results);
  assert.equal(doc.querySelectorAll("#search-list .search-hit").length, 2);
  assert.match(doc.getElementById("search-summary").textContent, /找到 2 处/);
  // A snippet covers both occurrences in this fixture, so marks are not 1:1.
  assert.ok(doc.querySelectorAll("#search-list mark").length >= 2);
  assert.ok(
    doc.querySelectorAll("#search-list .search-hit")[0].querySelectorAll("mark").length >= 1,
    "the matched term must be highlighted inside the snippet",
  );

  posted.length = 0;
  doc.querySelectorAll("#search-list .search-hit")[1].click();
  expectMessageFields(posted, {
    type: "openChapter",
    index: 1,
    highlight: { query: "关键词", occurrence: 2 },
  });

  /* ----------------------------------------------------------- bookmarks */

  send({ type: "bookmarks", bookmarks: [] });
  assert.match(doc.getElementById("bookmark-list").textContent, /还没有书签/);

  const bookmarkMark = panel.webview.count();
  await panel.webview.send({
    type: "addBookmark",
    chapter: 1,
    scrollRatio: 0.5,
    label: "2. 第二章",
    excerpt: "摘录",
  });
  const bookmarks = await panel.webview.waitFor<{ bookmarks: any[] }>("bookmarks", {
    after: bookmarkMark,
  });
  send(bookmarks);
  assert.equal(doc.querySelectorAll("#bookmark-list .bookmark-row").length, 1);
  assert.match(doc.getElementById("bookmark-list").textContent, /2\. 第二章/);

  posted.length = 0;
  doc.querySelector("#bookmark-list .row-delete").click();
  expectMessageFields(posted, { type: "removeBookmark", id: bookmarks.bookmarks[0].id });

  /* ------------------------------------------------------------ settings */

  posted.length = 0;
  const themeSelect = doc.getElementById("theme-select");
  themeSelect.value = "sepia";
  themeSelect.dispatchEvent(new window.Event("change", { bubbles: true }));
  expectMessage(posted, { type: "updateSetting", key: "pageTheme", value: "sepia" });
  assert.match(shadowOf(window).innerHTML, /#f4ecd8/, "the page palette must follow the theme");

  posted.length = 0;
  press(window, "+");
  expectMessage(posted, { type: "updateSetting", key: "fontSize", value: 18 });
  assert.match(shadowOf(window).innerHTML, /font-size: 18px/);
  posted.length = 0;
  press(window, "0");
  expectMessage(posted, { type: "updateSetting", key: "fontSize", value: 17 });

  send({ type: "settings", settings: { ...init.settings, pageTheme: "dark", fontSize: 20 } });
  assert.equal(doc.getElementById("theme-select").value, "dark");

  /* --------------------------------------------------------------- toast */

  send({ type: "toast", level: "warn", message: "注意" });
  assert.equal(doc.getElementById("toast").hidden, false);
  assert.equal(doc.getElementById("toast").textContent, "注意");

  send({ type: "chapterError", index: 0, message: "这一节坏了" });
  assert.match(doc.querySelector(".error-box").textContent, /这一节坏了/);

  /* ------------------------------------------------------- stale results */

  send({ type: "searchResults", results: { ...results.results, requestId: 99999 } });
  assert.equal(
    doc.querySelectorAll("#search-list .search-hit").length,
    2,
    "results for an older request must be ignored",
  );
});

/* ------------------------------------------------------------- edit mode */

interface EditFixtures {
  posted: any[];
  send: (message: unknown) => void;
  window: any;
  panel: Awaited<ReturnType<typeof openPanel>>["panel"];
  entries: any;
  editContent: any;
}

/**
 * Boot the real client with real host payloads and the edit content for the
 * first chapter already fetched from the host.
 */
async function bootEditFixtures(epubPath: string): Promise<EditFixtures> {
  const { panel } = await openPanel(epubPath, createEpub3());
  const mark = panel.webview.count();
  await panel.webview.send({ type: "ready" });
  const init = await panel.webview.waitFor<InitMessage>("init", { after: mark });
  const chapter = await panel.webview.waitFor<{ chapter: ChapterPayload }>("chapter", { after: mark });

  const editMark = panel.webview.count();
  await panel.webview.send({ type: "requestEdit" });
  const entries = await panel.webview.waitFor<any>("editEntries", { after: editMark });
  const editContent = await panel.webview.waitFor<any>("editContent", { after: editMark });

  const { window, posted, send } = await bootClient(panel.webview.html);
  send(init);
  send(chapter);
  return { posted, send, window, panel, entries, editContent };
}

/** MutationObserver delivery is asynchronous; let it run before asserting. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 30));
}

test("the webview edits the chapter in place and writes it back to the host", async () => {
  resetHostState();
  const { posted, send, window, entries, editContent } = await bootEditFixtures(
    "D:/books/edit-ui.epub",
  );
  const doc = window.document;

  // The toolbar button asks the host for the current chapter's edit content.
  posted.length = 0;
  doc.getElementById("btn-edit").click();
  const request = lastOfType(posted, "requestEdit");
  assert.ok(request, `expected a requestEdit, saw [${posted.map((m) => m.type)}]`);
  assert.match(request.path, /chapter1\.xhtml$/);

  posted.length = 0;
  send(entries);
  send(editContent);

  assert.equal(doc.getElementById("edit-bar").hidden, false);
  assert.equal(doc.getElementById("app").getAttribute("data-edit-mode"), "true");
  assert.equal(doc.getElementById("btn-edit").classList.contains("is-active"), true);
  assert.equal(
    doc.getElementById("edit-file"),
    null,
    "the file picker was removed: editing targets the chapter being read",
  );
  assert.equal(doc.getElementById("btn-edit-visual").disabled, false);

  const container = shadowOf(window).querySelector(".reader-body");
  assert.ok(container, "the editable body must exist");
  assert.equal(container.getAttribute("contenteditable"), "true");
  assert.ok(container.classList.contains("is-editing"));
  assert.match(shadowOf(window).innerHTML, /\.reader-body \.epub-keep/);

  // Typing marks the file dirty and the 应用 button posts it to the host.
  container.appendChild(doc.createTextNode("新加的一句话"));
  await settle();
  assert.match(doc.getElementById("edit-status").textContent, /改动待写入|Ctrl\+S/);
  posted.length = 0;
  doc.getElementById("btn-edit-apply").click();
  const applied = lastOfType(posted, "applyEdit");
  assert.ok(applied, `expected an applyEdit, saw [${posted.map((m) => m.type)}]`);
  assert.equal(applied.path, "OPS/text/chapter1.xhtml");
  assert.equal(applied.visual, true);
  assert.match(applied.content, /新加的一句话/);
  assert.match(applied.content, /data-epub-orig-src/, "annotations travel with the edit");

  send({ type: "editApplied", path: "OPS/text/chapter1.xhtml", dirty: true });
  assert.match(doc.getElementById("edit-status").textContent, /已写入草稿/);

  // Links are inert while editing: no navigation request is posted.
  posted.length = 0;
  const link = shadowOf(window).querySelector("a");
  assert.ok(link);
  link.click();
  assert.equal(lastOfType(posted, "openChapter"), undefined);
});

test("reader shortcuts stay off while editing and Ctrl+S saves", async () => {
  resetHostState();
  const { posted, send, window, entries, editContent } = await bootEditFixtures(
    "D:/books/shortcuts.epub",
  );
  const doc = window.document;
  posted.length = 0;
  doc.getElementById("btn-edit").click();
  send(entries);
  send(editContent);

  posted.length = 0;
  press(window, "]");
  press(window, "t");
  press(window, "b");
  assert.equal(posted.length, 0, `editing must swallow reader shortcuts, saw ${posted.map((m) => m.type)}`);

  posted.length = 0;
  doc.dispatchEvent(
    new window.KeyboardEvent("keydown", { key: "s", ctrlKey: true, bubbles: true, cancelable: true }),
  );
  assert.ok(lastOfType(posted, "saveNow"), "Ctrl+S must ask the host to save");

  // Leaving edit mode re-renders the chapter through the reading pipeline.
  posted.length = 0;
  doc.getElementById("btn-edit-exit").click();
  const refresh = lastOfType(posted, "openChapter");
  assert.ok(refresh, `expected a chapter refresh, saw [${posted.map((m) => m.type)}]`);
  assert.equal(refresh.index, 0);
  assert.equal(doc.getElementById("edit-bar").hidden, true);
  assert.equal(doc.getElementById("app").getAttribute("data-edit-mode"), null);
});

test("the source editor takes over and guards pending changes", async () => {
  resetHostState();
  const { posted, send, window, entries, editContent } = await bootEditFixtures(
    "D:/books/source-ui.epub",
  );
  const doc = window.document;
  posted.length = 0;
  doc.getElementById("btn-edit").click();
  send(entries);
  send(editContent);

  // 源码 swaps the visual editor for the raw XHTML of the same chapter.
  posted.length = 0;
  doc.getElementById("btn-edit-source").click();
  expectMessage(posted, {
    type: "requestEdit",
    path: "OPS/text/chapter1.xhtml",
    source: true,
  });

  send({
    type: "editContent",
    path: "OPS/text/chapter1.xhtml",
    kind: "source",
    content: "<html><body><p>原始源码</p></body></html>",
  });
  const area = doc.getElementById("source-editor");
  assert.equal(area.hidden, false);
  assert.equal(doc.getElementById("reading-surface").hidden, true);
  assert.equal(area.value, "<html><body><p>原始源码</p></body></html>");
  assert.equal(doc.getElementById("btn-edit-source").classList.contains("is-active"), true);

  posted.length = 0;
  area.value = "<html><body><p>改过的源码</p></body></html>";
  area.dispatchEvent(new window.Event("input", { bubbles: true }));
  doc.getElementById("btn-edit-apply").click();
  const applied = lastOfType(posted, "applyEdit");
  assert.ok(applied, `expected an applyEdit, saw [${posted.map((m) => m.type)}]`);
  assert.equal(applied.visual, false);
  assert.equal(applied.content, "<html><body><p>改过的源码</p></body></html>");

  // Leaving with un-written changes asks before dropping them.
  area.value = "<html><body><p>又要改</p></body></html>";
  area.dispatchEvent(new window.Event("input", { bubbles: true }));
  press(window, "Escape");
  assert.equal(doc.getElementById("edit-guard").hidden, false);

  posted.length = 0;
  doc.getElementById("guard-discard").click();
  assert.ok(lastOfType(posted, "revertEdit"), "discarding restores the file from disk");
  assert.ok(lastOfType(posted, "openChapter"), "and returns to reading");
  assert.equal(doc.getElementById("edit-guard").hidden, true);
  assert.equal(doc.getElementById("edit-bar").hidden, true);
});

test("the edit button is disabled when the setting turns editing off", async () => {
  resetHostState();
  const { posted, send, window } = await bootEditFixtures("D:/books/readonly-ui.epub");
  const doc = window.document;

  send({
    type: "init",
    book: { title: "测试之书", creator: "测试作者", chapterCount: 3 },
    toc: [],
    settings: { fontSize: 17, lineHeight: 1.75, maxWidth: 46, pageTheme: "auto", rememberProgress: true },
    bookmarks: [],
    startChapter: 0,
    editingEnabled: false,
  });
  assert.equal(doc.getElementById("btn-edit").disabled, true);
  assert.match(doc.getElementById("btn-edit").title, /关闭/);

  posted.length = 0;
  doc.getElementById("btn-edit").click();
  press(window, "e");
  assert.equal(
    posted.length,
    0,
    `a disabled editor must not ask for content, saw [${posted.map((m) => m.type)}]`,
  );
  assert.equal(doc.getElementById("edit-bar").hidden, true);
});

test("editing never clobbers the reading position", async () => {
  resetHostState();
  const { posted, send, window, entries, editContent } = await bootEditFixtures(
    "D:/books/position.epub",
  );
  const doc = window.document;
  const surface = doc.getElementById("reading-surface");

  // Reading mode: scrolling reports progress.
  posted.length = 0;
  surface.dispatchEvent(new window.Event("scroll"));
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.ok(lastOfType(posted, "saveProgress"), "reading scrolls must save progress");

  posted.length = 0;
  doc.getElementById("btn-edit").click();
  send(entries);
  send(editContent);
  assert.equal(doc.getElementById("edit-bar").hidden, false);

  // Scrolling the edit surface says nothing about where reading is.
  posted.length = 0;
  surface.dispatchEvent(new window.Event("scroll"));
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(
    lastOfType(posted, "saveProgress"),
    undefined,
    "editing must not move the reading position",
  );

  // Leaving edit mode returns to the recorded chapter and ratio.
  posted.length = 0;
  doc.getElementById("btn-edit-exit").click();
  const refresh = lastOfType(posted, "openChapter");
  assert.ok(refresh, `expected a chapter refresh, saw [${posted.map((m) => m.type)}]`);
  assert.equal(refresh.index, 0);
  assert.equal(typeof refresh.scrollRatio, "number");
});

test("a forced refresh reloads the file being edited instead of the reading view", async () => {
  resetHostState();
  const { posted, send, window, entries, editContent } = await bootEditFixtures(
    "D:/books/refresh.epub",
  );
  const doc = window.document;
  posted.length = 0;
  doc.getElementById("btn-edit").click();
  send(entries);
  send(editContent);
  assert.equal(doc.getElementById("edit-bar").hidden, false);

  // A save (or an undo, or another panel) arrives as a forced init.
  posted.length = 0;
  send({
    type: "init",
    book: { title: "测试之书", creator: "测试作者", chapterCount: 3 },
    toc: [],
    settings: { fontSize: 17, lineHeight: 1.75, maxWidth: 46, pageTheme: "auto", rememberProgress: true },
    bookmarks: [],
    startChapter: 0,
    forceRender: true,
  });
  const refresh = lastOfType(posted, "requestEdit");
  assert.ok(refresh, `expected the edit content to be reloaded, saw [${posted.map((m) => m.type)}]`);
  assert.equal(refresh.path, "OPS/text/chapter1.xhtml");
  assert.equal(doc.getElementById("edit-bar").hidden, false, "edit mode survives a refresh");

  // A quiet refresh (this panel's own edit) must not reload anything.
  posted.length = 0;
  send({
    type: "init",
    book: { title: "测试之书", creator: "测试作者", chapterCount: 3 },
    toc: [],
    settings: { fontSize: 17, lineHeight: 1.75, maxWidth: 46, pageTheme: "auto", rememberProgress: true },
    bookmarks: [],
    startChapter: 0,
    forceRender: false,
  });
  assert.equal(lastOfType(posted, "requestEdit"), undefined);
  assert.equal(lastOfType(posted, "openChapter"), undefined);
});
