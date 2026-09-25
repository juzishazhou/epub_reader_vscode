import { strict as assert } from "node:assert";
import { test } from "node:test";
import { openEpub } from "../epub/book";
import { SearchIndex } from "../epub/search";
import { createEpub3 } from "./helpers/fixtures";

test("counts matches per chapter and produces snippets", () => {
  const index = new SearchIndex(openEpub(createEpub3()));
  const outcome = index.search("关键词");

  assert.equal(outcome.totalMatches, 2);
  assert.equal(outcome.results.length, 1);
  assert.equal(outcome.results[0].index, 1);
  assert.equal(outcome.results[0].title, "第二章 转折");
  assert.equal(outcome.results[0].count, 2);
  assert.deepEqual(
    outcome.results[0].hits.map((hit) => hit.occurrence),
    [1, 2],
  );
  assert.match(outcome.results[0].hits[0].snippet, /关键词/);
  assert.equal(outcome.truncated, false);
});

test("is case-insensitive by default and case-sensitive on request", () => {
  const index = new SearchIndex(openEpub(createEpub3()));
  assert.equal(index.search("keyword").totalMatches, 1);
  assert.equal(index.search("KEYWORD").totalMatches, 1);
  assert.equal(index.search("KEYWORD", { caseSensitive: true }).totalMatches, 1);
  assert.equal(index.search("keyword", { caseSensitive: true }).totalMatches, 0);
});

test("caps hits per chapter and flags truncation", () => {
  const index = new SearchIndex(openEpub(createEpub3()));
  const outcome = index.search("关键词", { maxPerChapter: 1 });

  assert.ok(outcome.results.length > 0);
  assert.ok(outcome.results.every((result) => result.hits.length === 1));
  assert.equal(outcome.results[0].count, 2, "the chapter really has two matches");
  assert.equal(outcome.totalMatches, 2);
  assert.equal(outcome.truncated, true);
});

test("build indexes every chapter and reports progress", () => {
  const index = new SearchIndex(openEpub(createEpub3()));
  const progress: Array<[number, number]> = [];
  const done = index.build((completed, total) => progress.push([completed, total]));

  assert.equal(done, 3);
  assert.equal(index.builtChapters, 3);
  assert.equal(index.chapterCount, 3);
  assert.ok(progress.length > 0);
  assert.deepEqual(progress[progress.length - 1], [3, 3]);
});

test("build stops early when cancelled", () => {
  const index = new SearchIndex(openEpub(createEpub3()));
  const done = index.build(undefined, { isCancellationRequested: true });

  assert.equal(done, 0);
  assert.equal(index.builtChapters, 0);
});

test("an empty query returns nothing at all", () => {
  const index = new SearchIndex(openEpub(createEpub3()));
  const outcome = index.search("   ");

  assert.equal(outcome.totalMatches, 0);
  assert.equal(outcome.results.length, 0);
});
