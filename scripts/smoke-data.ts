import { loadConfig } from "../src/config.ts";
import { HttpClient } from "../src/core/http.ts";
import { TravelData } from "../src/data/providers.ts";

const config = loadConfig();
const http = new HttpClient({ cacheDir: config.cacheDir });
const data = new TravelData(http, { amapKey: config.amapKey });

const t0 = Date.now();
const geo = await data.geocode("北京");
console.log("[geocode]", geo.availability, geo.provenance.source, "结果", geo.data?.length, ((Date.now() - t0) / 1000).toFixed(1) + "s");
if (geo.data?.[0]) console.log("   ", JSON.stringify(geo.data[0]));

for (const q of ["故宫博物院", "天坛", "慕田峪长城", "埃菲尔铁塔"]) {
  const t1 = Date.now();
  const res = await data.searchPlaces(q, q.includes("埃菲") ? "巴黎" : "北京", 6);
  const first = res.data?.[0];
  console.log(
    "[" + q + "]", res.availability, "|", (Date.now() - t1) + "ms", "|", res.provenance.source,
    "|", res.data?.length ?? 0, "条"
  );
  if (first) {
    console.log("    ", first.name, "|", first.lat + "," + first.lon, "|", first.openingHours ?? "无营业时间", "|", first.ticketRange ? first.ticketRange.min + "-" + first.ticketRange.max + " " + first.ticketRange.currency : "无票价", "|", first.source, "|", first.verified);
  }
  if (res.error) console.log("     err:", res.error.slice(0, 160));
}

const wx = await data.weather(39.9163, 116.3972, "2026-11-20", "2026-11-22");
console.log("[weather]", wx.availability, wx.data?.map((d) => d.date + " " + d.weatherText + " " + d.tempMin + "~" + d.tempMax + "℃ 降水" + d.precipitationProb + "%").join(" | "));

const rt = await data.route(39.9163, 116.3972, 39.9847, 116.4953, "driving");
console.log("[route]", rt.availability, JSON.stringify(rt.data));

const cf = await data.countryFacts("中国");
console.log("[country]", cf.availability, JSON.stringify(cf.data));
