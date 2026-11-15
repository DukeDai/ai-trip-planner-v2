/**
 * 离线种子库：当实时 POI 源不可用时的兜底。
 * 规则：这里的一切都是「参考值」，不是权威数据 —— confidence 最高只给 medium，
 * 且 verified 恒为 false，agent 必须把引用到的条目写进 unconfirmed 清单。
 */

export interface SeedPlace {
  id: string;
  name: string;
  enName: string;
  city: string;
  category: "sight" | "food" | "hotel" | "nature";
  area: string;
  lat: number;
  lon: number;
  openingHours: string;
  ticket: { min: number; max: number; currency: string } | null;
  durationMin: number;
  tips: string;
};

export const SEED_PLACES: SeedPlace[] = [
  { id: "bj-gugong", name: "故宫博物院", enName: "The Palace Museum", city: "北京", category: "sight", area: "东城", lat: 39.91555556, lon: 116.39083333, openingHours: "约 08:30-17:00（周一闭馆，旺季延长）", ticket: { min: 40, max: 60, currency: "CNY" }, durationMin: 180, tips: "需提前 7 天官网实名预约；午门进神武门出" },
  { id: "bj-tiananmen", name: "天安门广场", enName: "Tiananmen Square", city: "北京", category: "sight", area: "东城", lat: 39.904567, lon: 116.391392, openingHours: "约 05:00-22:00（升旗时间随日出变）", ticket: null, durationMin: 90, tips: "需提前预约；过安检排队较久" },
  { id: "bj-tiantan", name: "天坛公园", enName: "Temple of Heaven", city: "北京", category: "sight", area: "东城", lat: 39.8822, lon: 116.4066, openingHours: "约 06:00-21:00（祈年殿 08:00-17:30）", ticket: { min: 15, max: 34, currency: "CNY" }, durationMin: 120, tips: "联票含祈年殿；早上市民公园氛围好" },
  { id: "bj-mutianyu", name: "慕田峪长城", enName: "Mutianyu Great Wall", city: "北京", category: "sight", area: "怀柔", lat: 40.43801667, lon: 116.5619, openingHours: "约 07:30-18:00（旺季延长）", ticket: { min: 40, max: 45, currency: "CNY" }, durationMin: 300, tips: "距市区约 90km；建议包车或景区直通车" },
  { id: "bj-summerpalace", name: "颐和园", enName: "Summer Palace", city: "北京", category: "sight", area: "海淀", lat: 39.9975, lon: 116.2689, openingHours: "约 06:30-18:00（旺季）", ticket: { min: 20, max: 30, currency: "CNY" }, durationMin: 180, tips: "东宫门进、北宫门出；建议租船或自行车" },
  { id: "bj-yonghegong", name: "雍和宫", enName: "Yonghe Temple", city: "北京", category: "sight", area: "东城", lat: 39.947, lon: 116.4113, openingHours: "约 09:00-16:30", ticket: { min: 20, max: 25, currency: "CNY" }, durationMin: 90, tips: "需提前预约；免费赠香" },
  { id: "bj-nanluoguxiang", name: "南锣鼓巷", enName: "Nanluoguxiang", city: "北京", category: "sight", area: "东城", lat: 39.9371, lon: 116.4035, openingHours: "全天开放（店铺约 10:00-22:00）", ticket: null, durationMin: 90, tips: "主街拥挤，往两侧胡同更安静" },
  { id: "bj-shichahai", name: "什刹海", enName: "Shichahai", city: "北京", category: "nature", area: "西城", lat: 39.9403, lon: 116.3855, openingHours: "全天开放", ticket: null, durationMin: 90, tips: "傍晚酒吧街热闹；可租船或骑行环湖" },
  { id: "bj-798", name: "798 艺术区", enName: "798 Art District", city: "北京", category: "sight", area: "朝阳", lat: 39.9847, lon: 116.4953, openingHours: "画廊约 10:00-18:00（周一多闭馆）", ticket: { min: 0, max: 80, currency: "CNY" }, durationMin: 150, tips: "特展单独售票；地铁望京站换乘" },
  { id: "bj-taikooli", name: "三里屯太古里", enName: "Taikoo Li Sanlitun", city: "北京", category: "food", area: "朝阳", lat: 39.9365, lon: 116.4551, openingHours: "约 10:00-22:00", ticket: null, durationMin: 120, tips: "餐饮购物密集；适合安排在行程中段" },
  { id: "bj-yuanmingyuan", name: "圆明园", enName: "Old Summer Palace", city: "北京", category: "sight", area: "海淀", lat: 40.008, lon: 116.298, openingHours: "约 07:00-17:30", ticket: { min: 10, max: 25, currency: "CNY" }, durationMin: 120, tips: "遗址区面积大，注意补水" },
  { id: "bj-beihai", name: "北海公园", enName: "Beihai Park", city: "北京", category: "nature", area: "西城", lat: 39.9254, lon: 116.383, openingHours: "约 06:30-20:00", ticket: { min: 5, max: 10, currency: "CNY" }, durationMin: 90, tips: "白塔登顶看故宫屋脊" },
  { id: "par-eiffel", name: "埃菲尔铁塔", enName: "Eiffel Tower", city: "巴黎", category: "sight", area: "7区", lat: 48.8584, lon: 2.2945, openingHours: "约 09:30-23:45（登顶票分时段）", ticket: { min: 16.8, max: 28.3, currency: "EUR" }, durationMin: 120, tips: "二楼/顶层需预约时段；建议傍晚登顶看夜景" },
  { id: "par-louvre", name: "卢浮宫", enName: "Louvre Museum", city: "巴黎", category: "sight", area: "1区", lat: 48.8606, lon: 2.3376, openingHours: "约 09:00-18:00（周二闭馆）", ticket: { min: 17, max: 22, currency: "EUR" }, durationMin: 240, tips: "官方在线预约；蒙娜丽莎需单独计时" },
  { id: "par-notredame", name: "巴黎圣母院", enName: "Notre-Dame de Paris", city: "巴黎", category: "sight", area: "4区", lat: 48.853, lon: 2.3499, openingHours: "约 08:00-19:00", ticket: null, durationMin: 60, tips: "需官网预约免费时段；广场视野好" },
  { id: "par-arc", name: "凯旋门", enName: "Arc de Triomphe", city: "巴黎", category: "sight", area: "8区", lat: 48.8738, lon: 2.295, openingHours: "约 10:00-23:00（登顶 21:00 前）", ticket: { min: 13, max: 16, currency: "EUR" }, durationMin: 75, tips: "过马路走地下通道；日落时分最挤" },
  { id: "par-sacrecouer", name: "圣心大教堂", enName: "Sacré-Cœur", city: "巴黎", category: "sight", area: "18区", lat: 48.8867, lon: 2.3431, openingHours: "约 06:00-22:30", ticket: null, durationMin: 90, tips: "台阶前是全城最佳俯瞰；周边蒙马特值得散步" },
  { id: "par-orsay", name: "奥赛博物馆", enName: "Musée d'Orsay", city: "巴黎", category: "sight", area: "7区", lat: 48.86, lon: 2.3266, openingHours: "约 09:30-18:00（周二闭馆）", ticket: { min: 13, max: 16, currency: "EUR" }, durationMin: 150, tips: "印象派收藏为主；五层大钟是打卡点" },
  { id: "par-orangerie", name: "橘园美术馆", enName: "Musée de l'Orangerie", city: "巴黎", category: "sight", area: "1区", lat: 48.8638, lon: 2.3226, openingHours: "约 09:00-18:00（周二闭馆）", ticket: { min: 12.8, max: 14.5, currency: "EUR" }, durationMin: 90, tips: "莫奈睡莲椭圆厅，室内可停留" },
  { id: "par-pompidou", name: "蓬皮杜中心", enName: "Centre Pompidou", city: "巴黎", category: "sight", area: "4区", lat: 48.8606, lon: 2.3522, openingHours: "约 11:00-21:00（周二闭馆）", ticket: { min: 15, max: 19, currency: "EUR" }, durationMin: 120, tips: "顶层观景视野好；现代艺术" },
  { id: "par-seine", name: "塞纳河游船", enName: "Seine River Cruise", city: "巴黎", category: "sight", area: "全城", lat: 48.86, lon: 2.305, openingHours: "约 10:00-22:00（班次密集）", ticket: { min: 12, max: 25, currency: "EUR" }, durationMin: 75, tips: "日落班次最贵也最值；需提前订票" },
  { id: "par-versailles", name: "凡尔赛宫", enName: "Palace of Versailles", city: "巴黎", category: "sight", area: "大皇宫（郊区）", lat: 48.8049, lon: 2.1204, openingHours: "约 09:00-18:30（周一闭馆）", ticket: { min: 32, max: 41, currency: "EUR" }, durationMin: 300, tips: "距市区约 20km；RER C 线约 45 分钟" },
  { id: "par-shakespeare", name: "莎士比亚书店", enName: "Shakespeare and Company", city: "巴黎", category: "sight", area: "5区", lat: 48.8526, lon: 2.3471, openingHours: "约 10:00-22:00", ticket: null, durationMin: 45, tips: "塞纳河左岸经典书店，可现场读一段" },
  { id: "par-lemarais", name: "玛黑区", enName: "Le Marais", city: "巴黎", category: "food", area: "3/4区", lat: 48.8575, lon: 2.3622, openingHours: "街区全天，店铺约 11:00-19:00（周日多休）", ticket: null, durationMin: 150, tips: "周日下午很多店关门，别安排在此" },
  { id: "tyo-sensoji", name: "浅草寺", enName: "Sensō-ji", city: "东京", category: "sight", area: "台东区", lat: 35.7148, lon: 139.7967, openingHours: "约 06:00-17:00（雷门与商店街全天）", ticket: null, durationMin: 120, tips: "仲见世商店街早市更热闹；本堂需脱鞋" },
  { id: "tyo-skytree", name: "东京晴空塔", enName: "Tokyo Skytree", city: "东京", category: "sight", area: "墨田区", lat: 35.7101, lon: 139.8107, openingHours: "约 10:00-21:00", ticket: { min: 3100, max: 4500, currency: "JPY" }, durationMin: 120, tips: "需预约时段；与浅草同片区域可一起排" },
  { id: "tyo-meiji", name: "明治神宫", enName: "Meiji Shrine", city: "东京", category: "sight", area: "涩谷区", lat: 35.6764, lon: 139.6993, openingHours: "日出至日落（随季节变化）", ticket: null, durationMin: 90, tips: "南参道入口的鸟居最出片；森林参道避暑" },
  { id: "tyo-shibuya", name: "涩谷十字路口", enName: "Shibuya Crossing", city: "东京", category: "sight", area: "涩谷区", lat: 35.6595, lon: 139.7004, openingHours: "全天开放", ticket: null, durationMin: 45, tips: "最佳观景位在二楼咖啡店" },
  { id: "tyo-shinjukugyoen", name: "新宿御苑", enName: "Shinjuku Gyoen", city: "东京", category: "nature", area: "新宿区", lat: 35.6852, lon: 139.71, openingHours: "约 09:00-16:30（周一闭园）", ticket: { min: 500, max: 1000, currency: "JPY" }, durationMin: 120, tips: "园内禁烟；樱花季极挤" },
  { id: "tyo-ueno", name: "东京国立博物馆", enName: "Tokyo National Museum", city: "东京", category: "sight", area: "台东区", lat: 35.7188, lon: 139.7765, openingHours: "约 09:30-17:00（周一闭馆）", ticket: { min: 1000, max: 1000, currency: "JPY" }, durationMin: 150, tips: "与上野公园连带安排；东洋馆值得单独留时间" },
  { id: "tyo-toyosu", name: "丰洲市场", enName: "Toyosu Market", city: "东京", category: "food", area: "江东区", lat: 35.645, lon: 139.786, openingHours: "约 05:00-14:00（周日休）", ticket: null, durationMin: 120, tips: "金枪鱼拍卖参观需线上抽选；看台免费" },
  { id: "tyo-teamlab", name: "teamLab Planets", enName: "teamLab Planets", city: "东京", category: "sight", area: "江东区", lat: 35.6297, lon: 139.7745, openingHours: "约 09:00-21:00（分时段）", ticket: { min: 3800, max: 4600, currency: "JPY" }, durationMin: 120, tips: "必须线上购票选时段；赤脚涉水" },
  { id: "tyo-ginza", name: "银座", enName: "Ginza", city: "东京", category: "food", area: "中央区", lat: 35.6717, lon: 139.765, openingHours: "商店约 11:00-20:00（周日多休）", ticket: null, durationMin: 120, tips: "中央通周末步行者天国；百货晚间营业" },
  { id: "tyo-yoyogi", name: "代代木公园", enName: "Yoyogi Park", city: "东京", category: "nature", area: "涩谷区", lat: 35.6717, lon: 139.6949, openingHours: "全天开放", ticket: null, durationMin: 90, tips: "适合周末野餐；近原宿与明治神宫" },
  { id: "tyo-ghibli", name: "三鹰之森吉卜力美术馆", enName: "Ghibli Museum", city: "东京", category: "sight", area: "三鹰", lat: 35.6962, lon: 139.5704, openingHours: "分时段，需指定日期入场", ticket: { min: 1000, max: 1000, currency: "JPY" }, durationMin: 120, tips: "需提前官网抢票；禁止拍照" },
  { id: "tyo-takebashita", name: "竹下通", enName: "Takeshita Street", city: "东京", category: "food", area: "涩谷区", lat: 35.6702, lon: 139.7027, openingHours: "约 10:00-20:00", ticket: null, durationMin: 75, tips: "学生街潮流餐饮；周末极挤" }
];

export const SEED_COUNTRIES: Record<string, {
  name: string; code: string; capital: string; currencies: string[]; languages: string[];
  timezones: string[]; drivingSide: string; region: string;
}> = {
  "中国": { name: "中国", code: "CHN", capital: "北京", currencies: ["CNY"], languages: ["zh"], timezones: ["UTC+8"], drivingSide: "right", region: "东亚" },
  "日本": { name: "日本", code: "JPN", capital: "东京", currencies: ["JPY"], languages: ["ja"], timezones: ["UTC+9"], drivingSide: "left", region: "东亚" },
  "法国": { name: "法国", code: "FRA", capital: "巴黎", currencies: ["EUR"], languages: ["fr"], timezones: ["UTC+1", "UTC+2"], drivingSide: "right", region: "西欧" },
  "美国": { name: "美国", code: "USA", capital: "华盛顿哥伦比亚特区", currencies: ["USD"], languages: ["en"], timezones: ["UTC-5", "UTC-6", "UTC-7", "UTC-8", "UTC-9", "UTC-10"], drivingSide: "right", region: "北美" },
  "英国": { name: "英国", code: "GBR", capital: "伦敦", currencies: ["GBP"], languages: ["en"], timezones: ["UTC+0", "UTC+1"], drivingSide: "left", region: "西欧" },
  "泰国": { name: "泰国", code: "THA", capital: "曼谷", currencies: ["THB"], languages: ["th"], timezones: ["UTC+7"], drivingSide: "left", region: "东南亚" },
  "新加坡": { name: "新加坡", code: "SGP", capital: "新加坡", currencies: ["SGD"], languages: ["zh", "en", "ms", "ta"], timezones: ["UTC+8"], drivingSide: "left", region: "东南亚" },
  "意大利": { name: "意大利", code: "ITA", capital: "罗马", currencies: ["EUR"], languages: ["it"], timezones: ["UTC+1", "UTC+2"], drivingSide: "right", region: "南欧" },
  "西班牙": { name: "西班牙", code: "ESP", capital: "马德里", currencies: ["EUR"], languages: ["es"], timezones: ["UTC+1", "UTC+2"], drivingSide: "right", region: "南欧" },
  "德国": { name: "德国", code: "DEU", capital: "柏林", currencies: ["EUR"], languages: ["de"], timezones: ["UTC+1", "UTC+2"], drivingSide: "right", region: "中欧" }
};

export function matchSeedPlaces(query: string, city?: string, limit = 8): SeedPlace[] {
  const q = query.trim().toLowerCase();
  const cityKey = city?.trim();
  let pool = SEED_PLACES;
  if (cityKey) {
    const scoped = SEED_PLACES.filter((p) => p.city.includes(cityKey) || cityKey.includes(p.city));
    if (scoped.length > 0) pool = scoped;
  }
  const scored = pool
    .map((p) => {
      const hay = (p.name + " " + p.enName + " " + p.area + " " + p.city).toLowerCase();
      const idx = hay.indexOf(q);
      let score = idx >= 0 ? 100 - idx : 0;
      if (p.name.toLowerCase().includes(q)) score += 50;
      if (p.enName.toLowerCase().includes(q)) score += 30;
      return { p, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((x) => x.p);
}
