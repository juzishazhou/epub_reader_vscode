import * as path from "node:path";
import * as vscode from "vscode";
import { EpubBook, openEpub } from "../epub/book";
import { SearchIndex } from "../epub/search";
import { sha1, sanitizeZipPath } from "../epub/util";

const CACHE_ROOT_SEGMENT = "books";

/**
 * One opened `.epub`: the parsed book, its on-disk asset cache and the lazy
 * full-text index. Shared by every editor panel showing the same file.
 */
export class EpubDocument implements vscode.CustomDocument {
  private readonly uriCache = new Map<string, vscode.Uri>();
  private readonly extraction = new Map<string, Promise<void>>();
  private readonly extracted = new Set<string>();
  private index: SearchIndex | undefined;

  private constructor(
    readonly uri: vscode.Uri,
    /** Stable identity of the book, derived from its location on disk. */
    readonly bookId: string,
    readonly contentHash: string,
    /** Directory holding extracted assets for exactly this content revision. */
    readonly cacheDir: vscode.Uri,
    readonly book: EpubBook | undefined,
    readonly error: string | undefined,
  ) {}

  static async open(
    context: vscode.ExtensionContext,
    uri: vscode.Uri,
    data: Buffer,
  ): Promise<EpubDocument> {
    const bookId = sha1(uri.fsPath.toLowerCase()).slice(0, 16);
    const contentHash = sha1(data).slice(0, 12);
    const base = vscode.Uri.joinPath(context.globalStorageUri, CACHE_ROOT_SEGMENT, bookId);
    const cacheDir = vscode.Uri.joinPath(base, contentHash);

    let book: EpubBook | undefined;
    let error: string | undefined;
    try {
      book = openEpub(data, path.basename(uri.fsPath, path.extname(uri.fsPath)));
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    }

    if (book) {
      void pruneSiblingCaches(base, contentHash);
    }
    return new EpubDocument(uri, bookId, contentHash, cacheDir, book, error);
  }

  /** Lazily created full-text index over the spine. */
  get searchIndex(): SearchIndex | undefined {
    if (!this.book) {
      return undefined;
    }
    if (!this.index) {
      this.index = new SearchIndex(this.book);
    }
    return this.index;
  }

  /** Deterministic cache location for an in-zip asset (no disk check). */
  fileUri(zipPath: string): vscode.Uri {
    const key = zipPath;
    const cached = this.uriCache.get(key);
    if (cached) {
      return cached;
    }
    const real = this.book?.zip.realName(zipPath) ?? zipPath;
    const segments = sanitizeZipPath(real).split("/").filter((segment) => segment.length > 0);
    const uri = vscode.Uri.joinPath(this.cacheDir, ...(segments.length > 0 ? segments : ["_"]));
    this.uriCache.set(key, uri);
    return uri;
  }

  /** Extract assets on demand so the webview can load them by URI. */
  async ensureExtracted(zipPaths: readonly string[]): Promise<void> {
    const book = this.book;
    if (!book) {
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
    const book = this.book;
    if (!book) {
      return;
    }
    try {
      const data = book.zip.read(zipPath);
      const target = this.fileUri(zipPath);
      await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(target, ".."));
      await vscode.workspace.fs.writeFile(target, data);
      this.extracted.add(zipPath);
    } catch {
      // A broken resource must not break reading: the webview just shows a gap.
    }
  }

  dispose(): void {
    this.uriCache.clear();
    this.extracted.clear();
  }
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
