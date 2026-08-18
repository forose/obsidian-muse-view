import {
  App,
  PluginSettingTab,
  Setting,
  Notice,
  SuggestModal,
  TFile,
} from "obsidian";
import type MuseViewPlugin from "./main";
import { createT, resolveLang, getAppLocale, type T } from "./i18n";

/** 插件设置。 */
export interface MuseViewSettings {
  /** 记忆文件夹（相对于 vault 根）。 */
  folder: string;
  /** 附件文件夹。 */
  attachmentFolder: string;
  /** 保存后是否清空输入框。 */
  clearAfterSave: boolean;
  /** 列表分页大小（renderList 初始 pageLimit，loadMore 按此步长增量加载）。 */
  pageSize: number;
  /** 侧栏标签展示模式：off=不显示，tree=层级树，cloud=标签云。 */
  sidebarTagsMode: "off" | "tree" | "cloud";
  /** 删除时是否移入回收站。 */
  useTrash: boolean;
  /** 导出图片（分享图）的背景主题。 */
  exportTheme: string;
  /** 超长正文折叠的行数阈值。 */
  collapseLineLimit: number;
  /** 每日目标条数（侧栏热力图下方进度条满值）。 */
  dailyGoal: number;
  /** 回收站上限（_trash.md 追加条数上限，超出按 FIFO 裁剪）。 */
  trashMaxItems: number;
  /** 界面密度。 */
  density: "compact" | "comfortable";
  /** 是否启用心情着色（卡片左侧 3px 情绪色条）。 */
  enableMoodColoring: boolean;
  /** 是否启用智能回顾（随机回顾走加权算法而非纯随机）。 */
  enableSmartReview: boolean;
  /** 是否启用编辑框实时预览（单栏 Live Preview，仿 Obsidian 编辑视图）。 */
  livePreview: boolean;
  /** 是否在主列表顶部显示贡献热力图（统计头部 + 一年网格）。 */
  showHeatmap: boolean;
  /** 语言：auto / zh / en。 */
  language: "auto" | "zh" | "en";
  /** 发送快捷键：enter / mod+enter。 */
  sendHotkey: "enter" | "mod+enter";
  /** 默认概览模式：heatmap=贡献热力图，calendar=月历。 */
  defaultOverviewMode: "heatmap" | "calendar";
  /** 绑定的日志文件（点击该 Markdown 文件自动打开 MuseView 主界面；null=禁用）。 */
  bindFile: string | null;
}

export const DEFAULT_SETTINGS: MuseViewSettings = {
  folder: "0- 碎片记忆",
  attachmentFolder: "9- 本地附件",
  clearAfterSave: true,
  pageSize: 50,
  sidebarTagsMode: "cloud",
  useTrash: false,
  exportTheme: "kraft",
  collapseLineLimit: 8,
  dailyGoal: 5,
  trashMaxItems: 300,
  density: "compact",
  enableMoodColoring: true,
  enableSmartReview: true,
  livePreview: true,
  showHeatmap: true,
  language: "zh",
  sendHotkey: "enter",
  defaultOverviewMode: "heatmap",
  bindFile: null,
};

const REPO_URL = "https://github.com/forose/obsidian-muse-view";

/** 选择绑定文件的建议弹窗。 */
class FileSuggestModal extends SuggestModal<TFile> {
  constructor(
    app: App,
    placeholder: string,
    private onPick: (file: TFile) => void
  ) {
    super(app);
    this.setPlaceholder(placeholder);
  }
  getSuggestions(query: string): TFile[] {
    const q = query.toLowerCase();
    return this.app.vault
      .getMarkdownFiles()
      .filter((f) => f.path.toLowerCase().includes(q));
  }
  renderSuggestion(file: TFile, el: HTMLElement): void {
    el.textContent = file.path;
  }
  onChooseSuggestion(file: TFile): void {
    this.onPick(file);
  }
}

/** 设置页：使用 Obsidian 标准的 PluginSettingTab + Setting 组件。 */
export class MuseViewSettingTab extends PluginSettingTab {
  plugin: MuseViewPlugin;
  private t: T;

  constructor(app: App, plugin: MuseViewPlugin) {
    super(app, plugin);
    this.plugin = plugin;
    this.t = createT(
      resolveLang(plugin.settings.language, getAppLocale(app))
    );
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: this.t("settings.header") });

    new Setting(containerEl)
      .setName(this.t("settings.folder"))
      .setDesc(this.t("settings.folder.desc"))
      .addText((text) =>
        text
          .setPlaceholder("0- 碎片记忆")
          .setValue(this.plugin.settings.folder)
          .onChange(async (value) => {
            this.plugin.settings.folder = value.trim() || "0- 碎片记忆";
            await this.plugin.saveSettings();
            this.plugin.getView()?.refresh();
          })
      );

    new Setting(containerEl)
      .setName(this.t("settings.attachment"))
      .setDesc(this.t("settings.attachment.desc"))
      .addText((text) =>
        text
          .setPlaceholder("9- 本地附件")
          .setValue(this.plugin.settings.attachmentFolder)
          .onChange(async (value) => {
            this.plugin.settings.attachmentFolder =
              value.trim() || "9- 本地附件";
            await this.plugin.saveSettings();
            this.plugin.getView()?.refresh();
          })
      );

    new Setting(containerEl)
      .setName(this.t("settings.clear"))
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.clearAfterSave)
          .onChange(async (value) => {
            this.plugin.settings.clearAfterSave = value;
            await this.plugin.saveSettings();
            this.plugin.getView()?.refresh();
          })
      );

    // 侧栏标签展示：单一三态（关 / 层级树 / 标签云），替代原「显示标签 + 云图」两个开关。
    new Setting(containerEl)
      .setName(this.t("settings.sidebarTags"))
      .setDesc(this.t("settings.sidebarTags.desc"))
      .addDropdown((dropdown) =>
        dropdown
          .addOption("off", this.t("settings.sidebarTags.off"))
          .addOption("tree", this.t("settings.sidebarTags.tree"))
          .addOption("cloud", this.t("settings.sidebarTags.cloud"))
          .setValue(this.plugin.settings.sidebarTagsMode)
          .onChange(async (value) => {
            this.plugin.settings.sidebarTagsMode = value as
              | "off"
              | "tree"
              | "cloud";
            await this.plugin.saveSettings();
            // 立即生效：重渲染侧栏，无需关闭/重开 MuseView 视图。
            this.plugin.getView()?.renderSidebar();
          })
      );

    new Setting(containerEl)
      .setName(this.t("settings.useTrash"))
      .setDesc(this.t("settings.useTrash.desc"))
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.useTrash)
          .onChange(async (value) => {
            this.plugin.settings.useTrash = value;
            await this.plugin.saveSettings();
            this.plugin.getView()?.refresh();
          })
      );

    new Setting(containerEl)
      .setName(this.t("settings.trashMax.name"))
      .setDesc(this.t("settings.trashMax.desc"))
      .addDropdown((dropdown) =>
        dropdown
          .addOption("0", this.t("settings.trash.0"))
          .addOption("100", this.t("settings.trash.100"))
          .addOption("300", this.t("settings.trash.300"))
          .addOption("500", this.t("settings.trash.500"))
          .addOption("1000", this.t("settings.trash.1000"))
          .addOption("3000", this.t("settings.trash.3000"))
          .setValue(String(this.plugin.settings.trashMaxItems))
          .onChange(async (value) => {
            this.plugin.settings.trashMaxItems = parseInt(value, 10);
            await this.plugin.saveSettings();
            this.plugin.getView()?.refresh();
          })
      );

    new Setting(containerEl)
      .setName(this.t("settings.density"))
      .setDesc(this.t("settings.density.desc"))
      .addDropdown((dropdown) =>
        dropdown
          .addOption("compact", this.t("settings.density.compact"))
          .addOption("comfortable", this.t("settings.density.comfortable"))
          .setValue(this.plugin.settings.density)
          .onChange(async (value) => {
            this.plugin.settings.density = value as "compact" | "comfortable";
            await this.plugin.saveSettings();
            this.plugin.getView()?.applyDensity();
          })
      );

    new Setting(containerEl)
      .setName(this.t("settings.collapse.name"))
      .setDesc(this.t("settings.collapse.desc"))
      .addDropdown((dropdown) =>
        dropdown
          .addOption("0", this.t("settings.collapse.0"))
          .addOption("4", this.t("settings.collapse.4"))
          .addOption("6", this.t("settings.collapse.6"))
          .addOption("8", this.t("settings.collapse.8"))
          .addOption("12", this.t("settings.collapse.12"))
          .addOption("20", this.t("settings.collapse.20"))
          .setValue(String(this.plugin.settings.collapseLineLimit))
          .onChange(async (value) => {
            this.plugin.settings.collapseLineLimit = parseInt(value, 10);
            await this.plugin.saveSettings();
            this.plugin.getView()?.refresh();
          })
      );

    new Setting(containerEl)
      .setName(this.t("settings.exportTheme.name"))
      .setDesc(this.t("settings.exportTheme.desc"))
      .addDropdown((dropdown) =>
        dropdown
          .addOption("auto", this.t("settings.exportTheme.auto"))
          .addOption("kraft", this.t("settings.exportTheme.kraft"))
          .addOption("paper", this.t("settings.exportTheme.paper"))
          .addOption("charcoal", this.t("settings.exportTheme.charcoal"))
          .addOption("midnight", this.t("settings.exportTheme.midnight"))
          .addOption("mint", this.t("settings.exportTheme.mint"))
          .addOption("lavender", this.t("settings.exportTheme.lavender"))
          .addOption("peach", this.t("settings.exportTheme.peach"))
          .addOption("sky", this.t("settings.exportTheme.sky"))
          .addOption("random", this.t("settings.exportTheme.random"))
          .setValue(this.plugin.settings.exportTheme)
          .onChange(async (value) => {
            this.plugin.settings.exportTheme = value;
            await this.plugin.saveSettings();
            this.plugin.getView()?.refresh();
          })
      );

    new Setting(containerEl)
      .setName(this.t("settings.defaultOverview.name"))
      .setDesc(this.t("settings.defaultOverview.desc"))
      .addDropdown((dropdown) =>
        dropdown
          .addOption("heatmap", this.t("settings.defaultOverview.heatmap"))
          .addOption("calendar", this.t("settings.defaultOverview.calendar"))
          .setValue(this.plugin.settings.defaultOverviewMode)
          .onChange(async (value) => {
            this.plugin.settings.defaultOverviewMode = value as
              | "heatmap"
              | "calendar";
            await this.plugin.saveSettings();
            // 立即生效：刷新侧栏，无需重启插件
            this.plugin.getView()?.setOverviewMode(
              this.plugin.settings.defaultOverviewMode
            );
          })
      );

    new Setting(containerEl)
      .setName(this.t("settings.heatmap.name"))
      .setDesc(this.t("settings.heatmap.desc"))
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.showHeatmap)
          .onChange(async (value) => {
            this.plugin.settings.showHeatmap = value;
            await this.plugin.saveSettings();
            this.plugin.getView()?.refresh();
          })
      );

    new Setting(containerEl)
      .setName(this.t("settings.sendHotkey"))
      .setDesc(this.t("settings.sendHotkey.desc"))
      .addDropdown((dropdown) =>
        dropdown
          .addOption("enter", this.t("settings.sendHotkey.enter"))
          .addOption("mod+enter", this.t("settings.sendHotkey.mod"))
          .setValue(this.plugin.settings.sendHotkey)
          .onChange(async (value) => {
            this.plugin.settings.sendHotkey = value as "enter" | "mod+enter";
            await this.plugin.saveSettings();
            this.plugin.getView()?.refresh();
          })
      );

    new Setting(containerEl)
      .setName(this.t("settings.dailyGoal"))
      .setDesc(this.t("settings.dailyGoal.desc"))
      .addText((text) => {
        text.inputEl.type = "number";
        text.inputEl.setAttribute("min", "1");
        text
          .setPlaceholder("5")
          .setValue(String(this.plugin.settings.dailyGoal))
          .onChange(async (value) => {
            const n = parseInt(value, 10);
            this.plugin.settings.dailyGoal =
              Number.isFinite(n) && n > 0 ? n : 5;
            await this.plugin.saveSettings();
            this.plugin.getView()?.refresh();
          });
      });

    new Setting(containerEl)
      .setName(this.t("settings.pageSize"))
      .setDesc(this.t("settings.pageSize.desc"))
      .addText((text) => {
        text.inputEl.type = "number";
        text.inputEl.setAttribute("min", "1");
        text
          .setPlaceholder("50")
          .setValue(String(this.plugin.settings.pageSize))
          .onChange(async (value) => {
            const n = parseInt(value, 10);
            this.plugin.settings.pageSize =
              Number.isFinite(n) && n > 0 ? n : 50;
            await this.plugin.saveSettings();
            this.plugin.getView()?.refresh();
          });
      });

    // 功能开关
    containerEl.createEl("h3", {
      text: this.t("settings.heading.newFeatures"),
    });

    new Setting(containerEl)
      .setName(this.t("settings.smartReview.name"))
      .setDesc(this.t("settings.smartReview.desc"))
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.enableSmartReview)
          .onChange(async (value) => {
            this.plugin.settings.enableSmartReview = value;
            await this.plugin.saveSettings();
            this.plugin.getView()?.refresh();
          })
      );

    new Setting(containerEl)
      .setName(this.t("settings.mood.name"))
      .setDesc(this.t("settings.mood.desc"))
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.enableMoodColoring)
          .onChange(async (value) => {
            this.plugin.settings.enableMoodColoring = value;
            await this.plugin.saveSettings();
            this.plugin.getView()?.refresh();
          })
      );

    new Setting(containerEl)
      .setName(this.t("settings.livePreview.name"))
      .setDesc(this.t("settings.livePreview.desc"))
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.livePreview)
          .onChange(async (value) => {
            this.plugin.settings.livePreview = value;
            await this.plugin.saveSettings();
            new Notice(this.t("notice.saved"));
            this.plugin.getView()?.refresh();
          })
      );

    new Setting(containerEl)
      .setName(this.t("settings.bindFile.name"))
      .setDesc(this.t("settings.bindFile.desc"))
      .addText((text) =>
        text
          .setPlaceholder(this.t("settings.bindFile.placeholder"))
          .setValue(this.plugin.settings.bindFile ?? "")
          .onChange(async (value) => {
            this.plugin.settings.bindFile = value.trim() || null;
            await this.plugin.saveSettings();
            this.plugin.getView()?.refresh();
          })
      )
      .addButton((btn) =>
        btn
          .setButtonText(this.t("settings.bindFile.btn"))
          .onClick(() => {
            new FileSuggestModal(
              this.app,
              this.t("settings.bindFile.placeholder"),
              (file) => {
                this.plugin.settings.bindFile = file.path;
                this.plugin.saveSettings();
                this.display();
              }
            ).open();
          })
      )
      .addButton((btn) =>
        btn
          .setButtonText(this.t("settings.bindFile.clear"))
          .onClick(() => {
            this.plugin.settings.bindFile = null;
            this.plugin.saveSettings();
            this.display();
          })
      );

    new Setting(containerEl)
      .setName(this.t("settings.language"))
      .setDesc(this.t("settings.language.desc"))
      .addDropdown((dropdown) =>
        dropdown
          .addOption("auto", this.t("settings.language.auto"))
          .addOption("zh", this.t("settings.language.zh"))
          .addOption("en", this.t("settings.language.en"))
          .setValue(this.plugin.settings.language)
          .onChange(async (value) => {
            this.plugin.settings.language = value as "auto" | "zh" | "en";
            await this.plugin.saveSettings();
            new Notice(this.t("notice.saved"));
            this.display();
          })
      );

    // 关于
    containerEl.createEl("h3", { text: this.t("settings.heading.about") });

    new Setting(containerEl)
      .setName(this.t("settings.repo.name"))
      .setDesc(this.t("settings.repo.desc"))
      .addButton((btn) =>
        btn
          .setButtonText(this.t("settings.repo.btn"))
          .onClick(() => window.open(REPO_URL, "_blank"))
      );

    const about = containerEl.createDiv({ cls: "muse-settings-about" });
    about.appendText(this.t("settings.about.p1"));
    about.appendText(this.t("settings.version", { ver: this.plugin.manifest.version }));
    about.appendText(this.t("settings.about.p2"));
  }
}
