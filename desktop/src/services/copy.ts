/** 文案生成与洗稿：Node 版先走本地离线模板，保证无网络也可用。 */
import {
  appendTopics,
  complianceIssues,
  normalizeDesc,
  normalizeTitle,
  normalizeTopics,
} from "../core/contentText";
import { DEFAULT_PLATFORM, normalizePlatform, platformLabel, specOf } from "../core/platform";
import { getSetting } from "../core/settings";
import { markdownToHtml } from "./richtext";

function sentences(desc: string): string[] {
  return String(desc || "")
    .replace(/\s+/g, " ")
    .trim()
    .split(/[。！？!?\n]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function offlineXhs(seed: string, parts: string[], product: boolean): [string, string, string[]] {
  const first = parts[0] || seed;
  const points = (parts.length > 1 ? parts.slice(1, 4) : [first]).slice(0, 3);
  while (points.length < 3) {
    points.push(["先做最小的一步", "做完记一句结果"][points.length - 1]);
  }
  const lines = [first, "", "我自己的做法是："];
  points.forEach((point, index) => lines.push(`${index + 1}. ${point}`));
  lines.push("", "先把最小的那一步做掉，比整晚焦虑有用。");
  if (product) {
    const name = getSetting("product_name", "应声面试 Pro");
    const pitch = getSetting("product_pitch", "");
    lines.push("", `顺便说一句，我自己在用「${name}」，${pitch}`.trim());
  }
  lines.push("", "你卡在哪一步？");
  return [normalizeTitle(seed, seed, 20), lines.join("\n"), normalizeTopics([], seed, 6)];
}

function offlineWechat(
  seed: string,
  parts: string[],
  product: boolean,
  angle = ""
): [string, string, string[]] {
  const first = parts[0] || seed;
  const point = (index: number, fallback: string) => parts[index] || fallback;
  const intro =
    `最近不少读者问我关于「${seed}」的问题。${first}。` +
    "这篇把自己踩过的坑、实际采用的做法和容易忽略的细节一次讲清楚，尽量少讲空话。";
  const sections: Array<[string, string[]]> = [
    [
      "一、先把问题看清楚",
      [
        `${point(1, "先把目标写下来")}。在动手之前，我会把目标、限制条件和最坏结果各写一行，判断会清楚很多。`,
        "很多卡住并不是能力不够，而是问题定义太模糊。把「我想要什么」换成「下一步能验证什么」，行动就会具体。",
      ],
    ],
    [
      "二、我实际采用的步骤",
      [
        `${point(2, "先把最小的一步做完")}。我的做法是拆成可以检查的小节点，每完成一个就记录一次结果。`,
        "不要一次把所有事情铺开。先跑通一个最小闭环，再根据反馈调整，比一开始追求完美更可靠。",
      ],
    ],
    [
      "三、容易被忽略的细节",
      [
        `${point(3, "把过程记录下来")}。这些细节短期看不出差别，但决定了后面能不能稳定复现。`,
        "如果中途出问题，先回到最近一次有效结果，而不是推倒重来。保留过程，才有机会复盘。",
      ],
    ],
  ];
  const lines = [intro, ""];
  for (const [heading, paragraphs] of sections) {
    lines.push(`## ${heading}`, "");
    for (const paragraph of paragraphs) lines.push(paragraph, "");
  }
  let closing =
    `回到「${seed}」，最重要的不是一次做对，而是先开始、再迭代。` +
    (angle || "如果你也在处理类似的问题，可以从今天最小的一步开始。");
  if (product) {
    closing += ` 我自己在用「${getSetting("product_name", "应声面试 Pro")}」，${getSetting("product_pitch", "")}`.trim();
  }
  lines.push(closing);
  return [
    normalizeTitle(`${seed}：我的做法与三个关键步骤`, seed, 64),
    lines.join("\n"),
    normalizeTopics([], seed, 3),
  ];
}

function offlineDouyin(seed: string, parts: string[], product: boolean): [string, string, string[]] {
  const first = parts[0] || seed;
  const second = parts[1] || "把目标拆成今天能做完的一步";
  const lines = [
    first,
    `先做最小的一步：${second}`,
    "再把目标拆成今天能做完的动作",
    "做完记一句结果，下次直接用",
  ];
  if (product) lines.push(`我自己在用「${getSetting("product_name", "应声面试 Pro")}」，省了不少时间。`);
  lines.push("你卡在哪一步？");
  return [normalizeTitle(`${seed}，先别急着找方法`, seed, 55), lines.join("\n"), normalizeTopics([], seed, 4)];
}

export interface CopyResult {
  title: string;
  desc: string;
  topics: string[];
  body_md: string;
  body_html: string;
  engine: string;
  raw: string;
  platform: string;
  platform_name: string;
  title_max: number;
  body_target: number[];
  compliance: Array<{ label: string; match: string }>;
  llm_error: string;
  retryable: boolean;
}

export function generateFromBrief(
  brief: string,
  options: {
    topic?: string;
    tone?: string;
    tags?: boolean;
    product?: boolean;
    platform?: string;
  } = {}
): CopyResult {
  const desc = String(brief || "").trim();
  if (!desc) throw new Error("文案描述不能为空");
  const platform = normalizePlatform(options.platform || DEFAULT_PLATFORM);
  const spec = specOf(platform);
  const parts = sentences(desc);
  const seed = String(options.topic || "").trim() || parts[0] || "今天想聊一件事";
  const [rawTitle, rawBody, rawTopics] =
    platform === "wechat_mp"
      ? offlineWechat(seed, parts, Boolean(options.product))
      : platform === "douyin"
        ? offlineDouyin(seed, parts, Boolean(options.product))
        : offlineXhs(seed, parts, Boolean(options.product));
  const title = normalizeTitle(rawTitle, seed, spec.title_max);
  const topics = options.tags === false ? [] : normalizeTopics(rawTopics, options.topic || "", platform === "wechat_mp" ? 3 : 6);
  const body = options.tags === false ? rawBody : appendTopics(rawBody, topics, platform);
  const finalDesc = normalizeDesc(body, topics, spec.desc_max, platform);
  const bodyMd = platform === "wechat_mp" ? rawBody : "";
  const bodyHtml = platform === "wechat_mp" ? markdownToHtml(rawBody) : "";
  return {
    title,
    desc: finalDesc,
    topics,
    body_md: bodyMd,
    body_html: bodyHtml,
    engine: "offline",
    raw: body,
    platform,
    platform_name: platformLabel(platform),
    title_max: spec.title_max,
    body_target: platform === "wechat_mp" ? [800, 2000] : [120, 450],
    compliance: complianceIssues(`${title}\n${finalDesc}`),
    llm_error: "",
    retryable: false,
  };
}

export function generateCopy(
  topic: Record<string, unknown>,
  options: { tone?: string; product?: boolean | null; platform?: string } = {}
): CopyResult {
  const title = String(topic.title || "");
  const angle = String(topic.angle || "");
  const brief = angle ? `${title}。${angle}` : title;
  return generateFromBrief(brief, {
    topic: title,
    tone: options.tone,
    tags: true,
    product: options.product === null || options.product === undefined ? Boolean(topic.product) : options.product,
    platform: options.platform,
  });
}

export function rewriteCopy(
  title: string,
  body: string,
  options: { angle?: string; tone?: string; platform?: string } = {}
): CopyResult {
  const platform = normalizePlatform(options.platform || DEFAULT_PLATFORM);
  const angle = String(options.angle || "").trim();
  const brief = `${title}。${body}${angle ? `。${angle}` : ""}`;
  const result = generateFromBrief(brief, {
    topic: title,
    tone: options.tone,
    tags: true,
    platform,
  });
  return { ...result, engine: "offline", llm_error: "", retryable: false };
}

export function checkCopy(
  title: string,
  desc: string,
  platform = DEFAULT_PLATFORM
): Record<string, unknown> {
  const spec = specOf(platform);
  return {
    issues: complianceIssues(`${title}\n${desc}`),
    title_length: normalizeTitle(title, "", spec.title_max).length,
    desc_length: String(desc || "").length,
    platform: normalizePlatform(platform),
    title_max: spec.title_max,
    desc_max: spec.desc_max,
  };
}
