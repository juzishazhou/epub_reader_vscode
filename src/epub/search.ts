import { EpubBook } from "./book";
import { chapterText } from "./render";
import { clamp, collapseWhitespace, findOccurrences } from "./util";

export interface SearchHit {
  /** 1-based occurrence index inside the chapter, used for highlighting. */
  occurrence: number;
  snippet: string;
}

export interface ChapterHits {
  index: number;
  title: string;
  /** Total matches in the chapter, which may exceed `hits.length`. */
  count: number;
  hits: SearchHit[];
}

export interface SearchOptions {
  maxPerChapter?: number;
  maxTotal?: number;
  caseSensitive?: boolean;
  /** Only search up to this many chapters (0 or undefined means all). */
  limitChapters?: number;
}

export interface SearchOutcome {
  query: string;
  results: ChapterHits[];
  totalMatches: number;
  /** True when the per-chapter or total caps were hit. */
  truncated: boolean;
  searchedChapters: number;
}

export interface CancellationLike {
  readonly isCancellationRequested: boolean;
}

const SNIPPET_RADIUS = 36;

/**
 * Lazy full-text index over the whole spine. Chapter text is extracted with the
 * same transformation the renderer uses, so `occurrence` indexes can be handed
 * straight to `renderChapter` for highlighting.
 */
export class SearchIndex {
  private readonly cache = new Map<number, string>();
  private builtCount = 0;

  constructor(private readonly book: EpubBook) {}

  get chapterCount(): number {
    return this.book.chapters.length;
  }

  get builtChapters(): number {
    return this.builtCount;
  }

  /** Text of one chapter, extracted and cached on first use. */
  text(index: number): string {
    const cached = this.cache.get(index);
    if (cached !== undefined) {
      return cached;
    }
    const text = chapterText(this.book, index);
    this.cache.set(index, text);
    if (index + 1 > this.builtCount) {
      this.builtCount = index + 1;
    }
    return text;
  }

  /**
   * Extract every chapter up front. Returns the number of chapters indexed
   * (fewer than `chapterCount` when the token was cancelled).
   */
  build(onProgress?: (done: number, total: number) => void, token?: CancellationLike): number {
    const total = this.chapterCount;
    for (let index = 0; index < total; index++) {
      if (token?.isCancellationRequested) {
        return index;
      }
      this.text(index);
      if (onProgress && (index % 64 === 0 || index === total - 1)) {
        onProgress(index + 1, total);
      }
    }
    return total;
  }

  search(rawQuery: string, options: SearchOptions = {}): SearchOutcome {
    const caseSensitive = options.caseSensitive ?? false;
    const maxPerChapter = clamp(options.maxPerChapter ?? 8, 1, 50);
    const maxTotal = clamp(options.maxTotal ?? 200, 1, 2000);
    const limit = options.limitChapters && options.limitChapters > 0
      ? Math.min(options.limitChapters, this.chapterCount)
      : this.chapterCount;

    const results: ChapterHits[] = [];
    let totalMatches = 0;
    let truncated = false;

    if (rawQuery.trim().length === 0) {
      return { query: rawQuery, results, totalMatches: 0, truncated: false, searchedChapters: 0 };
    }

    for (let index = 0; index < limit; index++) {
      if (totalMatches >= maxTotal) {
        truncated = true;
        break;
      }
      const text = this.text(index);
      if (text.length === 0) {
        continue;
      }
      const offsets = findOccurrences(text, rawQuery, caseSensitive);
      if (offsets.length === 0) {
        continue;
      }
      totalMatches += offsets.length;
      const hits: SearchHit[] = [];
      for (let i = 0; i < offsets.length && i < maxPerChapter; i++) {
        hits.push({ occurrence: i + 1, snippet: buildSnippet(text, offsets[i], rawQuery.length) });
      }
      if (offsets.length > maxPerChapter) {
        truncated = true;
      }
      const chapter = this.book.chapters[index];
      results.push({
        index,
        title: chapter.title || `第 ${index + 1} 节`,
        count: offsets.length,
        hits,
      });
    }

    return {
      query: rawQuery,
      results,
      totalMatches,
      truncated,
      searchedChapters: limit,
    };
  }
}

function buildSnippet(text: string, offset: number, length: number): string {
  const start = Math.max(0, offset - SNIPPET_RADIUS);
  const end = Math.min(text.length, offset + length + SNIPPET_RADIUS);
  const head = start > 0 ? "…" : "";
  const tail = end < text.length ? "…" : "";
  return head + collapseWhitespace(text.slice(start, end)) + tail;
}
