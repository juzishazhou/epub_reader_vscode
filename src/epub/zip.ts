import * as zlib from "node:zlib";
import { decodeText, normalizeZipPath } from "./util";

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_EOCD64_LOCATOR = 0x07064b50;

const U16_MAX = 0xffff;
const U32_MAX = 0xffffffff;

const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;

export class ZipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZipError";
  }
}

export interface ZipEntry {
  /** Normalized in-zip path using `/` separators. */
  readonly name: string;
  readonly method: number;
  readonly flags: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly localHeaderOffset: number;
  readonly isDirectory: boolean;
}

function readU16(data: Buffer, offset: number): number {
  return data.readUInt16LE(offset);
}

function readU32(data: Buffer, offset: number): number {
  return data.readUInt32LE(offset);
}

function readU64(data: Buffer, offset: number): number {
  return Number(data.readBigUInt64LE(offset));
}

/** Scan backwards for the End Of Central Directory record. */
function findEocd(data: Buffer): number {
  const minOffset = Math.max(0, data.length - 0xffff - 22);
  for (let i = data.length - 22; i >= minOffset; i--) {
    if (readU32(data, i) === SIG_EOCD) {
      return i;
    }
  }
  return -1;
}

interface Zip64Info {
  entryCount: number;
  centralSize: number;
  centralOffset: number;
}

function readZip64Info(data: Buffer, eocdOffset: number): Zip64Info | undefined {
  const locatorOffset = eocdOffset - 20;
  if (locatorOffset < 0 || readU32(data, locatorOffset) !== SIG_EOCD64_LOCATOR) {
    return undefined;
  }
  const recordOffset = readU64(data, locatorOffset + 8);
  if (recordOffset < 0 || recordOffset + 56 > data.length || readU32(data, recordOffset) !== SIG_EOCD64) {
    return undefined;
  }
  return {
    entryCount: readU64(data, recordOffset + 32),
    centralSize: readU64(data, recordOffset + 40),
    centralOffset: readU64(data, recordOffset + 48),
  };
}

function parseZip64Extra(extra: Buffer, entry: { uncompressedSize: number; compressedSize: number; localHeaderOffset: number }): void {
  let p = 0;
  while (p + 4 <= extra.length) {
    const headerId = extra.readUInt16LE(p);
    const size = extra.readUInt16LE(p + 2);
    const body = p + 4;
    if (headerId === 0x0001) {
      let q = body;
      if (entry.uncompressedSize === U32_MAX && q + 8 <= body + size) {
        entry.uncompressedSize = Number(extra.readBigUInt64LE(q));
        q += 8;
      }
      if (entry.compressedSize === U32_MAX && q + 8 <= body + size) {
        entry.compressedSize = Number(extra.readBigUInt64LE(q));
        q += 8;
      }
      if (entry.localHeaderOffset === U32_MAX && q + 8 <= body + size) {
        entry.localHeaderOffset = Number(extra.readBigUInt64LE(q));
        q += 8;
      }
      return;
    }
    p = body + size;
  }
}

/**
 * Minimal read-only ZIP archive. Only what EPUB needs: the central directory
 * index plus on-demand `stored` / `deflate` entry extraction.
 */
export class ZipArchive {
  private readonly byName = new Map<string, ZipEntry>();
  private readonly byLowerName = new Map<string, ZipEntry>();
  private readonly textCache = new Map<string, string>();

  private constructor(private readonly data: Buffer, entries: readonly ZipEntry[]) {
    for (const entry of entries) {
      const key = normalizeZipPath(entry.name);
      if (key.length === 0 || entry.isDirectory) {
        continue;
      }
      if (!this.byName.has(key)) {
        this.byName.set(key, entry);
      }
      const lower = key.toLowerCase();
      if (!this.byLowerName.has(lower)) {
        this.byLowerName.set(lower, entry);
      }
    }
  }

  /** Parse the central directory of an in-memory zip file. */
  static open(data: Buffer): ZipArchive {
    if (data.length < 22) {
      throw new ZipError("文件太小，不是有效的 ZIP/EPUB。");
    }
    const eocd = findEocd(data);
    if (eocd < 0) {
      throw new ZipError("没有找到 ZIP 中央目录，文件可能损坏或不是 EPUB。");
    }

    let entryCount = readU16(data, eocd + 10);
    let centralSize = readU32(data, eocd + 12);
    let centralOffset = readU32(data, eocd + 16);

    if (entryCount === U16_MAX || centralSize === U32_MAX || centralOffset === U32_MAX) {
      const zip64 = readZip64Info(data, eocd);
      if (zip64) {
        entryCount = zip64.entryCount;
        centralSize = zip64.centralSize;
        centralOffset = zip64.centralOffset;
      }
    }

    if (centralOffset + centralSize > data.length || centralOffset >= data.length) {
      throw new ZipError("ZIP 中央目录越界，文件可能被截断。");
    }

    const entries: ZipEntry[] = [];
    let p = centralOffset;
    for (let i = 0; i < entryCount; i++) {
      if (p + 46 > data.length || readU32(data, p) !== SIG_CENTRAL) {
        break;
      }
      const flags = readU16(data, p + 8);
      const method = readU16(data, p + 10);
      const partial = {
        uncompressedSize: readU32(data, p + 24),
        compressedSize: readU32(data, p + 20),
        localHeaderOffset: readU32(data, p + 42),
      };
      const nameLength = readU16(data, p + 28);
      const extraLength = readU16(data, p + 30);
      const commentLength = readU16(data, p + 32);
      const nameStart = p + 46;
      if (nameStart + nameLength > data.length) {
        break;
      }
      const nameBytes = data.subarray(nameStart, nameStart + nameLength);
      const name = (flags & 0x0800) !== 0 ? nameBytes.toString("utf8") : decodeZipName(nameBytes);

      if (
        partial.uncompressedSize === U32_MAX ||
        partial.compressedSize === U32_MAX ||
        partial.localHeaderOffset === U32_MAX
      ) {
        if (extraLength > 0 && nameStart + nameLength + extraLength <= data.length) {
          parseZip64Extra(data.subarray(nameStart + nameLength, nameStart + nameLength + extraLength), partial);
        }
      }

      const normalized = normalizeZipPath(name);
      entries.push({
        name: normalized,
        method,
        flags,
        compressedSize: partial.compressedSize,
        uncompressedSize: partial.uncompressedSize,
        localHeaderOffset: partial.localHeaderOffset,
        isDirectory: name.endsWith("/") || normalized.length === 0,
      });
      p = nameStart + nameLength + extraLength + commentLength;
    }

    if (entries.length === 0) {
      throw new ZipError("ZIP 中央目录为空，未找到任何文件。");
    }
    return new ZipArchive(data, entries);
  }

  /** Number of file entries (directories excluded). */
  get size(): number {
    return this.byName.size;
  }

  /** Every file entry name, in central directory order. */
  names(): string[] {
    return Array.from(this.byName.keys());
  }

  /** Exact, case-sensitive lookup. */
  entry(name: string): ZipEntry | undefined {
    return this.byName.get(normalizeZipPath(name));
  }

  /** Lookup that falls back to a case-insensitive match (real world epubs lie). */
  findEntry(name: string): ZipEntry | undefined {
    const key = normalizeZipPath(name);
    return this.byName.get(key) ?? this.byLowerName.get(key.toLowerCase());
  }

  has(name: string): boolean {
    return this.findEntry(name) !== undefined;
  }

  /** Actual stored name for a lookup key (case fixes applied). */
  realName(name: string): string | undefined {
    return this.findEntry(name)?.name;
  }

  /** Decompress one entry. Returns a fresh buffer that does not alias the archive. */
  read(name: string): Buffer {
    const entry = this.findEntry(name);
    if (!entry) {
      throw new ZipError(`EPUB 中不存在条目：${name}`);
    }
    if ((entry.flags & 0x0001) !== 0) {
      throw new ZipError(`条目已加密，无法读取：${entry.name}`);
    }
    const offset = entry.localHeaderOffset;
    if (offset + 30 > this.data.length || readU32(this.data, offset) !== SIG_LOCAL) {
      throw new ZipError(`条目本地头损坏：${entry.name}`);
    }
    const nameLength = readU16(this.data, offset + 26);
    const extraLength = readU16(this.data, offset + 28);
    const start = offset + 30 + nameLength + extraLength;
    const end = start + entry.compressedSize;
    if (end > this.data.length) {
      throw new ZipError(`条目数据越界：${entry.name}`);
    }
    const raw = this.data.subarray(start, end);
    switch (entry.method) {
      case METHOD_STORE:
        return Buffer.from(raw);
      case METHOD_DEFLATE:
        try {
          return zlib.inflateRawSync(raw);
        } catch (error) {
          throw new ZipError(`解压失败：${entry.name}（${(error as Error).message}）`);
        }
      default:
        throw new ZipError(`不支持的压缩方式 ${entry.method}：${entry.name}`);
    }
  }

  /** Read an entry and decode it as text (BOM + XML declaration aware). */
  readText(name: string): string {
    const key = normalizeZipPath(name);
    const cached = this.textCache.get(key);
    if (cached !== undefined) {
      return cached;
    }
    const text = decodeText(this.read(key));
    this.textCache.set(key, text);
    return text;
  }

  /** Read an entry as text, or `undefined` when it is missing/undecodable. */
  tryReadText(name: string): string | undefined {
    try {
      return this.readText(name);
    } catch {
      return undefined;
    }
  }
}

/**
 * ZIP names are CP437 unless the UTF-8 flag is set; Node's "latin1" is a close
 * enough match for the ASCII range that real EPUB entry names live in, and we
 * only use it as a fallback after trying UTF-8.
 */
function decodeZipName(bytes: Buffer): string {
  const utf8 = bytes.toString("utf8");
  return utf8.includes("\ufffd") ? bytes.toString("latin1") : utf8;
}
