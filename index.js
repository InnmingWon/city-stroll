/**
 * Xiaohongshu food & attractions guide for city residents (常驻人群), multi-city.
 *
 * A Host-only Cordis plugin that registers one model-facing tool:
 *   xiaohongshu_guide
 *
 * It aggregates web search results (Xiaohongshu posts and the wider web) for a
 * destination's 美食 (food) and 景点 (attractions) into two rankings —
 *   (1) 近期热门（随季节变化 / 活动出圈）, and
 *   (2) 经典口碑（老牌长青）—
 * and appends a single-day (within-one-day) 景点+正餐 itinerary with time estimates.
 *
 * Audience: people who already live in a supported city (熟悉城市, 但对出游/美食不熟),
 * NOT first-time tourists — results favour seasonal/event-driven spots and
 * local classic spots over landmark sightseeing (故宫/长城 etc.).
 * Supported cities (data/): 北京 上海 广州 深圳 成都 杭州 西安 武汉 南京 重庆.
 *
 * Extra knobs:
 *   - `origin` (所在区/出发地; default = 城市中心地铁站) biases queries to nearby
 *     spots so the itinerary stays close to home.
 *   - `preference` (综合 / 自然秋景 / 人文老城 / 文艺展览 / 美食探店 / 运动户外)
 *     steers queries + scoring via PREFERENCE_KEYWORDS; 综合 = 无特别倾向（全面均衡）.
 *   - `theme` (通用 / 情侣约会 / 朋友聚会 / 亲子遛娃 / 带父母 / 独自慢游)
 *     personalizes queries + scoring via THEME_KEYWORDS.
 *   - `slot` (上午 / 下午 / 晚上) picks start time (09:00 / 13:00 / 18:00); 晚上
 *     switches to night-life keywords (夜游/灯光秀/演艺/夜市/展览) and drops
 *     daytime-only spots (爬山/赏红叶/露营…).
 *   - The itinerary's meal slots use only 正餐 (meal) candidates — desserts,
 *     drinks and snacks (冰沙/雪冰/糖葫芦/奶茶…) are excluded from lunch/dinner.
 *   - Attractions are reordered by a real-coordinate nearest-neighbour (haversine)
 *     顺路 pass over an offline per-city POI coordinate table — no keyword-based
 *     cluster guessing; coordinates are rough, not navigation-grade.
 *   - Cross-validation confidence (置信度) = 独立来源（域名）数 × 来源权威度;
 *     ENTITY_ALIASES normalizes place-name variants (香山公园 = 北京香山公园).
 *
 * Popularity is a heuristic multi-factor score estimated from aggregated search
 * results (cross-validation confidence × recency time-decay × heat × engagement
 * × cross-source frequency) — NOT live Xiaohongshu metrics.
 */
import { readFileSync } from 'node:fs';
import z from '@deepseek-ai/schemastery';

export const inject = ['tools', 'web'];

// 多城市索引（城市名/别名/区 → 数据文件 + 默认出发地），零依赖读取。
const CITIES = JSON.parse(readFileSync(new URL('./data/cities.json', import.meta.url), 'utf8')).cities;
const CITY_DATA = new Map(); // id -> 已解析的城市数据（懒加载缓存）
const CITY = { id: null, name: null, defaultOrigin: null }; // 当前命中的城市（工具单线程执行，无并发竞争）

/** 依 destination 匹配城市：先按城市名/别名（含双向包含），再按区名兜底。 */
function matchCity(destination) {
  const d = String(destination ?? '').trim().toLowerCase();
  if (!d) return null;
  for (const city of CITIES) {
    const names = [city.name, ...(city.aliases ?? [])].map((s) => String(s).toLowerCase());
    if (names.some((n) => d.includes(n) || n.includes(d))) return city;
  }
  for (const city of CITIES) {
    if ((city.districts ?? []).some((s) => d.includes(String(s).toLowerCase()))) return city;
  }
  return null;
}

/** 插件配置（可选）。安装后可在 bundle 的 config 中覆盖这些默认值。 */
export const Config = z.object({
  maxResults: z.number().min(1).max(20).default(8).description('每次 web 检索返回的结果条数上限。'),
  timeoutMs: z.number().min(10000).max(600000).default(120000).description('工具执行超时（毫秒）。'),
  defaultOrigin: z.string().default('知春路').description('目的地未命中任何城市数据时的兜底出发地。'),
});


// ---------------------------------------------------------------------------
// Heuristic signals (documented; never presented as official metrics).
// ---------------------------------------------------------------------------

const TRENDING_WORDS = [
  '新开', '新晋', '新店', '新景', '上新', '网红', '爆火', '排队', '人气', '打卡',
  '出圈', '刷屏', '安利', '热门', '最近', '近期', '最新', '本季', '季节', '限定',
  '活动', '展览', '市集', '快闪', '限时', '首店',
];

const CLASSIC_WORDS = [
  '经典', '老字号', '老牌', '老店', '百年', '传统', '地道', '招牌', '口碑',
  '常青', '本地人', '情怀', '小时候', '几十年', '非遗', '名店', '回头客',
];

/** 出游偏好（风格）→ 关键词注入 + 打分。综合 = 无特别倾向（全面均衡，默认）。 */
const PREFERENCE_KEYWORDS = {
  综合: [],
  自然秋景: ['自然', '秋景', '赏秋', '红叶', '银杏', '枫叶', '公园', '森林', '湿地', '登山', '徒步', '郊野', '花海', '湖泊', '秋色', '山水'],
  人文老城: ['胡同', '老城', '古建', '历史', '博物馆', '故居', '街区', '四合院', '古迹', '文化', '城墙', '传统'],
  文艺展览: ['展览', '美术馆', '博物馆', '艺术', '画廊', '剧场', '话剧', '音乐会', '文创', '市集', '演出'],
  美食探店: ['美食', '探店', '必吃', '老字号', '网红', '餐厅', '火锅', '烧烤', '小吃', '甜品', '夜市', '大排档'],
  运动户外: ['运动', '骑行', '徒步', '跑步', '户外', '体育', '健身', '攀岩', '球类', '郊野', '绿道'],
};

const MEAL_WORDS = [
  '餐厅', '饭店', '饭馆', '菜馆', '酒楼', '食府', '涮肉', '烤鸭', '火锅', '面馆',
  '家常菜', '川菜', '湘菜', '粤菜', '淮扬', '清真', '老字号', '正餐', '午餐', '晚餐',
  '烤肉', '羊蝎子', '铜锅', '酱肉', '炒肝', '卤煮', '炸酱面', '饺子', '包子',
];

const SNACK_WORDS = [
  '冰沙', '雪冰', '糖葫芦', '奶茶', '甜品', '甜点', '咖啡', '面包', '蛋糕',
  '冰淇淋', '冰激凌', '小吃', '零嘴', '点心', '糕点', '酸奶', '茶饮', '果汁', '零食',
];

/** 夜间/晚间活动信号（晚上时段用来筛选「有活动」的去处）。 */
const NIGHT_WORDS = [
  '夜游', '灯光', '灯光秀', '灯会', '灯节', '夜景', '夜市', '演艺', '演出', '舞台剧',
  '音乐会', '话剧', '市集', '快闪', '亮化', '夜场', '晚场', '展览', 'livehouse', 'live',
  '露天电影', '光影', '不夜', '夜跑', '水岸', '亮马河', '夜生活', '深夜',
];

/** 白天专属活动（晚上时段应降权/剔除，避免推荐爬山/赏红叶这种只能白天去的地方）。 */
const DAY_ONLY_WORDS = [
  '爬山', '徒步', '登高', '登山', '赏红叶', '赏银杏', '银杏', '红叶', '枫叶', '秋景',
  '彩叶', '晨练', '日出', '露营', '骑行', '山野', '花海',
];

/** 个性化主题（同行人/场景）→ 关键词注入 + 打分，用于「个性化推荐」。 */
const THEME_KEYWORDS = {
  情侣约会: ['约会', '浪漫', '氛围感', '夜景', '下午茶', '安静', '拍照', '适合两人'],
  朋友聚会: ['聚会', '聚餐', '热闹', '多人', '烤肉', '火锅', '啤酒', '撸串'],
  亲子遛娃: ['亲子', '遛娃', '儿童', '乐园', '科普', '互动', '家庭', '寓教于乐'],
  带父母: ['适合老人', '平缓', '无障碍', '轻松', '园林', '环境好', '步行少'],
  独自慢游: ['独处', '安静', '慢节奏', '书店', '咖啡', '展览', '美术馆', '小众'],
};

/** 当前城市辖区，用于顺路聚类的兜底（名字里直接带区名时命中）。 */
let AREAS = [];

/** 过滤纯来源页/攻略页标题（去噪：这些不是具体地点）。 */
const GENERIC_NAME_RE =
  /^(携程|去哪儿|大众点评|美团|马蜂窝|穷游|猫途鹰|TripAdvisor|百度|高德|点评|攻略|游记|指南|榜单|排行|周边)/i;

/** 来源域名分类（权威度权重）：用于交叉验证 + 白名单加权。3=官方/权威口碑, 2=社区/榜单/旅行, 1=其他, 0=噪声。 */
const DOMAIN_RULES = [
  { re: /\.gov\.cn/, type: 'official', weight: 3 },
  { re: /(?:^|\.)(?:dianping|meituan)\.com/, type: 'review', weight: 3 },
  { re: /(?:^|\.)(?:xiaohongshu|xhslink)\.com/, type: 'community', weight: 2 },
  { re: /(?:^|\.)bendibao\.com/, type: 'ranking', weight: 2 },
  { re: /(?:^|\.)(?:gaode|amap)\.com/, type: 'ranking', weight: 2 },
  { re: /(?:mafengwo|ctrip|qyer|trip\.com)/, type: 'travel', weight: 2 },
  { re: /(?:baike|wiki|zhihu\/question|cidian|\.b2b|qcc|aiqicha|tianyancha|huangye|\/shop\/)/, type: 'noise', weight: 0 },
];

/** 噪声文件扩展名（PDF/Office/图片等非网页；允许后面跟 # 片段或 ? 查询）。 */
const NOISE_EXT_RE = /\.(?:pdf|docx?|xlsx?|pptx?|zip|rar|7z|jpg|jpeg|png|gif|webp)(?:[?#]|$)/i;

/** 搜索引擎/黄页/列表检索结果页（非具体 POI 内容页）。 */
const SEARCH_PAGE_RE = /(?:\/sou\/|\/search\/|map_list|keyword=)/i;

/** 置信度标签（用于展示）。 */
const CONF_LABEL = { 3: '高', 2: '中', 1: '低', 0: '—' };

/** 从 URL 提取域名（去 www.）。 */
function domainOf(url) {
  const u = String(url ?? '');
  if (!u) return 'unknown';
  try {
    return new URL(u).hostname.replace(/^www\./, '') || 'unknown';
  } catch {
    const m = u.match(/^https?:\/\/([^/]+)/);
    return m ? m[1].replace(/^www\./, '') : 'unknown';
  }
}

/** 来源分类：返回 { type, weight }；weight=0 表示噪声，应直接丢弃。 */
function classifySource(url) {
  const u = String(url ?? '');
  if (!u || NOISE_EXT_RE.test(u) || SEARCH_PAGE_RE.test(u)) return { type: 'noise', weight: 0 };
  for (const rule of DOMAIN_RULES) {
    if (rule.re.test(u)) return { type: rule.type, weight: rule.weight };
  }
  return { type: 'other', weight: 1 };
}

// ---------------------------------------------------------------------------
// 实体归一（经典地名别名表）：让「北京香山公园」和「香山公园」在交叉验证时算作同一地点。
// 每个 entry.name 是规范名，entry.aliases 是各种写法/简称；规范名也会自动进入索引。
// ---------------------------------------------------------------------------

let ENTITY_ALIASES = [];

let ENTITY_INDEX = null;

function buildEntityIndex() {
  const map = new Map();
  for (const entry of ENTITY_ALIASES) {
    for (const n of [entry.name, ...(entry.aliases ?? [])]) {
      const key = String(n).toLowerCase();
      if (!map.has(key)) map.set(key, entry.name);
    }
  }
  return map;
}

/** 实体归一：把「北京香山公园」/「香山」/「香山红叶节」都归一到「香山公园」；无匹配返回 null。 */
function normalizeEntity(name) {
  const n = String(name ?? '').trim();
  if (n.length < 2) return null;
  if (!ENTITY_INDEX) ENTITY_INDEX = buildEntityIndex();
  const lower = n.toLowerCase();
  let best = null;
  let bestLen = 0;
  for (const [key, canonical] of ENTITY_INDEX) {
    if (lower.includes(key) && key.length > bestLen) {
      best = canonical;
      bestLen = key.length;
    } else if (key.includes(lower) && lower.length >= 2 && key.length > bestLen) {
      best = canonical;
      bestLen = key.length;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// 条目名清洗：去掉来源站名后缀、@作者前缀、攻略类尾缀；丢弃无意义碎片与榜单/攻略集合页标题。
// ---------------------------------------------------------------------------

const SOURCE_SUFFIX_RE =
  /(?:[-–—‖|｜·！!：:～~]+\s*|\s*[-–—‖|｜·！!：:～~]+\s*)(?:大众点评|穷游网|马蜂窝|携程|去哪儿|美团|本地宝|北京本地宝|北京时间|Trip\.com|Ctrip|Mafengwo).*$/i;
const AUTHOR_PREFIX_RE = /^@[^\s，,。；;！!？?…:：]{1,30}(?:的笔记|的帖子)?\s*/;
const TRAILING_TAG_RE = /[（(【\[《]?(?:详情|攻略|指南|清单|合集|实况|打卡|推荐|介绍|游记|大全|盘点|地图|路线)[）)】\]》]?$/;
const GUIDE_TITLE_RE =
  /(?:好去处|去处|攻略|指南|地图|盘点|清单|合集|排行|榜单|榜|必吃榜|Top\s*\d+|大合集|[三四五六七八九十百]+\s*家|大公开|在哪|哪里|怎么玩|去哪玩|值得|有哪些|\d{4}年|\d+处|个?(?:景点|地点|地方|公园|好去处)|整理|精选|私藏|玩法)/i;
const NOTE_SENTENCE_RE =
  /(?:氛围感|拉满|就要|太好|真的|终于|最近|一定要|必须|强烈|安利|种草|拔草|好吃|好玩|好拍|出片|绝美|太美|太绝|谁懂|好吃到|好喝到|最美|必打卡|真实|好评|感谢|带路|已经|天花板|推薦|建議|季節|很美|超美|超值|五星|探店|堂食|就对了|来这儿|一顿|登高|期待|拥抱|褪去|藏在)/i;
const CANTONESE_RE = /[係唔嚟咩嘅睇咗冇嘢喺嗰咁啲哋嚟]/;
const JAPANESE_RE = /[\u3040-\u309f\u30a0-\u30ff]/;
const PURE_NOISE = new Set([
  '出圈', '附近美食', '北京 朝阳', '北京朝阳', '2026', '也不是很近', '凑个热闹',
  '还好来得早没排队', '自然氧吧', '金十字', '黑 橘', '黑+橘', '榜单', '排行', '攻略', '指南', '详情', '清单', '合集',
  '北京', '朝阳', '海淀', '东城', '西城', '丰台', '石景山', '通州',
]);

function sanitizeName(raw) {
  let s = String(raw ?? '').trim();
  if (!s) return '';
  s = s.replace(SOURCE_SUFFIX_RE, '').trim();
  s = s.replace(AUTHOR_PREFIX_RE, '').trim();
  s = s.replace(TRAILING_TAG_RE, '').trim();
  s = s.replace(/[—…！!？?。]+$/, '').trim();
  if (s.length < 2) return '';
  if (PURE_NOISE.has(s)) return '';
  if (/^[\d\s]+$/.test(s)) return '';
  if (JAPANESE_RE.test(s)) return ''; // 日文标题 → 非中文实体
  const latinCount = (s.match(/[A-Za-z]/g) || []).length;
  const cjkCount = (s.match(/[\u4e00-\u9fff]/g) || []).length;
  if (latinCount > 0 && latinCount >= cjkCount) return ''; // 拉丁字母主导（英文标题）→ 非中文实体
  if ((s.match(/[、,，]/g) || []).length >= 2) return ''; // 多顿号列表标题 → 非实体
  if (/[啊呢吧嘛呀]$/.test(s)) return ''; // 句末语气词 → 句子型标题，非实体
  if (/[！!？?]/.test(s)) return ''; // 感叹/问号 → 句子型标题，非实体
  if (CANTONESE_RE.test(s)) return ''; // 粤语/港式标题 → 非实体
  if (NOTE_SENTENCE_RE.test(s)) return ''; // 笔记体句子标题 → 非实体
  if (GUIDE_TITLE_RE.test(s)) return ''; // 榜单/攻略/合集页标题 → 非实体
  return truncate(s, 24);
}

/** Count case-insensitive occurrences of each signal word in `text`. */
function countSignals(text, words) {
  if (!text) return 0;
  const lower = String(text).toLowerCase();
  let n = 0;
  for (const word of words) {
    const w = word.toLowerCase();
    let index = 0;
    while ((index = lower.indexOf(w, index)) !== -1) {
      n += 1;
      index += w.length;
    }
  }
  return n;
}

/** 时间衰减权重（用于近期热门）：越新权重越高；未知时间取中性 0.5。 */
function recencyWeight(published, now) {
  if (!Number.isFinite(published)) return 0.5;
  const days = (now - published) / 86400000;
  if (days < 0) return 0.5;
  if (days <= 3) return 1;
  if (days <= 7) return 0.9;
  if (days <= 30) return 0.7;
  if (days <= 90) return 0.4;
  return 0.2;
}

/** 把「3.2万 / 5k / 3000」等中文数字串解析成数值。 */
function parseCnNumber(s) {
  if (!s) return 0;
  const m = String(s).match(/(\d+(?:\.\d+)?)/);
  if (!m) return 0;
  let v = parseFloat(m[1]);
  if (!Number.isFinite(v)) return 0;
  if (/万|w/i.test(s)) v *= 10000;
  else if (/千|k/i.test(s)) v *= 1000;
  return v;
}

/** 把数值格式化为「3.2万 / 5千」的展示串。 */
function formatCount(n) {
  if (!Number.isFinite(n)) return '';
  if (n >= 10000) return `${(n / 10000).toFixed(1).replace(/\.0$/, '')}万`;
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}千`;
  return `${Math.round(n)}`;
}

/** 提取带语义的真实口碑/热度信号（评分、点评数、热度、点赞、收藏、播放）。 */
function extractStructuredSignals(text) {
  const t = String(text ?? '');
  const rating = (() => {
    // 前缀格式「评分4.6 / 分数4.5 / 口味4.2 / 综合分4.3」
    let m = t.match(/(?:评分|分数|口味|环境|服务|口碑分|综合分)\s*[:：]?\s*(\d(?:\.\d)?)/);
    // 后缀格式「4.5分」（最常见；排除「5分钟 / 3秒钟」）
    if (!m) m = t.match(/(\d(?:\.\d)?)\s*分(?![钟秒])/);
    if (!m) return null;
    const v = parseFloat(m[1]);
    return v >= 1 && v <= 5 ? v : null;
  })();
  const reviews = parseCnNumber(t.match(/[\d.]+万?\s*条?\s*点评/)?.[0]);
  const comments = parseCnNumber(t.match(/[\d.]+万?\s*条?\s*(?:评论|评价)/)?.[0]);
  const heat = (() => {
    const m = t.match(/(?:热度|人气)\s*[:：]?\s*(\d{1,3})/);
    return m ? parseInt(m[1], 10) : null;
  })();
  const likes = parseCnNumber(t.match(/点赞\s*[\d.]+万?/)?.[0]);
  const collects = parseCnNumber(t.match(/收藏\s*[\d.]+万?/)?.[0]);
  const plays = parseCnNumber(t.match(/播放(?:量|次数)?\s*[\d.]+万?/)?.[0]);
  return { rating, reviews, comments, heat, likes, collects, plays };
}

/** 互动量代理：点赞+收藏+播放+评论 的加权，辅以裸数字兜底（有些结果不带语义前缀）。 */
function extractEngagement(text) {
  const t = String(text ?? '');
  const s = extractStructuredSignals(t);
  let score = s.likes + s.collects + s.plays + s.comments;
  if (score === 0) {
    const hits = t.match(/(\d+(?:\.\d+)?)\s*(万|w|k|千)/gi) ?? [];
    for (const h of hits) {
      const n = parseFloat(h.replace(/[^\d.]/g, ''));
      if (Number.isFinite(n)) score += /万|w/i.test(h) ? n * 10000 : n * 1000;
    }
  }
  score += countSignals(t, ['收藏', '点赞', '评论', '浏览', '种草', '转发']) * 100;
  return score;
}

const EMOJI_URL_RE =
  /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}\u{2190}-\u{21FF}]|https?:\/\/\S+/gu;
const HOOK_WORDS =
  /^(网红|新开|新晋|最新|最近|本季|本周|周末|发现|安利|打卡|分享|推荐|攻略)\s*[:：]?\s*/;
const BARE_HOOK_RE =
  /^(网红|新开|新晋|最新|最近|本季|本周|周末|发现|安利|打卡|分享|推荐|攻略)$/;

/** Strip emoji/URLs/decoration and collapse whitespace. */
function stripNoise(text) {
  return String(text ?? '')
    .replace(EMOJI_URL_RE, '')
    .replace(/[|｜·•▪◦※☆★▶►→↑↓✓✔✅❌]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Extract a clean name candidate from a snippet (quoted entity → first clean phrase). */
function nameFromSnippet(snippet) {
  const s = stripNoise(snippet);
  if (!s) return null;
  const sq = s.match(/[「『“"【《]([^」』”"】》]{2,24})[」』”"】》]/);
  if (sq && sq[1].trim().length >= 2) return sq[1].trim();
  const first = s.split(/[，,。；;！!？?]/)[0].trim();
  if (
    first.length >= 2 &&
    first.length <= 24 &&
    !/(来源|作者|发布|阅读|评论|点赞|浏览|转载|编辑|时间|近日|目前)/.test(first)
  ) {
    return first;
  }
  return null;
}

/**
 * Extract a short, name-like label from a search result — deterministic, no LLM.
 * Priority: quoted entity → snippet (for sentence/headline titles) → delimiter split → snippet → truncate.
 */
function extractName(title, snippet) {
  let t = stripNoise(title);
  if (!t) return '';

  // 1) quoted entity 「…」『…』“…” "…" 【…】《…》 — almost always the place/event name.
  const q = t.match(/[「『“"【《]([^」』”"】》]{2,24})[」』”"】》]/);
  if (q && q[1].trim().length >= 2) return q[1].trim();

  // 2) strip bracket tags and leading hook words.
  t = t.replace(/^【[^】]{1,24}】\s*/, '').replace(/^\[[^\]]{1,24}\]\s*/, '');
  t = t.replace(HOOK_WORDS, '');

  // sentence/headline signal: trailing dash/ellipsis or exclamation/question marks.
  const looksLikeHeadline = /[—…]+\s*$/.test(t) || /[！？。]/.test(t);

  // 3) if the title is a sentence/headline, prefer a clean name from the snippet.
  if (looksLikeHeadline && snippet) {
    const fromSnippet = nameFromSnippet(snippet);
    if (fromSnippet) return fromSnippet;
  }

  // 4) cut at strong delimiters; prefer the first fragment that isn't a bare hook.
  const frags = t.split(/[———:：|｜]+/).map((s) => s.trim()).filter((s) => s.length >= 2);
  if (frags.length >= 2) {
    const pick = frags.find((s) => !BARE_HOOK_RE.test(s)) || frags[0];
    return truncate(pick, 24);
  }

  // 5) too-long or too-short core → snippet fallback.
  const core = t.replace(/[—…]+$/, '');
  if ((core.length > 24 || core.length <= 4) && snippet) {
    const fromSnippet = nameFromSnippet(snippet);
    if (fromSnippet) return fromSnippet;
  }

  return truncate(core, 24);
}

/** Collapse whitespace and truncate a snippet. */
function truncate(text, max = 90) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…`;
}

/** Rough seasonal hint by month, for seasonal keyword injection. */
function getSeasonHint() {
  const m = new Date().getMonth() + 1; // 1–12
  if (m >= 3 && m <= 5) return '赏花 樱花 桃花 踏青 春游';
  if (m >= 6 && m <= 8) return '避暑 荷花 纳凉 夜游 夏夜';
  if (m >= 9 && m <= 11) return '赏秋 银杏 红叶 枫叶 秋游';
  return '冰雪 温泉 滑雪 赏雪 灯会 冬景';
}

// ---------------------------------------------------------------------------
// 各城市离线 POI 坐标库 + 空间算法（Yuntu 式「真实 POI 池 + 空间算法」）。
// 坐标用于「就近 / 同路顺路 / 通勤」粗算，非精确导航；精确路线请以高德/百度地图为准。
// 所有候选地点先经坐标解析；解析不到坐标的地点排到候选末尾，不再依赖关键词猜片区。
// ---------------------------------------------------------------------------

/** 当前城市主要地铁站坐标（WGS84，用于通勤粗算与就近出发）。 */
let METRO_STATIONS = [];

/** 当前城市常见美食 / 景点坐标库（WGS84）。name 与 ENTITY_ALIASES 的规范名对齐。 */
let POI_DB = [];

let POI_INDEX = null;
let METRO_INDEX = null;

/** 加载并切换当前城市数据（重置缓存索引）。工具单线程执行，切换安全。 */
function loadCityData(city) {
  if (!CITY_DATA.has(city.id)) {
    CITY_DATA.set(
      city.id,
      JSON.parse(readFileSync(new URL(`./data/${city.id}.json`, import.meta.url), 'utf8')),
    );
  }
  const data = CITY_DATA.get(city.id);
  CITY.id = city.id;
  CITY.name = city.name;
  CITY.defaultOrigin = city.defaultOrigin;
  AREAS = data.areas ?? [];
  ENTITY_ALIASES = data.entityAliases ?? [];
  METRO_STATIONS = data.metroStations ?? [];
  POI_DB = data.poiDb ?? [];
  ENTITY_INDEX = null;
  POI_INDEX = null;
  METRO_INDEX = null;
  return data;
}

function buildPoiIndex() {
  const map = new Map();
  for (const p of POI_DB) {
    map.set(String(p.name).toLowerCase(), p);
    for (const alias of p.aliases ?? []) map.set(String(alias).toLowerCase(), p);
  }
  return map;
}

/** haversine 球面距离（公里）。 */
function haversine(a, b) {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const sinLat = Math.sin(dLat / 2);
  const sinLng = Math.sin(dLng / 2);
  const s =
    sinLat * sinLat +
    Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * sinLng * sinLng;
  return 2 * R * Math.asin(Math.sqrt(s));
}

/** 解析地点坐标：精确名 → 别名 → 模糊包含；解析不到返回 null。 */
function coordOf(name) {
  const n = String(name ?? '').trim();
  if (n.length < 2) return null;
  if (!POI_INDEX) POI_INDEX = buildPoiIndex();
  const lower = n.toLowerCase();
  if (POI_INDEX.has(lower)) return POI_INDEX.get(lower);
  for (const [key, p] of POI_INDEX) {
    if (lower.includes(key) || key.includes(lower)) return p;
  }
  return null;
}

/** 解析地铁站坐标（精确 / 模糊）。 */
function metroCoordOf(name) {
  const n = String(name ?? '').trim();
  if (!n) return null;
  if (!METRO_INDEX) {
    METRO_INDEX = new Map(METRO_STATIONS.map((s) => [s.name.toLowerCase(), s]));
  }
  const lower = n.toLowerCase();
  if (METRO_INDEX.has(lower)) return METRO_INDEX.get(lower);
  for (const [key, s] of METRO_INDEX) if (lower.includes(key) || key.includes(lower)) return s;
  return null;
}

/** 估算从 origin 到 name 的通勤（基于坐标 + 地铁平均速度粗算，非实时导航）。 */
function commuteOf(name, origin) {
  const target = coordOf(name);
  const from = metroCoordOf(origin) || coordOf(origin) || metroCoordOf(CITY.defaultOrigin);
  if (!target) {
    const n = String(name ?? '');
    let minutes = 40;
    if (/朝阳/.test(n)) minutes = 45;
    else if (/海淀|中关村|五道口|学院路|颐和|圆明/.test(n)) minutes = 25;
    else if (/西城|东城|鼓楼|什刹海|前门|天坛|故宫|北海/.test(n)) minutes = 30;
    return { route: '地铁/公交换乘（该地点暂无坐标，具体请用高德/百度地图查询）', minutes };
  }
  const km = haversine(from, target);
  const minutes = Math.max(8, Math.round((km / 35) * 60 + 12));
  const fromLabel = origin || CITY.defaultOrigin || '知春路';
  const toMetro = target.metro ? `（${target.metro} 方向）` : '';
  return {
    route: `地铁（${fromLabel} → 目的地${toMetro}），直线约 ${km.toFixed(1)} km，粗估`,
    minutes,
  };
}

/** 顺路排序：从出发地出发的最近邻贪心（haversine），等价于 TSP 最近邻，减少回头路。 */
function orderByProximity(names, origin) {
  const start = metroCoordOf(origin) || coordOf(origin) || metroCoordOf(CITY.defaultOrigin);
  const withCoord = [];
  const noCoord = [];
  for (const name of [...new Set(names)]) {
    const p = coordOf(name);
    if (p) withCoord.push({ name, coord: p });
    else noCoord.push(name);
  }
  const ordered = [];
  let cur = start;
  const remaining = withCoord;
  while (remaining.length) {
    let bestIdx = 0;
    let bestDist = Infinity;
    for (let i = 0; i < remaining.length; i += 1) {
      const d = haversine(cur, remaining[i].coord);
      if (d < bestDist) {
        bestDist = d;
        bestIdx = i;
      }
    }
    const picked = remaining.splice(bestIdx, 1)[0];
    ordered.push(picked.name);
    cur = picked.coord;
  }
  return [...ordered, ...noCoord];
}

/** Destination-scoped search queries — 泛搜（多角度扩大覆盖）+ 权威源定向（site: 限域），用于交叉验证。 */
/** 生成「POI 名字批量」查询：把内置 POI 库中的规范名拼进搜索词，确保结果能命中内置实体（提升覆盖率）。 */
function poiBatchQuery(kind, n) {
  return POI_DB.filter((p) => p.kind === kind).slice(0, n).map((p) => p.name).join(' ');
}

function buildBucketQueries(destination, scope, origin, preference, themeWords, slot) {
  const season = getSeasonHint();
  const near = origin ? `${origin} 附近` : '';
  const prefWords = PREFERENCE_KEYWORDS[preference] || [];
  const pref = prefWords.length ? ` ${prefWords.join(' ')} ` : '';
  const theme = themeWords?.length ? ` ${themeWords.join(' ')} ` : '';
  const queries = { attractions: [], food: [] };
  const isNight = slot === '晚上';
  if (scope === 'both' || scope === 'attractions') {
    if (isNight) {
      // 夜游专用：灯光秀/演艺/市集/夜市/展览
      queries.attractions.push(`${destination} ${near} 夜游 灯光秀 夜景 演艺 市集 展览 晚上 去哪玩${theme}`);
      queries.attractions.push(`${destination} ${near} 灯光秀 夜游 不夜城 夜景 打卡 推荐${theme}`);
      queries.attractions.push(`${destination} ${near} 演出 音乐会 舞台剧 展览 市集 快闪 晚上${theme}`);
      queries.attractions.push(`site:bendibao.com ${destination} 夜游 灯光秀 夜市 夜间`);
    } else {
      // 泛搜：多角度扩大覆盖
      queries.attractions.push(`${destination} ${near} 周末 去哪玩 新开 活动 展览 打卡 ${season}${pref}${theme}`);
      queries.attractions.push(`${destination} ${near} 公园 山 森林 赏秋 本地人 常去 口碑${pref}${theme}`);
      queries.attractions.push(`${destination} ${near} 景点 排行榜 榜单 推荐 实测${pref}${theme}`);
      // 权威源定向：观赏期/花期（本地宝）；北京专属变色率（园林绿化局）
      queries.attractions.push(`site:bendibao.com ${destination} 银杏 红叶 观赏期 花期${pref}`);
      if (/北京/.test(destination)) {
        queries.attractions.push('site:yllhj.beijing.gov.cn 北京 彩叶 变色率 银杏 红叶');
      }
      queries.attractions.push(`高德 ${destination} 景点 热度 排行`);
      // POI 名批量检索：确保搜索结果能命中内置景点实体（补足经典口碑榜覆盖）
      queries.attractions.push(`${destination} ${poiBatchQuery('attraction', 14)} 景点 推荐 点评`);
    }
  }
  if (scope === 'both' || scope === 'food') {
    if (isNight) {
      queries.food.push(`${destination} ${near} 晚餐 夜宵 深夜食堂 夜市 美食 推荐${theme}`);
      queries.food.push(`${destination} ${near} 晚餐 聚餐 火锅 烧烤 撸串 深夜 探店${theme}`);
      queries.food.push(`${destination} ${near} 美食 夜市 大排档 夜宵 必吃${theme}`);
    } else {
      queries.food.push(`${destination} ${near} 新店 探店 季节限定 网红 排队 小红书${theme}`);
      queries.food.push(`${destination} ${near} 老字号 餐厅 正餐 本地人 口碑 美食${theme}`);
      queries.food.push(`${destination} ${near} 美食 必吃榜 热门榜 必打卡 宝藏店${theme}`);
      // 权威源定向：点评必吃榜 / 高德状元榜
      queries.food.push(`site:dianping.com ${destination} 必吃榜 热门榜`);
      queries.food.push(`site:dianping.com ${destination} 评分 点评 人均`);
      queries.food.push(`高德 状元榜 ${destination} 美食`);
      queries.food.push(`site:weibo.com ${destination} 美食 话题`);
      // POI 名批量检索：确保搜索结果能命中内置餐厅实体（补足美食榜覆盖）
      queries.food.push(`${destination} ${poiBatchQuery('food', 14)} 老字号 点评 必吃`);
    }
  }
  return queries;
}

/** Run each bucket's searches concurrently; collect sources, tolerating per-query failure. */
async function gatherSourcesByBucket(ctx, bucketQueries, signal, maxResults = 8) {
  const out = { attractions: [], food: [] };
  for (const [bucket, queries] of Object.entries(bucketQueries)) {
    const results = await Promise.allSettled(
      queries.map((query) => ctx.web.search({ query, maxResults }, signal)),
    );
    for (const result of results) {
      if (result.status === 'fulfilled') out[bucket].push(...(result.value.sources ?? []));
    }
  }
  return out;
}

/** 扫描一段文本中出现的所有内置 POI（名字/别名 → 规范名），返回去重后的规范名数组。 */
function findMentionedPois(text) {
  const lower = String(text ?? '').toLowerCase();
  if (lower.length < 2) return [];
  if (!ENTITY_INDEX) ENTITY_INDEX = buildEntityIndex();
  const found = new Set();
  for (const [key, canonical] of ENTITY_INDEX) {
    if (key.length >= 2 && lower.includes(key)) found.add(canonical);
  }
  return [...found];
}

/** 根据 POI 名字粗分类偏好（用于「偏好」筛选，比来源文本关键词更可靠）。一个 POI 可命中多类。 */
const POI_PREF_RE = {
  自然秋景: /(?:公园|山|湖|潭|海|河|森林|林|植物园|湿地|红叶|银杏|枫叶|花|绿道|水库|草原|岛|瀑|温泉|郊野|生态|风景区)/,
  人文老城: /(?:故|城|宫|寺|庙|坛|陵|园|馆|街|巷|楼|塔|桥|坊|故居|遗址|古镇|老街|历史|博物|纪念|书院|教堂|胡同|园林|古城|城墙|四合院)/,
  文艺展览: /(?:美术馆|艺术|展览|剧院|演出|音乐|文创|剧场|画廊|博物馆|科技馆|天文馆|图书馆|展|秀)/,
  运动户外: /(?:骑行|徒步|登山|滑雪|攀岩|运动|体育|健身|露营|越野|马拉松|球|滑冰|游泳|乐园|蹦床|郊野公园)/,
  美食探店: /(?:餐厅|饭店|饭馆|菜馆|酒楼|食府|火锅|烧烤|烤鸭|面馆|小吃|夜市|大排档|居|斋|庄|涮|羊蝎子|卤煮|炸酱|饺子|包子|料理|茶|咖啡|甜品|糖|店)/,
};

function classifyPreference(name) {
  const n = String(name ?? '');
  const tags = [];
  for (const [pref, re] of Object.entries(POI_PREF_RE)) {
    if (re.test(n)) tags.push(pref);
  }
  return tags;
}

/** 兜底：搜索未命中足够内置 POI 时，用内置 POI 库补齐（老牌经典去处，无实时信号，标 fallback 只进经典榜不进热门榜）。 */
function supplementFromPoiDb(list, kind, minCount = 8) {
  if (list.length >= minCount) return list;
  const existing = new Set(list.map((c) => String(c.name).toLowerCase()));
  const fallback = POI_DB.filter((p) => p.kind === kind && !existing.has(String(p.name).toLowerCase()))
    .slice(0, minCount - list.length)
    .map((p) => ({
      name: p.name,
      kind,
      poiPrefs: classifyPreference(p.name),
      fallback: true,
      url: null,
      snippet: '',
      heat: 0,
      classic: 1,
      pref: 0,
      meal: kind === 'food' ? 1 : 0,
      snack: 0,
      night: 0,
      theme: 0,
      engagement: 0,
      rating: null,
      ratingCount: 0,
      reviews: 0,
      heatLevel: null,
      freq: 1,
      newest: null,
      recency: 0.3,
      domainCount: 1,
      maxAuthority: 1,
      conf: 1,
    }));
  return [...list, ...fallback];
}

/** Convert raw sources into ranked, deduplicated candidates（硬门槛 POI 归一门控 + 多因子口碑信号）. */
function buildCandidates(sources, now, themeWords, slot, prefWords) {
  const map = new Map();
  for (const source of sources) {
    const cls = classifySource(source.url);
    if (cls.type === 'noise') continue; // 硬排除噪声源（PDF/黄页/百科/论坛…）
    const domain = domainOf(source.url);
    const text = `${source.title ?? ''} ${source.snippet ?? ''} ${source.summary ?? ''}`;
    // 硬门槛：只保留文本中能归一到内置 POI 库的实体，杜绝攻略页/句子型标题混入榜单
    const mentioned = findMentionedPois(text);
    if (!mentioned.length) continue;
    const heat = countSignals(text, TRENDING_WORDS);
    const classic = countSignals(text, CLASSIC_WORDS);
    const meal = countSignals(text, MEAL_WORDS);
    const snack = countSignals(text, SNACK_WORDS);
    const pref = prefWords?.length ? countSignals(text, prefWords) : 0;
    const night = countSignals(text, NIGHT_WORDS);
    const dayOnly = countSignals(text, DAY_ONLY_WORDS);
    // 晚上时段：跳过明显「白天专属」的去处（爬山/赏红叶/露营…），优先有夜间信号的活动
    if (slot === '晚上' && dayOnly > 0 && night === 0) continue;
    const theme = themeWords?.length ? countSignals(text, themeWords) : 0;
    const engagement = extractEngagement(text);
    const sig = extractStructuredSignals(text);
    const published = source.publishedAt ? Date.parse(source.publishedAt) : NaN;

    for (const canonical of mentioned) {
      const poi = coordOf(canonical); // {name,lat,lng,kind,metro}
      const name = poi?.name ?? canonical;
      const key = name.toLowerCase();
      let candidate = map.get(key);
      if (!candidate) {
        candidate = {
          name,
          kind: poi?.kind ?? null,
          poiPrefs: classifyPreference(name),
          url: source.url,
          snippet: truncate(source.snippet ?? source.summary ?? ''),
          heat: 0,
          classic: 0,
          pref: 0,
          meal: 0,
          snack: 0,
          night: 0,
          theme: 0,
          engagement: 0,
          rating: null,
          ratingCount: 0,
          reviews: 0,
          heatLevel: null,
          freq: 0,
          newest: null,
          recency: 0.5,
          domains: new Set(),
          maxAuthority: 0,
        };
        map.set(key, candidate);
      }
      candidate.heat += heat;
      candidate.classic += classic;
      candidate.pref += pref;
      candidate.meal += meal;
      candidate.snack += snack;
      candidate.night += night;
      candidate.theme += theme;
      candidate.engagement = Math.max(candidate.engagement, engagement);
      if (sig.rating != null) {
        candidate.rating = candidate.rating == null ? sig.rating : Math.max(candidate.rating, sig.rating);
        candidate.ratingCount += 1;
      }
      candidate.reviews += sig.reviews;
      if (sig.heat != null) {
        candidate.heatLevel = candidate.heatLevel == null ? sig.heat : Math.max(candidate.heatLevel, sig.heat);
      }
      candidate.freq += 1;
      candidate.domains.add(domain);
      candidate.maxAuthority = Math.max(candidate.maxAuthority, cls.weight);
      if (Number.isFinite(published)) {
        candidate.newest = Number.isFinite(candidate.newest)
          ? Math.max(candidate.newest, published)
          : published;
      }
    }
  }
  for (const c of map.values()) {
    c.recency = recencyWeight(c.newest, now);
    c.domainCount = c.domains.size;
    c.conf = confidenceOf(c);
    delete c.domains; // Set 不参与 JSON 序列化
  }
  return [...map.values()];
}

/** 交叉验证置信度：独立来源（域名）数 + 来源权威度 + 结构化信号加成。3=高, 2=中, 1=低。 */
function confidenceOf(c) {
  const n = c.domainCount ?? 0;
  const auth = c.maxAuthority ?? 1;
  let conf;
  if (n >= 3) conf = 3;
  else if (n === 2) conf = 2;
  else if (n === 1) conf = auth >= 2 ? 2 : 1;
  else conf = 0;
  // 结构化信号（评分/点评数/热度等级）来自大众点评/高德等权威平台，可再提升一级置信度
  const structured = c.rating != null || c.reviews > 0 || c.heatLevel != null;
  if (structured && conf < 3) conf += 1;
  return conf;
}

/** 真实口碑/热度信号加成：评分（口碑质量）、点评数（人气）、热度等级（平台热度）。 */
function authorityBoost(c) {
  let b = 0;
  if (c.rating != null) b += (c.rating - 3) * 60; // 4.5 分→+90，3 分→0，低于 3 分惩罚
  b += Math.min(100, (c.reviews / 1000) * 20); // 1000 条点评→+20，5000+ 封顶 +100
  if (c.heatLevel != null) b += Math.min(60, c.heatLevel * 0.6); // 热度 100→+60
  return b;
}

/** 多因子口碑评分：交叉验证置信度 + 时间衰减（recency）+ 热度 + 互动量 + 真实口碑加成 + 主题加成。 */
function trendingScore(c, themeWords) {
  const themeBoost = themeWords?.length ? c.theme * 20 : 0;
  return c.conf * 100 + c.recency * 100 + c.heat * 10 + (c.engagement / 10000) * 10 + authorityBoost(c) + themeBoost + c.freq * 5;
}

function classicScore(c, themeWords) {
  const themeBoost = themeWords?.length ? c.theme * 20 : 0;
  return c.conf * 100 + c.classic * 100 + c.freq * 20 + (c.engagement / 10000) * 10 + authorityBoost(c) + themeBoost;
}

function prefScore(c, themeWords) {
  const themeBoost = themeWords?.length ? c.theme * 20 : 0;
  return c.conf * 100 + c.pref * 100 + c.heat * 10 + c.recency * 50 + themeBoost + authorityBoost(c) + c.freq * 5;
}

function rankTrending(list, themeWords) {
  return [...list].sort((a, b) => trendingScore(b, themeWords) - trendingScore(a, themeWords));
}

function rankClassic(list, themeWords) {
  return [...list].sort((a, b) => classicScore(b, themeWords) - classicScore(a, themeWords));
}

function rankPref(list, themeWords) {
  return [...list].sort((a, b) => prefScore(b, themeWords) - prefScore(a, themeWords));
}

/** 夜间活动评分：夜间信号优先，再叠加置信度 + 热度。 */
function nightScore(c) {
  return c.night * 100 + c.conf * 50 + c.heat * 10 + c.freq * 5;
}

function rankNight(list) {
  return [...list].sort((a, b) => nightScore(b) - nightScore(a));
}

function take(list, n) {
  return list.slice(0, n);
}

/** 交叉验证选择：优先保留置信度 ≥ 中（2 独立来源或 1 权威来源）；数量不足时回退到全部。 */
function selectConfident(list, minCount = 3) {
  const confident = list.filter((c) => c.conf >= 2);
  return confident.length >= minCount ? confident : list;
}

/** 偏好过滤：preference ≠ 综合 时，只保留「POI 名字命中该偏好」或「来源文本命中偏好关键词」的候选；命中过少则回退全部（避免空结果）。 */
function selectByPreference(list, preference) {
  if (!preference || preference === '综合') return list;
  const filtered = list.filter((c) => (c.poiPrefs ?? []).includes(preference) || c.pref > 0);
  return filtered.length >= 3 ? filtered : list;
}

/** 主题硬排除：某些主题下剔除体力消耗大 / 不适合的去处（如带父母→登山/徒步/攀岩）。 */
const THEME_EXCLUDE = {
  带父母: ['登山', '徒步', '攀岩', '越野', '露营', '骑行', '爬山', '登高', '冲浪', '滑雪', '漂流'],
  亲子遛娃: ['登山', '徒步', '攀岩', '酒吧', '夜店', '爬山', '登高'],
};

/** 主题排除：按主题剔除不合适的候选；剔除过多则回退（避免空结果）。 */
function excludeByTheme(list, theme) {
  const words = THEME_EXCLUDE[theme];
  if (!words || !words.length) return list;
  const filtered = list.filter((c) => {
    const t = `${c.name ?? ''} ${c.snippet ?? ''}`;
    return !words.some((w) => t.includes(w));
  });
  return filtered.length >= 3 ? filtered : list;
}

/** Format minutes-since-midnight as HH:MM. */
function formatClock(minutes) {
  const h = Math.floor(minutes / 60) % 24;
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** Build a single-day (within-one-day) 景点+正餐 itinerary with 通勤往返. duration ∈ '半天' | '全天'; slot ∈ '上午' | '下午' | '晚上'. */
function buildItinerary(attractions, foods, duration, origin, slot) {
  const attr = orderByProximity([...new Set(attractions)], origin);
  const meal = [...new Set(foods)];

  // 半天: 1 景点 + 1 正餐; 全天: 2 景点 + 2 正餐（景点/正餐交替）
  const nAttrs = duration === '半天' ? 1 : 2;
  const nMeals = duration === '半天' ? 1 : 2;
  const attrMinutes = duration === '半天' ? 105 : 120; // 半天压缩景点时长以容纳通勤

  const commute = attr[0] ? commuteOf(attr[0], origin) : null;

  const startHour = slot === '下午' ? 13 : slot === '晚上' ? 18 : 9; // 上午 09:00 / 下午 13:00 / 晚上 18:00 出发
  let clock = startHour * 60;
  const slots = [];

  if (commute) {
    slots.push({ time: formatClock(clock), type: '通勤', name: `${origin || '出发地'}出发`, minutes: commute.minutes, route: commute.route });
    clock += commute.minutes;
  }

  for (let i = 0; i < nAttrs || i < nMeals; i += 1) {
    if (i < nAttrs && attr[i]) {
      slots.push({ time: formatClock(clock), type: '景点', name: attr[i], minutes: attrMinutes });
      clock += attrMinutes;
    }
    if (i < nMeals && meal[i]) {
      slots.push({ time: formatClock(clock), type: clock >= 17 * 60 ? '晚餐' : '午餐', name: meal[i], minutes: 60 });
      clock += 60;
    }
  }

  if (commute) {
    slots.push({ time: formatClock(clock), type: '通勤', name: '返程', minutes: commute.minutes, route: commute.route });
    clock += commute.minutes;
  }

  const totalMinutes = Math.max(0, clock - startHour * 60);
  return { slots, totalMinutes, duration, commute, slot };
}

function hoursLabel(minutes) {
  const h = Math.round((minutes / 60) * 2) / 2;
  return `${h} 小时`;
}

/** Format minutes as "X 小时 Y 分" (drops the minutes part when zero). */
function clockLabel(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h} 小时` : `${h} 小时 ${m} 分`;
}

// ---------------------------------------------------------------------------
// 苏格拉底式追问：信息不完整时先问清，再生成计划。
// ---------------------------------------------------------------------------

const CLARIFY_QUESTIONS = {
  destination: {
    question: '你想去哪一片 / 哪个目的地？（区域或具体地名都行）',
    options: ['海淀', '朝阳'],
  },
  origin: {
    question: '你从哪出发？（用于就近推荐与通勤估算）',
    options: [],
  },
  duration: {
    question: '你打算玩「半天」（上午 + 一顿正餐）还是「全天」（一天内约 8 小时）？',
    options: ['半天', '全天'],
  },
  preference: {
    question: '你更想要哪种风格？没有特别偏好就选「综合」，我会全面均衡地推荐。',
    options: ['综合', '自然秋景', '人文老城', '文艺展览', '美食探店', '运动户外'],
  },
};

/** 依优先级返回第一条缺失的关键信息（苏格拉底式：一次只问一个，附预选项）；齐全则返回 null。 */
function assessClarification(args) {
  const destination = String(args?.destination ?? '').trim();
  if (!destination) return { field: 'destination', ...CLARIFY_QUESTIONS.destination };
  const origin = String(args?.origin ?? '').trim();
  if (!origin) {
    const city = matchCity(destination);
    const options = city ? [city.defaultOrigin, ...(city.districts ?? [])].slice(0, 3) : [];
    return { field: 'origin', question: CLARIFY_QUESTIONS.origin.question, options };
  }
  if (args?.duration !== '半天' && args?.duration !== '全天') {
    return { field: 'duration', ...CLARIFY_QUESTIONS.duration };
  }
  if (!PREFERENCE_KEYWORDS[args?.preference]) {
    return { field: 'preference', ...CLARIFY_QUESTIONS.preference };
  }
  return null;
}

/** Render the "need more info" result. */
function renderClarify(value) {
  const lines = [];
  lines.push('## 信息还不完整，先别生成计划');
  lines.push('');
  lines.push('采用苏格拉底式追问：一次只问一个问题，等用户回答后再继续。');
  lines.push('');
  lines.push('**下一步请向用户追问**：');
  lines.push('');
  lines.push(`> ${value.question}`);
  lines.push('');
  if (value.options && value.options.length) {
    lines.push(`**可选**：${value.options.map((o) => `「${o}」`).join('　/　')}`);
    lines.push('');
    lines.push('> 也可以直接说自己的想法（不必局限在选项里），我会按你的实际需求继续。');
    lines.push('');
  }
  const known = [];
  if (value.destination) known.push(`目的地 = ${value.destination}`);
  if (value.origin) known.push(`出发地 = ${value.origin}`);
  if (known.length) {
    lines.push(`已掌握：${known.join('；')}`);
    lines.push('');
  }
  lines.push(
    '得到回答后，把该信息补进参数（destination / scope / duration / origin / preference）再次调用我；若仍有缺失，我会继续提示下一个问题。信息齐全后我会直接生成完整计划（近期热门 + 经典口碑 + 一天内行程）。',
  );
  return lines.join('\n');
}

/** Render the tool result as a single markdown string. */
function renderReport(value) {
  if (value.error) {
    return `# ${value.destination} · 美食 & 景点推荐\n\n⚠️ ${value.error}\n`;
  }

  const lines = [];
  lines.push(`# ${value.destination} · 美食 & 景点推荐（常驻人群版）`);
  lines.push('');
  lines.push(`> ${value.disclaimer}`);
  lines.push('');
  const metaParts = [`📍 出发地：${value.origin}`, `偏好：${value.preference}`];
  if (value.slot && value.slot !== '上午') metaParts.push(`时段：${value.slot}`);
  if (value.theme && value.theme !== '通用') metaParts.push(`主题：${value.theme}`);
  lines.push(`> ${metaParts.join('｜')}`);
  lines.push('');

  const emitList = (title, items) => {
    lines.push(`### ${title}`);
    if (!items || items.length === 0) {
      lines.push('_暂无足够的检索结果，请换个目的地或稍后再试。_');
    } else {
      items.forEach((item, i) => {
        const name = truncate(item.name, 30);
        const stats = [];
        if (item.rating != null) stats.push(`⭐${item.rating.toFixed(1)}`);
        if (item.reviews > 0) stats.push(`${formatCount(item.reviews)}点评`);
        if (item.heatLevel != null) stats.push(`热度${item.heatLevel}`);
        const statStr = stats.length ? `〔${stats.join(' · ')}〕` : '';
        const conf = item.conf ? `（置信度：${CONF_LABEL[item.conf] ?? '—'}）` : '';
        const source = item.url ? ` — [来源](${item.url})` : '';
        const snippet = item.snippet ? ` — ${item.snippet}` : '';
        lines.push(`${i + 1}. **${name}**${statStr}${conf}${snippet}${source}`);
      });
    }
    lines.push('');
  };

  const showAttractions = value.scope !== 'food';
  const showFood = value.scope !== 'attractions';

  lines.push('## 一、近期热门（随季节 / 活动出圈）');
  lines.push('');
  if (showAttractions) emitList('🏛️ 景点', value.attractions?.trendingWeek);
  if (showFood) emitList('🍜 美食', value.food?.trendingWeek);

  lines.push('## 二、经典口碑（老牌长青）');
  lines.push('');
  if (showAttractions) emitList('🏛️ 景点', value.attractions?.classic);
  if (showFood) emitList('🍜 美食', value.food?.classic);

  lines.push('## 三、行程规划（一天以内）');
  lines.push('');
  const { slots, totalMinutes, duration, commute } = value.itinerary;
  const slotLabel = value.slot === '晚上' ? '晚上' : value.slot === '下午' ? '下午' : '上午';
  const mealCount = (slots ?? []).filter((s) => s.type === '午餐' || s.type === '晚餐').length;
  const attrCount = (slots ?? []).filter((s) => s.type === '景点' || s.type === '活动').length;
  const planParts = [];
  if (attrCount) planParts.push(`${attrCount} 个去处`);
  if (mealCount) planParts.push(`${mealCount} 顿正餐`);
  const planSummary = planParts.length ? planParts.join(' + ') : '暂无安排';
  const durationLabel = `${duration === '半天' ? '半天' : '全天'}（${slotLabel}出发，${planSummary}）`;
  lines.push(
    `> 建议行程：${durationLabel}，从 ${value.origin} 出发，全程约 **${clockLabel(totalMinutes)}**（含通勤往返、景点游览与正餐，粗略估算）。`,
  );
  lines.push('');
  lines.push('> 行程顺序已按「真实坐标 + 最近邻顺路」优化（内置城市 POI 坐标库 + haversine 距离），减少折返。');
  lines.push('');
  if (commute?.route) {
    lines.push(`**通勤去程**：${commute.route}。约 ${commute.minutes} 分钟。`);
    lines.push('');
  }
  if (!slots || slots.length === 0) {
    lines.push('_暂无足够的检索结果来生成行程。_');
  } else {
    lines.push('| 时间 | 行程 | 类型 |');
    lines.push('| --- | --- | --- |');
    const attrLabel = value.slot === '晚上' ? '活动' : '景点';
    const startHour = value.slot === '下午' ? 13 : value.slot === '晚上' ? 18 : 9;
    for (const slot of slots) {
      let cell = slot.name;
      if (slot.type === '通勤' && slot.name === '返程') cell = `返程（约 ${slot.minutes} 分钟）`;
      else if (slot.type === '景点') cell = `${slot.name}（约 ${clockLabel(slot.minutes)}）`;
      const typeLabel = slot.type === '景点' ? attrLabel : slot.type;
      lines.push(`| ${slot.time} | ${cell} | ${typeLabel} |`);
    }
    const endTime = formatClock(startHour * 60 + totalMinutes);
    lines.push(`| ${endTime} | 回到 ${value.origin}，全程约 ${clockLabel(totalMinutes)} | — |`);
  }
  lines.push('');
  lines.push(
    '> ⚠️ 以上时间仅为粗略估算，实际请以景点营业时间、排队、交通与个人节奏为准；通勤/顺路为基于内置 POI 坐标库 + haversine 距离的粗算（非精确导航，请以高德/百度地图为准）；排名为基于公开检索结果与时间/热度信号的启发式估算，非小红书官方实时数据。',
  );
  lines.push('');

  return lines.join('\n');
}

export function apply(ctx, config) {
  const maxResults = config?.maxResults ?? 8;
  const timeoutMs = config?.timeoutMs ?? 120000;
  const defaultOrigin = config?.defaultOrigin ?? '知春路';

  ctx.tools.register({
      name: 'xiaohongshu_guide',
      description:
        '为常驻本地的城市人群汇总小红书及全网的「美食」和「景点」帖子，返回两份排序：①近期热门（随季节变化 / 活动出圈的最适宜去处）；②经典口碑（老牌长青）。排序采用多因子口碑聚合（交叉验证置信度 × 发布时间时间衰减 × 热度 × 互动量 × 被提及频次；置信度 = 多个独立来源同时佐证同一地点，经扩大搜索范围后交叉验证），并支持「偏好」风格（综合/自然秋景/人文老城/文艺展览/美食探店/运动户外；没特别倾向就选综合=全面均衡）、「主题」个性化推荐（情侣约会/朋友聚会/亲子遛娃/带父母/独自慢游）与「时段」维度（上午/下午/晚上；晚上=夜游·灯光秀·演艺·夜市·展览，18:00 出发并筛掉爬山/赏红叶等白天专属项）。附一天以内的景点+正餐行程与大致时间花费：按出发地就近推荐、景点按「真实坐标 + 最近邻顺路」排序减少折返、自动附带地铁通勤路线与时长（基于内置城市 POI 坐标库 + haversine 距离粗算，非实时导航）。当前支持城市：北京、上海、广州、深圳、成都、杭州、西安、武汉、南京、重庆。面向熟悉本地但不太会安排出游/美食的常驻人群，不是第一次来旅游的观光客。当用户询问某城市周末去哪玩、美食探店、季节限定去处、一日游规划时调用。当出发地/出游时长/偏好等关键信息缺失时，本工具会先返回追问提示，请先向用户逐一确认（一次一个问题）后再生成计划。',
      parameters: {
        type: 'object',
        properties: {
          destination: {
            type: 'string',
            description: '目的地城市或区域，例如「上海」「杭州西湖」「北京海淀」「成都」。',
          },
          scope: {
            type: 'string',
            enum: ['both', 'attractions', 'food'],
            description: '查询类别：both=景点+美食，attractions=仅景点，food=仅美食。',
          },
          duration: {
            type: 'string',
            enum: ['半天', '全天'],
            description: '出游时长：半天=上午+一顿正餐；全天=一天内（约 8 小时）。未指定时本工具会先追问。',
          },
          origin: {
            type: 'string',
            description: '出发地/地铁站，用于就近推荐与通勤估算（例如「人民广场」「徐汇区」，各城市默认出发地不同）。未指定时本工具会先追问。',
          },
          preference: {
            type: 'string',
            enum: ['综合', '自然秋景', '人文老城', '文艺展览', '美食探店', '运动户外'],
            description: '偏好/风格：综合=全面均衡（没特别倾向就选这个，默认）；自然秋景=公园/银杏/红叶；人文老城=胡同/古建/博物馆；文艺展览=美术馆/展览/演出；美食探店=新店/必吃/老字号；运动户外=骑行/徒步/运动公园。未指定时本工具会先追问。',
          },
          slot: {
            type: 'string',
            enum: ['上午', '下午', '晚上'],
            description: '出游时段：上午（默认，09:00 出发）/ 下午（13:00 出发）/ 晚上（18:00 出发，夜游·灯光秀·演艺·夜市·展览）。当用户提到「今晚/晚上/夜游/夜景/下班后/夜宵」时设为「晚上」。默认上午。',
          },
          theme: {
            type: 'string',
            enum: ['通用', '情侣约会', '朋友聚会', '亲子遛娃', '带父母', '独自慢游'],
            description: '个性化主题（同行人/场景）：通用=不限定；情侣约会/朋友聚会/亲子遛娃/带父母/独自慢游（带父母/亲子遛娃会自动剔除登山/攀岩等体力消耗大的去处）。默认通用。',
          },
        },
        required: ['destination'],
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [
          {
            type: 'text',
            text: value && value.status === 'clarify' ? renderClarify(value) : renderReport(value),
          },
        ],
      },
      timeoutMs,
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        const destination = String(args.destination ?? '').trim();
        const fail = (error) => ({
          destination: destination || '(未指定)',
          origin: '',
          preference: '',
          disclaimer: '',
          attractions: { trendingWeek: [], classic: [] },
          food: { trendingWeek: [], classic: [] },
          itinerary: { slots: [], totalMinutes: 0, duration: '全天' },
          error,
        });

        // 苏格拉底式追问：目的地/出发地/时长/偏好缺失时先返回追问，不生成计划。
        const clarification = assessClarification(args);
        if (clarification) {
          return {
            status: 'clarify',
            ...clarification,
            destination: destination || null,
            origin: String(args.origin ?? '').trim() || null,
          };
        }

        // 解析城市并加载对应数据（用于坐标/顺路/通勤与默认出发地）。
        const city = matchCity(destination);
        if (city) loadCityData(city);

        const scope = ['both', 'attractions', 'food'].includes(args.scope) ? args.scope : 'both';
        const duration = args.duration === '半天' ? '半天' : '全天';
        const origin = String(args.origin ?? '').trim() || CITY.defaultOrigin || defaultOrigin;
        const preference = PREFERENCE_KEYWORDS[args.preference] ? args.preference : '综合';
        const prefWords = PREFERENCE_KEYWORDS[preference] || [];
        const slot = ['上午', '下午', '晚上'].includes(args.slot) ? args.slot : '上午';
        const theme = THEME_KEYWORDS[args.theme] ? args.theme : '通用';
        const themeWords = THEME_KEYWORDS[theme] || [];

        const now = Date.now();

        try {
          const sourcesByBucket = await gatherSourcesByBucket(
            ctx,
            buildBucketQueries(destination, scope, origin, preference, themeWords, slot),
            exec.signal,
            maxResults,
          );

          const totalSources = sourcesByBucket.attractions.length + sourcesByBucket.food.length;
          if (totalSources === 0) {
            return fail(`未检索到「${destination}」的有效结果，请确认目的地拼写或稍后重试。`);
          }

          // 合并两桶来源统一建候选，再按 POI 的 kind 分流，杜绝「景点混入美食栏 / 美食混入景点栏」
          const allCandidates = buildCandidates(
            [...sourcesByBucket.attractions, ...sourcesByBucket.food],
            now, themeWords, slot, prefWords,
          );
          const attractionCandidates = scope === 'food'
            ? []
            : supplementFromPoiDb(
                selectConfident(allCandidates.filter((c) => c.kind === 'attraction')),
                'attraction',
              );
          const foodCandidates = scope === 'attractions'
            ? []
            : supplementFromPoiDb(
                selectConfident(allCandidates.filter((c) => c.kind === 'food')),
                'food',
              );
          const attractions = excludeByTheme(
            selectByPreference(attractionCandidates, preference),
            theme,
          );
          const food = foodCandidates;

          // 兜底 POI 只进经典榜：热门榜仅用真实搜索命中的候选，避免「经典老字号」冒充「近期热门」
          const realAttractions = attractions.filter((c) => !c.fallback);
          const realFood = food.filter((c) => !c.fallback);
          const attractionsTrending = take(
            slot === '晚上'
              ? rankNight(realAttractions)
              : preference !== '综合'
                ? rankPref(realAttractions, themeWords)
                : rankTrending(realAttractions, themeWords),
            6,
          );
          // 两栏去重：经典榜排除已进热门榜的条目，避免重复
          const classicAttractions = attractions.filter(
            (c) => !attractionsTrending.some((t) => t.name === c.name),
          );
          const attractionsClassic = take(rankClassic(classicAttractions, themeWords), 6);
          const foodTrending = take(rankTrending(realFood, themeWords), 6);
          const classicFood = food.filter(
            (c) => !foodTrending.some((t) => t.name === c.name),
          );
          const foodClassic = take(rankClassic(classicFood, themeWords), 6);

          const allAttractions = [
            ...new Set([...attractionsTrending, ...attractionsClassic].map((c) => c.name)),
          ];

          // 正餐候选：排除明显的小吃/甜品/冰饮；优先「明确正餐信号 + 老字号经典」，用于午餐/晚餐时段
          const mealPool = food.filter((c) => c.meal >= c.snack);
          const explicitMeals = mealPool.filter((c) => c.meal > 0);
          const mealSource = explicitMeals.length ? explicitMeals : mealPool;
          const mealTop = take(rankClassic(mealSource, themeWords), 4).map((c) => c.name);
          const allFoods = [...new Set([...foodTrending, ...foodClassic].map((c) => c.name))];
          const mealFoods = mealTop.length ? mealTop : allFoods;

          return {
            destination,
            origin,
            scope,
            preference,
            slot,
            theme,
            generatedAt: new Date(now).toISOString(),
            disclaimer:
              '面向常驻本地的城市人群（熟悉城市、只是不熟出游/美食），不面向第一次来旅游的观光客。数据来自小红书及全网公开检索结果（非官方实时数据）；热度为基于检索结果、发布时间（时间衰减）、互动量与关键词信号的多因子启发式估算；「置信度」= 多个独立来源（不同域名）交叉佐证同一地点的强度；通勤与顺路为基于内置城市 POI 坐标库 + haversine 距离的粗算（非精确导航，请以高德/百度地图为准），仅供参考。',
            attractions: { trendingWeek: attractionsTrending, classic: attractionsClassic },
            food: { trendingWeek: foodTrending, classic: foodClassic },
            itinerary: buildItinerary(allAttractions, mealFoods, duration, origin, slot),
          };
        } catch (error) {
          if (exec.signal?.aborted) throw error;
          return fail(
            `检索失败：${error?.message ?? error}。请确认已启用 Web 搜索服务（web-search-deepseek / web-fetch-http）后重试。`,
          );
        }
      },
    },
  );
}
