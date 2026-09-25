import { ZipFileInput, createPng, createZip } from "./zipwriter";

const PNG = createPng();

function epub3Entries(): ZipFileInput[] {
  return [
    { name: "mimetype", data: "application/epub+zip", store: true },
    {
      name: "META-INF/container.xml",
      data: `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OPS/package.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`,
    },
    {
      name: "OPS/package.opf",
      data: `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pub-id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="pub-id">urn:uuid:test-0001</dc:identifier>
    <dc:title>测试之书</dc:title>
    <dc:creator>测试作者</dc:creator>
    <dc:creator>第二作者</dc:creator>
    <dc:language>zh-CN</dc:language>
    <dc:publisher>单元测试出版社</dc:publisher>
    <dc:description>一本用于测试的电子书。</dc:description>
    <meta property="dcterms:modified">2024-01-01T00:00:00Z</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="c1" href="text/chapter1.xhtml" media-type="application/xhtml+xml"/>
    <item id="c2" href="text/chapter2.xhtml" media-type="application/xhtml+xml"/>
    <item id="c3" href="text/sub/chapter3.xhtml" media-type="application/xhtml+xml"/>
    <item id="cover" href="images/cover.png" media-type="image/png" properties="cover-image"/>
    <item id="css" href="styles/main.css" media-type="text/css"/>
    <item id="extra" href="styles/extra.css" media-type="text/css"/>
    <item id="diagram" href="images/diagram.svg" media-type="image/svg+xml"/>
  </manifest>
  <spine>
    <itemref idref="c1"/>
    <itemref idref="c2"/>
    <itemref idref="c3"/>
  </spine>
</package>`,
    },
    {
      name: "OPS/nav.xhtml",
      data: `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>目录</title></head>
<body>
<nav epub:type="toc" id="toc">
  <h1>目录</h1>
  <ol>
    <li><a href="text/chapter1.xhtml">第一章 起点</a>
      <ol>
        <li><a href="text/chapter1.xhtml#sec1">第一节 小节</a></li>
      </ol>
    </li>
    <li><a href="text/chapter2.xhtml">第二章 转折</a></li>
    <li><a href="text/sub/chapter3.xhtml">第三章 深入</a></li>
  </ol>
</nav>
</body>
</html>`,
    },
    {
      name: "OPS/text/chapter1.xhtml",
      data: `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head>
  <title>第一章 起点</title>
  <link rel="stylesheet" type="text/css" href="../styles/main.css"/>
  <style>p.lead { color: red; background: url(../images/diagram.svg); }</style>
</head>
<body>
  <h1 id="c1">第一章 起点</h1>
  <p class="lead">正文段落，包含 <em>强调</em> 与 &amp; 符号。</p>
  <img src="../images/diagram.svg" alt="示意图"/>
  <script>alert('should never run')</script>
  <p onclick="evil()">点击 <a href="chapter2.xhtml#mark">下一章</a> 或 <a href="https://example.com/x">外部链接</a>。</p>
  <p><a href="#c1">回到顶部</a></p>
</body>
</html>`,
    },
    {
      name: "OPS/text/chapter2.xhtml",
      data: `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>第二章 转折</title></head>
<body>
  <h1 id="mark">第二章 转折</h1>
  <p>第二章的正文提到了 关键词 与另一个 关键词。</p>
  <p>这里还有一个 KEYWORD 用大写出现。</p>
</body>
</html>`,
    },
    {
      name: "OPS/text/sub/chapter3.xhtml",
      data: `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<head>
  <title>第三章 深入</title>
  <link rel="stylesheet" href="../../styles/main.css"/>
</head>
<body>
  <h1>第三章 深入</h1>
  <p>第三章位于子目录，样式路径需要上跳两级。</p>
  <img src="../../images/cover.png"/>
</body>
</html>`,
    },
    {
      name: "OPS/styles/main.css",
      data: `@import url("extra.css");
body { font-family: serif; margin: 1em; }
p.lead { background: url('../images/cover.png'); color: #333; }
@import "extra.css";`,
    },
    {
      name: "OPS/styles/extra.css",
      data: `.note { background: url(../images/diagram.svg); }
.reader-body .x { color: blue; }`,
    },
    {
      name: "OPS/images/diagram.svg",
      data: `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20" fill="#3a7"/></svg>`,
    },
    { name: "OPS/images/cover.png", data: PNG },
  ];
}

function epub2Entries(): ZipFileInput[] {
  return [
    { name: "mimetype", data: "application/epub+zip", store: true },
    {
      name: "META-INF/container.xml",
      data: `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`,
    },
    {
      name: "OEBPS/content.opf",
      data: `<?xml version='1.0' encoding='UTF-8' standalone='no' ?>
<opf:package version="2.0" unique-identifier="BookId" xmlns:opf="http://www.idpf.org/2007/opf" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <opf:metadata>
    <dc:identifier id="BookId" opf:scheme="UUID">urn:uuid:legacy-0002</dc:identifier>
    <dc:title>古早格式</dc:title>
    <dc:creator opf:role="aut">老作者</dc:creator>
    <dc:language>zh</dc:language>
    <opf:meta name="cover" content="cover-img" />
  </opf:metadata>
  <opf:manifest>
    <opf:item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml" />
    <opf:item id="cover-img" href="images/cover.png" media-type="image/png" />
    <opf:item id="c0" href="chapter_0.xhtml" media-type="application/xhtml+xml" />
    <opf:item id="c1" href="text/ch%201.xhtml" media-type="application/xhtml+xml" />
  </opf:manifest>
  <opf:spine toc="ncx">
    <opf:itemref idref="c0" />
    <opf:itemref idref="c1" />
  </opf:spine>
  <opf:guide>
    <reference type="cover" title="Cover" href="images/cover.png" />
  </opf:guide>
</opf:package>`,
    },
    {
      name: "OEBPS/toc.ncx",
      data: `<?xml version='1.0' encoding='UTF-8' standalone='no' ?>
<ncx version="2005-1" xmlns="http://www.daisy.org/z3986/2005/ncx/">
  <head><meta name="dtb:depth" content="3" /></head>
  <docTitle><text>古早格式</text></docTitle>
  <navMap>
    <navPoint id="navPoint-1" playOrder="1">
      <navLabel><text>楔子</text></navLabel>
      <content src="chapter_0.xhtml" />
      <navPoint id="navPoint-1-1" playOrder="2">
        <navLabel><text>楔子·补遗</text></navLabel>
        <content src="chapter_0.xhtml#extra" />
      </navPoint>
    </navPoint>
    <navPoint id="navPoint-2" playOrder="3">
      <navLabel><text>带空格的章节</text></navLabel>
      <content src="text/ch%201.xhtml" />
    </navPoint>
  </navMap>
</ncx>`,
    },
    {
      name: "OEBPS/chapter_0.xhtml",
      data: `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>楔子</title></head>
<body>
  <h1>楔子</h1>
  <p>这是旧格式电子书的第一段。</p>
  <p id="extra">这里是补遗内容。</p>
</body>
</html>`,
    },
    {
      name: "OEBPS/text/ch 1.xhtml",
      data: `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>带空格的章节</title></head>
<body><h1>带空格的章节</h1><p>路径里带空格的章节也能对上目录。</p></body>
</html>`,
    },
    { name: "OEBPS/images/cover.png", data: PNG },
  ];
}

export function createEpub3(): Buffer {
  return createZip(epub3Entries());
}

export function createEpub2(): Buffer {
  return createZip(epub2Entries());
}

/** EPUB whose container points at a missing OPF package. */
export function createBrokenEpub(): Buffer {
  return createZip([
    { name: "mimetype", data: "application/epub+zip", store: true },
    {
      name: "META-INF/container.xml",
      data: `<?xml version="1.0"?><container><rootfiles><rootfile full-path="OPS/missing.opf"/></rootfiles></container>`,
    },
  ]);
}

export const EXPECTED_PATHS = {
  epub3: {
    chapter1: "OPS/text/chapter1.xhtml",
    chapter2: "OPS/text/chapter2.xhtml",
    chapter3: "OPS/text/sub/chapter3.xhtml",
    cover: "OPS/images/cover.png",
    diagram: "OPS/images/diagram.svg",
    mainCss: "OPS/styles/main.css",
    extraCss: "OPS/styles/extra.css",
  },
  epub2: {
    chapter0: "OEBPS/chapter_0.xhtml",
    chapterWithSpace: "OEBPS/text/ch 1.xhtml",
    cover: "OEBPS/images/cover.png",
  },
};
