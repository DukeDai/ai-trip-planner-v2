import test from "node:test";
import assert from "node:assert/strict";
import { createTools } from "../src/agent/tools.ts";
import type { TripWorkspace } from "../src/core/trips.ts";

/** 内存工作区：够跑审查工具，不落盘 */
function memoryWorkspace(): TripWorkspace & { files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    tripId: "trip-test",
    dir: "/tmp/trip-test",
    files,
    read(rel: string) {
      return files.get(rel) ?? null;
    },
    write(rel: string, content: string) {
      files.set(rel, content);
      return { bytes: Buffer.byteLength(content, "utf8") };
    },
    list() {
      return [...files.keys()];
    }
  };
}

function report(approved = true) {
  return {
    approved,
    summary: "测试用报告",
    scores: { requirement: 90, consistency: 90, value: 90, sourceTrust: 90 },
    blocking: [],
    warnings: [],
    localAlternatives: []
  };
}

function planText(v: number): string {
  return JSON.stringify({ tripId: "T", version: v, days: [], budget: {}, risks: [], unconfirmed: [] });
}

async function makeTools(ws: TripWorkspace, reviewer: (input: { round: number }) => Promise<unknown>) {
  const tools = createTools({
    data: {} as never,
    workspace: ws,
    reviewer: reviewer as never,
    requirements: {
      destination: "苏州",
      startDate: "2026-11-20",
      endDate: "2026-11-22",
      travelers: 2,
      budgetTotal: 6000,
      currency: "CNY"
    }
  });
  const found = tools.find((t) => t.name === "review_itinerary");
  assert.ok(found, "应该有 review_itinerary 工具");
  // 工具是联合类型，这里只用到 invoke，统一成最小签名
  return found as unknown as { invoke: (input: unknown) => Promise<unknown> };
}

test("审查结论缓存：同一份行程重复送审不重跑模型", async () => {
  const ws = memoryWorkspace();
  ws.write("itinerary.json", planText(1));
  let calls = 0;
  const review = await makeTools(ws, async () => {
    calls++;
    return report();
  });

  await review.invoke({});
  assert.equal(calls, 1);
  await review.invoke({});
  assert.equal(calls, 1, "行程未改动时不该再调审查模型");

  // 改了行程 → 哈希变了 → 必须重新审
  ws.write("itinerary.json", planText(2));
  await review.invoke({});
  assert.equal(calls, 2, "行程改了就得重新审");
});

test("审查轮次硬上限：超过 6 轮不再调模型，直接封顶放行", async () => {
  const ws = memoryWorkspace();
  let calls = 0;
  const review = await makeTools(ws, async () => {
    calls++;
    return report();
  });

  // 每轮都改行程，制造新的 planHash
  for (let v = 1; v <= 10; v++) {
    ws.write("itinerary.json", planText(v));
    await review.invoke({});
  }
  assert.equal(calls, 6, "超过上限后不该再调审查模型，实际调用 " + calls + " 次");

  const stored = JSON.parse(ws.read("review/report.json") as string);
  assert.equal(stored.approved, true);
  assert.equal(stored.blocking.length, 0);
  assert.ok(
    stored.warnings.some((w: { code: string }) => w.code === "review/cap"),
    "封顶说明应该写进 warnings"
  );
});
