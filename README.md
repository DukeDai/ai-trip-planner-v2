# TripPilot · AI 深度行程规划工作台

基于 **LangChain Deep Agents**（`createDeepAgent`）+ TypeScript / Node 24 的行程规划应用。
交付物不是一段攻略文本，而是一份**带来源、带时效判断、带审查关卡、带预算守门、可导出可改签**的行程单。

```bash
npm install
npm start          # http://127.0.0.1:8787
npm test           # 单测
npm run typecheck  # 类型检查
```

## 一、它解决什么

自由行规划的六个固有难点，恰好对应 Deep Agents 内置的六个机制：

| 行程难点 | Deep Agents 机制 | 本项目落地 |
|---|---|---|
| 需求含糊 | `write_todos` 规划工具 | 先出需求澄清表，缺槽位先追问，槽位齐了才开工 |
| 信息爆炸 | 文件系统 | 调研原始结果落盘，主上下文只留结论 |
| 专业域多 | `task` 子代理 | transport / stay / sights / food 四路并行调研 |
| 偏好要记住 | `memory`(AGENTS.md) + `store` | 出行人画像跨会话注入 |
| 规划有口径 | `skills`(SKILL.md) | 预算口径、时效判定、编排规范、打包清单四份规范按需加载 |
| 决策有责任 | `interruptOn` HITL | 定稿与超支必须人工放行 |

第二轮再加一层：**行程合理性关卡** —— 机器校验（12 条硬规则）+ LLM 审查员 + 跨城决策的本地替代对照。

## 二、目录结构

```
src/
├── config.ts            # env 配置 + 本机 MCode 登录态兜底读凭证
├── core/
│   ├── types.ts         # 行程数据契约
│   ├── schema.ts        # itinerary.json 的 zod 校验 + 12 条硬规则（SPEC §10 / §15.2 A）
│   ├── http.ts          # 带缓存/限流/熔断的 HTTP 客户端
│   ├── trips.ts         # 行程存储（产物落盘、路径越界防护）
│   ├── db.ts            # PG 连接池 + trip_pilot schema DDL + LangGraph saver/store
│   └── persist.ts       # 仓储层（13 张表：会话状态 + 业务表）
├── data/
│   ├── providers.ts     # 地理编码 / POI / 天气 / 路线 / 国别（多源回退）
│   ├── wikidata.ts      # Wikidata 检索 + 维基百科摘要
│   └── country-facts.ts # 内置事实表（非 API）：仅国家元数据，POI 绝不用它兜底
├── agent/
│   ├── build.ts         # createDeepAgent 装配（模型/后端/子代理/skills/HITL/审查器）
│   ├── prompts.ts       # 主提示词 + 4 个子代理提示词
│   ├── tools.ts         # 领域工具（13 个）+ 事实包记录
│   ├── reviewer.ts      # 审查员：只吃事实包 + 行程单，出结构化问题清单
│   ├── tool-catalog.ts  # 细粒度工具目录（按数据域）
│   ├── tool-search.ts   # 本地 tool search：元工具 + 按上下文裁剪工具列表
│   ├── runner.ts        # 流式事件归一化 + HITL 续跑
│   └── skills/          # 4 份 SKILL.md 规范
├── server/main.ts       # HTTP + SSE + 静态站点
web/                     # 零构建前端（三栏工作台）
test/                    # 45 个单测
```

## 三、数据源与降级

主源与回退链见 SPEC §5。要点：

- **数据源间歇可达**是常态，不是异常 → 单 host 限流 + 连续失败熔断 + 6h 磁盘缓存
- 多源命中同一地点（名称相近且 250m 内）会**合并字段**
- **没有内置假 POI**（第二轮已删 `seed.ts`）：POI 只来自 Wikidata / OSM(Nominatim、Photon) / 高德（配 key 时），
  取不到就如实 `verified: false` + 进 `unconfirmed`
- 国家元数据（货币/语言/时区）保留一张**内置事实表（非 API）**，只在 RestCountries 不可用时兜底，来源如实标注
- 配 `AMAP_KEY` 后接入高德：营业时间/均价/评分/POI 覆盖显著增强

## 三之二、PostgreSQL 持久化（强烈建议配）

设 `TRIP_PG_URL` 后启用。数据全部落在**独立 schema**（默认 `trip_pilot`），不与业务库既有表混用：

| 表 | 存什么 |
|---|---|
| `checkpoints` / `checkpoint_blobs` / `checkpoint_writes` | LangGraph 会话状态（deepagents 的 thread_id = 行程 id），重启不丢、HITL 可续跑 |
| `store` | 长期记忆（跨行程的出行人偏好） |
| `trips` | 行程元数据 |
| `artifacts` | 产物文件（行程单/预算表/清单/调研记录），DB 里留一份可查询副本 |
| `source_snapshots` | **每一次外部取数的快照**：来源 URL、抓取时间、置信度、原始结果 |
| `place_index` | 地点库（跨行程复用的 POI 缓存，每行带 source/source_ref/置信度） |
| `route_cache` | 路线缓存 |
| `preferences` | 出行人长期偏好 |

**取数三段式**（解决「实时查会 api fail」）：

1. **本地优先** —— 命中 `place_index` / `route_cache` 直接用，不打外网；
2. **取到即落库** —— 每次外部取数写 `source_snapshots`，附来源与抓取时间；
3. **存档兜底** —— 外网挂掉时返回最近一次存档，`availability=degraded`，来源标注
   「存档兜底 · 某源（N 分钟前取回）」，置信度下调为 low，并在 `error` 里说明实时源失败原因。

不配 `TRIP_PG_URL` 时自动退回纯内存模式，其余功能不受影响。

## 四、行程合理性关卡（第二轮）

定稿前要连过三道关：

1. **机器校验**（`submit_itinerary` → `src/core/schema.ts`，12 条硬规则）：
   预算一致性 + 时间单调不减 + 相邻点位地理连贯（>80km 判跳变）+ **落地前禁排目的地活动** +
   **跨城必须显式写成 transport 条目** + 点位属于当日可达城市集合 + **跨城必须有本地替代对照**。
2. **LLM 审查**（`review_itinerary` → `src/agent/reviewer.ts`）：
   只吃**事实包**（`research/facts.json`，工具真取到的数据）+ 行程单，
   按需求匹配度 / 时间线与地理自洽 / 性价比 / 来源可信度四个维度出结构化问题清单；
   报告带 `planHash`，**改稿后必须重新审查**；有 blocking 就打回，**最多 3 轮**。
3. **人工放行**（`finalize_itinerary` → HITL）：预算差额 + 定稿摘要等人确认。

跨城决策的**本地替代**是硬要求：`alternatives` 里必须写清本地替代、成本差、耗时、体验增益与结论；
跨城成本高于本地替代 1.5 倍时，`risks` 里必须给出降级建议。

## 五、工具检索（本地 tool search）

`langchain@1.6` 只有 `providerToolSearchMiddleware`，且**仅支持 OpenAI gpt-5.4+ / Claude Sonnet 4+`
（当前模型 MiniMax-M3 调它会直接抛错），所以默认走本地实现：

- 细粒度工具目录（`src/agent/tool-catalog.ts`）：按数据域组织（geo / poi:sight / poi:food / poi:stay /
  poi:transport / weather / route / country / budget / alternative）
- `tool_search` 元工具：模型按需检索并装载
- `localToolSearchMiddleware`：按对话上下文对目录打分，只把命中的工具挂给模型；
  已用过的工具保持可见（sticky）

开关：`TRIP_TOOL_SEARCH=local|provider|none`，默认 `local`；
`provider` 挂 provider 原生实现（换 Claude/GPT-5.4+ 时才可用）。

## 六、模型配置

默认走本机 MCode 网关（Anthropic 协议）：

```bash
TRIP_LLM_PROVIDER=anthropic
TRIP_LLM_BASE_URL=https://agent.minimax.cn/mavis/api/v1/llm/v1
TRIP_LLM_MODEL=MiniMax-M3
# TRIP_LLM_API_KEY=...      # 不设则自动从本机 MCode 登录态读取
```

切换任意 OpenAI 兼容端点：`TRIP_LLM_PROVIDER=openai TRIP_LLM_BASE_URL=... TRIP_LLM_API_KEY=...`。

## 七、HITL 流程

1. agent 写 `/itinerary.json` → `review_itinerary` 审查（有 blocking 就改稿重审，≤3 轮）
2. 审查通过 → `submit_itinerary` 机器校验（有问题会被打回重改）
3. 校验通过 → `finalize_itinerary` → **挂起**，SSE 推 `interrupt` 事件
4. 前端展示待确认卡片（摘要 + 预算差额）→ 用户放行或驳回并说明
5. `POST /api/trips/:id/approve` → `Command({ resume })` 续跑 → 写 `approved.json`，行程状态置 approved

## 八、HTTP API

见 `docs/frontend-contract.md`（前后端唯一事实来源）。

## 九、已知限制

- 未配 `AMAP_KEY` 时，POI 的营业时间/票价只能来自 Wikidata 与 OSM，实时票价覆盖有限
- 天气只有未来约 16 天，超出范围会显式标注「需复核」
- 不做真实下单与库存锁定
- 审查员依赖事实包：模型没调取数工具时，审查只能给 warning（不会凭空判 blocking）
