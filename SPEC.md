# TripPilot — AI 深度行程规划工作台（SPEC v1）

> 状态：合同级规格。改行为先改本文件。
> 技术底座：LangChain **Deep Agents**（`createDeepAgent`）+ TypeScript / Node 24。

---

## 0. 一句话

输入「去哪、几天、几个人、多少钱、什么口味」，产出一份**带真实数据来源、带预算守门、带开放时间时效判断、可导出可编辑**的行程单，并支持追问改签。

不是「聊天机器人吐一段攻略」——是工作台：左边对话推进，中间看板成型，右边预算与产物实时可查。

---

## 1. 目标用户与场景

| 角色 | 场景 | 当前痛点 |
|---|---|---|
| 自由行规划者 | 5–10 天自由行，需要跨城、多日节奏 | 通用模型给的行程不落地：闭馆、路程、预算对不上 |
| 预算敏感者 | 出行前要拿到可控的钱 | 只有总价，没有逐项账，没有超支预警 |
| 返程复盘者 | 上次行程踩坑 | 行程存不下来，改一版要重写全篇 |

**产品承诺**：每一���条目都要能回答三个问题 —— *它是什么（数据来自哪）*、*什么时候去（开放时间/时效）*、*花多少钱（单列计价）*。做不到时必须显式标注「未确认」，不允许编造。

---

## 2. 必须做的事（MUST）

1. **六机制落地**（见 §4），不是口头宣称，每个机制都要在运行日志里可见。
2. **真实数据源**，免费无 key 为基线：高德/百度/OSM/Overpass/Wikidata/RestCountries/Open-Meteo/OSRM/WTTR 中至少 4 类接入，且**全部返回来源、时间戳、置信度**。
3. **数据降级诚实**：某数据源不可用时，工具返回 `availability: "unavailable"` + 原因，agent 必须把相关结论标为「待人工确认」，不得用训练记忆编造开放时间/票价。
4. **预算守门**：逐项计价 + 分类小计 + 与预算差额；超支或超阈值时触发人工确认（HITL）。
5. **产物落盘**：每次规划产出固定 6 个文件（§10），可下载。
6. **多轮改签**：支持「把第 3 天改成艺术主题」「预算砍 20%」这类指令，agent 就地改写并标注 diff。
7. **可观测**：SSE 实时推送 todo 进度、工具调用、子代理委派、token 流。

## 3. 明确不做（OUT OF SCOPE）

- 不做真实下单/支付（只产出「预订清单」，不代持凭证）
- 不做实时库存锁定（票价与库存标注为「参考价，需预订前复核」）
- 不做多用户账号体系（单用户本地部署）
- 不做移动端原生 App（响应式 Web）

---

## 4. 核心设计：Deep Agents 六机制 × 行程规划六难点

| # | 行程规划固有难点 | Deep Agents 机制 | 本项目落地 |
|---|---|---|---|
| 1 | 需求含糊、约束缺失（不知道几个人/几天/预算） | **规划工具 `write_todos`** | 开工先出「需求澄清表」，缺槽位先追问，槽位齐了才进入规划 |
| 2 | 信息爆炸，主上下文会被搜索结果撑爆 | **文件系统**（ls/read_file/write_file/edit_file/grep/glob） | 调研原始结果落盘，主上下文只留结论；产物即文件 |
| 3 | 专业域多（交通/住宿/景点/餐饮）互不熟悉 | **子代理 `task`** | 4 个专职子代理并行调研，各自独占上下文与文件区 |
| 4 | 出行人偏好要跨会话记住 | **长期记忆 `memory`(AGENTS.md) + `store`** | 画像文件（预算/节奏/忌口/体力）跨会话注入 |
| 5 | 规划有专业口径（怎么算钱、怎么判时效） | **Skills（SKILL.md）** | 预算估算口径、开放时间时效判定、行程编排规范、打包清单 4 份规范按需加载 |
| 6 | 决策有责任归属（超预算/定稿） | **HITL `interruptOn`** | 定稿与超预算动作必须人工放行 |

> 附加：**文件后端 `FilesystemBackend`**（每行程独立目录）→ 产物跨会话可见、可导出；**会话 checkpointer** → 多轮改签有上下文与 HITL 续跑。

**文件沙箱（安全硬约束）**：`FilesystemBackend` 默认 `virtualMode=false`，此时工具里的绝对路径会**直接放行到整机文件系统**（实测 `ls("/")` 列出 /bin /etc /Applications）。必须用 `{ rootDir: 行程目录, virtualMode: true }`：此时 "/xxx" 是行程目录内的虚拟路径，拒绝 `..`/`~` 穿越，解析结果必须仍在 rootDir 内。

---

## 5. 工具契约

所有工具统一返回 `{ ok, data, source, fetchedAt, confidence, availability }`，agent 只能引用 `data` 里的字段。

| 工具 | 作用 | 主数据源 | 回退链 |
|---|---|---|---|
| `geocode` | 地点 → 坐标 | Open-Meteo Geocoding | Nominatim → Photon |
| `search_places` | POI/景点/餐厅/酒店检索 | Wikidata（结构化事实） | 高德（有 key）→ Photon → Nominatim → 内置种子库 |
| `get_weather` | 逐日天气（气温/降水概率/风/日出日落） | Open-Meteo | WTTR.in |
| `get_route` | 点到点距离/时长 | OSRM（自驾） | 直线距离 × 经验系数（步行/骑行/自驾降级） |
| `get_country_facts` | 货币/语言/时区/驾驶方向 | RestCountries | 内置离线国别表 |
| `compute_budget` | 汇总预算、明细合计、差额与占比告警 | 内部（口径来自 Skill） | — |
| `submit_itinerary` | 对 `/itinerary.json` 做机器校验（强制关卡） | 内部（SPEC §10 规则） | — |
| `finalize_itinerary` | 定稿（触发 HITL） | — | — |

**地点描述补全**：检索结果里的前两条会再查一次维基百科摘要，拿到人话介绍与坐标交叉验证。

**网络韧性（必须）**：数据源在本机网络下**间歇可达**（同一 host 时通时断）。因此数据层强制三件套：
1. 单 host 限流闸门（Photon/Nominatim 每 1.1–1.2s 一次）；
2. 连续失败 2 次即熔断 60s，直接返回「已熔断」而不是继续空等；
3. 磁盘缓存 6h —— 同一批地点只打一次外网。

命中多源且「名称相近 + 距离 250m 内」视为同一地点，**合并字段而不是丢弃**（例如 Wikidata 给坐标、种子库给票价与营业时间）。

置信度规则：`high`=官方/一手源；`medium`=聚合源；`low`=推断或估算；`unavailable`=取不到。

## 6. 子代理分工

| 子代理 | 职责 | 输出文件 |
|---|---|---|
| `transport` 交通调度 | 城际交通方案、市内通勤时长、机场/车站接驳 | `research/transport.md` |
| `stay` 住宿区位 | 分区建议、到核心 POI 的可达性矩阵 | `research/stay.md` |
| `sights` 景点情报 | 景点清单、开放时间、票价区间、必订标记 | `research/sights.md` |
| `food` 餐饮策划 | 餐饮安排、忌口过滤、预算档位 | `research/food.md` |

主代理：需求澄清 → 并行委派 → 汇总编排 → 预算校验 → 写产物 → HITL 定稿。

## 7. Skills 清单（`src/agent/skills/`）

1. `budget-estimation/SKILL.md` —— 计价口径（住宿按晚、交通按人、门票按张、餐饮按人餐）、取整规则、置信度标注规则
2. `freshness-policy/SKILL.md` —— 时效判定：开放时间缺失、闭馆日、需预订 ≥N 天、票价过期风险
3. `itinerary-craft/SKILL.md` —— 行程编排规范：每日 ≤N 个点位、跨区不排太紧、留出 15% 缓冲
4. `packing-checklist/SKILL.md` —— 打包与证件清单生成规则

## 8. 记忆模型

- `data/trips/<id>/AGENTS.md`：本次行程的出行人画像（预算/人数/节奏/忌口/体力/偏好），启动即注入（`memory` 参数）
- `store`：跨行程的长期偏好（同一用户反复出现的偏好）
- 画像每次规划后由主代理更新

## 9. HITL

`interruptOn: { finalize_itinerary: true }`。
前端展示待确认内容（预算差额/定稿摘要）→ 放行或驳回 → 服务端用 `Command({ resume })` 续跑。驳回需给出理由，主代理据此改稿。

## 10. 产物文件契约（每行程目录）

| 文件 | 内容 | 格式 |
|---|---|---|
| `itinerary.json` | 行程结构化数据（看板数据源） | JSON，见下 |
| `itinerary.md` | 人读版行程单 | Markdown |
| `budget.csv` | 逐项预算 | CSV |
| `research/*.md` | 四路调研原始记录 | Markdown |
| `packing.md` | 打包与证件清单 | Markdown |
| `bookings.md` | 待预订清单（标注需提前多久） | Markdown |

`itinerary.json` 结构：

```jsonc
{
  "tripId": "…", "destination": "…", "startDate": "2026-12-01", "endDate": "2026-12-05",
  "travelers": { "count": 2, "budgetTotal": 100000, "currency": "CNY" },
  "days": [{
    "day": 1, "date": "2026-12-01", "theme": "…", "totalCost": 3200,
    "activities": [{
      "time": "09:30", "title": "…", "type": "sight|food|transport|stay|free",
      "location": "…", "durationMin": 120, "costPerPerson": 120, "costTotal": 240,
      "notes": "…", "source": "…", "fetchedAt": "…", "confidence": "high|medium|low",
      "needsBooking": true, "bookingLeadDays": 14, "verified": true
    }]
  }],
  "budget": { "lines": [{ "category": "stay|transport|sight|food|other", "label": "…", "amount": 0, "unit": "…", "confidence": "…" }], "total": 0, "planned": 0, "delta": 0 },
  "risks": [{ "level": "high|medium|low", "title": "…", "mitigation": "…" }],
  "unconfirmed": [{ "item": "…", "reason": "…", "howToVerify": "…" }]
}
```

**校验规则**：`budget.total === sum(lines.amount)`；`day.totalCost === sum(activities.costTotal)`；`grandTotal === sum(days)`；任何 `verified:false` 必须出现在 `unconfirmed`。校验失败则写盘失败并报错，不得产出半成品。

## 11. HTTP API 契约

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | 健康检查 + 已接数据源状态 |
| POST | `/api/trips` | 创建行程，返回 `tripId` |
| GET | `/api/trips` | 行程列表 |
| GET | `/api/trips/:id` | 行程详情（含 itinerary.json 解析结果） |
| GET | `/api/trips/:id/files` | 产物文件列表 |
| GET | `/api/trips/:id/files/:name` | 下载单个产物 |
| POST | `/api/trips/:id/chat` | 发消息（SSE 流式） |
| POST | `/api/trips/:id/approve` | HITL 放行/驳回 |
| GET | `/api/trips/:id/events` | SSE 事件流（重连用） |

SSE 事件类型：`status`、`todo`、`tool`、`subagent`、`token`、`artifact`、`interrupt`、`error`、`done`。

## 12. 非功能约束

- **模型**：默认 `MiniMax-M3`（Anthropic 协议，`https://agent.minimax.cn/mavis/api/v1/llm/v1`）；可换任意 OpenAI 兼容 / Anthropic 兼容端点，仅靠 env 切换
- **凭据**：只从 env / 本地 auth store 读，**绝不进日志、不进产物、不进 git**
- **成本**：子代理并行；单次规划目标 ≤ 15 次模型调用
- **超时**：单工具 ≤ 15s，带缓存（TTL 6h）、单 host 限流、连续失败熔断 60s
- **隐私**：产物落本地 `data/trips/`，本地 gitignore

## 13. 验收标准（可测）

1. `npm test` 全绿；数据层与校验层有单测（≥ 12 个用例）
2. 一次真实规划能产出 6 类产物文件，且 `itinerary.json` 通过 §10 校验
3. 日志里能看到：todo 列表、≥1 次子代理委派、≥3 个数据工具调用、1 次 HITL 中断与放行
4. 每个 activity 的 `source` 非空；数据源不可用时 `unconfirmed` 非空
5. 前端：看板按天渲染、预算条与差额可见、产物可下载、追问能改签

### 验证记录（2026-11-15 实测）

| 项 | 结果 |
|---|---|
| 类型检查 `tsc --noEmit` | 无错误 |
| 单测 `node --test` | **27 passed / 0 failed**（校验规则 11 例、数据层 9 例、存储 7 例） |
| 真实规划 E2E（北京 3 天 / 2 人 / 8000 CNY） | 390s，673 个 token 帧、**111 次工具调用**、4 个子代理全部完成 |
| 产物 | `itinerary.json`(44KB) `itinerary.md` `budget.csv` `packing.md` `bookings.md` + `research/{transport,stay,sights,food}.md` 共 9 个 |
| `itinerary.json` 校验 | 通过（3 天、合计 4938 / 上限 8000 / 差额 −3062、8 条风险、46 条待确认） |
| HITL | 挂起 → 放行耗时 **3.6s**，`approved.json` 落盘，行程状态 draft → **approved**；驳回会把理由作为 ToolMessage 回灌给 agent |
| 真实数据 | Wikidata 命中故宫/天坛/慕田峪/埃菲尔铁塔；OSRM 故宫→798 = 14.2km / 15min；Open-Meteo 三日预报；RestCountries 不可用时回退内置表 |
| 前端（内置浏览器实测） | 看板按天渲染、风险卡/预算分类/置信度徽标正常、产物 9 项可下载、预算口径正确显示「结余 ¥3,062」 |
| 数据源健康 | open-meteo / osrm / restcountries / offline-seed 可用；photon 间歇不可达；amap 未配置（可选） |

**本次修掉的真缺陷（均为实测暴露）**
1. `FilesystemBackend` 未开 `virtualMode` → agent 的 `ls("/")` 能看到整机根目录
2. `messages` 流模式载荷是 `[message, metadata]` 元组，当成对象读会丢掉全部 token
3. HITL 续跑载荷写成了 `{[toolCallId]: decision}`，实际必须是 `{decisions: [...]}` 数组
4. 同名同坐标的跨源条目被去重丢弃（Wikidata 坐标 + 种子库票价没有合并）
5. 预算差额符号口径相反：数据是 `delta = 实际 − 计划`（负数为结余），前端按 `delta < 0 = 超支` 渲染
6. 产物列表把内部 `skills/` 与隐藏文件当成交付物暴露


## 14. 风险与已知限制

| 风险 | 应对 |
|---|---|
| POI 源在中国大陆可达性不稳定 | 多源回退 + 显式 unavailable + unconfirmed 清单 |
| 票价/开放时间易过期 | 一律标 `verified:false` 并给复核方式 |
| 模型编造细节 | 工具层强制来源字段；prompt 禁止引用无来源数值 |
| 长会话上下文膨胀 | 子代理隔离 + 文件系统卸载 + summarization 中间件 |
| OAuth 令牌会过期 | 启动时检查过期并给可执行提示 |
