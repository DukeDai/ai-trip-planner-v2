import type { Db } from "./db.ts";
import type { ItineraryPlan, PlaceCandidate, TripMeta } from "./types.ts";

export interface SnapshotRecord {
  tool: string;
  queryKey: string;
  provider: string;
  url?: string;
  fetchedAt: string;
  confidence: string;
  availability: string;
  payload: unknown;
}

export interface StoredPlace {
  placeId: string;
  name: string;
  kind?: string;
  city?: string;
  district?: string;
  lat: number;
  lng: number;
  source: string;
  sourceRef?: string;
  openingHours?: Record<string, unknown>;
  ticketMin?: number;
  ticketMax?: number;
  ticketCurrency?: string;
  rating?: number;
  businessStatus: string;
  sourceDetail: Record<string, unknown>;
  fetchedAt: string;
}

export interface StoredRoute {
  fromKey: string;
  toKey: string;
  mode: string;
  durationMin: number;
  distanceKm: number;
  source: string;
}

/**
 * 行程持久化仓储。没有配置 PG 时所有方法退化为 no-op（纯内存模式仍可跑）。
 * 与业务库其它表完全隔离，全部落在自己的 schema 下。
 */
export class TripRepository {
  private readonly db: Db | null;

  constructor(db: Db | null) {
    this.db = db;
  }

  get enabled(): boolean {
    return this.db !== null;
  }

  get schema(): string {
    return this.db ? this.db.schema : "";
  }

  private t(): string {
    return this.db ? this.db.schema : "trip_pilot";
  }

  // ------------------------------------------------------------ 行程元数据
  async upsertTrip(meta: TripMeta): Promise<void> {
    if (!this.db) return;
    const sql =
      "insert into " + this.t() + ".trips " +
      "(id, title, destination, start_date, end_date, travelers, budget_total, currency, preferences, status, meta, created_at, updated_at) " +
      "values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11::jsonb,$12,$13) " +
      "on conflict (id) do update set title = excluded.title, destination = excluded.destination, " +
      "start_date = excluded.start_date, end_date = excluded.end_date, travelers = excluded.travelers, " +
      "budget_total = excluded.budget_total, currency = excluded.currency, preferences = excluded.preferences, " +
      "status = excluded.status, meta = excluded.meta, updated_at = now()";
    await this.db.query(sql, [
      meta.id,
      meta.title,
      meta.destination,
      meta.startDate,
      meta.endDate,
      meta.travelers,
      meta.budgetTotal,
      meta.currency,
      JSON.stringify(meta.preferences),
      meta.status,
      JSON.stringify({}),
      meta.createdAt,
      meta.updatedAt
    ]);
  }

  async getTrip(id: string): Promise<TripMeta | null> {
    if (!this.db) return null;
    const rows = await this.db.query<Record<string, unknown>>(
      "select * from " + this.t() + ".trips where id = $1",
      [id]
    );
    const row = rows[0];
    return row ? rowToTrip(row) : null;
  }

  async listTrips(): Promise<TripMeta[]> {
    if (!this.db) return [];
    const rows = await this.db.query<Record<string, unknown>>(
      "select * from " + this.t() + ".trips order by updated_at desc limit 100"
    );
    return rows.map(rowToTrip);
  }

  // ------------------------------------------------------------ 产物文件
  async saveArtifact(tripId: string, name: string, content: string): Promise<void> {
    if (!this.db) return;
    try {
      await this.writeArtifact(tripId, name, content);
    } catch {
      // 行程行未入库时跳过，不阻断主流程
    }
  }

  private async writeArtifact(tripId: string, name: string, content: string): Promise<void> {
    if (!this.db) return;
    await this.db.query(
      "insert into " + this.t() + ".artifacts (trip_id, name, content, bytes, updated_at) " +
        "values ($1,$2,$3,$4, now()) " +
        "on conflict (trip_id, name) do update set content = excluded.content, bytes = excluded.bytes, updated_at = now()",
      [tripId, name, content, Buffer.byteLength(content, "utf8")]
    );
  }

  async loadArtifacts(tripId: string): Promise<{ name: string; content: string; bytes: number; updatedAt: string }[]> {
    if (!this.db) return [];
    const rows = await this.db.query<Record<string, unknown>>(
      "select name, content, bytes, updated_at from " + this.t() + ".artifacts where trip_id = $1 order by name",
      [tripId]
    );
    return rows.map((r) => ({
      name: String(r.name),
      content: String(r.content),
      bytes: Number(r.bytes),
      updatedAt: new Date(String(r.updated_at)).toISOString()
    }));
  }

  // ------------------------------------------------------------ 外部取数快照
  async saveSnapshot(tripId: string | null, rec: SnapshotRecord): Promise<void> {
    if (!this.db) return;
    try {
      await this.writeSnapshot(tripId, rec);
    } catch (err) {
      // 行程行还没入库（外键失败）时，退化为不挂行程的快照，不影响取数主流程
      try {
        await this.writeSnapshot(null, rec);
      } catch {
        void err;
      }
    }
  }

  private async writeSnapshot(tripId: string | null, rec: SnapshotRecord): Promise<void> {
    if (!this.db) return;
    await this.db.query(
      "insert into " + this.t() + ".source_snapshots " +
        "(trip_id, tool, query_key, provider, url, fetched_at, confidence, availability, payload) " +
        "values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)",
      [
        tripId,
        rec.tool,
        rec.queryKey,
        rec.provider,
        rec.url ?? null,
        rec.fetchedAt,
        rec.confidence,
        rec.availability,
        JSON.stringify(rec.payload ?? null)
      ]
    );
  }

  async latestSnapshot(tool: string, queryKey: string): Promise<SnapshotRecord | null> {
    if (!this.db) return null;
    const rows = await this.db.query<Record<string, unknown>>(
      "select * from " + this.t() + ".source_snapshots " +
        "where tool = $1 and query_key = $2 and availability <> 'unavailable' " +
        "order by fetched_at desc limit 1",
      [tool, queryKey]
    );
    const row = rows[0];
    if (!row) return null;
    return {
      tool: String(row.tool),
      queryKey: String(row.query_key),
      provider: String(row.provider),
      url: row.url ? String(row.url) : undefined,
      fetchedAt: new Date(String(row.fetched_at)).toISOString(),
      confidence: String(row.confidence),
      availability: String(row.availability),
      payload: row.payload
    };
  }

  // ------------------------------------------------------------ 地点索引
  async upsertPlaces(places: StoredPlace[]): Promise<void> {
    if (!this.db || places.length === 0) return;
    for (const p of places) {
      await this.db.query(
        "insert into " + this.t() + ".place_index " +
          "(place_id, name, kind, city, district, lat, lng, source, source_ref, opening_hours, " +
          "ticket_min, ticket_max, ticket_currency, rating, business_status, source_detail, fetched_at, updated_at) " +
          "values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13,$14,$15,$16::jsonb,$17, now()) " +
          "on conflict (place_id) do update set name = excluded.name, kind = excluded.kind, city = excluded.city, " +
          "district = excluded.district, lat = excluded.lat, lng = excluded.lng, source = excluded.source, " +
          "source_ref = excluded.source_ref, opening_hours = excluded.opening_hours, ticket_min = excluded.ticket_min, " +
          "ticket_max = excluded.ticket_max, ticket_currency = excluded.ticket_currency, rating = excluded.rating, " +
          "business_status = excluded.business_status, source_detail = excluded.source_detail, " +
          "fetched_at = excluded.fetched_at, updated_at = now()",
        [
          p.placeId,
          p.name,
          p.kind ?? null,
          p.city ?? null,
          p.district ?? null,
          p.lat,
          p.lng,
          p.source,
          p.sourceRef ?? null,
          JSON.stringify(p.openingHours ?? {}),
          p.ticketMin ?? null,
          p.ticketMax ?? null,
          p.ticketCurrency ?? null,
          p.rating ?? null,
          p.businessStatus,
          JSON.stringify(p.sourceDetail ?? {}),
          p.fetchedAt
        ]
      );
    }
  }

  async findPlaces(nameLike: string, city?: string, limit = 8): Promise<StoredPlace[]> {
    if (!this.db) return [];
    const rows = await this.db.query<Record<string, unknown>>(
      "select * from " + this.t() + ".place_index " +
        "where name ilike $1 and ($2::text is null or city is null or city ilike '%' || $2 || '%') " +
        "order by fetched_at desc limit $3",
      ["%" + nameLike + "%", city ?? null, limit]
    );
    return rows.map(rowToPlace);
  }

  // ------------------------------------------------------------ 路线缓存
  async saveRoute(route: StoredRoute): Promise<void> {
    if (!this.db) return;
    await this.db.query(
      "insert into " + this.t() + ".route_cache (from_key, to_key, mode, duration_min, distance_km, source, computed_at) " +
        "values ($1,$2,$3,$4,$5,$6, now()) " +
        "on conflict (from_key, to_key, mode) do update set duration_min = excluded.duration_min, " +
        "distance_km = excluded.distance_km, source = excluded.source, computed_at = now()",
      [route.fromKey, route.toKey, route.mode, route.durationMin, route.distanceKm, route.source]
    );
  }

  async getRoute(fromKey: string, toKey: string, mode: string): Promise<StoredRoute | null> {
    if (!this.db) return null;
    const rows = await this.db.query<Record<string, unknown>>(
      "select * from " + this.t() + ".route_cache where from_key = $1 and to_key = $2 and mode = $3",
      [fromKey, toKey, mode]
    );
    const row = rows[0];
    if (!row) return null;
    return {
      fromKey: String(row.from_key),
      toKey: String(row.to_key),
      mode: String(row.mode),
      durationMin: Number(row.duration_min),
      distanceKm: Number(row.distance_km),
      source: String(row.source)
    };
  }

  // ------------------------------------------------------------ 长期偏好
  async savePreference(scope: string, key: string, value: unknown, tripId?: string, weight = 1): Promise<void> {
    if (!this.db) return;
    await this.db.query(
      "insert into " + this.t() + ".preferences (scope, key, value, weight, trip_id, updated_at) " +
        "values ($1,$2,$3::jsonb,$4,$5, now()) " +
        "on conflict (scope, key, COALESCE(trip_id, '')) do update set value = excluded.value, " +
        "weight = excluded.weight, updated_at = now()",
      [scope, key, JSON.stringify(value ?? null), weight, tripId ?? null]
    );
  }

  async listPreferences(scope: string, tripId?: string): Promise<{ key: string; value: unknown; weight: number }[]> {
    if (!this.db) return [];
    const rows = await this.db.query<Record<string, unknown>>(
      "select key, value, weight from " + this.t() + ".preferences " +
        "where scope = $1 and ($2::text is null or trip_id = $2)",
      [scope, tripId ?? null]
    );
    return rows.map((r) => ({ key: String(r.key), value: r.value, weight: Number(r.weight) }));
  }
}

function rowToTrip(row: Record<string, unknown>): TripMeta {
  return {
    id: String(row.id),
    title: String(row.title),
    destination: String(row.destination),
    startDate: String(row.start_date).slice(0, 10),
    endDate: String(row.end_date).slice(0, 10),
    travelers: Number(row.travelers),
    budgetTotal: Number(row.budget_total),
    currency: String(row.currency),
    preferences: Array.isArray(row.preferences) ? (row.preferences as string[]) : [],
    status: row.status === "approved" ? "approved" : "draft",
    createdAt: new Date(String(row.created_at)).toISOString(),
    updatedAt: new Date(String(row.updated_at)).toISOString()
  };
}

function rowToPlace(row: Record<string, unknown>): StoredPlace {
  return {
    placeId: String(row.place_id),
    name: String(row.name),
    kind: row.kind ? String(row.kind) : undefined,
    city: row.city ? String(row.city) : undefined,
    district: row.district ? String(row.district) : undefined,
    lat: Number(row.lat),
    lng: Number(row.lng),
    source: String(row.source),
    sourceRef: row.source_ref ? String(row.source_ref) : undefined,
    openingHours: (row.opening_hours ?? {}) as Record<string, unknown>,
    ticketMin: row.ticket_min === null || row.ticket_min === undefined ? undefined : Number(row.ticket_min),
    ticketMax: row.ticket_max === null || row.ticket_max === undefined ? undefined : Number(row.ticket_max),
    ticketCurrency: row.ticket_currency ? String(row.ticket_currency) : undefined,
    rating: row.rating === null || row.rating === undefined ? undefined : Number(row.rating),
    businessStatus: String(row.business_status),
    sourceDetail: (row.source_detail ?? {}) as Record<string, unknown>,
    fetchedAt: new Date(String(row.fetched_at)).toISOString()
  };
}

export function placeIdOf(candidate: PlaceCandidate): string {
  const src = candidate.source;
  const provider = src.includes("Wikidata")
    ? "wd"
    : src.includes("高德")
    ? "amap"
    : src.includes("种子库")
    ? "seed"
    : src.includes("Nominatim")
    ? "nom"
    : src.includes("Photon")
    ? "photon"
    : "ext";
  return (candidate.id || candidate.name) + "|" + provider;
}

export function toStoredPlace(candidate: PlaceCandidate, fetchedAt: string): StoredPlace {
  return {
    placeId: placeIdOf(candidate),
    name: candidate.name,
    kind: candidate.category,
    city: candidate.city,
    district: candidate.address,
    lat: candidate.lat,
    lng: candidate.lon,
    source: candidate.source,
    sourceRef: candidate.id,
    openingHours: candidate.openingHours ? { text: candidate.openingHours } : {},
    ticketMin: candidate.ticketRange?.min,
    ticketMax: candidate.ticketRange?.max,
    ticketCurrency: candidate.ticketRange?.currency,
    rating: candidate.rating,
    businessStatus: "active",
    sourceDetail: {
      tips: candidate.tips,
      avgCost: candidate.avgCost,
      verified: candidate.verified,
      confidence: candidate.confidence
    },
    fetchedAt
  };
}

export function toCandidate(place: StoredPlace): PlaceCandidate {
  const hours = place.openingHours as { text?: string };
  const detail = place.sourceDetail as { tips?: unknown; confidence?: unknown };
  return {
    id: place.placeId,
    name: place.name,
    category: place.kind ?? "unknown",
    city: place.city,
    address: place.district,
    lat: place.lat,
    lon: place.lng,
    openingHours: hours?.text,
    ticketRange:
      place.ticketMin !== undefined || place.ticketMax !== undefined
        ? {
            min: place.ticketMin ?? 0,
            max: place.ticketMax ?? place.ticketMin ?? 0,
            currency: place.ticketCurrency ?? "CNY"
          }
        : undefined,
    rating: place.rating,
    tips: typeof detail.tips === "string" ? detail.tips : undefined,
    source: "本地地点库 · " + place.source,
    confidence: (detail.confidence as PlaceCandidate["confidence"]) ?? "medium",
    verified: false
  };
}

export type { ItineraryPlan };
