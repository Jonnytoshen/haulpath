---
version: 1
slug: "src-components-workbench-tsx"
primary_target: "src/components/workbench.tsx"
related_targets: ["src/app/globals.css","src/components/map-panel.tsx","src/components/import-dialog.tsx"]
---

# 工作台

Mode: Operate。面向本机电脑上的个人线路规划者，本轮优先点位编排 → 测算 → 核对导出。用户指定简约清爽；接口、数据库和路线方案生命周期沿用现有约定。

## Direction contract

THESIS: 线路编排台。以当前线路为连续任务，不再让项目、线路、点位四列等权竞争。

OWN-WORLD: 日间办公桌上的浅色工作面；白色内容、浅灰绿导航、深绿主动作，细边界和系统中文无衬线。连续编号轴表达点位顺序，表格数值对齐，辅助信息保持可读。

STORY: 先选择项目和线路，沿顺序完善点位，在固定入口手动测算，核对同一完整路线方案后导出。点库保留当前线路、已添加点数及返回入口，支持连续选点。

FIRST VIEWPORT: 左侧约248px集中项目与线路；主体顶部项目名称与能力边界，下面三阶段任务提示；中间约380px点位编排与底部固定测算控件，右侧地图与路线方案。1280×720仍可找到主按钮。手机导航默认收起，完整保留项目名称，内容自然纵向排列。

FORM: 七个候选依次为线路任务单、地图册、测算表、线路编排台、资料目录、现场笔记、站点导视；采用第4项，seed 4b92049b。用户已确认主任务，并在方向页选择线路编排台和代码实现。六个外部挑战方向均不适合本轮业务清晰度与场景识别，分别吸收数值秩序、区域动线、上下文持续、连续轴、焦点层级和固定主操作的纪律，不沿用其装饰。

SIGNATURE: 点库连续选点时当前线路点数即时更新；返回后编号序列与地图同步。交互只用短颜色与布局状态反馈，遵从 reduced-motion。

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
