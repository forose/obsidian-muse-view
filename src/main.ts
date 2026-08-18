import { Plugin, WorkspaceLeaf, TFile, Notice } from "obsidian";
import {
  MuseViewSettings,
  DEFAULT_SETTINGS,
  MuseViewSettingTab,
} from "./settings";
import { MemoStore } from "./store";
import { MuseView } from "./view/MuseView";
import { LivePreviewEditor } from "./editor/MuseEditor";
import { VIEW_TYPE_MUSE } from "./types";
import { createT, resolveLang, getAppLocale, type T } from "./i18n";

/**
 * MuseView —— 碎片笔记插件。
 *
 * 设计要点：
 * - 每条 memo = vault 里的一个 Markdown 文件（`<folder>/<id>.md`），元数据走 frontmatter。
 * - UI 拆分为「主视图（MuseView）」+「存储（MemoStore）」+「设置（MuseViewSettingTab）」，
 *   职责清晰，便于后续继续扩展热力图/日历/统计页等高级功能。
 */
export default class MuseViewPlugin extends Plugin {
  settings: MuseViewSettings = { ...DEFAULT_SETTINGS };
  store!: MemoStore;

  /** 当前语言的翻译函数。 */
  get t(): T {
    return createT(resolveLang(this.settings.language, getAppLocale(this.app)));
  }

  async onload(): Promise<void> {
    await this.loadSettings();
    this.store = new MemoStore(this.app, this.settings);

    // 注册主视图
    this.registerView(VIEW_TYPE_MUSE, (leaf) => new MuseView(leaf, this));

    // ribbon 图标：feather
    this.addRibbonIcon("feather", this.t("ribbon.openMuseView"), () => {
      void this.activateView();
    });

    // 打开视图命令
    this.addCommand({
      id: "open-muse",
      name: this.t("command.openMuseView"),
      callback: () => void this.activateView(),
    });

    // 快速记录命令：全局浮层快速记录（Mod+Shift+M）
    this.addCommand({
      id: "muse-quick-capture",
      name: this.t("command.quickCapture"),
      hotkeys: [{ modifiers: ["Mod", "Shift"], key: "M" }],
      callback: () => void this.quickCapture(),
    });

    // 归一化全部笔记命令
    this.addCommand({
      id: "muse-normalize-all",
      name: this.t("command.normalizeAll"),
      callback: () => void this.normalizeAll(),
    });

    // 设置页
    this.addSettingTab(new MuseViewSettingTab(this.app, this));

    // 外部 vault 变更时刷新缓存，驱动视图自动更新
    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (file instanceof TFile && this.store.isInFolder(file))
          void this.store.reloadFile(file);
      })
    );
    this.registerEvent(
      this.app.vault.on("create", (file) => {
        if (file instanceof TFile && this.store.isInFolder(file))
          void this.store.reloadFile(file);
      })
    );
    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        if (file instanceof TFile) this.store.removeFile(file.path);
      })
    );
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        if (file instanceof TFile) {
          this.store.removeFile(oldPath);
          if (this.store.isInFolder(file)) void this.store.reloadFile(file);
        }
      })
    );

    // 绑定文件：打开指定 md 文件时自动激活 MuseView 主视图
    this.registerEvent(
      this.app.workspace.on("file-open", (file) => {
        if (!file) return;
        if (!this.settings.bindFile) return;
        if (file.path === this.settings.bindFile) {
          void this.activateView();
          setTimeout(() => {
            const leaves = this.app.workspace.getLeavesOfType("markdown");
            for (const leaf of leaves) {
              const vs = leaf.getViewState();
              if ((vs.state as { file?: string })?.file === this.settings.bindFile) {
                leaf.detach();
              }
            }
          }, 0);
        }
      })
    );
  }

  onunload(): void {
    // 视图由 Obsidian 自动卸载；此处无需额外清理
  }

  /** 打开（或聚焦）主视图。focusInput 时顺便把焦点交给输入框。 */
  async activateView(focusInput = false): Promise<void> {
    const { workspace } = this.app;
    let leaf: WorkspaceLeaf | null = workspace.getLeavesOfType(VIEW_TYPE_MUSE)[0];
    if (!leaf) {
      leaf = workspace.getLeaf(false);
      await leaf.setViewState({ type: VIEW_TYPE_MUSE, active: true });
    }
    if (leaf) workspace.revealLeaf(leaf);
    if (focusInput) {
      const view = this.getView();
      view?.focusInput();
    }
  }

  /** 归一化全部笔记。 */
  async normalizeAll(): Promise<void> {
    if (!confirm(this.t("notice.normalizeConfirm"))) return;
    new Notice(this.t("notice.normalizing"));
    try {
      const n = await this.store.normalizeAll();
      new Notice(this.t("notice.normalized", { n }));
    } catch (e) {
      console.error(e);
      new Notice(this.t("notice.normalizeFailed", { msg: (e as Error).message }));
    }
  }

  /** 全局浮层快速记录。 */
  async quickCapture(): Promise<void> {
    const existing = document.querySelector(".muse-modal-backdrop");
    if (existing) {
      const lp = existing.querySelector(".muse-lp");
      if (lp) (lp as HTMLElement).focus();
      return;
    }
    const backdrop = document.createElement("div");
    backdrop.addClass("muse-modal-backdrop");
    const modal = backdrop.createDiv({ cls: "muse-modal" });
    modal.createDiv({ cls: "muse-modal-title", text: this.t("quickCapture.title") });
    const sendHint =
      this.settings.sendHotkey === "enter" ? "Enter 发送" : "Ctrl/Cmd+Enter 发送";
    // 复用主视图同款 Live Preview 编辑器，支持实时 markdown 渲染。
    const editor = new LivePreviewEditor(modal, this.app);
    editor.el.addClass("muse-modal-input");
    editor.setPlaceholder(`快速记录 ${sendHint} · Esc 关闭`);
    const btns = modal.createDiv({ cls: "muse-modal-btns" });
    const cancel = btns.createEl("button", { text: this.t("quickCapture.cancel") });
    const send = btns.createEl("button", {
      text: this.t("quickCapture.send"),
      cls: "mod-cta",
    });
    document.body.appendChild(backdrop);
    const cleanup = () => {
      editor.destroy();
      backdrop.remove();
    };
    this.register(() => cleanup());
    setTimeout(() => editor.focus(), 20);
    const doSend = async () => {
      const val = editor.getValue().trim();
      if (!val) {
        cleanup();
        return;
      }
      try {
        await this.store.addMemo(val);
        cleanup();
      } catch (e) {
        new Notice(this.t("notice.saveFailed", { msg: (e as Error).message }));
      }
    };
    send.addEventListener("click", () => void doSend());
    cancel.addEventListener("click", cleanup);
    backdrop.addEventListener("mousedown", (ev) => {
      if (ev.target === backdrop) cleanup();
    });
    editor.setOnKeydown((ev) => {
      if (ev.key === "Escape") {
        ev.preventDefault();
        cleanup();
        return;
      }
      const mod = ev.metaKey || ev.ctrlKey;
      if (this.settings.sendHotkey === "enter") {
        if (ev.key === "Enter" && !ev.shiftKey && !mod) {
          ev.preventDefault();
          void doSend();
        }
      } else if (ev.key === "Enter" && mod) {
        ev.preventDefault();
        void doSend();
      }
    });
  }

  /** 取当前主视图实例（未打开时为 null）。 */
  getView(): MuseView | null {
    const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_MUSE)[0];
    return (leaf?.view as MuseView) ?? null;
  }

  async loadSettings(): Promise<void> {
    const data = (await this.loadData()) ?? {};
    // 迁移：旧版 showSidebarTags / tagCloud 两个布尔 → 单一三态 sidebarTagsMode。
    if (
      data.sidebarTagsMode === undefined &&
      (data.showSidebarTags !== undefined || data.tagCloud !== undefined)
    ) {
      data.sidebarTagsMode = data.showSidebarTags
        ? data.tagCloud
          ? "cloud"
          : "tree"
        : "off";
    }
    delete data.showSidebarTags;
    delete data.tagCloud;
    this.settings = { ...DEFAULT_SETTINGS, ...data };
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}
