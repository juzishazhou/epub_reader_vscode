import * as vscode from "vscode";
import { listEditableEntries, restoreEditedMarkup, spliceBody } from "../epub/edit";
import { RenderedChapter, renderChapter } from "../epub/render";
import { SearchIndex } from "../epub/search";
import { clamp } from "../epub/util";
import { DocumentEdit, EpubDocument } from "./epubDocument";
import type {
  BookmarkDto,
  ChapterPayload,
  EditableEntryDto,
  HighlightRequest,
  HostToWebviewMessage,
  PageTheme,
  ReaderSettings,
  SearchHitDto,
  WebviewToHostMessage,
} from "./protocol";
import { READER_VIEW_TYPE } from "./protocol";
import { buildErrorShell, buildReaderShell } from "./shell";
import { Bookmark, ReaderStore } from "./storage";

const PROGRESS_FLUSH_DELAY = 800;
const INDEX_CHUNK = 50;

/** One editor panel: owns the webview, the render pipeline and the message loop. */
export class ReaderSession {
  private readonly disposables: vscode.Disposable[] = [];
  private progressTimer: ReturnType<typeof setTimeout> | undefined;
  private pendingProgress: { chapter: number; scrollRatio: number } | undefined;
  private currentChapter = 0;
  private renderToken = 0;
  private disposed = false;
  private indexing = false;
  private clientErrorCount = 0;
  /** Entry this panel is editing, when the client asked for edit mode. */
  private clientEditPath: string | undefined;
  /** Whether the file picker list was already sent to this panel. */
  private editEntriesSent = false;
  /** One warning per panel is enough when VS Code lost the document. */
  private linkWarningShown = false;

  constructor(
    private readonly document: EpubDocument,
    private readonly panel: vscode.WebviewPanel,
    private readonly context: vscode.ExtensionContext,
    private readonly store: ReaderStore,
    /** Hands an undoable edit to VS Code's undo stack. False when VS Code
     * refuses it (its document registry lost this file, see linkBroken). */
    private readonly pushEdit: (edit: DocumentEdit) => boolean = () => false,
  ) {}

  async activate(token: vscode.CancellationToken): Promise<void> {
    const book = this.document.book;
    if (!book || this.document.error) {
      this.panel.webview.options = { enableScripts: false };
      this.panel.webview.html = buildErrorShell(
        titleFromPath(this.document.uri),
        this.document.error ?? "未知错误",
      );
      return;
    }

    const webview = this.panel.webview;
    webview.options = {
      enableScripts: true,
      localResourceRoots: [this.context.extensionUri, this.document.cacheDir],
    };
    webview.html = buildReaderShell(webview, this.context.extensionUri);

    this.disposables.push(
      webview.onDidReceiveMessage((raw: unknown) => {
        void this.onMessage(raw as WebviewToHostMessage);
      }),
      this.document.onDidChange((change) => {
        void this.onDocumentChange(change);
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("epubReader")) {
          this.post({ type: "settings", settings: this.settings() });
        }
      }),
      this.panel.onDidDispose(() => this.dispose()),
      token.onCancellationRequested(() => this.dispose()),
    );
  }

  private async onMessage(message: WebviewToHostMessage): Promise<void> {
    if (this.disposed || !message || typeof message.type !== "string") {
      return;
    }
    switch (message.type) {
      case "ready":
        await this.handleReady();
        return;
      case "openChapter":
        // Any chapter request means the panel is back in reading mode.
        this.clientEditPath = undefined;
        await this.handleOpenChapter(message);
        return;
      case "search":
        await this.handleSearch(message.requestId, message.query);
        return;
      case "saveProgress":
        this.queueProgress(message.chapter, message.scrollRatio);
        return;
      case "addBookmark":
        this.handleAddBookmark(message.chapter, message.scrollRatio, message.label, message.excerpt);
        return;
      case "removeBookmark":
        this.post({
          type: "bookmarks",
          bookmarks: dtoList(this.store.removeBookmark(this.document.bookId, message.id)),
        });
        return;
      case "updateSetting":
        await this.handleUpdateSetting(message.key, message.value);
        return;
      case "openExternal":
        await this.handleOpenExternal(message.url);
        return;
      case "requestEdit":
        await this.handleRequestEdit(message.path, message.source === true);
        return;
      case "applyEdit":
        await this.handleApplyEdit(message.path, message.content, message.visual === true);
        return;
      case "revertEdit":
        await this.handleRevertEdit(message.path);
        return;
      case "saveNow":
        await this.handleSaveNow();
        return;
      case "clientError":
        if (this.clientErrorCount++ < 3) {
          void vscode.window.showWarningMessage(`EPUB View: ${message.message}`);
        }
        return;
      default:
        return;
    }
  }

  private async handleReady(): Promise<void> {
    const book = this.document.book;
    if (!book) {
      return;
    }
    const settings = this.settings();
    const saved = settings.rememberProgress ? this.store.progress(this.document.bookId) : undefined;
    const startChapter =
      saved && saved.chapter >= 0 && saved.chapter < book.chapters.length
        ? Math.floor(saved.chapter)
        : 0;

    let coverUri: string | undefined;
    const coverPath = book.metadata.coverPath;
    if (coverPath) {
      await this.document.ensureExtracted([coverPath]);
      coverUri = this.mediaUri(coverPath);
    }
    if (this.disposed) {
      return;
    }

    this.post({
      type: "init",
      book: {
        title: book.metadata.title,
        creator: book.metadata.creator,
        publisher: book.metadata.publisher,
        language: book.metadata.language,
        description: book.metadata.description,
        chapterCount: book.chapters.length,
        coverUri,
      },
      toc: book.toc,
      settings,
      bookmarks: dtoList(this.store.bookmarks(this.document.bookId)),
      progress: saved ? { chapter: startChapter, scrollRatio: saved.scrollRatio } : undefined,
      startChapter,
      editingEnabled: this.editingEnabled(),
    });

    this.touchRecent(startChapter);
    await this.openChapter(startChapter, { scrollRatio: saved?.scrollRatio });
  }

  private async handleOpenChapter(message: {
    index?: number;
    path?: string;
    fragment?: string;
    scrollRatio?: number;
    highlight?: HighlightRequest;
  }): Promise<void> {
    const book = this.document.book;
    if (!book) {
      return;
    }
    let index: number | undefined;
    if (typeof message.index === "number" && Number.isFinite(message.index)) {
      index = message.index;
    } else if (typeof message.path === "string" && message.path.length > 0) {
      index = book.chapterIndexForPath(message.path);
    }
    if (index === undefined) {
      this.post({ type: "toast", level: "warn", message: "目录里的这一项没有对应正文，已跳过。" });
      return;
    }
    await this.openChapter(index, {
      scrollRatio: typeof message.scrollRatio === "number" ? message.scrollRatio : undefined,
      fragment: message.fragment,
      highlight: message.highlight,
    });
  }

  private async openChapter(
    index: number,
    options: { scrollRatio?: number; fragment?: string; highlight?: HighlightRequest } = {},
  ): Promise<void> {
    const book = this.document.book;
    if (!book || this.disposed) {
      return;
    }
    const token = ++this.renderToken;
    const target = clamp(Math.floor(index), 0, book.chapters.length - 1);

    let rendered: RenderedChapter;
    try {
      rendered = renderChapter(book, target, {
        uriFor: (path) => this.mediaUri(path),
        resolveChapterPath: (path) => {
          const found = book.chapterIndexForPath(path);
          return found === undefined ? undefined : book.chapters[found].path;
        },
        readText: (path) => book.zip.tryReadText(path),
        highlight: options.highlight,
      });
    } catch (error) {
      this.post({ type: "chapterError", index: target, message: messageOf(error) });
      return;
    }

    if (rendered.assets.length > 0) {
      await this.document.ensureExtracted(rendered.assets);
    }
    if (token !== this.renderToken || this.disposed) {
      return;
    }

    const chapter: ChapterPayload = {
      index: rendered.index,
      path: book.chapters[rendered.index].path,
      title: rendered.title,
      body: rendered.body,
      css: rendered.css,
      fragment: options.fragment,
      highlight: options.highlight
        ? { ...options.highlight, found: rendered.highlightFound }
        : undefined,
    };
    this.currentChapter = rendered.index;
    this.progress = { chapter: rendered.index, scrollRatio: options.scrollRatio ?? 0 };
    this.post({ type: "chapter", chapter });
    this.touchRecent(rendered.index);
  }

  /* ------------------------------------------------------------- editing */

  /** Send the current chapter (or a chosen entry) to the edit panel. */
  private async handleRequestEdit(path: string | undefined, source: boolean): Promise<void> {
    if (!this.editingEnabled()) {
      this.post({ type: "toast", level: "warn", message: "编辑功能已在设置里关闭。" });
      return;
    }
    const book = this.document.book;
    if (!book) {
      this.post({ type: "toast", level: "error", message: "书籍当前无法解析，不能进入编辑。" });
      return;
    }
    const target =
      typeof path === "string" && path.length > 0
        ? path
        : book.chapters[this.currentChapter]?.path;
    if (!target) {
      this.post({ type: "toast", level: "warn", message: "没有可编辑的文件。" });
      return;
    }

    if (!this.editEntriesSent) {
      this.postEditEntries();
    }

    const chapterIndex = book.chapterIndexForPath(target);
    if (chapterIndex !== undefined && !source) {
      const token = ++this.renderToken;
      let rendered: RenderedChapter;
      try {
        rendered = renderChapter(book, chapterIndex, {
          uriFor: (assetPath) => this.mediaUri(assetPath),
          resolveChapterPath: (assetPath) => {
            const found = book.chapterIndexForPath(assetPath);
            return found === undefined ? undefined : book.chapters[found].path;
          },
          readText: (assetPath) => book.zip.tryReadText(assetPath),
          fidelity: "edit",
        });
      } catch (error) {
        this.post({ type: "toast", level: "error", message: messageOf(error) });
        return;
      }
      if (rendered.assets.length > 0) {
        await this.document.ensureExtracted(rendered.assets);
      }
      if (token !== this.renderToken || this.disposed) {
        return;
      }
      this.clientEditPath = rendered.index === undefined ? target : book.chapters[rendered.index].path;
      this.post({
        type: "editContent",
        path: target,
        kind: "visual",
        body: rendered.body,
        css: rendered.css,
      });
      return;
    }

    const content = this.document.editableText(target);
    if (content === undefined) {
      this.post({ type: "toast", level: "warn", message: `这个文件不能编辑：${target}` });
      return;
    }
    this.clientEditPath = target;
    this.post({ type: "editContent", path: target, kind: "source", content });
  }

  /** Take edited markup or text from the panel and put it in the document. */
  private async handleApplyEdit(
    path: string,
    content: string,
    visual: boolean,
  ): Promise<void> {
    if (!this.editingEnabled()) {
      this.post({ type: "toast", level: "warn", message: "编辑功能已在设置里关闭。" });
      return;
    }
    if (typeof path !== "string" || path.length === 0 || typeof content !== "string") {
      return;
    }
    let next = content;
    if (visual) {
      const current = this.document.currentText(path);
      if (current === undefined) {
        this.post({ type: "toast", level: "error", message: `无法读取 ${path} 的原文，改动没有写入。` });
        return;
      }
      try {
        next = spliceBody(current, restoreEditedMarkup(content));
      } catch (error) {
        this.post({ type: "toast", level: "error", message: messageOf(error) });
        return;
      }
    }

    const result = this.document.applyEdit(path, next, this);
    if (!result.ok) {
      this.post({ type: "toast", level: "error", message: result.error });
      return;
    }
    if (result.edit && !this.pushEdit(result.edit)) {
      // VS Code's registry no longer knows this file; keep going on our own.
      this.warnAboutBrokenLink();
    }
    this.clientEditPath = path;
    this.post({ type: "editApplied", path, dirty: this.document.dirty });
  }

  /** Put one entry back to the version on disk, as an undoable edit. */
  private async handleRevertEdit(path: string): Promise<void> {
    if (typeof path !== "string" || path.length === 0) {
      return;
    }
    const original = this.document.originalText(path);
    if (original === undefined) {
      this.post({ type: "toast", level: "error", message: `读不到 ${path} 的原始内容。` });
      return;
    }
    const result = this.document.applyEdit(path, original, this);
    if (!result.ok) {
      this.post({ type: "toast", level: "error", message: result.error });
      return;
    }
    if (result.edit && !this.pushEdit(result.edit)) {
      this.warnAboutBrokenLink();
    }
    this.clientEditPath = path;
    this.post({ type: "editApplied", path, dirty: this.document.dirty });
  }

  /** Ctrl+S inside the webview: save through VS Code, or直接写文件 if it cannot. */
  private async handleSaveNow(): Promise<void> {
    if (this.document.linkBroken) {
      await this.saveDirectly();
      return;
    }
    try {
      await vscode.commands.executeCommand("workbench.action.files.save");
    } catch (error) {
      this.post({ type: "toast", level: "warn", message: `保存失败：${messageOf(error)}` });
    }
  }

  /**
   * Save without VS Code's save pipeline. Used when the document registry lost
   * this file, where `workbench.action.files.save` can only fail.
   */
  private async saveDirectly(): Promise<void> {
    if (!this.document.dirty) {
      this.post({ type: "toast", level: "info", message: "没有需要保存的改动。" });
      return;
    }
    try {
      await this.document.writeToDisk();
      this.post({ type: "toast", level: "info", message: "已直接写入 EPUB 文件。" });
    } catch (error) {
      this.post({ type: "toast", level: "error", message: `保存失败：${messageOf(error)}` });
    }
  }

  /**
   * VS Code dropped this document from its own registry (a tab restored after
   * a window reload is the usual cause). Editing still works — we keep the
   * edits — but its undo stack and save command cannot, so say so once and
   * offer the one action that really fixes it.
   */
  private warnAboutBrokenLink(): void {
    if (this.linkWarningShown) {
      return;
    }
    this.linkWarningShown = true;
    this.post({
      type: "toast",
      level: "warn",
      message: "编辑器状态已与 VS Code 失联（重载窗口后常见）：Ctrl+S 将直接写文件，建议重开这本书。",
    });
    void vscode.window
      .showWarningMessage(
        `EPUB View：《${titleFromPath(this.document.uri)}》的编辑器状态与 VS Code 失联了（重载窗口后常见）。` +
          "编辑与保存仍然可用（会直接写文件），但撤销栈不可用。重新打开这本书即可完全恢复。",
        "保存并重新打开",
      )
      .then(
        (choice) => {
          if (choice === "保存并重新打开") {
            void this.reopenBook();
          }
        },
        () => undefined,
      );
  }

  /** Save pending edits, then close and reopen the editor to re-register. */
  private async reopenBook(): Promise<void> {
    const uri = this.document.uri;
    try {
      if (this.document.dirty) {
        await this.document.writeToDisk();
      }
    } catch {
      // Reopening still re-registers the document; unsaved edits stay in the
      // overlay of this instance and are re-applied from the disk copy.
    }
    try {
      await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
      await vscode.commands.executeCommand("vscode.openWith", uri, READER_VIEW_TYPE);
    } catch (error) {
      this.post({ type: "toast", level: "warn", message: `重新打开失败：${messageOf(error)}` });
    }
  }

  private postEditEntries(): void {
    const book = this.document.book;
    if (!book) {
      return;
    }
    const entries: EditableEntryDto[] = listEditableEntries(book);
    this.editEntriesSent = true;
    this.post({ type: "editEntries", entries });
  }

  /**
   * React to an edit, a save or a revert. The panel that caused an edit keeps
   * its in-progress DOM (so the caret does not jump); every other panel — and
   * every panel after a save or an undo — is rebuilt from the new state.
   */
  private async onDocumentChange(change: {
    kind: "edited" | "saved" | "reverted";
    origin?: unknown;
  }): Promise<void> {
    if (this.disposed) {
      return;
    }
    const fromThisPanel = change.origin === this && change.kind === "edited";
    const book = this.document.book;
    if (!book) {
      this.post({
        type: "toast",
        level: "error",
        message: `修改后无法解析这本书：${this.document.error ?? "未知错误"}`,
      });
      return;
    }

    this.panel.title = book.metadata.title || this.panel.title;
    this.editEntriesSent = false;

    const startChapter = clamp(this.currentChapter, 0, book.chapters.length - 1);
    let coverUri: string | undefined;
    const coverPath = book.metadata.coverPath;
    if (coverPath) {
      await this.document.ensureExtracted([coverPath]);
      coverUri = this.mediaUri(coverPath);
    }
    if (this.disposed) {
      return;
    }

    this.post({
      type: "init",
      book: {
        title: book.metadata.title,
        creator: book.metadata.creator,
        publisher: book.metadata.publisher,
        language: book.metadata.language,
        description: book.metadata.description,
        chapterCount: book.chapters.length,
        coverUri,
      },
      toc: book.toc,
      settings: this.settings(),
      bookmarks: dtoList(this.store.bookmarks(this.document.bookId)),
      progress: { chapter: startChapter, scrollRatio: this.progress.scrollRatio },
      startChapter,
      forceRender: !fromThisPanel,
      editingEnabled: this.editingEnabled(),
    });

    // An edit panel keeps editing the file it has; re-rendering the reading
    // surface underneath it would throw the user's caret away. Its client
    // re-requests the edit content itself when `forceRender` was set.
    if (this.clientEditPath !== undefined) {
      return;
    }
    await this.openChapter(startChapter, { scrollRatio: this.progress.scrollRatio });
  }

  private async handleSearch(requestId: number, rawQuery: string): Promise<void> {
    const index = this.document.searchIndex;
    const query = rawQuery.trim();
    if (!index || query.length === 0) {
      this.post({
        type: "searchResults",
        results: {
          requestId,
          query,
          hits: [],
          totalMatches: 0,
          truncated: false,
          indexedChapters: 0,
          elapsedMs: 0,
        },
      });
      return;
    }

    await this.ensureIndexed(index);
    if (this.disposed) {
      return;
    }

    const started = Date.now();
    const outcome = index.search(query, { maxPerChapter: 6, maxTotal: 300 });
    const hits: SearchHitDto[] = [];
    for (const result of outcome.results) {
      for (const hit of result.hits) {
        hits.push({
          chapter: result.index,
          chapterTitle: result.title,
          occurrence: hit.occurrence,
          snippet: hit.snippet,
        });
      }
    }
    this.post({
      type: "searchResults",
      results: {
        requestId,
        query,
        hits,
        totalMatches: outcome.totalMatches,
        truncated: outcome.truncated,
        indexedChapters: index.builtChapters,
        elapsedMs: Date.now() - started,
      },
    });
  }

  /** Build the full-text index in chunks, keeping the extension host responsive. */
  private async ensureIndexed(index: SearchIndex): Promise<void> {
    if (index.builtChapters >= index.chapterCount || this.indexing) {
      return;
    }
    const total = index.chapterCount;
    this.indexing = true;
    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "EPUB View：建立全文索引",
          cancellable: false,
        },
        async (progress) => {
          for (let i = 0; i < total; i++) {
            index.text(i);
            if (i % INDEX_CHUNK === INDEX_CHUNK - 1 || i === total - 1) {
              progress.report({
                message: `${i + 1} / ${total} 章`,
                increment: (INDEX_CHUNK / total) * 100,
              });
              await new Promise((resolve) => setImmediate(resolve));
            }
          }
        },
      );
    } finally {
      this.indexing = false;
    }
  }

  private handleAddBookmark(
    chapter: number,
    scrollRatio: number,
    label: string,
    excerpt: string,
  ): void {
    const safeChapter = Math.max(0, Math.floor(chapter));
    const bookmark: Bookmark = {
      id: `${safeChapter}-${Math.round(scrollRatio * 10000)}-${Date.now().toString(36)}`,
      chapter: safeChapter,
      scrollRatio: clamp(scrollRatio, 0, 1),
      label: label.slice(0, 120) || `第 ${safeChapter + 1} 节`,
      excerpt: excerpt.replace(/\s+/g, " ").trim().slice(0, 200),
      createdAt: Date.now(),
    };
    const list = this.store.addBookmark(this.document.bookId, bookmark);
    this.post({ type: "bookmarks", bookmarks: dtoList(list), addedId: bookmark.id });
    this.post({ type: "toast", level: "info", message: "已添加书签" });
  }

  private async handleUpdateSetting(
    key: keyof ReaderSettings,
    value: number | string | boolean,
  ): Promise<void> {
    if (!SETTING_KEYS.has(key)) {
      return;
    }
    try {
      await vscode.workspace
        .getConfiguration("epubReader")
        .update(key, value, vscode.ConfigurationTarget.Global);
    } catch (error) {
      this.post({ type: "toast", level: "warn", message: `设置保存失败：${messageOf(error)}` });
    }
  }

  private async handleOpenExternal(url: string): Promise<void> {
    if (!/^https?:\/\//i.test(url)) {
      return;
    }
    await vscode.env.openExternal(vscode.Uri.parse(url));
  }

  private queueProgress(chapter: number, scrollRatio: number): void {
    if (!this.settings().rememberProgress) {
      return;
    }
    this.pendingProgress = { chapter: Math.floor(chapter), scrollRatio: clamp(scrollRatio, 0, 1) };
    if (this.progressTimer) {
      return;
    }
    this.progressTimer = setTimeout(() => {
      this.progressTimer = undefined;
      this.flushProgress();
    }, PROGRESS_FLUSH_DELAY);
  }

  private flushProgress(): void {
    const pending = this.pendingProgress;
    this.pendingProgress = undefined;
    if (!pending || this.disposed) {
      return;
    }
    this.progress = pending;
    this.store.setProgress(this.document.bookId, pending.chapter, pending.scrollRatio);
    this.touchRecent(pending.chapter);
  }

  private touchRecent(chapter: number): void {
    const book = this.document.book;
    if (!book) {
      return;
    }
    this.store.touchRecent({
      bookId: this.document.bookId,
      fsPath: this.document.uri.fsPath,
      title: book.metadata.title,
      chapter,
      chapterTitle: book.chapters[chapter]?.title ?? "",
    });
  }

  private progress: { chapter: number; scrollRatio: number } = { chapter: 0, scrollRatio: 0 };

  private settings(): ReaderSettings {
    const config = vscode.workspace.getConfiguration("epubReader");
    const theme = config.get<string>("pageTheme", "auto");
    return {
      fontSize: clamp(config.get<number>("fontSize", 17), 12, 40),
      lineHeight: clamp(config.get<number>("lineHeight", 1.75), 1.2, 3),
      maxWidth: clamp(config.get<number>("maxWidth", 46), 24, 120),
      pageTheme: (["auto", "light", "sepia", "dark"].includes(theme) ? theme : "auto") as PageTheme,
      rememberProgress: config.get<boolean>("rememberProgress", true),
    };
  }

  /** Whether the user allows writing edits back into the file. */
  private editingEnabled(): boolean {
    return vscode.workspace.getConfiguration("epubReader").get<boolean>("enableEditing", true);
  }

  private mediaUri(zipPath: string): string | undefined {
    const book = this.document.book;
    if (!book || !book.zip.has(zipPath)) {
      return undefined;
    }
    return this.panel.webview.asWebviewUri(this.document.fileUri(zipPath)).toString();
  }

  private post(message: HostToWebviewMessage): void {
    if (this.disposed) {
      return;
    }
    void this.panel.webview.postMessage(message).then(undefined, () => {
      /* the panel may be gone already */
    });
  }

  private dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    if (this.progressTimer) {
      clearTimeout(this.progressTimer);
      this.progressTimer = undefined;
    }
    this.pendingProgress = this.pendingProgress ?? {
      chapter: this.currentChapter,
      scrollRatio: this.progress.scrollRatio,
    };
    this.flushProgress();
    for (const disposable of this.disposables.splice(0)) {
      disposable.dispose();
    }
  }
}

const SETTING_KEYS = new Set<string>([
  "fontSize",
  "lineHeight",
  "maxWidth",
  "pageTheme",
  "rememberProgress",
]);

function dtoList(bookmarks: readonly Bookmark[]): BookmarkDto[] {
  return bookmarks.map((bookmark) => ({ ...bookmark }));
}

function titleFromPath(uri: vscode.Uri): string {
  const base = uri.path.slice(uri.path.lastIndexOf("/") + 1);
  return base.replace(/\.epub$/i, "");
}

function messageOf(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
