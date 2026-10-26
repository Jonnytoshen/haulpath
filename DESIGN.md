---
"name": "重途 · HaulPath"
"description": "白色与浅灰绿工作面，围绕有序点位和完整路线方案组织操作。"
"colors":
  "primary": "#176b55"
  "primary-hover": "#125640"
  "white": "#ffffff"
  "ink": "#243b34"
  "secondary-ink": "#5d6e65"
  "muted-ink": "#65746d"
  "canvas": "#fbfcfb"
  "sidebar": "#f4f7f4"
  "muted": "#f3f6f4"
  "accent": "#eaf2ed"
  "border": "#dfe7e2"
  "control-surface": "#f8faf8"
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
  "failed-bg": "#fff0ed"
  "failed-ink": "#a43a30"
  "running-bg": "#e3f0e8"
  "running-ink": "#25634d"
  "draft-bg": "#f0f3f0"
  "draft-ink": "#5d6f63"
  "notice-bg": "#fcfaf3"
  "notice-ink": "#77602f"
  "notice-border": "#e9e3d3"
  "error-bg": "#fff5f3"
  "error-ink": "#a2372e"
  "error-border": "#f1d1cc"
  "success-bg": "#edf7f0"
  "success-ink": "#205b3d"
  "success-border": "#bed8c7"
"typography":
  "headline":
    "fontFamily": "-apple-system, BlinkMacSystemFont, \"Segoe UI\", \"PingFang SC\", \"Microsoft YaHei\", sans-serif"
    "fontSize": "23px"
    "fontWeight": 650
    "lineHeight": 1.4
    "letterSpacing": "-0.025em"
  "title":
    "fontFamily": "-apple-system, BlinkMacSystemFont, \"Segoe UI\", \"PingFang SC\", \"Microsoft YaHei\", sans-serif"
    "fontSize": "17px"
    "fontWeight": 600
    "lineHeight": 1.55
    "letterSpacing": "-0.015em"
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
    "fontSize": "27px"
    "fontWeight": 600
    "lineHeight": 1
    "letterSpacing": "-0.025em"
"rounded":
  "text": "3px"
  "tag": "4px"
  "control": "6px"
  "navigation": "7px"
  "panel": "12px"
  "circle": "50%"
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
    "padding": "4px 0"
  "button-plan":
    "backgroundColor": "{colors.primary}"
    "textColor": "{colors.white}"
    "typography": "{typography.body}"
    "rounded": "{rounded.control}"
    "padding": "0 15px"
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
    "padding": "2px 7px"
  "status-planned":
    "backgroundColor": "{colors.planned-bg}"
    "textColor": "{colors.planned-ink}"
    "rounded": "{rounded.tag}"
    "padding": "2px 7px"
  "status-stale":
    "backgroundColor": "{colors.stale-bg}"
    "textColor": "{colors.stale-ink}"
    "rounded": "{rounded.tag}"
    "padding": "2px 7px"
  "status-failed":
    "backgroundColor": "{colors.failed-bg}"
    "textColor": "{colors.failed-ink}"
    "rounded": "{rounded.tag}"
    "padding": "2px 7px"
  "status-running":
    "backgroundColor": "{colors.running-bg}"
    "textColor": "{colors.running-ink}"
    "rounded": "{rounded.tag}"
    "padding": "2px 7px"
  "route-navigation":
    "backgroundColor": "transparent"
    "textColor": "{colors.secondary-ink}"
    "rounded": "{rounded.navigation}"
    "padding": "12px"
    "width": "100%"
  "route-navigation-active":
    "backgroundColor": "{colors.white}"
  "point-number":
    "backgroundColor": "#edf2ed"
    "textColor": "#536e5b"
    "rounded": "{rounded.circle}"
    "size": "24px"
---

# Design System: 重途 · HaulPath

## Overview

**Creative North Star: "线路编排台"**

以日间办公桌上的浅色工作面为共同语言：白色承载正在处理的内容，浅灰绿承载导航与辅助区域，深绿标识主动作和当前任务。界面以中文系统无衬线、细边界和短促的状态反馈保持轻量、清晰的办公感。

信息优先服务操作与核对。项目和线路名称允许换行，数值用等宽数字对齐；顺序通过连续编号表达，状态同时使用文字与颜色。布局可以随可用空间收紧，但当前上下文、保存反馈和下一步动作必须可辨认。

**Key Characteristics:**
- 白色内容面与浅灰绿辅助面的温和分层。
- 深绿主动作、细边界、小幅圆角，常驻区域保持平面。
- 中文界面与 Lucide 线性功能图标；数字顺序和数值对齐比装饰更醒目。
- 品牌入口使用原创 H「上扬」标志与 HaulPath 主字标，资产、颜色及尺寸遵循[品牌标志规范](docs/brand.md)。
- 桌面分区滚动，短屏收紧密度，窄屏改为自然纵向阅读。

本文件记录已实现的视觉系统，供新增界面复用。颜色、字体、圆角、间距与基础组件的规范值以顶部 frontmatter 为准；交互、层级、断点与可独立渲染的组件片段位于 `.impeccable/design.json`。工作台的具体任务策略保留在对应 surface brief；产品能力与领域约束以 `PRODUCT.md`、术语表和 ADR 为准。

## Colors

整体是低饱和的灰绿中性色与克制的深绿行动色。前景文字保有绿色倾向，避免大片纯黑造成视觉压力。

### Primary

- **工作深绿**（`primary`）用于手动规划、关键创建动作、当前任务步骤、选中标签页和有效路线折线；悬停使用 `primary-hover`。
- **浅绿回应**（`accent`）用于轻量按钮悬停，提供可见反馈而不抬高层级。

### Neutral

- **纸白**（`white`）用于内容面板、对话框与按钮；**近白画布**（`canvas`）承载主体，**灰绿导航面**（`sidebar`）承载项目和线路。
- **柔和辅助面**（`muted`、`control-surface`）用于弱化背景、规划控制区及尚无结果的提示。
- **深绿墨色**（`ink`）用于正文和标题；**辅助墨色**（`secondary-ink`）用于说明、标签与元数据；`muted-ink` 用于输入占位文字。
- **细灰绿边界**（`border`）分隔面板、表头与区域。次要按钮使用独立的 `button-border`，悬停加深至 `button-hover-border`。

### 状态配色

- 状态标签成对使用 `planned-*`、`stale-*`、`failed-*`、`running-*` 和 `draft-*`，分别表达已规划、待重算、规划失败、规划中与未规划。
- 能力边界说明使用 `notice-*` 的温和米色；操作错误使用 `error-*`，成功反馈使用 `success-*`。破坏性确认按钮单独使用 `danger` 与 `danger-hover`。
- 起点和终点的编号、地图标记与图例保持绿色／赭黄色角色区分；点位库地图标记为蓝灰色。这些是地图与顺序识别用色，不扩大为第二套主动作色。

**The 行动与状态 Rule.** 深绿用于主要行动、当前步骤与选中反馈；成功、待重算和失败必须同时给出文字，不能仅靠颜色区分。

## Typography

**Body Font:** `-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif`。

标题、正文和控件共用这套中文系统字体栈；当前系统没有独立展示字体或等宽字体。标题依靠字号、字重和紧凑字距建立层级，不使用全大写装饰文字。

### Hierarchy

- **Headline**：项目标题；桌面取 `headline`，在 900px 以下缩至 21px，640px 以下缩至 19px。
- **Title**：当前线路名称；取 `title`，手机与短屏桌面缩至 16px。面板标题取 `section`。
- **Body**：正文、表单输入与主要规划按钮的文字基础取 `body`。
- **Control / Label**：常用按钮与点位名称分别以 13px 控件字、12px 标签字组织；说明行通常使用 1.8 行高。
- **Metadata**：坐标、点位角色、保存反馈和状态标签使用 11px；限于次要信息，不替代主操作和字段标签。
- **Metric**：总里程与区间数使用 `metric`；单位退至 12px。结果时间为 12px，保持次级位置。

**The 数值可核对 Rule.** 坐标、里程和序号使用等宽数字；区间里程与累计里程右对齐，保留三位小数的业务展示精度。

## Layout

桌面工作台以视口为边界（宽度大于 900px 时 `100dvh`），外层不滚动。左侧项目与线路导航默认为 248px；主体内边距为上方 24px、两侧 28px。内容区采用两列网格：左列 `minmax(330px, .84fr)`，右列 `minmax(0, 1.45fr)`，间距 20px。此处记录当前工作台的实现范例，不要求所有新界面复制同一列数。

滚动按内容归属划分：项目列表有高度上限，线路列表在导航中滚动；编辑区仅点位列表伸缩滚动，添加点位条与下方规划控制区不收缩；地图与路线方案共用右侧纵向滚动区。点位库的介绍、当前线路、返回入口、工具栏与搜索固定在面板内，只有库列表滚动。列表的 `min-height: 0` 与容器的明确高度关系必须保留，避免内容挤走主操作。

### 响应式与短屏

- **1350px 及以下**：导航缩至 228px；主体两侧 20px、网格间距 16px；网格左列最小 320px；隐藏地图操作尾注与能力说明的重复尾标。
- **901–1100px**：导航为 212px；编排列固定 310px，主体两侧 16px；流程辅助说明收起，结果时间另起一行。
- **900px 及以下**：内容两列改为一列，页面恢复自然纵向滚动；编排面板最小 480px、最大 700px；地图高 330px；导航在侧边保持黏附。
- **640px 及以下**：导航变成顶部条，默认收起，通过带展开状态的菜单按钮访问；主体标题可换行呈现完整项目名。主体两侧 14px，编排面板最小 440px；点位列表最大 440px、点位库列表最大 420px；地图高 320px。内容和表单按可用宽度排列，导入列映射改为单列。
- **桌面且高度不超过 800px**：缩短顶部与流程区、标签页和段落间距；点位行由常规最小 104px 收紧至 74px；添加按钮高 34px，规划按钮高 40px。辅助重复说明收起，主操作与规划状态仍保留。

间距以 frontmatter 的实际重复步长为准：组件细节使用 4–12px，控件组与面板内部主要使用 14–24px。面板之间保留明确间隔，避免将每行都包装成独立卡片。

## Elevation & Depth

主工作面采用底色和细线分层，常驻面板与按钮不加投影。地图上的搜索、候选列表和标记需要从真实底图中浮起；模态对话框使用遮罩和更强的投影形成明确的操作层级。

### Shadow Vocabulary

- **地图搜索条**：`0 3px 16px #183e281a`；仅用于地图上方浮动的搜索输入。
- **地图候选列表**：`0 5px 20px #183e2826`；用于搜索结果层。
- **地图标记**：`0 2px 5px #203e4026`；与白色描边一起保证编号从底图中分离。
- **模态窗口**：Tailwind `shadow-2xl`，当前值为 `0 25px 50px -12px rgb(0 0 0 / 0.25)`；遮罩使用半透明深色与 2px 背景模糊。

**The 平面工作面 Rule.** 常驻导航和内容面用底色、细边界与间距分层。阴影只承担地图浮层、地图标记及模态窗口的层级提示。

## Shapes

主面板和对话框使用柔和大圆角（`panel`），控件使用小圆角（`control`），项目与线路导航项使用略宽的 `navigation` 圆角。状态与计数标签取 `tag`，文字按钮取 `text`。细边界通常为 1px，不以粗描边制造层级。

编号与地图标记使用正圆，连接线为单像素竖线；标签页以底部 2px 直线表达选中，不套成胶囊。地图内部裁切在面板中，表格允许横向滚动。导入文件区以虚线边界表达文件输入。

## Components

### Buttons

主按钮直接、稳定；次要操作保留明确触发面，轻量操作采用文字或透明底。

- **Primary / Secondary**：遵循 `button-primary` 与 `button-secondary`。常用高度 38px、内边距 `0 13px`；主按钮深绿填充，次要按钮白底细描边。
- **Planning**：宽度填满编排列，高 42px；文字与路线图标分列两端，短屏桌面收紧为 40px。添加点位条和规划控制区均在编辑滚动区外。读取配置或缺少 Web 服务配置时禁用，并在按钮旁说明原因及提供配置帮助；JS 地图配置独立判断。
- **Ghost / Text / Icon**：透明底按钮以浅绿悬停；文字按钮悬停加下划线；图标按钮通常 34px 正方形，点位行使用紧凑的二维按钮组。
- **Danger**：仅破坏性确认使用红色实底；常驻删除入口为低强调图标或文字。项目、线路与点库永久删除先确认目标和后果；线路中的点位移除使用成功反馈中的撤销入口。
- **Hover / Focus / Disabled**：颜色过渡使用 Tailwind 默认 150ms、`cubic-bezier(0.4, 0, 0.2, 1)`；按钮保留 2px 主题色焦点环。禁用降低为 50% 不透明度并阻止触发；不新增位移或弹跳反馈。

### Inputs / Fields

输入与原生选择框采用细描边、小圆角、横向 12px 与纵向 8px 内边距；基础高度 40px，模态表单最小 42px，侧栏搜索为 36px。字段标签位于上方，间距 8px；字段间距 18px。

键盘聚焦使用主题色边界与 20% 主题色的 2px 环；输入的 `aria-invalid` 使用破坏性色边界，错误信息另以中文提示呈现。禁用保持 50% 不透明度。地图搜索输入的外框由整个搜索条承担，避免内外双重描边。

### Navigation

项目导航按名称换行；选中项目使用浅绿底、深绿字和勾选标识。线路项由名称、点位数与状态组成；选中线路为白底、浅绿边界，悬停以灰绿底回应。项目与线路选择后保留主体上下文。

编辑内容切换采用两个文字标签页，以深绿文字和底线表达当前项，并提供按下状态。手机的导航默认收起，展开按钮的可访问名称和 `aria-expanded` 同步更新。

### Chips / Status

状态采用紧凑矩形标签：小圆角、轻底色、中文状态文字，字重 450、字号 11px；不是筛选按钮，不增加悬停或按压反馈。计数使用等宽数字。待重算和失败在规划区补充可行动的说明。

### Cards / Containers

白色主面板包含独立标题行、细分隔线与内容区，标题行通常最小高 54px、左右 20px。地图、结果与编排器共享此容器语言；内部列表按行分隔，避免重复套卡。能力边界提示常驻顶部，明确显示“未校验重卡限高、限重及货车限行”。

### 有序点位轴

点位行使用拖动手柄、24px 编号圆、角色／名称／坐标三行信息，以及编辑／上移／下移／移除按钮。编号圆居于一条单像素连接轴上，起点为浅绿，终点为浅赭黄，中间点为中性灰绿。最后一点不继续绘制连接线。

拖动时点位行降低至 50% 不透明度，并带浅绿底；键盘焦点进入行内控件时整行底色轻微变化。顺序变更立即更新编号与起终点角色；同时保留上移和下移按钮，不能只提供拖动。最近一次成功移除可在当前线路撤销；恢复仅插回原点位，保留后续编辑与顺序，不回滚路线方案。切换项目／线路或关闭提示后清除撤销入口。

### 点位库上下文与地图／结果

点位库在列表之前持续显示当前线路、已添加点数和返回入口。选入点位后留在点位库，点数即时更新，支持连续选点；成功提示作为右下角可关闭反馈，不替代当前线路上下文。每个点库操作的可访问名称包含点位名称；永久删除确认说明线路副本保留。

地图使用真实高德底图；未配置或加载失败时显示文字占位、配置说明或重试入口，不展示虚构折线。点位编号与编排轴一致，有效路线以主题深绿折线显示。结果以总里程、区间数、北京时间与明细表组织；两个里程列右对齐。待重算时不显示旧折线、当前里程或旧明细，用文字解释下一步。

对话框宽度为视口减 32px、普通最大 512px，导入最大 896px，最高 90vh 并内部滚动；底部动作条保持可达。隐藏说明对应表单、删除确认或只读帮助的实际用途；关闭后焦点返回仍存在的触发入口。减少动态效果偏好下，所有过渡和动画时长降至 0.01ms，滚动恢复即时。

## Do's and Don'ts

### Do:
- Do 沿用白色内容面、浅灰绿辅助面与深绿主动作，优先用空间和边界区分区域。
- Do 保持项目、线路与点位的名称可读；长名称换行，移动端仍在主体标题中呈现完整项目名称。
- Do 将长列表放入其所属滚动区，保留添加入口、规划偏好和手动规划按钮的可达性。
- Do 对已规划、规划中、待重算、失败和未规划状态给出中文文字，并让无有效结果的数值显示为空缺。
- Do 为键盘操作保留焦点环、跳转链接和点位上移／下移按钮；尊重减少动态效果偏好。

### Don't:
- Don't 为常驻面板添加装饰性投影或背景渐变。
- Don't 用颜色替代点位编号、起终点角色或状态文字。
- Don't 把过期方案的折线和里程当作当前结果继续强调。
- Don't 让长点位库推动当前线路上下文、返回入口或搜索框离开各自面板。
- Don't 用 emoji 取代 Lucide 图标，或将地图占位区画成可误认为真实路线的示意地图。
