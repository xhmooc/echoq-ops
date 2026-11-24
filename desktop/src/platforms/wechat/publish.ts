/**
 * 公众号发布：只写草稿（与 Python 版同一策略）。
 *
 * 平台没有稳定的群发接口，自动「发表」会把失败伪装成成功；这里保存到
 * 草稿箱并明确告知用户去后台人工确认。
 */
import fs from "node:fs";
import path from "node:path";
import { ASSETS_DIR, DATA_DIR, DESIGN_DIR, UPLOAD_DIR } from "../../core/config";
import { log } from "../../core/log";
import {
  PlatformFailure,
  WeChatClient,
  responseJson,
  type WxResponse,
} from "./client";
import { avatarFromHtml, findField, parseAccount } from "./parser";

const COVER_MAX_BYTES = 10 * 1024 * 1024;
const IMAGE_SUFFIXES = new Set([".jpg", ".jpeg", ".png"]);

export interface PublishPayload {
  title?: string;
  desc?: string;
  body_html?: string;
  wx_theme?: string;
  images?: string[];
  content_type?: string;
}

export interface PublishOutcome {
  ok: boolean;
  message: string;
  result: Record<string, unknown>;
  kind?: string;
}

export function validatePayload(payload: PublishPayload): string[] {
  const problems: string[] = [];
  const title = String(payload.title || "").trim();
  const desc = String(payload.desc || "");
  const images = (payload.images || []).map(String).filter(Boolean);
  if (!title) problems.push("公众号草稿需要标题");
  if (title.length > 64) problems.push("公众号标题不能超过 64 字");
  if (desc.length > 20000) problems.push("公众号正文不能超过 2 万字");
  if (!images.length) {
    problems.push("公众号发布需要 1 张封面图");
  } else {
    const file = images[0];
    const suffix = path.extname(file).toLowerCase();
    if (!IMAGE_SUFFIXES.has(suffix)) {
      problems.push(`公众号封面不支持该格式：${suffix || "未知"}`);
    } else if (fs.existsSync(file) && fs.statSync(file).size > COVER_MAX_BYTES) {
      problems.push("公众号封面不能超过 10MB");
    } else if (!fs.existsSync(file)) {
      problems.push(`封面文件不存在：${file}`);
    }
  }
  const requested = String((payload as Record<string, unknown>).action || "").trim();
  if (requested && requested !== "draft") {
    problems.push("公众号只支持保存草稿；群发/发表请在公众号后台人工完成");
  }
  return problems;
}

export async function ensureTokenAsync(client: WeChatClient): Promise<void> {
  if (client.token) return;
  const response = await client.get("/cgi-bin/home", { t: "home/index", lang: "zh_CN" });
  const info = parseAccount(response.text, response.url);
  if (info.token) client.token = info.token;
  if (info.ticket) client.sessionData.ticket = info.ticket;
  if (info.user_name) client.sessionData.user_name = info.user_name;
  if (info.svr_time) client.sessionData.svr_time = info.svr_time;
  if (!client.token) {
    throw new PlatformFailure("auth", "公众号后台 token 已失效，请重新登录");
  }
}

/** 只信任数据目录内的本地素材，避免把任意本地文件上传到平台。 */
function withinDataDir(file: string): boolean {
  const base = path.resolve(DATA_DIR);
  const target = path.resolve(file);
  return target === base || target.startsWith(base + path.sep);
}

function localAssetPath(src: string): string | null {
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

export async function uploadCover(
  client: WeChatClient,
  filePath: string
): Promise<{ cdn_url: string; file_id: string }> {
  const suffix = path.extname(filePath).toLowerCase();
  if (!IMAGE_SUFFIXES.has(suffix)) {
    throw new PlatformFailure("content", "公众号封面只支持 jpg/png");
  }
  if (!fs.existsSync(filePath)) {
    throw new PlatformFailure("content", "公众号封面文件不存在");
  }
  if (!withinDataDir(filePath)) {
    throw new PlatformFailure("content", "公众号封面必须位于应用数据目录内");
  }
  const data = fs.readFileSync(filePath);
  if (data.length > COVER_MAX_BYTES) {
    throw new PlatformFailure("content", "公众号封面不能超过 10MB");
  }
  const mime = suffix === ".png" ? "image/png" : "image/jpeg";
  const base = { token: client.token, lang: "zh_CN" };
  const context = client.sessionData;
  const candidates: Array<[string, Record<string, string>]> = [];
  if (context.ticket && context.user_name && context.svr_time) {
    candidates.push([
      "/cgi-bin/filetransfer",
      {
        ...base,
        action: "upload_material",
        f: "json",
        ticket_id: String(context.user_name),
        ticket: String(context.ticket),
        svr_time: String(context.svr_time),
        writetype: "doublewrite",
        groupid: "1",
      },
    ]);
  }
  candidates.push([
    "/cgi-bin/filetransfer",
    {
      ...base,
      action: "upload_material",
      f: "json",
      scene: "8",
      writetype: "doublewrite",
      groupid: "1",
    },
  ]);
  candidates.push([
    "/cgi-bin/uploadmaterial",
    { cgi: "uploadmaterial", type: "2", ...base },
  ]);

  let last: PlatformFailure | null = null;
  for (const [endpoint, params] of candidates) {
    let response: WxResponse;
    try {
      response = await client.postFile(
        endpoint,
        params,
        "file",
        path.basename(filePath),
        mime,
        data
      );
    } catch (error) {
      last = error instanceof PlatformFailure ? error : null;
      continue;
    }
    try {
      const payload = responseJson(response, "upload_cover");
      let cdnUrl = findField(payload, ["cdn_url", "cdnurl", "cdnUrl", "url", "img_url", "file_url"]);
      let fileId = findField(payload, [
        "media_id",
        "fileid",
        "file_id",
        "nested_media_id",
        "nested_fileid",
        "content",
      ]);
      if (fileId && !/^[A-Za-z0-9_-]{1,80}$/.test(fileId)) fileId = "";
      if (!cdnUrl) {
        const content = String(payload.content || "");
        const match = /src=["']([^"']+)/.exec(content);
        if (match) cdnUrl = match[1];
      }
      if (!fileId) {
        throw new PlatformFailure(
          "platform",
          "公众号封面上传成功但没有返回素材 ID，接口可能已改版",
          JSON.stringify(payload).slice(0, 500)
        );
      }
      return { cdn_url: cdnUrl, file_id: fileId };
    } catch (error) {
      // 已收到接口响应但解析失败时不再换接口：换接口会重复上传同一素材。
      if (error instanceof PlatformFailure) throw error;
      throw new PlatformFailure(
        "platform",
        "公众号封面上传响应解析失败，接口可能已改版",
        String(error)
      );
    }
  }
  throw last || new PlatformFailure("platform", "公众号封面上传失败，接口可能已改版");
}

async function uploadInlineImages(client: WeChatClient, html: string): Promise<string> {
  const cache = new Map<string, string>();
  const sources: string[] = [];
  const pattern = /src="([^"]+)"/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html))) {
    const src = match[1];
    if (!cache.has(src)) cache.set(src, "");
    sources.push(src);
  }
  for (const src of new Set(sources)) {
    const file = localAssetPath(src);
    if (!file) continue;
    try {
      const uploaded = await uploadCover(client, file);
      if (uploaded.cdn_url) cache.set(src, uploaded.cdn_url);
    } catch (error) {
      log.warn(`公众号正文图片上传失败，保留原地址: ${src} / ${String(error)}`);
    }
  }
  return html.replace(pattern, (whole, src: string) => {
    const url = cache.get(src);
    return url ? `src="${url}"` : whole;
  });
}

function plainToHtml(text: string): string {
  const paragraphs = String(text || "")
    .split(/\n{2,}/)
    .map((item) => item.trim())
    .filter(Boolean);
  if (!paragraphs.length) return "<p><br/></p>";
  return paragraphs.map((item) => `<p>${item.replace(/\n/g, "<br/>")}</p>`).join("");
}

async function articleHtml(client: WeChatClient, payload: PublishPayload): Promise<string> {
  let html = String(payload.body_html || "").trim();
  if (!html) html = plainToHtml(String(payload.desc || ""));
  if (!html) html = "<p><br/></p>";
  const uploaded = await uploadInlineImages(client, html);
  return `<section style="font-size:16px;line-height:1.75;color:#333;">${uploaded}</section>`;
}

async function createDraft(
  client: WeChatClient,
  payload: PublishPayload,
  cover: { cdn_url: string; file_id: string }
): Promise<string> {
  const title = String(payload.title || "").trim();
  const desc = String(payload.desc || "").trim();
  const digest = desc.replace(/\s+/g, " ").trim().slice(0, 120);
  const html = await articleHtml(client, payload);
  const context = client.sessionData;
  const appmsgId = String(context.appmsgid || "0");
  const req = {
    idx_infos: [{ save_old: 0, cps_info: { cps_import: 0 } }],
    appmsg_id: /^\d+$/.test(appmsgId) ? Number(appmsgId) : 0,
    is_use_flag: Number(context.is_use_flag || 0),
    template_version: String(context.template_version || ""),
  };
  const data: Record<string, string> = {
    token: client.token,
    lang: "zh_CN",
    t: "ajax-response",
    sub: "create",
    type: "77",
    AppMsgId: appmsgId,
    count: "1",
    articlenum: "1",
    data_seq: String(context.data_seq || "0"),
    isnew: "0",
    ajax: "1",
    isneedsave: "0",
    autosave_log: "",
    pre_timesend_set: "0",
    operate_from: "Chrome",
    title0: title,
    author0: "",
    digest0: digest,
    content0: html,
    sourceurl0: "",
    fileid0: cover.file_id,
    cdnurl0: cover.cdn_url,
    show_cover_pic0: "1",
    need_open_comment0: "1",
    only_fans_can_comment0: "0",
    copyright_type0: "0",
    req: JSON.stringify(req),
  };
  const response = await client.postForm(
    "/cgi-bin/operate_appmsg",
    { t: "ajax-response", sub: "create", type: "77", token: client.token, lang: "zh_CN" },
    data
  );
  const result = responseJson(response, "create_draft");
  const draftId = findField(result, [
    "msgid",
    "appmsgid",
    "appMsgId",
    "app_msg_id",
    "msg_id",
    "nested_msgid",
  ]);
  if (!draftId) {
    throw new PlatformFailure(
      "platform",
      "公众号草稿已提交，但接口没有返回草稿 ID；请到草稿箱确认",
      JSON.stringify(result).slice(0, 500)
    );
  }
  return draftId;
}

export async function publishDraft(
  session: Record<string, unknown>,
  payload: PublishPayload,
  proxy = ""
): Promise<PublishOutcome> {
  const problems = validatePayload(payload);
  if (problems.length) {
    return { ok: false, message: problems.join("；"), result: { stage: "validate" }, kind: "content" };
  }
  const images = (payload.images || []).map(String).filter(Boolean);
  const client = new WeChatClient(session, proxy);
  let draftId = "";
  try {
    await ensureTokenAsync(client);
    const cover = await uploadCover(client, images[0]);
    // 每次都新建草稿：按标题复用旧草稿不会更新正文与封面，会把旧内容发出去。
    draftId = await createDraft(client, payload, cover);
    return {
      ok: true,
      message: "已保存到公众号草稿箱，请在公众平台确认后手动发表",
      result: { action: "draft", draft_id: draftId, stage: "draft" },
    };
  } catch (error) {
    if (error instanceof PlatformFailure) {
      const result: Record<string, unknown> = { stage: error.kind, action: "draft" };
      let message = error.message;
      if (draftId) {
        result.draft_id = draftId;
        result.stage = "draft";
        message = `草稿已保存（ID ${draftId}），但后续步骤失败：${error.message}`;
      }
      return { ok: false, message, result, kind: error.kind };
    }
    log.error(`公众号发布异常: ${error instanceof Error ? error.stack : String(error)}`);
    return {
      ok: false,
      message: "公众号发布失败，请稍后重试（详见日志）",
      result: { stage: "unknown", action: "draft" },
      kind: "platform",
    };
  } finally {
    client.close();
  }
}

/** 登录态巡检：访问后台首页，能解析出身份即视为有效。 */
export async function checkSession(
  session: Record<string, unknown>,
  proxy = ""
): Promise<{
  ok: boolean;
  message: string;
  nickname?: string;
  red_id?: string;
  user_id?: string;
  avatar?: string;
}> {
  const client = new WeChatClient(session, proxy);
  try {
    const response = await client.get("/cgi-bin/home", {
      t: "home/index",
      lang: "zh_CN",
      token: client.token,
    });
    if (response.url.includes("login") || response.text.slice(0, 500).includes("请登录")) {
      return { ok: false, message: "公众号登录态已失效，请重新扫码登录" };
    }
    const info = parseAccount(response.text, response.url);
    if (info.token) client.token = info.token;
    if (!info.nickname && !info.fakeid) {
      return { ok: false, message: "公众号登录态已失效，请重新扫码登录" };
    }
    // 首页 HTML 里通常带一张头像地址；拿不到就留空，界面回退到平台色块。
    const avatar = avatarFromHtml(response.text);
    return {
      ok: true,
      message: "登录态正常",
      nickname: info.nickname,
      red_id: info.fakeid,
      user_id: info.fakeid,
      avatar,
    };
  } catch (error) {
    if (error instanceof PlatformFailure) {
      return { ok: false, message: error.message };
    }
    return { ok: false, message: "公众号登录态检查失败，请稍后重试" };
  } finally {
    client.close();
  }
}
