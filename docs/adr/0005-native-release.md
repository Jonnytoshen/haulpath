# 发布直接使用 Nx 原生命令

2026-10-30，维护者明确要求 release 命令全部直接使用 Nx 原生能力并清理自定义脚本。根入口采用 `nx release --skip-publish`，由 Nx 管理版本、统一日志、Git 与 GitHub Release；继续保留单一根产品版本、私有无版本子包、原生渲染器、作者用户名和分类标题图标。

该决策取代 [ADR 0003](0003-prerelease-version-consistency.md) 的自定义累计版本下限与候选渠道状态机，并删除自定义发布、预检和 API-only 恢复驱动。接受原生 SemVer / `--preid` 规则及已有 Release 的更新行为；质量检查改为维护者发布前显式执行。Nx 推送使用 `--follow-tags --no-verify --atomic`，可能携带其他可达 annotated tags 并跳过 pre-push；提交 hook 和用户签名继续保留。取舍是减少项目自有发布逻辑，同时不再提供旧协议的候选一致性、精确推送范围与历史说明保护保证。具体操作与失败处理见[发布指南](../releasing.md)。
