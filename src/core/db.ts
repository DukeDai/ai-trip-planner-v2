import { Pool } from "pg";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { PostgresStore } from "@langchain/langgraph-checkpoint-postgres/store";

export const DEFAULT_PG_SCHEMA = "trip_pilot";

export interface DbOptions {
  url: string;
  schema: string;
}

export interface Db {
  pool: Pool;
  schema: string;
  saver: PostgresSaver;
  store: PostgresStore;
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  one<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | null>;
  close(): Promise<void>;
}

/**
 * TripPilot 自己的持久化 schema，与业务库里其它表完全隔离。
 *
 * 设计要点：外部数据源取回的一切都必须落库（source_snapshots / place_index / route_cache），
 * 因为实时查询随时可能失败（限流、网络抖动、上游宕机）。落库之后：
 *   1) 同一份数据不再重复打外网；
 *   2) 外网挂掉时用存档兜底，并如实标注「存档 + 取回时间 + 置信度下调」；
 *   3) 行程产物、快照、偏好都能跨进程/跨会话恢复。
 */
const DDL_TEMPLATE = [
  "CREATE SCHEMA IF NOT EXISTS {schema};",
  "",
  "CREATE TABLE IF NOT EXISTS {schema}.trips (",
  "  id            text PRIMARY KEY,",
  "  title         text NOT NULL,",
  "  destination   text NOT NULL,",
  "  start_date    date NOT NULL,",
  "  end_date      date NOT NULL,",
  "  travelers     integer NOT NULL DEFAULT 1,",
  "  budget_total  numeric(12,2) NOT NULL DEFAULT 0,",
  "  currency      text NOT NULL DEFAULT 'CNY',",
  "  preferences   jsonb NOT NULL DEFAULT '[]'::jsonb,",
  "  status        text NOT NULL DEFAULT 'draft',",
  "  meta          jsonb NOT NULL DEFAULT '{}'::jsonb,",
  "  created_at    timestamptz NOT NULL DEFAULT now(),",
  "  updated_at    timestamptz NOT NULL DEFAULT now()",
  ");",
  "",
  "CREATE TABLE IF NOT EXISTS {schema}.artifacts (",
  "  trip_id    text NOT NULL REFERENCES {schema}.trips(id) ON DELETE CASCADE,",
  "  name       text NOT NULL,",
  "  content    text NOT NULL,",
  "  bytes      integer NOT NULL DEFAULT 0,",
  "  updated_at timestamptz NOT NULL DEFAULT now(),",
  "  PRIMARY KEY (trip_id, name)",
  ");",
  "",
  "CREATE TABLE IF NOT EXISTS {schema}.source_snapshots (",
  "  id           bigserial PRIMARY KEY,",
  "  trip_id      text REFERENCES {schema}.trips(id) ON DELETE CASCADE,",
  "  tool         text NOT NULL,",
  "  query_key    text NOT NULL,",
  "  provider     text NOT NULL,",
  "  url          text,",
  "  fetched_at   timestamptz NOT NULL DEFAULT now(),",
  "  confidence   text NOT NULL DEFAULT 'medium',",
  "  availability text NOT NULL DEFAULT 'ok',",
  "  payload      jsonb NOT NULL DEFAULT 'null'::jsonb,",
  "  raw          jsonb",
  ");",
  "CREATE INDEX IF NOT EXISTS source_snapshots_lookup_idx",
  "  ON {schema}.source_snapshots (tool, query_key, fetched_at DESC);",
  "CREATE INDEX IF NOT EXISTS source_snapshots_trip_idx",
  "  ON {schema}.source_snapshots (trip_id, fetched_at DESC);",
  "",
  "CREATE TABLE IF NOT EXISTS {schema}.place_index (",
  "  place_id        text PRIMARY KEY,",
  "  name            text NOT NULL,",
  "  kind            text,",
  "  city            text,",
  "  district        text,",
  "  lat             numeric(10,7) NOT NULL,",
  "  lng             numeric(10,7) NOT NULL,",
  "  source          text NOT NULL,",
  "  source_ref      text,",
  "  opening_hours   jsonb NOT NULL DEFAULT '{}'::jsonb,",
  "  ticket_min      numeric(10,2),",
  "  ticket_max      numeric(10,2),",
  "  ticket_currency text,",
  "  rating          numeric(3,2),",
  "  business_status text NOT NULL DEFAULT 'active',",
  "  source_detail   jsonb NOT NULL DEFAULT '{}'::jsonb,",
  "  fetched_at      timestamptz NOT NULL DEFAULT now(),",
  "  updated_at      timestamptz NOT NULL DEFAULT now()",
  ");",
  "CREATE INDEX IF NOT EXISTS place_index_city_idx ON {schema}.place_index (city);",
  "CREATE INDEX IF NOT EXISTS place_index_name_idx ON {schema}.place_index (name);",
  "",
  "CREATE TABLE IF NOT EXISTS {schema}.route_cache (",
  "  from_key     text NOT NULL,",
  "  to_key       text NOT NULL,",
  "  mode         text NOT NULL,",
  "  duration_min integer NOT NULL,",
  "  distance_km  numeric(10,2) NOT NULL,",
  "  source       text NOT NULL,",
  "  computed_at  timestamptz NOT NULL DEFAULT now(),",
  "  PRIMARY KEY (from_key, to_key, mode)",
  ");",
  "",
  "CREATE TABLE IF NOT EXISTS {schema}.preferences (",
  "  id         bigserial PRIMARY KEY,",
  "  scope      text NOT NULL,",
  "  key        text NOT NULL,",
  "  value      jsonb NOT NULL,",
  "  weight     numeric(4,2) NOT NULL DEFAULT 1,",
  "  trip_id    text REFERENCES {schema}.trips(id) ON DELETE CASCADE,",
  "  updated_at timestamptz NOT NULL DEFAULT now()",
  ");",
  "CREATE UNIQUE INDEX IF NOT EXISTS preferences_scope_key_idx",
  "  ON {schema}.preferences (scope, key, COALESCE(trip_id, ''));",
  ""
].join("\n");

export async function connectDb(options: DbOptions): Promise<Db> {
  const schema = options.schema.replace(/[^a-zA-Z0-9_]/g, "_");
  const pool = new Pool({ connectionString: options.url, max: 8 });
  await pool.query("select 1");
  await pool.query(DDL_TEMPLATE.split("{schema}").join(schema));

  const saver = new PostgresSaver(pool, undefined, { schema });
  await saver.setup();
  const store = new PostgresStore({ connectionOptions: { connectionString: options.url }, schema });
  await store.setup();

  const query = async <T>(sql: string, params: unknown[] = []): Promise<T[]> => {
    const res = await pool.query(sql, params as never[]);
    return res.rows as T[];
  };
  const one = async <T>(sql: string, params: unknown[] = []): Promise<T | null> => {
    const rows = await query<T>(sql, params);
    return rows.length > 0 ? rows[0] : null;
  };

  return {
    pool,
    schema,
    saver,
    store,
    query,
    one,
    close: async () => {
      await pool.end();
    }
  };
}
