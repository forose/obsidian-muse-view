/**
 * 分享图导出（将笔记导出为 PNG 分享卡）。
 *
 * 设计说明：
 * - 不引入任何第三方 DOM→图 库，纯手写 SVG 分享卡，再 canvas 转 PNG，
 *   避免外部图片导致的 canvas 污染（tainted canvas）问题。
 * - 正文里的图片语法的 markdown（`![[..]]` / `![..](..)`）会被剔除，分享卡为纯文字。
 * - 背景主题直接复用设置项 `exportTheme`（paper/kraft/mint/peach/sky/lavender/
 *   midnight/charcoal + auto/random）。
 * - 水印为「Muse View」。
 */
import type MuseViewPlugin from "./main";
import { Memo, SYSTEM_TAGS } from "./types";
import { stripInlineTags } from "./parser";
import { Modal, Notice } from "obsidian";

/* ===================== 常量 ===================== */
const WIDTH = 640;
const PAD = 48;
const CONTENT_W = WIDTH - PAD * 2; // 544
const BODY_TOP = 110; // 正文首行 baseline
const FONT =
  "-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Hiragino Sans GB','Microsoft YaHei','微软雅黑',sans-serif";
// 纯 path 羽毛笔（跨平台无依赖）
const FEATHER =
  "M13.5 0.5 C11 2.5, 8 5, 5.5 8 C3.5 10.5, 2 12.5, 1.2 14 L3 14.5 L13.5 4 Z M5 6.5 L3.5 9 L5.5 9.2 Z M8 3.5 L6.5 6 L8.5 6.2 Z M10.5 1.2 L9 3.6 L11 3.8 Z M1 14.2 L0 15.5 L1 15.5 Z";

/* ===================== 主题调色板 ===================== */
interface Palette {
  bg: string;
  fg: string;
  muted: string;
  accent1: string;
  accent2: string;
  tagBg: string;
  tagFg: string;
  border: string;
}

const PALETTES: Record<string, Palette> = {
  paper: { bg: "#fdfdfd", fg: "#1a1a1c", muted: "#8a8a8e", accent1: "#7c3aed", accent2: "#3b82f6", tagBg: "rgba(124,58,237,0.08)", tagFg: "#6d28d9", border: "#c8c8cc" },
  kraft: { bg: "#f5ebd8", fg: "#3d2f1e", muted: "#8a6f4a", accent1: "#b45309", accent2: "#d97706", tagBg: "rgba(180,83,9,0.12)", tagFg: "#92400e", border: "#c8a876" },
  mint: { bg: "#e8f5ec", fg: "#1a3a28", muted: "#5a8368", accent1: "#059669", accent2: "#10b981", tagBg: "rgba(5,150,105,0.12)", tagFg: "#047857", border: "#95c8a5" },
  peach: { bg: "#fde8e1", fg: "#3d1f18", muted: "#a77363", accent1: "#ea580c", accent2: "#f97316", tagBg: "rgba(234,88,12,0.12)", tagFg: "#c2410c", border: "#ecab93" },
  sky: { bg: "#e0f2fe", fg: "#0c2a3e", muted: "#5a7a95", accent1: "#0284c7", accent2: "#0ea5e9", tagBg: "rgba(2,132,199,0.12)", tagFg: "#0369a1", border: "#84bcd8" },
  lavender: { bg: "#eee7fa", fg: "#2a1a3e", muted: "#7a6a95", accent1: "#7c3aed", accent2: "#a78bfa", tagBg: "rgba(124,58,237,0.12)", tagFg: "#6d28d9", border: "#bba9de" },
  midnight: { bg: "#1a2238", fg: "#e8e8ea", muted: "#8a95b0", accent1: "#60a5fa", accent2: "#a78bfa", tagBg: "rgba(167,139,250,0.18)", tagFg: "#c4b5fd", border: "#3a4568" },
  charcoal: { bg: "#1a1b1e", fg: "#e8e8ea", muted: "#8a8a90", accent1: "#a78bfa", accent2: "#60a5fa", tagBg: "rgba(167,139,250,0.14)", tagFg: "#c4b5fd", border: "#3a3a40" },
};

function resolvePalette(theme: string, isDark: boolean): Palette {
  let d = theme || "auto";
  if (d === "auto") d = isDark ? "charcoal" : "paper";
  else if (d === "random") {
    const keys = Object.keys(PALETTES);
    d = keys[Math.floor(Math.random() * keys.length)];
  }
  return PALETTES[d] || PALETTES.paper;
}

/* ===================== 文本量算 ===================== */
function isCJK(ch: string): boolean {
  const c = ch.codePointAt(0) ?? 0;
  return (
    (c >= 0x3000 && c <= 0x9fff) ||
    (c >= 0xff00 && c <= 0xffef) ||
    (c >= 0x3040 && c <= 0x30ff)
  );
}

function charWidth(ch: string, fontSize: number, bold: boolean): number {
  let w: number;
  if (isCJK(ch)) w = fontSize;
  else if (/\s/.test(ch)) w = fontSize * 0.3;
  else if (/[.,;:!?'"()\[\]{}<>\/\\|@#$%^&*\-+=~]/.test(ch)) w = fontSize * 0.5;
  else w = fontSize * 0.56;
  return w * (bold ? 1.05 : 1);
}

function measure(str: string, fontSize: number, bold: boolean): number {
  let w = 0;
  for (const ch of str) w += charWidth(ch, fontSize, bold);
  return w;
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function hexToRgba(hex: string, a: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

/* ===================== 内联样式解析 ===================== */
interface Span {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  link?: boolean;
  strike?: boolean;
}

function parseInline(text: string): Span[] {
  const spans: Span[] = [];
  const push = (
    t: string,
    bold = false,
    italic = false,
    code = false,
    link = false,
    strike = false
  ) => {
    if (t) spans.push({ text: t, bold, italic, code, link, strike });
  };
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === "`") {
      const m = text.slice(i).match(/^`([^`]+)`/);
      if (m) {
        push(m[1], false, false, true);
        i += m[0].length;
        continue;
      }
    }
    if (c === "*" && text[i + 1] === "*") {
      const m = text.slice(i).match(/^\*\*([^*]+)\*\*/);
      if (m) {
        push(m[1], true);
        i += m[0].length;
        continue;
      }
    }
    if (c === "~" && text[i + 1] === "~") {
      const m = text.slice(i).match(/^~~([^~]+)~~/);
      if (m) {
        push(m[1], false, false, false, false, true);
        i += m[0].length;
        continue;
      }
    }
    if (c === "[") {
      const link = text.slice(i).match(/^\[([^\]]*)\]\(([^)]+)\)/);
      if (link) {
        push(link[1] || link[2], false, false, false, true);
        i += link[0].length;
        continue;
      }
      const wiki = text.slice(i).match(/^\[\[([^\]]+)\]\]/);
      if (wiki) {
        push(wiki[1], false, false, false, true);
        i += wiki[0].length;
        continue;
      }
    }
    if (c === "*") {
      const m = text.slice(i).match(/^\*([^*\n]+)\*(?!\*)/);
      if (m) {
        push(m[1], false, true);
        i += m[0].length;
        continue;
      }
    }
    // 普通文本：累积到下一个特殊字符
    let j = i + 1;
    while (j < text.length) {
      const d = text[j];
      if (d === "`" || d === "~" || d === "[" || d === "*") break;
      j++;
    }
    push(text.slice(i, j));
    i = j;
  }
  return spans;
}

/* ===================== 块解析 ===================== */
type Block =
  | { kind: "h"; level: number; text: string }
  | { kind: "p"; text: string }
  | { kind: "quote"; text: string }
  | { kind: "ul"; indent: number; text: string }
  | { kind: "ol"; indent: number; num: number; text: string }
  | { kind: "task"; indent: number; checked: boolean; text: string }
  | { kind: "code"; text: string }
  | { kind: "hr" };

function parseBlocks(src: string): Block[] {
  const lines = src.split("\n");
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*$/.test(line)) {
      i++;
      continue;
    }
    if (/^\s*```/.test(line)) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) {
        buf.push(lines[i]);
        i++;
      }
      i++; // 跳过结束 ```
      blocks.push({ kind: "code", text: buf.join("\n") });
      continue;
    }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      blocks.push({ kind: "h", level: h[1].length, text: h[2] });
      i++;
      continue;
    }
    const q = line.match(/^>\s?(.*)$/);
    if (q) {
      const buf: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^>\s?/, ""));
        i++;
      }
      blocks.push({ kind: "quote", text: buf.join("\n") });
      continue;
    }
    const task = line.match(/^(\s*)[-*]\s+\[([ xX])\]\s+(.*)$/);
    if (task) {
      blocks.push({
        kind: "task",
        indent: task[1].length,
        checked: task[2].toLowerCase() === "x",
        text: task[3],
      });
      i++;
      continue;
    }
    const ul = line.match(/^(\s*)[-*+]\s+(.*)$/);
    if (ul) {
      blocks.push({ kind: "ul", indent: ul[1].length, text: ul[2] });
      i++;
      continue;
    }
    const ol = line.match(/^(\s*)\d+\.\s+(.*)$/);
    if (ol) {
      const m = line.match(/^(\s*)(\d+)\.\s+(.*)$/)!;
      blocks.push({
        kind: "ol",
        indent: m[1].length,
        num: parseInt(m[2], 10),
        text: m[3],
      });
      i++;
      continue;
    }
    if (/^\s*(---|\*\*\*|___)\s*$/.test(line)) {
      blocks.push({ kind: "hr" });
      i++;
      continue;
    }
    // 段落：聚合连续的非空、且不是新块起始的行
    const buf: string[] = [];
    while (
      i < lines.length &&
      !/^\s*$/.test(lines[i]) &&
      !/^\s*```/.test(lines[i]) &&
      !/^(#{1,6})\s+/.test(lines[i]) &&
      !/^>\s?/.test(lines[i]) &&
      !/^(\s*)[-*+]\s+/.test(lines[i]) &&
      !/^(\s*)\d+\.\s+/.test(lines[i]) &&
      !/^\s*(---|\*\*\*|___)\s*$/.test(lines[i])
    ) {
      buf.push(lines[i]);
      i++;
    }
    blocks.push({ kind: "p", text: buf.join(" ") });
  }
  return blocks;
}

/* ===================== 自动换行 ===================== */
interface LineSpan {
  text: string;
  x: number;
  bold: boolean;
  italic: boolean;
  code: boolean;
  link: boolean;
  strike: boolean;
}

/** 把 span 序列按字符宽度量算换行，返回多行（每行是带绝对 x 的片段数组）。 */
function wrapSpans(
  spans: Span[],
  fontSize: number,
  maxWidth: number,
  x0: number
): LineSpan[][] {
  const lines: LineSpan[][] = [];
  let cur: LineSpan[] = [];
  let x = x0;
  for (const sp of spans) {
    let rem = sp.text;
    while (rem.length) {
      let len = 0;
      let w = 0;
      while (len < rem.length) {
        const cw = charWidth(rem[len], fontSize, !!sp.bold);
        if (x + w + cw > x0 + maxWidth && len > 0) break;
        w += cw;
        len++;
      }
      const piece = rem.slice(0, len);
      cur.push({
        text: piece,
        x,
        bold: !!sp.bold,
        italic: !!sp.italic,
        code: !!sp.code,
        link: !!sp.link,
        strike: !!sp.strike,
      });
      x += w;
      rem = rem.slice(len);
      if (rem.length) {
        lines.push(cur);
        cur = [];
        x = x0;
      }
    }
  }
  if (cur.length) lines.push(cur);
  else if (lines.length === 0) lines.push([]);
  return lines;
}

/* ===================== 正文布局 ===================== */
function headingSize(level: number): number {
  return [0, 28, 24, 20, 17, 16, 15][level] ?? 15;
}

function layoutBody(body: string, pal: Palette): { svg: string; height: number } {
  const blocks = parseBlocks(body);
  let y = BODY_TOP;
  const deco: string[] = [];
  const text: string[] = [];

  const emitLine = (
    line: LineSpan[],
    ly: number,
    fs: number,
    blockBold: boolean
  ) => {
    const tspans = line
      .map((s) => {
        const attrs: string[] = [];
        if (s.bold || blockBold) attrs.push('font-weight="700"');
        if (s.italic) attrs.push('font-style="italic"');
        if (s.code) attrs.push('font-family="monospace"');
        if (s.link) {
          attrs.push(`fill="${pal.accent1}"`);
          attrs.push('text-decoration="underline"');
        }
        if (s.strike) {
          attrs.push('text-decoration="line-through"');
          attrs.push(`fill="${pal.muted}"`);
        }
        return `<tspan x="${s.x}" y="${ly}" ${attrs.join(" ")}>${esc(s.text)}</tspan>`;
      })
      .join("");
    text.push(`<text font-size="${fs}" fill="${pal.fg}">${tspans}</text>`);
  };

  for (const b of blocks) {
    if (b.kind === "hr") {
      const yy = y + 8;
      deco.push(
        `<line x1="${PAD}" y1="${yy}" x2="${WIDTH - PAD}" y2="${yy}" stroke="${pal.border}" stroke-width="1.5" stroke-dasharray="4 4"/>`
      );
      y += 28;
      continue;
    }

    if (b.kind === "code") {
      const fs = 14;
      const lh = fs * 1.5;
      const innerW = CONTENT_W - 24;
      const lines: LineSpan[][] = [];
      for (const raw of b.text.split("\n")) {
        for (const ln of wrapSpans(parseInline(raw), fs, innerW, PAD + 12))
          lines.push(ln);
      }
      const padV = 10;
      const boxTop = y - fs * 0.8;
      const boxH = lines.length * lh + padV * 2;
      deco.push(
        `<rect x="${PAD}" y="${boxTop}" width="${CONTENT_W}" height="${boxH}" rx="8" fill="${hexToRgba(pal.fg, 0.05)}" stroke="${pal.border}" stroke-width="1"/>`
      );
      let ly = y;
      for (const line of lines) {
        const tspans = line
          .map(
            (s) =>
              `<tspan x="${s.x}" y="${ly}"${s.bold ? ' font-weight="700"' : ""}>${esc(s.text)}</tspan>`
          )
          .join("");
        text.push(`<text font-size="${fs}" fill="${pal.fg}" font-family="monospace">${tspans}</text>`);
        ly += lh;
      }
      y = ly + 12;
      continue;
    }

    const isHeading = b.kind === "h";
    const fs = isHeading ? headingSize((b as { level: number }).level) : 16;
    const lh = fs * 1.6;
    const blockBold = isHeading;
    let spans = parseInline(b.text || "");
    let x0 = PAD;
    let maxW = CONTENT_W;
    let prefixSvg = "";

    if (b.kind === "quote") {
      x0 = PAD + 16;
      maxW = CONTENT_W - 16;
      const barTop = y - fs * 0.8;
      deco.push(
        `<rect x="${PAD}" y="${barTop}" width="3" height="${lh}" rx="1.5" fill="${pal.accent1}" opacity="0.5"/>`
      );
    } else if (b.kind === "ul") {
      x0 = PAD + 22;
      maxW = CONTENT_W - 22;
      prefixSvg = `<text x="${PAD + 4}" y="${y}" font-size="${fs}" fill="${pal.accent1}">•</text>`;
    } else if (b.kind === "ol") {
      x0 = PAD + 30;
      maxW = CONTENT_W - 30;
      prefixSvg = `<text x="${PAD + 4}" y="${y}" font-size="${fs}" fill="${pal.accent1}" font-weight="600">${(b as { num: number }).num}.</text>`;
    } else if (b.kind === "task") {
      x0 = PAD + 26;
      maxW = CONTENT_W - 26;
      const tb = b as { checked: boolean };
      const boxTop = y - fs * 0.8;
      if (tb.checked) {
        deco.push(
          `<rect x="${PAD + 2}" y="${boxTop}" width="14" height="14" rx="3" fill="${pal.accent1}"/>`
        );
        deco.push(
          `<polyline points="${PAD + 6},${boxTop + 7} ${PAD + 8.5},${boxTop + 9.5} ${PAD + 13},${boxTop + 4}" fill="none" stroke="${pal.bg}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>`
        );
        spans = spans.map((s) => ({ ...s, strike: true }));
      } else {
        deco.push(
          `<rect x="${PAD + 2}" y="${boxTop}" width="14" height="14" rx="3" fill="transparent" stroke="${pal.muted}" stroke-width="1.5"/>`
        );
      }
    }

    const lines = wrapSpans(spans, fs, maxW, x0);
    let ly = y;
    let first = true;
    for (const line of lines) {
      if (first && prefixSvg) text.push(prefixSvg);
      emitLine(line, ly, fs, blockBold);
      ly += lh;
      first = false;
    }
    y = ly + (isHeading ? 10 : 6);
  }

  return { svg: deco.concat(text).join("\n  "), height: Math.max(0, y - BODY_TOP) };
}

/* ===================== 标签胶囊 ===================== */
function layoutTags(
  tags: string[],
  pal: Palette
): { svg: string; height: number } {
  if (!tags.length) return { svg: "", height: 0 };
  const fs = 14;
  const padX = 10;
  const h = 24;
  const gap = 8;
  const items: string[] = [];
  let x = PAD;
  let rowY = 0;
  let bottom = 0;
  for (const t of tags) {
    const label = "#" + t;
    const tw = measure(label, fs, false) + padX * 2;
    if (x + tw > WIDTH - PAD && x > PAD) {
      x = PAD;
      rowY += h + gap;
    }
    items.push(
      `<rect x="${x}" y="${rowY}" width="${tw}" height="${h}" rx="12" fill="${pal.tagBg}"/>`
    );
    items.push(
      `<text x="${x + tw / 2}" y="${rowY + h / 2 + fs * 0.35}" font-size="${fs}" fill="${pal.tagFg}" text-anchor="middle">${esc(label)}</text>`
    );
    x += tw + gap;
    bottom = Math.max(bottom, rowY + h);
  }
  return { svg: items.join("\n  "), height: bottom > 0 ? bottom + gap : 0 };
}

/* ===================== 组装分享卡 SVG ===================== */
function buildSVG(
  memo: Memo,
  pal: Palette,
  bodySvg: string,
  bodyH: number,
  tagsSvg: string,
  tagsH: number
): string {
  const afterBody = BODY_TOP + bodyH;
  const tagsTop = tagsH > 0 ? afterBody + 18 : afterBody;
  const tagsBottom = tagsH > 0 ? tagsTop + tagsH : afterBody;
  const dividerY = tagsBottom + 22;
  const dateY = dividerY + 30;
  const timeY = dateY + 20;
  const TOTAL = timeY + 36;
  const ds = memo.date.replace(/-/g, ".");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${TOTAL}" viewBox="0 0 ${WIDTH} ${TOTAL}" font-family="${FONT}">
  <defs>
    <linearGradient id="topBar" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="${pal.accent1}"/>
      <stop offset="100%" stop-color="${pal.accent2}"/>
    </linearGradient>
  </defs>

  <!-- 背景 -->
  <rect width="100%" height="100%" fill="${pal.bg}"/>

  <!-- 顶部渐变装饰条 -->
  <rect x="${PAD}" y="0" width="${CONTENT_W}" height="6" fill="url(#topBar)"/>

  <!-- 装饰引号 -->
  <text x="${PAD}" y="72" font-size="54" font-family="Georgia, 'Times New Roman', serif" fill="${pal.accent1}" opacity="0.22" font-weight="700">&#8220;</text>

  <!-- 正文 -->
  ${bodySvg}

  ${tagsH > 0 ? `<!-- 标签胶囊 -->\n  <g transform="translate(0, ${tagsTop})">\n  ${tagsSvg}\n  </g>` : ""}

  <!-- 虚线分割 -->
  <line x1="${PAD}" y1="${dividerY}" x2="${WIDTH - PAD}" y2="${dividerY}" stroke="${pal.border}" stroke-width="1.6" stroke-linecap="round" stroke-dasharray="5 4"/>

  <!-- 日期 / 时间 -->
  <text x="${PAD}" y="${dateY}" font-size="18" fill="${pal.fg}" font-weight="600" letter-spacing="1">${esc(ds)}</text>
  <text x="${PAD}" y="${timeY}" font-size="13" fill="${pal.muted}">${esc(memo.time)}</text>

  <!-- 右下角：羽毛笔 + Muse View 水印 -->
  <g transform="translate(${WIDTH - PAD - 110}, ${dateY - 15}) scale(1.3)" fill="${pal.muted}" opacity="0.85">
    <path d="${FEATHER}"/>
  </g>
  <text x="${WIDTH - PAD}" y="${dateY}" font-size="12" fill="${pal.muted}" text-anchor="end" letter-spacing="1.5" font-weight="600">Muse View</text>
</svg>`;
}

/* ===================== SVG → PNG ===================== */
function svgToPngBlob(
  svg: string,
  w: number,
  h: number,
  scale: number
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const blob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.width = w;
    img.height = h;
    img.onload = () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = w * scale;
        canvas.height = h * scale;
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          URL.revokeObjectURL(url);
          reject(new Error("canvas 不可用"));
          return;
        }
        ctx.scale(scale, scale);
        ctx.drawImage(img, 0, 0, w, h);
        canvas.toBlob((out) => {
          URL.revokeObjectURL(url);
          if (out) resolve(out);
          else reject(new Error("canvas.toBlob 返回 null（通常是 tainted canvas）"));
        }, "image/png");
      } catch (e) {
        URL.revokeObjectURL(url);
        reject(e as Error);
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("SVG 渲染失败"));
    };
    img.src = url;
  });
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ===================== 构建分享卡 SVG ===================== */
export function buildShareSvg(
  plugin: MuseViewPlugin,
  memo: Memo
): { svg: string; width: number; height: number; filename: string } {
  const isDark =
    document.body.classList.contains("theme-dark") ||
    document.documentElement.classList.contains("theme-dark");
  const pal = resolvePalette(plugin.settings.exportTheme, isDark);

  const { text: stripped, tags } = stripInlineTags(memo.content);
  const body = stripped
    .replace(/!\[\[[^\]]+\]\]/g, "")
    .replace(/!\[[^\]]*\]\([^)]+\)/g, "")
    .trim();
  const visibleTags = tags.filter((t) => !SYSTEM_TAGS.includes(t));

  const bodyLayout = layoutBody(body, pal);
  const tagLayout = layoutTags(visibleTags, pal);
  const svg = buildSVG(
    memo,
    pal,
    bodyLayout.svg,
    bodyLayout.height,
    tagLayout.svg,
    tagLayout.height
  );

  const filename = `muse-${memo.date}-${memo.time.replace(/:/g, "")}`;
  return { svg, width: WIDTH, height: measureTotal(svg), filename };
}

/* ===================== 复制到剪贴板 ===================== */
async function copyPngToClipboard(blob: Blob): Promise<void> {
  const Ctor =
    (window as unknown as { ClipboardItem?: typeof ClipboardItem }).ClipboardItem;
  if (!navigator.clipboard || !Ctor) {
    throw new Error("当前环境不支持复制图片到剪贴板");
  }
  await navigator.clipboard.write([new Ctor({ "image/png": blob })]);
}

/* ===================== 预览弹窗 ===================== */
export class ShareImageModal extends Modal {
  private plugin: MuseViewPlugin;
  private svg: string;
  private width: number;
  private height: number;
  private filename: string;
  private busy = false;

  constructor(
    plugin: MuseViewPlugin,
    svg: string,
    width: number,
    height: number,
    filename: string
  ) {
    super(plugin.app);
    this.plugin = plugin;
    this.svg = svg;
    this.width = width;
    this.height = height;
    this.filename = filename;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("muse-share-modal");
    // 弹窗整体稍微上移一点（默认垂直居中，translateY 负值上移）
    this.modalEl.addClass("muse-share-modal-wrap");

    // 用 Obsidian Modal 自带的 titleEl，它会和右上角叉号自然处于同一行
    this.titleEl.setText(this.plugin.t("modal.shareTitle"));

    // 内嵌 SVG，随容器宽度自适应缩放
    const preview = contentEl.createDiv({ cls: "muse-share-preview" });
    preview.innerHTML = this.svg;

    const bar = contentEl.createDiv({ cls: "muse-share-bar" });
    const copyBtn = bar.createEl("button", {
      cls: "mod-cta muse-share-btn",
      text: this.plugin.t("card.copyImage"),
    });
    copyBtn.addEventListener("click", () => void this.copy());
    const exportBtn = bar.createEl("button", {
      cls: "muse-share-btn",
      text: this.plugin.t("card.exportPng"),
    });
    exportBtn.addEventListener("click", () => void this.exportPng());
  }

  private async toPng(): Promise<Blob> {
    return svgToPngBlob(this.svg, this.width, this.height, 2);
  }

  private async copy(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const blob = await this.toPng();
      await copyPngToClipboard(blob);
      new Notice(this.plugin.t("notice.copiedImage"));
    } catch (e) {
      console.error("[MuseView] 复制图片失败：", e);
      new Notice(this.plugin.t("notice.copyFailed", { msg: (e as Error).message }));
    } finally {
      this.busy = false;
    }
  }

  private async exportPng(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const blob = await this.toPng();
      downloadBlob(blob, `${this.filename}.png`);
      new Notice(this.plugin.t("notice.exportDone", { name: this.filename }));
    } catch (e) {
      console.warn("[MuseView] PNG 导出失败，降级为 SVG：", e);
      const svgBlob = new Blob([this.svg], {
        type: "image/svg+xml;charset=utf-8",
      });
      downloadBlob(svgBlob, `${this.filename}.svg`);
      new Notice(this.plugin.t("notice.exportFailed", { msg: (e as Error).message }));
    } finally {
      this.busy = false;
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/* ===================== 对外入口 ===================== */
export async function openShareImage(
  plugin: MuseViewPlugin,
  memo: Memo
): Promise<void> {
  try {
    const { svg, width, height, filename } = buildShareSvg(plugin, memo);
    new ShareImageModal(plugin, svg, width, height, filename).open();
  } catch (e) {
    console.error("[MuseView] 生成分享图失败：", e);
    new Notice(plugin.t("notice.exportFailed", { msg: (e as Error).message }));
  }
}

/** 从 SVG 字符串里读回 height（避免重复计算）。 */
function measureTotal(svg: string): number {
  const m = /height="(\d+(?:\.\d+)?)"/.exec(svg);
  return m ? parseFloat(m[1]) : 400;
}
