import * as zlib from "node:zlib";
import { ZipArchive, ZipError } from "./zip";

/**
 * ZIP output for edited EPUBs.
 *
 * The reader side (`zip.ts`) is deliberately read-only; this module is its
 * write-side counterpart. It re-assembles an archive from a parsed one plus
 * the text overrides registered on it:
 *
 *  - unchanged entries are copied **verbatim**: their raw compressed bytes,
 *    compression method, CRC and timestamps are re-emitted unchanged, so a
 *    save rewrites only what the user actually edited;
 *  - edited entries are re-deflated from their UTF-8 text (falling back to
 *    `store` when deflation does not help);
 *  - the original central-directory order is kept, with `mimetype` forced to
 *    the front, because the OCF container requires it to be first and stored.
 *
 * Output is plain ZIP32: entries above 4 GB or 65 535 files throw a clear
 * error instead of producing a corrupt book.
 *
 * Headers are normalized rather than copied: optional extra fields, entry
 * comments, data descriptors and Zip64 placeholders are dropped. No reader
 * needs them, and a real 10 MB book shrinks by a fraction of a percent while
 * every entry's payload stays byte-identical (see `realbook.test.ts`).
 */

const U16_MAX = 0xffff;
const U32_MAX = 0xffffffff;

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;

const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;

const FLAG_UTF8 = 0x0800;

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let value = i;
    for (let bit = 0; bit < 8; bit++) {
      value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[i] = value;
  }
  return table;
})();

export function crc32(buffer: Buffer): number {
  let crc = -1;
  for (let i = 0; i < buffer.length; i++) {
    crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ -1) >>> 0;
}

interface OutputEntry {
  name: string;
  method: number;
  crc: number;
  compressedSize: number;
  uncompressedSize: number;
  dosTime: number;
  dosDate: number;
  /** Payload exactly as it will sit in the archive. */
  bytes: Buffer;
  /** True when the entry was edited (re-compressed), for tests. */
  edited: boolean;
}

/** Current local time in DOS timestamp fields. */
function dosNow(): { time: number; date: number } {
  const now = new Date();
  const time = (now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2);
  const date =
    ((Math.max(1980, now.getFullYear()) - 1980) << 9) |
    ((now.getMonth() + 1) << 5) |
    now.getDate();
  return { time, date };
}

/** Pick the smaller of deflated / stored for a freshly edited entry. */
function compressEdited(name: string, data: Buffer, forceStore: boolean): {
  method: number;
  bytes: Buffer;
} {
  if (forceStore) {
    return { method: METHOD_STORE, bytes: data };
  }
  const deflated = zlib.deflateRawSync(data, { level: 9 });
  return deflated.length < data.length
    ? { method: METHOD_DEFLATE, bytes: deflated }
    : { method: METHOD_STORE, bytes: data };
}

/**
 * Assemble a new archive from `archive`: every entry whose text was
 * overridden with `setOverride` is written from the override; all others are
 * copied verbatim.
 */
export function rewriteZip(archive: ZipArchive): Buffer {
  const names = archive.names();
  const ordered = [
    ...names.filter((name) => name.toLowerCase() === "mimetype"),
    ...names.filter((name) => name.toLowerCase() !== "mimetype"),
  ];

  const now = dosNow();
  const entries: OutputEntry[] = [];
  for (const name of ordered) {
    const override = archive.overrideText(name);
    if (override !== undefined) {
      const data = Buffer.from(override, "utf8");
      const { method, bytes } = compressEdited(name, data, name.toLowerCase() === "mimetype");
      entries.push({
        name,
        method,
        crc: crc32(data),
        compressedSize: bytes.length,
        uncompressedSize: data.length,
        dosTime: now.time,
        dosDate: now.date,
        bytes,
        edited: true,
      });
      continue;
    }
    const raw = archive.rawEntry(name);
    if (!raw) {
      throw new ZipError(`无法读取原始条目，放弃改写：${name}`);
    }
    if (
      raw.crc === U32_MAX ||
      raw.compressedSize === U32_MAX ||
      raw.uncompressedSize === U32_MAX ||
      raw.dosDate === U16_MAX && raw.dosTime === U16_MAX
    ) {
      // Unresolved Zip64 placeholders would corrupt the rewritten archive.
      throw new ZipError(`原始条目尺寸无法解析（可能是异常的 Zip64）：${name}`);
    }
    entries.push({ ...raw, edited: false });
  }

  if (entries.length > U16_MAX) {
    throw new ZipError("条目数量超过 65535，超出 ZIP32 改写上限。");
  }

  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    if (
      entry.compressedSize > U32_MAX ||
      entry.uncompressedSize > U32_MAX ||
      offset > U32_MAX ||
      offset + entry.bytes.length > U32_MAX
    ) {
      throw new ZipError("文件超过 4 GB，超出 ZIP32 改写上限。");
    }
    const nameBytes = Buffer.from(entry.name, "utf8");
    if (nameBytes.length > U16_MAX) {
      throw new ZipError(`条目名过长：${entry.name}`);
    }

    const local = Buffer.alloc(30);
    local.writeUInt32LE(SIG_LOCAL, 0);
    local.writeUInt16LE(entry.method === METHOD_STORE ? 10 : 20, 4);
    local.writeUInt16LE(FLAG_UTF8, 6);
    local.writeUInt16LE(entry.method, 8);
    local.writeUInt16LE(entry.dosTime, 10);
    local.writeUInt16LE(entry.dosDate, 12);
    local.writeUInt32LE(entry.crc, 14);
    local.writeUInt32LE(entry.compressedSize, 18);
    local.writeUInt32LE(entry.uncompressedSize, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, nameBytes, entry.bytes);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(SIG_CENTRAL, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(entry.method === METHOD_STORE ? 10 : 20, 6);
    central.writeUInt16LE(FLAG_UTF8, 8);
    central.writeUInt16LE(entry.method, 10);
    central.writeUInt16LE(entry.dosTime, 12);
    central.writeUInt16LE(entry.dosDate, 14);
    central.writeUInt32LE(entry.crc, 16);
    central.writeUInt32LE(entry.compressedSize, 20);
    central.writeUInt32LE(entry.uncompressedSize, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBytes);

    offset += local.length + nameBytes.length + entry.bytes.length;
  }

  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  if (offset + centralSize > U32_MAX) {
    throw new ZipError("文件超过 4 GB，超出 ZIP32 改写上限。");
  }

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(SIG_EOCD, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, ...centralParts, eocd]);
}
