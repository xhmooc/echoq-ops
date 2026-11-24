/**
 * 极简 ZIP 读写，只用于备份文件（.eqbak）。
 *
 * 不引入第三方依赖：写入使用 deflateRaw，读取支持 store/deflate，
 * 兼容 Python zipfile 生成的压缩包（含 UTF-8 文件名标志）。
 */
import zlib from "node:zlib";
import { promisify } from "node:util";

const deflateRaw = promisify(zlib.deflateRaw);
const inflateRaw = promisify(zlib.inflateRaw);

export interface ZipEntry {
  name: string;
  data: Uint8Array;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let index = 0; index < data.length; index += 1) {
    crc = CRC_TABLE[(crc ^ data[index]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosTime(date: Date): { time: number; date: number } {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  const stamp = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, date: stamp };
}

export async function zipCreate(entries: ZipEntry[]): Promise<Buffer> {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  const { time, date } = dosTime(new Date());
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    // 异步压缩：大备份不再阻塞主进程里的界面与 worker。
    const compressed = await deflateRaw(entry.data);
    const checksum = crc32(entry.data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);

    locals.push(local, name, compressed);
    centrals.push(central, name);
    offset += local.length + name.length + compressed.length;
  }
  const centralBuffer = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuffer, end]);
}

export async function zipExtract(data: Buffer): Promise<ZipEntry[]> {
  const endOffset = findEndOfCentralDirectory(data);
  if (endOffset < 0) throw new Error("备份文件不是有效的 ZIP 压缩包");
  const total = data.readUInt16LE(endOffset + 10);
  const centralOffset = data.readUInt32LE(endOffset + 16);
  if (centralOffset >= data.length) throw new Error("备份文件中央目录越界");
  const entries: ZipEntry[] = [];
  let cursor = centralOffset;
  for (let index = 0; index < total; index += 1) {
    if (cursor + 46 > data.length) throw new Error("备份文件中央目录不完整");
    if (data.readUInt32LE(cursor) !== 0x02014b50) break;
    const flags = data.readUInt16LE(cursor + 8);
    const method = data.readUInt16LE(cursor + 10);
    const expectedCrc = data.readUInt32LE(cursor + 16);
    const compSize = data.readUInt32LE(cursor + 20);
    const rawSize = data.readUInt32LE(cursor + 24);
    const nameLen = data.readUInt16LE(cursor + 28);
    const extraLen = data.readUInt16LE(cursor + 30);
    const commentLen = data.readUInt16LE(cursor + 32);
    const localOffset = data.readUInt32LE(cursor + 42);
    if (flags & 0x0001) throw new Error("备份文件包含加密条目，无法读取");
    if (compSize === 0xffffffff || rawSize === 0xffffffff || localOffset === 0xffffffff) {
      throw new Error("备份文件使用了 ZIP64 格式，暂不支持");
    }
    if (method !== 0 && method !== 8) {
      throw new Error("备份文件使用了不支持的压缩方式");
    }
    if (cursor + 46 + nameLen + extraLen + commentLen > data.length) {
      throw new Error("备份文件中央目录不完整");
    }
    const name = data.subarray(cursor + 46, cursor + 46 + nameLen).toString("utf8");
    cursor += 46 + nameLen + extraLen + commentLen;

    if (localOffset + 30 > data.length) throw new Error(`备份条目越界：${name}`);
    if (data.readUInt32LE(localOffset) !== 0x04034b50) continue;
    const localNameLen = data.readUInt16LE(localOffset + 26);
    const localExtraLen = data.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLen + localExtraLen;
    const end = start + compSize;
    if (end > data.length) throw new Error(`备份条目越界：${name}`);
    const raw = data.subarray(start, end);
    const content = method === 8 ? await inflateRaw(raw) : Buffer.from(raw);
    if (content.length !== rawSize) throw new Error(`备份条目大小不符：${name}`);
    if (crc32(content) !== expectedCrc) throw new Error(`备份条目校验失败：${name}`);
    entries.push({ name: name.replace(/\\/g, "/"), data: content });
  }
  return entries;
}

function findEndOfCentralDirectory(data: Buffer): number {
  if (data.length < 22) return -1;
  const minimum = Math.max(0, data.length - 65557);
  for (let index = data.length - 22; index >= minimum; index -= 1) {
    if (data.readUInt32LE(index) === 0x06054b50) return index;
  }
  return -1;
}
