import type { HttpClient } from "../core/http.ts";
import type { Confidence } from "../core/types.ts";

export interface WikidataPlace {
  id: string;
  name: string;
  description?: string;
  lat: number;
  lon: number;
  website?: string;
  openingHours?: string;
  imageUrl?: string;
  source: string;
  confidence: Confidence;
}

interface WikibaseSearchHit {
  id?: string;
  label?: string;
  description?: string;
  match?: { text?: string };
}

function coordOf(entity: Record<string, unknown>): { lat: number; lon: number } | null {
  const claims = entity.claims as Record<string, { mainsnak?: { datavalue?: { value?: unknown } } }[]> | undefined;
  const list = claims?.P625 ?? [];
  for (const c of list) {
    const v = c.mainsnak?.datavalue?.value;
    if (v && typeof v === "object") {
      const o = v as { latitude?: number; longitude?: number };
      if (typeof o.latitude === "number" && typeof o.longitude === "number") {
        return { lat: o.latitude, lon: o.longitude };
      }
    }
  }
  return null;
}

function stringClaims(entity: Record<string, unknown>, pid: string): string[] {
  const claims = entity.claims as Record<string, { mainsnak?: { datavalue?: { value?: unknown } } }[]> | undefined;
  const out: string[] = [];
  for (const c of claims?.[pid] ?? []) {
    const v = c.mainsnak?.datavalue?.value;
    if (typeof v === "string") out.push(v);
    else if (v && typeof v === "object") {
      const o = v as { time?: string; text?: string; id?: string };
      if (o.time) out.push(o.time.replace(/^[+]/, "").replace(/-00-0$/, ""));
      else if (o.text) out.push(o.text);
      else if (o.id) out.push(o.id);
    }
  }
  return out;
}

/** 用 Wikidata 检索地点：拿到坐标、官网、开放起始时间与一句话描述 */
export async function searchWikidata(
  http: HttpClient,
  query: string,
  limit = 6
): Promise<{ places: WikidataPlace[]; error?: string }> {
  const searchUrl =
    "https://www.wikidata.org/w/api.php?action=wbsearchentities&search=" +
    encodeURIComponent(query) +
    "&language=zh&uselang=zh&type=item&format=json&limit=" +
    String(limit);
  const searchRes = await http.json<{ search?: WikibaseSearchHit[] }>(searchUrl, {
    timeoutMs: 9000,
    retries: 1
  });
  if (!searchRes.ok) {
    return { places: [], error: "Wikidata 检索失败：" + (searchRes.error ?? "未知错误") };
  }
  const hits = (searchRes.data?.search ?? []).filter((h) => h.id);
  if (hits.length === 0) return { places: [] };

  const ids = hits.map((h) => h.id as string).join("|");
  const entityUrl =
    "https://www.wikidata.org/w/api.php?action=wbgetentities&ids=" +
    ids +
    "&props=claims|labels&languages=zh|en&format=json";
  const entRes = await http.json<{ entities?: Record<string, Record<string, unknown>> }>(entityUrl, {
    timeoutMs: 9000,
    retries: 1
  });
  if (!entRes.ok) {
    return { places: [], error: "Wikidata 实体读取失败：" + (entRes.error ?? "未知错误") };
  }
  const entities = entRes.data?.entities ?? {};
  const out: WikidataPlace[] = [];
  for (const hit of hits) {
    const id = hit.id as string;
    const entity = entities[id];
    if (!entity) continue;
    const coord = coordOf(entity);
    if (!coord) continue;
    const websites = stringClaims(entity, "P856");
    const hours = [...stringClaims(entity, "P1629"), ...stringClaims(entity, "P1619")].filter(
      (h) => /^\d{1,2}[:.]\d{2}/.test(h)
    );
    const images = stringClaims(entity, "P18");
    out.push({
      id,
      name: hit.label ?? id,
      description: hit.description,
      lat: coord.lat,
      lon: coord.lon,
      website: websites[0],
      openingHours: hours.length ? "开放起始 " + hours.slice(0, 3).join("、") : undefined,
      imageUrl: images[0]
        ? "https://commons.wikimedia.org/wiki/Special:FilePath/" + encodeURIComponent(images[0])
        : undefined,
      source: "Wikidata",
      confidence: "medium"
    });
  }
  return { places: out };
}

/** 维基百科一句话描述（给地点补人话介绍） */
export async function wikipediaSummary(
  http: HttpClient,
  title: string
): Promise<{ description?: string; extract?: string } | null> {
  const encoded = encodeURIComponent(title);
  for (const lang of ["zh", "en"]) {
    const url = "https://" + lang + ".wikipedia.org/api/rest_v1/page/summary/" + encoded;
    const res = await http.json<{ description?: string; extract?: string }>(url, {
      timeoutMs: 8000,
      retries: 0
    });
    if (res.ok && res.data && (res.data.description || res.data.extract)) {
      return {
        description: res.data.description,
        extract: res.data.extract ? res.data.extract.slice(0, 220) : undefined
      };
    }
  }
  return null;
}
