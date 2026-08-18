import { App, TFile, normalizePath } from "obsidian";
import type { Memo, TagCount } from "./types";
import {
  extractTags,
  hasImage,
  hasLink,
  hasOpenTask,
} from "./parser";
import { RESERVED_TAG_PIN, RESERVED_TAG_STAR, RESERVED_TAGS } from "./types";

/**
 * MemoStore —— 负责读写 vault 里的「年度单文件」。
 *
 * 存储约定：
 *   - 路径：`<folder>/<year>.md`（例如 `0- 碎片记忆/2026.md`）
 *   - 文档结构：
 *       # 2026
 *       ## 2026-06-09 周二
 *       - 18:05
 *         正文（续行以两空格缩进）
 *   - 置顶/星标用内联保留标签 `#置顶` / `#收藏` 表示
 *
 * 每条 memo 在文件内由 `range: [startLine, endLine]` 定位，所有写操作（编辑/删除/
 * 置顶/星标/改时间）都基于该 range 在原文上做精确的增删改。
 */
export class MemoStore {
  private memos: Memo[] = [];
  private listeners: Array<() => void> = [];

  constructor(private app: App, private settings: import("./settings").MuseViewSettings) {}

  private get folder(): string {
    return normalizePath(this.settings.folder);
  }

  folderPath(): string {
    return this.folder;
  }

  onChange(cb: () => void): () => void {
    this.listeners.push(cb);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== cb);
    };
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }

  /** 同步获取内存缓存的全部 memo（已按 pinned 优先 + 时间倒序排序）。 */
  getAll(): Memo[] {
    return this.memos;
  }

  /** 从 vault 重新读取全部年度文件并刷新缓存。 */
  async reloadAll(): Promise<void> {
    const files = this.collectFiles();
    const parsed = (
      await Promise.all(
        files.map(async (f) => {
          const raw = await this.app.vault.read(f);
          return parseMemos(f, raw);
        })
      )
    ).flat();
    this.sortMemos(parsed);
    this.memos = parsed;
    this.emit();
  }

  /** 归一化全部年度文件：按规范格式重新序列化每条 memo（不动日期头/年份头）。返回归一化条数。 */
  async normalizeAll(): Promise<number> {
    await this.reloadAll();
    const all = this.getAll();
    const byFile = new Map<string, Memo[]>();
    for (const m of all) {
      const arr = byFile.get(m.file.path) ?? [];
      arr.push(m);
      byFile.set(m.file.path, arr);
    }
    let count = 0;
    for (const [path, memos] of byFile) {
      memos.sort((a, b) => b.range[0] - a.range[0]);
      const file = this.app.vault.getAbstractFileByPath(path);
      if (!(file instanceof TFile)) continue;
      const lines = (await this.app.vault.read(file)).split(/\r?\n/);
      for (const m of memos) {
        const [start, end] = m.range;
        const replacement = serializeMemo(m.time, m.content).split("\n");
        lines.splice(start, end - start + 1, ...replacement);
        count++;
      }
      await this.app.vault.modify(file, lines.join("\n"));
    }
    await this.reloadAll();
    return count;
  }

  /** 重新读取单个年度文件（vault 事件回调用）。 */
  async reloadFile(file: TFile): Promise<void> {
    if (!this.isInFolder(file)) return;
    const raw = await this.app.vault.read(file);
    const parsed = parseMemos(file, raw);
    this.memos = this.memos.filter((m) => m.file.path !== file.path);
    this.memos.push(...parsed);
    this.sortMemos(this.memos);
    this.emit();
  }

  /** 删除缓存中对应路径的 memo（vault 删除事件用）。 */
  removeFile(path: string): void {
    const before = this.memos.length;
    this.memos = this.memos.filter((m) => m.file.path !== path);
    if (this.memos.length !== before) this.emit();
  }

  private sortMemos(arr: Memo[]): void {
    arr.sort((a, b) => {
      if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;
      const d = b.datetime.getTime() - a.datetime.getTime();
      if (d !== 0) return d;
      if (a.file.path !== b.file.path)
        return a.file.path < b.file.path ? 1 : -1;
      return b.range[0] - a.range[0];
    });
  }

  private collectFiles(): TFile[] {
    const folder = this.folder;
    return this.app.vault.getMarkdownFiles().filter((f) => {
      if (f.name.startsWith("_")) return false;
      return f.path === `${folder}/${f.name}` || f.path.startsWith(`${folder}/`);
    });
  }

  isInFolder(file: TFile): boolean {
    return !file.name.startsWith("_") && file.path.startsWith(`${this.folder}/`);
  }

  async ensureFolder(path: string): Promise<void> {
    if (!this.app.vault.getAbstractFileByPath(path)) {
      await this.app.vault.createFolder(path);
    }
  }

  /** 新增一条 memo（视图调用入口）。默认写入「当前时间」对应的年度文件。 */
  async addMemo(text: string, when: Date = new Date()): Promise<void> {
    const body = text.trim();
    if (!body) return;
    const year = when.getFullYear().toString();
    const dateStr = formatDate(when);
    const timeStr = formatTime(when);
    const weekday = WEEKDAYS[when.getDay()];
    const path = normalizePath(`${this.folder}/${year}.md`);
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) {
      const raw = await this.app.vault.read(existing);
      const next = insertMemoIntoYear(raw, year, dateStr, weekday, timeStr, body);
      await this.app.vault.modify(existing, next);
    } else {
      await this.ensureFolder(this.folder);
      const created = `# ${year}\n\n## ${dateStr} ${weekday}\n\n${serializeMemo(timeStr, body)}\n`;
      await this.app.vault.create(path, created);
    }
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) await this.reloadFile(file);
  }

  /** 编辑 memo 正文（保留原始 date/time）。 */
  async editMemo(memo: Memo, text: string): Promise<void> {
    const body = text.trim();
    if (!body) return;
    const file = this.app.vault.getAbstractFileByPath(memo.file.path);
    if (!(file instanceof TFile)) return;
    const raw = await this.app.vault.read(file);
    const lines = raw.split(/\r?\n/);
    const [s, e] = locateMemoRange(lines, memo) ?? memo.range;
    const block = serializeMemo(memo.time, body).split("\n");
    lines.splice(s, e - s + 1, ...block);
    await this.app.vault.modify(file, lines.join("\n"));
    await this.reloadFile(file);
  }

  /** 编辑 memo 的正文与时间（视图「修改创建时间」入口）。 */
  async editMemoDateTime(memo: Memo, date: Date, text: string): Promise<void> {
    const body = text.trim();
    if (!body) return;
    const file = this.app.vault.getAbstractFileByPath(memo.file.path);
    if (!(file instanceof TFile)) return;
    const srcYear = memo.file.basename;
    const dstYear = date.getFullYear().toString();
    const dateStr = formatDate(date);
    const timeStr = formatTime(date);
    const weekday = WEEKDAYS[date.getDay()];

    if (dstYear === srcYear) {
      // 同一年度文件内：删除旧条目后按新时间重新插入
      const raw = await this.app.vault.read(file);
      const lines = raw.split(/\r?\n/);
      const [s, e] = locateMemoRange(lines, memo) ?? memo.range;
      lines.splice(s, e - s + 1);
      removeOrphanDateHeaders(lines);
      trimTrailing(lines);
      const next = insertMemoIntoYear(
        lines.join("\n"),
        dstYear,
        dateStr,
        weekday,
        timeStr,
        body
      );
      await this.app.vault.modify(file, next);
      await this.reloadFile(file);
    } else {
      // 跨年度文件：从源文件删除，写入目标年份文件
      const raw = await this.app.vault.read(file);
      const lines = raw.split(/\r?\n/);
      const [s, e] = locateMemoRange(lines, memo) ?? memo.range;
      lines.splice(s, e - s + 1);
      removeOrphanDateHeaders(lines);
      trimTrailing(lines);
      await this.app.vault.modify(file, lines.join("\n"));
      const dstPath = normalizePath(`${this.folder}/${dstYear}.md`);
      const dst = this.app.vault.getAbstractFileByPath(dstPath);
      if (dst instanceof TFile) {
        const rawDst = await this.app.vault.read(dst);
        const next = insertMemoIntoYear(
          rawDst,
          dstYear,
          dateStr,
          weekday,
          timeStr,
          body
        );
        await this.app.vault.modify(dst, next);
        await this.reloadFile(dst);
      } else {
        await this.ensureFolder(this.folder);
        const created = `# ${dstYear}\n\n## ${dateStr} ${weekday}\n\n${serializeMemo(timeStr, body)}\n`;
        const newFile = await this.app.vault.create(dstPath, created);
        if (newFile instanceof TFile) await this.reloadFile(newFile);
      }
      await this.reloadFile(file);
    }
  }

  /** 删除一条 memo（先可选写入回收站，再删除正文行并清理孤儿日期标题）。 */
  async deleteMemo(memo: Memo): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(memo.file.path);
    if (!(file instanceof TFile)) return;
    if (this.settings.useTrash) {
      try {
        await this.appendToTrash(memo);
      } catch (err) {
        console.error("[MuseView] 写入回收站失败（将继续执行删除）:", err);
      }
    }
    const raw = await this.app.vault.read(file);
    const lines = raw.split(/\r?\n/);
    const [s, e] = memo.range;
    lines.splice(s, e - s + 1);
    removeOrphanDateHeaders(lines);
    trimTrailing(lines);
    await this.app.vault.modify(file, lines.join("\n"));
    await this.reloadFile(file);
  }

  /** 切换置顶（基于内联保留标签 `#置顶`）。 */
  async togglePinned(memo: Memo): Promise<void> {
    await this.toggleReservedTag(memo, RESERVED_TAG_PIN);
  }

  /** 切换星标（基于内联保留标签 `#收藏`）。 */
  async toggleStarred(memo: Memo): Promise<void> {
    await this.toggleReservedTag(memo, RESERVED_TAG_STAR);
  }

  private async toggleReservedTag(memo: Memo, tag: string): Promise<void> {
    const has = memo.tags.includes(tag);
    let next: string;
    if (has) {
      const re = new RegExp(`\\s*#${escapeRe(tag)}(?![A-Za-z0-9_\\u4e00-\\u9fff/])`, "g");
      next = memo.content
        .replace(re, "")
        .split("\n")
        .map((l) => l.replace(/[ \t]+$/, ""))
        .join("\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
      if (next === "") next = `（已取消${tag}）`;
    } else {
      const lines = memo.content.split("\n");
      if (lines.length === 0 || lines[0].trim() === "") lines[0] = `#${tag}`;
      else lines[0] = `${lines[0].replace(/\s+$/, "")} #${tag}`;
      next = lines.join("\n");
    }
    await this.editMemo(memo, next);
  }

  /** 保存图片附件到附件文件夹，返回可写入正文的链接路径。 */
  async saveImageAttachment(file: File, ext?: string): Promise<string> {
    const folder = normalizePath(this.settings.attachmentFolder);
    await this.ensureFolder(folder);
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const stamp =
      `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-` +
      `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    const rand = Math.random().toString(36).slice(2, 6);
    const extName = (ext || file.name.split(".").pop() || "png")
      .replace(/^\./, "")
      .toLowerCase();
    const path = `${folder}/mattach-${stamp}-${rand}.${extName}`;
    const buf = await file.arrayBuffer();
    await this.app.vault.createBinary(path, buf);
    return path;
  }

  /** 聚合全部标签及其出现次数（倒序）。 */
  async allTags(): Promise<TagCount[]> {
    const counts = new Map<string, number>();
    for (const m of this.memos) {
      for (const tag of m.tags) {
        if (RESERVED_TAGS.has(tag)) continue;
        counts.set(tag, (counts.get(tag) ?? 0) + 1);
      }
    }
    return Array.from(counts.entries())
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag, "zh"));
  }

  // ---------------------------------------------------------------- 回收站

  private async appendToTrash(memo: Memo): Promise<void> {
    const folder = this.folder;
    await this.ensureFolder(folder);
    const path = normalizePath(`${folder}/_trash.md`);
    const now = new Date();
    const head = `## 已删除 ${formatDate(now)} ${formatTime(now)}`;
    const body = memo.content
      .split("\n")
      .map((l) => (l === "" ? "" : `  ${l}`))
      .join("\n");
    const entry = `\n${head}\n\n- 来源：\`${memo.file.path}\` · 原时间 ${memo.date} ${memo.time}\n${body}\n`;
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) {
      const raw = await this.app.vault.read(existing);
      const next = trimTrashToLimit(raw + entry, this.settings.trashMaxItems);
      await this.app.vault.modify(existing, next);
    } else {
      const header =
        `# MuseView 回收站\n\n> 这里保存被删除的笔记。停用插件后依然可读，可手动恢复或清空。\n> 该文件不会被 MuseView 主视图识别为普通笔记。\n`;
      await this.app.vault.create(path, header + entry);
    }
  }
}

// ============================================================ 解析 / 序列化

/** 解析单个年度文件内容为 Memo[]。 */
export function parseMemos(file: TFile, content: string): Memo[] {
  const lines = content.split(/\r?\n/);
  const out: Memo[] = [];
  let date = "";
  const dateRe = /^##\s+(\d{4}-\d{2}-\d{2})(?:\s+.+)?$/;
  const memoRe = /^-\s+(\d{2}:\d{2})\s?(.*)$/;
  const yearRe = /^#\s+\d{4}\s*$/;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const dh = line.match(dateRe);
    if (dh) {
      date = dh[1];
      i++;
      continue;
    }
    const mp = line.match(memoRe);
    if (mp && date) {
      const time = mp[1];
      const firstRest = mp[2] ?? "";
      const start = i;
      const contentLines = [firstRest];
      i++;
      while (i < lines.length) {
        const cur = lines[i];
        if (memoRe.test(cur) || dateRe.test(cur) || yearRe.test(cur)) break;
        if (cur.startsWith("  ")) {
          contentLines.push(cur.slice(2));
          i++;
          continue;
        }
        if (cur.trim() === "") {
          let j = i + 1;
          while (j < lines.length && lines[j].trim() === "") j++;
          if (j >= lines.length) break;
          const nxt = lines[j];
          if (memoRe.test(nxt) || dateRe.test(nxt) || yearRe.test(nxt)) break;
          if (nxt.startsWith("  ")) {
            for (let k = i; k < j; k++) contentLines.push("");
            i = j;
            continue;
          }
          break;
        }
        break;
      }
      // 去掉首尾空行
      while (contentLines.length && contentLines[0].trim() === "") contentLines.shift();
      while (contentLines.length && contentLines[contentLines.length - 1].trim() === "")
        contentLines.pop();
      const body = contentLines.join("\n");
      const tags = extractTags(body);
      out.push({
        file,
        range: [start, i - 1],
        date,
        time,
        datetime: makeDateTime(date, time),
        content: body,
        tags,
        hasImage: hasImage(body),
        hasLink: hasLink(body),
        hasOpenTask: hasOpenTask(body),
        isPinned: tags.includes(RESERVED_TAG_PIN),
        isStarred: tags.includes(RESERVED_TAG_STAR),
      });
      continue;
    }
    i++;
  }
  return out;
}

/** 在文件中定位某条 memo 的真实行范围（range 失效时回退到内容匹配）。 */
function locateMemoRange(
  lines: string[],
  memo: Memo
): [number, number] | null {
  const [s, e] = memo.range;
  const timeRe = new RegExp(`^-\\s+${memo.time}(?:\\s|$)`);
  if (s >= 0 && s < lines.length && timeRe.test(lines[s]) && e < lines.length) {
    return [s, e];
  }
  // 回退：按 date+time+content 匹配
  const matches = parseMemos(memo.file, lines.join("\n")).filter(
    (m) =>
      m.date === memo.date &&
      m.time === memo.time &&
      m.content === memo.content
  );
  if (matches.length === 0) return null;
  matches.sort((a, b) => Math.abs(a.range[0] - s) - Math.abs(b.range[0] - s));
  return matches[0].range;
}

/** 把一条 memo 序列化为正文行。 */
function serializeMemo(time: string, content: string): string {
  const t = content.replace(/\r\n/g, "\n").split("\n");
  while (t.length && t[0].trim() === "") t.shift();
  while (t.length && t[t.length - 1].trim() === "") t.pop();
  if (t.length === 0) return `- ${time}`;
  const s = t.map((l) => (l.trim() === "" ? "" : `  ${l}`)).join("\n");
  return `- ${time}\n${s}`;
}

/** 在年度文件中插入一条 memo（按 date 节、time 倒序定位）。 */
function insertMemoIntoYear(
  raw: string,
  year: string,
  dateStr: string,
  weekday: string,
  timeStr: string,
  body: string
): string {
  const lines = raw.split(/\r?\n/);
  const yearHeading = `# ${year}`;
  const dateHeading = `## ${dateStr} ${weekday}`;
  const block = serializeMemo(timeStr, body);
  let yIdx = lines.findIndex((l) => l.trim() === yearHeading);
  if (yIdx < 0) {
    if (lines.length && lines[0].trim() !== "") lines.unshift("", yearHeading, "");
    else lines.unshift(yearHeading, "");
    yIdx = lines.findIndex((l) => l.trim() === yearHeading);
  }
  const dateRe = new RegExp(`^##\\s+${dateStr}(?:\\s+.+)?$`);
  const dateIdx = lines.findIndex((l) => dateRe.test(l));
  if (dateIdx >= 0) {
    // 在已有日期节内插入
    let sectionEnd = lines.length;
    for (let m = dateIdx + 1; m < lines.length; m++) {
      if (/^#{1,2}\s+/.test(lines[m])) {
        sectionEnd = m;
        break;
      }
    }
    const timeRe = /^-\s+(\d{2}:\d{2})(?:\s|$)/;
    let insertAt = -1;
    for (let m = dateIdx + 1; m < sectionEnd; m++) {
      const mm = lines[m].match(timeRe);
      if (mm && mm[1] > timeStr) {
        insertAt = m;
        break;
      }
    }
    if (insertAt >= 0) {
      let m = insertAt;
      while (m > dateIdx + 1 && lines[m - 1].trim() === "") m--;
      lines.splice(m, 0, block, "");
      return lines.join("\n");
    }
    const D = trimTrailingBlank(lines, dateIdx + 1, sectionEnd);
    lines.splice(D, 0, "", block);
    return lines.join("\n");
  }
  // 无该日期节：插入新的 ## 日期块（按日期排序定位）
  const dateOnlyRe = /^##\s+(\d{4}-\d{2}-\d{2})/;
  const yearOnlyRe = /^#\s+\d{4}\s*$/;
  let nextYear = lines.length;
  for (let k = yIdx + 1; k < lines.length; k++) {
    if (yearOnlyRe.test(lines[k])) {
      nextYear = k;
      break;
    }
  }
  let insertIdx = -1;
  for (let k = yIdx + 1; k < nextYear; k++) {
    const v = lines[k].match(dateOnlyRe);
    if (v && v[1] > dateStr) {
      insertIdx = k;
      break;
    }
  }
  if (insertIdx === -1) {
    if (nextYear < lines.length) {
      let k = nextYear;
      while (k > yIdx + 1 && lines[k - 1].trim() === "") k--;
      const block2 = [dateHeading, "", block, ""];
      lines.splice(k, 0, "", ...block2);
      return lines.join("\n");
    }
    while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
    lines.push("", dateHeading, "", block, "");
    return lines.join("\n");
  }
  const block2 = ["", dateHeading, "", block, ""];
  lines.splice(insertIdx, 0, ...block2);
  return lines.join("\n");
}

/** 删除没有下属 memo 的孤儿日期标题。 */
function removeOrphanDateHeaders(lines: string[]): void {
  const dateRe = /^##\s+\d{4}-\d{2}-\d{2}(?:\s+.+)?$/;
  const memoRe = /^- \d{2}:\d{2}/;
  const headingRe = /^#{1,2}\s+/;
  const toRemove: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!dateRe.test(lines[i])) continue;
    let has = false;
    for (let l = i + 1; l < lines.length && !headingRe.test(lines[l]); l++) {
      if (memoRe.test(lines[l])) {
        has = true;
        break;
      }
    }
    if (!has) toRemove.push(i);
  }
  for (let i = toRemove.length - 1; i >= 0; i--) lines.splice(toRemove[i], 1);
}

/** 去掉文件末尾多余空行（保留一个空行分隔）。 */
function trimTrailing(lines: string[]): void {
  while (lines.length > 1 && lines[lines.length - 1].trim() === "") lines.pop();
}

/** 返回 [start, end) 区间内最后一个非空行之后的索引。 */
function trimTrailingBlank(lines: string[], start: number, end: number): number {
  let s = start;
  for (let n = start; n < end; n++) if (lines[n].trim() !== "") s = n + 1;
  return s;
}

/** 回收站内容超过上限时，从最旧开始裁切。 */
function trimTrashToLimit(content: string, limit: number): string {
  if (!limit || limit <= 0) return content;
  const lines = content.split(/\r?\n/);
  const headRe = /^##\s+已删除\s+/;
  const heads: number[] = [];
  for (let i = 0; i < lines.length; i++) if (headRe.test(lines[i])) heads.push(i);
  if (heads.length <= limit) return content;
  const keepFrom = heads[heads.length - limit];
  const head = lines.slice(0, heads[0]);
  const body = lines.slice(keepFrom);
  while (head.length && head[head.length - 1].trim() === "") head.pop();
  return head.join("\n") + "\n\n" + body.join("\n");
}

// ---------------------------------------------------------- 日期 / 工具

const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

function formatDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function formatTime(d: Date): string {
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  return `${h}:${m}`;
}

function makeDateTime(date: string, time: string): Date {
  const [Y, M, D] = date.split("-").map((n) => parseInt(n, 10));
  const [h, m] = time.split(":").map((n) => parseInt(n, 10));
  return new Date(Y, M - 1, D, h, m, 0, 0);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
