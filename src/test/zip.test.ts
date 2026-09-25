import { strict as assert } from "node:assert";
import { test } from "node:test";
import { ZipArchive, ZipError } from "../epub/zip";
import { createZip } from "./helpers/zipwriter";

test("reads stored and deflated entries", () => {
  const long = "hello 世界 ".repeat(200);
  const archive = ZipArchive.open(
    createZip([
      { name: "mimetype", data: "application/epub+zip", store: true },
      { name: "text/a.txt", data: long },
      { name: "empty.txt", data: "" },
    ]),
  );

  assert.equal(archive.size, 3);
  assert.equal(archive.readText("mimetype"), "application/epub+zip");
  assert.equal(archive.readText("text/a.txt"), long);
  assert.equal(archive.readText("empty.txt"), "");
  assert.deepEqual(archive.names().sort(), ["empty.txt", "mimetype", "text/a.txt"]);
});

test("looks entries up case-insensitively but prefers the exact name", () => {
  const archive = ZipArchive.open(
    createZip([
      { name: "OEBPS/Content.opf", data: "<package/>" },
      { name: "OEBPS/other.txt", data: "x" },
    ]),
  );

  assert.ok(archive.has("oebps/content.opf"));
  assert.equal(archive.realName("oebps/CONTENT.opf"), "OEBPS/Content.opf");
  assert.equal(archive.readText("OEBPS/CONTENT.OPF"), "<package/>");
  assert.equal(archive.entry("oebps/other.txt"), undefined);
  assert.ok(archive.has("oebps/other.txt"));
  assert.equal(archive.has("nope.txt"), false);
});

test("decodes UTF-8 entry names", () => {
  const archive = ZipArchive.open(createZip([{ name: "文本/第一章.xhtml", data: "<p>你好</p>" }]));
  assert.deepEqual(archive.names(), ["文本/第一章.xhtml"]);
  assert.equal(archive.readText("文本/第一章.xhtml"), "<p>你好</p>");
});

test("returns independent buffers for repeated reads", () => {
  const archive = ZipArchive.open(createZip([{ name: "a.txt", data: "abcdef", store: true }]));
  const first = archive.read("a.txt");
  first[0] = 0x7a;
  assert.equal(archive.read("a.txt").toString("utf8"), "abcdef");
});

test("reports clear errors for non-zip data and missing entries", () => {
  assert.throws(() => ZipArchive.open(Buffer.from("definitely not a zip file")), ZipError);
  const archive = ZipArchive.open(createZip([{ name: "a.txt", data: "a" }]));
  assert.throws(() => archive.read("missing.txt"), /不存在条目/);
  assert.equal(archive.tryReadText("missing.txt"), undefined);
});

test("honours a UTF-8 BOM and an XML declared encoding", () => {
  const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("<p>正文</p>", "utf8")]);
  const gbkDeclared = Buffer.concat([
    Buffer.from(`<?xml version="1.0" encoding="gbk"?><p>`, "latin1"),
    Buffer.from("中文", "latin1"),
    Buffer.from("</p>", "latin1"),
  ]);
  const archive = ZipArchive.open(
    createZip([
      { name: "bom.xml", data: bom, store: true },
      { name: "gbk.xml", data: gbkDeclared, store: true },
    ]),
  );

  assert.equal(archive.readText("bom.xml"), "<p>正文</p>");
  assert.ok(archive.readText("gbk.xml").startsWith('<?xml version="1.0" encoding="gbk"?>'));
});
