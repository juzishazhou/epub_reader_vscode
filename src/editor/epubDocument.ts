import * as path from "node:path";
import * as vscode from "vscode";
import { EpubBook, openEpubFromArchive } from "../epub/book";
import { isEditableTextEntry, normalizeWrittenText } from "../epub/edit";
import { SearchIndex } from "../epub/search";
import { sha1, sanitizeZipPath } from "../epub/util";
import { ZipArchive } from "../epub/zip";
import { rewriteZip } from "../epub/zipwrite";

const CACHE_ROOT_SEGMENT = "books";

/** What changed about an open document; panels use it to refresh themselves. */
export interface DocumentChange {
  kind: "edited" | "saved" | "reverted";
  /** The session that caused the change, when an edit panel caused it. */
  origin?: unknown;
}

/** One undoable step, in the shape VS Code's custom editor API wants it. */
export interface DocumentEdit {
  label: string;
  undo(): void;
  redo(): void;
}

export type ApplyEditResult =
  | { ok: true; edit: DocumentEdit | undefined }
  | { ok: false; error: string };

/**
 * One opened `.epub`: the parsed book, its on-disk asset cache, the lazy
 * full-text index and the pending text edits. Shared by every editor panel
 * showing the same file, so an edit in one panel refreshes all of them.
 *
 * Edits live as an overlay of in-zip path → new text on top of the original
 * bytes. The book is re-parsed from that overlay, so the reader shows edits
 * immediately while the file on disk stays untouched until a save commits the
 * rewritten archive.
 */
export class EpubDocument implements vscode.CustomDocument {
  private readonly uriCache = new Map<string, vscode.Uri>();
  private readonly extraction = new Map<string, Promise<void>>();
  private readonly extracted = new Set<string>();
  /** Pending edits: in-zip path → replacement text. */
  private readonly edits = new Map<string, string>();
  private readonly changeEmitter = new vscode.EventEmitter<DocumentChange>();

  private data: Buffer;
  private archive: ZipArchive | undefined;
  /** Lazily opened copy of the on-disk bytes, for "revert this file". */
  private pristine: ZipArchive | undefined;
  private parsed: EpubBook | undefined;
  private failure: string | undefined;
  /** Set when VS Code rejects our change events (stale document registry). */
  private linkFailure: string | undefined;
  private revision: string;
  private cache: vscode.Uri;
  private index: SearchIndex | undefined;

  /** Fires on every edit, save and revert so panels can refresh. */
  readonly onDidChange = this.changeEmitter.event;

  private constructor(
    readonly uri: vscode.Uri,
    /** Stable identity of the book, derived from its location on disk. */
    readonly bookId: string,
    private readonly baseDir: vscode.Uri,
    private readonly fallbackTitle: string,
    data: Buffer,
  ) {
    this.data = data;
    this.revision = sha1(data).slice(0, 12);
    this.cache = vscode.Uri.joinPath(baseDir, this.revision);
    this.rebuild();
  }

  static async open(
    context: vscode.ExtensionContext,
    uri: vscode.Uri,
    data: Buffer,
    restoredEdits?: Record<string, string>,
  ): Promise<EpubDocument> {
    const bookId = sha1(uri.fsPath.toLowerCase()).slice(0, 16);
    const base = vscode.Uri.joinPath(context.globalStorageUri, CACHE_ROOT_SEGMENT, bookId);
    const document = new EpubDocument(
      uri,
      bookId,
      base,
      path.basename(uri.fsPath, path.extname(uri.fsPath)),
      data,
    );
    document.restoreEdits(restoredEdits);
    if (document.book) {
      void pruneSiblingCaches(base, document.contentHash);
    }
    return document;
  }

  get book(): EpubBook | undefined {
    return this.parsed;
  }

  get error(): string | undefined {
    return this.failure;
  }

  /** Revision of the *current* state, edits included. */
  get contentHash(): string {
    return this.revision;
  }

  /** Directory holding extracted assets for exactly this revision. */
  get cacheDir(): vscode.Uri {
    return this.cache;
  }

  /** True while edits are waiting to be written to disk. */
  get dirty(): boolean {
    return this.edits.size > 0;
  }

  get editedPaths(): string[] {
    return Array.from(this.edits.keys());
  }

  /**
   * True when VS Code's own bookkeeping for this document is gone.
   *
   * VS Code keeps a registry of custom documents keyed by view type plus
   * resource, and it drops an entry when an editor input is disposed. A tab
   * restored after a window reload can therefore keep working while the new
   * extension host has no document for it: every `onDidChangeCustomDocument`
   * event and every save then fails with "No custom document found" inside
   * VS Code. When that happens we stop talking to that registry, keep the
   * edits ourselves and write the file directly.
   */
  get linkBroken(): boolean {
    return this.linkFailure !== undefined;
  }

  get linkFailureReason(): string | undefined {
    return this.linkFailure;
  }

  markLinkBroken(reason: string): void {
    if (this.linkFailure === undefined) {
      this.linkFailure = reason;
    }
  }

  /** Lazily created full-text index over the spine. */
  get searchIndex(): SearchIndex | undefined {
    if (!this.parsed) {
      return undefined;
    }
    if (!this.index) {
      this.index = new SearchIndex(this.parsed);
    }
    return this.index;
  }

  /**
   * Apply one text edit to the in-memory book. Returns the undo/redo step to
   * hand to VS Code, or a message explaining why the edit was refused.
   */
  applyEdit(zipPath: string, nextText: string, origin?: unknown): ApplyEditResult {
    const archive = this.archive;
    if (!archive) {
      return { ok: false, error: `EPUB 当前无法解析，改不动：${this.failure ?? "未知错误"}` };
    }
    if (!archive.has(zipPath)) {
      return { ok: false, error: `EPUB 中不存在条目：${zipPath}` };
    }
    if (!isEditableTextEntry(zipPath)) {
      return { ok: false, error: `该条目不支持编辑：${zipPath}` };
    }
    const previousText = archive.tryReadText(zipPath);
    if (previousText === undefined) {
      return { ok: false, error: `该条目无法按文本读取：${zipPath}` };
    }

    const normalized = normalizeWrittenText(previousText, nextText);
    if (normalized === previousText) {
      return { ok: true, edit: undefined };
    }
    // Typing a file back to exactly what is on disk leaves nothing to save.
    const pristine = this.originalText(zipPath);
    const replacement = pristine !== undefined && normalized === pristine ? undefined : normalized;

    const before = this.edits.get(zipPath);
    const apply = (text: string | undefined): void => {
      if (text === undefined) {
        this.edits.delete(zipPath);
      } else {
        this.edits.set(zipPath, text);
      }
      this.rebuild();
      this.changeEmitter.fire({ kind: "edited", origin });
    };

    apply(replacement);

    return {
      ok: true,
      edit: {
        label: `编辑 ${zipPath}`,
        undo: () => apply(before),
        redo: () => apply(replacement),
      },
    };
  }

  /** Current text of an entry, edits included. */
  currentText(zipPath: string): string | undefined {
    return this.archive?.tryReadText(zipPath);
  }

  /** Text of an entry as it is on disk, ignoring every pending edit. */
  originalText(zipPath: string): string | undefined {
    if (!this.pristine) {
      try {
        this.pristine = ZipArchive.open(this.data);
      } catch {
        return undefined;
      }
    }
    return this.pristine.tryReadText(zipPath);
  }

  /** Text of an entry when it may be edited, otherwise `undefined`. */
  editableText(zipPath: string): string | undefined {
    const archive = this.archive;
    if (!archive || !archive.has(zipPath) || !isEditableTextEntry(zipPath)) {
      return undefined;
    }
    return archive.tryReadText(zipPath);
  }

  /** The whole EPUB with every edit applied, or `undefined` when clean. */
  assembleEditedBytes(): Buffer | undefined {
    if (this.edits.size === 0 || !this.archive) {
      return undefined;
    }
    return rewriteZip(this.archive);
  }

  /**
   * Write the edited archive back into the original file.
   *
   * The write is deliberately in place: replacing the file through a temporary
   * sibling makes VS Code see the resource disappear, which is exactly the
   * kind of churn a watched custom editor must not provoke. Returns `false`
   * when there was nothing to save.
   */
  async writeToDisk(): Promise<boolean> {
    const bytes = this.assembleEditedBytes();
    if (!bytes) {
      return false;
    }
    await vscode.workspace.fs.writeFile(this.uri, bytes);
    this.commitSave(bytes);
    return true;
  }

  /** Called by the provider after the rewritten archive hit the disk. */
  commitSave(bytes: Buffer): void {
    this.data = bytes;
    this.edits.clear();
    this.rebuild();
    void pruneSiblingCaches(this.baseDir, this.revision);
    this.changeEmitter.fire({ kind: "saved" });
  }

  /** Drop every pending edit, going back to what is on disk. */
  revertAll(): void {
    if (this.edits.size === 0) {
      return;
    }
    this.edits.clear();
    this.rebuild();
    this.changeEmitter.fire({ kind: "reverted" });
  }

  /** Pending edits as plain data, for hot-exit backups. */
  editsSnapshot(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [name, content] of this.edits) {
      out[name] = content;
    }
    return out;
  }

  /** Deterministic cache location for an in-zip asset (no disk check). */
  fileUri(zipPath: string): vscode.Uri {
    const cached = this.uriCache.get(zipPath);
    if (cached) {
      return cached;
    }
    const real = this.archive?.realName(zipPath) ?? zipPath;
    const segments = sanitizeZipPath(real).split("/").filter((segment) => segment.length > 0);
    const uri = vscode.Uri.joinPath(this.cache, ...(segments.length > 0 ? segments : ["_"]));
    this.uriCache.set(zipPath, uri);
    return uri;
  }

  /** Extract assets on demand so the webview can load them by URI. */
  async ensureExtracted(zipPaths: readonly string[]): Promise<void> {
    if (!this.archive) {
      return;
    }
    const jobs: Promise<void>[] = [];
    for (const zipPath of zipPaths) {
      if (zipPath.length === 0 || this.extracted.has(zipPath)) {
        continue;
      }
      const pending = this.extraction.get(zipPath);
      if (pending) {
        jobs.push(pending);
        continue;
      }
      const job = this.extractOne(zipPath).finally(() => {
        this.extraction.delete(zipPath);
      });
      this.extraction.set(zipPath, job);
      jobs.push(job);
    }
    if (jobs.length > 0) {
      await Promise.all(jobs);
    }
  }

  private async extractOne(zipPath: string): Promise<void> {
    const archive = this.archive;
    if (!archive) {
      return;
    }
    try {
      const data = archive.read(zipPath);
      const target = this.fileUri(zipPath);
      await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(target, ".."));
      await vscode.workspace.fs.writeFile(target, data);
      this.extracted.add(zipPath);
    } catch {
      // A broken resource must not break reading: the webview just shows a gap.
    }
  }

  private restoreEdits(restored: Record<string, string> | undefined): void {
    if (!restored) {
      return;
    }
    for (const [name, content] of Object.entries(restored)) {
      if (typeof content === "string" && this.editableText(name) !== undefined) {
        this.edits.set(name, content);
      }
    }
    if (this.edits.size > 0) {
      this.rebuild();
    }
  }

  /**
   * Re-parse the book from the original bytes plus the current edit overlay.
   * Also re-derives the asset-cache revision, because an edited stylesheet can
   * change which files a chapter pulls in.
   */
  private rebuild(): void {
    this.uriCache.clear();
    this.extracted.clear();
    this.extraction.clear();
    this.index = undefined;
    this.archive = undefined;
    this.pristine = undefined;
    this.parsed = undefined;
    this.failure = undefined;
    this.revision = this.computeRevision();
    this.cache = vscode.Uri.joinPath(this.baseDir, this.revision);

    let zip: ZipArchive;
    try {
      zip = ZipArchive.open(this.data);
    } catch (cause) {
      this.failure = messageOf(cause);
      return;
    }
    for (const [name, content] of this.edits) {
      zip.setOverride(name, content);
    }
    this.archive = zip;

    try {
      this.parsed = openEpubFromArchive(zip, this.fallbackTitle);
    } catch (cause) {
      this.failure = messageOf(cause);
    }
  }

  private computeRevision(): string {
    const base = sha1(this.data);
    if (this.edits.size === 0) {
      return base.slice(0, 12);
    }
    const parts = Array.from(this.edits.keys())
      .sort()
      .map((name) => `${name}:${sha1(this.edits.get(name) ?? "")}`);
    return sha1(`${base}|${parts.join("|")}`).slice(0, 12);
  }

  dispose(): void {
    this.uriCache.clear();
    this.extracted.clear();
    this.extraction.clear();
    this.changeEmitter.dispose();
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Remove asset caches from earlier content revisions of the same book. */
async function pruneSiblingCaches(base: vscode.Uri, keep: string): Promise<void> {
  try {
    const entries = await vscode.workspace.fs.readDirectory(base);
    await Promise.all(
      entries
        .filter(([name, kind]) => kind === vscode.FileType.Directory && name !== keep)
        .map(([name]) => vscode.workspace.fs.delete(vscode.Uri.joinPath(base, name), { recursive: true })),
    );
  } catch {
    // Nothing cached yet, or the directory is not readable: not our problem.
  }
}

/** Drop asset caches that were not touched for a while. */
export async function cleanupBookCaches(context: vscode.ExtensionContext): Promise<void> {
  const root = vscode.Uri.joinPath(context.globalStorageUri, CACHE_ROOT_SEGMENT);
  let books: [string, vscode.FileType][];
  try {
    books = await vscode.workspace.fs.readDirectory(root);
  } catch {
    return;
  }
  const cutoff = Date.now() - 14 * 24 * 60 * 60 * 1000;
  for (const [bookDir] of books) {
    const bookUri = vscode.Uri.joinPath(root, bookDir);
    try {
      const revisions = await vscode.workspace.fs.readDirectory(bookUri);
      for (const [revision] of revisions) {
        const revisionUri = vscode.Uri.joinPath(bookUri, revision);
        const stat = await vscode.workspace.fs.stat(revisionUri);
        if (stat.mtime < cutoff) {
          await vscode.workspace.fs.delete(revisionUri, { recursive: true });
        }
      }
    } catch {
      // Ignore caches we cannot inspect.
    }
  }
}
