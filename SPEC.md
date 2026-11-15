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
8. **无内置假数据**（第二轮）：任何 POI、票价、开放时间只能来自 API，取不到就标 `unavailable` + `verified:false`；内置事实表仅限国家元数据，且必须标注「内置事实表（非 API）」。

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
| `tool_search` | **元工具**：按关键词/数据域检索细粒度工具目录并装载 | 本地目录（零网络） | — |
| `geocode_place` | 地点 → 坐标 | Open-Meteo Geocoding | Nominatim → Photon |
| `search_sights` | 景点/文化/自然/亲子/夜景检索 | Wikidata（结构化事实） | 高德（有 key）→ Photon → Nominatim |
| `search_food` | 餐厅/市集/早餐/特色餐饮检索 | 同上 | 同上 |
| `search_lodging` | 酒店/民宿/住宿区域检索 | 同上 | 同上 |
| `search_transport_hub` | 机场/车站/码头检索 | 同上 | 同上 |
| `get_daily_weather` | 逐日天气（气温/降水概率/风/日出日落） | Open-Meteo | — |
| `measure_travel_time` | 点到点距离/通勤时长 | OSRM（自驾） | 直线距离 × 经验系数（步行/骑行/自驾降级） |
| `get_country_profile` | 货币/语言/时区/驾驶方向 | RestCountries | 内置事实表（非 API） |
| `compute_budget` | 汇总预算、明细合计、差额与占比告警 | 内部（口径来自 Skill） | — |
| `find_local_alternative` | **本地替代方案**检索：同一城市内体验等价的替代点位 | 同 `search_sights` | — |
| `review_itinerary` | **审查关卡**：读行程单 + 事实包，LLM 审查并出具结构化问题清单 | 内部（§15.2 B） | — |
| `submit_itinerary` | 机器校验 + 审查门禁（强制关卡） | 内部（SPEC §10 规则） | — |
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
| `reviewer` 行程审查员 | 对照需求/事实审查行程单，出具结构化问题清单与本地替代建议 | `/review/report.json` |

> `reviewer` 由 `review_itinerary` 工具直接驱动（工具内部调用独立模型实例），不走 `task` 委派 —— 审查是**强制关卡**，不能靠模型自觉。

主代理：需求澄清 → 并行委派 → 汇总编排 → 预算校验 → 写产物 → **reviewer 审查（≤3 轮）** → 机器校验 → HITL 定稿。

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
  "tripId": "…", "origin": "…", "destination": "…", "startDate": "2026-12-01", "endDate": "2026-12-05",
  "travelers": { "count": 2, "budgetTotal": 100000, "currency": "CNY" },
  "days": [{
    "day": 1, "date": "2026-12-01", "theme": "…", "totalCost": 3200,
    "activities": [{
      "time": "09:30", "title": "…", "type": "sight|food|transport|stay|free",
      "location": "…", "durationMin": 120, "costPerPerson": 120, "costTotal": 240,
      "notes": "…", "source": "…", "fetchedAt": "…", "confidence": "high|medium|low",
      "needsBooking": true, "bookingLeadDays": 14, "verified": true,
      // 第二轮新增：城市归属与坐标 —— 机器校验与 reviewer 审查都靠它
      "city": "…", "lat": 39.9, "lon": 116.4,
      // 仅 transport 类需要：显式跨城起终点
      "fromCity": "…", "toCity": "…"
    }]
  }],
  "budget": { "lines": [{ "category": "stay|transport|sight|food|other", "label": "…", "amount": 0, "unit": "…", "confidence": "…" }], "total": 0, "planned": 0, "delta": 0 },
  "risks": [{ "level": "high|medium|low", "title": "…", "mitigation": "…" }],
  "unconfirmed": [{ "item": "…", "reason": "…", "howToVerify": "…" }],
  // 第二轮新增：跨城/远距离决策的本地替代对比（跨城行程必填）
  "alternatives": [{
    "decision": "上海 → 京都 3 天",
    "fromCity": "上海", "toCity": "京都",
    "chosen": "…", "localAlternative": "…",
    "chosenCost": 12000, "localCost": 1800, "costDelta": 10200,
    "chosenTime": "…", "localTime": "…",
    "experienceGain": "…",
    "recommendation": "keep|downgrade|switch",
    "rationale": "…"
  }]
}
```

**校验规则（§10 一致性 + §15.2 A 行程合理性，硬门槛）**

一致性：
1. `budget.total === sum(lines.amount)`
2. `day.totalCost === sum(activities.costTotal)`
3. `grandTotal === sum(days)`
4. `budget.delta === total - planned`，且 `planned === travelers.budgetTotal`
5. 任何 `verified:false` 必须出现在 `unconfirmed`
6. `needsBooking:true` 必须给出 `bookingLeadDays`

行程合理性（第二轮新增，缺一即打回）：
7. **时间单调不减**：同一天 activities 的 `time`（HH:mm）不得倒退
8. **地理连贯性**：相邻两条非交通条目的直线距离 ≤ 80km，否则报「地理跳变」（中间缺交通衔接）
9. **到达前禁排目的地活动**：按时间顺序推进城市轨迹，`origin` 是起点；
   任何非交通条目的 `city` 必须等于「当前所在城市」
10. **跨城移动必须显式出现**：城市变化只能由 `type=transport` 且带 `fromCity`/`toCity` 的条目产生；
    交通条目的 `fromCity` 必须等于当前所在城市
11. **点位属于当日可达城市集合**：由第 9/10 条推导，`city` 不得超出当日可达集合
12. **本地替代硬规则**：出现跨城（`fromCity !== toCity`）时，`alternatives` 必须有对应条目，
    且写清本地替代、成本差、耗时、体验维度与结论；缺任一项即报错

校验失败则写盘失败并报错，不得产出半成品。

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
- **持久化**：可选 PostgreSQL（`TRIP_PG_URL`），独立 schema `trip_pilot`。会话状态走 LangGraph
  原生 checkpoint（deepagents 的 thread_id 即行程 id，与普通 LangGraph 完全一致）；
  行程/产物/取数快照/地点库/路线缓存/偏好落自建表。不配则退回纯内存模式
- **取数三段式**：本地优先 → 取到即落库 → 存档兜底（兜底时必须标注存档来源与取回时间，置信度下调）
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

### 第二轮验证记录（2026-11-15 晚，PG + 前端修复）

| 项 | 结果 |
|---|---|
| PG 自动建表 | 13 张：`checkpoints` `checkpoint_blobs` `checkpoint_writes` `checkpoint_migrations` `store` `store_migrations`（LangGraph 原生）+ `trips` `artifacts` `source_snapshots` `place_index` `route_cache` `preferences`（自建） |
| E2E（北京 3 天 / PG checkpointer） | 739s，729 个 token 帧、**177 次工具调用**、4 子代理全完成、9 个产物、HITL 正常挂起；线程在 PG 里留下 **855 行 checkpoint** |
| 取数三段式实测 | ① 断源 + 本地命中 → `ok`「本地地点库（已落库，未再请求外网）」；② 断源 + 无本地无存档 → `unavailable`（如实报错）；③ 断源 + 有存档 → `degraded`「存档兜底 · open-meteo（0 分钟前取回）」，置信度下调 low |
| **跨进程放行** | 脚本进程把行程挂起在 HITL，**另一个进程（服务器）从 PG checkpoint 认出该挂起并放行** → 169 帧 SSE（168 token + 1 done）→ 行程状态 draft → **approved**，产物 10 个 |
| 前端 4 项修复 | ① 放行后走 SSE 续跑（此前 jfetch 拿不到事件流，故"没下文"）；② 徽标改为显示结余/超支**金额**（实际合计与计划移入 title）；③ 看板改块级流 + days 按日期排序（此前 flex 列把行程卡压成细线、风险卡顶到最前）；④ 切换行程时的过期响应守卫 |
| 单测 | **32 passed / 0 failed**（新增 5 例覆盖本地优先 / 取到即落库 / 存档兜底 / 无存档诚实失败 / 无仓储不崩） |

**第二轮修掉的真缺陷**
7. approve 端点返回 SSE，前端却用普通 JSON 请求读它 → 放行后"没下文"
8. 预算差额符号在两处都写反（徽标与 HITL 卡片）
9. `.board-scroll` 用 flex column，子项被压缩 → 行程卡变成细线、风险卡顶到最前
10. 切换行程时旧请求后到，把已加载的方案清成 null（加过期响应守卫）
11. 快照外键依赖行程行，而行程入库是"异步即发" → 竞态下 FK 失败（改为有序落库 + 失败降级）
12. HITL 待确认动作只存在进程内 map → 换进程/重启就找不到（改为从 checkpoint 恢复）

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

---

## 15. 第二轮需求（DD 2026-11-15 夜）

> 目标：让行程"看上去像那么回事"。四条硬要求，逐条可验收。

### 15.1 去掉 seed 假数据，只看真实 API 数据

- 删除 `src/data/seed.ts`（36 条凭记忆写的 POI 参考价/开放时间）及其全部引用与单测。
- POI 只允许来自 API：Wikidata / OSM(Nominatim、Photon) / 高德（若配 key）/ 维基百科摘要。
- 取数失败 → `unavailable`（如实说取不到），**不允许用内置假数据顶上**。
- 国别事实表（货币/时区/驾驶方向）保留但必须标注来源为「内置事实表（非 API）」。

### 15.2 行程合理性必须过关（当前最大问题）

现象：出现过「先在京都吃早餐，再从上海机场出发去京都」这种自相矛盾的排布。

**A. 机器校验（`src/core/schema.ts` 增补，硬门槛）**
1. 每天条目时间**单调不减**；
2. 同一天相邻点位的**地理连贯性**：距离/通勤时间突变（如 2km → 500km）即报错；
3. **到达日/离开日**语义：出发城市未落地前不得排目的地活动；
4. 跨城移动**必须在行程里显式出现**（transport 类条目 + 起终点城市），否则跨城点位判为非法；
5. 每条 activity 的地点必须属于当日可达城市集合（用 geocode + route 事实判定）。

**B. 审查者（reviewer）关卡 —— 用大模型自身的能力**
- 新增 `reviewer` 子代理与 `review_itinerary` 工具：读 `/itinerary.json`，对照
  ①需求匹配度 ②时间线/地理自洽 ③性价比 ④来源可信度，输出结构化问题清单；
- `submit_itinerary` 之前**必须**先过 reviewer；有 blocking 级问题则打回修改（最多 3 轮）；
- reviewer 拿到的是**事实**（路线耗时/距离、天气、票价、开放时间），不是让模型自己脑补。

**C. 性价比与想象力（避免高成本低体验）**
- 行程规划必须对每个「跨城/远距离」决策给出**本地替代方案**对比（成本、耗时、体验维度）；
- 跨城成本显著高于本地替代且体验增益不明显时，产出**降级建议**（写进 `risks` 或新增 `alternatives`）；
- 硬规则：不允许出现「为了一次活动跨越半个地球/跨国往返」而没有成本与体验的对照说明。

### 15.3 工具检索能力（tool search）

- 现状核实：`langchain@1.6` 只导出 `providerToolSearchMiddleware`，且**仅支持 OpenAI gpt-5.4+ / Claude Sonnet 4+**，
  其它供应商直接抛错 —— 当前 MiniMax-M3 用不了。
- 因此实现**本地 tool search**：把工具拆成细粒度目录（按城市/品类/数据域），只给模型一张
  「工具目录 + 一个 `tool_search` 元工具」，模型按需检索并动态装载具体工具；
  provider 原生路径保留为开关（模型换成 Claude/GPT-5.4+ 时可开）。

### 15.4 交付要求

- 分支：**main**；完成后 **commit + push**（origin = github.com/DukeDai/ai-trip-planner-v2.git）。
- 验收：见 §15.5。

### 15.5 验收标准（第二轮）

1. 单测全绿；新增校验用例覆盖：时间倒退、跨城跳跃、到达前排目的地、本地替代缺失。
2. 用**真实 API 数据**跑至少 3 个目的地：①上海本地 1 晚 ②上海→京都 3 天（高成本反例）
   ③一个中距离目的地；产出完整行程单 + 全部产物文件。
3. 反例验证：把「上海→京都」这类行程交给 reviewer，**必须被抓出**并给出本地替代建议
   （如「上海本地替代方案 + 成本差」）。
4. 产物中不再出现任何内置假 POI；取不到的条目标 `verified: false` 且进 `unconfirmed`。
5. 浏览器实测：看板顺序、预算口径、放行续跑、产物列表全正常。

### 15.6 实施约定（第二轮落地细节）

**去假数据**
- `src/data/seed.ts` 整体删除（36 条凭记忆写的 POI 假数据 + 其单测一并移除）。
- POI 只允许来自 API：Wikidata / OSM(Nominatim、Photon) / 高德（配 key 时）/ 维基百科摘要。
- 国别元数据移入 `src/data/country-facts.ts`，来源固定标注「**内置事实表（非 API）**」，
  且只在 RestCountries 不可用时兜底。

**机器校验**
- `src/core/schema.ts` 增补 §10 的第 7–12 条规则。
- `city` / `lat` / `lon` 由 agent 从 `search_*` / `geocode_place` 的返回值抄进行程单；
  字段缺失时**跳过该项校验**而不是猜测（宁可少查也不误杀）。

**reviewer 关卡**
- 工具层维护**事实包** `research/facts.json`：每次数据工具调用成功即追加一条事实
  （路线耗时/距离、天气、票价、开放时间、坐标）。reviewer 只吃这份事实包 + 行程单，不允许脑补。
- `review_itinerary` 工具内部直接调用审查模型（独立模型实例，thinking 关闭），
  产出 `/review/report.json`；`submit_itinerary` 校验报告里的 `planHash` 是否等于当前
  `itinerary.json` 的哈希 —— 改稿后必须重新审查。
- 审查最多 3 轮：第 4 轮仍未通过，`submit_itinerary` 直接拒绝并说明。
- 有 `blocking` 问题 → 报告 `approved:false`，主代理必须改稿后重新 `review_itinerary`。

**tool search**
- `langchain@1.6` 只有 `providerToolSearchMiddleware`（仅 OpenAI gpt-5.4+ / Claude Sonnet 4+），
  当前模型 MiniMax-M3 用不了 → 默认走**本地实现**。
- 本地实现 = 细粒度工具目录（`src/agent/tool-catalog.ts`）+ `tool_search` 元工具 +
  `localToolSearchMiddleware`：按对话上下文对目录做关键词打分，只把命中的工具挂给模型；
  模型也可主动 `tool_search` 精确装载。
- 开关：`TRIP_TOOL_SEARCH=local|provider|none`，默认 `local`；
  `provider` 挂 `providerToolSearchMiddleware`（换 Claude/GPT-5.4+ 时才可用）。
