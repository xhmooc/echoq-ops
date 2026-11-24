/**
 * 小红书适配器的公共类型。
 *
 * 字段与 ops/platforms/xiaohongshu.py 的 normalize_note / normalize_comment
 * 保持一致，队列与页面可以直接复用，不需要再二次转换。
 */

export interface NormalizedNote {
  remote_note_id: string;
  title: string;
  desc: string;
  cover: string;
  note_type: "image" | "video";
  visibility: string;
  views: number | null;
  likes: number | null;
  collects: number | null;
  comments: number | null;
  published_at: number;
  url: string;
  raw: Record<string, unknown>;
}

export interface NormalizedComment {
  remote_comment_id: string;
  author: string;
  author_id: string;
  content: string;
  likes: number | null;
  commented_at: number;
  is_reply: boolean;
  parent_comment_id: string;
}

export interface SessionCheckResult {
  ok: boolean;
  message: string;
  nickname?: string;
  red_id?: string;
  user_id?: string;
  avatar?: string;
}

export interface PublishOutcome {
  ok: boolean;
  message: string;
  result: Record<string, unknown>;
  kind?: string;
}

export interface PublishedPage {
  ok: boolean;
  message: string;
  items: NormalizedNote[];
  next_cursor: number | null;
}

export interface CommentsPage {
  ok: boolean;
  message: string;
  items: NormalizedComment[];
}
