/**
 * 内置事实表（非 API）—— 货币 / 语言 / 时区 / 首都 / 驾驶方向 / 区域。
 *
 * 为什么保留这一张表（而 POI 种子库必须删）：
 * - 国家元数据是**稳定事实**，不是「凭印象编的参考值」；RestCountries 在本机网络下
 *   实测时通时断，完全删掉会让整条行程在源抖动时开天窗。
 * - 但它**不是 API 数据**，所以来源必须如实标注为「内置事实表（非 API）」，
 *   且只在 RestCountries 不可用时兜底。
 *
 * 纪律：这里只放国家级元数据，**不放任何 POI / 票价 / 开放时间**。
 */

export interface CountryFactEntry {
  name: string;
  code: string;
  capital: string;
  currencies: string[];
  languages: string[];
  timezones: string[];
  drivingSide: string;
  region: string;
}

/** 固定的来源标注 —— 任何用到本表的返回值都必须带上它 */
export const COUNTRY_FACT_SOURCE = "内置事实表（非 API）";

export const COUNTRY_FACT_TABLE: Record<string, CountryFactEntry> = {
  中国: { name: "中国", code: "CHN", capital: "北京", currencies: ["CNY"], languages: ["zh"], timezones: ["UTC+8"], drivingSide: "right", region: "东亚" },
  日本: { name: "日本", code: "JPN", capital: "东京", currencies: ["JPY"], languages: ["ja"], timezones: ["UTC+9"], drivingSide: "left", region: "东亚" },
  韩国: { name: "韩国", code: "KOR", capital: "首尔", currencies: ["KRW"], languages: ["ko"], timezones: ["UTC+9"], drivingSide: "right", region: "东亚" },
  泰国: { name: "泰国", code: "THA", capital: "曼谷", currencies: ["THB"], languages: ["th"], timezones: ["UTC+7"], drivingSide: "left", region: "东南亚" },
  新加坡: { name: "新加坡", code: "SGP", capital: "新加坡", currencies: ["SGD"], languages: ["zh", "en", "ms", "ta"], timezones: ["UTC+8"], drivingSide: "left", region: "东南亚" },
  越南: { name: "越南", code: "VNM", capital: "河内", currencies: ["VND"], languages: ["vi"], timezones: ["UTC+7"], drivingSide: "right", region: "东南亚" },
  法国: { name: "法国", code: "FRA", capital: "巴黎", currencies: ["EUR"], languages: ["fr"], timezones: ["UTC+1", "UTC+2"], drivingSide: "right", region: "西欧" },
  德国: { name: "德国", code: "DEU", capital: "柏林", currencies: ["EUR"], languages: ["de"], timezones: ["UTC+1", "UTC+2"], drivingSide: "right", region: "中欧" },
  意大利: { name: "意大利", code: "ITA", capital: "罗马", currencies: ["EUR"], languages: ["it"], timezones: ["UTC+1", "UTC+2"], drivingSide: "right", region: "南欧" },
  西班牙: { name: "西班牙", code: "ESP", capital: "马德里", currencies: ["EUR"], languages: ["es"], timezones: ["UTC+1", "UTC+2"], drivingSide: "right", region: "南欧" },
  英国: { name: "英国", code: "GBR", capital: "伦敦", currencies: ["GBP"], languages: ["en"], timezones: ["UTC+0", "UTC+1"], drivingSide: "left", region: "西欧" },
  美国: { name: "美国", code: "USA", capital: "华盛顿哥伦比亚特区", currencies: ["USD"], languages: ["en"], timezones: ["UTC-5", "UTC-6", "UTC-7", "UTC-8", "UTC-9", "UTC-10"], drivingSide: "right", region: "北美" }
};

/** 宽松匹配：中文名、英文名、含「中国」这样的包含关系都能命中 */
export function matchCountryFact(country: string): CountryFactEntry | undefined {
  const key = country.trim();
  if (!key) return undefined;
  const direct = COUNTRY_FACT_TABLE[key];
  if (direct) return direct;
  const byCode = Object.values(COUNTRY_FACT_TABLE).find((c) => c.code === key.toUpperCase());
  if (byCode) return byCode;
  const fuzzy = Object.values(COUNTRY_FACT_TABLE).find(
    (c) => key.includes(c.name) || c.name.includes(key)
  );
  return fuzzy;
}
