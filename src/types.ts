import { TFile } from "obsidian";

/** 视图类型常量，供 workspace 注册与查找使用。 */
export const VIEW_TYPE_MUSE = "muse-view";
export const VIEW_TYPE_STATS = "muse-stats-view";

/** 保留标签（置顶 / 收藏），渲染时仍从标签胶囊里排除它们
 *  （仅以置顶/星标图标呈现）。 */
export const SYSTEM_TAGS = ["置顶", "收藏"];
export const RESERVED_TAG_PIN = "置顶";
export const RESERVED_TAG_STAR = "收藏";
/** 保留标签集合，用于标签聚合时跳过。 */
export const RESERVED_TAGS = new Set<string>([RESERVED_TAG_PIN, RESERVED_TAG_STAR]);

/** 一条 memo 在内存中的完整表示（含视图渲染所需的派生字段）。 */
export interface Memo {
  /** 对应的 Markdown 年度文件。 */
  file: TFile;
  /** 该 memo 在文件内的行范围 [startLine, endLine]，写操作据此精确定位。 */
  range: [number, number];
  /** 从正文提取出的标签（去 `#` 前缀、去重、排序，含保留标签 `#置顶`/`#收藏`）。 */
  tags: string[];
  /** 用于显示的纯文本（= 正文，保留内联标签原文）。 */
  content: string;
  /** 日期 YYYY-MM-DD。 */
  date: string;
  /** 时间 HH:MM。 */
  time: string;
  /** 完整时间戳。 */
  datetime: Date;
  /** 正文是否包含图片。 */
  hasImage: boolean;
  /** 正文是否包含链接。 */
  hasLink: boolean;
  /** 正文是否包含未完成的任务。 */
  hasOpenTask: boolean;
  /** 是否置顶（正文含 `#置顶`）。 */
  isPinned: boolean;
  /** 是否星标（正文含 `#收藏`）。 */
  isStarred: boolean;
}

/** 侧栏标签导航项（保留接口，核心版由 store 直接计算）。 */
export interface TagCount {
  tag: string;
  count: number;
}

/** 列表过滤条件。 */
export type FilterPreset =
  | "all"
  | "pinned"
  | "starred"
  | "today"
  | "week"
  | "todo"
  | "on-this-day"
  | "no-tag"
  | "with-image"
  | "with-link"
  | "random";

export interface MemoFilter {
  tag: string | null;
  year: string | null;
  date: string | null;
  keyword: string;
  preset: FilterPreset;
  randomSeed?: number;
  /** 随机挑选条数：侧栏「随机回顾」用 5，「随机一条」按钮用 1。 */
  randomCount?: number;
}

/** 图片信息（用于九宫格 / 灯箱）。 */
export interface MemoImage {
  src: string;
  alt: string;
}
