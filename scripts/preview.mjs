/*
 * Dev script: render a chapter exactly the way the webview does and write the
 * resulting documents to preview/, so the reading surface can be eyeballed in a
 * plain browser (and the asset pipeline can be checked on disk).
 *
 *   node scripts/preview.mjs
 */
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { openEpub } = require("../out/src/epub/book.js");
const { renderChapter } = require("../out/src/epub/render.js");
const { createEpub3 } = require("../out/src/test/helpers/fixtures.js");

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, "..");
const outDir = path.join(projectRoot, "preview");
const assetDir = path.join(outDir, "assets");
const realBookCandidates = [
  path.resolve(projectRoot, "..", "玄鉴仙族.epub"),
  path.resolve(projectRoot, "fixtures", "sample.epub"),
];

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(assetDir, { recursive: true });

/** Mirrors baseCss() in media/reader.js so the preview matches the reader. */
function baseCss() {
  return `
html { background: #ffffff; }
body { margin: 0; padding: 0; background: #ffffff; color: #1f1f1f; }
.reader-body {
  box-sizing: border-box;
  max-width: 46rem;
  margin: 0 auto;
  padding: 2.4rem 1.5rem 4rem;
  font-family: Georgia, "Noto Serif SC", "Source Han Serif SC", "Songti SC", SimSun, serif;
  font-size: 17px;
  line-height: 1.75;
  text-align: justify;
  overflow-wrap: break-word;
  word-break: break-word;
}
.reader-body p { margin: 0 0 0.85em; }
.reader-body img, .reader-body svg { max-width: 100%; height: auto; }
.reader-body a { color: #0a58ca; text-decoration: none; border-bottom: 1px dotted currentColor; }
.reader-body mark.reader-hit { background: rgba(234,179,8,.4); border-radius: 2px; padding: 0 .1em; }
`;
}

function document(chapter, cssList) {
  const styles = cssList.map((css) => `<style>\n${css}\n</style>`).join("\n");
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>${chapter.title}</title>
${styles}
<style>${baseCss()}</style>
</head>
<body><div class="reader-body">
${chapter.body}
</div></body></html>
`;
}

/* ------------------------------------------------------- synthetic fixture */

const fixtureBook = openEpub(createEpub3());
const fixtureChapter = renderChapter(fixtureBook, 0, {
  uriFor: (zipPath) => {
    const target = path.join(assetDir, zipPath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, fixtureBook.zip.read(zipPath));
    return `assets/${zipPath}`;
  },
  resolveChapterPath: (target) => {
    const index = fixtureBook.chapterIndexForPath(target);
    return index === undefined ? undefined : fixtureBook.chapters[index].path;
  },
  readText: (target) => fixtureBook.zip.tryReadText(target),
  highlight: { query: "强调", occurrence: 1 },
});

const fixtureHtml = path.join(outDir, "fixture-epub3.html");
fs.writeFileSync(fixtureHtml, document(fixtureChapter, fixtureChapter.css), "utf8");
console.log(`[preview] ${path.relative(projectRoot, fixtureHtml)}`);
console.log(`  assets extracted : ${fixtureChapter.assets.length}`);
console.log(`  stylesheets      : ${fixtureChapter.css.length}`);
console.log(`  highlight placed : ${fixtureChapter.highlightFound}`);

/* --------------------------------------------------------------- real book */

const realPath = realBookCandidates.find((candidate) => fs.existsSync(candidate));
if (realPath) {
  const real = openEpub(fs.readFileSync(realPath));
  const chapter = renderChapter(real, 10, {
    uriFor: () => undefined,
    resolveChapterPath: () => undefined,
    readText: (target) => real.zip.tryReadText(target),
  });
  const target = path.join(outDir, "real-book-chapter.html");
  fs.writeFileSync(target, document(chapter, chapter.css), "utf8");
  console.log(`[preview] ${path.relative(projectRoot, target)}`);
  console.log(`  book             : ${real.metadata.title} / ${real.chapters.length} 节`);
  console.log(`  chapter          : ${chapter.title}`);
  console.log(`  characters       : ${chapter.text.length}`);
} else {
  console.log("[preview] 未找到示例电子书，跳过真实书籍预览");
}

console.log("\n用浏览器打开 preview/ 下的 HTML 即可查看渲染效果。");
