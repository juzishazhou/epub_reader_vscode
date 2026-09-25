# 开发说明

面向想改这个扩展的人。用户文档在 [README.md](README.md)。

## 环境

- Node.js 20+（开发时用 22）
- VS Code 1.85+
- 无需任何全局工具

```powershell
npm install
npm run compile      # tsc 编译到 out/
npm run watch        # 监听编译
npm run verify       # 编译 + webview 契约检查 + 全部测试
```

调试：在 VS Code 里打开本目录按 **F5**（`.vscode/launch.json` 第二份配置会直接打开旁边的示例书）。改动 `media/` 下的 webview 资源后需要重载窗口；改 `src/` 后重新 F5。

## 代码结构

```
src/
  epub/                纯 Node 逻辑，不 import vscode，因此可以直接单测
    zip.ts             只读 ZIP：中央目录索引 + 按需 inflate（支持 Zip64）
    xml.ts             宽松 XML/XHTML 解析器与序列化
    util.ts            路径归一化、百分号解码、编码嗅探（UTF-8/BOM/GBK/Big5…）
    book.ts            container.xml → OPF → manifest/spine/metadata → NCX/NAV 目录
    render.ts          章节清洗、资源改写、CSS 内联、搜索高亮注入
    search.ts          全书惰性索引与检索
  editor/              与 VS Code API 打交道
    epubEditorProvider.ts  CustomEditorProvider（只读）
    epubDocument.ts        已打开的文档：解析结果 + 资源缓存 + 全文索引
    readerSession.ts       单个面板：消息循环、渲染流水线、进度落盘
    storage.ts             globalState 里的进度 / 书签 / 最近阅读
    shell.ts               webview HTML 外壳与 CSP
    protocol.ts            host ↔ webview 的消息类型
  test/                node:test；helpers 内含内存 ZIP 写入器、EPUB 样例、假 vscode 模块
media/
  reader.css           webview 样式（只用 VS Code 主题变量）
  reader.js            webview 客户端（无框架、无构建步骤）
  icon.png             Marketplace 图标，由 scripts/make-icon.mjs 生成
scripts/
  make-icon.mjs        生成 128×128 图标（纯 Node 画图 + 自写 PNG 编码）
  preview.mjs          把渲染结果写成 HTML，便于快速看效果
  screenshot.mjs       用真实 shell + 真实客户端 + Chrome 无头出图到 docs/
  check-webview.mjs    webview 静态契约检查（见下）
```

## 渲染流水线

1. `ZipArchive.open()` 只读中央目录，章节与资源按需解压 —— 10 MB 的书打开约 0.1–0.2 秒；
2. `openEpub()` 解析 OPF，得到元数据、spine 顺序与目录树，每个目录项都映射到 spine 序号；
3. 打开某章时 `renderChapter()` 把 XHTML 解析成节点树：丢弃 `script` / `iframe` / `head` 等，剔除事件属性，
   把 `img@src`、`image@xlink:href`、`a@href`、内联 `style` 的 `url()` 改写成 webview 可访问的 URI，
   把 `<link rel=stylesheet>` 与 `<style>` 内联为 CSS 文本（`@import` 递归展开、`url()` 只改写一次）；
4. 引用到的资源解压到 `<globalStorage>/books/<bookId>/<contentHash>/…`，由 `webview.asWebviewUri` 生成地址；
5. 客户端把 `body` 与 `css` 放进阅读区的 Shadow DOM，配上跟随主题的排版；
   搜索命中由宿主注入 `<mark class="reader-hit">`，客户端只负责滚动过去。

### 搜索命中为什么不会错位

`chapterText()` 与 `renderChapter()` 共用同一套遍历（同样的丢弃规则、同样的文本节点顺序、同样跳过
`<script>`/`<style>` 的原始内容），所以「第 N 次命中」在索引侧和渲染侧含义完全一致。搜索结果里的
`occurrence` 直接交给渲染层注入高亮，不需要客户端猜偏移。

## 几个关键取舍

**零运行时依赖。** ZIP 与 XML 都是自己实现的（`zip.ts` + `xml.ts`，约 740 行）。换 jszip +
fast-xml-parser 能省掉这些代码，但会引入第三方依赖与它们的打包/更新成本；对只做「读」的场景，
自写实现反而更小更可控。XML 解析器刻意写得宽容：标签不闭合、命名空间前缀、CDATA、`<` 出现在正文里
都能正确恢复，因为电子书是上千种生成器造出来的。

**正文用 Shadow DOM，不用 srcdoc iframe。** iframe 在语义上更干净（真正的独立文档），但 VS Code 的
webview 宿主页 CSP 是 `frame-src 'self'`，而 srcdoc 在 `frame-src` 下是否被 Chromium 拦截没有权威结论；
Shadow DOM 没有这个不确定性，同样能隔离书的样式。代价是书的 `html`/`body`/`:root` 规则不生效
（见 README 的常见问题）。

**`[hidden]` 护栏不能删。** `reader.css` 顶部的 `[hidden] { display: none !important; }` 不是装饰：
`hidden` 属性只在浏览器默认样式表里对应 `display: none`，任何作者样式里针对同一元素写的
`display` 都会赢。浮层（`.help-overlay`、`.loading`）正是 `display: flex`，所以少了这条护栏，
它们会永久可见、且 `element.hidden = true` 完全失效。这类 bug **jsdom 抓不到**（它对这条规则的判断
和真实浏览器相反），因此由 `scripts/check-webview.mjs` 静态检查兜底。

**webview 客户端不碰 `innerHTML` 拼书内容以外的字符串。** 目录、书签、搜索结果一律用
`createElement` + `textContent` 构造，宿主发来的章节正文已经过清洗与改写，才允许写进 Shadow DOM。

## 测试

```powershell
npm test          # node --test，每个测试文件一个子进程
npm run verify    # 上面的基础上再加编译与契约检查
```

四层覆盖：

| 文件 | 覆盖内容 |
| --- | --- |
| `zip.test.ts` | stored/deflate、中文条目名、BOM 与声明编码、损坏文件报错 |
| `xml.test.ts` | 命名空间前缀、CDATA、DOCTYPE、实体、`<` 出现在正文、标签不闭合的恢复 |
| `book.test.ts` | EPUB 2（NCX）/ EPUB 3（NAV）、多级目录、百分号路径、封面识别、错误提示 |
| `render.test.ts` | 清洗、资源与 CSS `url()` 改写（含 `@import` 只改写一次）、链接标注、高亮定位 |
| `search.test.ts` | 大小写、每章与总量截断、取消、片段 |
| `host.test.ts` | 假 `vscode` 模块里跑真实扩展：`ready → init → chapter → 搜索 → 高亮 → 书签 → 进度落盘 → 重开续读` |
| `webview.test.ts` | jsdom 里加载真实 shell HTML 与真实 `reader.js`，验证目录、Shadow DOM 正文、链接点击、快捷键、搜索防抖、书签增删、主题与字号、错误页 |

真实书籍用例（`realbook.test.ts` 与 `host.test.ts` 最后一个）默认**跳过**：仓库不附带 EPUB。想跑它们，
把任意 EPUB 放进 `fixtures/`，或设置环境变量指向一本书：

```powershell
$env:EPUB_READER_SAMPLE = "D:\books\some-book.epub"; npm test
```

这些用例会断言章节数、目录标题与首章文本，并打印打开与建索引耗时（9.9 MB / 1660 章的示例书：打开 0.1–0.2 秒，建索引 0.3–0.9 秒）。

**在受限沙箱里**（禁止子进程管道）`node --test` 会因无法 spawn 而报 `EPERM`，改用
`npm run test:single`（`--experimental-test-isolation=none`，单进程跑完）。

## 看效果

```powershell
npm run preview      # preview/fixture-epub3.html —— 含 CSS/@import/图片/链接的样例章节
npm run screenshot   # docs/reading-ui.png + docs/search-ui.png
```

`scripts/screenshot.mjs` 走的是真实链路：用假 `vscode` 模块启动真实宿主拿到**真实 shell HTML** 与
**真实章节数据**，注入真实 `reader.css` / `reader.js`，再补上 VS Code 的 `--vscode-*` 主题变量，
最后用 Chrome 无头渲染成图。它既是发布素材，也是唯一能看见版式的手段——jsdom 没有布局，
测不了像素。想换主题或换书，改脚本里的 `THEME` 与 `jobs`。

## 已知限制

- 不支持加密 / DRM 的 EPUB（Adobe ADEPT、LCP）。
- 目录项指向非 spine 文档时跳过。
- 书的 `html` / `body` / `:root` 样式在 Shadow DOM 中不生效。
- `@import` 上的媒体查询条件会被丢弃（样式内容仍会内联）。
- 只有滚动阅读模式，没有分页 / 双栏。
