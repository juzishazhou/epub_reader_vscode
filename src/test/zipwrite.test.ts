import { strict as assert } from "node:assert";
import { test } from "node:test";
import { openEpub } from "../epub/book";
import { ZipArchive } from "../epub/zip";
import { rewriteZip } from "../epub/zipwrite";
import { EXPECTED_PATHS, createEpub2, createEpub3 } from "./helpers/fixtures";

test("rewrites only the edited entries and copies the rest verbatim", () => {
  const original = createEpub3();
  const before = ZipArchive.open(original);
  const coverRaw = Buffer.from(before.rawEntry(EXPECTED_PATHS.epub3.cover)!.bytes);
  const svgRaw = Buffer.from(before.rawEntry(EXPECTED_PATHS.epub3.diagram)!.bytes);

  const edited = ZipArchive.open(original);
  edited.setOverride(
    EXPECTED_PATHS.epub3.chapter1,
    `<html><body><p>${"改".repeat(2000)}</p></body></html>`,
  );
  const rewritten = rewriteZip(edited);

  const after = ZipArchive.open(rewritten);
  assert.equal(
    after.readText(EXPECTED_PATHS.epub3.chapter1),
    `<html><body><p>${"改".repeat(2000)}</p></body></html>`,
  );
  assert.deepEqual(
    Buffer.from(after.rawEntry(EXPECTED_PATHS.epub3.cover)!.bytes),
    coverRaw,
    "an untouched binary entry must keep its exact compressed bytes",
  );
  assert.deepEqual(Buffer.from(after.rawEntry(EXPECTED_PATHS.epub3.diagram)!.bytes), svgRaw);
  assert.equal(after.names().length, before.names().length, "no entries appear or disappear");
  assert.deepEqual(after.names(), before.names(), "central directory order is preserved");
});

test("keeps the OCF container rules: mimetype first and stored", () => {
  const archive = ZipArchive.open(createEpub3());
  archive.setOverride(EXPECTED_PATHS.epub3.chapter2, "<html><body><p>新</p></body></html>");
  const rewritten = rewriteZip(archive);

  const after = ZipArchive.open(rewritten);
  assert.equal(after.names()[0], "mimetype", "mimetype must stay the first entry");
  const entry = after.rawEntry("mimetype");
  assert.ok(entry, "mimetype must still exist");
  assert.equal(entry!.method, 0, "mimetype must be stored, not deflated");
  assert.equal(after.readText("mimetype"), "application/epub+zip");
});

test("edited text is recompressed and the result still opens as a book", () => {
  const archive = ZipArchive.open(createEpub3());
  const path = EXPECTED_PATHS.epub3.chapter1;
  archive.setOverride(path, `<html><body><p>${"重复的正文 ".repeat(400)}</p></body></html>`);

  const rewritten = rewriteZip(archive);
  const after = ZipArchive.open(rewritten);
  const entry = after.rawEntry(path);
  assert.ok(entry);
  assert.equal(entry!.method, 8, "repetitive edited text should deflate");
  assert.ok(entry!.compressedSize < entry!.uncompressedSize);

  const book = openEpub(rewritten);
  assert.equal(book.chapters.length, 3);
  assert.match(book.zip.readText(path), /重复的正文/);
});

test("handles entry names with spaces and non-ascii characters", () => {
  const archive = ZipArchive.open(createEpub2());
  const path = EXPECTED_PATHS.epub2.chapterWithSpace;
  archive.setOverride(path, "<html><body><p>带空格的条目被改写了。</p></body></html>");
  const rewritten = rewriteZip(archive);

  const after = ZipArchive.open(rewritten);
  assert.match(after.readText(path), /带空格的条目被改写了/);
  assert.ok(after.has(EXPECTED_PATHS.epub2.chapter0));
  assert.equal(openEpub(rewritten).chapters.length, 2);
});

test("rewriting without edits is a byte-level no-op for entry payloads", () => {
  const original = createEpub3();
  const before = ZipArchive.open(original);
  const rewritten = rewriteZip(ZipArchive.open(original));
  const after = ZipArchive.open(rewritten);

  for (const name of before.names()) {
    assert.deepEqual(
      Buffer.from(after.rawEntry(name)!.bytes),
      Buffer.from(before.rawEntry(name)!.bytes),
      `${name} must be copied unchanged`,
    );
  }
});
