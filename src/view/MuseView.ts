import {
  ItemView,
  WorkspaceLeaf,
  Modal,
  setIcon,
  Notice,
  Menu,
  MarkdownRenderer,
  Component,
} from "obsidian";
import type MuseViewPlugin from "../main";
import {
  VIEW_TYPE_MUSE,
  SYSTEM_TAGS,
  type Memo,
  type MemoFilter,
  type FilterPreset,
  type MemoImage,
} from "../types";
import { extractMemoImages, stripInlineTags } from "../parser";
import { openShareImage } from "../shareImage";
import {
  TextareaEditor,
  LivePreviewEditor,
  type MuseEditor,
} from "../editor/MuseEditor";

type FilterMode = "all" | "pinned" | "starred";

/** 主视图：左侧栏（stats/搜索/热力图/每日目标/导航/标签）+ 右侧输入卡 + 按日期分组卡片流。 */
export class MuseView extends ItemView {
  private plugin: MuseViewPlugin;
  private filter: MemoFilter = {
    tag: null,
    year: null,
    date: null,
    keyword: "",
    preset: "all",
  };
  private unsubscribe: (() => void) | null = null;
  private childComponent = new Component();
  private overviewMode: "heatmap" | "calendar" = "heatmap";
  private overviewModeOverridden = false;
  private calViewMonth: Date = new Date();
  private editingMemo: Memo | null = null;
  private editBannerEl: HTMLElement | null = null;
  private editDateTimeEl: HTMLInputElement | null = null;
  private inputEl!: HTMLElement;
  private editor!: MuseEditor;
  private searchEl!: HTMLInputElement;
  private sidebarEl!: HTMLElement;
  private statsEl!: HTMLElement;
  private overviewWrapper!: HTMLElement;
  // 热力图统计头部（最近一年贡献/最长连续/最近连续/共 N 条 + 图例）：
  // 固定在列表滚动容器之外，向上滚动时始终可见、不随内容一起滚走。
  private metaHeatmapHeadEl!: HTMLElement;
  private listEl!: HTMLElement;
  private pageLimit = 50;
  private loadingMore = false;
  private onListScroll = (): void => {
    const el = this.listEl;
    if (!el) return;
    // 接近底部（阈值 60px）且仍有更多条目时，自动加载下一页。
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 60) {
      const filtered = this.getFilteredMemos();
      if (this.pageLimit < filtered.length) this.loadMore();
    }
  };
  private heatmapTooltipEl: HTMLElement | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: MuseViewPlugin) {
    super(leaf);
    this.plugin = plugin;
    this.overviewMode = this.plugin.settings.defaultOverviewMode || "heatmap";
  }

  getViewType(): string {
    return VIEW_TYPE_MUSE;
  }

  /** 从设置页调用：切换概览模式并立即重渲染侧栏，避免改完参数不生效。 */
  public setOverviewMode(mode: "heatmap" | "calendar"): void {
    this.overviewMode = mode;
    this.overviewModeOverridden = false;
    this.renderSidebar();
  }

  /**
   * 设置项变化后立即生效的兜底刷新：
   * - 重新拉设置里的侧栏、列表、密度、占位符等所有与配置相关的可视部分。
   * - 不重新打开文件 / 重新加载数据，所以开销很低，仅做 DOM 重建。
   * - 任何 settings.onChange 在 saveSettings() 之后调用本方法，即可做到"改完即生效"。
   */
  public refresh(): void {
    if (!this.overviewModeOverridden)
      this.overviewMode = this.plugin.settings.defaultOverviewMode || "heatmap";
    this.renderSidebar();
    this.renderList();
    this.updateEditBanner();
    this.applyDensity();
  }
  getDisplayText(): string {
    return this.plugin.t("view.title");
  }
  getIcon(): string {
    return "feather";
  }

  async onOpen(): Promise<void> {
    this.contentEl.addClass("muse-root");
    this.contentEl.addClass("muse-container");
    this.buildLayout();
    this.unsubscribe = this.plugin.store.onChange(() => this.renderAll());
    this.registerDomEvent(this.contentEl, "keydown", (e: KeyboardEvent) => {
      const s = document.activeElement;
      if (
        s instanceof HTMLElement &&
        this.contentEl.contains(s) &&
        this.shouldSendOnKeydown(e)
      ) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        this.submitMemo();
      }
    });
    this.childComponent.load();
    // 窗口尺寸变化（如启动后从非最大化切到最大化）后，重新评估卡片折叠状态，
    // 避免「窄栏误折叠、变宽后展开按钮不消失」。registerDomEvent 会在视图关闭时自动解绑。
    this.registerDomEvent(window, "resize", this.handleResize);
    try {
      await this.plugin.store.reloadAll();
    } catch (err) {
      console.error("[MuseView] reloadAll failed:", err);
    }
    const draft = this.loadDraft();
    if (draft) this.editor.setValue(draft);
    this.autoResizeInput();
    this.syncInputCardContentState();
    this.renderAll();
  }

  async onClose(): Promise<void> {
    if (this.unsubscribe) this.unsubscribe();
    this.unsubscribe = null;
    this.hideHeatmapTooltip();
    this.childComponent.unload();
  }

  /** 供命令/设置页调用：刷新密度样式。 */
  applyDensity(): void {
    if (this.listEl) {
      this.listEl.toggleClass(
        "is-compact",
        this.plugin.settings.density === "compact"
      );
    }
  }

  /** 供命令调用：聚焦输入框。 */
  focusInput(): void {
    this.inputEl?.focus();
  }

  /* ----------------------------- 布局骨架 ----------------------------- */

  private buildLayout(): void {
    this.contentEl.empty();
    const shell = this.contentEl.createDiv({ cls: "muse-shell" });
    this.sidebarEl = shell.createDiv({ cls: "muse-sidebar" });
    shell
      .createDiv({ cls: "muse-sidebar-overlay" })
      .addEventListener("click", () => this.toggleSidebar(false));

    this.statsEl = this.sidebarEl.createDiv({ cls: "muse-stats" });

    const searchContainer = this.sidebarEl.createDiv({
      cls: "muse-sidebar-search",
    });
    const searchWrap = searchContainer.createDiv({ cls: "muse-search-wrap" });
    const searchIcon = searchWrap.createDiv({ cls: "muse-search-icon" });
    setIcon(searchIcon, "search");
    this.searchEl = searchWrap.createEl("input", {
      cls: "muse-search",
      attr: { placeholder: this.plugin.t("search.placeholder"), type: "text" },
    });
    const debouncedSearch = debounce(() => {
      this.filter.keyword = this.searchEl.value.trim();
      this.pageLimit = this.getInitialPageLimit();
      this.renderList();
    }, 180);
    this.searchEl.addEventListener("input", debouncedSearch);

    this.overviewWrapper = this.sidebarEl.createDiv({
      cls: "muse-overview-wrapper",
    });

    const main = shell.createDiv({ cls: "muse-main" });
    this.buildInputCard(main);
    // 统计头部固定在滚动容器之外（输入卡与列表之间）：不随列表滚动消失。
    // 下方网格由 renderMetaHeatmapGrid 渲染到 listEl 内，跟随滚动。
    this.metaHeatmapHeadEl = main.createDiv({
      cls: "muse-list-heatmap-head muse-list-heatmap-head-fixed",
    });
    this.listEl = main.createDiv({ cls: "muse-list" });
    // 无限滚动：列表滚动到底部自动加载更多（与「加载更多」按钮共用 loadMore）。
    this.registerDomEvent(this.listEl, "scroll", this.onListScroll);
  }

  private buildInputCard(host: HTMLElement): void {
    const card = host.createDiv({ cls: "muse-input-card" });
    if (this.plugin.settings.livePreview) {
      this.editor = new LivePreviewEditor(card, this.app, "");
    } else {
      const ta = card.createEl("textarea", {
        cls: "muse-input",
        attr: {
          placeholder: this.plugin.t("input.placeholder"),
          rows: "1",
        },
      });
      this.editor = new TextareaEditor(ta);
    }
    this.inputEl = this.editor.el;
    this.editor.setOnFocus(() => card.addClass("is-focused"));
    this.editor.setOnBlur(() => card.removeClass("is-focused"));
    this.editor.setOnKeydown((e) => this.handleEditorKeydown(e));
    this.editor.setOnChange(() => this.handleEditorChange());
    // 初始化占位符：LivePreviewEditor 不走 textarea 的 placeholder 属性，
    // 必须显式 setPlaceholder 写入 data-placeholder，否则 ::before 取不到内容、占位符不显示。
    // （textarea 分支此处为冗余但无害的设置。）
    this.editor.setPlaceholder(this.plugin.t("input.placeholder"));

    const toolbar = card.createDiv({ cls: "muse-input-toolbar" });
    const tools = toolbar.createDiv({ cls: "muse-input-tools" });
    const mkTool = (icon: string, label: string, onClick: () => void) => {
      const b = tools.createEl("button", {
        cls: "muse-tool-btn",
        attr: { "aria-label": label },
      });
      setIcon(b, icon);
      // 关键：mousedown 时阻止默认行为，避免点击按钮瞬间编辑框失去焦点/光标。
      // 否则 blur 会触发卡片塌陷（未聚焦态 40px 高）、工具栏淡出、且 LivePreview
      // 选区丢失导致 insertAtCursor 插入位置错乱（表现为"点击后输入框显示不正常"）。
      b.addEventListener("mousedown", (e) => e.preventDefault());
      b.addEventListener("click", onClick);
    };
    mkTool("hash", this.plugin.t("toolbar.insertTag"), () =>
      this.insertAtCursor("#")
    );
    mkTool("image", this.plugin.t("toolbar.insertImage"), () =>
      this.pickImageFromDisk()
    );
    mkTool("list", this.plugin.t("toolbar.insertUL"), () =>
      this.insertListAtCursor("- ")
    );
    mkTool("list-ordered", this.plugin.t("toolbar.insertOL"), () =>
      this.insertOrderedListAtCursor()
    );
    mkTool("square-check", this.plugin.t("toolbar.insertTask"), () =>
      this.insertListAtCursor("- [ ] ")
    );
    mkTool("table", this.plugin.t("toolbar.insertTable"), () =>
      this.showTablePicker()
    );

    const submitWrap = toolbar.createDiv({ cls: "muse-submit-wrap" });
    this.editDateTimeEl = submitWrap.createEl("input", {
      cls: "muse-edit-datetime muse-hidden",
      type: "datetime-local",
      attr: { step: "60", title: this.plugin.t("input.editTimeTitle") },
    });
    const cancelBtn = submitWrap.createEl("button", {
      cls: "muse-cancel-btn muse-hidden",
      text: this.plugin.t("input.cancel"),
    });
    cancelBtn.addEventListener("click", () => this.exitEditMode());
    this.editBannerEl = cancelBtn;
    const submitBtn = submitWrap.createEl("button", {
      cls: "muse-submit-btn",
    });
    submitBtn.setText(this.plugin.t("input.submit"));
    submitBtn.addEventListener("click", () => this.submitMemo());
  }

  /* ----------------------------- 输入框辅助 ----------------------------- */

  private handleEditorKeydown(e: KeyboardEvent): void {
    if (this.shouldSendOnKeydown(e)) {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      this.submitMemo();
      return;
    }
    if (!(e.isComposing || e.keyCode === 229)) {
      if (e.key === "Escape" && this.editingMemo) {
        e.preventDefault();
        this.exitEditMode();
      }
    }
  }

  private handleEditorChange(): void {
    if (!this.editingMemo) this.saveDraft(this.editor.getValue());
    this.autoResizeInput();
    this.syncInputCardContentState();
  }

  private insertAtCursor(text: string): void {
    const s = this.editor.getCaret();
    const n = this.editor.getCaretEnd();
    const active = this.editor.getActiveText();
    if (s !== n) {
      const sel = active.slice(s, n);
      this.editor.replaceRange(s, n, text + sel);
    } else {
      this.editor.replaceRange(s, n, text);
    }
    this.editor.focus();
    this.autoResizeInput();
    if (!this.editingMemo) this.saveDraft(this.editor.getValue());
    this.syncInputCardContentState();
  }

  private insertListAtCursor(prefix: string): void {
    const s = this.editor.getCaret();
    const n = this.editor.getCaretEnd();
    const active = this.editor.getActiveText();
    if (s !== n) {
      const sel = active
        .slice(s, n)
        .split("\n")
        .map((l) => `${prefix}${l}`)
        .join("\n");
      const before = active.slice(0, s);
      const pad = s === 0 || before.endsWith("\n") ? sel : `\n${sel}`;
      this.editor.replaceRange(s, n, pad);
      this.editor.focus();
      this.autoResizeInput();
      if (!this.editingMemo) this.saveDraft(this.editor.getValue());
      return;
    }
    const i = s;
    const before = active.slice(0, i);
    const atLineStart = i === 0 || before.endsWith("\n");
    this.insertAtCursor(atLineStart ? prefix : `\n${prefix}`);
  }

  private insertOrderedListAtCursor(): void {
    const s = this.editor.getCaret();
    const n = this.editor.getCaretEnd();
    const active = this.editor.getActiveText();
    if (s !== n) {
      const sel = active
        .slice(s, n)
        .split("\n")
        .map((l, idx) => `${idx + 1}. ${l}`)
        .join("\n");
      const before = active.slice(0, s);
      const pad = s === 0 || before.endsWith("\n") ? sel : `\n${sel}`;
      this.editor.replaceRange(s, n, pad);
      this.editor.focus();
      this.autoResizeInput();
      if (!this.editingMemo) this.saveDraft(this.editor.getValue());
      return;
    }
    const i = s;
    const before = active.slice(0, i);
    const atLineStart = i === 0 || before.endsWith("\n");
    const lines = (atLineStart ? before.replace(/\n$/, "") : before).split("\n");
    let next = 1;
    for (let g = lines.length - 1; g >= 0; g--) {
      const m = lines[g].match(/^(\d+)\.\s/);
      if (!m) break;
      next = parseInt(m[1], 10) + 1;
      break;
    }
    this.insertAtCursor(atLineStart ? `${next}. ` : `\n${next}. `);
  }

  private async pickImageFromDisk(): Promise<void> {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.addEventListener("change", async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const path = await this.plugin.store.saveImageAttachment(
          file,
          file.name.split(".").pop()
        );
        this.insertAtCursor(`![[${path}]]`);
      } catch (err) {
        new Notice(this.plugin.t("notice.error") + (err as Error).message);
      }
    });
    input.click();
  }

  private autoResizeInput(): void {
    this.editor?.autoResize();
  }

  private syncInputCardContentState(): void {
    const card = this.inputEl.closest(".muse-input-card");
    if (!card) return;
    card.toggleClass("has-content", this.editor.getValue().length > 0);
  }

  private shouldSendOnKeydown(e: KeyboardEvent): boolean {
    if (e.key !== "Enter") return false;
    const mod = e.ctrlKey || e.metaKey;
    const shift = e.shiftKey;
    if (this.plugin.settings.sendHotkey === "enter") {
      return !(mod || shift || e.isComposing || e.keyCode === 229);
    }
    return !!(mod && !shift);
  }

  /* ----------------------------- 提交 / 编辑 ----------------------------- */

  private async submitMemo(): Promise<void> {
    const text = this.editor.getValue().trim();
    if (!text) return;
    try {
      if (this.editingMemo) {
        const dtVal = this.editDateTimeEl?.value ?? "";
        const orig = `${this.editingMemo.date}T${this.editingMemo.time}`;
        if (dtVal && dtVal !== orig) {
          const d = new Date(dtVal);
          if (isNaN(d.getTime())) {
            new Notice(this.plugin.t("notice.invalidTime"));
            return;
          }
          await this.plugin.store.editMemoDateTime(
            this.editingMemo,
            d,
            text
          );
        } else {
          await this.plugin.store.editMemo(this.editingMemo, text);
        }
        this.exitEditMode();
      } else {
        const withTag = this.appendActiveTagIfMissing(text);
        await this.plugin.store.addMemo(withTag);
      }
      if (this.plugin.settings.clearAfterSave) {
        this.editor.setValue("");
        this.clearDraft();
        this.editor.el.blur();
      }
      this.autoResizeInput();
      this.syncInputCardContentState();
    } catch (err) {
      console.error(err);
      new Notice(
        this.plugin.t("notice.saveFailed", { msg: (err as Error).message })
      );
    }
  }

  private appendActiveTagIfMissing(text: string): string {
    const tag = this.filter.tag;
    if (!tag) return text;
    const used = new Set<string>();
    const re = /#([A-Za-z0-9_\u4e00-\u9fff/]+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) used.add(m[1]);
    if (used.has(tag)) return text;
    for (const u of used) if (u.startsWith(tag + "/")) return text;
    const pad = text.endsWith("\n") ? "" : "\n";
    return `${text}${pad}#${tag}`;
  }

  private draftKey(): string {
    try {
      return `muse-draft:${this.app.vault.getName()}`;
    } catch {
      return "muse-draft";
    }
  }
  private saveDraft(text: string): void {
    try {
      const k = this.draftKey();
      if (text.trim() === "") window.localStorage.removeItem(k);
      else if (text.length <= 512 * 1024)
        window.localStorage.setItem(k, text);
    } catch {
      /* ignore */
    }
  }
  private loadDraft(): string {
    try {
      return window.localStorage.getItem(this.draftKey()) ?? "";
    } catch {
      return "";
    }
  }
  private clearDraft(): void {
    try {
      window.localStorage.removeItem(this.draftKey());
    } catch {
      /* ignore */
    }
  }

  private toggleSidebar(open: boolean): void {
    this.contentEl.toggleClass("muse-sidebar-open", open);
  }

  private memoKey(memo: Memo): string {
    return `${memo.file.path}#${memo.range[0]}`;
  }

  /** 编辑态高亮：仅当前 editingMemo 对应的卡片加 is-editing（列表不会因进入/退出编辑而重绘，
   *  故在此手动切换；memo 为 null 时清除全部）。 */
  private setEditingCardHighlight(memo: Memo | null): void {
    this.contentEl.findAll(".muse-card").forEach((c) => {
      const el = c as HTMLElement;
      const match = memo != null && el.getAttribute("data-memo-key") === this.memoKey(memo);
      el.toggleClass("is-editing", match);
    });
  }

  private enterEditMode(memo: Memo): void {
    // 仅在「正在撰写新 memo 草稿」时暂存草稿；编辑已有 memo 时不要把它内容写进草稿，
    // 否则连续编辑两张卡再取消后，输入框会残留上一张卡的内容且无法回到草稿态。
    if (!this.editingMemo && this.editor.getValue().trim()) {
      this.saveDraft(this.editor.getValue());
    }
    this.editingMemo = memo;
    this.setEditingCardHighlight(memo);
    this.editor.setValue(memo.content);
    if (this.editDateTimeEl)
      this.editDateTimeEl.value = `${memo.date}T${memo.time}`;
    this.editor.focus();
    this.updateEditBanner();
    this.autoResizeInput();
    this.syncInputCardContentState();
  }

  private exitEditMode(): void {
    this.editingMemo = null;
    this.setEditingCardHighlight(null);
    this.editor.setValue(this.loadDraft());
    if (this.editDateTimeEl) this.editDateTimeEl.value = "";
    this.updateEditBanner();
    this.autoResizeInput();
    this.syncInputCardContentState();
  }

  private updateEditBanner(): void {
    if (!this.editBannerEl) return;
    const card = this.inputEl.closest(".muse-input-card");
    if (this.editingMemo) {
      this.editBannerEl.removeClass("muse-hidden");
      this.editDateTimeEl?.removeClass("muse-hidden");
      card?.addClass("is-editing");
      this.editor.setPlaceholder(
        this.plugin.t("input.editPlaceholder", {
          date: this.editingMemo.date,
          time: this.editingMemo.time,
        })
      );
    } else {
      this.editBannerEl.addClass("muse-hidden");
      this.editDateTimeEl?.addClass("muse-hidden");
      card?.removeClass("is-editing");
      if (this.filter.tag)
        this.editor.setPlaceholder(this.plugin.t("input.placeholderWithTag", { tag: this.filter.tag }));
      else this.editor.setPlaceholder(this.plugin.t("input.placeholder"));
    }
  }

  /* ----------------------------- 渲染总控 ----------------------------- */

  getInitialPageLimit(): number {
    return Math.max(10, this.plugin.settings.pageSize || 50);
  }

  private renderAll(): void {
    if (!this.overviewModeOverridden)
      this.overviewMode = this.plugin.settings.defaultOverviewMode || "heatmap";
    this.renderSidebar();
    this.renderList();
    // 同步输入框占位符：切换标签筛选（filter.tag）后，占位符应在
    // 「记录此刻的想法…」与「将归入 #tag」之间切换。updateEditBanner 已按
    // editingMemo / filter.tag 计算正确文案，此处统一兜底刷新（editBannerEl
    // 在 buildInputCard 已创建，调用安全）。
    this.updateEditBanner();
  }

  renderSidebar(): void {
    const stats = this.sidebarEl.querySelector(".muse-stats");
    if (stats) stats.empty();
    const overview = this.sidebarEl.querySelector(".muse-overview-wrapper");
    if (overview) overview.empty();
    this.sidebarEl
      .querySelectorAll(
        ".muse-sidebar-section, .muse-nav-item, .muse-daily-goal-row, .muse-tag-node, .muse-tag-cloud"
      )
      .forEach((el) => el.remove());

    const all = this.plugin.store.getAll();
    const tagSet = new Set<string>();
    const daySet = new Set<string>();
    let nImg = 0,
      nLink = 0,
      nPin = 0,
      nStar = 0,
      nTodo = 0,
      nNoTag = 0;
    const today = dateKey(new Date());
    const monthDay = today.slice(5);
    const weekStart = startOfWeek();
    let todayCount = 0;
    for (const v of all) {
      for (const tg of v.tags) if (!SYSTEM_TAGS.includes(tg)) tagSet.add(tg);
      daySet.add(v.date);
      if (v.hasImage) nImg++;
      if (v.hasLink) nLink++;
      if (v.isPinned) nPin++;
      if (v.isStarred) nStar++;
      if (v.hasOpenTask) nTodo++;
      if (v.tags.filter((t) => !SYSTEM_TAGS.includes(t)).length === 0) nNoTag++;
      if (v.date === today) todayCount++;
      if (v.datetime.getTime() >= weekStart) {
        /* counted by week below via preset */
      }
    }

    if (this.statsEl) {
      this.renderStatItem(this.statsEl, String(all.length), this.plugin.t("stats.memos"));
      this.renderStatItem(this.statsEl, String(tagSet.size), this.plugin.t("stats.tags"));
      this.renderStatItem(this.statsEl, String(daySet.size), this.plugin.t("stats.days"));
    }
    this.renderOverview(this.overviewWrapper, all);
    this.renderDailyGoal(this.sidebarEl, all, today, todayCount);

    this.sidebarEl.createDiv({
      cls: "muse-sidebar-section",
      text: this.plugin.t("sidebar.section.views"),
    });
    const views: Array<{
      key: FilterPreset;
      icon: string;
      text: string;
      count: number;
    }> = [
      { key: "all", icon: "layout-grid", text: this.plugin.t("sidebar.all"), count: all.length },
      { key: "pinned", icon: "pin", text: this.plugin.t("sidebar.pinned"), count: nPin },
      { key: "starred", icon: "star", text: this.plugin.t("sidebar.starred"), count: nStar },
      { key: "today", icon: "calendar", text: this.plugin.t("sidebar.today"), count: todayCount },
      { key: "week", icon: "calendar-days", text: this.plugin.t("sidebar.week"), count: this.weekCount(all, weekStart) },
      { key: "todo", icon: "check-square", text: this.plugin.t("sidebar.todo"), count: nTodo },
      { key: "on-this-day", icon: "history", text: this.plugin.t("sidebar.review"), count: this.onThisDayCount(all, monthDay, today) },
    ];
    for (const v of views) this.renderNavItem(v.key, v.icon, v.text, v.count);

    this.sidebarEl.createDiv({
      cls: "muse-sidebar-section",
      text: this.plugin.t("sidebar.section.search"),
    });
    this.renderNavItem("no-tag", "tag", this.plugin.t("sidebar.noTag"), nNoTag);
    this.renderNavItem("with-image", "image", this.plugin.t("sidebar.withImage"), nImg);
    this.renderNavItem("with-link", "link", this.plugin.t("sidebar.withLink"), nLink);

    const years = new Map<string, number>();
    for (const v of all) {
      const y = v.date.substring(0, 4);
      years.set(y, (years.get(y) ?? 0) + 1);
    }
    if (years.size) {
      this.sidebarEl.createDiv({
        cls: "muse-sidebar-section",
        text: this.plugin.t("sidebar.section.years"),
      });
      const sorted = [...years.entries()].sort((a, b) =>
        a[0] < b[0] ? 1 : -1
      );
      for (const [y, c] of sorted) {
        const item = this.sidebarEl.createDiv({
          cls:
            "muse-nav-item" +
            (this.filter.year === y ? " active" : ""),
        });
        const icon = item.createDiv({ cls: "muse-nav-icon" });
        setIcon(icon, "calendar");
        item.createSpan({ cls: "muse-nav-text", text: y });
        item.createSpan({ cls: "muse-nav-count", text: String(c) });
        item.addEventListener("click", () => {
          this.filter.year = this.filter.year === y ? null : y;
          this.filter.preset = "all";
          this.pageLimit = this.getInitialPageLimit();
          this.renderAll();
        });
      }
    }

    if (this.plugin.settings.sidebarTagsMode !== "off") {
      const tagCounts = new Map<string, number>();
      for (const v of all)
        for (const tg of v.tags)
          if (!SYSTEM_TAGS.includes(tg))
            tagCounts.set(tg, (tagCounts.get(tg) ?? 0) + 1);
      if (tagCounts.size) {
        // 标签区常开（不再折叠），去掉左侧箭头与点击切换逻辑。
        this.sidebarEl.createDiv({
          cls: "muse-sidebar-section",
          text: `${this.plugin.t("sidebar.section.tags")} (${tagCounts.size})`,
        });
        if (this.plugin.settings.sidebarTagsMode === "cloud") {
          this.renderTagCloud(this.sidebarEl, tagCounts);
        } else {
          const tree = this.buildTagTree(tagCounts);
          this.renderTagTree(this.sidebarEl, tree, 0);
        }
      }
    }
  }

  private weekCount(all: Memo[], weekStart: number): number {
    return all.filter((m) => m.datetime.getTime() >= weekStart).length;
  }
  private onThisDayCount(all: Memo[], monthDay: string, today: string): number {
    return all.filter(
      (m) => m.date.slice(5) === monthDay && m.date !== today
    ).length;
  }

  private renderStatItem(host: HTMLElement, num: string, label: string): void {
    const item = host.createDiv({ cls: "muse-stat" });
    item.createDiv({ cls: "muse-stat-num", text: num });
    item.createDiv({ cls: "muse-stat-label", text: label });
  }

  private renderNavItem(
    key: FilterPreset | string,
    icon: string,
    text: string,
    count?: number
  ): void {
    const active =
      this.filter.preset === key && !this.filter.tag && !this.filter.year;
    const item = this.sidebarEl.createDiv({
      cls: "muse-nav-item" + (active ? " active" : ""),
    });
    const ic = item.createDiv({ cls: "muse-nav-icon" });
    setIcon(ic, icon);
    item.createSpan({ cls: "muse-nav-text", text });
    if (count !== undefined)
      item.createSpan({ cls: "muse-nav-count", text: String(count) });
    item.addEventListener("click", () => {
      this.filter.preset = key as FilterPreset;
      this.filter.tag = null;
      this.filter.year = null;
      this.filter.date = null;
      if (key === "random") {
        this.filter.randomSeed = Date.now();
        this.filter.randomCount = 5;
      }
      this.pageLimit = this.getInitialPageLimit();
      this.renderAll();
    });
  }

  /* ----------------------------- 概览（热力图） ----------------------------- */

  private renderOverview(host: HTMLElement, memos: Memo[]): void {
    host.empty();
    const overview = host.createDiv({ cls: "muse-overview" });
    const content = overview.createDiv({ cls: "muse-overview-content" });
    // 概览模式由「侧栏默认视图」设置项决定（heatmap / calendar），无切换按钮。
    if (this.overviewMode === "calendar") this.renderCalendar(content, memos);
    else this.renderHeatmap(content, memos);
  }

  private renderCalendar(host: HTMLElement, memos: Memo[]): void {
    const counts = new Map<string, number>();
    for (const m of memos) counts.set(m.date, (counts.get(m.date) ?? 0) + 1);
    const todayKey = dateKey(new Date());

    const nav = host.createDiv({ cls: "muse-cal-nav" });
    const prev = nav.createDiv({ cls: "muse-cal-nav-btn" });
    setIcon(prev, "chevron-left");
    const title = nav.createDiv({ cls: "muse-cal-title" });
    const next = nav.createDiv({ cls: "muse-cal-nav-btn" });
    setIcon(next, "chevron-right");

    const grid = host.createDiv({ cls: "muse-cal-grid" });
    const dows = ["日", "一", "二", "三", "四", "五", "六"];

    const draw = () => {
      const y = this.calViewMonth.getFullYear();
      const mo = this.calViewMonth.getMonth();
      title.setText(`${y}年${mo + 1}月`);
      grid.empty();
      for (const w of dows)
        grid.createDiv({ cls: "muse-cal-dow", text: w });
      const first = new Date(y, mo, 1);
      const startDow = first.getDay();
      const days = new Date(y, mo + 1, 0).getDate();
      for (let i = 0; i < startDow; i++)
        grid.createDiv({ cls: "muse-cal-cell empty" });
      for (let d = 1; d <= days; d++) {
        const key = dateKey(new Date(y, mo, d));
        const cnt = counts.get(key) ?? 0;
        const cell = grid.createDiv({
          cls:
            "muse-cal-cell" +
            (cnt > 0 ? " has" : "") +
            (key === todayKey ? " today" : ""),
        });
        cell.createSpan({ cls: "muse-cal-day", text: String(d) });
        if (cnt > 0) {
          cell.addClass(`level-${cnt < 2 ? 1 : cnt < 4 ? 2 : cnt < 7 ? 3 : 4}`);
          cell.setAttr("title", `${key}  ${this.plugin.t("list.totalCount", { n: cnt })}`);
          cell.style.cursor = "pointer";
          cell.addEventListener("click", () => {
            this.filter.date = key;
            this.filter.preset = "all";
            this.pageLimit = this.getInitialPageLimit();
            this.renderList();
          });
        }
      }
      // 高度恒定：网格永远补到 6 行（42 格），避免 5 行 / 6 行月之间跳动。
      // 末尾空白格无边框、不可见，仅占位维持高度。
      const trailing = Math.max(0, 42 - startDow - days);
      for (let i = 0; i < trailing; i++)
        grid.createDiv({ cls: "muse-cal-cell empty" });
    };

    draw();
    prev.addEventListener("click", () => {
      this.calViewMonth = new Date(
        this.calViewMonth.getFullYear(),
        this.calViewMonth.getMonth() - 1,
        1
      );
      draw();
    });
    next.addEventListener("click", () => {
      this.calViewMonth = new Date(
        this.calViewMonth.getFullYear(),
        this.calViewMonth.getMonth() + 1,
        1
      );
      draw();
    });
  }

  private renderHeatmap(host: HTMLElement, memos: Memo[]): void {
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    const dow = now.getDay();
    const start = new Date(now);
    start.setDate(now.getDate() - dow);
    const begin = new Date(start);
    begin.setDate(start.getDate() - 13 * 7);
    const counts = new Map<string, number>();
    for (const m of memos) counts.set(m.date, (counts.get(m.date) ?? 0) + 1);
    const grid = host.createDiv({ cls: "muse-heatmap" });
    for (let col = 0; col < 14; col++) {
      const c = grid.createDiv({ cls: "muse-heatmap-col" });
      for (let row = 0; row < 7; row++) {
        const d = new Date(begin);
        d.setDate(begin.getDate() + col * 7 + row);
        const key = dateKey(d);
        const cnt = counts.get(key) ?? 0;
        const level = cnt === 0 ? 0 : cnt < 2 ? 1 : cnt < 4 ? 2 : cnt < 7 ? 3 : 4;
        const cell = c.createDiv({
          cls: `muse-heatmap-cell level-${level}`,
        });
        if (d > now) cell.addClass("future");
        if (cnt > 0) {
          cell.addEventListener("mouseenter", () =>
            this.showHeatmapTooltip(cell, key, memos.filter((m) => m.date === key))
          );
          cell.addEventListener("mouseleave", () => this.hideHeatmapTooltip());
          cell.addEventListener("click", () => {
            this.filter.date = key;
            this.filter.preset = "all";
            this.renderList();
          });
          cell.style.cursor = "pointer";
        } else {
          cell.setAttr("title", `${key}  ${this.plugin.t("list.totalCount", { n: cnt })}`);
        }
      }
    }
  }

  /**
   * 主区域热力图 —— 统计头部（固定在滚动容器之外，不随列表滚动消失）。
   * 承载：最近一年贡献 / 最长连续 / 最近连续 / 共 N 条 + 少/多图例 + 筛选操作按钮。
   * 数据来源：`memos`（调用方传入 `filtered`，即当前筛选结果）—— 与「共 N 条」同源，
   * 筛选激活时整块联动（3 个数 / 网格 / 计数一致）；默认（全部）时 filtered == 全部，
   * 表现等价于全局活跃度。
   */
  private renderMetaHeatmapHead(
    host: HTMLElement,
    memos: Memo[],
    totalLabel: string,
    actions?: { reroll?: boolean; back?: boolean }
  ): void {
    host.empty();
    if (!memos.length) {
      host.addClass("is-empty");
      return;
    }
    host.removeClass("is-empty");

    const now = new Date();
    now.setHours(0, 0, 0, 0);
    const cols = 52;
    const dow = now.getDay(); // 0=周日 .. 6=周六
    // 最后一列 = 本周（周日→周六），today 落在其中；
    // 首列 = 51 周前的周日。begin 对齐到周日，保证每列都是完整日历周，
    // 且「最近一周」干净地落在最后一列（不会出现跨列拆分 / 末列溢出到下周）。
    const lastSunday = new Date(now);
    lastSunday.setDate(now.getDate() - dow);
    const begin = new Date(lastSunday);
    begin.setDate(lastSunday.getDate() - (cols - 1) * 7);

    const dateSet = new Set<string>();
    for (const m of memos) dateSet.add(m.date);

    // 统计：最近一年贡献总数（窗口 [begin, now] 内）
    let totalYear = 0;
    for (const m of memos) {
      const t = m.datetime.getTime();
      if (t >= begin.getTime() && t <= now.getTime() + 86400000) totalYear++;
    }
    const longest = this.calcLongestStreak(dateSet, begin, now);
    const current = this.calcCurrentStreak(dateSet, now);

    // ---------- 左侧分组：最长连续 / 最近连续 / 最近一年贡献 ----------
    // 用 space-between 让该分组贴左、「共 N 条」贴右；图例已移除不显示。
    const leftWrap = host.createDiv({
      cls: "muse-list-heatmap-stats muse-list-heatmap-stats-right",
    });
    const renderStat = (key: string, n: number) => {
      const html = this.plugin
        .t(key, { n })
        .replace("<b>", '<b class="muse-list-heatmap-stat-num">');
      const span = leftWrap.createSpan({ cls: "muse-list-heatmap-stat" });
      span.innerHTML = html;
    };
    renderStat("meta.heatmapTotalYear", totalYear);
    renderStat("meta.heatmapLongest", longest);
    renderStat("meta.heatmapCurrent", current);

    // 随机 / 历史上的今天 筛选时的操作按钮（同一行，紧挨左侧分组之后）。
    if (actions?.reroll) {
      const reroll = leftWrap.createEl("button", { cls: "muse-meta-btn" });
      setIcon(reroll.createSpan(), "shuffle");
      reroll.createSpan({ text: this.plugin.t("meta.reroll") });
      reroll.addEventListener("click", () => {
        this.filter.randomSeed = Date.now();
        this.renderList();
      });
    }
    if (actions?.back) {
      const back = leftWrap.createEl("button", { cls: "muse-meta-btn" });
      setIcon(back.createSpan(), "history");
      back.createSpan({ text: this.plugin.t("meta.backToOnThisDay") });
      back.addEventListener("click", () => {
        this.filter.preset = "on-this-day";
        this.renderList();
      });
    }

    // ---------- 共 N 条：最右侧（当前筛选结果数，随筛选实时变化） ----------
    const countSpan = host.createSpan({ cls: "muse-list-heatmap-count" });
    countSpan.setText("📊 " + totalLabel);
  }

  /**
   * 主区域热力图 —— 网格（52 列 × 7 行绿系），作为列表滚动容器的首个子元素渲染，
   * 因此向上滚动时网格会随卡片一起滚走（统计头部已固定在上方、不滚动）。
   */
  private renderMetaHeatmapGrid(host: HTMLElement, memos: Memo[]): void {
    if (!memos.length) return;

    const now = new Date();
    now.setHours(0, 0, 0, 0);
    const cols = 52;
    const dow = now.getDay(); // 0=周日 .. 6=周六
    const lastSunday = new Date(now);
    lastSunday.setDate(now.getDate() - dow);
    const begin = new Date(lastSunday);
    begin.setDate(lastSunday.getDate() - (cols - 1) * 7);

    const counts = new Map<string, number>();
    for (const m of memos) counts.set(m.date, (counts.get(m.date) ?? 0) + 1);
    const todayKey = dateKey(now);

    const grid = host.createDiv({ cls: "muse-heatmap muse-list-heatmap" });
    for (let col = 0; col < cols; col++) {
      const c = grid.createDiv({ cls: "muse-heatmap-col" });
      for (let row = 0; row < 7; row++) {
        const d = new Date(begin);
        d.setDate(begin.getDate() + col * 7 + row);
        const key = dateKey(d);
        const cnt = counts.get(key) ?? 0;
        const level = cnt === 0 ? 0 : cnt < 2 ? 1 : cnt < 4 ? 2 : cnt < 7 ? 3 : 4;
        const cell = c.createDiv({
          cls: `muse-heatmap-cell muse-list-heatmap-cell level-${level}`,
        });
        if (d > now) cell.addClass("future");
        if (key === todayKey) cell.addClass("today");
        if (cnt > 0) {
          cell.addEventListener("mouseenter", () =>
            this.showHeatmapTooltip(cell, key, memos.filter((m) => m.date === key))
          );
          cell.addEventListener("mouseleave", () => this.hideHeatmapTooltip());
          cell.style.cursor = "pointer";
        } else {
          cell.setAttr("title", `${key}  ${this.plugin.t("list.totalCount", { n: cnt })}`);
        }
        cell.addEventListener("click", () => {
          this.filter.date = key;
          this.filter.preset = "all";
          this.filter.tag = null;
          this.filter.year = null;
          this.filter.keyword = "";
          this.pageLimit = this.getInitialPageLimit();
          this.renderAll();
        });
      }
    }
  }

  /** 在 [begin, end] 窗口内（含两端）求最长连续贡献天数。 */
  private calcLongestStreak(
    dateSet: Set<string>,
    begin: Date,
    end: Date
  ): number {
    let best = 0,
      cur = 0;
    const d = new Date(begin);
    while (d.getTime() <= end.getTime() + 86400000) {
      if (dateSet.has(dateKey(d))) {
        cur++;
        if (cur > best) best = cur;
      } else {
        cur = 0;
      }
      d.setDate(d.getDate() + 1);
    }
    return best;
  }

  /** 从 today 往前推连续贡献天数（含 today，若今日无贡献则不计入）。 */
  private calcCurrentStreak(dateSet: Set<string>, today: Date): number {
    let n = 0;
    const d = new Date(today);
    while (dateSet.has(dateKey(d))) {
      n++;
      d.setDate(d.getDate() - 1);
    }
    return n;
  }

  private showHeatmapTooltip(
    anchor: HTMLElement,
    date: string,
    memos: Memo[]
  ): void {
    this.hideHeatmapTooltip();
    const tip = document.body.createDiv({ cls: "muse-heatmap-tooltip" });
    const head = tip.createDiv({ cls: "muse-heatmap-tooltip-head" });
    head.createSpan({ text: date });
    head.createSpan({
      cls: "muse-heatmap-tooltip-count",
      text: this.plugin.t("list.totalCount", { n: memos.length }),
    });
    for (const m of memos.slice(0, 2)) {
      const row = tip.createDiv({ cls: "muse-heatmap-tooltip-row" });
      row.createSpan({ cls: "muse-heatmap-tooltip-time", text: m.time });
      const txt = m.content
        .replace(/!\[[^\]]*\]\([^)]+\)/g, this.plugin.t("list.imageHolder"))
        .replace(/!\[\[[^\]]+\]\]/g, this.plugin.t("list.imageHolder"))
        .replace(/#[^\s#]+/g, "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 50);
      row.createSpan({
        cls: "muse-heatmap-tooltip-text",
        text: txt || this.plugin.t("list.noText"),
      });
    }
    if (memos.length > 2)
      tip.createDiv({
        cls: "muse-heatmap-tooltip-more",
        text: this.plugin.t("list.heatmapMore", { n: memos.length - 2 }),
      });
    const r = anchor.getBoundingClientRect();
    tip.style.position = "fixed";
    tip.style.left = `${Math.min(r.right + 8, window.innerWidth - 280)}px`;
    tip.style.top = `${Math.max(8, r.top - 4)}px`;
    tip.style.zIndex = "1000";
    this.heatmapTooltipEl = tip;
  }

  private hideHeatmapTooltip(): void {
    if (this.heatmapTooltipEl) {
      this.heatmapTooltipEl.remove();
      this.heatmapTooltipEl = null;
    }
  }

  private renderDailyGoal(
    host: HTMLElement,
    memos: Memo[],
    today: string,
    todayCount: number
  ): void {
    const goal = Math.max(1, this.plugin.settings.dailyGoal || 5);
    const pct = Math.min(100, Math.round((todayCount / goal) * 100));
    const done = todayCount >= goal;
    const desc = done
      ? this.plugin.t("list.dailyGoalExceed", {
          goal,
          done: todayCount,
          extra: todayCount - goal,
        })
      : this.plugin.t("list.dailyGoalDone", { goal, done: todayCount });
    const row = host.createDiv({
      cls: `muse-daily-goal-row${done ? " is-done" : ""}`,
    });
    const bar = row.createDiv({
      cls: "muse-daily-goal",
      attr: { "aria-label": desc },
    });
    bar.addEventListener("click", () => {
      this.filter.preset = "today";
      this.filter.tag = null;
      this.filter.date = null;
      this.pageLimit = this.getInitialPageLimit();
      this.renderAll();
    });
    const fill = bar.createDiv({ cls: "muse-daily-goal-bar" });
    fill.createDiv({ cls: "muse-daily-goal-fill" });
    (fill.firstChild as HTMLElement).style.width = `${pct}%`;
  }

  /* ----------------------------- 标签树 ----------------------------- */

  private buildTagTree(counts: Map<string, number>): TagNode {
    const root: TagNode = {
      name: "",
      full: "",
      count: 0,
      self: 0,
      children: new Map(),
    };
    for (const [tag, count] of counts) {
      const parts = tag.split("/");
      let node = root;
      let full = "";
      for (const p of parts) {
        full = full ? `${full}/${p}` : p;
        if (!node.children.has(p))
          node.children.set(p, {
            name: p,
            full,
            count: 0,
            self: 0,
            children: new Map(),
          });
        node = node.children.get(p)!;
      }
      node.self += count;
    }
    this.sumTag(root);
    return root;
  }

  private sumTag(node: TagNode): number {
    let total = node.self;
    for (const c of node.children.values()) total += this.sumTag(c);
    node.count = total;
    return total;
  }

  private renderTagTree(host: HTMLElement, node: TagNode, depth: number): void {
    const children = [...node.children.values()].sort(
      (a, b) => b.count - a.count
    );
    for (const c of children) {
      const wrapper = host.createDiv({ cls: "muse-tag-node" });
      const item = wrapper.createDiv({
        cls:
          "muse-nav-item muse-tag-item" +
          (this.filter.tag === c.full ? " active" : ""),
      });
      item.style.paddingLeft = `${12 + depth * 14}px`;
      item.createDiv({ cls: "muse-nav-icon" }).setText("#");
      item.createSpan({ cls: "muse-nav-text", text: c.name });
      item.createSpan({ cls: "muse-nav-count", text: String(c.count) });
      item.addEventListener("click", () => {
        this.filter.tag = this.filter.tag === c.full ? null : c.full;
        this.filter.preset = "all";
        this.pageLimit = this.getInitialPageLimit();
        this.renderAll();
      });
      if (c.children.size) this.renderTagTree(wrapper, c, depth + 1);
    }
  }

  /** 标签云：按出现频率缩放字号，横向流式排列；点击即筛选（含层级子标签）。 */
  private renderTagCloud(host: HTMLElement, counts: Map<string, number>): void {
    const entries = [...counts.entries()].sort(
      (a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "zh")
    );
    if (entries.length === 0) return;
    const vals = entries.map((e) => e[1]);
    const min = Math.min(...vals);
    const max = Math.max(...vals);
    const minSize = 0.78;
    const maxSize = 1.95;
    const denom =
      max === min ? 0 : Math.log(max + 1) - Math.log(min + 1) || 1;
    const cloud = host.createDiv({ cls: "muse-tag-cloud" });
    for (const [tag, count] of entries) {
      const size =
        denom === 0
          ? (minSize + maxSize) / 2
          : minSize +
            ((maxSize - minSize) * (Math.log(count + 1) - Math.log(min + 1))) /
              denom;
      const item = cloud.createDiv({
        cls:
          "muse-tag-cloud-item" +
          (this.filter.tag === tag ? " active" : ""),
      });
      item.style.fontSize = `${size.toFixed(2)}em`;
      item.createSpan({ cls: "muse-tag-cloud-hash", text: "#" });
      item.createSpan({ cls: "muse-tag-cloud-name", text: tag });
      item.setAttribute("title", `${tag} · ${count}`);
      item.addEventListener("click", () => {
        this.filter.tag = this.filter.tag === tag ? null : tag;
        this.filter.preset = "all";
        this.pageLimit = this.getInitialPageLimit();
        this.renderAll();
      });
    }
  }

  /* ----------------------------- 列表 / 卡片 ----------------------------- */

  private getFilteredMemos(): Memo[] {
    const all = this.plugin.store.getAll();
    const kw = this.filter.keyword.toLowerCase();
    let list = all.filter((m) => {
      if (this.filter.year && !m.date.startsWith(this.filter.year)) return false;
      if (this.filter.date && m.date !== this.filter.date) return false;
      if (
        this.filter.tag &&
        !m.tags.some(
          (t) => t === this.filter.tag || t.startsWith(`${this.filter.tag}/`)
        )
      )
        return false;
      if (kw) {
        const hay = `${m.content} ${m.tags.join(" ")} ${m.date}`.toLowerCase();
        if (!hay.includes(kw)) return false;
      }
      return true;
    });
    const today = dateKey(new Date());
    if (this.filter.preset === "today") list = list.filter((m) => m.date === today);
    else if (this.filter.preset === "week")
      list = list.filter((m) => m.datetime.getTime() >= startOfWeek());
    else if (this.filter.preset === "on-this-day") {
      const md = today.slice(5);
      list = list.filter((m) => m.date.slice(5) === md && m.date !== today);
    } else if (this.filter.preset === "no-tag")
      list = list.filter(
        (m) => m.tags.filter((t) => !SYSTEM_TAGS.includes(t)).length === 0
      );
    else if (this.filter.preset === "with-image")
      list = list.filter((m) => m.hasImage);
    else if (this.filter.preset === "with-link")
      list = list.filter((m) => m.hasLink);
    else if (this.filter.preset === "pinned")
      list = list.filter((m) => m.isPinned);
    else if (this.filter.preset === "starred")
      list = list.filter((m) => m.isStarred);
    else if (this.filter.preset === "todo")
      list = list.filter((m) => m.hasOpenTask);
    else if (this.filter.preset === "random" && list.length) {
      const count = this.filter.randomCount ?? 5;
      if (this.plugin.settings.enableSmartReview) {
        list = this.smartPick(list, this.filter.randomSeed ?? 1, count);
      } else {
        const seed = this.filter.randomSeed ?? 1;
        list = shuffle(list, seed).slice(0, Math.min(count, list.length));
      }
    }
    return list;
  }

  private memoId(m: Memo): string {
    return `${m.file.path}#${m.range[0]}`;
  }

  private loadLastSeen(): Record<string, number> {
    try {
      const raw = window.localStorage.getItem("muse-lastseen");
      return raw ? (JSON.parse(raw) as Record<string, number>) : {};
    } catch {
      return {};
    }
  }

  private saveLastSeen(map: Record<string, number>): void {
    try {
      window.localStorage.setItem("muse-lastseen", JSON.stringify(map));
    } catch {
      /* ignore */
    }
  }

  /** 智能回顾：加权挑选 5 条（越久没翻过越优先、与今天标签/情绪呼应加分）。 */
  private smartPick(pool: Memo[], seed: number, count = 5): Memo[] {
    const today = dateKey(new Date());
    const todayTags = new Set<string>();
    const todayMoods = new Set<string>();
    for (const m of this.plugin.store.getAll()) {
      if (m.date !== today) continue;
      for (const t of m.tags) if (!SYSTEM_TAGS.includes(t)) todayTags.add(t);
      const mood = this.detectMood(m.content);
      if (mood) todayMoods.add(mood);
    }
    const now = Date.now();
    const seen = this.loadLastSeen();
    const scored = pool.map((m) => {
      const last = seen[this.memoId(m)] ?? 0;
      const days = last ? (now - last) / 86400000 : 30;
      let score = Math.min(days, 60) / 60;
      for (const t of m.tags) if (todayTags.has(t)) score += 0.5;
      const mood = this.detectMood(m.content);
      if (mood && todayMoods.has(mood)) score += 0.5;
      return { m, score: score + 0.05 };
    });
    const chosen: Memo[] = [];
    const bag = scored.slice();
    const n = Math.min(count, bag.length);
    let rng = seed >>> 0;
    for (let i = 0; i < n; i++) {
      const total = bag.reduce((s, x) => s + x.score, 0);
      rng = (rng * 1103515245 + 12345) & 0x7fffffff;
      let r = (rng / 0x7fffffff) * total;
      let idx = 0;
      for (; idx < bag.length - 1; idx++) {
        r -= bag[idx].score;
        if (r <= 0) break;
      }
      chosen.push(bag[idx].m);
      bag.splice(idx, 1);
    }
    for (const m of chosen) seen[this.memoId(m)] = now;
    this.saveLastSeen(seen);
    return chosen;
  }

  private renderList(): void {
    this.listEl.empty();
    this.childComponent.unload();
    this.childComponent = new Component();
    this.childComponent.load();
    this.listEl.toggleClass(
      "is-compact",
      this.plugin.settings.density === "compact"
    );

    const filtered = this.getFilteredMemos();
    // 统计头部固定在滚动容器之外（metaHeatmapHeadEl），不随列表滚动消失；
    // 「共 N 条」随筛选变化，每次重渲。统计行始终显示，不受热力图开关影响。
    this.metaHeatmapHeadEl.removeClass("is-hidden");
    this.renderMetaHeatmapHead(
      this.metaHeatmapHeadEl,
      filtered,
      this.describeFilter(filtered.length),
      {
        reroll: this.filter.preset === "random",
        back: this.filter.preset === "on-this-day",
      }
    );
    // 一年贡献网格受设置 showHeatmap 控制：关闭则不渲染（列表里只留卡片）。
    if (this.plugin.settings.showHeatmap) {
      // 热力图网格作为 listEl 首个子元素渲染（跟随滚动）：
      // 向上滚动时网格会随卡片一起滚走，但统计头部固定在上方始终可见。
      // 网格与统计头部、共 N 条同源（filtered）：筛选激活时整块联动，
      // 头部数字/网格/计数保持一致；默认（全部）时 filtered == 全部，等价全局。
      this.renderMetaHeatmapGrid(this.listEl, filtered);
    }

    if (filtered.length === 0) {
      this.renderEmpty(this.listEl);
      return;
    }

    const slice = filtered.slice(0, this.pageLimit);
    const pinned = slice.filter((m) => m.isPinned);
    const rest = slice.filter((m) => !m.isPinned);
    if (pinned.length) {
      const group = this.listEl.createDiv({
        cls: "muse-day-group muse-pin-group",
      });
      const head = group.createDiv({
        cls: "muse-day-head muse-pin-head",
      });
      const pic = head.createSpan({ cls: "muse-pin-head-icon" });
      setIcon(pic, "pin");
      head.createSpan({
        text: this.plugin.t("list.pinnedHead", { n: pinned.length }),
      });
      for (const m of pinned) this.renderMemoCard(group, m);
    }
    const byDate = new Map<string, Memo[]>();
    for (const m of rest) {
      const arr = byDate.get(m.date) ?? [];
      arr.push(m);
      byDate.set(m.date, arr);
    }
    const today = dateKey(new Date());
    const yest = dateKey(new Date(Date.now() - 86400000));
    for (const [date, arr] of byDate) {
      const group = this.listEl.createDiv({ cls: "muse-day-group" });
      group.dataset.date = date;
      const head = group.createDiv({ cls: "muse-day-head" });
      const d = new Date(`${date}T00:00:00`);
      let label = `${date}  ${this.plugin.t(`weekday.${d.getDay()}`)}`;
      if (date === today) label = `${this.plugin.t("date.today")}  ${this.plugin.t(`weekday.${d.getDay()}`)}`;
      else if (date === yest) label = `${this.plugin.t("date.yesterday")}  ${this.plugin.t(`weekday.${d.getDay()}`)}`;
      head.setText(label);
      for (const m of arr) this.renderMemoCard(group, m);
    }
    if (this.pageLimit < filtered.length) {
      const more = this.listEl.createDiv({ cls: "muse-load-more" });
      more.setText(
        this.plugin.t("list.loadMore", {
          n: filtered.length - this.pageLimit,
        })
      );
      // 显式点击也可加载下一页（作为自动加载之外的兜底入口）。
      more.addEventListener("click", () => this.loadMore());
    }
  }

  /** 加载下一页：按 pageSize 步长扩大 pageLimit，渲染后保留当前滚动位置。 */
  private loadMore(): void {
    if (this.loadingMore) return;
    const filtered = this.getFilteredMemos();
    if (this.pageLimit >= filtered.length) return;
    this.loadingMore = true;
    const el = this.listEl;
    const prevScrollTop = el.scrollTop;
    const step = Math.max(10, this.plugin.settings.pageSize || 50);
    this.pageLimit = Math.min(filtered.length, this.pageLimit + step);
    this.renderList();
    requestAnimationFrame(() => {
      // renderList 重建了内容、scrollTop 归零，恢复到用户当前位置，避免跳顶。
      el.scrollTop = prevScrollTop;
      this.loadingMore = false;
    });
  }

  private renderEmpty(host: HTMLElement): void {
    const empty = host.createDiv({ cls: "muse-empty" });
    if (this.filter.preset === "on-this-day") {
      empty.createDiv({ cls: "muse-empty-emoji", text: "🕰️" });
      empty.createDiv({ cls: "muse-empty-text", text: this.plugin.t("empty.onThisDay") });
      empty.createDiv({ cls: "muse-empty-sub", text: this.plugin.t("empty.onThisDaySub") });
      const btn = empty.createEl("button", { cls: "muse-empty-btn" });
      setIcon(btn.createSpan(), "shuffle");
      btn.createSpan({ text: this.plugin.t("empty.onThisDayBtn") });
      btn.addEventListener("click", () => {
        this.filter.preset = "random";
        this.filter.randomSeed = Date.now();
        this.filter.randomCount = 1;
        this.renderList();
      });
      return;
    }
    if (this.filter.preset === "todo") {
      empty.createDiv({ cls: "muse-empty-emoji", text: "🎉" });
      empty.createDiv({ cls: "muse-empty-text", text: this.plugin.t("empty.todo") });
      empty.createDiv({ cls: "muse-empty-sub", text: this.plugin.t("empty.todoSub") });
      return;
    }
    empty.createDiv({ cls: "muse-empty-emoji", text: "📭" });
    empty.createDiv({ cls: "muse-empty-text", text: this.plugin.t("empty.default") });
    empty.createDiv({ cls: "muse-empty-sub", text: this.plugin.t("empty.defaultSub") });
  }

  private static readonly MOOD_DICT: Record<string, string[]> = {
    happy: ["开心", "高兴", "快乐", "哈哈", "太好了", "欣喜", "愉悦", "爽", "赞", "喜欢", "爱了", "幸福", "美滋滋"],
    touched: ["感动", "泪目", "破防", "暖", "温暖", "感人", "泪", "心疼", "触动"],
    inspired: ["鼓励", "加油", "努力", "坚持", "冲", "燃", "激励", "信心", "希望", "打气", "奋斗"],
    sad: ["难过", "伤心", "失落", "沮丧", "郁闷", "丧", "低落", "哭", "委屈", "孤独"],
    angry: ["烦", "气", "怒", "暴躁", "崩溃", "烦人", "讨厌", "无语", "草", "烦死了", "气死"],
    fear: ["怕", "害怕", "恐惧", "担心", "焦虑", "慌", "紧张", "怕了"],
    tired: ["累", "困", "疲惫", "倦", "乏", "想睡", "瞌睡", "疲劳", "倦了"],
  };

  /** 基于关键词词典检测情绪维度（返回 CSS 类名后缀，无匹配返回 null）。 */
  private detectMood(text: string): string | null {
    for (const [mood, kws] of Object.entries(MuseView.MOOD_DICT)) {
      for (const kw of kws) {
        if (text.includes(kw)) return mood;
      }
    }
    return null;
  }

  private renderMemoCard(host: HTMLElement, memo: Memo): void {
    const mood = this.plugin.settings.enableMoodColoring
      ? this.detectMood(memo.content)
      : null;
    const card = host.createDiv({
      cls:
        "muse-card" +
        (mood ? ` muse-mood-${mood}` : "") +
        (memo.isPinned ? " is-pinned" : "") +
        (memo.isStarred ? " is-starred" : "") +
        (this.editingMemo === memo ? " is-editing" : ""),
      attr: { "data-memo-key": this.memoKey(memo) },
    });
    card.addEventListener("dblclick", (e) => {
      const tgt = e.target as HTMLElement;
      if (!tgt.closest(".muse-img-cell") && tgt.tagName !== "A")
        this.enterEditMode(memo);
    });

    const head = card.createDiv({ cls: "muse-card-head" });
    const timeWrap = head.createDiv({ cls: "muse-card-time-wrap" });
    if (memo.isPinned) {
      const pin = timeWrap.createSpan({ cls: "muse-card-pin" });
      setIcon(pin, "pin");
      pin.setAttr("aria-label", this.plugin.t("card.pinnedMark"));
    }
    if (memo.isStarred) {
      const star = timeWrap.createSpan({ cls: "muse-card-star" });
      setIcon(star, "star");
      star.setAttr("aria-label", this.plugin.t("card.starredMark"));
    }
    timeWrap.createSpan({
      cls: "muse-card-time",
      text: `${memo.date} ${memo.time}`,
    });

    const actions = head.createDiv({ cls: "muse-card-actions" });
    const quoteBtn = actions.createEl("button", {
      cls: "muse-icon-btn muse-card-quote",
      attr: { "aria-label": this.plugin.t("toolbar.quote") },
    });
    setIcon(quoteBtn, "quote");
    quoteBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.quoteMemo(memo);
    });
    const moreBtn = actions.createEl("button", {
      cls: "muse-icon-btn",
      attr: { "aria-label": this.plugin.t("toolbar.more") },
    });
    setIcon(moreBtn, "more-horizontal");
    moreBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.showMemoMenu(e, memo);
    });

    const { text: stripped, tags } = stripInlineTags(memo.content);
    const { text: body, images } = extractMemoImages(
      this.app,
      stripped,
      memo.file.path
    );
    if (body.trim()) {
      const bodyEl = card.createDiv({ cls: "muse-card-body" });
      MarkdownRenderer.render(
        this.app,
        body,
        bodyEl,
        memo.file.path,
        this.childComponent
      );
      this.bindInternalLinks(bodyEl, memo);
      // 长笔记自动折叠：超过 collapseLineLimit 行时截断并加「展开全文」。
      const limit = this.plugin.settings.collapseLineLimit;
      if (limit > 0) this.maybeCollapse(bodyEl, limit);
    }
    if (images.length) this.renderImageGrid(card, images);
    const visibleTags = tags.filter((t) => !SYSTEM_TAGS.includes(t));
    if (visibleTags.length) {
      const tagEl = card.createDiv({ cls: "muse-card-tags" });
      for (const tg of visibleTags) {
        const pill = tagEl.createSpan({
          cls: "muse-tag-pill",
          text: `#${tg}`,
        });
        pill.addEventListener("click", () => {
          this.filter.tag = tg;
          this.filter.preset = "all";
          this.pageLimit = this.getInitialPageLimit();
          this.renderAll();
        });
      }
    }
  }

  /** 长笔记自动折叠：正文视觉高度超过 collapseLineLimit 行时截断，并加「展开/收起」按钮。
   *  复用 styles.css 的 .is-collapsed（max-height + 渐变遮罩）与 .muse-collapse-toggle 交互。 */
  private maybeCollapse(bodyEl: HTMLElement, limit: number): void {
    // MarkdownRenderer 可能异步补充代码块/高亮，延一帧再量高度更准；
    // 若卡片已被重建（isConnected=false）则跳过，避免挂到旧 DOM。
    requestAnimationFrame(() => {
      if (!bodyEl.isConnected) return;
      if (this.countVisualLines(bodyEl) <= limit) return;
      this.applyCollapse(bodyEl, limit);
    });
  }

  /** 对某个正文应用折叠态：设置折叠高度、加遮罩类、插入「展开/收起」按钮。
   *  供初次渲染（maybeCollapse）与窗口尺寸变化时的重新评估复用。 */
  private applyCollapse(bodyEl: HTMLElement, limit: number): void {
    // 已是折叠态则跳过，避免重复插入按钮。
    if (bodyEl.classList.contains("has-toggle")) return;
    const cs = getComputedStyle(bodyEl);
    const lh = parseFloat(cs.lineHeight);
    if (!isFinite(lh) || lh <= 0) return;
    const maxH = lh * limit;
    // 清掉可能残留的展开态内联高度，保证折叠类能生效。
    bodyEl.style.maxHeight = "";
    // 用设置项行数推算最大高度（覆盖 CSS 默认的 --muse-collapse-max: 240px）。
    bodyEl.style.setProperty("--muse-collapse-max", `${maxH}px`);
    bodyEl.addClass("is-collapsed");
    bodyEl.addClass("has-toggle");
    const btn = bodyEl.createDiv({ cls: "muse-collapse-toggle" });
    const icon = btn.createSpan({ cls: "muse-collapse-icon" });
    setIcon(icon, "chevron-down");
    btn.setAttribute("aria-label", this.plugin.t("card.collapseFull"));
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (bodyEl.classList.contains("is-collapsed")) {
        // 展开：先锁定折叠高度作为过渡起点，再去掉折叠类让展开态样式
        // （含 padding-bottom 留白）生效，然后以「含留白的完整高度」为目标过渡。
        // 关键：必须在 removeClass 之后再测 scrollHeight，否则测得的高度不含
        // 展开态留白，transitionend 置 max-height:none 时 body 会再长一截 → 末段跳动。
        bodyEl.style.maxHeight = `${maxH}px`;
        bodyEl.removeClass("is-collapsed");
        // 强制 reflow，让起点高度与展开态样式先生效，下一步过渡才会从 maxH 起步
        void bodyEl.offsetHeight;
        bodyEl.style.maxHeight = bodyEl.scrollHeight + "px";
        setIcon(icon, "chevron-up");
        btn.setAttribute("aria-label", this.plugin.t("card.collapseLess"));
        bodyEl.dataset.userExpanded = "1";
        const onEnd = () => {
          bodyEl.removeEventListener("transitionend", onEnd);
          // 仅在仍处于展开态时放开高度限制；若中途又点了收起则保持折叠高度
          if (!bodyEl.classList.contains("is-collapsed")) bodyEl.style.maxHeight = "none";
        };
        bodyEl.addEventListener("transitionend", onEnd);
      } else {
        // 收起：先把高度锁为当前完整值（触发 reflow），再过渡到折叠高度，
        // 按钮随 body 平滑上移。
        bodyEl.style.maxHeight = bodyEl.scrollHeight + "px";
        // 强制 reflow，让上面的高度赋值先生效，下一步过渡才会启动
        void bodyEl.offsetHeight;
        bodyEl.style.maxHeight = `${maxH}px`;
        bodyEl.addClass("is-collapsed");
        setIcon(icon, "chevron-down");
        btn.setAttribute("aria-label", this.plugin.t("card.collapseFull"));
        delete bodyEl.dataset.userExpanded;
      }
    });
  }

  /** 撤销折叠态：移除遮罩类、渐变、内联高度，并删掉折叠按钮。
   *  用于窗口变宽后内容已能完整显示的情形（无论此前是折叠还是用户手动展开）。 */
  private clearCollapse(bodyEl: HTMLElement): void {
    bodyEl.classList.remove("is-collapsed", "has-toggle");
    bodyEl.style.maxHeight = "";
    bodyEl.style.removeProperty("--muse-collapse-max");
    delete bodyEl.dataset.userExpanded;
    bodyEl.querySelector(".muse-collapse-toggle")?.remove();
  }

  /** 窗口尺寸变化后，重新评估所有卡片正文的折叠状态。
   *  - 内容已能完整显示（视觉行数 <= 限制）：撤掉折叠态与按钮。
   *  - 内容仍超出且非用户手动展开：重新折叠（窗口变窄时）。
   *  已手动展开过的卡片（dataset.userExpanded）保持展开，尊重用户选择。 */
  private recomputeCollapse(): void {
    const limit = this.plugin.settings.collapseLineLimit;
    if (limit <= 0) return;
    const bodies = this.containerEl.querySelectorAll<HTMLElement>(".muse-card-body");
    bodies.forEach((body) => {
      if (!body.isConnected) return;
      const lines = this.countVisualLines(body);
      if (lines <= limit) {
        this.clearCollapse(body);
      } else if (body.dataset.userExpanded !== "1" && !body.classList.contains("is-collapsed")) {
        this.applyCollapse(body, limit);
      }
    });
  }

  private resizeTimer: number | null = null;
  private handleResize = (): void => {
    if (this.resizeTimer !== null) window.clearTimeout(this.resizeTimer);
    this.resizeTimer = window.setTimeout(() => {
      this.resizeTimer = null;
      this.recomputeCollapse();
    }, 150);
  };

  /** 统计元素内文本的视觉行数：遍历文本节点，用 Range.getClientRects 取得每行矩形，
   *  按行的纵向坐标（四舍五入）去重，得到真实视觉行数。不受 inline 元素拆分
   *  （如 <strong> 包裹）与 markdown 块间距影响，比 scrollHeight/lineHeight 更贴合直觉。 */
  private countVisualLines(el: HTMLElement): number {
    const tops = new Set<number>();
    const walk = (node: Node): void => {
      if (node.nodeType === Node.TEXT_NODE) {
        const text = node.textContent ?? "";
        if (!text.trim()) return;
        const range = document.createRange();
        try {
          range.selectNodeContents(node);
        } catch {
          return;
        }
        const rects = range.getClientRects();
        for (let i = 0; i < rects.length; i++) {
          if (rects[i].height > 0) tops.add(Math.round(rects[i].top));
        }
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        node.childNodes.forEach(walk);
      }
    };
    el.childNodes.forEach(walk);
    return tops.size;
  }

  private renderImageGrid(host: HTMLElement, images: MemoImage[]): void {
    if (images.length === 0) return;
    const grid = host.createDiv({
      cls: `muse-img-grid muse-img-grid-${Math.min(images.length, 9)}`,
    });
    images.slice(0, 9).forEach((img, i) => {
      const cell = grid.createDiv({ cls: "muse-img-cell" });
      const el = cell.createEl("img", {
        cls: "muse-img",
        attr: { src: img.src, alt: img.alt, loading: "lazy" },
      });
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        this.openLightbox(images, i);
      });
      if (i === 8 && images.length > 9) {
        const overlay = cell.createDiv({ cls: "muse-img-overlay" });
        overlay.setText(`+${images.length - 9}`);
        overlay.addEventListener("click", (e) => {
          e.stopPropagation();
          this.openLightbox(images, 8);
        });
      }
    });
  }

  private openLightbox(images: MemoImage[], index: number): void {
    new LightboxModal(this.app, images, index).open();
  }

  private bindInternalLinks(host: HTMLElement, memo: Memo): void {
    host.addEventListener("click", (e) => {
      const tgt = e.target as HTMLElement;
      const internal = tgt.closest("a.internal-link") as HTMLAnchorElement | null;
      if (internal) {
        e.preventDefault();
        e.stopPropagation();
        const href = internal.getAttribute("data-href") || internal.getAttribute("href") || "";
        if (!href) return;
        const mod = e.ctrlKey || e.metaKey || e.button === 1;
        this.app.workspace.openLinkText(href, memo.file.path, mod);
        return;
      }
      const tagLink = tgt.closest("a.tag") as HTMLAnchorElement | null;
      if (tagLink) {
        e.preventDefault();
        e.stopPropagation();
        const href = (tagLink.getAttribute("href") || "").replace(/^#/, "");
        if (!href) return;
        this.filter.tag = href;
        this.filter.preset = "all";
        this.pageLimit = this.getInitialPageLimit();
        this.renderAll();
      }
    });
  }

  /* ----------------------------- 卡片菜单 / 操作 ----------------------------- */

  private showMemoMenu(e: MouseEvent, memo: Memo): void {
    const menu = new Menu();
    menu.addItem((item) =>
      item
        .setTitle(memo.isPinned ? this.plugin.t("card.unpin") : this.plugin.t("card.pin"))
        .setIcon(memo.isPinned ? "pin-off" : "pin")
        .onClick(async () => {
          await this.plugin.store.togglePinned(memo);
          new Notice(memo.isPinned ? this.plugin.t("notice.unpinned") : this.plugin.t("notice.pinned"));
        })
    );
    menu.addItem((item) =>
      item
        .setTitle(memo.isStarred ? this.plugin.t("card.unstar") : this.plugin.t("card.star"))
        .setIcon(memo.isStarred ? "star-off" : "star")
        .onClick(async () => {
          await this.plugin.store.toggleStarred(memo);
          new Notice(memo.isStarred ? this.plugin.t("notice.unstarred") : this.plugin.t("notice.starred"));
        })
    );
    menu.addSeparator();
    menu.addItem((item) =>
      item
        .setTitle(this.plugin.t("card.edit"))
        .setIcon("pencil")
        .onClick(() => this.enterEditMode(memo))
    );
    menu.addItem((item) =>
      item
        .setTitle(this.plugin.t("card.openSource"))
        .setIcon("file-text")
        .onClick(() => this.openInFile(memo))
    );
    menu.addItem((item) =>
      item
        .setTitle(this.plugin.t("card.copySource"))
        .setIcon("copy")
        .onClick(async () => {
          await navigator.clipboard.writeText(memo.content);
          new Notice(this.plugin.t("notice.copied"));
        })
    );
    menu.addItem((item) =>
      item
        .setTitle(this.plugin.t("card.exportImage"))
        .setIcon("image-file")
        .onClick(async () => {
          await openShareImage(this.plugin, memo);
        })
    );
    menu.addSeparator();
    menu.addItem((item) =>
      item
        .setTitle(this.plugin.t("card.delete"))
        .setIcon("trash")
        .onClick(async () => {
          if (await this.confirmAsync(this.plugin.t("notice.confirmDelete"))) {
            await this.plugin.store.deleteMemo(memo);
          }
        })
    );
    menu.showAtMouseEvent(e);
  }

  private async openInFile(memo: Memo): Promise<void> {
    const leaf = this.app.workspace.getLeaf("tab");
    await leaf.openFile(memo.file);
  }

  private quoteMemo(memo: Memo): void {
    const quote = `> ${memo.content.replace(/\n/g, "\n> ")}`;
    const cur = this.editor.getValue();
    const prefix = cur ? "\n\n" : "";
    this.editor.setValue(cur + prefix + quote);
    this.editor.focus();
    this.autoResizeInput();
    this.syncInputCardContentState();
  }

  private describeFilter(total: number): string {
    const parts: string[] = [];
    const names: Record<string, string> = {
      today: this.plugin.t("sidebar.today"),
      week: this.plugin.t("sidebar.week"),
      "on-this-day": this.plugin.t("list.presetOnThisDay"),
      "no-tag": this.plugin.t("sidebar.noTag"),
      "with-image": this.plugin.t("sidebar.withImage"),
      "with-link": this.plugin.t("sidebar.withLink"),
      pinned: this.plugin.t("list.presetPinned"),
      starred: this.plugin.t("list.presetStarred"),
      todo: this.plugin.t("sidebar.todo"),
    };
    if (this.filter.preset !== "all") parts.push(names[this.filter.preset] ?? this.filter.preset);
    if (this.filter.year) parts.push(this.filter.year);
    if (this.filter.date) parts.push(`📅 ${this.filter.date}`);
    if (this.filter.tag) parts.push(`#${this.filter.tag}`);
    if (this.filter.keyword) parts.push(`「${this.filter.keyword}」`);
    return `${parts.length ? parts.join(" · ") + " · " : ""}${this.plugin.t("list.totalCount", { n: total })}`;
  }

  /** 表格选择器（简化：插入一个 2x2 表格占位）。 */
  private showTablePicker(): void {
    const rows = ["| 列1 | 列2 |", "| --- | --- |", "|  |  |", "|  |  |"].join("\n");
    this.insertAtCursor(`\n${rows}\n`);
  }

  /** 自建的确认弹窗：直接 createDiv 到 document.body，
   *  无 Obsidian X 关闭按钮，Esc=取消 Enter=确认，点击外部也关闭）。 */
  confirmAsync(message: string): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const backdrop = document.body.createDiv({ cls: "muse-modal-backdrop" });
      const modal = backdrop.createDiv({ cls: "muse-modal muse-confirm" });
      modal.createDiv({ cls: "muse-modal-title", text: message });
      const btns = modal.createDiv({ cls: "muse-modal-btns" });
      const cancelBtn = btns.createEl("button", { text: this.plugin.t("input.cancel") });
      const okBtn = btns.createEl("button", {
        text: this.plugin.t("notice.confirmDeleteOk"),
        cls: "mod-warning",
      });

      let settled = false;
      let pendingMouseUp: ((e: MouseEvent) => void) | null = null;
      const clearPendingMouseUp = () => {
        if (pendingMouseUp) {
          document.removeEventListener("mouseup", pendingMouseUp, true);
          pendingMouseUp = null;
        }
      };
      // 视图/插件卸载时保险兜底关闭
      this.register(() => {
        if (!settled) {
          settled = true;
          backdrop.remove();
          document.removeEventListener("keydown", onKey, true);
          clearPendingMouseUp();
          setTimeout(() => resolve(false), 0);
        }
      });
      const settle = (v: boolean) => {
        if (!settled) {
          settled = true;
          backdrop.remove();
          document.removeEventListener("keydown", onKey, true);
          clearPendingMouseUp();
          setTimeout(() => resolve(v), 0);
        }
      };
      const onKey = (ev: KeyboardEvent) => {
        if (ev.key === "Escape") {
          ev.preventDefault();
          settle(false);
        } else if (ev.key === "Enter") {
          ev.preventDefault();
          settle(true);
        }
      };
      cancelBtn.addEventListener("click", () => settle(false));
      okBtn.addEventListener("click", () => settle(true));
      backdrop.addEventListener("mousedown", (downEv) => {
        if (downEv.target !== backdrop) return;
        clearPendingMouseUp();
        const onUp = (upEv: MouseEvent) => {
          document.removeEventListener("mouseup", onUp, true);
          pendingMouseUp = null;
          if (upEv.target === backdrop) settle(false);
        };
        pendingMouseUp = onUp;
        document.addEventListener("mouseup", onUp, true);
      });
      document.addEventListener("keydown", onKey, true);
      setTimeout(() => okBtn.focus(), 20);
    });
  }
}

/* ----------------------------- 工具函数 / 类型 ----------------------------- */

interface TagNode {
  name: string;
  full: string;
  count: number;
  self: number;
  children: Map<string, TagNode>;
}

function debounce(fn: () => void, ms: number): () => void {
  let timer: number | undefined;
  return () => {
    if (timer) window.clearTimeout(timer);
    timer = window.setTimeout(fn, ms);
  };
}

function dateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** 本周一 00:00 的时间戳（毫秒）。 */
function startOfWeek(): number {
  const now = new Date();
  const dow = (now.getDay() + 6) % 7;
  const d = new Date(now);
  d.setDate(now.getDate() - dow);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** 基于种子的确定性洗牌（保证同一 seed 结果稳定）。 */
function shuffle<T>(arr: T[], seed: number): T[] {
  let s = seed >>> 0;
  const rand = () => {
    s = (s + 1831565813) >>> 0;
    let x = s;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** 图片灯箱模态。 */
class LightboxModal extends Modal {
  private images: MemoImage[];
  private index: number;
  private counterEl!: HTMLElement;
  private imgEl!: HTMLImageElement;
  private prevBtn!: HTMLElement;
  private nextBtn!: HTMLElement;

  constructor(app: import("obsidian").App, images: MemoImage[], index: number) {
    super(app);
    this.images = images;
    this.index = index;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass("muse-lightbox");
    const stage = contentEl.createDiv({ cls: "muse-lightbox-stage" });
    this.imgEl = stage.createEl("img", { cls: "muse-lightbox-img" });
    this.counterEl = contentEl.createDiv({ cls: "muse-lightbox-counter" });
    const close = contentEl.createEl("button", {
      cls: "muse-lightbox-close",
      text: "×",
      attr: { "aria-label": "关闭" },
    });
    this.prevBtn = contentEl.createEl("button", {
      cls: "muse-lightbox-nav muse-lightbox-prev",
      text: "‹",
      attr: { "aria-label": "上一张" },
    });
    this.nextBtn = contentEl.createEl("button", {
      cls: "muse-lightbox-nav muse-lightbox-next",
      text: "›",
      attr: { "aria-label": "下一张" },
    });
    const update = () => {
      this.imgEl.src = this.images[this.index].src;
      this.imgEl.alt = this.images[this.index].alt;
      this.counterEl.setText(`${this.index + 1} / ${this.images.length}`);
      this.prevBtn.style.visibility = this.index > 0 ? "visible" : "hidden";
      this.nextBtn.style.visibility =
        this.index < this.images.length - 1 ? "visible" : "hidden";
    };
    update();
    const prev = () => {
      if (this.index > 0) {
        this.index--;
        update();
      }
    };
    const next = () => {
      if (this.index < this.images.length - 1) {
        this.index++;
        update();
      }
    };
    close.addEventListener("click", () => this.close());
    this.prevBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      prev();
    });
    this.nextBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      next();
    });
    contentEl.addEventListener("click", (e) => {
      if (e.target === contentEl || e.target === stage) this.close();
    });
    this.imgEl.addEventListener("click", (e) => {
      e.stopPropagation();
      next();
    });
    this.keyHandler = (e: KeyboardEvent) => {
      if (e.key === "Escape") this.close();
      else if (e.key === "ArrowLeft") prev();
      else if (e.key === "ArrowRight") next();
    };
    document.addEventListener("keydown", this.keyHandler);
  }

  private keyHandler!: (e: KeyboardEvent) => void;

  onClose(): void {
    document.removeEventListener("keydown", this.keyHandler);
    this.contentEl.empty();
  }
}

