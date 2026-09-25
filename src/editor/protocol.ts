import type { TocEntry } from "../epub/book";

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
  title: string;
  body: string;
  css: string[];
  /** Element id to scroll to once the chapter is rendered. */
  fragment?: string;
  /** Present when the chapter was opened from a search hit. */
  highlight?: { query: string; occurrence: number; found: boolean };
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
    }
  | { type: "chapter"; chapter: ChapterPayload }
  | { type: "chapterError"; index: number; message: string }
  | { type: "bookmarks"; bookmarks: BookmarkDto[]; addedId?: string }
  | { type: "searchResults"; results: SearchResultsDto }
  | { type: "settings"; settings: ReaderSettings }
  | { type: "toast"; level: "info" | "warn" | "error"; message: string }
  | { type: "fatal"; message: string };

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
  | { type: "clientError"; message: string };
