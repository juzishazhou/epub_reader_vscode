/*
 * EPUB Reader webview client.
 *
 * The host owns parsing and sanitizing; this file owns presentation: the
 * drawer, the reading surface (a shadow root, so book styles stay contained),
 * progress reporting and keyboard shortcuts.
 * No framework, no build step, no dynamic HTML from book content.
 */
(function () {
  "use strict";

  const vscode = acquireVsCodeApi();

  const DEFAULT_SETTINGS = {
    fontSize: 17,
    lineHeight: 1.75,
    maxWidth: 46,
    pageTheme: "auto",
    rememberProgress: true,
  };

  const state = {
    book: null,
    toc: [],
    flatToc: [],
    bookmarks: [],
    settings: Object.assign({}, DEFAULT_SETTINGS),
    chapterIndex: 0,
    chapterTitle: "",
    chapterBody: "",
    chapterCss: [],
    chapterReady: false,
    chapterCount: 0,
    scrollRatio: 0,
    pendingScroll: null,
    drawerOpen: true,
    activeTab: "toc",
    searchRequestId: 0,
    searchQuery: "",
    autoSearchTimer: null,
    composing: false,
    progressTimer: null,
    progressSentAt: 0,
  };

  const dom = {};
  /** Shadow root holding the reading surface, so EPUB css cannot leak out. */
  let shadow = null;

  /* ------------------------------------------------------------- helpers */

  function clamp(value, min, max) {
    const number = Number(value);
    if (!isFinite(number)) {
      return min;
    }
    return Math.min(max, Math.max(min, number));
  }

  function $(id) {
    return document.getElementById(id);
  }

  function iconButton(label, title, className) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = className || "row-delete";
    button.title = title || label;
    button.textContent = label;
    return button;
  }

  function formatTime(timestamp) {
    try {
      const date = new Date(timestamp);
      const pad = (value) => String(value).padStart(2, "0");
      return (
        date.getFullYear() +
        "-" +
        pad(date.getMonth() + 1) +
        "-" +
        pad(date.getDate()) +
        " " +
        pad(date.getHours()) +
        ":" +
        pad(date.getMinutes())
      );
    } catch (error) {
      return "";
    }
  }

  /* ----------------------------------------------------------------- boot */

  function boot() {
    dom.app = $("app");
    dom.bookTitle = $("book-title");
    dom.chapterTitle = $("chapter-title");
    dom.surface = $("reading-surface");
    dom.loading = $("loading");
    dom.toast = $("toast");
    dom.help = $("help");
    dom.cover = $("cover");
    dom.metaTitle = $("meta-title");
    dom.metaAuthor = $("meta-author");
    dom.metaExtra = $("meta-extra");
    dom.tocList = $("toc-list");
    dom.tocFilter = $("toc-filter");
    dom.bookmarkList = $("bookmark-list");
    dom.searchList = $("search-list");
    dom.searchSummary = $("search-summary");
    dom.searchInput = $("search-input");
    dom.themeSelect = $("theme-select");
    dom.progressFill = $("progress-fill");
    dom.statusChapter = $("status-chapter");
    dom.statusPercent = $("status-percent");

    bindToolbar();
    bindDrawer();
    bindKeyboard();

    // In a narrow editor group the drawer would eat the whole reading area.
    if (window.innerWidth < 820) {
      state.drawerOpen = false;
      dom.app.setAttribute("data-drawer-open", "false");
    }

    shadow = dom.surface.attachShadow({ mode: "open" });
    dom.surface.addEventListener("scroll", onSurfaceScroll, { passive: true });
    shadow.addEventListener("click", onSurfaceClick);
    window.addEventListener("message", onMessage);
    vscode.postMessage({ type: "ready" });
  }

  function bindToolbar() {
    $("btn-drawer").addEventListener("click", toggleDrawer);
    $("btn-prev").addEventListener("click", previousChapter);
    $("btn-next").addEventListener("click", nextChapter);
    $("btn-bookmark").addEventListener("click", addBookmark);
    $("btn-font-dec").addEventListener("click", () => changeFontSize(-1));
    $("btn-font-inc").addEventListener("click", () => changeFontSize(1));
    $("btn-help").addEventListener("click", () => toggleHelp(true));
    $("help-close").addEventListener("click", () => toggleHelp(false));

    dom.themeSelect.addEventListener("change", () => {
      state.settings.pageTheme = dom.themeSelect.value;
      vscode.postMessage({
        type: "updateSetting",
        key: "pageTheme",
        value: dom.themeSelect.value,
      });
      rerenderSurface();
    });

    dom.searchInput.addEventListener("input", () => {
      if (state.composing) {
        return;
      }
      scheduleAutoSearch();
    });
    dom.searchInput.addEventListener("compositionstart", () => {
      state.composing = true;
    });
    dom.searchInput.addEventListener("compositionend", () => {
      state.composing = false;
      scheduleAutoSearch();
    });
    dom.searchInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        runSearch(true);
      } else if (event.key === "Escape") {
        dom.searchInput.blur();
      }
    });
  }

  function bindDrawer() {
    const tabs = document.querySelectorAll(".drawer-tabs .tab");
    for (const tab of tabs) {
      tab.addEventListener("click", () => switchTab(tab.getAttribute("data-tab")));
    }
    dom.tocFilter.addEventListener("input", renderToc);
  }

  function bindKeyboard() {
    document.addEventListener("keydown", onKeyDown);
  }

  /* ------------------------------------------------------------- messages */

  function onMessage(event) {
    const message = event.data;
    if (!message || typeof message.type !== "string") {
      return;
    }
    switch (message.type) {
      case "init":
        applyInit(message);
        break;
      case "chapter":
        applyChapter(message.chapter);
        break;
      case "chapterError":
        showChapterError(message.message);
        break;
      case "bookmarks":
        state.bookmarks = message.bookmarks || [];
        renderBookmarks();
        break;
      case "searchResults":
        applySearchResults(message.results);
        break;
      case "settings":
        state.settings = Object.assign({}, DEFAULT_SETTINGS, message.settings || {});
        syncSettingsUi();
        break;
      case "toast":
        showToast(message.message, message.level);
        break;
      case "fatal":
        showFatal(message.message);
        break;
      default:
        break;
    }
  }

  function applyInit(message) {
    state.book = message.book;
    state.toc = message.toc || [];
    state.settings = Object.assign({}, DEFAULT_SETTINGS, message.settings || {});
    state.bookmarks = message.bookmarks || [];
    state.chapterCount = message.book ? message.book.chapterCount : 0;
    state.flatToc = flattenToc(state.toc);
    state.chapterIndex = clamp(message.startChapter, 0, Math.max(0, state.chapterCount - 1));

    dom.bookTitle.textContent = state.book.title || "";
    dom.bookTitle.title = state.book.title || "";
    dom.metaTitle.textContent = state.book.title || "";
    dom.metaAuthor.textContent = state.book.creator || "";
    const extras = [];
    if (state.book.publisher) {
      extras.push(state.book.publisher);
    }
    extras.push(state.chapterCount + " 节");
    dom.metaExtra.textContent = extras.join(" · ");
    if (state.book.coverUri) {
      dom.cover.src = state.book.coverUri;
      dom.cover.hidden = false;
    }
    if (state.book.description) {
      dom.metaTitle.title = state.book.description;
    }

    if (message.progress) {
      state.pendingScroll = { kind: "ratio", value: clamp(message.progress.scrollRatio, 0, 1) };
    } else {
      state.pendingScroll = { kind: "ratio", value: 0 };
    }

    renderToc();
    renderBookmarks();
    renderSearchPlaceholder();
    syncSettingsUi();
    switchTab(state.activeTab);
    updateStatus();
    showLoading();
  }

  function applyChapter(chapter) {
    if (!chapter) {
      return;
    }
    state.chapterIndex = chapter.index;
    state.chapterTitle = chapter.title || "";
    state.chapterBody = chapter.body || "";
    state.chapterCss = chapter.css || [];
    state.chapterReady = true;
    dom.chapterTitle.textContent = state.chapterTitle;
    dom.chapterTitle.title = state.chapterTitle;

    if (chapter.highlight) {
      if (chapter.highlight.found) {
        state.pendingScroll = { kind: "hit" };
      } else {
        state.pendingScroll = { kind: "ratio", value: 0 };
        showToast("这一处搜索结果在当前排版下不可见", "warn");
      }
    } else if (chapter.fragment) {
      state.pendingScroll = { kind: "fragment", value: chapter.fragment };
    } else if (!state.pendingScroll) {
      state.pendingScroll = { kind: "ratio", value: 0 };
    }

    clearErrorBox();
    renderSurface();
    hideLoading();
    restoreScroll();
    updateStatus();
    highlightActiveToc();
  }

  function showChapterError(message) {
    hideLoading();
    showErrorBox(message || "这一节无法显示。");
  }

  function showFatal(message) {
    showErrorBox(message || "阅读器遇到无法恢复的错误。");
  }

  /* ------------------------------------------------------- reading surface */

  function renderSurface() {
    if (!shadow) {
      return;
    }
    shadow.innerHTML = composeDocument();
  }

  function rerenderSurface() {
    if (!state.chapterReady) {
      return;
    }
    state.pendingScroll = { kind: "ratio", value: state.scrollRatio };
    renderSurface();
    restoreScroll();
  }

  function composeDocument() {
    const palette = pagePalette();
    const parts = [];
    for (const css of state.chapterCss) {
      parts.push("<style>" + css + "</style>");
    }
    parts.push("<style>" + baseCss(palette) + "</style>");
    parts.push('<div class="reader-body">');
    parts.push(state.chapterBody);
    parts.push("</div>");
    return parts.join("\n");
  }

  function isDarkTheme() {
    const classes = document.body.classList;
    return classes.contains("vscode-dark") || classes.contains("vscode-high-contrast");
  }

  function themeVariable(name, fallback) {
    const value = getComputedStyle(document.body).getPropertyValue(name);
    return value && value.trim().length > 0 ? value.trim() : fallback;
  }

  function pagePalette() {
    const dark = isDarkTheme();
    const theme = state.settings.pageTheme;
    const link = themeVariable("--vscode-textLink-foreground", dark ? "#4daafc" : "#0a58ca");
    let background = themeVariable("--vscode-editor-background", dark ? "#1f1f1f" : "#ffffff");
    let foreground = themeVariable("--vscode-editor-foreground", dark ? "#d4d4d4" : "#1f1f1f");
    let selection = themeVariable("--vscode-editor-selectionBackground", "rgba(64,128,255,.3)");

    if (theme === "light") {
      background = "#ffffff";
      foreground = "#1f1f1f";
    } else if (theme === "sepia") {
      background = "#f4ecd8";
      foreground = "#3a3226";
      selection = "rgba(180,140,60,.35)";
    } else if (theme === "dark") {
      background = "#15171c";
      foreground = "#c8ccd2";
    }

    return {
      dark: theme === "auto" ? dark : theme === "dark",
      background: background,
      foreground: foreground,
      link: link,
      selection: selection,
      hit: themeVariable("--vscode-editor-findMatchHighlightBackground", "rgba(234,179,8,.4)"),
      font:
        '"Georgia", "Noto Serif SC", "Source Han Serif SC", "Songti SC", "SimSun", "Times New Roman", serif',
    };
  }

  function baseCss(palette) {
    const settings = state.settings;
    return [
      "html { background: " + palette.background + "; }",
      "body { margin: 0; padding: 0; background: " + palette.background + "; color: " + palette.foreground + "; }",
      ".reader-body {",
      "  box-sizing: border-box;",
      "  max-width: " + settings.maxWidth + "rem;",
      "  margin: 0 auto;",
      "  padding: 2.4rem 1.5rem 60vh;",
      "  font-family: " + palette.font + ";",
      "  font-size: " + settings.fontSize + "px;",
      "  line-height: " + settings.lineHeight + ";",
      "  text-align: justify;",
      "  overflow-wrap: break-word;",
      "  word-break: break-word;",
      "}",
      ".reader-body > *:first-child { margin-top: 0; }",
      ".reader-body p { margin: 0 0 0.85em; }",
      ".reader-body img, .reader-body svg, .reader-body image { max-width: 100%; height: auto; }",
      ".reader-body table { max-width: 100%; border-collapse: collapse; }",
      ".reader-body pre { white-space: pre-wrap; }",
      ".reader-body a { color: " + palette.link + "; text-decoration: none; border-bottom: 1px dotted currentColor; }",
      ".reader-body a:hover { text-decoration: underline; }",
      ".reader-body mark.reader-hit {",
      "  background: " + palette.hit + ";",
      "  color: inherit;",
      "  border-radius: 2px;",
      "  padding: 0 0.1em;",
      "  animation: reader-flash 1.1s ease-out 1;",
      "}",
      "@keyframes reader-flash { from { background: " + palette.link + "; } }",
      "::selection { background: " + palette.selection + "; }",
    ].join("\n");
  }

  function onSurfaceScroll() {
    const max = Math.max(1, dom.surface.scrollHeight - dom.surface.clientHeight);
    state.scrollRatio = clamp(dom.surface.scrollTop / max, 0, 1);
    updateStatus();
    scheduleProgressSave();
  }

  function findAnchor(name) {
    if (!shadow || !name) {
      return null;
    }
    const byId = shadow.getElementById ? shadow.getElementById(name) : null;
    if (byId) {
      return byId;
    }
    try {
      const escaped = window.CSS && CSS.escape ? CSS.escape(name) : name;
      return shadow.querySelector('[name="' + escaped + '"]');
    } catch (error) {
      return null;
    }
  }

  function restoreScroll() {
    const pending = state.pendingScroll;
    state.pendingScroll = null;
    const surface = dom.surface;

    const applyRatio = (value) => {
      const max = Math.max(0, surface.scrollHeight - surface.clientHeight);
      surface.scrollTop = Math.round(max * clamp(value, 0, 1));
    };
    const scrollToHit = () => {
      const hit = shadow ? shadow.querySelector("mark.reader-hit") : null;
      if (hit && hit.scrollIntoView) {
        hit.scrollIntoView({ block: "center" });
      }
    };

    if (pending) {
      if (pending.kind === "fragment" && pending.value) {
        const target = findAnchor(pending.value);
        if (target && target.scrollIntoView) {
          target.scrollIntoView({ block: "start" });
        }
      } else if (pending.kind === "hit") {
        scrollToHit();
      } else {
        applyRatio(pending.value);
      }
    }

    onSurfaceScroll();
    if (pending && (pending.kind === "ratio" || pending.kind === "hit")) {
      // Late loading images and fonts can shift the layout under us.
      window.requestAnimationFrame(() => {
        if (pending.kind === "ratio") {
          applyRatio(pending.value);
        } else {
          scrollToHit();
        }
        onSurfaceScroll();
      });
    }
  }

  function onSurfaceClick(event) {
    const target = event.target;
    if (!target || !target.closest) {
      return;
    }
    const anchor = target.closest("a");
    if (!anchor) {
      return;
    }
    event.preventDefault();
    const external = anchor.getAttribute("data-epub-external");
    if (external) {
      vscode.postMessage({ type: "openExternal", url: external });
      return;
    }
    const chapterPath = anchor.getAttribute("data-epub-chapter");
    const fragment = anchor.getAttribute("data-epub-fragment");
    if (chapterPath) {
      openChapter({ path: chapterPath, fragment: fragment, scrollRatio: 0 });
      return;
    }
    if (fragment) {
      const anchorTarget = findAnchor(fragment);
      if (anchorTarget && anchorTarget.scrollIntoView) {
        anchorTarget.scrollIntoView({ block: "start" });
      }
    }
  }

  /* ------------------------------------------------------------ navigation */

  function chapterIndexFromEntry(entry) {
    if (typeof entry.chapterIndex === "number") {
      return entry.chapterIndex;
    }
    return undefined;
  }

  function openChapter(request) {
    state.pendingScroll = request.highlight
      ? { kind: "hit" }
      : request.fragment
        ? { kind: "fragment", value: request.fragment }
        : { kind: "ratio", value: clamp(request.scrollRatio || 0, 0, 1) };
    showLoading();
    vscode.postMessage(
      Object.assign({ type: "openChapter" }, request, {
        index: typeof request.index === "number" ? request.index : undefined,
      }),
    );
  }

  function previousChapter() {
    if (state.chapterIndex > 0) {
      openChapter({ index: state.chapterIndex - 1, scrollRatio: 0 });
    } else {
      showToast("已经是第一节了", "info");
    }
  }

  function nextChapter() {
    if (state.chapterIndex < state.chapterCount - 1) {
      openChapter({ index: state.chapterIndex + 1, scrollRatio: 0 });
    } else {
      showToast("已经是最后一节了", "info");
    }
  }

  /* ------------------------------------------------------------------- toc */

  function flattenToc(entries, level, out) {
    const list = out || [];
    for (const entry of entries) {
      list.push({
        label: entry.label,
        path: entry.path,
        fragment: entry.fragment,
        level: entry.level || level || 1,
        chapterIndex: entry.chapterIndex,
      });
      if (entry.children && entry.children.length > 0) {
        flattenToc(entry.children, (level || 1) + 1, list);
      }
    }
    return list;
  }

  function renderToc() {
    const filter = (dom.tocFilter.value || "").trim().toLowerCase();
    const items = filter
      ? state.flatToc.filter((entry) => (entry.label || "").toLowerCase().indexOf(filter) >= 0)
      : state.flatToc;

    dom.tocList.textContent = "";
    if (items.length === 0) {
      const hint = document.createElement("div");
      hint.className = "pane-hint";
      hint.textContent = filter ? "没有匹配的章节" : "这本书没有目录";
      dom.tocList.appendChild(hint);
      return;
    }

    const fragment = document.createDocumentFragment();
    for (const entry of items) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "toc-item";
      button.dataset.level = String(Math.min(entry.level || 1, 5));
      button.dataset.chapter = String(entry.chapterIndex);
      button.textContent = entry.label || "未命名章节";
      button.title = entry.label || "";
      if (entry.chapterIndex === state.chapterIndex) {
        button.classList.add("is-active");
      }
      button.addEventListener("click", () => {
        const index = chapterIndexFromEntry(entry);
        openChapter({
          index: index,
          path: index === undefined ? entry.path : undefined,
          fragment: entry.fragment,
          scrollRatio: 0,
        });
        if (window.innerWidth < 700) {
          toggleDrawer(false);
        }
      });
      fragment.appendChild(button);
    }
    dom.tocList.appendChild(fragment);
  }

  function highlightActiveToc() {
    const items = dom.tocList.querySelectorAll(".toc-item");
    let firstActive = null;
    for (const item of items) {
      const matches = Number(item.dataset.chapter) === state.chapterIndex;
      item.classList.toggle("is-active", matches);
      if (matches && !firstActive) {
        firstActive = item;
      }
    }
    if (firstActive && firstActive.scrollIntoView) {
      firstActive.scrollIntoView({ block: "nearest" });
    }
  }

  /* ------------------------------------------------------------- bookmarks */

  function renderBookmarks() {
    dom.bookmarkList.textContent = "";
    if (state.bookmarks.length === 0) {
      const hint = document.createElement("div");
      hint.className = "pane-hint";
      hint.textContent = "还没有书签。读到想标记的地方按 b 即可。";
      dom.bookmarkList.appendChild(hint);
      return;
    }

    const fragment = document.createDocumentFragment();
    for (const bookmark of state.bookmarks) {
      const row = document.createElement("div");
      row.className = "bookmark-row";

      const button = document.createElement("button");
      button.type = "button";
      button.className = "link-item";
      const label = document.createElement("div");
      label.className = "bookmark-label";
      label.textContent = bookmark.label || "第 " + (bookmark.chapter + 1) + " 节";
      const excerpt = document.createElement("div");
      excerpt.className = "bookmark-excerpt";
      excerpt.textContent = bookmark.excerpt || "";
      const time = document.createElement("div");
      time.className = "bookmark-time";
      time.textContent = formatTime(bookmark.createdAt);
      button.appendChild(label);
      if (bookmark.excerpt) {
        button.appendChild(excerpt);
      }
      button.appendChild(time);
      button.addEventListener("click", () => {
        openChapter({ index: bookmark.chapter, scrollRatio: bookmark.scrollRatio });
      });

      const remove = iconButton("✕", "删除书签");
      remove.addEventListener("click", (event) => {
        event.stopPropagation();
        vscode.postMessage({ type: "removeBookmark", id: bookmark.id });
      });

      row.appendChild(button);
      row.appendChild(remove);
      fragment.appendChild(row);
    }
    dom.bookmarkList.appendChild(fragment);
  }

  function currentExcerpt() {
    if (!shadow || !shadow.elementFromPoint) {
      return "";
    }
    try {
      const rect = dom.surface.getBoundingClientRect();
      const x = Math.round(rect.left + rect.width / 2);
      const y = Math.round(rect.top + 24);
      const node = shadow.elementFromPoint(x, y);
      const block =
        node && node.closest ? node.closest("p, li, div, h1, h2, h3, h4, blockquote, td") : null;
      const source = block || node;
      const text = source && source.textContent ? source.textContent : "";
      return text.replace(/\s+/g, " ").trim().slice(0, 120);
    } catch (error) {
      return "";
    }
  }

  function addBookmark() {
    if (!state.chapterReady) {
      return;
    }
    const label =
      state.chapterTitle || "第 " + (state.chapterIndex + 1) + " 节";
    vscode.postMessage({
      type: "addBookmark",
      chapter: state.chapterIndex,
      scrollRatio: state.scrollRatio,
      label: (state.chapterIndex + 1) + ". " + label,
      excerpt: currentExcerpt(),
    });
  }

  /* ---------------------------------------------------------------- search */

  function renderSearchPlaceholder() {
    if (!dom.searchList.childElementCount) {
      setSearchSummary("输入关键词后回车开始全书搜索");
    }
  }

  function setSearchSummary(text) {
    dom.searchSummary.textContent = text;
  }

  function scheduleAutoSearch() {
    if (state.autoSearchTimer) {
      clearTimeout(state.autoSearchTimer);
    }
    const query = (dom.searchInput.value || "").trim();
    if (query.length < 2) {
      return;
    }
    state.autoSearchTimer = setTimeout(() => runSearch(false), 550);
  }

  function runSearch(explicit) {
    const query = (dom.searchInput.value || "").trim();
    if (state.autoSearchTimer) {
      clearTimeout(state.autoSearchTimer);
      state.autoSearchTimer = null;
    }
    if (query.length === 0) {
      dom.searchList.textContent = "";
      setSearchSummary("输入关键词后回车开始全书搜索");
      return;
    }
    if (query.length < 2 && !explicit) {
      return;
    }
    state.searchRequestId += 1;
    state.searchQuery = query;
    switchTab("search");
    setSearchSummary("正在搜索…");
    dom.searchList.textContent = "";
    vscode.postMessage({ type: "search", requestId: state.searchRequestId, query: query });
  }

  function applySearchResults(results) {
    if (!results || results.requestId !== state.searchRequestId) {
      return;
    }
    dom.searchList.textContent = "";
    if (results.hits.length === 0) {
      setSearchSummary('没有找到「' + results.query + '」');
      return;
    }
    const summary = [
      "找到 " + results.totalMatches + " 处",
      results.hits.length < results.totalMatches ? "（显示前 " + results.hits.length + " 处）" : "",
      " · " + results.elapsedMs + " ms",
    ].join("");
    setSearchSummary(summary);

    const fragment = document.createDocumentFragment();
    for (const hit of results.hits) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "link-item search-hit";
      const title = document.createElement("div");
      title.className = "search-hit-title";
      title.textContent = hit.chapterTitle || "第 " + (hit.chapter + 1) + " 节";
      const snippet = document.createElement("div");
      snippet.className = "search-hit-snippet";
      appendHighlighted(snippet, hit.snippet || "", results.query);
      button.appendChild(title);
      button.appendChild(snippet);
      button.addEventListener("click", () => {
        openChapter({
          index: hit.chapter,
          scrollRatio: 0,
          highlight: { query: results.query, occurrence: hit.occurrence },
        });
      });
      fragment.appendChild(button);
    }
    dom.searchList.appendChild(fragment);
  }

  function appendHighlighted(container, text, query) {
    if (!query || query.length === 0) {
      container.appendChild(document.createTextNode(text));
      return;
    }
    const haystack = text.toLowerCase();
    const needle = query.toLowerCase();
    let from = 0;
    while (from <= haystack.length - needle.length) {
      const at = haystack.indexOf(needle, from);
      if (at < 0) {
        break;
      }
      if (at > from) {
        container.appendChild(document.createTextNode(text.slice(from, at)));
      }
      const mark = document.createElement("mark");
      mark.textContent = text.slice(at, at + needle.length);
      container.appendChild(mark);
      from = at + needle.length;
    }
    container.appendChild(document.createTextNode(text.slice(from)));
  }

  /* ------------------------------------------------------------ progress */

  function scheduleProgressSave() {
    const now = Date.now();
    if (state.progressTimer) {
      return;
    }
    const delay = Math.max(0, 600 - (now - state.progressSentAt));
    state.progressTimer = setTimeout(() => {
      state.progressTimer = null;
      state.progressSentAt = Date.now();
      vscode.postMessage({
        type: "saveProgress",
        chapter: state.chapterIndex,
        scrollRatio: state.scrollRatio,
      });
    }, delay);
  }

  function updateStatus() {
    const total = Math.max(1, state.chapterCount);
    dom.statusChapter.textContent = state.chapterIndex + 1 + " / " + total;
    const percent = Math.round(state.scrollRatio * 100);
    dom.statusPercent.textContent = percent + "%";
    dom.progressFill.style.width = percent + "%";
  }

  /* --------------------------------------------------------------- chrome */

  function syncSettingsUi() {
    dom.themeSelect.value = state.settings.pageTheme;
  }

  function changeFontSize(delta) {
    const next = clamp(state.settings.fontSize + delta, 12, 40);
    if (next === state.settings.fontSize) {
      return;
    }
    state.settings.fontSize = next;
    vscode.postMessage({ type: "updateSetting", key: "fontSize", value: next });
    showToast("字号 " + next + "px", "info");
    rerenderSurface();
  }

  function resetFontSize() {
    if (state.settings.fontSize === DEFAULT_SETTINGS.fontSize) {
      return;
    }
    state.settings.fontSize = DEFAULT_SETTINGS.fontSize;
    vscode.postMessage({
      type: "updateSetting",
      key: "fontSize",
      value: DEFAULT_SETTINGS.fontSize,
    });
    rerenderSurface();
  }

  function toggleDrawer(force) {
    state.drawerOpen = typeof force === "boolean" ? force : !state.drawerOpen;
    dom.app.setAttribute("data-drawer-open", state.drawerOpen ? "true" : "false");
  }

  function switchTab(tab) {
    if (!tab) {
      return;
    }
    state.activeTab = tab;
    const tabs = document.querySelectorAll(".drawer-tabs .tab");
    for (const item of tabs) {
      item.classList.toggle("is-active", item.getAttribute("data-tab") === tab);
    }
    const panes = document.querySelectorAll(".pane");
    for (const pane of panes) {
      pane.classList.toggle("is-active", pane.id === "pane-" + tab);
    }
    if (tab !== "toc") {
      toggleDrawer(true);
    }
  }

  function toggleHelp(force) {
    const show = typeof force === "boolean" ? force : dom.help.hidden;
    dom.help.hidden = !show;
  }

  let toastTimer = null;

  function showToast(message, level) {
    dom.toast.textContent = message;
    dom.toast.dataset.level = level || "info";
    dom.toast.hidden = false;
    if (toastTimer) {
      clearTimeout(toastTimer);
    }
    toastTimer = setTimeout(() => {
      dom.toast.hidden = true;
    }, 2600);
  }

  let loadingTimer = null;

  /** Delay the spinner so fast chapter switches do not flash. */
  function showLoading() {
    if (loadingTimer) {
      clearTimeout(loadingTimer);
    }
    loadingTimer = setTimeout(() => {
      loadingTimer = null;
      dom.loading.hidden = false;
    }, 140);
  }

  function hideLoading() {
    if (loadingTimer) {
      clearTimeout(loadingTimer);
      loadingTimer = null;
    }
    dom.loading.hidden = true;
  }

  function showErrorBox(message) {
    clearErrorBox();
    const box = document.createElement("div");
    box.className = "error-box";
    box.id = "error-box";
    box.textContent = message;
    dom.surface.hidden = true;
    dom.loading.parentElement.appendChild(box);
  }

  function clearErrorBox() {
    const existing = document.getElementById("error-box");
    if (existing) {
      existing.remove();
    }
    dom.surface.hidden = false;
  }

  /* ------------------------------------------------------------- keyboard */

  function onKeyDown(event) {
    if (event.ctrlKey || event.metaKey || event.altKey) {
      return;
    }
    const target = event.target;
    const tag = target && target.tagName ? target.tagName.toLowerCase() : "";
    const typing =
      tag === "input" || tag === "textarea" || tag === "select" ||
      (target && target.isContentEditable === true);

    if (typing) {
      if (event.key === "Escape" && target && target.blur) {
        target.blur();
      }
      return;
    }

    switch (event.key) {
      case "[":
      case "ArrowLeft":
      case "h":
      case "H":
        previousChapter();
        break;
      case "]":
      case "ArrowRight":
      case "l":
      case "L":
        nextChapter();
        break;
      case "t":
      case "T":
        toggleDrawer();
        break;
      case "/":
        switchTab("search");
        dom.searchInput.focus();
        dom.searchInput.select();
        break;
      case "b":
      case "B":
        addBookmark();
        break;
      case "+":
      case "=":
        changeFontSize(1);
        break;
      case "-":
      case "_":
        changeFontSize(-1);
        break;
      case "0":
        resetFontSize();
        break;
      case "?":
        toggleHelp();
        break;
      case "Escape":
        if (!dom.help.hidden) {
          toggleHelp(false);
        } else {
          toggleDrawer(false);
        }
        break;
      default:
        return;
    }
    event.preventDefault();
  }

  /* ------------------------------------------------------------------ run */

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
