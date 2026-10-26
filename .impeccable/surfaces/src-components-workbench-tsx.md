---
version: 1
slug: "src-components-workbench-tsx"
primary_target: "src/components/workbench.tsx"
related_targets: ["src/app/globals.css", "src/components/route-overview.tsx", "src/components/map-panel.tsx", "src/components/import-dialog.tsx"]
---

# 项目线路总览与工作台

Mode: Operate。面向本机电脑上的个人线路规划者，沿用用户已确认的灰绿线路编排台和 code-led 扩展。项目总览用于核对、比较与打开线路，编辑、手动规划与点库沿用工作台。规格为 `.scratch/haulpath-route-overview/spec.md`。

## Direction contract

THESIS: 当前项目的线路核对台。进入项目先比较所有有序安排、结果有效性与任务进度，再打开一条继续处理。

OWN-WORLD: 延续线路编排台的纸白内容、浅灰绿导航、工作深绿动作、中文系统无衬线、细边界和小圆角；真实表格行承载资料，数字对齐，状态始终有文字。

STORY: 默认查看总览 → 查找/筛选/排序/展开核对 → 按线路身份打开工作台 → 手动编辑规划 → 返回原浏览位置。项目导出始终全部线路。

FIRST VIEWPORT: 保留左侧项目/线路导航；主体顶部项目名、项目动作和能力说明，随后横向视图切换；查找控件下是一张占据剩余主区的七列表格，表头固定，窄屏在表内横滚，主入口始终可达。

FORM: 既有“线路编排台”surface 的精确功能扩充，沿用已确认代码路径；不运行新方向 seed，不更换 palette/type/component 世界。旧方向 seed `4b92049b` 仅保留历史来源，不作为本轮新选择。

SIGNATURE: 从任意总览行进入线路、再返回，仍在同一搜索、筛选、排序、展开和双向滚动位置；后台完成不会把用户切回原线。

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
