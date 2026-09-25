/*
 * Renders the real webview UI to PNG files, using the real shell HTML, the real
 * media/reader.css and media/reader.js, and real chapter payloads from the real
 * EPUB parser. Nothing here is a mock-up: the only injected bits are the
 * `--vscode-*` theme variables and a stub `acquireVsCodeApi`, because a plain
 * browser has no VS Code around it.
 *
 *   node scripts/screenshot.mjs
 *
 * Writes preview/ui-dark.html + preview/ui-search.html and, when Chrome or Edge
 * is available, docs/reading-ui.png + docs/search-ui.png.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { openPanel } = require("../out/src/test/helpers/hostHarness.js");
const { createEpub3 } = require("../out/src/test/helpers/fixtures.js");

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, "..");
const previewDir = path.join(projectRoot, "preview");
const docsDir = path.join(projectRoot, "docs");
const chromeDataDir = path.join(projectRoot, ".chrome-profile");

const readerCss = fs.readFileSync(path.join(projectRoot, "media", "reader.css"), "utf8");
const readerJs = fs.readFileSync(path.join(projectRoot, "media", "reader.js"), "utf8");

/** Dark Modern values for the variables the shell stylesheet consumes. */
const THEME = `
  --vscode-font-family: "Segoe UI", "Microsoft YaHei", system-ui, sans-serif;
  --vscode-font-size: 13px;
  --vscode-editor-font-family: Consolas, "Courier New", monospace;
  --vscode-foreground: #cccccc;
  --vscode-editor-background: #1f1f1f;
  --vscode-editor-foreground: #cccccc;
  --vscode-editor-selectionBackground: #264f78;
  --vscode-sideBar-background: #181818;
  --vscode-sideBar-foreground: #cccccc;
  --vscode-panel-border: #2b2b2b;
  --vscode-focusBorder: #0078d4;
  --vscode-descriptionForeground: #9d9d9d;
  --vscode-textLink-foreground: #4daafc;
  --vscode-button-background: #0078d4;
  --vscode-button-foreground: #ffffff;
  --vscode-button-hoverBackground: #026ec1;
  --vscode-input-background: #313131;
  --vscode-input-foreground: #cccccc;
  --vscode-input-placeholderForeground: #989898;
  --vscode-dropdown-background: #313131;
  --vscode-dropdown-foreground: #cccccc;
  --vscode-list-hoverBackground: #2a2d2e;
  --vscode-list-activeSelectionBackground: #04395e;
  --vscode-list-activeSelectionForeground: #ffffff;
  --vscode-progressBar-background: #0078d4;
  --vscode-editorWidget-background: #202020;
  --vscode-editorWidget-border: #313131;
  --vscode-editor-findMatchHighlightBackground: #ea5c0055;
  --vscode-toolbar-hoverBackground: #5a5d5e50;
  --vscode-editorWarning-foreground: #cca700;
  --vscode-errorForeground: #f85149;
  --vscode-textCodeBlock-background: #2b2b2b;
`;

const BOOTSTRAP = `(function () {
  var outbox = [];
  window.acquireVsCodeApi = function () {
    return {
      postMessage: function (message) { outbox.push(message); },
      getState: function () { return undefined; },
      setState: function () {}
    };
  };
  window.__inject = function (message) {
    window.dispatchEvent(new MessageEvent("message", { data: message }));
  };
})();`;

/** Turn the host's shell HTML into a standalone page a browser can render. */
function standalone(shellHtml, payloads) {
  let html = shellHtml
    .replace(/<meta http-equiv="Content-Security-Policy"[^>]*>\s*/i, "")
    .replace(/<link rel="stylesheet"[^>]*>/, `<style>\n${readerCss}\n</style>`)
    .replace(/<script nonce="[^"]*"[^>]*><\/script>/, "")
    .replace(/(src|href)="webview:[^"]*"/g, '$1=""');

  const tail = `
<script>${BOOTSTRAP}</script>
<script>${readerJs}</script>
<script>
window.addEventListener("load", function () {
${payloads}
});
</script>
</body>`;
  html = html.replace("</body>", tail);
  return html.replace("<head>", `<head>\n<style>:root {${THEME}}</style>`);
}

async function capture(shellHtml, chapterIndex, searchQuery) {
  const { panel } = await openPanel("D:/books/screenshot.epub", realBookBytes());

  const mark = panel.webview.count();
  await panel.webview.send({ type: "ready" });
  const init = await panel.webview.waitFor("init", { after: mark });

  const chapterMark = panel.webview.count();
  await panel.webview.send({ type: "openChapter", index: chapterIndex });
  const chapter = await panel.webview.waitFor("chapter", { after: chapterMark });

  const payloads = [
    `  window.__inject(${JSON.stringify(init)});`,
    `  window.__inject(${JSON.stringify(chapter)});`,
  ];

  if (searchQuery) {
    const searchMark = panel.webview.count();
    await panel.webview.send({ type: "search", requestId: 1, query: searchQuery });
    const results = await panel.webview.waitFor("searchResults", { after: searchMark });
    payloads.push(
      `  var input = document.getElementById("search-input");`,
      `  input.value = ${JSON.stringify(searchQuery)};`,
      `  input.dispatchEvent(new Event("input", { bubbles: true }));`,
      `  setTimeout(function () { window.__inject(${JSON.stringify(results)}); }, 800);`,
    );
  }

  return {
    html: standalone(shellHtml, payloads.join("\n")),
    title: init.book.title,
    chapters: init.book.chapterCount,
  };
}

function realBookBytes() {
  const candidates = [
    path.resolve(projectRoot, "..", "玄鉴仙族.epub"),
    path.resolve(projectRoot, "fixtures", "sample.epub"),
  ];
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (found) {
    console.log(`[shot] 使用真实电子书：${path.relative(projectRoot, found)}`);
    return fs.readFileSync(found);
  }
  console.log("[shot] 未找到示例电子书，改用内置 EPUB 3 样例");
  return createEpub3();
}

function findBrowser() {
  const candidates = [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  ];
  return candidates.find((candidate) => fs.existsSync(candidate));
}

function shoot(browser, htmlFile, pngFile) {
  const args = [
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    "--no-first-run",
    "--disable-extensions",
    "--disable-background-networking",
    "--force-device-scale-factor=2",
    "--window-size=1280,800",
    "--virtual-time-budget=6000",
    `--user-data-dir=${chromeDataDir}`,
    `--screenshot=${pngFile}`,
    `file:///${htmlFile.replace(/\\/g, "/")}`,
  ];
  execFileSync(browser, args, { stdio: "ignore", timeout: 120000 });
  return fs.existsSync(pngFile);
}

fs.mkdirSync(previewDir, { recursive: true });
fs.mkdirSync(docsDir, { recursive: true });

const browser = findBrowser();
const shellHtml = (await openPanel("D:/books/screenshot.epub", realBookBytes())).panel.webview.html;

const jobs = [
  {
    html: path.join(previewDir, "ui-dark.html"),
    png: path.join(docsDir, "reading-ui.png"),
    chapter: 100,
    search: undefined,
  },
  {
    html: path.join(previewDir, "ui-search.html"),
    png: path.join(docsDir, "search-ui.png"),
    chapter: 100,
    search: "陆江仙",
  },
];

let title = "";
let chapters = 0;
for (const job of jobs) {
  const rendered = await capture(shellHtml, job.chapter, job.search);
  title = rendered.title;
  chapters = rendered.chapters;
  fs.writeFileSync(job.html, rendered.html, "utf8");
  console.log(`[shot] ${path.relative(projectRoot, job.html)}`);
  if (browser) {
    const ok = shoot(browser, job.html, job.png);
    console.log(`[shot] ${ok ? "已截图" : "截图失败"}：${path.relative(projectRoot, job.png)}`);
  }
}

console.log(`[shot] ${title} · ${chapters} 节`);
if (!browser) {
  console.log("[shot] 未找到 Chrome/Edge，只生成了 HTML；用浏览器打开 preview/ui-*.html 即可查看");
}
fs.rmSync(chromeDataDir, { recursive: true, force: true });
