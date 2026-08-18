# MuseView

MuseView 是一个碎片笔记风格的 Obsidian 插件，采用标准 TypeScript 插件写法实现，
界面交互清晰、源码结构可读、便于扩展。

## 已实现

- **存储模型**：每条 memo 对应 vault 内的一个 Markdown 文件 `<folder>/<id>.md`，
  元数据（创建/修改时间、置顶、星标）写入 frontmatter 的 `muse` 字段，正文为纯文本、
  内联 `#标签`（符合 Obsidian 习惯，可被搜索直接识别）。
- **自定义编辑器**（`src/editor/MuseEditor.ts`，`LivePreviewEditor`）：输入卡内容编辑器，
  采用受控 `source[]` 数组驱动渲染——光标行以源码态（`is-active`，保留 `#`/`**` 等标记）
  呈现，其余行走 Obsidian `MarkdownRenderer` 富文本态（`is-rendered`）。支持标题 `#`、行内
  Markdown 高亮、`Ctrl/Cmd+A` 全选源码模式、IME 中文输入兼容、多行纯文本粘贴拆行；并对
  「删除末行 / 全选删除后根下游离文本」做兜底，保证始终有可识别的行。
- **主视图**（`src/view/MuseView.ts`，`ItemView`）：左侧栏（统计 / 导航 / 标签云）、
  顶栏（标题 + 实时搜索）、输入卡（自动高度、渐进式展开、工具栏、`#标签` 联想、
  Enter/Cmd+Enter 发送）、列表（按日期分组、Markdown 正文、标签胶囊、置顶/星标/编辑/删除）、
  编辑弹窗、图片灯箱、外部 vault 变更自动刷新。
- **设置页**（`src/settings.ts`，`PluginSettingTab`）：文件夹、附件目录、保存后清空、
  侧栏标签、回收站、密度、发送快捷键、语言、每日目标等。
- **i18n**（`src/i18n.ts`）：中/英，跟随 Obsidian 语言或手动指定。
- **命令 / ribbon**：打开视图、快速记录（聚焦输入框）。


## 目录结构

```
muse-view/
├── manifest.json          # 插件元信息
├── styles.css             # 主题感知样式（含密度模式）
├── data.json              # 本地示例设置（已被 .gitignore 排除，不纳入版本控制）
├── package.json           # devDeps: obsidian / esbuild / typescript
├── tsconfig.json
├── esbuild.config.mjs     # 输出 CJS main.js，obsidian 保持外部依赖
├── versions.json
├── .gitignore
└── src/
    ├── main.ts            # 入口：注册视图/ribbon/命令/设置
    ├── types.ts           # Memo / MemoMeta 等类型与视图类型常量
    ├── i18n.ts            # 中英文案 + 翻译函数
    ├── settings.ts        # MuseViewSettings + 默认 + 设置页
    ├── store.ts           # MemoStore：Markdown 读写、列表/增删/置顶星标/标签聚合
    ├── parser.ts          # 标签/图片提取、Markdown 渲染封装、日期分组
    ├── editor/
    │   └── MuseEditor.ts  # 自定义 contenteditable 编辑器（LivePreviewEditor）
    ├── globals.d.ts       # window.moment 环境声明
    └── view/
        └── MuseView.ts # 主视图与全部交互
```

## 构建与运行

```bash
npm install          # 安装依赖（obsidian / esbuild / typescript）
npm run build        # tsc 类型检查 + esbuild 产出 main.js（已验证通过）
# 或开发模式（带 watch）：
npm run dev
```

将整个文件夹放入 vault 的 `.obsidian/plugins/muse-view/`，在
「设置 → 第三方插件」中启用即可。

## 验证状态

- 代码严格对照 Obsidian 官方 API（`ItemView` / `PluginSettingTab` / `Modal` /
  `MarkdownRenderer` / `vault` 文件操作 / `parseYaml`+`stringifyYaml` 等）编写。
- 已通过 `tsc` 类型检查与 `esbuild` 打包，产出 `main.js` 可直接放入 vault 的
  `.obsidian/plugins/muse-view/` 启用。
