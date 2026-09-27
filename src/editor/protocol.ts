import type { TocEntry } from "../epub/book";

/** The custom editor's view type, shared by the provider and the sessions. */
export const READER_VIEW_TYPE = "epubReader.reader";

export type PageTheme = "auto" | "light" | "sepia" | "dark";

export interface ReaderSettings {
  fontSize: number;
  lineHeight: number;
  maxWidth: number;
  pageTheme: PageTheme;
  rememberProgress: boolean;
}

export interface BookInfo {
  title: string;
  creator?: string;
  publisher?: string;
  language?: string;
  description?: string;
  chapterCount: number;
  coverUri?: string;
}

export interface HighlightRequest {
  query: string;
  occurrence: number;
}

export interface ChapterPayload {
  index: number;
  /** In-zip path of the chapter document, so the client can ask to edit it. */
  path: string;
  title: string;
  body: string;
  css: string[];
  /** Element id to scroll to once the chapter is rendered. */
  fragment?: string;
  /** Present when the chapter was opened from a search hit. */
  highlight?: { query: string; occurrence: number; found: boolean };
}

/** One file the edit panel may open. */
export interface EditableEntryDto {
  path: string;
  /** Spine chapters get the visual editor; everything else is source-only. */
  isChapter: boolean;
  label: string;
}

export interface BookmarkDto {
  id: string;
  chapter: number;
  scrollRatio: number;
  label: string;
  excerpt: string;
  createdAt: number;
}

export interface ProgressDto {
  chapter: number;
  scrollRatio: number;
}

export interface SearchHitDto {
  chapter: number;
  chapterTitle: string;
  occurrence: number;
  snippet: string;
}

export interface SearchResultsDto {
  requestId: number;
  query: string;
  hits: SearchHitDto[];
  totalMatches: number;
  truncated: boolean;
  indexedChapters: number;
  elapsedMs: number;
}

export type HostToWebviewMessage =
  | {
      type: "init";
      book: BookInfo;
      toc: TocEntry[];
      settings: ReaderSettings;
      bookmarks: BookmarkDto[];
      progress?: ProgressDto;
      startChapter: number;
      /** False when `epubReader.enableEditing` turns the editor read-only. */
      editingEnabled?: boolean;
      /**
       * True when the surface must be re-rendered from this payload (a save,
       * an undo, or an edit from another panel). Edit panels use it to know
       * whether their in-progress DOM has to be rebuilt.
       */
      forceRender?: boolean;
    }
  | { type: "chapter"; chapter: ChapterPayload }
  | { type: "chapterError"; index: number; message: string }
  | { type: "bookmarks"; bookmarks: BookmarkDto[]; addedId?: string }
  | { type: "searchResults"; results: SearchResultsDto }
  | { type: "settings"; settings: ReaderSettings }
  | { type: "toast"; level: "info" | "warn" | "error"; message: string }
  | { type: "fatal"; message: string }
  /** Every file the edit panel may open. */
  | { type: "editEntries"; entries: EditableEntryDto[] }
  /**
   * Content for the edit panel: `visual` carries the fidelity render of a
   * spine chapter (editable markup plus stylesheets), `source` carries the
   * raw text of any other entry.
   */
  | {
      type: "editContent";
      path: string;
      kind: "visual" | "source";
      body?: string;
      css?: string[];
      content?: string;
    }
  | { type: "editApplied"; path: string; dirty: boolean };

export type WebviewToHostMessage =
  | { type: "ready" }
  | {
      type: "openChapter";
      index?: number;
      path?: string;
      fragment?: string;
      scrollRatio?: number;
      highlight?: HighlightRequest;
    }
  | { type: "search"; requestId: number; query: string }
  | { type: "saveProgress"; chapter: number; scrollRatio: number }
  | { type: "addBookmark"; chapter: number; scrollRatio: number; label: string; excerpt: string }
  | { type: "removeBookmark"; id: string }
  | { type: "updateSetting"; key: keyof ReaderSettings; value: number | string | boolean }
  | { type: "openExternal"; url: string }
  | { type: "clientError"; message: string }
  /** Open an entry in the edit panel (defaults to the current chapter). */
  | { type: "requestEdit"; path?: string; source?: boolean }
  /** Submit edited markup (visual) or text (source) for one entry. */
  | { type: "applyEdit"; path: string; content: string; visual: boolean }
  /** Drop the edits of one entry, restoring what is on disk. */
  | { type: "revertEdit"; path: string }
  /** Ask VS Code to save the document (Ctrl+S inside the webview). */
  | { type: "saveNow" };
