/**
 * 平台注册表（Node 版）：与 Python 的 ops/platforms 保持一致。
 *
 * 只放声明式元数据与通用校验，具体发布/回读能力见 platforms 目录。
 * 前端「平台」页与草稿规格提示都读这里，保证两家返回结构一致。
 */
export interface ContentSpec {
  key: string;
  label: string;
  media_type: string;
  title_max: number;
  desc_max: number;
  min_images: number;
  max_images: number;
  requires_media: boolean;
  topics: string;
  notes: string;
}

export interface VisibilityOption {
  value: number;
  label: string;
  note: string;
}

export interface PlatformMeta {
  key: string;
  name: string;
  short: string;
  status: "ready" | "planned";
  color: string;
  login_hint: string;
  docs: string;
  topic_style: string;
  default_content_type: string;
  content_types: ContentSpec[];
  visibility_options: VisibilityOption[];
  default_daily_limit: number;
  default_min_interval_sec: number;
  features: Record<string, boolean>;
  comments_mode: "read" | "probe" | "none";
  data_sources: string[];
}

export const DEFAULT_PLATFORM = "xiaohongshu";

const PLATFORMS: Record<string, PlatformMeta> = {
  xiaohongshu: {
    key: "xiaohongshu",
    name: "小红书",
    short: "小红书",
    status: "ready",
    color: "#ff2442",
    login_hint: "粘贴浏览器里的完整 Cookie，或用小红书 App 扫码",
    docs: "小红书创作服务平台",
    topic_style: "hashtag",
    default_content_type: "image_text",
    content_types: [
      {
        key: "image_text",
        label: "图文笔记",
        media_type: "image",
        title_max: 20,
        desc_max: 1000,
        min_images: 1,
        max_images: 18,
        requires_media: true,
        topics: "hashtag",
        notes: "1-18 张竖图，标题 20 字以内，正文 1000 字以内；话题用 # 形式。",
      },
      {
        key: "video",
        label: "视频笔记",
        media_type: "video",
        title_max: 20,
        desc_max: 1000,
        min_images: 1,
        max_images: 1,
        requires_media: true,
        topics: "hashtag",
        notes: "1 个视频文件，标题 20 字以内，正文 1000 字以内。",
      },
    ],
    visibility_options: [
      { value: 0, label: "公开", note: "所有用户可见" },
      { value: 1, label: "仅自己可见", note: "用于演练，不打扰读者" },
    ],
    default_daily_limit: 3,
    default_min_interval_sec: 2700,
    features: {
      login_cookie: true,
      login_qr: true,
      publish: true,
      fetch_published: true,
      fetch_comments: true,
      schedule: true,
    },
    comments_mode: "read",
    data_sources: [
      "阅读（小眼睛）、点赞、评论、收藏：发布后从创作平台作品列表同步。",
      "可见范围：平台作品列表返回的权限字段；本地发布记录作为兜底。",
      "原帖链接：由远端笔记 ID 拼接，可直接跳转。",
    ],
  },
  wechat_mp: {
    key: "wechat_mp",
    name: "微信公众号",
    short: "公众号",
    status: "ready",
    color: "#07c160",
    login_hint: "公众号管理员用微信扫码登录公众平台",
    docs: "微信公众平台 · 图文消息 / 图片消息（只写草稿）",
    topic_style: "topic",
    default_content_type: "long_article",
    content_types: [
      {
        key: "long_article",
        label: "公众号长文",
        media_type: "image",
        title_max: 64,
        desc_max: 20000,
        min_images: 1,
        max_images: 1,
        requires_media: true,
        topics: "topic",
        notes:
          "标题 ≤64 字，正文 ≤2 万字，必须 1 张封面图（jpg/png，≤10MB）；只保存到草稿箱，发表/群发请在后台人工完成。",
      },
      {
        key: "image_message",
        label: "公众号贴图",
        media_type: "image",
        title_max: 64,
        desc_max: 1000,
        min_images: 1,
        max_images: 9,
        requires_media: true,
        topics: "topic",
        notes:
          "图片消息（贴图）：1-9 张 jpg/png 原图（单张 ≤10MB），标题 ≤64 字，短文案 ≤1000 字；图片按原比例竖排。只保存到草稿箱。",
      },
    ],
    visibility_options: [
      { value: 1, label: "保存草稿", note: "只进草稿箱，不推送；发表请在公众号后台人工确认" },
    ],
    default_daily_limit: 1,
    default_min_interval_sec: 0,
    features: {
      login_cookie: false,
      login_qr: true,
      publish: true,
      fetch_published: true,
      schedule: true,
    },
    comments_mode: "probe",
    data_sources: [
      "阅读数、点赞、在看：公众号后台「已发表」列表，平台未返回时留空。",
      "评论数：列表接口通常不返回，留空而不是写 0。",
      "原文链接：平台返回的文章链接。",
    ],
  },
  douyin: {
    key: "douyin",
    name: "抖音",
    short: "抖音",
    status: "ready",
    color: "#161823",
    login_hint: "用抖音 App 扫描创作者中心二维码登录",
    docs: "抖音创作者中心 · 作品发布",
    topic_style: "hashtag",
    default_content_type: "video",
    content_types: [
      {
        key: "video",
        label: "抖音视频",
        media_type: "video",
        title_max: 55,
        desc_max: 1000,
        min_images: 1,
        max_images: 1,
        requires_media: true,
        topics: "hashtag",
        notes: "1 个视频（≤4GB、≤15 分钟），文案（含标题）≤1000 字，标题建议 ≤55 字。",
      },
      {
        key: "image_text",
        label: "抖音图文",
        media_type: "image",
        title_max: 55,
        desc_max: 1000,
        min_images: 2,
        max_images: 35,
        requires_media: true,
        topics: "hashtag",
        notes: "2-35 张图片，文案（含标题）≤1000 字。",
      },
    ],
    visibility_options: [
      { value: 0, label: "公开", note: "所有人可见" },
      { value: 1, label: "仅自己可见", note: "先发给自己检查" },
      { value: 2, label: "好友可见", note: "仅互关好友可见" },
    ],
    default_daily_limit: 3,
    default_min_interval_sec: 1800,
    features: {
      login_cookie: false,
      login_qr: true,
      publish: true,
      fetch_published: true,
      schedule: true,
    },
    comments_mode: "none",
    data_sources: [
      "播放量、点赞、评论、收藏：创作者中心作品列表接口，失败时回退页面可见数据。",
      "平台未返回的指标留空，不写 0。",
    ],
  },
};

const ORDER = ["xiaohongshu", "wechat_mp", "douyin"];

export function normalizePlatform(key: unknown): string {
  const value = String(key ?? "").trim();
  if (!value) return DEFAULT_PLATFORM;
  if (!PLATFORMS[value]) {
    throw new Error(`未知平台：${value}（可选：${ORDER.join("、")}）`);
  }
  return value;
}

export function platformMeta(key: unknown): PlatformMeta {
  return PLATFORMS[normalizePlatform(key)];
}

export function platformLabel(key: unknown): string {
  const value = String(key ?? DEFAULT_PLATFORM);
  return PLATFORMS[value]?.name || value;
}

export function isPlatformReady(key: unknown): boolean {
  return PLATFORMS[String(key ?? DEFAULT_PLATFORM)]?.status === "ready";
}

export function specOf(platform: unknown, contentType = ""): ContentSpec {
  const meta = platformMeta(platform);
  const target = contentType || meta.default_content_type;
  return meta.content_types.find((item) => item.key === target) || meta.content_types[0];
}

export function specForMedia(platform: unknown, mediaType = ""): ContentSpec {
  const meta = platformMeta(platform);
  return meta.content_types.find((item) => item.media_type === mediaType) || specOf(platform);
}

export function describePlatform(key: string): Record<string, unknown> {
  const meta = PLATFORMS[key];
  return {
    key: meta.key,
    name: meta.name,
    short: meta.short,
    status: meta.status,
    status_text: meta.status === "ready" ? "已接入" : "接入位已预留",
    ready: meta.status === "ready",
    color: meta.color,
    login_hint: meta.login_hint,
    docs: meta.docs,
    topic_style: meta.topic_style,
    default_content_type: meta.default_content_type,
    content_types: meta.content_types,
    visibility_options: meta.visibility_options,
    limits: {
      daily_limit: meta.default_daily_limit,
      min_interval_sec: meta.default_min_interval_sec,
    },
    features: meta.features,
    data_sources: meta.data_sources,
  };
}

export function listPlatforms(): Record<string, unknown>[] {
  return ORDER.map(describePlatform);
}

export function validateDraft(
  platform: unknown,
  payload: { title?: string; desc?: string; images?: unknown[]; media_type?: string },
  contentType = ""
): string[] {
  const meta = platformMeta(platform);
  const spec = contentType ? specOf(platform, contentType) : specForMedia(platform, payload.media_type || "");
  const title = String(payload.title || "").trim();
  const desc = String(payload.desc || "").trim();
  const images = Array.isArray(payload.images) ? payload.images : [];
  const problems: string[] = [];
  const noisy = (text: string) => text.includes("个素材，当前");
  if (!title) problems.push("标题不能为空");
  else if (title.length > spec.title_max) problems.push(`标题最多 ${spec.title_max} 字，当前 ${title.length} 字`);
  if (!desc) problems.push("正文不能为空");
  else if (desc.length > spec.desc_max) problems.push(`正文最多 ${spec.desc_max} 字，当前 ${desc.length} 字`);
  if (spec.requires_media && !images.length) problems.push(`${spec.label}需要至少 ${Math.max(1, spec.min_images)} 个素材`);
  if (images.length && images.length < spec.min_images) problems.push(`${spec.label}至少需要 ${spec.min_images} 个素材`);
  if (spec.max_images && images.length > spec.max_images) problems.push(`${spec.label}最多 ${spec.max_images} 个素材，当前 ${images.length} 个`);
  // 公众号长文允许跨平台留下的多余图片进正文，不算封面错误。
  if (meta.key === "wechat_mp" && spec.key === "long_article") {
    return problems.filter((item) => !noisy(item));
  }
  return problems;
}
