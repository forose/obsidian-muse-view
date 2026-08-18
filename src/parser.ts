import { App, MarkdownRenderer, Component, TFile } from "obsidian";
import type { MemoImage } from "./types";

/** 匹配内联标签：`#标签`，支持中英文、数字、下划线、斜杠、连字符。 */
const TAG_RE = /#([\p{L}\p{N}_/-]+)/gu;

/** 匹配图片嵌入：`![[图片]]` 与 `![](图片路径)`。 */
const WIKILINK_IMG_RE = /!\[\[([^\]]+?)\]\]/g;
const MD_IMG_RE = /!\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

/** 从正文中提取去重、排序后的标签（不含 `#` 前缀）。 */
export function extractTags(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(TAG_RE)) {
    const tag = m[1].trim();
    if (tag) out.add(tag);
  }
  return Array.from(out).sort((a, b) => a.localeCompare(b, "zh"));
}

/** 把 memo 正文渲染为 Markdown（交由 Obsidian 原生 MarkdownRenderer）。 */
export async function renderMarkdown(
  markdown: string,
  el: HTMLElement,
  sourcePath: string,
  component: Component
): Promise<void> {
  el.empty();
  await MarkdownRenderer.renderMarkdown(markdown, el, sourcePath, component);
}

/** 按本地日期（YYYY-MM-DD）分组排序用的 key。 */
export function dayKey(ts: number): string {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** 本地日期 YYYY-MM-DD。 */
export function formatDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** 本地时间 HH:MM。 */
export function formatTime(date: Date): string {
  const h = String(date.getHours()).padStart(2, "0");
  const m = String(date.getMinutes()).padStart(2, "0");
  return `${h}:${m}`;
}

/** 判断一个链接路径是否指向图片。 */
export function looksLikeImage(path: string): boolean {
  const p = path.split(/[?#]/)[0];
  return /\.(png|jpe?g|gif|webp|svg|bmp|avif)(\|[^\]]*)?$/i.test(p);
}

/** 正文是否包含图片（wikilink 或 markdown 图片）。 */
export function hasImage(text: string): boolean {
  return (
    /!\[\[[^\]]+\.(png|jpe?g|gif|webp|svg|bmp|avif)(\|[^\]]*)?\]\]/i.test(text) ||
    /!\[[^\]]*\]\([^)]+\.(png|jpe?g|gif|webp|svg|bmp|avif)[^)]*\)/i.test(text)
  );
}

/** 正文是否包含非图片链接（wiki 链接或 markdown 链接）。 */
export function hasLink(text: string): boolean {
  return (
    /(^|[^!])\[\[[^\]]+\]\]/.test(text) ||
    /(^|[^!])\[[^\]]+\]\([^)]+\)/.test(text)
  );
}

/** 正文是否包含未完成的任务 `- [ ]`。 */
export function hasOpenTask(text: string): boolean {
  return /^\s*[-*]\s+\[ \]/m.test(text);
}

/**
 * 从正文中抽取 `#标签` 文本并移除，返回「去标签后的正文」与「标签列表」。
 * 标签不出现在卡片正文里，单独以胶囊呈现。
 */
export function stripInlineTags(content: string): {
  text: string;
  tags: string[];
} {
  const tags: string[] = [];
  const text = content
    .replace(
      /[ \t]*#([A-Za-z0-9_\u4e00-\u9fff][A-Za-z0-9_\u4e00-\u9fff/]*)/g,
      (_m, t: string) => {
        if (!tags.includes(t)) tags.push(t);
        return "";
      }
    )
    .split("\n")
    .map((l) => l.replace(/\s+$/, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { text, tags };
}

/**
 * 从正文中提取图片并解析为可用于 <img src> 的地址。
 * 同时返回「移除图片语法后的正文」，供 Markdown 渲染。
 */
export function extractMemoImages(
  app: App,
  content: string,
  filePath: string
): { text: string; images: MemoImage[] } {
  const images: MemoImage[] = [];
  let s = content.replace(WIKILINK_IMG_RE, (_m, inner: string) => {
    const link = inner.trim();
    const p = link.split(/[?#]/)[0];
    if (!looksLikeImage(p)) return _m;
    const dest = app.metadataCache.getFirstLinkpathDest(p, filePath);
    if (!(dest instanceof TFile)) return _m;
    images.push({ src: app.vault.getResourcePath(dest), alt: dest.basename });
    return "";
  });
  s = s.replace(MD_IMG_RE, (_m, url: string) => {
    const link = url.trim();
    const p = link.split(/[?#]/)[0];
    if (
      !looksLikeImage(p) &&
      !link.startsWith("data:image/") &&
      !/^https?:/i.test(link)
    ) {
      return _m;
    }
    let src = link;
    if (!/^https?:/i.test(link) && !link.startsWith("data:")) {
      const dest = app.metadataCache.getFirstLinkpathDest(link, filePath);
      if (dest instanceof TFile) src = app.vault.getResourcePath(dest);
    }
    images.push({ src, alt: link || "image" });
    return "";
  });
  const text = s
    .split("\n")
    .map((l) => l.replace(/\s+$/, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { text, images };
}
