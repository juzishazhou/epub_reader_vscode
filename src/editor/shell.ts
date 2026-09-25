import * as crypto from "node:crypto";
import * as vscode from "vscode";
import { escapeHtml } from "../epub/util";

function nonce(): string {
  return crypto.randomBytes(16).toString("base64");
}

function contentSecurityPolicy(cspSource: string, scriptNonce: string): string {
  return [
    "default-src 'none'",
    `img-src ${cspSource} data: blob:`,
    `media-src ${cspSource} data: blob:`,
    `font-src ${cspSource} data:`,
    `style-src ${cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${scriptNonce}'`,
    "frame-src 'self' data: blob:",
    "form-action 'none'",
    "base-uri 'none'",
  ].join("; ");
}

function documentHead(cspSource: string, scriptNonce: string, extra: string): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="${contentSecurityPolicy(cspSource, scriptNonce)}">
<title>EPUB View</title>
${extra}
</head>`;
}

/** The full reader shell: toolbar, drawer, reading frame and status bar. */
export function buildReaderShell(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const scriptNonce = nonce();
  const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", "reader.css"));
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", "reader.js"));

  return `${documentHead(webview.cspSource, scriptNonce, `<link rel="stylesheet" href="${styleUri}">`)}
<body>
<div id="app" class="app" data-drawer="toc" data-drawer-open="true">

  <header class="toolbar">
    <button id="btn-drawer" class="icon-btn" type="button" title="目录 (t)">☰</button>
    <button id="btn-prev" class="icon-btn" type="button" title="上一章 ([ 或 ←)">‹</button>
    <button id="btn-next" class="icon-btn" type="button" title="下一章 (] 或 →)">›</button>
    <div class="title-block">
      <div id="book-title" class="book-title">正在打开…</div>
      <div id="chapter-title" class="chapter-title"></div>
    </div>
    <div class="toolbar-right">
      <input id="search-input" class="search-input" type="search" placeholder="全文搜索 (/)">
      <button id="btn-bookmark" class="icon-btn" type="button" title="在此处加书签 (b)">🔖</button>
      <button id="btn-font-dec" class="icon-btn" type="button" title="减小字号 (-)">A−</button>
      <button id="btn-font-inc" class="icon-btn" type="button" title="增大字号 (+)">A+</button>
      <select id="theme-select" class="theme-select" title="正文配色">
        <option value="auto">跟随主题</option>
        <option value="light">浅色</option>
        <option value="sepia">护眼</option>
        <option value="dark">深色</option>
      </select>
      <button id="btn-help" class="icon-btn" type="button" title="快捷键 (?)">?</button>
    </div>
  </header>

  <aside class="drawer">
    <div class="drawer-tabs">
      <button class="tab is-active" type="button" data-tab="toc">目录</button>
      <button class="tab" type="button" data-tab="bookmarks">书签</button>
      <button class="tab" type="button" data-tab="search">搜索</button>
    </div>
    <div class="drawer-body">
      <div class="pane is-active" id="pane-toc">
        <input id="toc-filter" class="toc-filter" type="search" placeholder="筛选章节">
        <div id="toc-list" class="toc-list"></div>
      </div>
      <div class="pane" id="pane-bookmarks">
        <div id="bookmark-list" class="bookmark-list"></div>
      </div>
      <div class="pane" id="pane-search">
        <div id="search-summary" class="pane-hint">输入关键词后回车开始全书搜索</div>
        <div id="search-list" class="search-list"></div>
      </div>
    </div>
    <div class="drawer-footer">
      <img id="cover" class="cover" alt="" hidden>
      <div class="book-meta">
        <div id="meta-title" class="meta-title"></div>
        <div id="meta-author" class="meta-author"></div>
        <div id="meta-extra" class="meta-extra"></div>
      </div>
    </div>
  </aside>

  <main class="content">
    <div id="reading-surface" class="reading-surface" tabindex="0"></div>
    <div id="loading" class="loading" hidden>正在加载章节…</div>
  </main>

  <footer class="statusbar">
    <div class="progress-track"><div id="progress-fill" class="progress-fill"></div></div>
    <div class="status-text">
      <span id="status-chapter"></span>
      <span id="status-percent"></span>
    </div>
  </footer>

  <div id="help" class="help-overlay" hidden>
    <div class="help-card">
      <h2>快捷键</h2>
      <dl>
        <dt>[</dt><dd>上一章</dd>
        <dt>]</dt><dd>下一章</dd>
        <dt>h / l</dt><dd>上一章 / 下一章</dd>
        <dt>← / →</dt><dd>上一章 / 下一章</dd>
        <dt>t</dt><dd>展开或收起侧栏</dd>
        <dt>/</dt><dd>聚焦搜索框</dd>
        <dt>b</dt><dd>在当前位置加书签</dd>
        <dt>+ / -</dt><dd>字号增减</dd>
        <dt>0</dt><dd>恢复默认字号</dd>
        <dt>Esc</dt><dd>关闭浮层 / 取消搜索</dd>
        <dt>?</dt><dd>显示本帮助</dd>
      </dl>
      <button id="help-close" class="primary-btn" type="button">知道了</button>
    </div>
  </div>

  <div id="toast" class="toast" hidden></div>
</div>
<script nonce="${scriptNonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

/** Fallback page for files that could not be parsed as EPUB. */
export function buildErrorShell(title: string, message: string): string {
  const scriptNonce = nonce();
  return `${documentHead(
    "",
    scriptNonce,
    `<style>
      body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 2rem; line-height: 1.7; }
      h1 { font-size: 1.2rem; margin: 0 0 .6rem; }
      pre { white-space: pre-wrap; background: var(--vscode-textCodeBlock-background); padding: .8rem 1rem; border-radius: 6px; }
      p { color: var(--vscode-descriptionForeground); }
    </style>`,
  )}
<body>
  <h1>无法打开《${escapeHtml(title)}》</h1>
  <pre>${escapeHtml(message)}</pre>
  <p>可以尝试：确认文件是完整的 EPUB（未加密、未损坏），或先用解压工具检查 <code>META-INF/container.xml</code>，也可以在资源管理器里右键选择「打开方式 → 文本编辑器」查看原始内容。</p>
</body>
</html>`;
}
