/**
 * 小红书请求签名（Node 版）。
 *
 * 这里不重写 vendor 里的 JS 算法，只负责：
 * 1. 读取 vendor 中的参考设备模板（reference_profile.json）；
 * 2. 用 `process.execPath` + `ELECTRON_RUN_AS_NODE=1` 执行 vendor 的
 *    b1.js / sign.js，参数格式与 vendor/xhs_utils/xhs_pc/runtime.py 一致；
 * 3. 抓取服务端下发的 `_dsl` / `_dsf` 锚点；
 * 4. 按浏览器抓包顺序组装 X-s / X-t / X-S-Common 等请求头。
 *
 * 已实现：PC 端 user/me、评论列表；Creator 端作品列表。
 * 受限：发布（post_note）涉及媒体上传、permit、RAP 指纹与转码，未迁移。
 */
import { randomBytes, randomInt, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ProxyAgent, fetch, type Dispatcher } from "undici";
import { cookieHeader, type CookieMap } from "./session";

type JsonRecord = Record<string, unknown>;
type MnsTier = "0101" | "0201" | "0301";

const PC_BUSINESS_ACCEPT_LANGUAGE = "zh-CN,zh;q=0.9,en;q=0.8,zh-TW;q=0.7,ja;q=0.6";
const SIGN_TIMEOUT_MS = 30_000;
const DS_TIMEOUT_MS = 8_000;

// PC 与 Creator 的同一档位输出长度不同（Creator 0101 是 196/197/198，
// PC 0101 是 205），这里取并集，既能拦住异常输出，也不会误杀正常签名。
const TIER_GATE: Record<MnsTier, { prefix: string; lengths: number[] }> = {
  "0101": { prefix: "mns0101_", lengths: [196, 197, 198, 205] },
  "0201": { prefix: "mns0201_", lengths: [200, 208] },
  "0301": { prefix: "mns0301_", lengths: [200] },
};

let seqValue = 0;
const dsCache = new Map<string, { value: string; program: string; fetchedAt: number }>();

function nextSeq(): number {
  seqValue += 1;
  return seqValue;
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => String(item)) : [];
}

function vendorRoot(): string {
  const candidates = [
    process.env.XHS_VENDOR_DIR || "",
    path.resolve(__dirname, "..", "..", "..", "..", "vendor"),
    path.resolve(process.cwd(), "vendor"),
    process.resourcesPath ? path.join(process.resourcesPath, "vendor") : "",
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (fs.existsSync(path.join(candidate, "xhs_utils", "xhs_core", "js", "sign.js"))) {
      return candidate;
    }
  }
  throw new Error("未找到小红书签名脚本（vendor 目录），请确认安装包包含 vendor/xhs_utils");
}

function coreJsDir(): string {
  return path.join(vendorRoot(), "xhs_utils", "xhs_core", "js");
}

function loadReference(kind: "pc" | "creator"): JsonRecord {
  const file = path.join(
    vendorRoot(),
    "xhs_utils",
    kind === "pc" ? "xhs_pc" : "xhs_creator",
    "js",
    "reference_profile.json"
  );
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as JsonRecord;
  } catch {
    throw new Error("小红书参考设备模板缺失，无法生成请求签名");
  }
}

export function makeDispatcher(proxy: string): Dispatcher | undefined {
  const value = String(proxy || "").trim();
  if (!value) return undefined;
  if (/^socks/i.test(value)) {
    throw new Error("小红书适配器暂不支持 socks 代理，请改用 http/https 代理");
  }
  return new ProxyAgent(value.includes("://") ? value : `http://${value}`);
}

async function runNode(
  script: string,
  args: string[],
  cwd: string,
  timeoutMs: number
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error("小红书签名子进程超时，请稍后重试"));
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`小红书签名子进程启动失败：${error.message}`));
    });
    child.on("close", (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(
          new Error(
            `小红书签名子进程退出异常：${(stderr || stdout).trim().slice(0, 300) || code}`
          )
        );
        return;
      }
      resolve(stdout);
    });
  });
}

function hexBytes(hex: string): number[] {
  const value = String(hex || "");
  if (!/^[0-9a-f]{28}$/i.test(value)) {
    throw new Error("小红书 MNS 环境参数格式异常");
  }
  return Array.from(Buffer.from(value, "hex"));
}

function jsAtom(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (value === true) return "true";
  if (value === false) return "false";
  if (typeof value === "number" && Number.isInteger(value)) return String(Math.trunc(value));
  return String(value);
}

function mapText(value: unknown): string {
  return Object.entries(asRecord(value))
    .map(([key, item]) => `${key}:${jsAtom(item)}`)
    .join(",");
}

function pcB1Options(reference: JsonRecord, startedAt: number, now: number): JsonRecord {
  const value = asRecord(reference.b1Reference);
  const overrides = { ...asRecord(value.overrides) };
  for (const key of ["x37", "x38", "x82"]) {
    if (value[key] !== undefined) overrides[key] = String(value[key]);
  }
  overrides.x36 = String(value.frameCount ?? 1);
  const timeOrigin =
    startedAt + Number(value.timeOriginOffsetMs ?? 0);
  const template = String(value.telemetryTemplate || "");
  if (template) overrides.x84 = template.split("__TIME_ORIGIN__").join(String(timeOrigin));
  return {
    now,
    x39: Number(value.x39 ?? 0),
    x50: String(value.x50 ?? ""),
    secCanvas: String(value.secCanvas ?? ""),
    windowKeys: asStringArray(value.selectedGlobalNames),
    telemetry: {
      profile: String(value.telemetryProfile || "active"),
      timeOrigin,
      mouse: asRecord(value.mouse),
      keyboard: asRecord(value.keyboard),
      page: asRecord(value.page),
      state: asRecord(value.state),
      features: asRecord(value.features),
    },
    overrides,
  };
}

function creatorTelemetry(value: JsonRecord, timeOrigin: number): string {
  const features: JsonRecord = {
    ae: null,
    ak: null,
    cdr: null,
    bf: null,
    fi: null,
    ...asRecord(value.features),
  };
  const bf = features.bf === null || features.bf === undefined ? null : asRecord(features.bf);
  const bfText = bf ? `{ar:${jsAtom(bf.ar)},fr:${jsAtom(bf.fr)}}` : "null";
  return (
    `{mt:{to:${jsAtom(timeOrigin)}},` +
    `m:{${mapText(value.mouse)}},` +
    `k:{${mapText(value.keyboard)}},` +
    `p:{${mapText(value.page)}},` +
    `st:{${mapText(value.state)}},` +
    `ft:{ae:${jsAtom(features.ae)},ak:${jsAtom(features.ak)},` +
    `cdr:${jsAtom(features.cdr)},bf:${bfText},fi:${jsAtom(features.fi)}}}`
  );
}

function creatorB1Options(
  reference: JsonRecord,
  startedAt: number,
  profileName = "note_manager"
): JsonRecord {
  const base = asRecord(reference.b1Reference);
  const profiles = asRecord(reference.b1Profiles);
  const useBase = !profileName || ["login", "default"].includes(profileName);
  const named = useBase ? {} : asRecord(profiles[profileName]);
  if (!useBase && !Object.keys(named).length) {
    throw new Error(`未知的小红书指纹档位：${profileName}`);
  }
  const value = { ...base, ...named };
  const timeOrigin = startedAt + Number(value.timeOriginOffsetMs ?? 0);
  const timestamp =
    value.generatedAtOffsetMs !== undefined && value.generatedAtOffsetMs !== null
      ? startedAt + Number(value.generatedAtOffsetMs)
      : Date.now();
  const names = asStringArray(value.selectedGlobalNames);
  const overrides: JsonRecord = {
    x36: String(value.frameCount ?? 1),
    x37: String(value.x37 ?? ""),
    x38: String(value.x38 ?? ""),
    x82: names.join("|").slice(0, 300),
    x84: creatorTelemetry(value, timeOrigin),
    ...asRecord(value.overrides),
  };
  return {
    now: timestamp,
    x39: Number(value.x39 ?? 0),
    x50: String(value.x50 ?? ""),
    x51: String(value.x51 ?? ""),
    secCanvas: String(value.secCanvas ?? ""),
    overrides,
  };
}

async function generateB1(options: JsonRecord): Promise<string> {
  const dir = coreJsDir();
  const output = await runNode(
    path.join(dir, "b1.js"),
    ["--generate", JSON.stringify(options)],
    dir,
    10_000
  );
  let value = "";
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("{"))
    .reverse();
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as JsonRecord;
      if (parsed.b1) {
        value = String(parsed.b1);
        break;
      }
    } catch {
      continue;
    }
  }
  if (!value) throw new Error("小红书 b1 指纹生成失败");
  if (value.length < 500 || value.length % 4 !== 0) {
    throw new Error("小红书 b1 指纹长度异常");
  }
  return value;
}

export async function fetchDsBundle(
  appId: string,
  referer: string,
  proxy: string
): Promise<{ value: string; program: string }> {
  const cached = dsCache.get(appId);
  if (cached && Date.now() - cached.fetchedAt < 300_000) {
    return { value: cached.value, program: cached.program };
  }
  const dispatcher = makeDispatcher(proxy);
  try {
    const response = await fetch(
      `https://as.xiaohongshu.com/api/sec/v1/ds?appId=${encodeURIComponent(appId)}`,
      {
        method: "GET",
        dispatcher,
        signal: AbortSignal.timeout(DS_TIMEOUT_MS),
        headers: {
          "user-agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
            "(KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36",
          referer,
          accept: "*/*",
        },
      }
    );
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = await response.text();
    const match = /function\s+getdss\s*\(\s*\)\s*\{\s*return\s+'(\d+)'/.exec(text);
    if (!match) throw new Error("ds 响应缺少 getdss()");
    if (!text.includes("_dsf") && !text.includes("__$c")) {
      throw new Error("ds 响应缺少签名程序");
    }
    dsCache.set(appId, { value: match[1], program: text, fetchedAt: Date.now() });
    return { value: match[1], program: text };
  } catch (error) {
    if (cached) return { value: cached.value, program: cached.program };
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`小红书签名锚点获取失败：${reason}`);
  } finally {
    if (dispatcher) void dispatcher.close().catch(() => undefined);
  }
}

async function runSigner(
  payload: JsonRecord,
  tier: MnsTier
): Promise<{ xs: string; xt: string; xs_common: string }> {
  const dir = coreJsDir();
  // 签名 payload 含完整 Cookie，始终走临时文件，绝不作为命令行参数暴露给进程列表。
  const tempFile = path.join(os.tmpdir(), `xhs_sign_${randomUUID()}.json`);
  fs.writeFileSync(tempFile, JSON.stringify(payload), "utf8");
  try {
    const output = await runNode(
      path.join(dir, "sign.js"),
      [`@${tempFile}`],
      dir,
      SIGN_TIMEOUT_MS
    );
    const lines = output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .reverse();
    for (const line of lines) {
      if (!line.startsWith("{") || !line.includes('"x3"')) continue;
      let result: JsonRecord;
      try {
        result = JSON.parse(line) as JsonRecord;
      } catch {
        continue;
      }
      const xs = String(result.xs || "");
      const x3 = String(result.x3 || "");
      const gate = TIER_GATE[tier];
      if (!xs || !x3.startsWith(gate.prefix) || !gate.lengths.includes(x3.length)) {
        throw new Error(
          `小红书签名未达到 ${tier} 档位要求（${x3.slice(0, 12)}…，长度 ${x3.length}）`
        );
      }
      return {
        xs,
        xt: String(result.xt || Date.now()),
        xs_common: String(result.xs_common || ""),
      };
    }
    throw new Error("小红书签名输出格式异常");
  } finally {
    try {
      fs.unlinkSync(tempFile);
    } catch {
      /* 清理失败不影响主流程 */
    }
  }
}

function xrayTraceId(): string {
  const now = Date.now();
  const seq = randomInt(1, 0x7fffff);
  const part1 = (((BigInt(now) << 23n) | BigInt(seq)) & 0xffffffffffffffffn)
    .toString(16)
    .padStart(16, "0");
  const part2 = randomBytes(8).toString("hex").slice(0, 16).padStart(16, "0");
  return part1 + part2;
}

function b3TraceId(): string {
  return randomBytes(8).toString("hex");
}

export interface PcSignOptions {
  method?: "GET" | "POST";
  /** 是否附加 x-rap-param（搜索 / 首页推荐 / 笔记详情 / 用户笔记需要）。 */
  rap?: boolean;
  /** 需要 xy-direction 的接口传入当前登录 user_id。 */
  xyUserId?: string;
}

function murmurHash3_32(key: string, seed = 0): number {
  const data = Buffer.from(key, "utf8");
  const length = data.length;
  let h = seed >>> 0;
  const nblocks = Math.floor(length / 4);
  for (let i = 0; i < nblocks; i += 1) {
    let k = data.readUInt32LE(i * 4);
    k = Math.imul(k, 0xcc9e2d51) >>> 0;
    k = ((k << 15) | (k >>> 17)) >>> 0;
    k = Math.imul(k, 0x1b873593) >>> 0;
    h ^= k;
    h = ((h << 13) | (h >>> 19)) >>> 0;
    h = (Math.imul(h, 5) + 0xe6546b64) >>> 0;
  }
  const tail = nblocks * 4;
  let k = 0;
  const rem = length % 4;
  if (rem === 3) k ^= data[tail + 2] << 16;
  if (rem >= 2) k ^= data[tail + 1] << 8;
  if (rem >= 1) {
    k ^= data[tail];
    k = Math.imul(k, 0xcc9e2d51) >>> 0;
    k = ((k << 15) | (k >>> 17)) >>> 0;
    k = Math.imul(k, 0x1b873593) >>> 0;
    h ^= k;
  }
  h ^= length;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

function xyDirection(userId: string): string {
  if (!userId) return "0";
  return String((murmurHash3_32(userId, 151488) % 100) + 1);
}

const ALPHABET36 = "0123456789abcdefghijklmnopqrstuvwxyz";

export async function generateXhsRap(
  api: string,
  data: string,
  options: { appId?: string; fingerprintHex?: string } = {}
): Promise<string> {
  const dir = path.join(vendorRoot(), "xhs_utils", "xhs_pc", "js");
  const args = [api, data];
  if (options.appId) args.push(options.appId);
  else if (options.fingerprintHex) args.push("");
  if (options.fingerprintHex) args.push(options.fingerprintHex);
  const output = await runNode(path.join(dir, "rap_cli.js"), args, dir, 30_000);
  const value = output.trim();
  if (!value.startsWith("ByQ")) throw new Error("小红书 RAP 参数生成失败");
  return value;
}

function creatorRapFingerprintHex(): string {
  const file = path.join(
    vendorRoot(),
    "xhs_utils",
    "xhs_creator",
    "js",
    "rap_fingerprint_creator.json"
  );
  let template: JsonRecord;
  try {
    template = JSON.parse(fs.readFileSync(file, "utf8")) as JsonRecord;
  } catch {
    throw new Error("小红书发布指纹模板缺失");
  }
  const hex = String(template.bodyUnmaskedHex || "");
  if (hex.slice(0, 12).toLowerCase() !== "03ea00000010") {
    throw new Error("小红书发布指纹模板格式异常");
  }
  const raw = Buffer.from(hex, "hex");
  let uuid = "";
  for (let index = 0; index < 16; index += 1) {
    uuid += ALPHABET36[randomInt(0, ALPHABET36.length)];
  }
  raw.write(uuid, 6, 16, "ascii");
  return raw.toString("hex");
}

/** Creator 发布 post_note 的 RAP 参数（436B 指纹模板，每次随机 Uuid）。 */
export async function creatorRapParam(api: string, data: string): Promise<string> {
  return generateXhsRap(api, data, {
    fingerprintHex: creatorRapFingerprintHex(),
  });
}

export async function pcSignedHeaders(
  cookieMap: CookieMap,
  api: string,
  data: string,
  proxy: string,
  options: PcSignOptions = {}
): Promise<Record<string, string>> {
  const reference = loadReference("pc");
  const release = asRecord(reference.release);
  const mnsStages = asRecord(reference.mnsStages);
  const cookie = cookieHeader(cookieMap);
  if (!cookieMap.a1) throw new Error("小红书登录态缺少 a1，请重新登录");
  const now = Date.now();
  const startedAt = Number(cookieMap.loadts || 0) || now;
  const tier: MnsTier = cookieMap.gid ? "0301" : "0101";
  const stage = asRecord(
    mnsStages[tier === "0301" ? "steadyContent" : "coldContent"]
  );
  const b1 = await generateB1(pcB1Options(reference, startedAt, now));
  const bundle = await fetchDsBundle("xhs-pc-web", "https://www.xiaohongshu.com/", proxy);
  const context: JsonRecord = {
    tier,
    now,
    version: randomInt(0, 0xffffffff),
    loadts: startedAt,
    seq: nextSeq(),
    envConst: Number(stage.envConst || 0),
    envFpTail: hexBytes(String(stage.envFpTailHex || "")),
    webBuild: String(cookieMap.webBuild || release.webBuild || ""),
    signVersion: String(release.signVersion || ""),
    appId: String(release.appId || "xhs-pc-web"),
    platform: String(release.platform || "Windows"),
    userAgent: String(release.userAgent || ""),
    secChUa: String(release.secChUa || ""),
  };
  const signed = await runSigner(
    {
      ...context,
      api,
      data,
      cookie,
      a1: cookieMap.a1,
      b1,
      dslPair: `${now};${bundle.value}`,
    },
    tier
  );
  const headers: Record<string, string> = {
    referer: "https://www.xiaohongshu.com/",
    "x-t": signed.xt,
    "x-s-common": signed.xs_common,
    "user-agent": String(context.userAgent),
    accept: "application/json, text/plain, */*",
    "x-s": signed.xs,
    "accept-language": PC_BUSINESS_ACCEPT_LANGUAGE,
    origin: "https://www.xiaohongshu.com",
    priority: "u=1, i",
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-site",
    "x-xray-traceid": xrayTraceId(),
    "x-b3-traceid": b3TraceId(),
    cookie,
  };
  if (options.method === "POST") {
    headers["content-type"] = "application/json;charset=UTF-8";
  }
  if (options.xyUserId) {
    headers["xy-direction"] = xyDirection(options.xyUserId);
  }
  if (options.rap) {
    headers["x-rap-param"] = await generateXhsRap(api, data, {
      appId: String(context.appId),
    });
  }
  return headers;
}

export async function pcSignedGetHeaders(
  cookieMap: CookieMap,
  api: string,
  data: string,
  proxy: string
): Promise<Record<string, string>> {
  return pcSignedHeaders(cookieMap, api, data, proxy, { method: "GET" });
}

export interface CreatorSignOptions {
  method?: "GET" | "POST";
  /** mnsProfiles 名称；留空时用 mnsStages.ready（发布 post_note 走的档位）。 */
  mnsProfile?: string;
  /** b1Profiles 名称；login/default 使用基础模板。 */
  b1Profile?: string;
  referer?: string;
  secFetchSite?: string;
}

export async function creatorSignedHeaders(
  creatorCookie: CookieMap,
  api: string,
  data: string,
  proxy: string,
  options: CreatorSignOptions = {}
): Promise<Record<string, string>> {
  const reference = loadReference("creator");
  const release = asRecord(reference.release);
  const profiles = asRecord(reference.mnsProfiles);
  const stages = asRecord(reference.mnsStages);
  const profileName = String(options.mnsProfile || "");
  const material = profileName
    ? asRecord(profiles[profileName])
    : asRecord(stages.ready);
  if (!Object.keys(material).length) {
    throw new Error(`未知的小红书签名档位：${profileName || "ready"}`);
  }
  const tierRaw = String(material.tier || "0101");
  if (!(tierRaw in TIER_GATE)) throw new Error("小红书签名档位异常");
  const tier = tierRaw as MnsTier;
  const cookie = cookieHeader(creatorCookie);
  if (!creatorCookie.a1) throw new Error("Creator Cookie 缺少 a1，请重新登录");
  const now = Date.now();
  const startedAt = Number(creatorCookie.loadts || 0) || now;
  const b1 = await generateB1(
    creatorB1Options(reference, startedAt, options.b1Profile || "login")
  );
  const bundle = await fetchDsBundle(
    "ugc",
    "https://creator.xiaohongshu.com/",
    proxy
  );
  const context: JsonRecord = {
    tier,
    now,
    version: randomInt(0, 0xffffffff),
    loadts: startedAt,
    seq: nextSeq(),
    envConst: Number(material.envConst || 0),
    envFpTail: hexBytes(String(material.envFpTailHex || "")),
    deviceTag: String(material.deviceTag || "a1"),
    b1b1: "1",
    signCount: 0,
    webBuild: String(release.webBuild || "1.26.0"),
    signVersion: String(release.signVersion || "4.3.6"),
    appId: String(release.appId || "ugc"),
    platform: String(release.platform || "Windows"),
    userAgent: String(release.userAgent || ""),
    secChUa: String(release.secChUa || ""),
    dsProgram: bundle.program,
  };
  const signed = await runSigner(
    {
      ...context,
      api,
      data,
      cookie,
      a1: creatorCookie.a1,
      b1,
      dslPair: `${now};${bundle.value}`,
    },
    tier
  );
  const headers: Record<string, string> = {
    authorization: "",
    referer:
      options.referer || "https://creator.xiaohongshu.com/new/note-manager",
    "x-xray-traceid": xrayTraceId(),
    "x-t": signed.xt,
    "x-b3-traceid": b3TraceId(),
    "x-s-common": signed.xs_common,
    "user-agent": String(context.userAgent),
    accept: "application/json, text/plain, */*",
    "x-s": signed.xs,
    "accept-language": "zh-CN,zh;q=0.9",
    cookie,
    priority: "u=1, i",
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": options.secFetchSite || "same-origin",
  };
  if (options.method === "POST") {
    headers["content-type"] = "application/json";
    headers.origin = "https://creator.xiaohongshu.com";
  }
  return headers;
}

export async function creatorSignedGetHeaders(
  creatorCookie: CookieMap,
  api: string,
  proxy: string
): Promise<Record<string, string>> {
  return creatorSignedHeaders(creatorCookie, api, "", proxy, {
    method: "GET",
    mnsProfile: "note_manager",
    b1Profile: "note_manager",
  });
}
