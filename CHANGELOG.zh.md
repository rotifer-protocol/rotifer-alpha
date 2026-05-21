# 更新动态

Rotifer Alpha 实验室的每日进展日志。无更新的日期会被跳过——这是一份动态信号，不是事无巨细的工程报告。

如需查看完整 git 历史，请前往 [GitHub commits](https://github.com/rotifer-protocol/rotifer-alpha/commits/main)。

---

### 2026-05-21
- 风控修正：回撤锚定从初始本金改为历史峰值净值
- gambler 基金更名为 **honeyBadger 🦡**（标识符全栈收敛 snake_case）
- 治理升级：新增 CONTRIBUTING + DCO sign-off 工作流

### 2026-05-20
- 品牌迁移：**Petri → Rotifer Alpha**（站点全栈更名）
- License 调整：MIT → AGPL-3.0-or-later + 商业双许可
- 扫描层多样化：按交易量分页拓宽信号源覆盖面

### 2026-05-19 — Live 上线日
- **Live 模式正式开启**：EIP-712 V2 签名 + Polymarket CLOB FOK 下单接通
- 组合层守护：Portfolio Coordinator + 事件族冲突防御
- 经济建模：Fee 模型 + 订单生命周期基因落地

### 2026-05-18
- 新增 Market Impact Gate：按市场流动性自适应下单规模
- 同事件持仓上限：每基金对同一事件最多 2 仓位
- 跨调度周期冷却缓存（KV 持久化）

### 2026-05-17
- Epoch 进度三阶段状态机：trades → time-gate → ready
- 复仓去重大修：覆盖全部 6 种关闭态 + 4 小时冷却

### 2026-05-16
- 新增 **Arena 页面**：F(g) 实时排行 + 竞速曲线 + 嵌入文档

### 2026-05-14
- 三大新页面落地：Analysis（深度分析）/ Docs（产品文档）/ Share Modal

### 2026-05-13
- 雷达图 tooltip 显示真实参数值（非归一化百分比）
- 标签去歧义：基因竞争轮次 vs 基金 PBT Epoch

### 2026-05-12
- ShadowPanel 全面重做：基金就绪矩阵 + 盈亏曲线 + 移动端卡片
- 性能优化第一波：SWR 缓存 + 代码分包 + 骨架屏
- 信息气泡覆盖核心指标：F(g) / Epoch / 最优 F(g) / 谱系 / 突变

### 2026-05-11 — 密集迭代日
- FundDetail 大改：交易日历热图、双轴净值曲线（金额 + 收益率）、统计面板
- 进化日志全面重做：分类筛选、排序、参数差异条形图
- 基金 tier（S / M / L）公开化 + MarketDriversCard：当日盈亏归因到具体市场

### 2026-05-10
- 已实现 / 浮动盈亏拆分 + 当日变化 + 集中度风险提示
- OTM 单仓位上限：进化系统之外的硬性风控护栏

### 2026-05-06
- Scanner 翻页改造：弃用低效 tag 模式，改 offset 分页
- ParamHeatmap 全基金显示（即使尚无进化历史）

### 2026-05-05 — 进化机制升级
- **3×5 基金矩阵正式落地**：15 个基金 = 3 资金量级 × 5 策略族
- **AI 驱动基因变异**：5 个可进化基因接通 LLM 变异生成（Cloudflare Workers AI）
- Genome pipeline 稳定性强化：心跳前置 + 错误恢复

### 2026-05-04
- 参数边界改造为 tier-aware：S / M / L 三档差异化

### 2026-04-19
- 公开层文档清理：剔除残留的内部 roadmap 痕迹
- 首页 meta description 与"诚实披露"文案对齐

### 2026-04-09
- 站点 slogan 与项目定位对齐——开源框架，非通用方案

### 2026-04-07
- 三层止损防御机制上线（Strategy / Position / Portfolio）
- 命名重构：Strategy DNA → **Strategy Gene**（与 Rotifer Protocol 对齐）

### 2026-04-06
- 全站 i18n 收口：硬编码文案全部走翻译层
- 基金描述与基因名称纳入双语数据层

### 2026-04-05 — 平台首发
- **平台首次部署上线**：基金 Agent 实验框架 + Hero 6 项指标仪表盘
- 影子交易（Shadow Trading）骨架接通
- Strategy Gene 抽象层 + 多基因实现级进化机制
