/**
 * 细粒度工具目录 —— 本地 tool search 的底座。
 *
 * 为什么拆细：一个粗粒度的 `search_places` 会把「找景点 / 找餐厅 / 找酒店 / 找机场」
 * 全塞进一个 schema，模型选错参数就出废数据。拆成数据域后，目录可以做检索，
 * 上下文里只挂当前真正需要的那个（见 tool-search.ts）。
 *
 * 每条目录项 = 一个可检索的语义入口 → 一个真实可调用的工具。
 */

export type ToolDomain =
  | "geo"
  | "poi:sight"
  | "poi:food"
  | "poi:stay"
  | "poi:transport"
  | "weather"
  | "route"
  | "country"
  | "budget"
  | "alternative";

export interface ToolCatalogEntry {
  /** 目录项 id */
  id: string;
  /** 实际可调用的工具名 */
  tool: string;
  domain: ToolDomain;
  title: string;
  summary: string;
  whenToUse: string;
  /** 检索关键词（中文为主，兼顾英文） */
  keywords: string[];
  /** 参数模板 */
  args: string;
  /** 调用示例 */
  example: string;
}

export const TOOL_CATALOG: ToolCatalogEntry[] = [
  {
    id: "geo.locate",
    tool: "geocode_place",
    domain: "geo",
    title: "地名定位",
    summary: "把地名/景点名解析成坐标与行政区信息",
    whenToUse: "查天气、算通勤、写 city/lat/lon 之前先定位",
    keywords: ["坐标", "经纬度", "定位", "在哪里", "位置", "地理编码", "geocode", "city", "坐标定位"],
    args: "{ name: '地名', }",
    example: "geocode_place({ name: '京都' })"
  },
  {
    id: "poi.sight",
    tool: "search_sights",
    domain: "poi:sight",
    title: "景点检索",
    summary: "按城市检索景点/博物馆/公园/古迹/自然景观",
    whenToUse: "安排每日点位、核实开放时间与票价时",
    keywords: ["景点", "博物馆", "公园", "古镇", "寺", "庙", "塔", "展览", "自然", "文化", "遗产", "名点", "打卡", "地标", "sight", "museum", "park", "temple", "艺术", "夜景"],
    args: "{ city: '城市', query: '检索词', limit?: 8 }",
    example: "search_sights({ city: '京都', query: '寺庙' })"
  },
  {
    id: "poi.food",
    tool: "search_food",
    domain: "poi:food",
    title: "餐饮检索",
    summary: "按城市检索餐厅/小吃/市集/早餐/特色菜",
    whenToUse: "安排早午晚餐段、匹配预算档位与忌口时",
    keywords: ["餐厅", "餐饮", "美食", "小吃", "早餐", "午餐", "晚餐", "夜市", "市集", "咖啡", "餐", "吃", "菜", "food", "restaurant", "特色菜", "人均"],
    args: "{ city: '城市', query: '检索词', limit?: 8 }",
    example: "search_food({ city: '京都', query: '拉面' })"
  },
  {
    id: "poi.stay",
    tool: "search_lodging",
    domain: "poi:stay",
    title: "住宿检索",
    summary: "按城市检索酒店/民宿/客栈与住宿区线索",
    whenToUse: "选住宿区域、核算住宿预算占比时",
    keywords: ["住宿", "酒店", "民宿", "客栈", "住哪", "落脚", "stay", "hotel", "旅馆", "住在", "过夜"],
    args: "{ city: '城市', query: '检索词', limit?: 8 }",
    example: "search_lodging({ city: '京都', query: '酒店' })"
  },
  {
    id: "poi.transport",
    tool: "search_transport_hub",
    domain: "poi:transport",
    title: "机场/车站检索",
    summary: "按城市检索机场/高铁站/车站/码头等枢纽",
    whenToUse: "安排到达、离开与接驳时",
    keywords: ["机场", "车站", "高铁", "火车站", "码头", "客运", "枢纽", "transport", "airport", "station", "接驳", "抵达", "离开"],
    args: "{ city: '城市', query: '检索词', limit?: 8 }",
    example: "search_transport_hub({ city: '上海', query: '机场' })"
  },
  {
    id: "env.weather",
    tool: "get_daily_weather",
    domain: "weather",
    title: "逐日天气",
    summary: "查目的地逐日预报（最高/最低温、天气、降水概率、风、日出日落）",
    whenToUse: "决定出行顺序、户外 vs 室内、携带雨具时",
    keywords: ["天气", "气温", "下雨", "降水", "预报", "风", "weather", "温度", "雨天", "伞"],
    args: "{ latitude, longitude, startDate, endDate }",
    example: "get_daily_weather({ latitude: 35.01, longitude: 135.76, startDate: '2026-12-01', endDate: '2026-12-03' })"
  },
  {
    id: "env.route",
    tool: "measure_travel_time",
    domain: "route",
    title: "通勤耗时/距离",
    summary: "算两个坐标（或两个地名）之间的距离与通勤时长",
    whenToUse: "排每日动线、验证地理连贯性、写 notes 通勤时间时",
    keywords: ["通勤", "距离", "车程", "多久", "路线", "路程", "耗时", "远近", "route", "drive", "通勤时间", "折返", "片区"],
    args: "{ fromPlace?, fromLat?, fromLon?, toPlace?, toLat?, toLon?, mode? }",
    example: "measure_travel_time({ fromPlace: '上海机场', toPlace: '外滩' })"
  },
  {
    id: "env.country",
    tool: "get_country_profile",
    domain: "country",
    title: "国家档案",
    summary: "查货币/语言/时区/首都/驾驶方向",
    whenToUse: "定预算币种、安排跨时区作息、自驾注意事项时",
    keywords: ["货币", "语言", "时区", "驾驶", "签证", "国家", "币种", "country", "换算", "靠左", "靠右"],
    args: "{ country: '国家名' }",
    example: "get_country_profile({ country: '日本' })"
  },
  {
    id: "money.budget",
    tool: "compute_budget",
    domain: "budget",
    title: "预算汇总",
    summary: "汇总预算明细，算总额/人均/分类小计/差额并给占比告警",
    whenToUse: "写完预算明细后调用，避免心算出错",
    keywords: ["预算", "花费", "成本", "费用", "总价", "开销", "人均", "钱", "budget", "超支", "结余", "占比"],
    args: "{ lines, travelersCount, budgetTotal, currency }",
    example: "compute_budget({ lines: [...], travelersCount: 2, budgetTotal: 8000, currency: 'CNY' })"
  },
  {
    id: "alt.local",
    tool: "find_local_alternative",
    domain: "alternative",
    title: "本地替代方案检索",
    summary: "在同一城市里找体验等价的替代点位，并算出与参照点的距离/耗时差",
    whenToUse: "跨城决策前：对比「去远方」与「在本地玩」的性价比时",
    keywords: ["本地替代", "替代方案", "就近", "等价", "性价比", "降级", "值不值", "划算", "比价", "alternative", "本地", "不出国", "不去", "体验相当"],
    args: "{ city: '本地城市', query: '体验主题', referenceName?, referenceLat?, referenceLon?, limit? }",
    example: "find_local_alternative({ city: '上海', query: '寺庙', referenceName: '京都伏见稻荷' })"
  }
];

/**
 * 受检索门控的工具（按需装载）。
 * 门控对象刻意选「最容易选错」的那几个：四类 POI 检索、国家档案、本地替代检索。
 * 地理编码 / 天气 / 通勤 / 预算 / 流程关卡始终可见 —— 几乎每趟行程都要用，
 * 藏起来只会让模型卡住，反而降低产出质量。
 */
export const GATED_TOOLS = new Set([
  "search_sights",
  "search_food",
  "search_lodging",
  "search_transport_hub",
  "get_country_profile",
  "find_local_alternative"
]);

/** 可被检索装载的工具名集合（目录全集） */
export const RETRIEVABLE_TOOLS = new Set(TOOL_CATALOG.map((e) => e.tool));

/** 始终可见的工具：流程关卡 + 元工具 + 每趟都要用的基础取数 */
export const ALWAYS_VISIBLE_TOOLS = [
  "tool_search",
  "review_itinerary",
  "submit_itinerary",
  "finalize_itinerary",
  "geocode_place",
  "measure_travel_time",
  "get_daily_weather",
  "compute_budget"
];

export function catalogByDomain(domain?: string): ToolCatalogEntry[] {
  if (!domain) return TOOL_CATALOG;
  const d = domain.trim().toLowerCase();
  const exact = TOOL_CATALOG.filter((e) => e.domain.toLowerCase() === d);
  if (exact.length > 0) return exact;
  // 允许用 "poi"、"sight"、"food" 之类的片段
  return TOOL_CATALOG.filter(
    (e) => e.domain.toLowerCase().includes(d) || e.domain.split(":")[1]?.includes(d) === true
  );
}
