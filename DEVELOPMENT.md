# 开发说明

面向想改这个扩展的人。用户文档在 [README.md](README.md)。

## 命令速查

从改一行代码到装进 VS Code，全流程就这几条命令（都在项目根目录跑）。

### 日常开发

```powershell
npm install              # 首次：装 devDependencies（typescript / jsdom / @types/*）

npm run watch            # 改 src/**：后台增量编译到 out/，按 F5 重新加载扩展宿主
npm run compile          # 一次性编译
npm run typecheck        # 只做类型检查（--noEmit），比 compile 更适合当保存钩子

npm run verify           # 提交前跑这个：编译 + webview 契约检查 + 全部测试
```

调试：在 VS Code 里打开本目录按 **F5**（`.vscode/launch.json` 第二份配置会直接打开旁边的示例书）。
`src/**` 改动重新 F5；只改 `media/reader.js` / `media/reader.css` 时，扩展宿主不用重启，重载窗口即可。

### 测试

```powershell
npm test                 # node --test，每个测试文件一个子进程（CI 与本地常规用法）
npm run test:single      # 单进程跑完全部测试（受限沙箱里无法 spawn 时用这个）
npm run check:webview    # webview 静态契约检查：id 对应、[hidden] 护栏

# 真实书籍用例默认跳过；给一本 EPUB 就跑起来（会断言章节数、索引耗时，并做整本书的编辑回写比对）
$env:EPUB_READER_SAMPLE = "D:\books\some-book.epub"; npm test
```

### 看效果 / 出素材

```powershell
npm run preview          # 生成 preview/*.html，浏览器打开即可看渲染（含编辑模式）
npm run screenshot       # 用无头 Chrome 出图到 docs/*.png（需要能启动 Chrome 的普通终端）
npm run icon             # 重新生成 media/icon.png
```

### 打包与安装

```powershell
npm run vsix             # 生成 epub-view-<version>.vsix（vsce package --no-dependencies）

# 本机安装/升级：装完执行 Developer: Reload Window
code --install-extension epub-view-0.2.1.vsix --force
```

`.vscodeignore` 决定包里有什么：进包的是 `out/**`（不含 `out/src/test/**`）、`media/**`、`README.md`、
`CHANGELOG.md`、`LICENSE`、`package.json`；`src/**`、`scripts/**`、`docs/**`、`preview/**`、示例 `*.epub`
都不进包。打完可以用 `npx --yes @vscode/vsce ls` 复核文件清单。

### 发版

```powershell
# 自动（推荐）：改版本、提交、打 tag，CI 负责 verify → 打包 → 发 Marketplace → 建 Release
npm version patch        # 或 minor / major
git push --follow-tags

# 手动
npm run verify
npm run vsix
npx --yes @vscode/vsce publish --no-dependencies   # 需要 VSCE_PAT 或先 vsce login ssfg
```

完整发版流程（发布者、PAT、secret 配置）见 [RELEASING.md](RELEASING.md)。

### 环境坑（踩过的）

| 现象 | 原因与对策 |
| --- | --- |
| `node --test` 报 `spawn EPERM` | 受限沙箱禁止子进程管道：改用 `npm run test:single` |
| `npm run screenshot` 报 `mojo ... 拒绝访问` | 沙箱禁止 Chrome 需要的命名管道：在普通终端跑，或只看 `preview/*.html` |
| 编辑后保存报 `No custom document found` | 窗口重载后 VS Code 恢复的标签页会失去它内部的文档登记。0.2.1 起会自动降级为直接写文件；彻底恢复请重开这本书 |
| `code --install-extension` 后没变化 | 扩展不会热更新：重装后执行 `Developer: Reload Window` |

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
    zip.ts             只读 ZIP：中央目录索引 + 按需 inflate（支持 Zip64）+ 编辑覆盖层
    zipwrite.ts        写回 ZIP：未改条目按原始压缩字节复制，只重压缩改过的条目
    xml.ts             宽松 XML/XHTML 解析器与序列化
    util.ts            路径归一化、百分号解码、编码嗅探（UTF-8/BOM/GBK/Big5…）
    book.ts            container.xml → OPF → manifest/spine/metadata → NCX/NAV 目录
    render.ts          章节清洗、资源改写、CSS 内联、搜索高亮注入、编辑保真渲染
    edit.ts            写回侧：可编辑条目清单、注解还原、<body> 外科替换、编码归一化
    search.ts          全书惰性索引与检索
  editor/              与 VS Code API 打交道
    epubEditorProvider.ts  CustomEditorProvider（阅读 + 编辑保存 / 撤销 / 热退出备份）
    epubDocument.ts        已打开的文档：解析结果 + 资源缓存 + 全文索引 + 编辑覆盖层
    readerSession.ts       单个面板：消息循环、渲染流水线、进度落盘、编辑消息
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

## 编辑管线

编辑模式与阅读模式共用同一个渲染器，只是 `renderChapter(..., { fidelity: "edit" })` 换了几个策略：

1. **不丢东西**：阅读时会被剔除的 `script` / `iframe` / 表单等元素改成加一个 `epub-keep` 类留在 DOM 里
   （CSS 里 `display: none`）；`on*` 事件属性保留，因为它们本来就被外壳 CSP（`script-src 'nonce-…'`）
   挡死。链接完全不改写，保持书里本来的 href。
2. **改写都留底**：`img@src`、`image@href`、内联 `style` 的 `url()` 这些为了显示必须改写的地方，
   会把原值写进 `data-epub-orig-<属性名>`；body 里的 `<style>`/`<link>` 就地保留，不再收集进 css 数组。
3. **浏览器序列化回来**：客户端把可编辑容器的 `innerHTML` 发回宿主。宿主用同一套宽松解析器解析，
   `restoreEditedMarkup()` 把 `data-epub-orig-*` 还原成原属性、去掉 `epub-keep` 标记，
   `spliceBody()` 只把这段内容替换进原文 `<body>…</body>` 的内部 —— 声明、doctype、`<head>`、
   body 标签属性因此逐字节保留。
4. **归一化**：`normalizeWrittenText()` 保持原文件的换行风格；原文若声明了非 UTF-8 编码，
   声明同步改成 utf-8（我们写出去的字节就是 UTF-8）。
5. **写入与落盘**：编辑进的是文档覆盖层（`ZipArchive.setOverride`），`EpubDocument` 用它重新解析整本书，
   所以阅读视图立刻能看到改动，而磁盘文件不动。保存时 `rewriteZip()` 重新拼 ZIP：改过的条目用
   UTF-8 文本重新压缩，其它条目按原始压缩字节复制，`mimetype` 仍在最前且不压缩。
   写盘走「临时文件 + rename，失败则原地覆盖」。

其余相关约定：

- **一次写入 = 一个撤销步骤。** `EpubDocument.applyEdit()` 返回 `undo`/`redo` 闭包，provider 把它
  交给 VS Code 的 `onDidChangeCustomDocument`，所以 Ctrl+Z / Ctrl+Y 和保存后的状态都由 VS Code 管。
- **自动写入。** 客户端停笔 900 ms 后自动 `applyEdit`；`Ctrl+S` 先 flush 再让宿主执行
  `workbench.action.files.save`（带 webview 焦点的自定义编辑器会走 `saveCustomDocument`）。
- **不会丢光标。** 发起编辑的面板在 `edited` 事件里收到 `forceRender: false`，只更新目录等外壳；
  保存 / 撤销 / 别的面板编辑则带 `forceRender: true`，客户端重新拉取编辑内容并按字符偏移恢复光标。
- **改坏了也能救。** 覆盖层让书解析失败时，`book` 变成 `undefined`，面板会提示而不是崩掉；
  「还原此文件」用一份惰性打开的原始归档（`EpubDocument.originalText()`）把该文件恢复成磁盘版本，
  撤销栈同样记一步。
- **热退出。** `backupCustomDocument` 只把「路径 → 新文本」写成一个 JSON，热退出后按 backupId 还原；
  空改动不写文件。

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
| `zipwrite.test.ts` | 改写 ZIP：`mimetype` 仍居首且不压缩、未改条目压缩字节逐字节相同、条目顺序不变、编辑条目重压缩、带空格条目名 |
| `xml.test.ts` | 命名空间前缀、CDATA、DOCTYPE、实体、`<` 出现在正文、标签不闭合的恢复 |
| `book.test.ts` | EPUB 2（NCX）/ EPUB 3（NAV）、多级目录、百分号路径、封面识别、错误提示 |
| `render.test.ts` | 清洗、资源与 CSS `url()` 改写（含 `@import` 只改写一次）、链接标注、高亮定位 |
| `edit.test.ts` | 可编辑条目清单、编辑保真渲染（注解与被保留元素）、**编辑 → 还原 → 拼接回原文**的全链路保真、`<body>` 外科替换、编码 / 换行归一化 |
| `search.test.ts` | 大小写、每章与总量截断、取消、片段 |
| `host.test.ts` | 假 `vscode` 模块里跑真实扩展：`ready → init → chapter → 搜索 → 高亮 → 书签 → 进度落盘 → 重开续读` |
| `editflow.test.ts` | 宿主编辑流：进入编辑、应用、撤销 / 重做、保存后的落盘内容、源码改 CSS、还原单文件、热退出备份、只读开关、多面板一致、改坏 OPF 后恢复 |
| `webview.test.ts` | jsdom 里加载真实 shell HTML 与真实 `reader.js`，验证目录、Shadow DOM 正文、链接点击、快捷键、搜索防抖、书签增删、主题与字号、错误页、**编辑模式 UI（可编辑正文、自动写入、脏保护、Ctrl+S、文件切换、只读）** |

真实书籍用例（`realbook.test.ts` 与 `host.test.ts` 最后一个）默认**跳过**：仓库不附带 EPUB。想跑它们，
把任意 EPUB 放进 `fixtures/`，或设置环境变量指向一本书：

```powershell
$env:EPUB_READER_SAMPLE = "D:\books\some-book.epub"; npm test
```

这些用例会断言章节数、目录标题与首章文本，打印打开与建索引耗时（9.9 MB / 1660 章的示例书：打开
0.1–0.2 秒，建索引 0.3–0.9 秒），并做一次**整本书的编辑回写比对**：改一章再重新拼 ZIP，逐个断言
其余 1664 个条目的解压内容与压缩字节完全一致。

**在受限沙箱里**（禁止子进程管道）`node --test` 会因无法 spawn 而报 `EPERM`，改用
`npm run test:single`（`--experimental-test-isolation=none`，单进程跑完）。

## 看效果

```powershell
npm run preview      # preview/fixture-epub3.html —— 含 CSS/@import/图片/链接的样例章节
npm run screenshot   # docs/reading-ui.png + docs/search-ui.png + docs/edit-ui.png
```

`scripts/screenshot.mjs` 走的是真实链路：用假 `vscode` 模块启动真实宿主拿到**真实 shell HTML** 与
**真实章节数据**，注入真实 `reader.css` / `reader.js`，再补上 VS Code 的 `--vscode-*` 主题变量，
最后用 Chrome 无头渲染成图。它既是发布素材，也是唯一能看见版式的手段——jsdom 没有布局，
测不了像素。想换主题或换书，改脚本里的 `THEME` 与 `jobs`；`edit: true` 的那个 job 会先向宿主
要编辑内容再截图，所以能拍到编辑模式。截图需要能启动 Chrome 的普通终端：受限沙箱里 Chrome 的
进程间通道（命名管道）被拦，会以 `mojo ... 拒绝访问` 失败，此时只会生成 `preview/*.html`。

## 已知限制

- 不支持加密 / DRM 的 EPUB（Adobe ADEPT、LCP）。
- 目录项指向非 spine 文档时跳过。
- 书的 `html` / `body` / `:root` 样式在 Shadow DOM 中不生效。
- `@import` 上的媒体查询条件会被丢弃（样式内容仍会内联）。
- 只有滚动阅读模式，没有分页 / 双栏。
- 编辑只写 `<body>` 内部，且只支持**文本**条目：图片等二进制资源、`mimetype`、`META-INF/` 不可编辑，
  也不能新增或删除文件。
- 编辑后的章节由浏览器的 HTML 序列化产出：属性引号、实体写法、空元素自闭合形式会规范化，
  语义与可见排版不变，但纯手写格式不再逐字节保留（`<body>` 之外的部分才是逐字节保留）。
- 编辑模式下链接是惰性的（点击不跳转），阅读时被隐藏的元素虽然保留在 DOM 中，但只有 CSP 在挡它们。
- 保存会规范化 ZIP 头部（丢弃可选 extra 字段 / 注释），文件体积可能有零点几个百分点的变化。
