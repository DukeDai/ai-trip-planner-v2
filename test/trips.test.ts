import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { TripStore } from "../src/core/trips.ts";

function tmpStore(): { store: TripStore; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trippilot-"));
  return { store: new TripStore(path.join(dir, "trips")), dir };
}

test("创建行程会落盘 trip.json 并可读回", () => {
  const { store } = tmpStore();
  const trip = store.create({
    destination: "东京",
    startDate: "2026-12-01",
    endDate: "2026-12-04",
    travelers: 2,
    budgetTotal: 50000
  });
  assert.match(trip.id, /^trip-\d{8}-[0-9a-f]{6}$/);
  assert.equal(store.get(trip.id)?.destination, "东京");
  assert.equal(store.get(trip.id)?.status, "draft");
});

test("list 按创建时间倒序返回", () => {
  const { store } = tmpStore();
  store.create({ destination: "A", startDate: "2026-12-01", endDate: "2026-12-02", travelers: 1, budgetTotal: 1 });
  store.create({ destination: "B", startDate: "2026-12-01", endDate: "2026-12-02", travelers: 1, budgetTotal: 1 });
  const list = store.list();
  assert.equal(list.length, 2);
});

test("产物写入与读取往返一致，子目录自动创建", () => {
  const { store } = tmpStore();
  const trip = store.create({ destination: "巴黎", startDate: "2026-12-01", endDate: "2026-12-02", travelers: 1, budgetTotal: 1 });
  store.writeArtifact(trip.id, "research/sights.md", "# 景点\n内容");
  assert.equal(store.readArtifact(trip.id, "research/sights.md"), "# 景点\n内容");
  assert.ok(store.listArtifacts(trip.id).some((a) => a.name === "research/sights.md"));
});

test("越界路径被拒绝", () => {
  const { store } = tmpStore();
  const trip = store.create({ destination: "X", startDate: "2026-12-01", endDate: "2026-12-02", travelers: 1, budgetTotal: 1 });
  assert.equal(store.writeArtifact(trip.id, "../../escape.md", "boom"), null);
  assert.equal(store.readArtifact(trip.id, "../../etc/passwd"), null);
});

test("readPlan 解析 itinerary.json，非法 JSON 返回 null", () => {
  const { store } = tmpStore();
  const trip = store.create({ destination: "X", startDate: "2026-12-01", endDate: "2026-12-02", travelers: 1, budgetTotal: 1 });
  store.writeArtifact(trip.id, "itinerary.json", "{ not json");
  assert.equal(store.readPlan(trip.id), null);
  store.writeArtifact(trip.id, "itinerary.json", JSON.stringify({ tripId: trip.id }));
  assert.equal(store.readPlan(trip.id)?.tripId, trip.id);
});

test("update 会刷新 updatedAt 并持久化", () => {
  const { store } = tmpStore();
  const trip = store.create({ destination: "X", startDate: "2026-12-01", endDate: "2026-12-02", travelers: 1, budgetTotal: 1 });
  const next = store.update(trip.id, { status: "approved" });
  assert.equal(next?.status, "approved");
  assert.equal(store.get(trip.id)?.status, "approved");
});
