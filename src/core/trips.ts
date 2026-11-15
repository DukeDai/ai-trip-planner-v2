import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ItineraryPlan, TripMeta } from "./types.ts";

export interface CreateTripInput {
  title?: string;
  destination: string;
  startDate: string;
  endDate: string;
  travelers: number;
  budgetTotal: number;
  currency?: string;
  preferences?: string[];
}

/** 行程工作区：agent 通过文件系统后端操作，工具通过它直接读写同一目录 */
export interface TripWorkspace {
  tripId: string;
  dir: string;
  read(rel: string): string | null;
  write(rel: string, content: string): { bytes: number };
  list(): string[];
}

export interface ArtifactInfo {
  name: string;
  bytes: number;
  updatedAt: string;
}

export class TripStore {
  readonly root: string;

  constructor(root: string) {
    this.root = root;
    fs.mkdirSync(this.root, { recursive: true });
  }

  dir(id: string): string {
    return path.join(this.root, id);
  }

  create(input: CreateTripInput): TripMeta {
    const id = "trip-" + new Date().toISOString().slice(0, 10).replace(/-/g, "") + "-" + crypto.randomBytes(3).toString("hex");
    const dir = this.dir(id);
    fs.mkdirSync(path.join(dir, "research"), { recursive: true });
    const now = new Date().toISOString();
    const meta: TripMeta = {
      id,
      title: input.title?.trim() || input.destination + " " + input.startDate + "→" + input.endDate,
      destination: input.destination,
      startDate: input.startDate,
      endDate: input.endDate,
      travelers: input.travelers,
      budgetTotal: input.budgetTotal,
      currency: input.currency ?? "CNY",
      preferences: input.preferences ?? [],
      status: "draft",
      createdAt: now,
      updatedAt: now
    };
    fs.writeFileSync(path.join(dir, "trip.json"), JSON.stringify(meta, null, 2), "utf8");
    return meta;
  }

  list(): TripMeta[] {
    let ids: string[] = [];
    try {
      ids = fs.readdirSync(this.root).filter((d) => {
        try {
          return fs.statSync(path.join(this.root, d)).isDirectory();
        } catch {
          return false;
        }
      });
    } catch {
      return [];
    }
    const trips = ids
      .map((id) => this.get(id))
      .filter((t): t is TripMeta => t !== null)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    return trips;
  }

  get(id: string): TripMeta | null {
    try {
      const raw = fs.readFileSync(path.join(this.dir(id), "trip.json"), "utf8");
      return JSON.parse(raw) as TripMeta;
    } catch {
      return null;
    }
  }

  update(id: string, patch: Partial<TripMeta>): TripMeta | null {
    const meta = this.get(id);
    if (!meta) return null;
    const next: TripMeta = { ...meta, ...patch, updatedAt: new Date().toISOString() };
    fs.writeFileSync(path.join(this.dir(id), "trip.json"), JSON.stringify(next, null, 2), "utf8");
    return next;
  }

  /** 相对路径安全解析：拒绝越界写入 */
  resolve(id: string, rel: string): string | null {
    const base = path.resolve(this.dir(id));
    const target = path.resolve(base, rel.replace(/^\/+/, ""));
    if (target !== base && !target.startsWith(base + path.sep)) return null;
    return target;
  }

  writeArtifact(id: string, rel: string, content: string): ArtifactInfo | null {
    const target = this.resolve(id, rel);
    if (!target) return null;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, "utf8");
    const stat = fs.statSync(target);
    return { name: rel.replace(/^\/+/, ""), bytes: stat.size, updatedAt: stat.mtime.toISOString() };
  }

  readArtifact(id: string, rel: string): string | null {
    const target = this.resolve(id, rel);
    if (!target) return null;
    try {
      return fs.readFileSync(target, "utf8");
    } catch {
      return null;
    }
  }

  listArtifacts(id: string): ArtifactInfo[] {
    const base = this.dir(id);
    const out: ArtifactInfo[] = [];
    const walk = (dir: string, prefix: string) => {
      let entries: fs.Dirent[] = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        // 内部文件不作为交付物暴露：trip.json / 画像 / 技能目录 / 隐藏文件
        if (e.name === "trip.json" || e.name === "AGENTS.md") continue;
        if (e.name === "skills") continue;
        if (e.name.startsWith(".")) continue;
        const full = path.join(dir, e.name);
        const rel = prefix ? prefix + "/" + e.name : e.name;
        if (e.isDirectory()) {
          walk(full, rel);
          continue;
        }
        try {
          const stat = fs.statSync(full);
          out.push({ name: rel, bytes: stat.size, updatedAt: stat.mtime.toISOString() });
        } catch {
          // ignore
        }
      }
    };
    walk(base, "");
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  readPlan(id: string): ItineraryPlan | null {
    const raw = this.readArtifact(id, "itinerary.json");
    if (!raw) return null;
    try {
      return JSON.parse(raw) as ItineraryPlan;
    } catch {
      return null;
    }
  }

  writePlan(id: string, plan: ItineraryPlan): ArtifactInfo | null {
    return this.writeArtifact(id, "itinerary.json", JSON.stringify(plan, null, 2));
  }

  writeProfile(id: string, markdown: string): void {
    this.writeArtifact(id, "AGENTS.md", markdown);
  }

  workspace(id: string): TripWorkspace {
    const store = this;
    return {
      tripId: id,
      dir: store.dir(id),
      read(rel) {
        return store.readArtifact(id, rel);
      },
      write(rel, content) {
        const info = store.writeArtifact(id, rel, content);
        return { bytes: info?.bytes ?? Buffer.byteLength(content, "utf8") };
      },
      list() {
        return store.listArtifacts(id).map((a) => a.name);
      }
    };
  }
}

export function buildProfileMarkdown(meta: TripMeta, extra?: string): string {
  const lines = [
    "# 出行人画像（本次行程）",
    "",
    "- 目的地：" + meta.destination,
    "- 日期：" + meta.startDate + " → " + meta.endDate,
    "- 人数：" + meta.travelers + " 人",
    "- 总预算：" + meta.budgetTotal + " " + meta.currency,
    "- 偏好：" + (meta.preferences.length ? meta.preferences.join("、") : "未指定")
  ];
  if (extra) {
    lines.push("", "## 本次确认的额外约束", "", extra.trim());
  }
  lines.push("", "## 约定", "", "- 所有金额以 " + meta.currency + " 计；如需换算，说明汇率与时点", "- 资料时效以本次检索时间为准，超期项必须提示复核");
  return lines.join("\n");
}
