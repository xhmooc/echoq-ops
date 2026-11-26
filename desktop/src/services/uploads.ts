/** 素材上传：解析 multipart，按文件头校验真实类型后落到 uploads 目录。 */
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import type http from "node:http";
import { UPLOAD_DIR } from "../core/config";
import { readRaw } from "../server/http";

const IMAGE_SUFFIXES = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);
const VIDEO_SUFFIXES = new Set([".mp4", ".mov", ".m4v", ".webm", ".avi", ".mkv", ".flv", ".wmv"]);
const MAX_BYTES = 128 * 1024 * 1024;

function sniffImage(head: Buffer): string {
  if (head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (head.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return "jpeg";
  const head6 = head.subarray(0, 6).toString("ascii");
  if (head6 === "GIF87a" || head6 === "GIF89a") return "gif";
  if (head.subarray(0, 4).toString("ascii") === "RIFF" && head.subarray(8, 12).toString("ascii") === "WEBP") {
    return "webp";
  }
  return "";
}

function sniffVideo(head: Buffer): boolean {
  if (head.length < 12) return false;
  if (head.subarray(4, 8).toString("ascii") === "ftyp") return true;
  if (head.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return true;
  if (head.subarray(0, 4).toString("ascii") === "RIFF" && head.subarray(8, 12).toString("ascii") === "AVI ") {
    return true;
  }
  if (head.subarray(0, 3).toString("ascii") === "FLV") return true;
  if (head.subarray(0, 8).equals(Buffer.from([0x30, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11]))) return true;
  return false;
}

interface Part {
  name: string;
  filename: string;
  data: Buffer;
}

function parseParts(raw: Buffer, boundary: string): Part[] {
  const delimiter = Buffer.from(`--${boundary}`);
  const parts: Part[] = [];
  let cursor = raw.indexOf(delimiter);
  while (cursor >= 0) {
    cursor += delimiter.length;
    if (raw.subarray(cursor, cursor + 2).toString("ascii") === "--") break;
    if (raw.subarray(cursor, cursor + 2).toString("ascii") === "\r\n") cursor += 2;
    const headerEnd = raw.indexOf("\r\n\r\n", cursor);
    if (headerEnd < 0) break;
    const headerText = raw.subarray(cursor, headerEnd).toString("utf8");
    const next = raw.indexOf(delimiter, headerEnd + 4);
    if (next < 0) break;
    let dataEnd = next;
    if (raw.subarray(dataEnd - 2, dataEnd).toString("ascii") === "\r\n") dataEnd -= 2;
    const data = raw.subarray(headerEnd + 4, dataEnd);
    let name = "";
    let filename = "";
    for (const line of headerText.split("\r\n")) {
      const match = line.match(/content-disposition:[^;]*;([\s\S]*)/i);
      if (!match) continue;
      for (const piece of match[1].split(";")) {
        // 文件名本身可能含 "="，只按第一个等号切分。
        const raw = piece.trim();
        const equal = raw.indexOf("=");
        if (equal <= 0) continue;
        const key = raw.slice(0, equal).trim().toLowerCase();
        const value = raw.slice(equal + 1).trim().replace(/^"|"$/g, "");
        if (key === "name") name = value;
        if (key === "filename") filename = value;
      }
    }
    parts.push({ name, filename, data });
    cursor = next;
  }
  return parts;
}

export async function handleUpload(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const contentType = String(req.headers["content-type"] || "");
  if (!contentType.startsWith("multipart/")) {
    throw new Error("请用 multipart/form-data 上传素材");
  }
  const boundaryMatch = contentType.match(/boundary=([^;]+)/i);
  if (!boundaryMatch) throw new Error("上传请求缺少 boundary");
  const raw = await readRaw(req, MAX_BYTES);
  const parts = parseParts(raw, boundaryMatch[1].trim().replace(/^"|"$/g, ""));
  const saved: string[] = [];
  for (const part of parts) {
    if (part.name !== "files" || !part.filename) continue;
    const suffix = path.extname(part.filename).toLowerCase();
    const isVideo = VIDEO_SUFFIXES.has(suffix);
    if (!IMAGE_SUFFIXES.has(suffix) && !isVideo) {
      throw new Error(`不支持的素材格式：${part.filename}`);
    }
    const head = part.data.subarray(0, 16);
    const valid = isVideo
      ? sniffVideo(head)
      : (() => {
          const kind = sniffImage(head);
          const expected = suffix === ".jpg" || suffix === ".jpeg" ? "jpeg" : suffix.replace(".", "");
          return Boolean(kind) && kind === expected;
        })();
    if (!valid) {
      throw new Error(
        `文件内容不是有效的${part.filename}，` +
          (isVideo ? "请上传真实的 MP4 / MOV / WEBM 等视频" : "请上传真实的 PNG / JPG / WEBP / GIF 图片")
      );
    }
    await fs.promises.mkdir(UPLOAD_DIR, { recursive: true });
    const target = path.join(UPLOAD_DIR, `${randomBytes(16).toString("hex")}${suffix}`);
    // 异步写盘：大文件上传期间不阻塞主进程里的其它请求与发布 worker。
    await fs.promises.writeFile(target, part.data);
    saved.push(target);
  }
  if (!saved.length) throw new Error("没有收到素材");
  return { paths: saved };
}
