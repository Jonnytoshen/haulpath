---
version: 1
slug: "src-components-workbench-tsx"
primary_target: "src/components/workbench.tsx"
related_targets: ["src/app/globals.css","src/components/project-library.tsx","src/components/route-overview.tsx","src/components/import-dialog.tsx","src/components/map-panel.tsx"]
---

# 任务画布

Mode: Operate。独立本机线路规划工作台，面向已确认的个人规划者；用户选择任务画布，优先围绕一条线路完成编排、测算与核对。

THESIS: 项目是资料的容器，线路是工作的主角；当前任务占据主工作区。

OWN-WORLD: 保留原创 HaulPath 品牌资产、工作深绿、灰绿导航、纸白工作面、中文系统字体与可读的等宽数字。界面以真实线路、点位和完整方案承载资料。

STORY: 项目总览 → 打开或新建线路 → 编排点位 → 手动测算 → 核对完整方案 → 导出；点位库独立维护，选入线路时进入绑定目标的选择模式。

FIRST VIEWPORT: 左侧项目和项目资源导航、快速切线；主区上方父级返回和线路标题，随后三个任务入口。编排以可滚动有序点位轴占据主区，测算以设置与地图相邻，核对以完整明细与地图相邻。动作条始终在所属任务底部可达。

FORM: 用户选定任务画布；seed eac5de3f，候选第七项。现有视觉系统保持，结构替换。代码优先，无批准视觉稿。

SIGNATURE: 连续从项目点位库选点时始终显示目标线路与即时点数；返回后有序点位轴就是所选顺序。任务切换仅做180ms轻移，减少动态偏好下即时切换。总览返回恢复当前项目会话浏览条件与滚动。

FINISH: 真实浏览器覆盖桌面与窄屏，独立reviewer审查有效截图，文档同步当前任务架构，不把测试高德替身当真实联调。
