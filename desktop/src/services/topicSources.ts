/**
 * 多平台外部热榜选题源。
 *
 * 小红书之外的平台没有公开的「关键词全网搜索」接口，但热榜是公开 JSON：
 * 抖音、知乎、百度、头条都不需要登录即可读取。这里把它们统一成选题候选，
 * 让选题池不再只有小红书一个来源，也让抖音 / 公众号的定时链路能自己找题。
 */
import { fetch } from "undici";
import { getSetting } from "../core/settings";
import { ingest } from "./topics";

export interface HotSourceMeta {
  key: string;
  label: string;
  platform: string;
  note: string;
}

export const HOT_SOURCES: Record<string, HotSourceMeta> = {
  douyin_hot: {
    key: "douyin_hot",
    label: "抖音热榜",
    platform: "douyin",
    note: "抖音站内实时热榜，适合短视频/图文选题。",
  },
  zhihu_hot: {
    key: "zhihu_hot",
    label: "知乎热榜",
    platform: "wechat_mp",
    note: "知乎热门问题，适合公众号长文。",
  },
  baidu_hot: {
    key: "baidu_hot",
    label: "百度热搜",
    platform: "wechat_mp",
    note: "全网新闻热搜，覆盖面最广。",
  },
  toutiao_hot: {
    key: "toutiao_hot",
    label: "头条热榜",
    platform: "wechat_mp",
    note: "今日头条热榜，资讯类选题。",
  },
};

export const HOT_SOURCE_LIST = Object.values(HOT_SOURCES);

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

interface HotItem {
  title: string;
  url: string;
  hot: number;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function text(value: unknown): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function number(value: unknown): number {
  const parsed = Number(String(value ?? "").replace(/[^\d.]/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

async function fetchJson(url: string, timeoutMs = 12_000): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: {
        "user-agent": UA,
        accept: "application/json, text/plain, */*",
        "accept-language": "zh-CN,zh;q=0.9",
      },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return (await response.json()) as unknown;
  } finally {
    clearTimeout(timer);
  }
}

function douyinItems(payload: unknown): HotItem[] {
  const list = asArray(asRecord(payload).word_list);
  return list
    .map((raw) => {
      const item = asRecord(raw);
      const word = text(item.word);
      if (!word) return null;
      return {
        title: word,
        url: `https://www.douyin.com/search/${encodeURIComponent(word)}`,
        hot: number(item.hot_value),
      };
    })
    .filter((item): item is HotItem => Boolean(item));
}

function zhihuItems(payload: unknown): HotItem[] {
  return asArray(asRecord(payload).data)
    .map((raw) => {
      const target = asRecord(asRecord(raw).target);
      const title = text(target.title);
      if (!title) return null;
      // 问题 ID 是 64 位整数，JSON 数字在 JS 里会丢精度；从字符串 URL 里取。
      const match = text(target.url).match(/questions\/(\d+)/);
      return {
        title,
        url: match ? `https://www.zhihu.com/question/${match[1]}` : "",
        hot: number(target.follower_count) + number(target.answer_count) * 10,
      };
    })
    .filter((item): item is HotItem => Boolean(item));
}

function baiduItems(payload: unknown): HotItem[] {
  const cards = asArray(asRecord(asRecord(payload).data).cards);
  const first = asRecord(cards[0]).content;
  // 百度把榜单再包了一层：cards[0].content[0].content。
  const nested = asArray(first);
  const content = nested.length && Array.isArray(asRecord(nested[0]).content)
    ? asArray(asRecord(nested[0]).content)
    : nested;
  return content
    .map((raw) => {
      const item = asRecord(raw);
      const word = text(item.word);
      if (!word) return null;
      return {
        title: word,
        url: text(item.url),
        hot: number(item.hotScore),
      };
    })
    .filter((item): item is HotItem => Boolean(item));
}

function toutiaoItems(payload: unknown): HotItem[] {
  return asArray(asRecord(payload).data)
    .map((raw) => {
      const item = asRecord(raw);
      const title = text(item.Title || item.title);
      if (!title) return null;
      return {
        title,
        url: text(item.Url || item.url),
        hot: number(item.HotValue || item.hot_value),
      };
    })
    .filter((item): item is HotItem => Boolean(item));
}

const FETCHERS: Record<string, { url: string; parse: (payload: unknown) => HotItem[] }> = {
  douyin_hot: {
    url: "https://www.iesdouyin.com/web/api/v2/hotsearch/billboard/word/",
    parse: douyinItems,
  },
  zhihu_hot: {
    url: "https://api.zhihu.com/topstory/hot-lists/total?limit=50",
    parse: zhihuItems,
  },
  baidu_hot: {
    url: "https://top.baidu.com/api/board?platform=wise&tab=realtime",
    parse: baiduItems,
  },
  toutiao_hot: {
    url: "https://www.toutiao.com/hot-event/hot-board/?origin=toutiao_pc",
    parse: toutiaoItems,
  },
};

/** 平台没有自己的挖掘能力时，按平台挑一个默认热榜来源。 */
export function hotSourceForPlatform(platform: string): string {
  if (platform === "douyin") return "douyin_hot";
  if (platform === "wechat_mp") return "zhihu_hot";
  return "douyin_hot";
}

function focusWords(): string[] {
  return getSetting("focus_keywords", "")
    .replace(/，/g, ",")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function focusHits(title: string, words: string[]): number {
  return words.reduce((total, word) => (title.includes(word) ? total + 1 : total), 0);
}

function scoreOf(item: HotItem, rank: number, total: number, hits: number) {
  const heat = item.hot > 0 ? Math.min(1, Math.log10(item.hot + 1) / 7.5) : Math.max(0, 1 - rank / Math.max(1, total));
  const engagement = Math.round(heat * 10000) / 10000;
  const fresh = 1;
  const fit = Math.min(1, hits / 3);
  const novelty = 0.6;
  const score = engagement * 0.45 + fresh * 0.15 + fit * 0.2 + novelty * 0.2;
  return {
    score: Math.round(score * 1000) / 10,
    detail: {
      engagement,
      fresh,
      fit,
      novelty,
      weighted_interactions: item.hot,
      focus_hits: hits,
      max_similarity: 0,
      age_days: 0,
      product: false,
      rank,
    },
  };
}

export interface MineHotOptions {
  limit?: number;
  keywords?: string[];
  product?: boolean;
}

/** 抓一个外部热榜并入池；失败返回 errors，不抛断整个定时链路之外的调用。 */
export async function mineHot(
  sourceKey: string,
  options: MineHotOptions = {}
): Promise<Record<string, unknown>> {
  const meta = HOT_SOURCES[sourceKey];
  const fetcher = FETCHERS[sourceKey];
  if (!meta || !fetcher) throw new Error(`未知热榜来源：${sourceKey}`);
  const limit = Math.max(1, Math.min(50, Math.trunc(Number(options.limit || 20))));
  const errors: string[] = [];
  let items: HotItem[] = [];
  try {
    const payload = await fetchJson(fetcher.url);
    items = fetcher.parse(payload);
  } catch (error) {
    errors.push(`${meta.label}拉取失败：${error instanceof Error ? error.message : String(error)}`);
  }
  items = items.filter((item) => item.title.length >= 2);
  const words = focusWords();
  const extra = (options.keywords || []).map((item) => item.trim()).filter(Boolean);
  const focus = Array.from(new Set([...words, ...extra]));
  const seen = new Set<string>();
  const candidates: Record<string, unknown>[] = [];
  items.slice(0, limit).forEach((item, index) => {
    if (seen.has(item.title)) return;
    seen.add(item.title);
    const hits = focusHits(item.title, focus);
    const { score, detail } = scoreOf(item, index, items.length, hits);
    candidates.push({
      source: meta.key,
      source_ref: item.url || `${meta.key}-${index}`,
      keyword: focus.find((word) => item.title.includes(word)) || "",
      category: meta.label,
      title: item.title,
      angle: `来自${meta.label}第 ${index + 1} 位，可结合账号定位找切口`,
      tone: "",
      product: Boolean(options.product),
      score,
      score_detail: detail,
      raw: {
        platform: meta.platform,
        hot_source: meta.key,
        hot: item.hot,
        rank: index + 1,
        url: item.url,
      },
    });
  });
  const result = ingest(candidates);
  return {
    source: meta.key,
    source_label: meta.label,
    inserted: Number(result.inserted || 0),
    skipped: Number(result.skipped || 0),
    errors: errors.concat(((result.errors as string[]) || []).slice(0, 5)),
    items: result.items,
    dedupes: result.dedupes,
  };
}
