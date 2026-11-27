/**
 * 小红书图文笔记发布（Node 版）。
 *
 * 链路与 vendor/apis/xhs_creator_apis.py 对齐：
 *   1. GET  /api/media/v1/upload/creator/permit        申请上传许可
 *   2. PUT  https://<uploadAddr>/spectrum/<fileId>     ROS 上传（q-signature）
 *   3. POST /web_api/sns/v2/note                       图文笔记提交
 *
 * 未联网回归：发布依赖真实创作平台登录态、RAP 指纹与 MNS 档位，代码按
 * Python 抓包逐字段对齐，但当前环境无法联网验证。失败一律返回中文原因，
 * 不写假的成功记录。
 */
import { createHash, createHmac } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ASSETS_DIR, DATA_DIR, DESIGN_DIR, UPLOAD_DIR } from "../../core/config";
import { log } from "../../core/log";
import type { AccountRow } from "../../core/accounts";
import {
  creatorPermit,
  creatorPostNote,
  creatorTopic,
  creatorUploadBinary,
} from "./api";
import type { CookieMap } from "./session";
import type { PublishOutcome } from "./types";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36";

const SUPPORTED_IMAGES = new Set([".png", ".jpg", ".jpeg", ".webp"]);

export class XhsPublishError extends Error {
  readonly kind: string;

  constructor(kind: string, message: string) {
    super(message);
    this.name = "XhsPublishError";
    this.kind = kind;
  }
}

export interface ImageNoteInput {
  title: string;
  desc: string;
  images: string[];
  topics: string[];
  privacyType: number;
}

interface FileInfo {
  fileIds: string;
  width: number;
  height: number;
  file_size: number;
  mime_type: string;
}

export interface UploadPermit {
  fileId: string;
  uploadHost: string;
  token: string;
  expireTime: string;
  xt: string;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function pick(source: unknown, ...keys: string[]): unknown {
  const record = asRecord(source);
  for (const key of keys) {
    const value = record[key];
    if (value !== null && value !== undefined && value !== "") return value;
  }
  return undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 只信任数据目录内的本地素材，避免把任意本地文件上传到平台。 */
function withinDataDir(file: string): boolean {
  const base = path.resolve(DATA_DIR);
  const target = path.resolve(file);
  return target === base || target.startsWith(base + path.sep);
}

/** 把前端返回的 /assets、/designs、/uploads 路径映射成本地文件。 */
function resolveLocalAsset(src: string): string | null {
  const value = String(src || "").trim();
  if (!value || /^(https?:)?\/\//.test(value) || value.startsWith("data:")) return null;
  const clean = value.split("?")[0].split("#")[0];
  if (fs.existsSync(clean) && fs.statSync(clean).isFile() && withinDataDir(clean)) {
    return clean;
  }
  const name = path.basename(clean);
  if (clean.startsWith("/uploads/")) return path.join(UPLOAD_DIR, name);
  if (clean.startsWith("/assets/")) {
    const parts = clean.replace(/^\/+/, "").split("/");
    return parts.length >= 3 ? path.join(ASSETS_DIR, ...parts.slice(1)) : null;
  }
  if (clean.startsWith("/designs/")) {
    const parts = clean.replace(/^\/+/, "").split("/");
    return parts.length >= 2 ? path.join(DESIGN_DIR, ...parts.slice(1)) : null;
  }
  return null;
}

function jpegSize(buffer: Buffer): { width: number; height: number } | null {
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buffer[offset + 1];
    const length = buffer.readUInt16BE(offset + 2);
    if (
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc
    ) {
      return {
        height: buffer.readUInt16BE(offset + 5),
        width: buffer.readUInt16BE(offset + 7),
      };
    }
    offset += 2 + length;
  }
  return null;
}

/** 只解析发布需要的尺寸与 MIME，不引入图片处理依赖。 */
function imageMeta(buffer: Buffer): { width: number; height: number; mime: string } {
  if (buffer.length > 24 && buffer.toString("ascii", 1, 4) === "PNG") {
    return {
      width: buffer.readUInt32BE(16),
      height: buffer.readUInt32BE(20),
      mime: "image/png",
    };
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8) {
    const size = jpegSize(buffer);
    if (size && size.width && size.height) {
      return { ...size, mime: "image/jpeg" };
    }
  }
  if (
    buffer.toString("ascii", 0, 4) === "RIFF" &&
    buffer.toString("ascii", 8, 12) === "WEBP"
  ) {
    const chunk = buffer.toString("ascii", 12, 16);
    if (chunk === "VP8X" && buffer.length >= 30) {
      return {
        width: 1 + buffer.readUIntLE(24, 3),
        height: 1 + buffer.readUIntLE(27, 3),
        mime: "image/webp",
      };
    }
    if (chunk === "VP8 " && buffer.length >= 30) {
      return {
        width: buffer.readUInt16LE(26) & 0x3fff,
        height: buffer.readUInt16LE(28) & 0x3fff,
        mime: "image/webp",
      };
    }
  }
  throw new XhsPublishError(
    "content",
    "无法识别配图尺寸，请上传 PNG / JPEG / WebP 图片"
  );
}

/** 对齐 vendor/xhs_creator/js/xhs_creator_signature.js::getSignature。 */
function uploadSignature(
  message: string,
  fileId: string,
  contentLength: number,
  host: string
): string {
  const key = createHmac("sha1", "null").update(message).digest("hex");
  const canonical =
    `put\n/spectrum/${fileId}\n\n` +
    `content-length=${contentLength}&host=${host}\n`;
  const params = createHash("sha1").update(canonical).digest("hex");
  const toSign = `sha1\n${message}\n${params}\n`;
  return createHmac("sha1", key).update(toSign).digest("hex");
}

function uploadHeaders(
  message: string,
  signature: string,
  token: string,
  uploadHost: string
): Record<string, string> {
  return {
    accept: "*/*",
    "accept-encoding": "gzip, deflate, br, zstd",
    "accept-language": "zh-CN,zh;q=0.9,en;q=0.8,zh-TW;q=0.7,ja;q=0.6",
    authorization:
      `q-sign-algorithm=sha1&q-ak=null&q-sign-time=${message}` +
      `&q-key-time=${message}&q-header-list=content-length;host` +
      `&q-url-param-list=&q-signature=${signature}`,
    "cache-control": "",
    "content-type": "",
    origin: "https://creator.xiaohongshu.com",
    referer: "https://creator.xiaohongshu.com/",
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": uploadHost.includes("xhscdn.com") ? "cross-site" : "same-site",
    "user-agent": USER_AGENT,
    "x-cos-security-token": token,
  };
}

async function uploadOne(
  creatorCookie: CookieMap,
  filePath: string,
  proxy: string
): Promise<FileInfo> {
  const buffer = fs.readFileSync(filePath);
  const meta = imageMeta(buffer);
  // 与 Python get_file_info 对齐：过宽的图按 2:1 收窄高度，避免服务端裁切。
  if (meta.width > 2 * meta.height) meta.height = Math.trunc(meta.width / 2);
  let permit;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    permit = await creatorPermit(creatorCookie, "image", proxy);
    if (permit.success) break;
    await sleep(600);
  }
  if (!permit || !permit.success) {
    throw new XhsPublishError(
      "platform",
      `获取上传许可失败：${permit?.message || "请稍后重试"}`
    );
  }
  const data = asRecord(permit.payload?.data);
  const permits = Array.isArray(data.uploadTempPermits)
    ? data.uploadTempPermits
    : [];
  const first = asRecord(permits[0]);
  const rawFileIds = Array.isArray(first.fileIds) ? first.fileIds : [];
  const fileId = String(rawFileIds[0] || "").split("/").pop() || "";
  const uploadHost = String(
    pick(first, "uploadAddr") || "ros-upload.xiaohongshu.com"
  );
  const token = String(first.token || "");
  const expireTime = String(first.expireTime || "");
  if (!fileId || !token) {
    throw new XhsPublishError("platform", "上传许可返回不完整，请稍后重试");
  }
  const xt = String(permit.xt || "").slice(0, 10);
  const message = `${xt};${expireTime.slice(0, 10)}`;
  const signature = uploadSignature(message, fileId, buffer.length, uploadHost);
  await creatorUploadBinary(
    uploadHost,
    fileId,
    buffer,
    uploadHeaders(message, signature, token, uploadHost),
    proxy
  );
  return {
    fileIds: fileId,
    width: meta.width,
    height: meta.height,
    file_size: buffer.length,
    mime_type: meta.mime,
  };
}

const NOTE_SOURCE =
  '{"type":"web","ids":"","extraInfo":"{\\"subType\\":\\"official\\",\\"systemId\\":\\"web\\"}"}';

function imageNoteBody(
  title: string,
  desc: string,
  privacyType: number,
  fileInfos: FileInfo[]
): Record<string, unknown> {
  const businessBinds =
    '{"version":1,"noteId":0,"bizType":0,"noteOrderBind":{},' +
    '"notePostTiming":{},"noteCollectionBind":{"id":""},' +
    '"noteSketchCollectionBind":{"id":""},' +
    '"noteCopyBind":{"copyable":false},' +
    '"interactionPermissionBind":{"commentPermission":0},' +
    '"optionRelationList":[]}';
  const images = fileInfos.map((info) => ({
    file_id: `spectrum/${info.fileIds}`,
    width: info.width,
    height: info.height,
    metadata: { source: -1 },
    extra_info_json: JSON.stringify({
      mimeType: info.mime_type,
      image_metadata: {
        bg_color: "",
        origin_size: info.file_size / 1024,
      },
    }),
  }));
  const contextJson = JSON.stringify({
    recommend_title: {
      recommend_title_id: "",
      is_use: 3,
      used_index: -1,
    },
    recommendTitle: [],
    recommend_topics: { used: [] },
  });
  return {
    common: {
      type: "normal",
      title,
      note_id: "",
      desc,
      source: NOTE_SOURCE,
      business_binds: businessBinds,
      ats: [],
      hash_tag: [],
      privacy_info: { op_type: 1, type: privacyType, user_ids: [] },
      goods_info: {},
      biz_relations: [],
      capa_trace_info: { contextJson },
    },
    image_info: { images },
    video_info: null,
  };
}

async function resolveTopics(
  creatorCookie: CookieMap,
  topics: string[],
  proxy: string
): Promise<Array<Record<string, string>>> {
  const tags: Array<Record<string, string>> = [];
  for (const topic of topics) {
    const name = String(topic || "").replace(/^#/, "").trim();
    if (!name) continue;
    const result = await creatorTopic(creatorCookie, name, proxy);
    if (!result.success) {
      // 话题只是附加信息：个别热词搜不到时跳过，不能因此让整篇笔记发布失败。
      if (/登录|失效|频繁|限流|风控/.test(result.message || "")) {
        throw new XhsPublishError(
          "platform",
          `话题「${name}」解析失败：${result.message || "请稍后重试"}`
        );
      }
      log.warn(`小红书话题「${name}」未解析，已跳过：${result.message || "无结果"}`);
      continue;
    }
    const info = asRecord(result.payload?.data);
    const dtos = Array.isArray(info.topic_info_dtos) ? info.topic_info_dtos : [];
    const first = asRecord(dtos[0]);
    if (!first.id) {
      log.warn(`小红书话题「${name}」无匹配结果，已跳过`);
      continue;
    }
    tags.push({
      id: String(first.id),
      link: String(first.link || ""),
      name: String(first.name || name),
      type: "topic",
    });
    await sleep(300);
  }
  return tags;
}

/** 发布图文笔记：校验、上传图片、提交 post_note。 */
export async function publishImageNote(
  account: AccountRow,
  creatorCookie: CookieMap,
  input: ImageNoteInput
): Promise<PublishOutcome> {
  const files: string[] = [];
  for (const src of input.images) {
    const filePath = resolveLocalAsset(src);
    if (!filePath) {
      throw new XhsPublishError("content", `配图文件不存在：${String(src || "空路径")}`);
    }
    const suffix = path.extname(filePath).toLowerCase();
    if (!SUPPORTED_IMAGES.has(suffix)) {
      throw new XhsPublishError(
        "content",
        `小红书配图只支持 PNG / JPEG / WebP，当前为 ${suffix || "未知格式"}`
      );
    }
    files.push(filePath);
  }
  if (!files.length) {
    throw new XhsPublishError("content", "小红书图文笔记至少需要 1 张配图");
  }

  const uploaded: FileInfo[] = [];
  for (const filePath of files) {
    uploaded.push(await uploadOne(creatorCookie, filePath, account.proxy));
    await sleep(200);
  }

  const tags = input.topics.length
    ? await resolveTopics(creatorCookie, input.topics, account.proxy)
    : [];
  let body = imageNoteBody(input.title, input.desc, input.privacyType, uploaded);
  if (tags.length) {
    const common = asRecord(body.common);
    const hashTag = Array.isArray(common.hash_tag) ? common.hash_tag : [];
    common.hash_tag = [...hashTag, ...tags];
    common.desc = `${String(common.desc || "")}${tags
      .map((tag) => ` #${tag.name}[话题]# `)
      .join("")}`;
    body = { ...body, common };
  }

  // 只提交一次：code=-1 等边缘拒绝可能已受理，盲目重发会产生重复笔记。
  const first = await creatorPostNote(creatorCookie, JSON.stringify(body), account.proxy);
  if (first.success) {
    return {
      ok: true,
      message: first.message || "发布成功",
      result: {
        platform: "xiaohongshu",
        stage: "post_note",
        response: first.payload,
      },
    };
  }
  const text = String(first.message || "");
  const kind = /频繁|风控|限流|稍后|406|429|code=-1/.test(text)
    ? "rate"
    : /登录|未登录|401|会话/.test(text)
      ? "auth"
      : "platform";
  return {
    ok: false,
    message: `发布失败：${first.message || "平台未给出原因"}`,
    result: {
      platform: "xiaohongshu",
      stage: "post_note",
      response: first.payload,
    },
    kind,
  };
}
