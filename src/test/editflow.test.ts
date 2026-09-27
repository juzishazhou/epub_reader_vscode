import { strict as assert } from "node:assert";
import { test } from "node:test";
import { openEpub } from "../epub/book";
import { ZipArchive } from "../epub/zip";
import type { EpubDocument } from "../editor/epubDocument";
import type { EditableEntryDto } from "../editor/protocol";
import { createEpub3, EXPECTED_PATHS } from "./helpers/fixtures";
import { attachPanel, openDocument, openPanel } from "./helpers/hostHarness";
import {
  FakeUri,
  configurationStore,
  executedCommands,
  fakeFs,
  neverCancelled,
  registeredProvider,
  resetHostState,
} from "./helpers/vscodeMock";

const EPUB_PATH = "D:/books/edit.epub";
const CHAPTER = EXPECTED_PATHS.epub3.chapter1;
const CSS = EXPECTED_PATHS.epub3.mainCss;
const OPF = "OPS/package.opf";

interface EditContentMessage {
  type: "editContent";
  path: string;
  kind: "visual" | "source";
  body?: string;
  css?: string[];
  content?: string;
}

function savedBytes(path: string = EPUB_PATH): Buffer {
  const bytes = fakeFs.files.get(FakeUri.file(path).path);
  assert.ok(bytes, "the epub must exist on the fake disk");
  return Buffer.from(bytes);
}

/** Text of an entry, failing loudly when it is missing. */
function textOf(document: EpubDocument, path: string): string {
  const text = document.currentText(path);
  assert.ok(text !== undefined, `expected text for ${path}`);
  return text;
}

/**
 * Whether the document currently parses. Written as a helper so that
 * assertions cannot narrow `document.book` for the rest of a test.
 */
function hasParsedBook(document: EpubDocument): boolean {
  return document.book !== undefined;
}

test("visual editing: apply, undo, redo and save", async () => {
  resetHostState();
  const bytes = createEpub3();
  const { panel, document } = await openPanel(EPUB_PATH, bytes);

  const mark = panel.webview.count();
  await panel.webview.send({ type: "ready" });
  await panel.webview.waitFor("chapter", { after: mark });

  const changes: any[] = [];
  registeredProvider!.provider.onDidChangeCustomDocument((event: any) => changes.push(event));

  // Enter edit mode on the current chapter.
  const editMark = panel.webview.count();
  await panel.webview.send({ type: "requestEdit" });
  const entries = await panel.webview.waitFor<{ entries: EditableEntryDto[] }>("editEntries", {
    after: editMark,
  });
  assert.ok(entries.entries.some((entry) => entry.path === CHAPTER && entry.isChapter));
  assert.ok(entries.entries.some((entry) => entry.path === CSS && !entry.isChapter));

  const content = await panel.webview.waitFor<EditContentMessage>("editContent", { after: editMark });
  assert.equal(content.kind, "visual");
  assert.equal(content.path, CHAPTER);
  assert.match(content.body!, /data-epub-orig-src="\.\.\/images\/diagram\.svg"/);
  assert.match(content.body!, /src="webview:.*diagram\.svg"/);
  assert.ok(content.css!.length >= 2, "head stylesheets still feed the edit render");

  // The client sends its edited container markup back.
  const applied = content.body!.replace("正文段落", "改写后的正文");
  const applyMark = panel.webview.count();
  await panel.webview.send({
    type: "applyEdit",
    path: CHAPTER,
    content: applied,
    visual: true,
  });
  const appliedMessage = await panel.webview.waitFor<{ dirty: boolean }>("editApplied", {
    after: applyMark,
  });
  assert.equal(appliedMessage.dirty, true);
  assert.equal(document.dirty, true);
  assert.equal(changes.length, 1, "each applied edit becomes one undo step");
  assert.match(textOf(document, CHAPTER), /改写后的正文/);
  // The file on disk is untouched until a save.
  assert.match(ZipArchive.open(savedBytes()).readText(CHAPTER), /正文段落/);

  // VS Code driven undo and redo.
  changes[0].undo();
  assert.equal(document.dirty, false);
  assert.match(textOf(document, CHAPTER), /正文段落/);
  changes[0].redo();
  assert.match(textOf(document, CHAPTER), /改写后的正文/);

  // Save writes a rewritten archive, in place: no temporary sibling may
  // appear, because a vanishing resource confuses VS Code's editor bookkeeping.
  await registeredProvider!.provider.saveCustomDocument(document, neverCancelled);
  assert.equal(document.dirty, false);
  for (const path of fakeFs.files.keys()) {
    assert.ok(!path.includes("epubview-save"), `unexpected temporary file ${path}`);
  }
  const written = ZipArchive.open(savedBytes());
  const chapterText = written.readText(CHAPTER);
  assert.match(chapterText, /改写后的正文/);
  // Everything the reader hides came back exactly as authored.
  assert.match(chapterText, /<script>alert\('should never run'\)<\/script>/);
  assert.match(chapterText, /onclick="evil\(\)"/);
  assert.match(chapterText, /src="\.\.\/images\/diagram\.svg"/);
  assert.ok(!chapterText.includes("webview:"), "no webview URI may leak into the file");
  assert.ok(!chapterText.includes("data-epub-orig-"));
  assert.ok(!chapterText.includes("epub-keep"));
  // Untouched entries keep their content, and the book still parses.
  assert.match(written.readText(CSS), /@import/);
  assert.match(written.readText(OPF), /<dc:title>测试之书<\/dc:title>/);
  const reopened = openEpub(savedBytes());
  assert.equal(reopened.chapters.length, 3);
  assert.equal(reopened.metadata.title, "测试之书");
});

test("source editing a stylesheet changes how chapters render", async () => {
  resetHostState();
  const { panel, document } = await openPanel(EPUB_PATH, createEpub3());
  const mark = panel.webview.count();
  await panel.webview.send({ type: "ready" });
  await panel.webview.waitFor("chapter", { after: mark });

  const editMark = panel.webview.count();
  await panel.webview.send({ type: "requestEdit", path: CSS });
  const content = await panel.webview.waitFor<EditContentMessage>("editContent", { after: editMark });
  assert.equal(content.kind, "source");
  assert.match(content.content!, /p\.lead \{ background/);

  const next = `${content.content}\np.lead { color: rebeccapurple; }`;
  await panel.webview.send({ type: "applyEdit", path: CSS, content: next, visual: false });
  await panel.webview.waitFor("editApplied", { after: editMark });
  assert.match(textOf(document, CSS), /rebeccapurple/);

  // Re-opening the chapter inlines the edited stylesheet.
  const chapterMark = panel.webview.count();
  await panel.webview.send({ type: "openChapter", index: 0 });
  const chapter = await panel.webview.waitFor<{ chapter: { css: string[] } }>("chapter", {
    after: chapterMark,
  });
  assert.ok(
    chapter.chapter.css.some((sheet) => sheet.includes("rebeccapurple")),
    "the edited stylesheet must reach the render pipeline",
  );
});

test("reverting one file restores the version on disk", async () => {
  resetHostState();
  const { panel, document } = await openPanel(EPUB_PATH, createEpub3());
  const mark = panel.webview.count();
  await panel.webview.send({ type: "ready" });
  await panel.webview.waitFor("chapter", { after: mark });

  await panel.webview.send({ type: "applyEdit", path: CSS, content: "p { color: red; }", visual: false });
  await panel.webview.waitFor("editApplied");
  assert.match(textOf(document, CSS), /color: red/);

  const revertMark = panel.webview.count();
  await panel.webview.send({ type: "revertEdit", path: CSS });
  await panel.webview.waitFor("editApplied", { after: revertMark });
  assert.equal(document.dirty, false);
  const restoredSheet = document.currentText(CSS);
  assert.ok(restoredSheet);
  assert.match(restoredSheet, /@import/);
  assert.ok(!restoredSheet.includes("color: red"));
});

test("a save request from the webview asks VS Code to save", async () => {
  resetHostState();
  const { panel } = await openPanel(EPUB_PATH, createEpub3());
  const mark = panel.webview.count();
  await panel.webview.send({ type: "ready" });
  await panel.webview.waitFor("chapter", { after: mark });

  await panel.webview.send({ type: "saveNow" });
  assert.deepEqual(executedCommands, ["workbench.action.files.save"]);
});

test("pending edits survive a hot-exit backup round trip", async () => {
  resetHostState();
  const bytes = createEpub3();
  const { panel, document } = await openPanel(EPUB_PATH, bytes);
  const mark = panel.webview.count();
  await panel.webview.send({ type: "ready" });
  await panel.webview.waitFor("chapter", { after: mark });

  await panel.webview.send({
    type: "applyEdit",
    path: CHAPTER,
    content: `${BOOK_TEXT}<p>备份里的改动</p>`,
    visual: false,
  });
  await panel.webview.waitFor("editApplied");
  assert.equal(document.dirty, true);

  const backup = await registeredProvider!.provider.backupCustomDocument(
    document,
    { destination: FakeUri.file("D:/backup"), isNew: true } as never,
    neverCancelled,
  );
  assert.match(backup.id, /epub-view-edits\.json/);
  assert.ok(fakeFs.files.has("D:/backup/epub-view-edits.json"));

  // Simulate a restart: the same file is opened from the backup id.
  const restored = await openDocument(EPUB_PATH, bytes, { backupId: backup.id });
  assert.equal(restored.dirty, true);
  const restoredChapter = restored.currentText(CHAPTER);
  assert.ok(restoredChapter);
  assert.match(restoredChapter, /备份里的改动/);
  assert.ok(!fakeFs.files.has("D:/backup/epub-view-edits.json"), "the backup is consumed once read");

  // A document without edits backs up to a no-op.
  const clean = await openDocument("D:/books/clean.epub", bytes);
  const empty = await registeredProvider!.provider.backupCustomDocument(
    clean,
    { destination: FakeUri.file("D:/backup"), isNew: true } as never,
    neverCancelled,
  );
  assert.match(empty.id, /clean/);
});

test("an edit that breaks the package is reported and can be undone", async () => {
  resetHostState();
  const { panel, document } = await openPanel(EPUB_PATH, createEpub3());
  const mark = panel.webview.count();
  await panel.webview.send({ type: "ready" });
  await panel.webview.waitFor("chapter", { after: mark });

  const brokenMark = panel.webview.count();
  await panel.webview.send({ type: "applyEdit", path: OPF, content: "<package", visual: false });
  const toast = await panel.webview.waitFor<{ level: string; message: string }>("toast", {
    after: brokenMark,
  });
  assert.equal(toast.level, "error");
  assert.match(toast.message, /无法解析/);
  assert.equal(hasParsedBook(document), false, "a broken package leaves no parsed book");
  assert.ok(document.error, "the parse failure must be visible to the host");

  // The edit is still filed, so it can be undone or reverted.
  assert.equal(document.dirty, true);
  const revertMark = panel.webview.count();
  await panel.webview.send({ type: "revertEdit", path: OPF });
  await panel.webview.waitFor("editApplied", { after: revertMark });
  assert.equal(document.dirty, false);
  assert.equal(hasParsedBook(document), true, "reverting the broken file brings the book back");
  assert.equal(document.book?.chapters.length, 3);
});

test("keeps editing when VS Code no longer knows the document", async () => {
  // Reproduces a tab restored after a window reload: VS Code's custom document
  // registry has no entry for it, so every change event it receives throws
  // "No custom document found" — which used to break editing and saving.
  resetHostState();
  const bytes = createEpub3();
  const { panel, document } = await openPanel("D:/books/stale.epub", bytes);
  const mark = panel.webview.count();
  await panel.webview.send({ type: "ready" });
  await panel.webview.waitFor("chapter", { after: mark });

  let fired = 0;
  registeredProvider!.provider.onDidChangeCustomDocument(() => {
    fired++;
    throw new Error("No custom document found");
  });

  const editMark = panel.webview.count();
  await panel.webview.send({ type: "requestEdit" });
  const content = await panel.webview.waitFor<EditContentMessage>("editContent", { after: editMark });

  const applyMark = panel.webview.count();
  await panel.webview.send({
    type: "applyEdit",
    path: CHAPTER,
    content: content.body!.replace("正文段落", "失联后照样能改"),
    visual: true,
  });
  const applied = await panel.webview.waitFor<{ dirty: boolean }>("editApplied", { after: applyMark });
  assert.equal(applied.dirty, true, "the edit still lands in the document");
  assert.equal(document.linkBroken, true);
  assert.equal(fired, 1, "VS Code is asked once, then we stop poking it");
  const warning = panel.webview
    .messages<{ level: string; message: string }>("toast")
    .some((toast) => toast.level === "warn" && /失联/.test(toast.message));
  assert.ok(warning, "the panel must be told that VS Code lost the document");

  // A second edit must not throw again on VS Code's side.
  await panel.webview.send({
    type: "applyEdit",
    path: CHAPTER,
    content: `${content.body!.replace("正文段落", "第二次修改")}`,
    visual: true,
  });
  await panel.webview.waitFor("editApplied", { after: applyMark });
  assert.equal(fired, 1);

  // Ctrl+S now writes the file directly instead of asking VS Code to save.
  executedCommands.length = 0;
  const saveMark = panel.webview.count();
  await panel.webview.send({ type: "saveNow" });
  await panel.webview.waitFor("toast", { after: saveMark });
  assert.ok(
    !executedCommands.includes("workbench.action.files.save"),
    "the broken save path must not be used",
  );
  assert.equal(document.dirty, false);
  assert.match(ZipArchive.open(savedBytes("D:/books/stale.epub")).readText(CHAPTER), /第二次修改/);
});

test("the enableEditing setting keeps the reader read-only", async () => {
  resetHostState();
  const { panel, document } = await openPanel("D:/books/readonly.epub", createEpub3());
  const mark = panel.webview.count();
  await panel.webview.send({ type: "ready" });
  const init = await panel.webview.waitFor<{ editingEnabled?: boolean }>("init", { after: mark });
  assert.equal(init.editingEnabled, true, "editing is on by default");
  await panel.webview.waitFor("chapter", { after: mark });

  configurationStore.set("enableEditing", false);

  const editMark = panel.webview.count();
  await panel.webview.send({ type: "requestEdit" });
  const toast = await panel.webview.waitFor<{ level: string; message: string }>("toast", {
    after: editMark,
  });
  assert.equal(toast.level, "warn");
  assert.match(toast.message, /关闭/);
  assert.equal(panel.webview.messages("editContent").length, 0);

  // A stray applyEdit message is refused too: nothing can dirty the document.
  await panel.webview.send({
    type: "applyEdit",
    path: CHAPTER,
    content: "<html><body><p>偷偷改</p></body></html>",
    visual: false,
  });
  assert.equal(document.dirty, false);
  assert.equal(panel.webview.messages("editApplied").length, 0);

  // Turning it back on restores editing.
  configurationStore.set("enableEditing", true);
  const againMark = panel.webview.count();
  await panel.webview.send({ type: "requestEdit" });
  const content = await panel.webview.waitFor<EditContentMessage>("editContent", { after: againMark });
  assert.equal(content.path, CHAPTER);
});

test("an edit in one panel refreshes the other panel showing the same book", async () => {
  resetHostState();
  const bytes = createEpub3();
  const document = await openDocument(EPUB_PATH, bytes);
  const first = await attachPanel(document);
  const second = await attachPanel(document);

  for (const panel of [first, second]) {
    const mark = panel.webview.count();
    await panel.webview.send({ type: "ready" });
    await panel.webview.waitFor("chapter", { after: mark });
  }

  // Panel one goes into edit mode, so it is the origin of the change.
  const editMark = first.webview.count();
  await first.webview.send({ type: "requestEdit" });
  const content = await first.webview.waitFor<EditContentMessage>("editContent", { after: editMark });

  const secondMark = second.webview.count();
  const firstMark = first.webview.count();
  await first.webview.send({
    type: "applyEdit",
    path: CHAPTER,
    content: content.body!.replace("正文段落", "另一个面板也该看到"),
    visual: true,
  });
  await first.webview.waitFor("editApplied", { after: firstMark });

  // The editing panel keeps its DOM: a quiet refresh, no re-render.
  const firstInit = await first.webview.waitFor<{ forceRender?: boolean }>("init", { after: firstMark });
  assert.equal(firstInit.forceRender, false);
  assert.equal(first.webview.messages("chapter").length, 1, "the editor keeps its surface");

  // The reading panel is rebuilt from the new state.
  const secondInit = await second.webview.waitFor<{ forceRender?: boolean }>("init", { after: secondMark });
  assert.equal(secondInit.forceRender, true);
  const secondChapter = await second.webview.waitFor<{ chapter: { body: string } }>("chapter", {
    after: secondMark,
  });
  assert.match(secondChapter.chapter.body, /另一个面板也该看到/);
});

/** A minimal valid chapter document used as an edit payload. */
const BOOK_TEXT = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>第一章 起点</title></head>
<body><h1>第一章 起点</h1></body>
</html>`;
