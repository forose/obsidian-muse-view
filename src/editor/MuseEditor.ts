import {
  App,
  Component,
  MarkdownRenderer,
  Platform,
  prepareFuzzySearch,
} from "obsidian";

const HEADING_CLASSES = [
  "lp-h1",
  "lp-h2",
  "lp-h3",
  "lp-h4",
  "lp-h5",
  "lp-h6",
];

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * 编辑框统一接口。
 * 这样主视图既可以用纯 textarea（关闭实时预览时的回退），
 * 也可以用 contenteditable 单栏 Live Preview，而不用到处改 .value 访问。
 */
export interface MuseEditor {
  el: HTMLElement;
  getValue(): string;
  setValue(v: string): void;
  focus(): void;
  isEmpty(): boolean;
  setPlaceholder(text: string): void;
  /** 光标所在"行/块"的源码文本（textarea 下即整篇）。 */
  getActiveText(): string;
  /** 光标偏移（相对 active text）。 */
  getCaret(): number;
  getCaretEnd(): number;
  setActiveText(text: string, caret?: number): void;
  /** 在 active text 的 [start,end) 处替换为 text，并把光标放到替换后位置。 */
  replaceRange(start: number, end: number, text: string): void;
  autoResize(): void;
  setOnChange(cb: () => void): void;
  setOnKeydown(cb: (e: KeyboardEvent) => void): void;
  setOnFocus(cb: () => void): void;
  setOnBlur(cb: () => void): void;
  destroy(): void;
}

/** textarea 实现的封装，作为 livePreview 关闭时的回退。 */
export class TextareaEditor implements MuseEditor {
  el: HTMLTextAreaElement;
  private changeCb?: () => void;
  private keyCb?: (e: KeyboardEvent) => void;
  private focusCb?: () => void;
  private blurCb?: () => void;

  constructor(el: HTMLTextAreaElement) {
    this.el = el;
    el.addEventListener("input", () => this.changeCb?.());
    el.addEventListener("keydown", (e) => this.keyCb?.(e));
    el.addEventListener("focus", () => this.focusCb?.());
    el.addEventListener("blur", () => this.blurCb?.());
  }
  getValue() {
    return this.el.value;
  }
  setValue(v: string) {
    this.el.value = v;
  }
  focus() {
    this.el.focus();
  }
  isEmpty() {
    return this.el.value.length === 0;
  }
  setPlaceholder(t: string) {
    this.el.setAttr("placeholder", t);
  }
  getActiveText() {
    return this.el.value;
  }
  getCaret() {
    return this.el.selectionStart ?? this.el.value.length;
  }
  getCaretEnd() {
    return this.el.selectionEnd ?? this.el.value.length;
  }
  setActiveText(t: string, caret?: number) {
    this.el.value = t;
    if (caret != null) this.el.setSelectionRange(caret, caret);
  }
  replaceRange(start: number, end: number, text: string) {
    this.el.value =
      this.el.value.slice(0, start) + text + this.el.value.slice(end);
    const pos = start + text.length;
    this.el.setSelectionRange(pos, pos);
  }
  autoResize() {
    const el = this.el;
    el.classList.add("muse-no-transition");
    if (el.value.length === 0) {
      el.style.height = "";
      requestAnimationFrame(() =>
        el.classList.remove("muse-no-transition")
      );
      return;
    }
    el.style.height = "auto";
    const h = el.scrollHeight + 2;
    const max = Platform.isMobile ? 56 : 96;
    el.style.height = h <= max ? "" : `${h}px`;
    requestAnimationFrame(() =>
      el.classList.remove("muse-no-transition")
    );
  }
  setOnChange(cb: () => void) {
    this.changeCb = cb;
  }
  setOnKeydown(cb: (e: KeyboardEvent) => void) {
    this.keyCb = cb;
  }
  setOnFocus(cb: () => void) {
    this.focusCb = cb;
  }
  setOnBlur(cb: () => void) {
    this.blurCb = cb;
  }
  destroy() {}
}

/**
 * 单栏 Live Preview 编辑器（仿 Obsidian 编辑视图）：
 * 光标所在行显示 markdown 源码，其余行实时渲染为富文本。
 *
 * 实现要点：
 * - 每行是一个 .muse-lp-line div，结构由本类显式管理（Enter/Backspace 自己接管，
 *   避免浏览器插入 <br> 导致源码丢失）。
 * - 只在「非光标行」上替换 innerHTML 为渲染结果，光标行 DOM 永远不动，
 *   因此输入法（IME）合成期间与光标都不会被打断。
 * - 渲染仅在非光标行「源码变化」时才重做（dataset.src 缓存），输入时几乎零重排。
 */
export class LivePreviewEditor implements MuseEditor {
  el: HTMLElement;
  private app: App;
  private sourcePath: string;
  private source: string[] = [""];
  private cursorRow = 0;
  private component = new Component();
  private changeCb?: () => void;
  private keyCb?: (e: KeyboardEvent) => void;
  private focusCb?: () => void;
  private blurCb?: () => void;
  private composing = false;
  private placeholder = "";
  private lastCol = 0;
  private navArrow = false;
  private renderScheduled = false;
  /** 全选模式：Ctrl/Cmd+A 时置 true，所有行都以「源码 + 样式」渲染（类似 Obsidian
   * Live Preview 全选时整体切到源码视图），便于整体查看/复制原始 markdown。 */
  private allSource = false;

  /** 内部链接建议（输入 [[ 触发，仿 Obsidian 的 wiki-link 自动补全）。 */
  private suggestEl!: HTMLElement;
  private suggest: {
    active: boolean;
    /** 光标行内 query 起点（即 [[ 的下一个字符偏移）。 */
    start: number;
    query: string;
    items: string[];
    index: number;
  } | null = null;
  /** vault 内全部 Markdown 笔记的 basename（已去重），搜索时复用。 */
  private cachedFiles: string[] = [];
  private onWinScroll = () => this.hideSuggest();

  constructor(parent: HTMLElement, app: App, sourcePath = "") {
    this.app = app;
    this.sourcePath = sourcePath;
    this.el = parent.createDiv({ cls: "muse-lp muse-input" });
    this.el.setAttribute("contenteditable", "true");
    this.el.setAttribute("role", "textbox");
    this.el.setAttribute("aria-multiline", "true");
    this.component.load();

    this.el.addEventListener("input", () => this.onInput());
    this.el.addEventListener("compositionstart", () => {
      this.composing = true;
    });
    this.el.addEventListener("compositionend", () => {
      this.composing = false;
      this.syncFromDom();
      this.scheduleRender();
      this.changeCb?.();
    });
    this.el.addEventListener("keydown", (e) => this.onKeydown(e));
    this.el.addEventListener("paste", (e) => this.onPaste(e));
    this.el.addEventListener("copy", this.onCopy);
    this.el.addEventListener("focus", () => this.focusCb?.());
    this.el.addEventListener("blur", () => {
      this.hideSuggest();
      this.blurCb?.();
    });
    this.el.addEventListener("scroll", () => this.hideSuggest());
    document.addEventListener("selectionchange", this.onSelectionChange);
    window.addEventListener("scroll", this.onWinScroll, true);

    this.ensureFirstLine();
    this.buildSuggestEl();
    this.updateEmpty();
  }

  /* ----------------------------- 接口实现 ----------------------------- */

  getValue(): string {
    // 取真值原则：
    // - 已渲染（非光标）行：必须用 dataset.src（原始源码），MarkdownRenderer 渲染后
    //   DOM 文本已吞掉 # / ** 等语法，textContent 不再是源码。
    // - 光标行：DOM 才是「权威」实时值——浏览器每次键入 / IME 合成都会更新 DOM；
    //   受控 source 只是渲染缓存，可能在 renderActiveLine innerHTML 重建与
    //   syncFromDom 之间、或 IME 合成中，出现极短时序的"短暂不一致"。
    //   因此光标行优先读 live DOM（按 trim 判真），仅在 DOM 为空时回退到 source 兜底。
    //   彻底杜绝「明明有内容却取到空」导致的「输入框被识别为空」问题。
    const rows = this.lineEls();
    const parts: string[] = [];
    rows.forEach((row, i) => {
      // 代码块内侧被隐藏的行：其源码已含在起始行的 joined src 中，跳过避免重复。
      if ((row.dataset as any).codeHidden) return;
      if (row.classList.contains("is-code-block")) {
        // 整段围栏代码块的源码（含换行），由起始行持有。
        parts.push((row.dataset as any).src ?? "");
        return;
      }
      if (row.classList.contains("is-rendered")) {
        const ds = (row.dataset as any).src;
        // 安全网：若渲染行 dataset.src 为空（旧空值残留）但 DOM 已有内容，
        // 说明用户在该行直接键入（异步窗口内尚未切活跃态）→ 以 DOM 真值为准，
        // 避免「有内容却取到空 / 占位符残留（看起来没识别到内容）」。
        if (!ds) {
          const dom = (row.textContent ?? "").trim();
          if (dom) {
            parts.push(dom);
            return;
          }
        }
        parts.push(ds ?? this.source[i] ?? "");
      } else {
        const dom = row.textContent ?? "";
        if (dom.trim()) parts.push(dom);
        else parts.push(this.source[i] ?? "");
      }
    });
    return parts.join("\n");
  }
  setValue(v: string): void {
    this.component.unload();
    this.component = new Component();
    this.component.load();
    // 重置瞬时编辑态，避免跨次 setValue（如连续编辑两张卡）残留全选源码模式等标记。
    this.allSource = false;
    this.composing = false;
    this.el.empty();
    this.source = v.length ? v.split("\n") : [""];
    this.source.forEach((s) => {
      const d = this.el.createDiv({ cls: "muse-lp-line" });
      d.textContent = s;
    });
    this.cursorRow = this.source.length - 1;
    this.updateEmpty();
    this.scheduleRender();
    requestAnimationFrame(() =>
      this.setCaretCol((this.source[this.cursorRow] ?? "").length)
    );
  }
  focus(): void {
    this.el.focus();
  }
  isEmpty(): boolean {
    return this.getValue().trim().length === 0;
  }
  setPlaceholder(t: string): void {
    this.placeholder = t;
    this.el.setAttr("data-placeholder", t);
    this.updateEmpty();
  }
  getActiveText(): string {
    return this.source[this.cursorRow] ?? "";
  }
  getCaret(): number {
    return this.getCaretCol();
  }
  getCaretEnd(): number {
    return this.getCaretCol();
  }
  setActiveText(t: string, caret?: number): void {
    this.source[this.cursorRow] = t;
    const row = this.lineEls()[this.cursorRow];
    if (row) row.textContent = t;
    if (caret != null) this.setCaretCol(caret);
    else this.setCaretCol(t.length);
    this.updateEmpty();
    this.scheduleRender();
  }
  replaceRange(start: number, end: number, text: string): void {
    const row = this.cursorRow;
    const cur = this.source[row] ?? "";
    const next = cur.slice(0, start) + text + cur.slice(end);
    this.source[row] = next;
    const lineEl = this.lineEls()[row];
    if (lineEl) lineEl.textContent = next;
    const pos = start + text.length;
    this.setCaretCol(pos);
    this.scheduleRender();
  }
  autoResize(): void {
    // 高度由内容自然撑开（CSS），无需手动计算。
  }
  setOnChange(cb: () => void) {
    this.changeCb = cb;
  }
  setOnKeydown(cb: (e: KeyboardEvent) => void) {
    this.keyCb = cb;
  }
  setOnFocus(cb: () => void) {
    this.focusCb = cb;
  }
  setOnBlur(cb: () => void) {
    this.blurCb = cb;
  }
  destroy(): void {
    document.removeEventListener("selectionchange", this.onSelectionChange);
    window.removeEventListener("scroll", this.onWinScroll, true);
    this.suggestEl?.remove();
    this.el.removeEventListener("copy", this.onCopy);
    this.component.unload();
  }

  /* ----------------------------- 内部逻辑 ----------------------------- */

  private lineEls(): HTMLElement[] {
    const out: HTMLElement[] = [];
    for (const child of Array.from(this.el.children)) {
      if (
        child instanceof HTMLElement &&
        child.classList.contains("muse-lp-line")
      ) {
        out.push(child);
      } else if (child instanceof HTMLElement) {
        child.addClass("muse-lp-line");
        out.push(child);
      }
    }
    return out;
  }

  private ensureFirstLine(): void {
    // contenteditable 在「删除最后一行 / 全选删除」后，浏览器可能把唯一的空行 div
    // 也移除 → el 无任何 muse-lp-line 子节点；或把用户随后输入直接落成 el 根下的
    // 文本节点（未包裹行 div）。这两种情况下 lineEls() 返回 0 行，syncFromDom 重建的
    // source 永远为空 → 「有内容却识别为空 / 没识别到内容」（新建/编辑已发布都复现）。
    // 兜底：把根下游离文本节点归并进行 div，并保证 el 始终至少有 1 个 muse-lp-line 行。
    const rows = this.lineEls();
    const freeTexts: string[] = [];
    for (const node of Array.from(this.el.childNodes)) {
      if (
        node.nodeType === Node.TEXT_NODE &&
        (node.textContent ?? "").length > 0
      ) {
        freeTexts.push(node.textContent ?? "");
      }
    }
    if (rows.length === 0 || freeTexts.length > 0) {
      const texts: string[] = rows.map((r) =>
        (r.textContent ?? "").replace(/\n$/, "")
      );
      freeTexts.forEach((t) => texts.push(t));
      const merged = texts.length ? texts : [""];
      this.el.empty();
      merged.forEach((s) => {
        const d = this.el.createDiv({ cls: "muse-lp-line" });
        d.textContent = s;
      });
      this.cursorRow = Math.max(0, merged.length - 1);
      // 光标放回规整后的末行末尾，避免规整后光标丢失、输入再次落到根下文本节点。
      this.setCaretCol((merged[this.cursorRow] ?? "").length);
    }
  }

  /** 以 this.source 为唯一真值，重建所有行的 DOM（用于 setValue / 多行粘贴后）。 */
  private rebuildDom(): void {
    this.el.empty();
    if (this.source.length === 0) this.source = [""];
    this.source.forEach((s) => {
      const d = this.el.createDiv({ cls: "muse-lp-line" });
      d.textContent = s;
    });
  }

  /**
   * 仅从「光标行」回读源码到 this.source。
   * 已渲染（非光标）行的 DOM 里 markdown 语法已被消费（如 `# 标题` 渲染后
   * textContent 变成 `标题`），绝不能从它们反读，否则 source 会丢失语法、
   * 表现为"前面的样式行输入后消失"。光标行永远是纯文本节点，可安全回读。
   * 用受控的 this.cursorRow（由所有操作维护）而非实时选区，避免失焦瞬间读错。
   */
  /**
   * 从 DOM 完整重建 source 数组：行数严格镜像当前 DOM，每行取「源码真值」。
   * - 光标行 / 活跃态行（is-active，含全选源码模式 allSource 下的所有行）：
   *   textContent 即为源码（renderActiveLine 渲染标题/行内时保留 # ** 等标记），直接读。
   * - 非光标且已渲染行（is-rendered）：textContent 已被 MarkdownRenderer 消费
   *   （# 标题 → 标题），必须用渲染时存的 dataset.src。
   * 旧实现只同步 cursorRow 一行，块操作（全选删除 / 跨行删 / 跨行粘贴）后 source 与 DOM
   * 错位，残留旧行被 renderActiveLine 回填或 onPaste 的 splice 漏改 →
   * 「全选删不掉 / 删除后粘贴残留旧内容」。
   */
  private syncFromDom(): void {
    // 兜底：规整「0 行 / 根下游离文本」为至少 1 个 muse-lp-line 行，避免删除末行后
    // 用户输入直接落成根下文本节点、lineEls 取空导致 source 永远为空（识别不到内容）。
    this.ensureFirstLine();
    // 【编辑模式「识别不出来」修复】实时 selection 所在行为「权威」行（用 DOM textContent），
    // 其他行才是「已渲染行」（走 dataset.src）。
    //
    // 之前用 this.cursorRow 作判定——但点新行后 cursorRow 立即更新，
    // 而 renderLines 把新行切到 is-rendered 是 scheduleRender 排的下一个 rAF 内才执行（异步）。
    // 这之间用户已按下第一个键：onInput → syncFromDom 跑时，新行仍标 is-rendered，
    // 旧 cursorRow 命中的是另一行（仍是 is-rendered），整张表都用 dataset.src 兜底
    // → 用户刚键入的字符被吞、source 残留旧内容 → 「有内容却识别为空 / 删除后残留」。
    // 改用 window.getSelection() 实时定位 selection 所在行：浏览器每次键入都维护
    // selection，把 selection 所在行视作权威活行、用 DOM textContent 重建 source。
    const rows = this.lineEls();
    const liveRow = this.getCurrentCaretRow();
    const live = liveRow >= 0 ? liveRow : Math.max(0, Math.min(this.cursorRow, rows.length - 1));
    // 强制把活行从「is-rendered」切回「is-active」——这样活行绝对会走 textContent 分支
    // （dataset.src 对活行不再有效），避免 input 落在渲染态的同一帧里被 dataset.src 吞掉。
    if (rows[live]) {
      rows[live].classList.remove("is-rendered");
      rows[live].classList.add("is-active");
      delete (rows[live].dataset as any).src;
    }
    this.source = [];
    rows.forEach((row, i) => {
      // 代码块内侧隐藏行：其源码已含在起始行的 joined src 中，跳过避免重复 / 破坏行数。
      if ((row.dataset as any).codeHidden) return;
      if (row.classList.contains("is-code-block") || (row.dataset as any).codeBlock === "start") {
        const joined = (row.dataset as any).src ?? "";
        joined.split("\n").forEach((l: string) => this.source.push(l));
        return;
      }
      if (i === live || row.classList.contains("is-active")) {
        this.source.push((row.textContent ?? "").replace(/\n$/, ""));
      } else {
        this.source.push((row.dataset as any).src ?? "");
      }
    });
    this.cursorRow = live;
    // 全部清空 → 归一化为「单行空 + 光标落首行」。
    // 否则浏览器在全选删除后会残留多个空行 div、且光标可能落在中间/末尾行，
    // 用户随后输入的内容会落在某一行、上方留若干空白行（→「内容显示在占位符下方」）；
    // 同时占位符（absolute 定位在容器顶部）与真实输入视觉叠加，看起来「没识别到内容」。
    // 代码块存在时不归一化，避免破坏整段代码块结构。
    if (
      !rows.some((r) => r.classList.contains("is-code-block")) &&
      this.source.length > 1 &&
      this.source.every((s) => !s.trim())
    ) {
      this.source = [""];
      for (let k = rows.length - 1; k >= 1; k--) rows[k].remove();
      const first = rows[0];
      if (first) {
        first.classList.remove("is-rendered");
        first.classList.add("is-active");
        delete (first.dataset as any).src;
        delete (first.dataset as any).activeSrc;
        first.textContent = "";
      }
      this.cursorRow = 0;
      this.setCaretCol(0);
    }
    this.updateEmpty();
  }

  private getCurrentCaretRow(): number {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return this.cursorRow;
    let node: Node | null = sel.anchorNode;
    while (node && node !== this.el) {
      if (
        node instanceof HTMLElement &&
        node.classList.contains("muse-lp-line")
      ) {
        const idx = this.lineEls().indexOf(node);
        if (idx >= 0) return idx;
      }
      node = node.parentNode;
    }
    return this.cursorRow;
  }

  private getCaretCol(): number {
    const row = this.lineEls()[this.cursorRow];
    if (!row) return 0;
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return 0;
    const range = sel.getRangeAt(0);
    if (!row.contains(range.endContainer)) return 0;
    const pre = range.cloneRange();
    pre.selectNodeContents(row);
    pre.setEnd(range.endContainer, range.endOffset);
    return pre.toString().length;
  }

  /** 读取光标（折叠选区）在「指定行」textContent 中的字符偏移（点击跨行时用）。 */
  private getCaretColInRow(row: HTMLElement): number {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return 0;
    const range = sel.getRangeAt(0);
    if (!row.contains(range.endContainer)) return 0;
    const pre = range.cloneRange();
    pre.selectNodeContents(row);
    pre.setEnd(range.endContainer, range.endOffset);
    return pre.toString().length;
  }

  /** 把光标放到光标行内「第 col 个字符」处。兼容行内样式 span（走 TreeWalker）。 */
  private setCaretCol(col: number): void {
    const row = this.lineEls()[this.cursorRow];
    if (!row) return;
    const total = (row.textContent ?? "").length;
    const c = Math.max(0, Math.min(col, total));
    const sel = window.getSelection();
    if (!sel) return;
    const walker = document.createTreeWalker(
      row,
      NodeFilter.SHOW_TEXT,
      null
    );
    let remaining = c;
    let node: Node | null;
    let lastText: Text | null = null;
    let placed = false;
    while ((node = walker.nextNode())) {
      const t = node as Text;
      const len = t.textContent?.length ?? 0;
      if (remaining <= len) {
        const range = document.createRange();
        range.setStart(t, remaining);
        range.collapse(true);
        sel.removeAllRanges();
        sel.addRange(range);
        placed = true;
        break;
      }
      remaining -= len;
      lastText = t;
    }
    if (!placed) {
      const range = document.createRange();
      if (lastText) range.setStart(lastText, lastText.textContent?.length ?? 0);
      else {
        range.selectNodeContents(row);
        range.collapse(false);
      }
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
    }
    this.el.focus();
  }

  private updateEmpty(): void {
    const empty = this.getValue().trim().length === 0;
    this.el.toggleClass("is-empty", empty);
  }

  /** 统一渲染：光标行做「源码 + 样式」，其余行做完整 markdown 渲染。
   *  围栏代码块（``` / ~~~）跨多行，逐行渲染会把上下两个围栏各自变成带复制按钮的
   *  空代码块。因此检测代码块区间：光标在块外时整段渲染为单个代码块（内侧行隐藏）；
   *  光标在块内时整段以源码 / 字面文本显示，便于编辑且不出现复制按钮。 */
  private renderLines(): void {
    const rows = this.lineEls();
    const cur = Math.max(0, Math.min(this.cursorRow, rows.length - 1));
    const spans = this.getFenceSpans(this.source);
    const spanOf: number[] = this.source.map(() => -1);
    spans.forEach((sp) => {
      for (let i = sp.start; i <= sp.end; i++) spanOf[i] = spans.indexOf(sp);
    });
    const cursorInSpan = spanOf[cur] >= 0;

    // 保住当前滚动位置：跨行渲染会拆除/重建 MarkdownRenderer 组件，内容瞬时塌陷会让
    // 浏览器把 scrollTop 钳到 0，表现为"换行时光标/视图跳到最前面"。先记下，渲染后还原。
    const prevScroll = this.el.scrollTop;
    // 存在代码块时结构依赖光标相对块的位置，每次都整段重建更稳妥；否则沿用轻量预判。
    const forceFull = spans.length > 0;
    let needRender = false;
    if (!forceFull) {
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const src = this.source[i] ?? "";
        // 全选源码模式：任何「渲染态」行都要切回活跃态（源码 + 样式）。
        if (this.allSource && row.classList.contains("is-rendered")) {
          needRender = true;
          break;
        }
        if (i === cur) {
          if (row.classList.contains("is-rendered")) needRender = true;
          else if ((row.dataset as any).activeSrc !== src) needRender = true;
        } else if (
          !row.classList.contains("is-rendered") ||
          (row.dataset as any).src !== src
        ) {
          needRender = true;
        }
        if (needRender) break;
      }
    }
    if (forceFull || needRender) {
      this.component.unload();
      this.component = new Component();
      this.component.load();
    }
    let i = 0;
    while (i < rows.length) {
      const row = rows[i];
      const src = this.source[i] ?? "";
      if (spanOf[i] >= 0) {
        const sp = spans[spanOf[i]];
        if (cursorInSpan) {
          // 光标在块内：整段以源码 / 字面文本显示，避免逐行渲染出空代码块与复制按钮。
          for (let k = sp.start; k <= sp.end; k++) {
            const r = rows[k];
            const s = this.source[k] ?? "";
            if (k === cur) {
              this.clearCodeFlags(r);
              r.classList.remove("is-rendered");
              r.classList.add("is-active", "is-code-line");
              if ((r.dataset as any).activeSrc !== s) {
                r.textContent = s;
                (r.dataset as any).activeSrc = s;
              }
            } else {
              this.renderLiteralLine(r, s);
            }
          }
          i = sp.end + 1;
          continue;
        }
        // 光标在块外：整段渲染为单个代码块，内侧行隐藏。
        const joined = this.source.slice(sp.start, sp.end + 1).join("\n");
        this.renderCodeBlock(rows[sp.start], joined);
        for (let k = sp.start + 1; k <= sp.end; k++) {
          const r = rows[k];
          r.classList.remove("is-rendered", "is-active", "is-code-block", "is-code-line");
          r.classList.add("is-code-hidden");
          (r.dataset as any).codeHidden = "1";
          (r.dataset as any).src = this.source[k] ?? "";
          r.innerHTML = "";
        }
        i = sp.end + 1;
        continue;
      }
      // 全选源码模式：所有行都按「源码 + 样式」渲染（显示 markdown 语法并保留排版样式）。
      if (this.allSource || i === cur) this.renderActiveLine(row, src);
      else this.renderInactiveLine(row, src);
      i++;
    }
    this.updateEmpty();
    // 还原滚动位置（同步），并对异步渲染的行再兜底一次（下一帧），彻底杜绝跳顶。
    this.el.scrollTop = prevScroll;
    requestAnimationFrame(() => {
      // 仅当滚动被钳到比之前更靠前（塌陷）时才还原；若浏览器已把光标滚入视野（更靠后），
      // 则保留，避免把光标行又藏回折叠区。
      if (this.el.scrollTop < prevScroll) this.el.scrollTop = prevScroll;
    });
  }

  /** 检测 source 中的围栏代码块区间（``` 或 ~~~ 起，到同字符围栏止；未闭合则延到末尾）。 */
  private getFenceSpans(src: string[]): { start: number; end: number }[] {
    const spans: { start: number; end: number }[] = [];
    let i = 0;
    while (i < src.length) {
      const open = src[i].match(/^(```|~~~)/);
      if (open) {
        const marker = open[1][0];
        const closing = new RegExp("^" + marker + "+\\s*$");
        let end = -1;
        for (let j = i + 1; j < src.length; j++) {
          if (closing.test(src[j])) {
            end = j;
            break;
          }
        }
        if (end === -1) end = src.length - 1;
        spans.push({ start: i, end });
        i = end + 1;
      } else {
        i++;
      }
    }
    return spans;
  }

  private clearCodeFlags(row: HTMLElement): void {
    row.classList.remove("is-code-block", "is-code-hidden", "is-code-line");
    delete (row.dataset as any).codeBlock;
    delete (row.dataset as any).codeHidden;
  }

  /** 把整段围栏代码块渲染为单个代码块（MarkdownRenderer 产出完整 <pre><code>）。 */
  private renderCodeBlock(row: HTMLElement, joinedSrc: string): void {
    this.clearCodeFlags(row);
    row.classList.add("is-code-block");
    (row.dataset as any).codeBlock = "start";
    (row.dataset as any).src = joinedSrc;
    row.innerHTML = "";
    MarkdownRenderer.render(this.app, joinedSrc, row, this.sourcePath, this.component);
  }

  /** 代码块内的非激活行：以字面文本显示（保留 ``` 围栏与代码内容，不触发独立代码块/复制按钮）。 */
  private renderLiteralLine(row: HTMLElement, src: string): void {
    this.clearCodeFlags(row);
    row.classList.add("is-code-line");
    delete (row.dataset as any).activeSrc;
    if ((row.dataset as any).src === src && row.textContent === src) return;
    row.textContent = src;
    (row.dataset as any).src = src;
  }

  /** 非光标行：用 Obsidian 自带 MarkdownRenderer 完整渲染富文本。 */
  private renderInactiveLine(row: HTMLElement, src: string): void {
    this.clearCodeFlags(row);
    row.classList.remove("is-active");
    HEADING_CLASSES.concat(["lp-quote", "lp-bullet", "lp-ordered"]).forEach(
      (c) => row.classList.remove(c)
    );
    delete (row.dataset as any).activeSrc;
    if (row.classList.contains("is-rendered") && row.dataset.src === src)
      return;
    row.innerHTML = "";
    row.classList.add("is-rendered");
    row.dataset.src = src;
    MarkdownRenderer.render(
      this.app,
      src,
      row,
      this.sourcePath,
      this.component
    );
  }

  /**
   * 光标行：仍显示源码（含 markdown 标记），但叠加排版样式。
   * 例如 `# 标题` 用 .lp-h1 放大、加粗用 span 高亮——文本字符不变，
   * 因而光标偏移映射完全不受影响。
   */
  private renderActiveLine(row: HTMLElement, src: string): void {
    this.clearCodeFlags(row);
    if (row.classList.contains("is-rendered")) {
      row.classList.remove("is-rendered");
      delete (row.dataset as any).src;
      row.textContent = src;
    }
    row.classList.add("is-active");
    const blockCls = this.blockClass(src);
    HEADING_CLASSES.concat(["lp-quote", "lp-bullet", "lp-ordered"]).forEach(
      (c) => row.classList.remove(c)
    );
    if (blockCls) row.classList.add(blockCls);

    // 标题行：用真正的 <h1>~<h6> 元素渲染（与「非光标行」MarkdownRenderer 产出的 <hN>
    // 完全一致），光标进出标题行时高度严格相等、不闪烁；# 标记单独包一层彩色。
    if (blockCls && blockCls.startsWith("lp-h")) {
      if ((row.dataset as any).activeSrc === src) return;
      const offset = this.getCaretCol();
      row.innerHTML = this.highlightHeading(src);
      (row.dataset as any).activeSrc = src;
      this.setCaretCol(offset);
    } else if (this.inlineToken(src)) {
      if ((row.dataset as any).activeSrc === src) return;
      const offset = this.getCaretCol();
      row.innerHTML = this.highlightInline(src);
      (row.dataset as any).activeSrc = src;
      this.setCaretCol(offset);
    } else if ((row.dataset as any).activeSrc !== src) {
      // DOM 已被 syncFromDom 反映为 src（cur/is-active 行 source = row.textContent），
      // 无需 textContent=src 重写——重写会创建新文本节点、破坏 selection，导致
      // 「编辑已发布内容多按 backspace 再输入识别不出来」（光标被反复打回行首，
      // 后续 Backspace 删错位、输入插错位）。
      (row.dataset as any).activeSrc = src;
    }
  }

  private scheduleRender(): void {
    if (this.renderScheduled) return;
    this.renderScheduled = true;
    requestAnimationFrame(() => {
      this.renderScheduled = false;
      if (!this.composing) this.renderLines();
    });
  }

  /* --------------------- 源码高亮（光标行用） --------------------- */

  private blockClass(src: string): string {
    const m = src.match(/^(#{1,6})\s/);
    if (m) return "lp-h" + m[1].length;
    if (/^>\s?/.test(src)) return "lp-quote";
    if (/^[-*+]\s/.test(src)) return "lp-bullet";
    if (/^\d+\.\s/.test(src)) return "lp-ordered";
    return "";
  }

  private inlineToken(src: string): boolean {
    return /(\*\*|__|\*|_|~~|`|\[[^\]]+\]\([^)]+\))/.test(src);
  }

  private highlightInline(src: string): string {
    let s = escapeHtml(src);
    s = s.replace(/`([^`]+)`/g, '<code class="lp-code">`$1`</code>');
    s = s.replace(/\*\*([^*]+?)\*\*/g, '<strong class="lp-strong">**$1**</strong>');
    s = s.replace(/__([^_]+?)__/g, '<strong class="lp-strong">__$1__</strong>');
    s = s.replace(/(^|[^*])\*([^*\n]+?)\*(?!\*)/g, '$1<em class="lp-em">*$2*</em>');
    s = s.replace(/(^|[^_])_([^_\n]+?)_(?!_)/g, '$1<em class="lp-em">_$2_</em>');
    s = s.replace(/~~([^~]+?)~~/g, '<del class="lp-del">~~$1~~</del>');
    s = s.replace(
      /\[([^\]]+)\]\(([^)]+)\)/g,
      '<span class="lp-link">[$1]($2)</span>'
    );
    return s;
  }

  /**
   * 标题行高亮：用真正的 <h1>~<h6> 元素包住文本（与「非光标行」MarkdownRenderer
   * 产出的 <hN> 完全一致），光标进出标题行时行高严格相等、不闪烁。行首 # 标记单独
   * 包成 .lp-hash（彩色、缩小、右移），文本部分仍走 highlightInline 支持标题内行内标记。
   */
  private highlightHeading(src: string): string {
    const m = src.match(/^(#{1,6})(\s?)([\s\S]*)$/);
    if (!m) return escapeHtml(src);
    const level = m[1].length;
    const inner = this.highlightInline(m[2] + m[3]);
    return `<h${level} class="muse-lp-heading"><span class="lp-hash">${escapeHtml(
      m[1]
    )}</span>${inner}</h${level}>`;
  }

  private onInput(): void {
    this.syncFromDom();
    if (this.composing) {
      // 输入法合成期间不重排编辑器（会打断中文输入），但仍要实时刷新链接
      // 建议浮层——否则中文必须等按空格提交后才会检索、且浮层不跟随光标。
      this.updateSuggest();
      return;
    }
    this.scheduleRender();
    this.updateSuggest();
    this.changeCb?.();
  }

  /** 多行粘贴：按纯文本插入并按换行拆成多行，避免 contenteditable 自作主张产生错位 DOM。 */
  private onPaste(e: ClipboardEvent): void {
    e.preventDefault();
    const text = e.clipboardData?.getData("text/plain") ?? "";
    if (!text) return;
    // 粘贴前确保退出「全选源码模式」并让 source 与 DOM 严格同步：否则会基于删除后
    // 未同步的旧 source 计算 before/after，rebuildDom 再把旧行重建出来 → 残留旧内容。
    if (this.allSource) this.allSource = false;
    this.syncFromDom();
    const row = this.cursorRow;
    const col = this.getCaretCol();
    const cur = this.source[row] ?? "";
    const before = cur.slice(0, col);
    const after = cur.slice(col);
    const pasted = text.split("\n");
    const newLines: string[] = [];
    newLines.push(before + pasted[0]);
    for (let k = 1; k < pasted.length; k++) newLines.push(pasted[k]);
    const lastIdx = newLines.length - 1;
    newLines[lastIdx] = newLines[lastIdx] + after;
    this.source.splice(row, 1, ...newLines);
    this.cursorRow = row + pasted.length - 1;
    this.rebuildDom();
    this.renderLines();
    this.setCaretCol((newLines[lastIdx] ?? "").length - after.length);
    this.changeCb?.();
  }

  private onKeydown(e: KeyboardEvent): void {
    // 内部链接建议激活时优先拦截方向键 / 回车 / Tab / Esc。
    // 必须 stopPropagation，否则 keydown 会冒泡到视图 contentEl 的发布监听导致误发。
    if (this.suggest?.active && this.handleSuggestKey(e)) {
      e.stopPropagation();
      return;
    }
    // 全选源码模式 或 存在非折叠选区（跨字符/跨行选中）：
    // 受控的「行合并/拆分」与「发送」逻辑都不适用——交给浏览器默认编辑行为
    // （删除选中范围 / 在选中处换行），随后 onInput→syncFromDom 会完整重建 source。
    // 否则【全选后按 Backspace】会误命中行合并：用全选前的旧 source 合并一行且
    // preventDefault，浏览器不删除选中内容 → 表现为「删不掉」（长内容全选后光标
    // 常落在中间行，更易触发此拦截）。有选区时 Enter 也不应发送，而应替换选区。
    const sel0 = window.getSelection();
    if (
      (this.allSource || (sel0 && !sel0.isCollapsed)) &&
      (e.key === "Backspace" || e.key === "Delete" || e.key === "Enter")
    ) {
      this.allSource = false;
      return;
    }
    this.keyCb?.(e);
    if (e.defaultPrevented) return;
    if (e.isComposing || e.keyCode === 229) return;
    // Ctrl/Cmd+A：进入「全选源码模式」——所有行显示 markdown 源码并保留排版样式，再整体选中。
    // 避免依赖浏览器默认全选触发的 selectionchange 把光标跳到最头、且首次按不全选的问题。
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
      e.preventDefault();
      if (!this.allSource) {
        this.allSource = true;
        this.renderLines();
      }
      const sel = window.getSelection();
      if (sel) {
        const range = document.createRange();
        range.selectNodeContents(this.el);
        sel.removeAllRanges();
        sel.addRange(range);
      }
      return;
    }
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      // 标记本次为方向键跨行导航，selectionchange 时用「源码列」还原，而非 X 坐标
      // （渲染态折叠光标取不到可靠 rect，X 还原会退化为错位偏移）。
      this.navArrow = true;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      this.splitLineAtCaret();
    } else if (e.key === "Backspace") {
      if (this.getCaretCol() === 0 && this.cursorRow > 0) {
        e.preventDefault();
        this.mergeWithPrev();
      }
    } else if (e.key === "Delete") {
      const len = (this.source[this.cursorRow] ?? "").length;
      if (this.getCaretCol() === len && this.cursorRow < this.source.length - 1) {
        e.preventDefault();
        this.mergeWithNext();
      }
    }
  }

  private continuePrefix(before: string): string {
    const lines = before.split("\n");
    const last = lines[lines.length - 1];
    let m = last.match(/^(\s*(?:[-*+]|\d+\.)\s+)/);
    if (m) return m[1];
    m = last.match(/^(\s*>+\s?)/);
    if (m) return m[1];
    return "";
  }

  private splitLineAtCaret(): void {
    const row = this.cursorRow;
    const col = this.getCaretCol();
    const text = this.source[row] ?? "";
    const before = text.slice(0, col);
    const after = text.slice(col);
    const cont = this.continuePrefix(before);
    this.source[row] = before;
    this.source.splice(row + 1, 0, cont + after);
    const curEl = this.lineEls()[row];
    if (curEl) curEl.textContent = before;
    const newEl = this.el.createDiv({ cls: "muse-lp-line" });
    newEl.textContent = cont + after;
    if (curEl && curEl.nextSibling)
      this.el.insertBefore(newEl, curEl.nextSibling);
    else this.el.appendChild(newEl);
    this.cursorRow = row + 1;
    this.renderLines();
    this.setCaretCol(cont.length);
    this.changeCb?.();
  }

  private mergeWithPrev(): void {
    const row = this.cursorRow;
    const prevLen = (this.source[row - 1] ?? "").length;
    this.source[row - 1] =
      (this.source[row - 1] ?? "") + (this.source[row] ?? "");
    this.source.splice(row, 1);
    const rows = this.lineEls();
    const curEl = rows[row];
    const prevEl = rows[row - 1];
    if (prevEl) prevEl.textContent = this.source[row - 1];
    if (curEl) curEl.remove();
    this.cursorRow = row - 1;
    this.renderLines();
    this.setCaretCol(prevLen);
    this.changeCb?.();
  }

  private mergeWithNext(): void {
    const row = this.cursorRow;
    const curLen = (this.source[row] ?? "").length;
    this.source[row] =
      (this.source[row] ?? "") + (this.source[row + 1] ?? "");
    this.source.splice(row + 1, 1);
    const rows = this.lineEls();
    const curEl = rows[row];
    const nextEl = rows[row + 1];
    if (curEl) curEl.textContent = this.source[row];
    if (nextEl) nextEl.remove();
    this.renderLines();
    this.setCaretCol(curLen);
    this.changeCb?.();
  }

  private onSelectionChange = (): void => {
    if (this.composing) return;
    // 扩展选区（全选、拖拽选行）：不重设 cursorRow、不重渲染，避免跳动与错位；
    // 全选模式下保持 allSource 源码显示，拖拽时保持当前活跃态不变。
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) return;
    const nav = this.navArrow;
    this.navArrow = false;
    const newRow = this.getCurrentCaretRow();
    if (this.allSource) {
      // 全选源码模式下，选区重新折叠（点击/方向键）→ 退出全选模式，回到单栏 Live Preview。
      this.allSource = false;
      this.cursorRow = newRow;
      this.renderLines();
      this.lastCol = this.getCaretCol();
      return;
    }
    if (newRow === this.cursorRow) {
      this.lastCol = this.getCaretCol();
      return;
    }
    if (nav) {
      // 方向键上下导航：直接保留「源码列」（lastCol 是旧活跃行的源码列），
      // 落到新行同列。避免渲染行 markdown 被吞（标题 # 被吞）导致列错位跑到 # 前。
      this.cursorRow = newRow;
      this.renderLines();
      this.setCaretCol(this.lastCol);
      this.lastCol = this.getCaretCol();
      return;
    }
    // 鼠标点击跨行：用「字符偏移」精确还原，避免 viewport X + 标记宽度补偿
    // 在 DOM 重建后立即执行带来的脆弱与闪烁（标题行 # 标记还带空格，X 补偿
    // 漏算空格宽会先落到错误列再跳正）。
    // 点击瞬间光标仍在旧「渲染态」行（# 等标记被 MarkdownRenderer 吞掉、
    // 不计入 textContent）。在该行读出光标的可见字符偏移 visOff，再补回被
    // 吞掉的标记字符数（srcLen - visLen），即得精确源码列，setCaretCol 一步到位。
    const oldRowEl = this.lineEls()[newRow];
    const visOff = oldRowEl ? this.getCaretColInRow(oldRowEl) : 0;
    const visLen = oldRowEl ? (oldRowEl.textContent ?? "").length : 0;
    const srcLen = (this.source[newRow] ?? "").length;
    const srcOff = Math.max(0, Math.min(visOff + (srcLen - visLen), srcLen));
    this.cursorRow = newRow;
    this.renderLines();
    this.setCaretCol(srcOff);
    this.lastCol = srcOff;
  };

  /** 读取当前光标（折叠选区）的 viewport 水平坐标；取不到返回 -1。 */
  private getCaretX(): number {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return -1;
    const range = sel.getRangeAt(0);
    let rect = range.getBoundingClientRect();
    if (rect.height === 0 && rect.width === 0) {
      const rects = range.getClientRects();
      if (rects.length) rect = rects[0];
    }
    if (rect.height === 0 && rect.width === 0) {
      // 折叠选区可能取不到 rect：退而构造一个宽度为 1 字符的 range 再取左侧坐标。
      const node = range.endContainer;
      const off = range.endOffset;
      if (node.nodeType === Node.TEXT_NODE) {
        const len = (node.textContent ?? "").length;
        const s = Math.max(0, off - 1);
        const e = Math.min(off, len);
        if (e > s) {
          const r2 = document.createRange();
          try {
            r2.setStart(node, s);
            r2.setEnd(node, e);
            const rr = r2.getBoundingClientRect();
            if (rr.height > 0 || rr.width > 0) rect = rr;
          } catch {
            /* ignore */
          }
        }
      }
    }
    if (rect.height === 0 && rect.width === 0) return -1;
    return rect.left;
  }

  /** 把光标放到光标行内「与给定 viewport X 最接近」的字符处，从而还原跨行前的横向列位。 */
  private setCaretAtX(x: number): void {
    const row = this.lineEls()[this.cursorRow];
    if (!row) return;
    const sel = window.getSelection();
    if (!sel) return;
    // 补偿活跃行行首的 markdown 标记宽度（如标题的 "# "）。渲染态行这些标记被吞、
    // 不占宽度，因此点击 X 是「正文坐标系」；活跃行把标记加回左侧会让同 X 对应的
    // 字符左偏约标记宽度。把 X 右移标记总宽度，使其在活跃行正文坐标系对齐。
    let markerW = 0;
    row.querySelectorAll(".lp-hash").forEach((m) => {
      markerW += (m as HTMLElement).getBoundingClientRect().width;
    });
    const targetX = x + markerW;
    const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT, null);
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const t = node as Text;
      const len = t.textContent?.length ?? 0;
      if (len === 0) continue;
      const nodeRect = this.rangeRect(t, 0, len);
      if (!nodeRect) continue;
      if (targetX <= nodeRect.left) {
        this.placeCaret(t, 0);
        return;
      }
      if (targetX >= nodeRect.right) continue;
      // X 落在当前文本节点内：逐字符求中点，取离 targetX 最近的偏移。
      let best = 0;
      let bestDist = Infinity;
      for (let o = 0; o <= len; o++) {
        const r = this.rangeRect(t, o, Math.min(o + 1, len));
        if (!r) continue;
        const cx = (r.left + r.right) / 2;
        const dist = Math.abs(cx - targetX);
        if (dist < bestDist) {
          bestDist = dist;
          best = o;
        }
      }
      this.placeCaret(t, best);
      return;
    }
    // 兜底：放到行尾。
    const range = document.createRange();
    range.selectNodeContents(row);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
    this.el.focus();
  }

  private rangeRect(node: Text, start: number, end: number): DOMRect | null {
    const r = document.createRange();
    try {
      r.setStart(node, start);
      r.setEnd(node, end);
      return r.getBoundingClientRect();
    } catch {
      return null;
    }
  }

  private placeCaret(node: Text, offset: number): void {
    const sel = window.getSelection();
    if (!sel) return;
    const range = document.createRange();
    range.setStart(node, offset);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
    this.el.focus();
  }

  /**
   * 拦截复制：原生 copy 读的是「渲染后 DOM 文本」，非光标行 markdown 语法已被吞
   *（如 `## 标题` 渲染成 `<h2>标题</h2>`，复制出来丢掉 `## `）。
   * 这里按选区重建「源码」文本——整行被选中的行直接用 `dataset.src`/受控 source，
   * 局部选中的活跃行按源码切片（渲染文本==源码），局部选中的渲染行退回渲染文本切片。
   */
  private onCopy = (e: ClipboardEvent): void => {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;
    const text = this.getSelectionSource();
    if (text == null) return;
    e.preventDefault();
    e.clipboardData?.setData("text/plain", text);
  };

  /** 把当前选区还原成 markdown 源码文本（按行拼接）。 */
  private getSelectionSource(): string | null {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return null;
    const range = sel.getRangeAt(0);
    const rows = this.lineEls();
    if (rows.length === 0) return null;
    const startRow = this.rowOfNode(range.startContainer, rows);
    const endRow = this.rowOfNode(range.endContainer, rows);
    if (startRow < 0 || endRow < 0) return null;
    const parts: string[] = [];
    for (let i = startRow; i <= endRow; i++) {
      const row = rows[i];
      const rendered = (row.textContent ?? "").replace(/\n$/, "");
      const isRendered = row.classList.contains("is-rendered");
      const src = isRendered
        ? ((row.dataset as any).src ?? this.source[i] ?? "")
        : (this.source[i] ?? "");
      let aLine: number;
      let bLine: number;
      if (i === startRow && i === endRow) {
        aLine = this.clampOffset(row, range.startContainer, range.startOffset, rendered.length);
        bLine = this.clampOffset(row, range.endContainer, range.endOffset, rendered.length);
      } else if (i === startRow) {
        aLine = this.clampOffset(row, range.startContainer, range.startOffset, rendered.length);
        bLine = rendered.length;
      } else if (i === endRow) {
        aLine = 0;
        bLine = this.clampOffset(row, range.endContainer, range.endOffset, rendered.length);
      } else {
        aLine = 0;
        bLine = rendered.length;
      }
      const a = Math.min(aLine, bLine);
      const b = Math.max(aLine, bLine);
      const full = a <= 0 && b >= rendered.length;
      if (full) parts.push(src);
      else if (!isRendered) parts.push(src.slice(a, b));
      else parts.push(rendered.slice(a, b));
    }
    return parts.join("\n");
  }

  private rowOfNode(node: Node, rows: HTMLElement[]): number {
    let n: Node | null = node;
    while (n && n !== this.el) {
      if (n instanceof HTMLElement && n.classList.contains("muse-lp-line")) {
        return rows.indexOf(n);
      }
      n = n.parentNode;
    }
    return -1;
  }

  /** 计算 container/offset 在 row「渲染文本」中的字符偏移；落在 row 之外则夹紧到 0/max。 */
  private clampOffset(
    row: HTMLElement,
    container: Node,
    offset: number,
    max: number
  ): number {
    if (!row.contains(container)) {
      const pre = document.createRange();
      pre.selectNodeContents(row);
      let cmp = 1;
      try {
        cmp = pre.comparePoint(container, offset);
      } catch {
        cmp = 1;
      }
      return cmp < 0 ? 0 : max;
    }
    const pre = document.createRange();
    pre.selectNodeContents(row);
    pre.setEnd(container, offset);
    return Math.max(0, Math.min(pre.toString().length, max));
  }

  /* ----------------------- 内部链接建议（[[ 自动补全） ----------------------- */

  /** 构建浮层容器（挂在编辑器父节点上，用 fixed 定位，避免被 contenteditable 影响）。 */
  private buildSuggestEl(): void {
    // 挂到 body 而非父容器：浮层用 position: fixed + 视口坐标定位，挂在带
    // transform 的祖先下会被当成相对该祖先定位而错位。body 下始终相对视口。
    this.suggestEl = document.body.createDiv({ cls: "muse-suggest" });
    this.suggestEl.style.display = "none";
    // mousedown 阻止默认：点选项时不抢编辑框焦点（否则 blur 会先关掉建议）
    this.suggestEl.addEventListener("mousedown", (e) => e.preventDefault());
  }

  /** 输入后检测光标行内是否处于未闭合的 [[ 触发态，刷新/隐藏建议。
   *  合成（IME）期间也会调用：中文输入时 [[ 后的候选要随拼音实时刷新。 */
  private updateSuggest(): void {
    const activeText = this.source[this.cursorRow] ?? "";
    const col = this.getCaretCol();
    const before = activeText.slice(0, col);
    const m = before.match(/\[\[([^\[\]\n]*)$/);
    if (!m) {
      if (this.suggest?.active) this.hideSuggest();
      return;
    }
    const start = m.index + 2;
    const query = m[1];
    if (!this.cachedFiles.length) this.refreshFiles();
    let items: string[];
    if (!query) {
      items = this.cachedFiles.slice(0, 50);
    } else {
      // 子串包含（大小写不敏感）优先，对中文笔记名最直观；fuzzy 作为英文/子序列补充。
      const q = query.toLowerCase();
      const fuzzy = prepareFuzzySearch(query);
      items = this.cachedFiles
        .map((f) => {
          const idx = f.toLowerCase().indexOf(q);
          const fr = fuzzy(f);
          return { f, idx, fr };
        })
        .filter((x) => x.idx >= 0 || x.fr)
        .sort((a, b) => {
          const aInc = a.idx >= 0;
          const bInc = b.idx >= 0;
          if (aInc !== bInc) return aInc ? -1 : 1;
          if (aInc && bInc) return a.idx - b.idx;
          if (a.fr && b.fr) return a.fr.score - b.fr.score;
          return 0;
        })
        .slice(0, 50)
        .map((x) => x.f);
    }
    if (items.length === 0) {
      if (this.suggest?.active) this.hideSuggest();
      return;
    }
    if (!this.suggest?.active) {
      this.suggest = { active: true, start, query, items, index: 0 };
    } else {
      this.suggest.start = start;
      this.suggest.query = query;
      this.suggest.items = items;
      this.suggest.index = Math.min(this.suggest.index, items.length - 1);
    }
    this.renderSuggest();
  }

  /** 渲染建议列表并定位到光标下方。 */
  private renderSuggest(): void {
    if (!this.suggest) return;
    const host = this.suggestEl;
    host.empty();
    this.suggest.items.forEach((name, i) => {
      const item = host.createDiv({
        cls:
          "muse-suggest-item" +
          (i === this.suggest!.index ? " is-active" : ""),
      });
      item.createSpan({ text: name });
      item.addEventListener("click", () => this.applySuggest(name));
    });
    const rowEl = this.lineEls()[this.cursorRow];
    const caretX = this.getCaretX();
    const rect = rowEl?.getBoundingClientRect();
    const left = caretX >= 0 ? caretX : (rect?.left ?? 0);
    const top = rect ? rect.bottom : 0;
    host.style.left = `${left}px`;
    host.style.top = `${top + 4}px`;
    host.style.display = "block";
    const active = host.querySelector(
      ".muse-suggest-item.is-active"
    ) as HTMLElement | null;
    if (active) active.scrollIntoView({ block: "nearest" });
  }

  /** 选择某项：把 [[query 替换为 [[name]]，光标落在 ]] 之后。 */
  private applySuggest(name: string): void {
    if (!this.suggest) return;
    const row = this.suggest.start;
    const col = this.getCaretCol();
    this.replaceRange(row, col, name + "]]");
    this.hideSuggest();
  }

  /** 隐藏建议浮层并清空状态。 */
  private hideSuggest(): void {
    this.suggest = null;
    if (this.suggestEl) this.suggestEl.style.display = "none";
  }

  /** 重新读取 vault 内全部 Markdown 笔记的 basename（去重），供搜索复用。 */
  private refreshFiles(): void {
    const set = new Set<string>();
    for (const f of this.app.vault.getMarkdownFiles()) set.add(f.basename);
    this.cachedFiles = Array.from(set);
  }

  /** 建议激活时处理导航键，返回 true 表示已消费该事件。 */
  private handleSuggestKey(e: KeyboardEvent): boolean {
    if (!this.suggest) return false;
    // 输入法合成中（isComposing）的 Enter/Tab 是「确认候选」语义，绝不能劫持去
    // 插入链接，否则中文还没上屏就被吞。交给输入法处理，合成结束后的回车才走这里。
    if (e.isComposing) return false;
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        this.suggest.index =
          (this.suggest.index + 1) % this.suggest.items.length;
        this.renderSuggest();
        return true;
      case "ArrowUp":
        e.preventDefault();
        this.suggest.index =
          (this.suggest.index - 1 + this.suggest.items.length) %
          this.suggest.items.length;
        this.renderSuggest();
        return true;
      case "Enter":
      case "Tab":
        // 浮层激活时回车永远消费：有匹配则插入链接，无匹配则仅关闭浮层，
        // 绝不穿透到发布逻辑（contentEl 的 Enter→submitMemo）。
        e.preventDefault();
        if (this.suggest.items.length) {
          this.applySuggest(this.suggest.items[this.suggest.index]);
        } else {
          this.hideSuggest();
        }
        return true;
      case "Escape":
        e.preventDefault();
        this.hideSuggest();
        return true;
      default:
        return false;
    }
  }
}
