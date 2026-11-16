import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { z } from "zod";

/**
 * 行程审查关卡（SPEC §15.2 B）。
 *
 * 纪律：
 * - reviewer 只吃**事实包**（工具真实取到的数据）+ 行程单，不允许脑补。
 * - 事实包里没有的信息，只能进 warnings 并要求人工复核，不能当既成事实。
 * - 报告落在 /review/report.json，带 planHash —— 改稿后必须重新审查。
 */

export interface ReviewFact {
  tool: string;
  kind: string;
  at: string;
  query?: string;
  data: unknown;
}

export const ReviewIssueSchema = z.object({
  severity: z.enum(["blocking", "warning"]),
  code: z.string(),
  title: z.string(),
  detail: z.string(),
  evidence: z.string().optional(),
  fix: z.string().optional()
});

export const ReviewReportSchema = z.object({
  approved: z.boolean(),
  summary: z.string(),
  scores: z.object({
    requirement: z.number(),
    consistency: z.number(),
    value: z.number(),
    sourceTrust: z.number()
  }),
  blocking: z.array(ReviewIssueSchema),
  warnings: z.array(ReviewIssueSchema),
  localAlternatives: z.array(
    z.object({
      decision: z.string(),
      suggestion: z.string(),
      costDelta: z.number().optional(),
      reason: z.string()
    })
  )
});

export type ReviewIssue = z.infer<typeof ReviewIssueSchema>;
export type ReviewReport = z.infer<typeof ReviewReportSchema>;

export interface ReviewRequirements {
  origin?: string;
  destination: string;
  startDate: string;
  endDate: string;
  travelers: number;
  budgetTotal: number;
  currency: string;
  preferences?: string[];
  userRequest?: string;
}

export interface ReviewInput {
  model: BaseChatModel;
  plan: unknown;
  planHash: string;
  round: number;
  facts: ReviewFact[];
  /** 工作区已有文件（审查员据此核对产物完整性） */
  artifactFiles?: string[];
  requirements: ReviewRequirements;
}

const BT = String.fromCharCode(96);

/** 第几轮起启用收敛兜底 */
const CONVERGE_ROUND = 4;

const REVIEWER_SYSTEM_PROMPT = [
  "你是 TripPilot 的**行程审查员**（reviewer）。你不做规划，只做审查：读行程单 + 事实包，判断这份行程是否站得住。",
  "",
  "# 铁律",
  "1. **只依据给定的行程单与事实包**。事实包里没有的开放时间/票价/班次/耗时，一律不要臆测，只能作为 warning 提出来并要求人工复核。",
  "2. 事实包里标了「unavailable / degraded / 存档兜底」的数据，说明时效或可靠性有问题 → 至少 warning；若被当成确定事实写 → blocking。",
  "3. 事实包里查不到某条数据 ≠ 这条数据是编的。它只是「缺证据」，按 warning 处理（要求标 verified=false + 进 unconfirmed）。",
  "4. 找不到证据不等于没问题，但也不等于有问题 —— 说清楚「缺什么证据、怎么补」。",
  "",
  "# 四个审查维度",
  "A. **需求匹配度**：天数、人数、预算上限、日期、核心诉求（用户明确点名的偏好/忌口/主题）是否被满足。",
  "B. **时间线与地理自洽**：",
  "   - 同一天时间是否单调不减；",
  "   - 是否存在「落地前就排目的地活动」（例如第 1 天先在京都吃早餐、然后才从上海机场出发）；",
  "   - 城市变化是否都有显式的跨城交通条目；",
  "   - 相邻点位距离是否与交通事实吻合（用事实包里的 route 耗时/距离比对，不要自己脑补距离）。",
  "C. **性价比**：跨城/远距离决策是否给出了本地替代对照（成本/耗时/体验）；跨城成本远高于本地替代且体验增益不明显时，必须给降级建议。",
  "D. **来源可信度**：每条 source 是否非空且来自事实包；verified=false 的条目是否进了 unconfirmed；有没有把「未确认」当确定事实写。",
  "",
  "# 产物完整性（SPEC §10）",
  "行程目录里必须有这五个文件：itinerary.json、itinerary.md、budget.csv、packing.md、bookings.md。",
  "少了任何一个 → blocking，并明确指出缺哪个、该由谁写（写哪个文件）。",
  "",
  "# 判定为 blocking（必须改）—— 只挑真正致命的，最多 8 条",
  "- B1 需求硬指标不满足（天数/人数/预算上限/用户明确要求的核心内容缺失）",
  "- B2 时间线或城市轨迹自相矛盾（落地前排目的地活动、时间倒退、跨城无交通条目、跨城起点不是当前所在城市）",
  "- B3 相邻点位存在巨大地理跳变且无交通衔接",
  "- B4 跨城/远距离决策缺少本地替代对照，或成本明显更高却无降级建议",
  "- B5 来源字段不可信：source 为空、或 source 与事实包里的同一实体明显矛盾。（**注意**：「事实包里查不到这条」属于 warning，不走 B5）",
  "- B6 事实包**明确显示**该数据 unavailable / degraded（存档兜底），行程却把它写成高置信的确定事实",
  "",
  "# 判定为 warning（提示人工复核，不要拦）",
  "- 事实包里**查不到**某条数据的证据 —— 这是 warning 不是 blocking：要求它把该条目标 verified=false 并写进 unconfirmed 即可",
  "- 事实包整体为空 —— 也是 warning（提示整体证据不足），**不要**因此判 blocking",
  "- 开放时间未确认、闭馆日可能冲突、票价时效风险、红叶季状态无依据、天气超出预报范围",
  "- 行程结构不完整（缺住宿/返程/某餐段）、每日点位过密或过疏",
  "- 路线耗时的**量级**出入：只要与事实包同一量级（如事实 25 分钟、行程写 20 分钟），属 warning；" +
    "只有方向性错误（写成步行 5 分钟、实际却是 2 小时车程；或路线方向相反）才 blocking",
  "- 行程依赖某个**未落实的手段**（包车/拼车/包团/某班次）：如果行程已经明确标注它未确认、" +
    "并且写出了可切换的备选（如「若包车不可行则改公共交通」），那就只是 warning；" +
    "只有当行程把未落实的手段当成唯一排程基准、且没有任何备选时，才 blocking",
  "- 同一个问题反复出现：如果你在上一轮已经提过它，而行程只是换了个说法，" +
    "那就降级为 warning —— 不要让同一个问题无限打回",
  "- 描述性建议（哪个点更值得去、路线顺序可以更优）",
  "",
  "# 分寸",
  "- 你的目标是**揪出真正会让行程不可用/不值当的问题**，不是挑文风。能靠「标未确认 + 进 unconfirmed」解决的，一律 warning。",
  "- 只有当问题必须改行程结构才能解决时，才判 blocking。",
  "",
  "# 收敛规则（重要）",
  "- 第 1 轮：尽量把问题找全，blocking 最多 8 条。",
  "- 第 2 轮及以后：只保留**必须改行程结构才能解决**的问题。",
  "  能用「标 verified=false + 进 unconfirmed」解决的，一律降级为 warning，不要再当 blocking。",
  "  不要因为「又想到一个新的细节」新增 blocking —— 上一轮没提的、能靠标注解决的，都放 warning。",
  "- 如果剩下的都是 warning 级问题，approved 给 true，并把它们列进 warnings（由主代理补标注后收工）。",
  "- 不要让行程永远改不完：宁可放过可标注的小瑕疵，也不要把行程卡死在打回循环里。",
  "",
  "# 输出",
  "**只输出一个 JSON 对象**，不要任何解释文字、不要 markdown 代码块。结构：",
  "{",
  '  "approved": true|false,',
  '  "summary": "两三句话的总体判断",',
  '  "scores": { "requirement": 0-100, "consistency": 0-100, "value": 0-100, "sourceTrust": 0-100 },',
  '  "blocking": [ { "severity": "blocking", "code": "B2", "title": "…", "detail": "…", "evidence": "引用事实包里的具体条目", "fix": "具体怎么改" } ],',
  '  "warnings": [ { "severity": "warning", "code": "W1", "title": "…", "detail": "…", "fix": "…" } ],',
  '  "localAlternatives": [ { "decision": "上海 → 京都 3 天", "suggestion": "上海本地可替代的玩法", "costDelta": -10200, "reason": "为什么" } ]',
  "}",
  "",
  "只要 blocking 非空，approved 必须是 false。"
].join("\n");

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        if (typeof b === "string") return b;
        if (b && typeof b === "object" && "text" in b) return String((b as { text: unknown }).text);
        return "";
      })
      .join("");
  }
  return "";
}

/** 从模型输出里抠出 JSON */
export function extractJson(text: string): unknown | null {
  const fence = BT.repeat(3);
  const re = new RegExp(fence + "(?:json)?\\s*([\\s\\S]*?)" + fence, "i");
  const fenced = re.exec(text);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
}

/** 事实包压缩：只保留审查需要的字段，控制 token */
export function compactFacts(facts: ReviewFact[], limit = 80): string {
  const recent = facts.slice(-limit);
  const lines: string[] = [];
  for (const f of recent) {
    const d = f.data as Record<string, unknown> | null;
    if (!d || typeof d !== "object") {
      lines.push(JSON.stringify({ tool: f.tool, query: f.query, at: f.at }));
      continue;
    }
    const avail = d.availability ? String(d.availability) : undefined;
    const prov = d.provenance as { source?: string; confidence?: string } | undefined;
    const data = d.data;
    if (Array.isArray(data)) {
      const items = data.slice(0, 12).map((x) => {
        const o = x as Record<string, unknown>;
        const picked: Record<string, unknown> = {};
        for (const key of [
          "name",
          "city",
          "category",
          "openingHours",
          "ticketRange",
          "avgCost",
          "lat",
          "lon",
          "source",
          "confidence",
          "verified",
          "date",
          "weatherText",
          "weatherCode",
          "tempMax",
          "tempMin",
          "precipitationProb",
          "windMax",
          "sunrise",
          "sunset"
        ]) {
          if (o[key] !== undefined && o[key] !== null) picked[key] = o[key];
        }
        return picked;
      });
      lines.push(JSON.stringify({ tool: f.tool, query: f.query, availability: avail, source: prov?.source, items }));
    } else if (data && typeof data === "object") {
      const o = data as Record<string, unknown>;
      lines.push(
        JSON.stringify({
          tool: f.tool,
          query: f.query,
          availability: avail,
          source: prov?.source,
          date: o.date,
          tempMax: o.tempMax,
          tempMin: o.tempMin,
          precipitationProb: o.precipitationProb,
          distanceMeters: o.distanceMeters,
          durationMinutes: o.durationMinutes,
          mode: o.mode,
          currencies: o.currencies,
          languages: o.languages,
          timezones: o.timezones,
          drivingSide: o.drivingSide
        })
      );
    } else {
      lines.push(JSON.stringify({ tool: f.tool, query: f.query, availability: avail, source: prov?.source }));
    }
  }
  return lines.join("\n");
}

function buildUserPrompt(input: ReviewInput): string {
  const r = input.requirements;
  return [
    "# 本次需求",
    JSON.stringify(
      {
        出发城市: r.origin ?? "（未提供）",
        目的地: r.destination,
        日期: r.startDate + " → " + r.endDate,
        人数: r.travelers,
        预算上限: r.budgetTotal + " " + r.currency,
        偏好: r.preferences ?? [],
        用户原话: r.userRequest ?? ""
      },
      null,
      2
    ),
    "",
    "# 工作区现有文件",
    input.artifactFiles && input.artifactFiles.length > 0
      ? input.artifactFiles.join("\n")
      : "（空）",
    "",
    "# 事实包（工具真实取到的数据，只有这些可以当证据）",
    input.facts.length > 0
      ? compactFacts(input.facts)
      : "（本次没有取到任何数据 —— 行程单里的任何具体数值都缺乏来源支撑）",
    "",
    "# 待审行程单（/itinerary.json）",
    JSON.stringify(input.plan, null, 2),
    "",
    "这是第 " + input.round + " 轮审查。上一轮 blocking 问题请逐条核对是否已修复；未修复的继续列出。",
    "",
    "只输出 JSON。"
  ].join("\n");
}

function normalizeReport(raw: unknown): { report: ReviewReport; problems: string[] } {
  const problems: string[] = [];
  const obj = (raw ?? {}) as Record<string, unknown>;
  const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
  const num = (v: unknown, fallback: number): number =>
    typeof v === "number" && Number.isFinite(v) ? v : fallback;
  const str = (v: unknown, fallback: string): string =>
    typeof v === "string" && v.trim() ? v : fallback;

  const blocking = asArray(obj.blocking).map((x) => {
    const o = (x ?? {}) as Record<string, unknown>;
    return {
      severity: "blocking" as const,
      code: str(o.code, "B?"),
      title: str(o.title, "未命名问题"),
      detail: str(o.detail, ""),
      evidence: typeof o.evidence === "string" ? o.evidence : undefined,
      fix: typeof o.fix === "string" ? o.fix : undefined
    };
  });
  const warnings = asArray(obj.warnings).map((x) => {
    const o = (x ?? {}) as Record<string, unknown>;
    return {
      severity: "warning" as const,
      code: str(o.code, "W?"),
      title: str(o.title, "未命名问题"),
      detail: str(o.detail, ""),
      fix: typeof o.fix === "string" ? o.fix : undefined
    };
  });
  const scores = (obj.scores ?? {}) as Record<string, unknown>;
  const localAlternatives = asArray(obj.localAlternatives).map((x) => {
    const o = (x ?? {}) as Record<string, unknown>;
    return {
      decision: str(o.decision, ""),
      suggestion: str(o.suggestion, ""),
      costDelta: typeof o.costDelta === "number" ? o.costDelta : undefined,
      reason: str(o.reason, "")
    };
  });

  if (blocking.length === 0 && warnings.length === 0 && !obj.summary) {
    problems.push("审查输出既没有结论也没有问题清单");
  }

  const report: ReviewReport = {
    approved: blocking.length === 0 && obj.approved === true,
    summary: str(obj.summary, blocking.length > 0 ? "存在必须修改的问题" : "未发现阻断问题"),
    scores: {
      requirement: num(scores.requirement, 60),
      consistency: num(scores.consistency, 60),
      value: num(scores.value, 60),
      sourceTrust: num(scores.sourceTrust, 60)
    },
    blocking,
    warnings,
    localAlternatives
  };
  return { report, problems };
}

/**
 * 跑一轮审查。模型输出解析失败时会再试一次；仍失败则给出 blocking 问题（不静默放行）。
 */
export async function runReview(input: ReviewInput): Promise<ReviewReport> {
  const report = await runReviewOnce(input);
  return convergeIfNeeded(report, input.round);
}

/**
 * 收敛兜底：第 4 轮起若仍未收敛，把剩余 blocking 降级为 warning 并放行。
 * 不这样做就会陷入「改一轮→再审一轮」的死循环（实测出现过 15 轮仍不收敛）。
 * 降级不是放过：这些条目会进 warnings，并要求主代理写进 risks / unconfirmed 供人工复核。
 */
export function convergeIfNeeded(report: ReviewReport, round: number): ReviewReport {
  if (round < CONVERGE_ROUND || report.blocking.length === 0) return report;
  const demoted = report.blocking.map((b) => ({
    ...b,
    severity: "warning" as const,
    code: b.code + "/未收敛"
  }));
  return {
    ...report,
    approved: true,
    summary:
      report.summary +
      " 【第 " + round + " 轮仍未收敛：按收敛规则把剩余 " + report.blocking.length +
      " 条问题降级为 warning，主代理必须把它们写进 risks / unconfirmed 供人工复核】",
    blocking: [],
    warnings: [...report.warnings, ...demoted]
  };
}

async function runReviewOnce(input: ReviewInput): Promise<ReviewReport> {
  const messages: { role: "system" | "user" | "assistant"; content: string }[] = [
    { role: "system", content: REVIEWER_SYSTEM_PROMPT },
    { role: "user", content: buildUserPrompt(input) }
  ];

  let lastText = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await input.model.invoke(messages);
      lastText = textOf(res.content);
      const parsed = extractJson(lastText);
      if (parsed) {
        const { report, problems } = normalizeReport(parsed);
        if (problems.length === 0) return report;
      }
    } catch (err) {
      lastText = "调用失败：" + (err instanceof Error ? err.message : String(err));
    }
    if (attempt === 0) {
      messages.push({ role: "assistant", content: lastText.slice(0, 400) });
      messages.push({
        role: "user",
        content: "上一次输出无法解析成目标 JSON。请只输出一个 JSON 对象，不要任何其他文字。"
      });
    }
  }

  return {
    approved: false,
    summary: "审查模型输出无法解析，已阻止提交（不静默放行）",
    scores: { requirement: 0, consistency: 0, value: 0, sourceTrust: 0 },
    blocking: [
      {
        severity: "blocking",
        code: "REVIEW_PARSE",
        title: "审查输出无法解析",
        detail: "审查模型连续两次没有返回可解析的 JSON 报告。原文摘要：" + lastText.slice(0, 300),
        fix: "再调一次 review_itinerary；若仍失败，说明行程单里可能有让模型无法判断的畸形结构"
      }
    ],
    warnings: [],
    localAlternatives: []
  };
}
