---
version: 1
slug: "src-components-route-overview-map-tsx"
primary_target: "src/components/route-overview-map.tsx"
related_targets: ["src/components/overview-map.tsx", "src/components/route-overview-details.tsx", "src/components/route-overview.tsx", "src/app/globals.css"]
---

# 项目线路分布

Mode: Operate。在项目内连续浏览线路的空间分布，选择只预览，明确打开才进入编排。

THESIS: 地图负责看分布，资料栏负责认线路；名称、稳定色标和选中勾选共同建立对应。

OWN-WORLD: 继承 DESIGN.md 的纸白工作面、浅灰绿资料区、深绿交互、中文系统字体、小圆角及 Lucide 图标。不建立新的视觉系统。

FIRST VIEWPORT: 桌面地图在左并占主要宽度，右侧为独立滚动线路列表与所选摘要；里程右对齐，选中勾选可辨。搜索筛选保持共享；摘要内容可滚动，打开线路固定在所属摘要底部。窄屏按地图、列表、摘要排列，短桌面允许工作区纵向滚动。

SIGNATURE: 点击折线或列表，原色线路高亮且编号点位出现，列表以勾选和浅绿同步反馈；查看全部恢复当前匹配范围。保留视野和列表滚动恢复，无新增测算、写入或过滤规则。

CONSTRAINTS: 七类摘要完整，无效方案的距离与时间为空缺；不绘制过期或虚构道路。固定八色按稳定标识分配。缺配置和 SDK 失败不阻断列表与打开。沿用普通驾车测算边界。

DIRECTION: 用户确认优先让地图与线路选择更清晰，保持现有功能范围。现有模块内部重构，代码优先，不做视觉世界替换，无批准视觉稿。

FINISH: 成组核对1440×900、1024×900、390×844及短桌面；浏览器真实HTTP和临时SQLite，仅高德边界替换；独立视觉与代码复核。
