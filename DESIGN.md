---
"name": "重途 · HaulPath"
"description": "白色与浅灰绿工作面，以项目资源和当前线路任务组织操作。"
"colors":
  "primary": "#176b55"
  "primary-hover": "#125640"
  "white": "#ffffff"
  "ink": "#243b34"
  "secondary-ink": "#5d6e65"
  "muted-ink": "#65746d"
  "canvas": "#fbfcfb"
  "sidebar": "#f3f6f4"
  "muted": "#f3f6f4"
  "accent": "#eaf2ed"
  "border": "#dfe7e2"
  "button-ink": "#385247"
  "button-border": "#d7e1da"
  "button-hover": "#f1f6f2"
  "button-hover-border": "#b4c9bc"
  "danger": "#b43a36"
  "danger-hover": "#942c29"
  "planned-bg": "#eaf5ec"
  "planned-ink": "#276340"
  "stale-bg": "#faf1dc"
  "stale-ink": "#825e20"
  "failed-ink": "#a43a30"
  "draft-bg": "#f0f3f0"
  "draft-ink": "#5d6f63"
  "notice-bg": "#f6f2e7"
  "notice-ink": "#735d2e"
  "error-bg": "#fff5f3"
  "error-ink": "#a2372e"
  "error-border": "#f1d1cc"
  "success-bg": "#edf7f0"
  "success-ink": "#205b3d"
  "success-border": "#bed8c7"
  "surface": "#f7f9f7"
  "selected-surface": "#edf4ef"
  "context-ink": "#305e46"
  "row-border": "#edf1ed"
"typography":
  "headline":
    "fontFamily": "-apple-system, BlinkMacSystemFont, \"Segoe UI\", \"PingFang SC\", \"Microsoft YaHei\", sans-serif"
    "fontSize": "24px"
    "fontWeight": 650
    "lineHeight": 1.4
    "letterSpacing": "-0.025em"
  "title":
    "fontFamily": "-apple-system, BlinkMacSystemFont, \"Segoe UI\", \"PingFang SC\", \"Microsoft YaHei\", sans-serif"
    "fontSize": "19px"
    "fontWeight": 600
    "lineHeight": 1.5
    "letterSpacing": "-0.02em"
  "section":
    "fontFamily": "-apple-system, BlinkMacSystemFont, \"Segoe UI\", \"PingFang SC\", \"Microsoft YaHei\", sans-serif"
    "fontSize": "14px"
    "fontWeight": 600
    "lineHeight": 1.5
  "body":
    "fontFamily": "-apple-system, BlinkMacSystemFont, \"Segoe UI\", \"PingFang SC\", \"Microsoft YaHei\", sans-serif"
    "fontSize": "14px"
    "fontWeight": 400
    "lineHeight": 1.5
  "control":
    "fontFamily": "-apple-system, BlinkMacSystemFont, \"Segoe UI\", \"PingFang SC\", \"Microsoft YaHei\", sans-serif"
    "fontSize": "13px"
    "fontWeight": 550
    "lineHeight": 1.5
  "label":
    "fontFamily": "-apple-system, BlinkMacSystemFont, \"Segoe UI\", \"PingFang SC\", \"Microsoft YaHei\", sans-serif"
    "fontSize": "12px"
    "fontWeight": 550
    "lineHeight": 1.5
  "metadata":
    "fontFamily": "-apple-system, BlinkMacSystemFont, \"Segoe UI\", \"PingFang SC\", \"Microsoft YaHei\", sans-serif"
    "fontSize": "11px"
    "fontWeight": 400
    "lineHeight": 1.5
  "metric":
    "fontFamily": "-apple-system, BlinkMacSystemFont, \"Segoe UI\", \"PingFang SC\", \"Microsoft YaHei\", sans-serif"
    "fontSize": "30px"
    "fontWeight": 600
    "lineHeight": 1
    "letterSpacing": "-0.025em"
  "item-title":
    "fontFamily": "-apple-system, BlinkMacSystemFont, \"Segoe UI\", \"PingFang SC\", \"Microsoft YaHei\", sans-serif"
    "fontSize": "14px"
    "fontWeight": 550
    "lineHeight": 1.5
"rounded":
  "text": "3px"
  "tag": "4px"
  "control": "6px"
  "navigation": "6px"
  "panel": "12px"
  "circle": "50%"
  "floating": "7px"
"spacing":
  "4": "4px"
  "6": "6px"
  "8": "8px"
  "10": "10px"
  "12": "12px"
  "14": "14px"
  "16": "16px"
  "18": "18px"
  "20": "20px"
  "22": "22px"
  "24": "24px"
  "28": "28px"
"components":
  "button-primary":
    "backgroundColor": "{colors.primary}"
    "textColor": "{colors.white}"
    "typography": "{typography.control}"
    "rounded": "{rounded.control}"
    "padding": "0 13px"
    "height": "38px"
  "button-primary-hover":
    "backgroundColor": "{colors.primary-hover}"
    "textColor": "{colors.white}"
  "button-secondary":
    "backgroundColor": "{colors.white}"
    "textColor": "{colors.button-ink}"
    "typography": "{typography.control}"
    "rounded": "{rounded.control}"
    "padding": "0 13px"
    "height": "38px"
  "button-secondary-hover":
    "backgroundColor": "{colors.button-hover}"
  "button-ghost":
    "backgroundColor": "transparent"
    "textColor": "{colors.button-ink}"
    "typography": "{typography.control}"
    "rounded": "{rounded.control}"
    "padding": "0 13px"
    "height": "38px"
  "button-ghost-hover":
    "backgroundColor": "{colors.accent}"
  "button-danger":
    "backgroundColor": "{colors.danger}"
    "textColor": "{colors.white}"
    "typography": "{typography.control}"
    "rounded": "{rounded.control}"
    "padding": "0 13px"
    "height": "38px"
  "button-danger-hover":
    "backgroundColor": "{colors.danger-hover}"
  "button-text":
    "backgroundColor": "transparent"
    "textColor": "{colors.primary}"
    "typography": "{typography.label}"
    "rounded": "{rounded.text}"
    "padding": "3px 0"
  "button-plan":
    "backgroundColor": "{colors.primary}"
    "textColor": "{colors.white}"
    "typography": "{typography.control}"
    "rounded": "{rounded.control}"
    "padding": "0 13px"
    "height": "42px"
    "width": "100%"
  "input":
    "backgroundColor": "transparent"
    "textColor": "{colors.ink}"
    "typography": "{typography.body}"
    "rounded": "{rounded.control}"
    "padding": "8px 12px"
    "height": "40px"
    "width": "100%"
  "panel":
    "backgroundColor": "{colors.white}"
    "textColor": "{colors.ink}"
    "rounded": "{rounded.panel}"
  "status-draft":
    "backgroundColor": "{colors.draft-bg}"
    "textColor": "{colors.draft-ink}"
    "rounded": "{rounded.tag}"
    "padding": "2px 6px"
  "status-planned":
    "backgroundColor": "{colors.planned-bg}"
    "textColor": "{colors.planned-ink}"
    "rounded": "{rounded.tag}"
    "padding": "2px 6px"
  "status-stale":
    "backgroundColor": "{colors.stale-bg}"
    "textColor": "{colors.stale-ink}"
    "rounded": "{rounded.tag}"
    "padding": "2px 6px"
  "route-navigation":
    "backgroundColor": "transparent"
    "textColor": "#3d584b"
    "rounded": "{rounded.navigation}"
    "padding": "13px 10px"
    "width": "100%"
  "route-navigation-active":
    "backgroundColor": "{colors.white}"
    "textColor": "#184f3c"
  "point-number":
    "backgroundColor": "#eef2ef"
    "textColor": "#536c5e"
    "rounded": "{rounded.circle}"
    "size": "27px"
  "task-navigation":
    "backgroundColor": "transparent"
    "textColor": "{colors.secondary-ink}"
    "padding": "6px 18px 16px"
    "width": "100%"
  "task-navigation-active":
    "backgroundColor": "{colors.selected-surface}"
    "textColor": "{colors.primary}"
  "library-selection-context":
    "backgroundColor": "{colors.selected-surface}"
    "textColor": "{colors.context-ink}"
    "padding": "15px 20px"
    "width": "100%"
---

# Design System: 重途 · HaulPath

## Overview

**Creative North Star: "线路编排台"**

以日间办公桌上的浅色工作面为共同语言：白色承载正在处理的内容，浅灰绿承载导航与辅助区域，深绿标识主动作和当前任务。界面以中文系统无衬线、细边界和短促的状态反馈保持轻量、清晰的办公感。

信息优先服务操作与核对。项目资源提供稳定的资料上下文，当前线路在主工作区内展开；名称允许换行，数值用等宽数字对齐，顺序通过连续编号表达，状态同时使用文字与颜色。布局随空间收紧，但当前对象、保存反馈和下一步动作必须可辨认。

**Key Characteristics:**
- 白色内容面与浅灰绿辅助面的温和分层。
- 深绿主动作、细边界、小幅圆角，常驻区域保持平面。
- 中文界面与 Lucide 线性功能图标；数字顺序和数值对齐比装饰更醒目。
- 品牌入口使用原创 H「上扬」标志与 HaulPath 主字标，资产、颜色及尺寸遵循[品牌标志规范](docs/brand.md)。
- 桌面分区滚动，短屏收紧密度，窄屏改为自然纵向阅读。

本文件记录已实现的视觉系统，供新增界面复用。颜色、字体、圆角、间距与基础组件的规范值以顶部 frontmatter 为准；深度、动效、断点与可独立渲染的组件片段位于 `.impeccable/design.json`。本次任务画布的方向合同位于[工作台 surface brief](.impeccable/surfaces/src-components-workbench-tsx.md)；产品能力与领域约束以 `PRODUCT.md`、术语表和 ADR 为准。

## Colors

整体是低饱和的灰绿中性色与克制的深绿行动色。前景文字保有绿色倾向，避免大片纯黑造成视觉压力。

### Primary

- **工作深绿**（`primary`）用于手动规划、关键创建动作、当前线路任务、选中反馈和有效路线折线；悬停使用 `primary-hover`。
- **浅绿回应**（`accent`）用于轻量按钮悬停；**任务与目标浅绿**（`selected-surface`）用于当前任务、点库选择目标和导入目的地提示，不扩大为第二套主动作色。

### Neutral

- **纸白**（`white`）用于内容面板、对话框与按钮；**近白画布**（`canvas`）承载主体，**灰绿导航面**（`sidebar`、`muted`）承载项目、项目资源与线路。
- **柔和表头面**（`surface`）用于点位库列标题；**细灰绿边界**（`border`）分隔面板与区域，**行分隔线**（`row-border`）分隔点位、库资料与结果表格。
- **深绿墨色**（`ink`）用于正文和标题；**辅助墨色**（`secondary-ink`）用于说明、标签与元数据；`muted-ink` 用于输入占位文字，`context-ink` 用于选择目标与导入目的地说明。
- 次要按钮使用独立的 `button-ink` 与 `button-border`，悬停使用 `button-hover` 与 `button-hover-border`。

### 状态配色

- 线路结果标签只表达已规划、待重算与未规划，分别使用 `planned-*`、`stale-*` 和 `draft-*`。任务进度通过按钮与进度条表达；失败通过 `failed-ink` 的文字提示表达，结果有效性与任务成败分别判断。
- 能力边界说明使用 `notice-*` 的温和米色；操作错误使用 `error-*`，成功反馈使用 `success-*`。破坏性确认按钮单独使用 `danger` 与 `danger-hover`。
- 起点与终点的编号、地图标记和图例保持绿色／赭黄色角色区分，项目点位库地图标记为蓝灰色。这些局部识别用色不扩为品牌主色；一次性辅助色也不提升为系统 token。

**The 行动与状态 Rule.** 深绿用于主要行动、当前任务与选中反馈；成功、待重算和失败必须同时给出文字，不能仅靠颜色区分。

## Typography

**Body Font:** `-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif`。

标题、正文和控件共用这套中文系统字体栈；当前系统没有独立展示字体或等宽字体。标题依靠字号、字重和紧凑字距建立层级，不使用全大写装饰文字。

### Hierarchy

- **Headline**：主体顶部当前线路、项目或资源页名称取 `headline`，手机缩至 21px；项目归属与父级返回入口置于其上。
- **Title / Section**：对话框标题取 `title`；面板标题取 `section`。任务标签、点位名称与选择目标名称取 `item-title`，手机任务标签缩至 12px、点位名称缩至 13px。
- **Body**：正文和表单输入取 `body`；常用按钮与偏好选择框使用 `control`。
- **Label**：字段说明与轻量操作取 `label`，较长说明通常使用 1.8–1.9 行高。
- **Metadata**：角色、保存反馈和结果标签取 `metadata`；手机点位坐标与任务辅助说明可缩至 10px，仅承载次要信息。
- **Metric**：总里程与区间数取 `metric`，手机缩至 28px；单位退至 12px，有效结果时间也保持 12px 的次级位置。

**The 数值可核对 Rule.** 坐标、里程和序号使用等宽数字；区间里程与累计里程右对齐，保留三位小数的业务展示精度。

## Layout

桌面以视口为边界（宽度大于 900px 时 `100dvh`），外层不滚动。左侧导航常规宽 236px，按“项目 → 项目资源 → 项目线路”分层；主体使用上方 24px、两侧 30px 的内边距。主体标题持续显示当前对象、项目归属和父级返回入口，能力边界提示位于标题之后。

### 当前工作台的空间范例

- 项目默认进入线路总览；线路总览与项目点位库是并列资源入口，侧栏另保留线路搜索、快速切线与继续编辑入口。总览七列表格最小宽度 1160px，表内双向滚动、固定表头；返回恢复当前项目会话的搜索、筛选、排序、展开与滚动。
- 打开或新建线路默认进入编排。三个等宽任务入口“编排点位／测算线路／核对方案”位于线路标题和能力提示之后，可自由切换。任务画布占据剩余空间，常规列间距 24px；任务底部独立显示保存反馈、返回或下一步动作。
- 编排采用 `minmax(0,1fr) 250px`：主列为有序点位，辅助列为行程说明。点位列表独立滚动，添加入口在面板底部，不随列表滚走。
- 测算采用 `320px minmax(0,1fr)`：偏好、范围、就绪原因、手动规划与进度集中在设置面板，地图占据另一列。设置面板在空间不足时内部滚动。
- 核对采用 `minmax(0,1.25fr) minmax(300px,.9fr)`：完整方案、里程和明细为主列，地图为另一列；结果表格最小宽度 510px，允许表内横滚。地图只出现在测算与核对任务中。
- 项目点位库使用单独的全宽资料面板。桌面上标题、选择目标（仅选择模式）、搜索、列标题与底部说明不收缩，只有库列表滚动；容器使用 `overflow: clip`，保留窄屏目标条的黏附行为。独立管理时不带线路目标、选入按钮、线路地图或方案。

上述列数是当前工作台的实现范例，不要求其他新界面复制。长列表保留 `min-height: 0` 与明确高度关系，防止挤走本任务动作。

### 响应式与短屏

- **1300px 及以下**：侧栏缩至 218px，主体两侧 22px；编排辅助列缩至 210px、列间距 20px，点位操作变为两列按钮；测算设置列缩至 290px、列间距 18px。隐藏重复地图尾注和能力说明尾标，点库列同步收紧。
- **1100px 及以下**：编排变为单列并隐藏辅助说明；核对改为纵向滚动，地图最小高 340px，结果面板最小高 350px。点库暂时隐藏独立坐标系一列。
- **900px 及以下**：页面恢复自然纵向滚动，侧栏宽 210px 并在顶部黏附；主体两侧 18px，测算改为单列。编排面板最小高 440px、最大高 700px，地图面板最小高 380px。总览与库列表最大高 65dvh；点库改为资料行，恢复行内坐标系标签，操作位于右侧，选择目标条在页面顶部黏附（`top: 0`）。任务图标、完成勾选收起，任务文字与状态仍可读。
- **640px 及以下**：导航变成顶部条，默认收起，通过具备展开状态的菜单按钮访问；主体两侧 14px，标题、工具条和底部动作允许换行。三个任务保持等宽，序号收起；编排面板最小高 420px、点位滚动区最大高 52dvh，地图面板最小高 365px。点库搜索独占一行，目标线路名称完整换行；导入列映射改为单列。
- **桌面且高度不超过 800px**：主体顶部缩至 16px，任务导航高度缩至最小 58px，面板标题缩至最小 54px，点位行由常规最小 100px 收紧至 88px。压缩设置与页脚间距，保留任务导航、添加入口、规划原因与底部动作。

间距以 frontmatter 的实际重复步长为准：组件细节使用 4–12px，控件组与面板内部主要使用 14–24px。面板之间保留明确间隔，避免将每行都包装成独立卡片。

## Elevation & Depth

主工作面采用底色和细线分层，常驻面板与按钮不加投影。地图浮层需要从真实底图中浮起，成功反馈以轻微投影区别于当前资料；模态对话框使用遮罩和更强投影形成明确操作层级。

### Shadow Vocabulary

- **地图搜索条**：`0 3px 16px #183e281a`；仅用于地图上方浮动搜索输入。
- **地图候选列表**：`0 5px 20px #183e2826`；用于搜索结果层。
- **地图标记**：`0 2px 5px #203e4026`；与白色描边共同分离编号和底图。
- **成功反馈**：`0 6px 24px #173d2620`；用于工作区右上方可关闭的成功提示及撤销入口，按正常布局排列，为标题工具栏和任务按钮留出空间，窄屏随工作区宽度换行。
- **模态窗口**：Tailwind `shadow-2xl`，当前值为 `0 25px 50px -12px rgb(0 0 0 / 0.25)`；遮罩使用半透明深色与 2px 背景模糊。

**The 平面工作面 Rule.** 常驻导航和内容面用底色、细边界与间距分层。阴影只承担地图浮层、地图标记、通知反馈及模态窗口的层级提示。

## Shapes

主面板和对话框使用柔和大圆角（`panel`），控件与导航项使用小圆角（`control`、`navigation`），地图搜索浮层使用 `floating`。状态与计数标签取 `tag`，文字按钮取 `text`；细边界通常为 1px。

编号与地图标记使用正圆，点位连接轴为单像素竖线。任务入口用平直的 2px 底线和浅绿底表达选中，不套为胶囊。地图内部裁切在面板中，表格允许横向滚动；导入文件区以虚线边界表达文件输入。

## Components

### Buttons

主按钮直接、稳定；次要操作保留明确触发面，轻量操作采用文字或透明底。

- **Primary / Secondary**：遵循 `button-primary` 与 `button-secondary`，常用高度 38px、内边距 `0 13px`；主按钮深绿填充，次要按钮白底细描边。
- **Planning**：在测算设置面板中全宽、高 42px，文字与路线图标分列两端。配置读取中、缺少 Web 服务配置、不足两个点或已有规划运行时禁用，原因始终紧邻按钮；缺少配置时提供帮助入口，JS 地图配置独立判断。
- **Ghost / Text / Icon**：透明底按钮以浅绿悬停，文字按钮悬停加下划线；常规图标按钮 34px 正方形，点位行使用更紧凑的按钮组。
- **Danger**：仅破坏性确认使用红色实底；常驻删除入口为低强调图标或文字。项目、线路与点库永久删除先确认对象与后果；线路点位移除通过成功反馈提供撤销。
- **Hover / Focus / Disabled**：颜色过渡使用 Tailwind 默认 150ms、`cubic-bezier(0.4, 0, 0.2, 1)`；按钮保留 2px 主题色焦点环。禁用降低为 50% 不透明度并阻止触发，不添加按钮位移或弹跳。

### Inputs / Fields

输入与原生选择框采用细描边、小圆角、横向 12px 与纵向 8px 内边距。基础高度 40px，模态字段最小 42px，侧栏和点库搜索为 37px；标签位于字段上方，间距 8px，字段间距 18px。

规划偏好在测算任务中使用全宽原生分组选择框，按“常用偏好／组合偏好／其他策略”分组。当前项说明紧随选择框，通过描述关联供辅助技术读取，允许自然换行。切换任务本身不保存偏好或触发规划。

键盘聚焦使用主题色边界与 20% 主题色的 2px 环；`aria-invalid` 使用破坏性色边界，并另有中文错误说明。禁用保持 50% 不透明度；地图搜索由整个搜索条承担外框，避免双重描边。

### Navigation

侧栏将项目选择、项目资源和快速切线分层。项目名称可换行，选中项目用浅绿底、深绿字与勾选标识；项目资源与当前线路用白底表达选中。线路项包含名称、点位数和结果状态，悬停用灰绿底反馈。

线路内的三个任务入口使用序号、Lucide 图标、任务名和辅助状态，选中项用深绿字、浅绿底与底线，同时提供按下状态及当前步骤语义。它们是可自由切换的任务导航；完成勾选和辅助文字只传达点数、任务运行或有效结果情况，不锁定下一步。切换采用 180ms、`cubic-bezier(.16,1,.3,1)` 的 4px 上移进入；减少动态效果偏好下即时切换。手机项目导航默认收起，菜单按钮名称与 `aria-expanded` 同步。

### Chips / Status

线路结果标签采用小圆角、轻底色、11px 中文文字与 450 字重，只显示未规划、已规划或待重算，不充当筛选按钮。任务进度、失败原因与结果标签分别呈现：运行中显示已完成／总区间数与进度条；失败提供手动重试；同输入重算失败时，仍可核对和导出当前有效的完整旧方案。

### Cards / Containers

白色主面板包含独立标题行、细分隔线与内容区；标题行常规最小高 62px、左右 20px。地图、结果和编排共用容器语言，内部列表按行分隔。能力边界提示常驻标题之后，明确写出“未校验重卡限高、限重及货车限行”。

任务动作条位于画布之后、页脚之前，显示本机自动保存反馈及本任务的返回／下一步动作。项目导出位于项目级工具条，当前线路导出位于核对方案标题行，作用域由位置和文字共同表达；打开、切换任务或导出均不自动测算。

### 有序点位轴

点位行由拖动手柄、27px 编号圆、角色／名称／坐标信息和编辑／上移／下移／移除按钮组成。编号圆位于单像素连接轴上，起点浅绿、终点浅赭黄、中间点中性灰绿，末点不继续绘制连接线。

拖动时点位行降至 50% 不透明度并显示浅绿底，行内控件获焦时整行底色轻微变化。顺序变化立即更新编号和角色，始终保留上移／下移按钮。空线路提供添加入口，单点草稿提示继续添加；最近一次成功移除可在当前线路撤销，切换项目／线路或关闭提示后清除撤销入口。

### 项目点位库与选择目标

独立管理模式呈现项目资料、添加／导入／模板、搜索、编辑与删除，不隐式选中线路。选择模式以同一资料面板呈现，并持续显示目标线路、已添加点数与“返回线路点位”；每行额外提供“选入线路”。选入后保留选择模式、点数即时更新，支持连续选点，返回后按选择顺序追加到编排轴。

桌面资料按名称、地图坐标、原始坐标系、操作排列；窄屏改为名称与坐标的纵向资料行，操作位于右侧。库操作的可访问名称包含点位名称，底部说明与删除确认均明确线路副本独立保留。成功提示不能替代目标条，窄屏目标条在页面顶部黏附。

### 地图、方案与导入

地图使用真实高德底图，编号与编排轴一致，有效路线以主题深绿折线显示。未配置或加载失败时显示真实原因、配置说明或重试入口，不展示虚构折线。无有效结果时里程显示空缺并引导前往测算；待重算时不显示旧折线、当前里程或旧明细，以文字说明旧方案保留及重新规划的下一步。

导入在独立模态中分为“选择文件与列”和“预览并确认有效行”，先映射与声明坐标系，再确认选中的有效行。目的地区明确写为当前项目点位库；来自选择模式时追加目标线路与导入后的继续选入说明，不自动加入线路。

对话框宽度为视口减 32px、普通最大 512px，导入最大 896px，最高 90vh 并内部滚动，底部动作条保持可达。关闭后焦点返回仍存在的触发入口。减少动态效果偏好下，所有过渡和动画时长降至 0.01ms，滚动恢复即时。

## Do's and Don'ts

### Do:
- Do 沿用白色内容面、浅灰绿辅助面与深绿主动作，优先用空间和边界区分区域。
- Do 保持项目、线路与点位的名称可读；长名称换行，移动端仍呈现完整当前对象与项目归属。
- Do 将长列表放入所属滚动区，保留本任务的添加入口、测算原因与底部动作；窄屏选择模式保留黏附目标条。
- Do 用中文标签表达三类结果状态，用任务进度与错误提示表达规划中和失败，无有效结果时数值显示为空缺。
- Do 为键盘操作保留焦点环、跳转链接和点位上移／下移按钮，尊重减少动态效果偏好。

### Don't:
- Don't 为常驻面板添加装饰性投影或背景渐变。
- Don't 用颜色替代点位编号、起终点角色或状态文字。
- Don't 把过期方案的折线和里程当作当前结果继续强调。
- Don't 用成功提示替代选择模式的目标线路、即时点数与返回入口。
- Don't 用 emoji 取代 Lucide 图标，或将地图占位区画成可误认为真实路线的示意地图。
