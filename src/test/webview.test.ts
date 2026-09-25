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
