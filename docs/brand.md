# 重途（HaulPath）品牌标志规范

正式标志采用用户于 2026-10-26 选定的 A「上扬」方案。HaulPath 为英文主字标，“重途”为中文辅助字标；名称文字及英文大小写保持不变。

## 图形、字形与颜色

独立图形提炼字母 H，采用向上的横画，不添加外框。英文主字标整体前倾 9°；除 H 的专用几何外，其余英文字母的常规笔画为母版坐标中的 9.5 单位。

中文辅助字标使用思源黑体简体中文 Medium。在组合标志宽 150 像素时，中文字形实际高度约 12 像素。

| 颜色 | 色值 | 用途 |
| --- | --- | --- |
| 品牌基础绿 | `#176B55` | H 之外的英文字母与中文辅助字标；单色版全部图形 |
| 提亮绿 | `#16A778` | 彩色版中的 H 与独立 H 图形 |
| 白色 | `#FFFFFF` | 深色背景上的反白版全部图形 |

标志使用纯色填充和透明背景，不添加渐变、阴影或外框，不单独拉伸图形、重排字母或改变图文比例。工作台主题颜色独立于标志资产管理，本次品牌定稿不扩大为整个界面配色的改版。

## 资产与尺寸

正式资产存放在 `public/brand/`，SVG 是矢量母版。三种构成各提供默认彩色、`-mono` 单色与 `-white` 反白版本：

| 构成 | 彩色 SVG 文件名 | viewBox | 透明 PNG 尺寸 |
| --- | --- | --- | --- |
| 独立图形 | `haulpath-mark.svg` | `0 0 100 100` | 512 × 512、1024 × 1024 |
| 英文主字标 | `haulpath-wordmark.svg` | `0 0 470 100` | 宽 1024、2048 像素，高度按比例 |
| 中英文组合标志 | `haulpath-lockup.svg` | `0 0 470 156` | 宽 1024、2048 像素，高度按比例 |

单色和反白 SVG 在扩展名前添加后缀，例如 `haulpath-lockup-mono.svg`、`haulpath-mark-white.svg`。PNG 使用 SVG 基名加导出尺寸，例如 `haulpath-mark-512.png`、`haulpath-lockup-mono-2048.png`；字标与组合标志的尺寸数字表示宽度。

所有正式 SVG 字形均转为路径，不包含运行时文字、远程字体或设备字体依赖。PNG 从对应 SVG 导出，保留透明背景；`public/brand/manifest.json` 记录每张 PNG 对应的 SVG 与 SHA-256。`src/app/icon.svg` 是 `haulpath-mark.svg` 的生成副本，必须逐字一致；更新母版时同步生成，避免 favicon 与应用图形分叉。

组合标志外围至少保留其大写 H 字高四分之一的空白，其他元素和裁切边界不得进入。组合标志最小展示宽度为 150 像素；纯英文主字标建议至少 120 像素宽；独立图形最低 16 像素，常规界面使用 24 像素以上。

## 应用接入

`BrandLogo` 组件使用 `variant="lockup"` 或 `variant="mark"` 选择组合标志与独立图形，直接引用正式 SVG。侧栏组合标志宽度为桌面 174 像素、平板 164 像素、手机 150 像素；欢迎页独立图形为 58 × 58 像素。favicon 使用同源的 `src/app/icon.svg` 文件约定。

侧栏首页链接保留中文可访问名称，标志图形避免重复朗读；欢迎页图形作为装饰呈现。线路空态、规划按钮等功能图标继续使用 Lucide，不以品牌标志替换功能图标。

品牌用于个人规划者的本机行前线路与里程测算工作台。图形及说明不表达实时导航、道路安全认证或重卡通行保证；“未校验重卡限高、限重及货车限行”的产品能力边界继续有效。

## 中文字体来源与许可

中文辅助字标固定使用 Source Han Sans SC Medium（思源黑体简体中文 Medium）`2.005R`，来源为 Adobe 的[思源黑体官方仓库](https://github.com/adobe-fonts/source-han-sans)。字体文件为 [SourceHanSansSC-Medium.otf](https://raw.githubusercontent.com/adobe-fonts/source-han-sans/2.005R/OTF/SimplifiedChinese/SourceHanSansSC-Medium.otf)，许可为该版本随附的 [SIL Open Font License 1.1](https://github.com/adobe-fonts/source-han-sans/blob/2.005R/LICENSE.txt)。

源字体 SHA-256：`1df61d31687d04fd2f928a3bb6ca6cd61f0e988cc267cf317f32406edbb49f70`。随资产保存 `public/brand/SOURCE-HAN-SANS-LICENSE.txt` 与 `public/brand/font-provenance.json`，记录版本、原始文件、来源和校验值；浏览器只展示转为路径的中文字形，不加载整套字体文件。

## 验收记录

正式资产与源码接入的日期、提交基线、检查范围及本机证据位置统一记录在[2026-10-26 品牌标志验收](acceptance.md#2026-10-26-品牌标志验收)。该阶段包含两项定向浏览器检查及生产资源与布局验证，未运行完整套件或真实高德联调。
