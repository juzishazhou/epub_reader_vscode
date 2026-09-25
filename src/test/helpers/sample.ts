import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Optional sample book for the integration tests. The repository ships no EPUB
 * (they are large, and most are copyrighted), so those tests skip unless one is
 * provided:
 *
 *   PowerShell:  $env:EPUB_READER_SAMPLE = "D:\books\some-book.epub"; npm test
 *   or simply drop any .epub into the `fixtures/` directory.
 */
export function findSampleEpub(): string | undefined {
  const projectRoot = path.resolve(__dirname, "../../..");
  const candidates: string[] = [];
  const fromEnv = process.env.EPUB_READER_SAMPLE;
  if (fromEnv && fromEnv.trim().length > 0) {
    candidates.push(fromEnv.trim());
  }
  const fixturesDir = path.join(projectRoot, "fixtures");
  try {
    for (const entry of fs.readdirSync(fixturesDir)) {
      if (entry.toLowerCase().endsWith(".epub")) {
        candidates.push(path.join(fixturesDir, entry));
      }
    }
  } catch {
    // No fixtures directory: nothing to add.
  }
  return candidates.find((candidate) => fs.existsSync(candidate));
}

/** Sample book path for a test that already skipped when it was missing. */
export function requireSampleEpub(): string {
  const found = findSampleEpub();
  if (!found) {
    throw new Error("this test requires a sample epub");
  }
  return found;
}