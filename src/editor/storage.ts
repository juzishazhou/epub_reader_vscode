import * as vscode from "vscode";

export interface ReadingProgress {
  chapter: number;
  scrollRatio: number;
  updatedAt: number;
}

export interface Bookmark {
  id: string;
  chapter: number;
  scrollRatio: number;
  label: string;
  excerpt: string;
  createdAt: number;
}

export interface RecentBook {
  bookId: string;
  fsPath: string;
  title: string;
  chapter: number;
  chapterTitle: string;
  updatedAt: number;
}

const KEY_PROGRESS = "epubReader.progress";
const KEY_BOOKMARKS = "epubReader.bookmarks";
const KEY_RECENTS = "epubReader.recents";

const MAX_RECENTS = 25;
const MAX_BOOKMARKS_PER_BOOK = 200;

/**
 * Everything that has to outlive a webview: reading positions, bookmarks and
 * the "continue reading" list. All of it lives in `globalState`.
 */
export class ReaderStore {
  constructor(private readonly memento: vscode.Memento) {}

  progress(bookId: string): ReadingProgress | undefined {
    return this.readMap<ReadingProgress>(KEY_PROGRESS)[bookId];
  }

  setProgress(bookId: string, chapter: number, scrollRatio: number): void {
    const all = this.readMap<ReadingProgress>(KEY_PROGRESS);
    all[bookId] = { chapter, scrollRatio, updatedAt: Date.now() };
    this.write(KEY_PROGRESS, all);
  }

  bookmarks(bookId: string): Bookmark[] {
    const all = this.readMap<Bookmark[]>(KEY_BOOKMARKS);
    const list = all[bookId];
    return Array.isArray(list) ? list : [];
  }

  addBookmark(bookId: string, bookmark: Bookmark): Bookmark[] {
    const all = this.readMap<Bookmark[]>(KEY_BOOKMARKS);
    const list = Array.isArray(all[bookId]) ? all[bookId] : [];
    const next = [bookmark, ...list.filter((item) => item.id !== bookmark.id)].slice(
      0,
      MAX_BOOKMARKS_PER_BOOK,
    );
    all[bookId] = next;
    this.write(KEY_BOOKMARKS, all);
    return next;
  }

  removeBookmark(bookId: string, id: string): Bookmark[] {
    const all = this.readMap<Bookmark[]>(KEY_BOOKMARKS);
    const list = Array.isArray(all[bookId]) ? all[bookId] : [];
    const next = list.filter((item) => item.id !== id);
    all[bookId] = next;
    this.write(KEY_BOOKMARKS, all);
    return next;
  }

  recents(): RecentBook[] {
    const list = this.memento.get<RecentBook[]>(KEY_RECENTS, []);
    return Array.isArray(list) ? list : [];
  }

  touchRecent(entry: Omit<RecentBook, "updatedAt">): void {
    const list = this.recents().filter((item) => item.bookId !== entry.bookId);
    list.unshift({ ...entry, updatedAt: Date.now() });
    this.write(KEY_RECENTS, list.slice(0, MAX_RECENTS));
  }

  clearHistory(): void {
    this.write(KEY_PROGRESS, {});
    this.write(KEY_BOOKMARKS, {});
    this.write(KEY_RECENTS, []);
  }

  private readMap<T>(key: string): Record<string, T> {
    const value = this.memento.get<Record<string, T>>(key, {});
    return value && typeof value === "object" ? value : {};
  }

  private write(key: string, value: unknown): void {
    void Promise.resolve(this.memento.update(key, value)).then(undefined, () => {
      /* a failed globalState write must never break reading */
    });
  }
}
