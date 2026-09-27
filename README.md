# EPUB View

在 VS Code 里直接读 EPUB 电子书 —— 双击 `.epub` 就能打开，不用切到别的阅读器；想改两笔，按 `e` 进入编辑模式，像改文档一样点着正文改，`Ctrl+S` 存回原书。零运行时依赖，只用 Node 标准库解析 ZIP 与 XHTML。

[![VS Marketplace](https://img.shields.io/badge/VS%20Marketplace-EPUB%20View-0078d4)](https://marketplace.visualstudio.com/items?itemName=ssfg.epub-view)
[![CI](https://github.com/juzishazhou/epub_reader_vscode/actions/workflows/ci.yml/badge.svg)](https://github.com/juzishazhou/epub_reader_vscode/actions/workflows/ci.yml)
[![License](https://img.shields.io/github/license/juzishazhou/epub_reader_vscode)](LICENSE)

![阅读界面](docs/reading-ui.png)

## 功能

| 能力 | 说明 |
| --- | --- |
| 双击即读 | 注册 `.epub` 自定义编辑器，资源管理器右键也能「用 EPUB View 打开」 |
| 目录导航 | EPUB 3 的 NAV 与 EPUB 2 的 NCX 都支持，多级目录树 + 筛选框，自动定位当前章 |
| 全书搜索 | 跨全部章节搜索，带上下文片段、命中数与耗时，点击跳转并高亮命中处 |
| 书签 | 在当前位置加书签（自动摘录当前段落），列表可跳转、删除 |
| 进度记忆 | 记住每本书的章节与滚动位置，重开自动回到原位；「继续阅读…」列出最近读的书 |
| 可视化编辑 | 按 `e` 进入编辑模式，正文跟阅读时长得一样，直接点进去改字；改动自动写入文档，`Ctrl+S` 存回 `.epub`（见[编辑书籍](#编辑书籍)） |
| 源码编辑 | 编辑面板里可切换到当前章节的 XHTML 源码，直接改标签与属性 |
| 完整排版 | EPUB 内的 CSS、`@import`、`url()`、图片、SVG、字体全部解析改写；正文在 Shadow DOM 中渲染，书的样式不会污染 VS Code 界面 |
| 安全清洗 | 阅读时章节里的 `<script>`、`<iframe>`、`on*` 事件属性、`javascript:` 链接一律剔除，配合 CSP 双重拦截；编辑模式下它们只是被隐藏，以便原样写回 |
| 阅读设置 | 字号、行高、行宽、正文配色（跟随主题 / 浅色 / 护眼 / 深色），实时生效并持久化 |
| 跟随主题 | 工具栏、目录、状态栏全部使用 VS Code 主题变量，亮色 / 暗色 / 高对比度都正常 |

![搜索界面](docs/search-ui.png)

## 安装

**Marketplace**：在 VS Code 扩展面板搜索 `EPUB View`，或

```powershell
code --install-extension ssfg.epub-view
```

**手动安装 VSIX**：从 [Releases](https://github.com/juzishazhou/epub_reader_vscode/releases) 下载最新的 `.vsix` 后（文件名里是版本号）

```powershell
code --install-extension epub-view-0.2.1.vsix   # 换成你下载到的文件名
```

装完执行一次 **`Developer: Reload Window`**，扩展才会生效。

## 打开一本书

1. 在资源管理器里**双击**任意 `.epub`；
2. 或者右键 →「打开方式...」→「EPUB View」；
3. 或者命令面板执行 `EPUB View: 用 EPUB View 打开`。

> **和别的 epub 扩展共存**：如果装了多个能打开 `.epub` 的扩展，双击时可能被对方接管。用右键「打开方式...」显式选择，或在用户设置里钉死：
> ```json
> "workbench.editorAssociations": { "*.epub": "epubReader.reader" }
> ```

## 快捷键

| 按键 | 作用 |
| --- | --- |
| `[` / `←` / `h` | 上一章 |
| `]` / `→` / `l` | 下一章 |
| `t` | 展开 / 收起侧栏 |
| `/` | 聚焦搜索框 |
| `b` | 在当前位置加书签 |
| `e` | 进入 / 退出编辑模式 |
| `Ctrl+S` | 写入改动并保存 `.epub` |
| `+` / `-` | 字号增减 |
| `0` | 恢复默认字号 |
| `?` | 显示快捷键帮助 |
| `Esc` | 关闭浮层 / 取消输入焦点 / 退出编辑模式 |

在输入框里打字时单键快捷键不会触发，中文输入法组合期间也不会误触发搜索；编辑模式下单键快捷键全部让位给正文。

## 编辑书籍

按 `e`（或点工具栏的 ✎）进入编辑模式：**正文和阅读时一模一样，只是可以直接点进去改字**。

| 操作 | 说明 |
| --- | --- |
| 直接改字 | 点进正文即可编辑，支持选择、复制、粘贴、输入法；`Enter` 分段仍是 `<p>` |
| 自动写入 | 停笔约 1 秒后改动写入文档，标签页出现未保存圆点；也可以点「应用」立刻写入 |
| 保存 | `Ctrl+S` 把改动写回 `.epub` 文件 |
| 排版 / 源码 | 「排版」在排版结果上直接改字，「源码」切到当前章节的 XHTML 原文 |
| 还原此文件 | 丢弃这个文件的改动，回到磁盘上的版本（把章节改坏时的救命按钮） |
| 撤销 | VS Code 的 `Ctrl+Z` / `Ctrl+Y`；一次写入是一个撤销步骤 |
| 退出 | `Esc`、点 ✕，或再按一次 `e`；还有没写入的改动时会先问一句 |

**改动会破坏原书吗？** 保存只替换该章节 `<body>` 的内部：XML 声明、doctype、`<head>`（含样式表引用）、`<body>` 自己的属性、以及 ZIP 里其它文件都原样不动。阅读时被剔除的 `<script>`、`<iframe>`、`on*` 等元素在编辑模式下只是被隐藏，保存时原样写回；图片、链接、样式里的地址也会还原成书里本来的相对路径，而不是编辑器内部用的地址。

**想彻底只读？** 关掉 `epubReader.enableEditing` 即可，工具栏的编辑按钮会禁用。

## 设置

| 配置项 | 默认 | 说明 |
| --- | --- | --- |
| `epubReader.fontSize` | `17` | 正文字号（px），12–40 |
| `epubReader.lineHeight` | `1.75` | 行高倍数，1.2–3 |
| `epubReader.maxWidth` | `46` | 正文最大宽度（rem），限制行长便于阅读 |
| `epubReader.pageTheme` | `auto` | `auto` 跟随 VS Code 主题，或 `light` / `sepia` / `dark` |
| `epubReader.rememberProgress` | `true` | 是否记住阅读位置 |
| `epubReader.enableEditing` | `true` | 是否允许编辑并写回 EPUB；关掉即只读 |

## 常见问题

**中文乱码？**
不会。读取章节时会嗅探 BOM 与 XML 声明里的编码，GBK / GB18030 / Big5 / UTF-16 都能正确解码。

**打开报「无法打开」？**
加密或带 DRM 的 EPUB（Adobe ADEPT、LCP）不支持，会给出明确提示。文件损坏、缺 `META-INF/container.xml` 同理。

**目录里某一项点了没反应？**
目录项指向的不是 spine 里的正文（有些书会指向单独的版权页或封面页），此时会提示并跳过。

**进度和书签存在哪？**
存在 VS Code 的 `globalState` 里（`epubReader.progress` / `epubReader.bookmarks` / `epubReader.recents`），以**文件路径**哈希为键，所以重新下载同名书不会丢进度。解压出的图片样式缓存在扩展 `globalStorage/books/` 下，两周未访问会自动清理。想完全重置：命令面板执行 `EPUB View: 清除阅读记录与书签`，再删掉 `globalStorage/books` 目录。

**排版为什么和手机阅读器不完全一样？**
正文渲染在 Shadow DOM 里，书的 CSS 中 `html` / `body` / `:root` 选择器不会命中，这部分样式由阅读器接管——这正是它能稳定跟随 VS Code 主题、且书的样式不会污染编辑器界面的原因。其余选择器（类名、标签、图片、表格等）都按书的原样生效。

**支持多大的书？**
实测 9.9 MB / 1660 章的 EPUB：打开 0.1–0.2 秒，全书建索引 0.3–0.9 秒。索引按需建立，首次搜索会显示进度提示。

**编辑后保存报「No custom document found」？**
这是 VS Code 在窗口重载后恢复标签页时会丢掉它内部的文档登记造成的。0.2.1 起扩展会自动降级：编辑照常写入草稿，`Ctrl+S` 直接写文件不会丢，并提示一次「保存并重新打开」。想彻底恢复（连同撤销栈），关掉这本书再打开即可。

**编辑会不会把书改坏？**
保存时只重压缩改动过的条目，其余 1664 个条目按原始压缩字节原样复制，`mimetype` 仍是首个且不压缩；编辑内容只替换 `<body>` 内部，其余部分逐字节保留。仓库里的真实书籍用例会逐个比对每个条目的解压内容与压缩字节。

**编辑后文件体积变了？**
保存会规范化 ZIP 头部（去掉可选 extra 字段与注释），10 MB 的书实测变化在 0.3% 以内；内容一个字节没少。另外改动过的条目会以 UTF-8 重新编码并同步修正 XML 声明里的编码，原文若是 GBK 也不会乱码。

**编辑模式里正文和阅读时一样吗？**
排版、字体、配色完全一致，同一个渲染管线。区别只有一个：阅读时会被剔除的 `script` / `iframe` 等元素在编辑模式下被隐藏保留（方便原样写回），链接在编辑时是惰性的、点它不会跳转。

## 开发

架构说明、代码结构、编辑管线与调试方式见 [DEVELOPMENT.md](DEVELOPMENT.md)；发版流程见 [RELEASING.md](RELEASING.md)。

```powershell
npm install
npm run compile     # tsc 编译到 out/
npm run verify      # 编译 + webview 契约检查 + 全部测试
npm run screenshot  # 用真实渲染生成 docs/*.png
```

## 许可

[MIT](LICENSE)
