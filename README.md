# TripPilot · AI 深度行程规划工作台

基于 **LangChain Deep Agents**（`createDeepAgent`）+ TypeScript / Node 24 的行程规划应用。
交付物不是一段攻略文本，而是一份**带来源、带时效判断、带预算守门、可导出可改签**的行程单。

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

## 二、目录结构

```
src/
├── config.ts            # env 配置 + 本机 MCode 登录态兜底读凭证
├── core/
│   ├── types.ts         # 行程数据契约
│   ├── schema.ts        # itinerary.json 的 zod 校验 + 一致性规则（SPEC §10）
│   ├── http.ts          # 带缓存/限流/熔断的 HTTP 客户端
│   └── trips.ts         # 行程存储（产物落盘、路径越界防护）
├── data/
│   ├── providers.ts     # 地理编码 / POI / 天气 / 路线 / 国别（多源回退）
│   ├── wikidata.ts      # Wikidata 检索 + 维基百科摘要
│   └── seed.ts          # 离线种子库（36 个地点的参考值）
├── agent/
│   ├── build.ts         # createDeepAgent 装配（模型/后端/子代理/skills/HITL）
│   ├── prompts.ts       # 主提示词 + 4 个子代理提示词
│   ├── tools.ts         # 领域工具（8 个）
│   ├── runner.ts        # 流式事件归一化 + HITL 续跑
│   └── skills/          # 4 份 SKILL.md 规范
├── server/main.ts       # HTTP + SSE + 静态站点
web/                     # 零构建前端（三栏工作台）
test/                    # 27 个单测
```

## 三、数据源与降级

主源与回退链见 SPEC §5。要点：

- **数据源间歇可达**是常态，不是异常 → 单 host 限流 + 连续失败熔断 + 6h 磁盘缓存
- 多源命中同一地点（名称相近且 250m 内）会**合并字段**，例如 Wikidata 给坐标、种子库给票价与营业时间
- 任何取不到的数据必须标 `verified: false` 并进 `unconfirmed`，**不允许编造**
- 配 `AMAP_KEY` 后接入高德：营业时间/均价/评分/POI 覆盖显著增强

## 四、模型配置

默认走本机 MCode 网关（Anthropic 协议）：

```bash
TRIP_LLM_PROVIDER=anthropic
TRIP_LLM_BASE_URL=https://agent.minimax.cn/mavis/api/v1/llm/v1
TRIP_LLM_MODEL=MiniMax-M3
# TRIP_LLM_API_KEY=...      # 不设则自动从本机 MCode 登录态读取
```

切换任意 OpenAI 兼容端点：`TRIP_LLM_PROVIDER=openai TRIP_LLM_BASE_URL=... TRIP_LLM_API_KEY=...`。

## 五、HITL 流程

1. agent 写 `/itinerary.json` → 调用 `submit_itinerary` 机器校验（不一致会被打回重改）
2. 校验通过 → 调用 `finalize_itinerary` → **挂起**，SSE 推 `interrupt` 事件
3. 前端展示待确认卡片（摘要 + 预算差额）→ 用户放行或驳回并说明
4. `POST /api/trips/:id/approve` → `Command({ resume })` 续跑 → 写 `approved.json`，行程状态置 approved

## 六、HTTP API

见 `docs/frontend-contract.md`（前后端唯一事实来源）。

## 七、已知限制

- 未配 `AMAP_KEY` 时，POI 的营业时间/票价只能来自内置种子库（36 个地点）与 Wikidata，实时票价覆盖有限
- 天气只有未来约 16 天，超出范围会显式标注「需复核」
- 会话 checkpointer 为进程内 MemorySaver，重启后多轮上下文丢失（产物文件仍在）
- 不做真实下单与库存锁定
