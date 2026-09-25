import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  attr,
  child,
  childText,
  children,
  createElement,
  descendants,
  firstDescendant,
  parseXml,
  serialize,
  setAttr,
  textContent,
} from "../epub/xml";

test("parses namespace-prefixed names and reads attributes by local name", () => {
  const root = parseXml(
    `<opf:package xmlns:opf="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="BookId">
       <opf:metadata><dc:title xmlns:dc="dc">书名</dc:title></opf:metadata>
       <opf:manifest><opf:item id="a" href="b.xhtml" media-type="application/xhtml+xml"/></opf:manifest>
     </opf:package>`,
  );

  const pkg = firstDescendant(root, "package");
  assert.ok(pkg);
  assert.equal(pkg.name, "opf:package");
  assert.equal(pkg.local, "package");
  assert.equal(attr(pkg, "unique-identifier"), "BookId");

  const title = firstDescendant(root, "title");
  assert.equal(title?.name, "dc:title");
  assert.equal(textContent(title!), "书名");

  const item = firstDescendant(root, "item");
  assert.equal(attr(item!, "href"), "b.xhtml");
  assert.equal(childText(pkg!, "title"), "");
  assert.equal(children(pkg!, "item").length, 0);
  assert.equal(descendants(pkg!, "item").length, 1);
});

test("skips declarations, comments and keeps CDATA as text", () => {
  const root = parseXml(
    `<?xml version="1.0" encoding="UTF-8"?>
     <!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd">
     <!-- a comment with <tags> inside -->
     <p>before<![CDATA[ raw <b>not a tag</b> ]]>after</p>`,
  );
  const p = firstDescendant(root, "p");
  assert.ok(p);
  assert.equal(textContent(p), "before raw <b>not a tag</b> after");
  assert.equal(descendants(root, "b").length, 0);
});

test("keeps a bare < in text as text", () => {
  const root = parseXml("<p>1 < 2 且 3 > 2</p>");
  const p = firstDescendant(root, "p");
  assert.equal(textContent(p!), "1 < 2 且 3 > 2");
});

test("decodes named and numeric entities", () => {
  const root = parseXml(`<p title="a&amp;b">&lt;tag&gt; &quot;q&quot; &#65;&#x42; &nbsp;&hellip; &unknown;</p>`);
  const p = firstDescendant(root, "p");
  assert.equal(attr(p!, "title"), "a&b");
  assert.equal(textContent(p!), `<tag> "q" AB \u00a0\u2026 &unknown;`);
});

test("recovers from mismatched end tags and unclosed void elements", () => {
  const root = parseXml("<div><b>bold</div><p>after<br>still in p</p>");
  const div = firstDescendant(root, "div");
  assert.equal(textContent(div!), "bold");
  const paragraphs = descendants(root, "p");
  assert.equal(paragraphs.length, 1);
  assert.equal(textContent(paragraphs[0]), "afterstill in p");
  assert.equal(descendants(root, "br").length, 1);
});

test("keeps raw text of style elements byte for byte", () => {
  const css = "p > a { content: '&amp;'; }\n.x { color: red }";
  const root = parseXml(`<style>${css}</style>`);
  const style = firstDescendant(root, "style");
  assert.ok(style);
  assert.equal(textContent(style), "");
  assert.equal(serialize(style!), `<style>${css}</style>`);
});

test("serializes attributes and escapes text", () => {
  const p = createElement("p");
  p.attrs["class"] = 'a"b';
  p.children.push({ kind: "text", value: "x & y < z > w" });
  assert.equal(serialize(p), '<p class="a&quot;b">x &amp; y &lt; z &gt; w</p>');
});

test("serializes void elements without a closing tag", () => {
  const image = createElement("img");
  image.attrs["src"] = "a.png";
  assert.equal(serialize(image), '<img src="a.png">');
});

test("setAttr replaces a prefixed attribute with the same local name", () => {
  const image = createElement("image");
  image.attrs["xlink:href"] = "a.png";
  setAttr(image, "href", "b.png");
  assert.equal(attr(image, "href"), "b.png");
  assert.equal(Object.keys(image.attrs).length, 1);
  assert.deepEqual(Object.keys(image.attrs), ["xlink:href"]);
});

test("child lookup is case-insensitive on local names", () => {
  const root = parseXml("<nav><ol><li>a</li></ol></nav>");
  const nav = firstDescendant(root, "nav");
  assert.ok(child(nav!, "OL"));
  assert.equal(children(nav!, "OL").length, 1);
});
