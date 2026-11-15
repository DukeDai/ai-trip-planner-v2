/* ==========================================================================
 * TripPilot · 前端工作台
 *
 * 唯一事实来源：docs/frontend-contract.md
 *  - HTTP API：/api/health /api/trips /api/trips/:id /api/trips/:id/files/:name
 *               /api/trips/:id/chat (POST + SSE) /api/trips/:id/approve
 *  - SSE 事件：status / todo / tool / subagent / token / artifact /
 *              interrupt / error / done
 *  - 数据结构：ItineraryPlan
 *
 * 约束：无构建步骤、无 npm 依赖、无 CDN 外链、纯原生 ES Module。
 * ========================================================================== */

/* ---------------------------------------------------------------- 常量 -- */

const API = {
  health: '/api/health',
  trips: '/api/trips',
  trip: (id) => `/api/trips/${encodeURIComponent(id)}`,
  file: (id, name) => {
    const encoded = String(name)
      .split('/')
      .filter(Boolean)
      .map(encodeURIComponent)
      .join('/');
    return `/api/trips/${encodeURIComponent(id)}/files/${encoded}`;
  },
  chat: (id) => `/api/trips/${encodeURIComponent(id)}/chat`,
  approve: (id) => `/api/trips/${encodeURIComponent(id)}/approve`,
};

const TYPE_META = {
  sight:    { icon: '◉', label: '景点', cls: 't-sight' },
  food:     { icon: '◆', label: '餐饮', cls: 't-food' },
  transport:{ icon: '➤', label: '交通', cls: 't-transport' },
  stay:     { icon: '▣', label: '住宿', cls: 't-stay' },
  free:     { icon: '○', label: '免费', cls: 't-free' },
};

const CONF_META = {
  high:   { label: '高置信', cls: 'c-high' },
  medium: { label: '中置信', cls: 'c-medium' },
  low:    { label: '低置信', cls: 'c-low' },
};

const CAT_META = {
  stay:      { label: '住宿', color: 'var(--c-stay)' },
  transport: { label: '交通', color: 'var(--c-transport)' },
  sight:     { label: '门票', color: 'var(--c-sight)' },
  food:      { label: '餐饮', color: 'var(--c-food)' },
  other:     { label: '其他', color: 'var(--c-other)' },
};

const PHASE_META = {
  clarify:    '需求澄清',
  research:   '资料调研',
  synthesize: '行程编排',
  budget:     '预算校验',
  finalize:   '定稿',
  done:       '完成',
  error:      '出错',
};

const TOOL_STATUS_LABEL = { running: '运行中', ok: '成功', error: '失败' };
const SUBAGENT_STATUS_LABEL = { running: '进行中', ok: '已完成', error: '失败' };
const TODO_MARK = { pending: '☐', in_progress: '◐', completed: '☑' };

const PREFERENCE_OPTIONS = ['美食', '自然', '艺术', '购物', '夜景', '亲子', '历史', '休闲'];

const CURRENCY_SYMBOL = { CNY: '¥', USD: '$', EUR: '€', JPY: '¥', HKD: 'HK$', GBP: '£', KRW: '₩' };

/* ------------------------------------------------------------ 工具函数 -- */

function el(tag, attrs, children) {
  const node = document.createElement(tag);
  if (attrs) {
    for (const key in attrs) {
      const value = attrs[key];
      if (value === undefined || value === null || value === false) continue;
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = String(value);
      else if (key === 'dataset') Object.assign(node.dataset, value);
      else if (key.indexOf('on') === 0 && typeof value === 'function') {
        node.addEventListener(key.slice(2).toLowerCase(), value);
      } else if (value === true) node.setAttribute(key, '');
      else node.setAttribute(key, String(value));
    }
  }
  if (children !== undefined && children !== null) {
    const list = Array.isArray(children) ? children : [children];
    for (const child of list) {
      if (child === undefined || child === null || child === false) continue;
      node.appendChild(typeof child === 'object' ? child : document.createTextNode(String(child)));
    }
  }
  return node;
}

function clear(node) {
  while (node && node.firstChild) node.removeChild(node.firstChild);
}

function fmtMoney(amount, currency) {
  const n = Number(amount);
  if (!Number.isFinite(n)) return '—';
  const code = String(currency || 'CNY').toUpperCase();
  const symbol = CURRENCY_SYMBOL[code] || code + ' ';
  return symbol + n.toLocaleString('zh-CN', { maximumFractionDigits: 2 });
}

function fmtDuration(minutes) {
  const m = Number(minutes);
  if (!Number.isFinite(m) || m <= 0) return '—';
  const h = Math.floor(m / 60);
  const rest = m % 60;
  if (h && rest) return h + '小时' + rest + '分';
  if (h) return h + '小时';
  return rest + '分钟';
}

function fmtBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(2) + ' MB';
}

function fmtDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(String(dateStr) + 'T00:00:00');
  if (Number.isNaN(d.getTime())) return String(dateStr);
  const week = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()];
  return String(dateStr) + ' ' + week;
}

function fmtStamp(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const p = function (n) { return String(n).padStart(2, '0'); };
  return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

function safeStringify(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch (e) {
    return String(value);
  }
}

function currencyOf(plan) {
  return (plan && plan.travelers && plan.travelers.currency) || 'CNY';
}

/* -------------------------------------------------------------- 状态 -- */

const state = {
  health: null,
  healthError: null,
  trips: [],
  tripsError: null,
  tripId: null,
  trip: null,
  plan: null,
  files: [],
  streaming: false,
  controller: null,
  backendOnline: false,
};

const dom = {};

/* ------------------------------------------------------------ 网络层 -- */

async function jfetch(path, options) {
  let res;
  try {
    res = await fetch(path, Object.assign({
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    }, options || {}));
  } catch (e) {
    throw new Error('无法连接后端（' + path + '）：' + (e && e.message ? e.message : '网络错误'));
  }
  const raw = await res.text().catch(function () { return ''; });
  if (!res.ok) {
    let message = '请求失败：HTTP ' + res.status;
    try {
      const body = JSON.parse(raw);
      if (body && body.error && body.error.message) message = body.error.message;
    } catch (e) { /* 非 JSON 错误体，沿用默认文案 */ }
    throw new Error(message);
  }
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (e) {
    return raw;
  }
}

/* -------------------------------------------------------------- 渲染 -- */

function toast(message, kind) {
  const node = el('div', { class: 'toast' + (kind ? ' is-' + kind : ''), text: message });
  dom.toastHost.appendChild(node);
  window.setTimeout(function () { node.remove(); }, 4200);
}

function scrollChat(force) {
  const host = dom.chatStream;
  if (!host) return;
  const nearBottom = host.scrollHeight - host.scrollTop - host.clientHeight < 140;
  if (force || nearBottom) host.scrollTop = host.scrollHeight;
}

function clearChatEmpty() {
  if (dom.chatEmpty && dom.chatEmpty.parentNode) dom.chatEmpty.remove();
}

function appendSystemNote(text, action) {
  clearChatEmpty();
  const note = el('div', { class: 'system-note' }, [
    el('span', { text: text }),
  ]);
  if (action) note.appendChild(action);
  dom.chatStream.appendChild(note);
  scrollChat(true);
  return note;
}

function appendError(text) {
  clearChatEmpty();
  dom.chatStream.appendChild(el('div', { class: 'error-bar' }, [
    el('span', { class: 'error-icon', text: '✕' }),
    el('span', { text: text }),
  ]));
  scrollChat(true);
}

/* -------- 顶栏：健康状态 -------- */

function renderHealth() {
  const badge = dom.healthBadge;
  const list = dom.healthList;
  const llm = dom.healthLlm;
  clear(list);
  clear(llm);

  if (state.healthError) {
    badge.textContent = '数据源 离线';
    badge.className = 'badge badge-danger';
    llm.textContent = state.healthError;
    llm.className = 'health-llm muted';
    return;
  }

  const health = state.health || {};
  const sources = Array.isArray(health.dataSources) ? health.dataSources : [];
  const up = sources.filter(function (s) { return s.status === 'up'; }).length;
  const down = sources.filter(function (s) { return s.status === 'down'; }).length;
  const degraded = sources.filter(function (s) { return s.status === 'degraded'; }).length;
  // 未配置的可选源（off）不计入异常分母
  const off = sources.filter(function (s) { return s.status === 'off'; }).length;
  const effective = Math.max(1, sources.length - off);

  if (!sources.length) {
    badge.textContent = '数据源 未知';
    badge.className = 'badge badge-muted';
  } else if (down) {
    badge.textContent = '数据源 ' + up + '/' + effective + ' 可用 · ' + down + ' 异常';
    badge.className = 'badge badge-danger';
  } else if (degraded) {
    badge.textContent = '数据源 ' + up + '/' + effective + ' 可用 · ' + degraded + ' 降级';
    badge.className = 'badge badge-warn';
  } else {
    badge.textContent = '数据源 ' + up + '/' + effective + ' 正常';
    badge.className = 'badge badge-ok';
  }

  const model = health.llm || {};
  llm.textContent = '模型：' + (model.model || '未知') + ' · 供应商：' + (model.provider || '未知');
  llm.className = 'health-llm muted';

  if (!sources.length) {
    list.appendChild(el('li', { class: 'health-row muted small', text: '后端未返回数据源列表' }));
    return;
  }
  for (const src of sources) {
    const status = src.status || 'unknown';
    list.appendChild(el('li', { class: 'health-row' }, [
      el('span', { class: 'dot dot-' + status }),
      el('span', { class: 'src-name', text: src.name || '—' }),
      el('span', { class: 'src-note', text: src.note || '' }),
    ]));
  }
}

/* -------- 顶栏：行程选择器 -------- */

function renderTripSelect() {
  const select = dom.tripSelect;
  clear(select);
  if (!state.trips.length) {
    select.appendChild(el('option', { value: '', text: state.tripsError ? '（无法连接后端）' : '（暂无行程）' }));
    select.disabled = true;
    return;
  }
  select.disabled = false;
  for (const trip of state.trips) {
    const option = el('option', {
      value: trip.id,
      text: (trip.title || trip.destination || trip.id) + (trip.destination && trip.title ? ' · ' + trip.destination : ''),
    });
    if (trip.id === state.tripId) option.selected = true;
    select.appendChild(option);
  }
  if (state.tripId && !state.trips.some(function (t) { return t.id === state.tripId; })) {
    const opt = el('option', { value: state.tripId, text: '（当前行程）' });
    opt.selected = true;
    select.appendChild(opt);
  }
}

function updateBudgetBadge() {
  const badge = dom.budgetBadge;
  const plan = state.plan;
  if (!plan || !plan.budget) {
    badge.textContent = '预算 —';
    badge.className = 'badge badge-muted';
    badge.title = '尚无预算数据';
    return;
  }
  const cur = currencyOf(plan);
  const total = Number(plan.budget.total) || 0;
  const planned = Number(plan.budget.planned) || 0;
  const delta = Number(plan.budget.delta) || 0;
  // 口径：delta = 实际合计 - 预算计划，> 0 为超支，< 0 为结余
  // 徽标展示的是「差额金额」，实际合计与计划放在 title 里
  const label = delta > 0 ? '超支 ' + fmtMoney(Math.abs(delta), cur)
    : delta < 0 ? '结余 ' + fmtMoney(Math.abs(delta), cur)
    : '预算内';
  badge.textContent = label;
  badge.className = 'badge ' + (delta > 0 ? 'badge-danger' : 'badge-ok');
  badge.title = '实际合计 ' + fmtMoney(total, cur) + ' / 预算计划 ' + fmtMoney(planned, cur) +
                '（' + label + '）';
}

/* -------- 中栏：看板 -------- */

function renderBoard() {
  const host = dom.board;
  clear(host);
  const plan = state.plan;

  if (!plan) {
    const message = state.tripsError
      ? '后端尚未连接或无法访问：' + state.tripsError + '。启动服务后点击「重试」即可加载。'
      : state.tripId
        ? '还没有生成行程单。在左侧对话中描述需求，或新建一个行程让助手开始规划。'
        : '先点击右上角「新建行程」，或选择已有行程。';
    host.appendChild(el('div', { class: 'empty-state' }, [
      el('div', { class: 'empty-title', text: '暂无行程方案' }),
      el('p', { class: 'empty-text', text: message }),
    ]));
    dom.boardSub.textContent = state.tripId ? '等待生成' : '尚未加载行程';
    return;
  }

  // 按 itinerary 的日期/序号排序，保证看板顺序与行程单一致
  const days = (Array.isArray(plan.days) ? plan.days.slice() : []).sort(function (a, b) {
    const da = String(a && a.date || '');
    const db = String(b && b.date || '');
    if (da !== db) return da < db ? -1 : 1;
    return (Number(a && a.day) || 0) - (Number(b && b.day) || 0);
  });
  dom.boardSub.textContent = (plan.destination || '') +
    (plan.startDate && plan.endDate ? ' · ' + plan.startDate + ' → ' + plan.endDate : '') +
    ' · ' + days.length + ' 天';

  for (const day of days) {
    host.appendChild(renderDayCard(day, plan));
  }
  if (!days.length) {
    host.appendChild(el('div', { class: 'empty-state' }, [
      el('div', { class: 'empty-title', text: '方案还没有行程日' }),
      el('p', { class: 'empty-text', text: '后端返回了 plan 但 days 为空，可能仍在生成中。' }),
    ]));
  }

  const risks = Array.isArray(plan.risks) ? plan.risks : [];
  const unconfirmed = Array.isArray(plan.unconfirmed) ? plan.unconfirmed : [];
  if (risks.length) host.appendChild(renderRiskSection(risks));
  if (unconfirmed.length) host.appendChild(renderUnconfirmedSection(unconfirmed));
}

function renderDayCard(day, plan) {
  const cur = currencyOf(plan);
  const card = el('section', { class: 'day-card' }, [
    el('header', { class: 'day-head' }, [
      el('span', { class: 'day-num', text: 'Day ' + (day.day !== undefined ? day.day : '?') }),
      el('div', { class: 'day-meta' }, [
        el('div', { class: 'day-date', text: fmtDate(day.date) }),
        el('div', { class: 'day-theme', text: day.theme || '（未命名主题）' }),
      ]),
      el('span', { class: 'day-total', text: fmtMoney(day.totalCost, cur) }),
    ]),
  ]);

  const list = el('ul', { class: 'acts' });
  const activities = Array.isArray(day.activities) ? day.activities : [];
  for (const act of activities) list.appendChild(renderActivity(act, cur));
  if (!activities.length) {
    list.appendChild(el('li', { class: 'act muted small', text: '这一天还没有安排' }));
  }
  card.appendChild(list);
  return card;
}

function renderActivity(act, cur) {
  const type = TYPE_META[act.type] || { icon: '•', label: act.type || '其他', cls: 't-free' };
  const conf = CONF_META[act.confidence] || { label: act.confidence || '未知', cls: 'c-low' };

  const title = el('div', { class: 'act-title' }, [
    el('span', { text: act.title || '（未命名活动）' }),
  ]);
  if (act.needsBooking) {
    const lead = act.bookingLeadDays ? ' · 提前 ' + act.bookingLeadDays + ' 天' : '';
    title.appendChild(el('span', { class: 'chip chip-book', text: '需预订' + lead }));
  }
  if (act.verified === false) {
    title.appendChild(el('span', { class: 'chip chip-verify', text: '待核实' }));
  }

  const sub = el('div', { class: 'act-sub' }, [
    el('span', { text: act.location || '地点未知' }),
    el('span', { text: '· ' + fmtDuration(act.durationMin) }),
    el('span', { class: 'act-src', text: act.source || '来源未知' }),
    el('span', { class: 'conf ' + conf.cls, text: conf.label }),
    act.fetchedAt
      ? el('span', { class: 'act-fetched', title: '数据取数时间 ' + act.fetchedAt, text: '取数 ' + fmtStamp(act.fetchedAt) })
      : null,
  ]);

  const body = el('div', { class: 'act-body' }, [title, sub]);
  if (act.notes) body.appendChild(el('div', { class: 'act-notes', text: act.notes }));

  const cost = el('div', { class: 'act-cost' }, [
    el('div', { class: 'act-cost-total', text: fmtMoney(act.costTotal, cur) }),
  ]);
  if (act.costPerPerson) {
    cost.appendChild(el('div', { class: 'act-cost-sub', text: fmtMoney(act.costPerPerson, cur) + '/人' }));
  }

  return el('li', { class: 'act' }, [
    el('span', { class: 'act-time', text: act.time || '--:--' }),
    el('span', { class: 'act-icon ' + type.cls, title: type.label, text: type.icon }),
    body,
    cost,
  ]);
}

function renderRiskSection(risks) {
  const section = el('section', { class: 'board-section', id: 'board-risks' }, [
    el('div', { class: 'board-section-head' }, [
      el('span', { class: 'board-section-title', text: '风险' }),
      el('span', { class: 'board-section-count', text: risks.length + ' 项' }),
    ]),
  ]);
  for (const risk of risks) {
    const level = risk.level || 'low';
    section.appendChild(el('article', { class: 'risk risk-' + level }, [
      el('div', { class: 'risk-head' }, [
        el('span', { class: 'risk-level', text: level === 'high' ? '高' : level === 'medium' ? '中' : '低' }),
        el('span', { class: 'risk-title', text: risk.title || '' }),
      ]),
      risk.mitigation ? el('p', { class: 'risk-mit', text: '应对：' + risk.mitigation }) : null,
    ]));
  }
  return section;
}

function renderUnconfirmedSection(unconfirmed) {
  const section = el('section', { class: 'board-section', id: 'board-unconfirmed' }, [
    el('div', { class: 'board-section-head' }, [
      el('span', { class: 'board-section-title', text: '待核实' }),
      el('span', { class: 'board-section-count', text: unconfirmed.length + ' 项' }),
    ]),
  ]);
  for (const item of unconfirmed) {
    section.appendChild(el('article', { class: 'unc' }, [
      el('div', { class: 'unc-item', text: item.item || '' }),
      item.reason ? el('p', { class: 'unc-reason', text: '原因：' + item.reason }) : null,
      item.howToVerify ? el('p', { class: 'unc-how' }, [
        el('b', { text: '核实方式：' }),
        el('span', { text: item.howToVerify }),
      ]) : null,
    ]));
  }
  return section;
}

/* -------- 右栏：预算 -------- */

function renderBudget() {
  const host = dom.budgetBody;
  clear(host);
  const plan = state.plan;

  if (!plan || !plan.budget) {
    host.appendChild(el('p', { class: 'muted small', text: '暂无预算数据。生成行程方案后这里会显示预算构成与差额。' }));
    return;
  }

  const budget = plan.budget;
  const cur = currencyOf(plan);
  const planned = Number(budget.planned) || 0;
  const total = Number(budget.total) || 0;
  const delta = Number(budget.delta) || 0;
  const over = delta > 0;
  const flat = delta === 0;
  const pct = planned > 0 ? Math.min(100, Math.round((total / planned) * 100)) : (total > 0 ? 100 : 0);

  host.appendChild(el('div', { class: 'budget-nums' }, [
    el('div', { class: 'budget-num' }, [
      el('span', { class: 'v', text: fmtMoney(total, cur) }),
      el('span', { class: 'k', text: '实际合计' }),
    ]),
    el('div', { class: 'budget-num' }, [
      el('span', { class: 'v', text: fmtMoney(planned, cur) }),
      el('span', { class: 'k', text: '预算计划' }),
    ]),
  ]));

  host.appendChild(el('div', {
    class: 'bar',
    role: 'progressbar',
    'aria-valuenow': String(pct),
    'aria-valuemin': '0',
    'aria-valuemax': '100',
    title: '已用 ' + pct + '%',
  }, [
    el('div', { class: 'bar-fill ' + (over ? 'is-over' : 'is-under'), style: 'width:' + pct + '%' }),
  ]));

  host.appendChild(el('div', { class: 'budget-delta ' + (over ? 'is-over' : 'is-under') }, [
    el('span', { text: over ? '▲' : flat ? '■' : '▼' }),
    el('span', {
      text: over
        ? '超支 ' + fmtMoney(Math.abs(delta), cur)
        : flat ? '与预算持平' : '结余 ' + fmtMoney(Math.abs(delta), cur),
    }),
  ]));

  const lines = Array.isArray(budget.lines) ? budget.lines : [];
  if (!lines.length) {
    host.appendChild(el('p', { class: 'muted small', text: '预算没有分类明细。' }));
    return;
  }

  // 分类占比条
  const groups = new Map();
  let sum = 0;
  for (const line of lines) {
    const cat = line.category || 'other';
    const amount = Number(line.amount) || 0;
    sum += amount;
    if (!groups.has(cat)) groups.set(cat, { total: 0, lines: [] });
    groups.get(cat).total += amount;
    groups.get(cat).lines.push(line);
  }
  if (sum > 0) {
    const stack = el('div', { class: 'budget-stack' });
    for (const [cat, group] of groups) {
      const meta = CAT_META[cat] || CAT_META.other;
      stack.appendChild(el('span', {
        style: 'width:' + Math.round((group.total / sum) * 100) + '%;background:' + meta.color,
        title: meta.label + ' ' + fmtMoney(group.total, cur),
      }));
    }
    host.appendChild(stack);
  }

  for (const [cat, group] of groups) {
    const meta = CAT_META[cat] || CAT_META.other;
    const block = el('div', { class: 'budget-cat' }, [
      el('div', { class: 'budget-cat-head' }, [
        el('span', { class: 'cat-swatch', style: 'background:' + meta.color }),
        el('span', { text: meta.label }),
        el('span', { class: 'cat-total', text: fmtMoney(group.total, cur) }),
      ]),
    ]);
    const list = el('div', { class: 'budget-lines' });
    for (const line of group.lines) {
      const conf = CONF_META[line.confidence];
      list.appendChild(el('div', { class: 'budget-line' }, [
        el('span', { class: 'bl-label', text: line.label || '(未命名)' }),
        conf ? el('span', { class: 'conf ' + conf.cls, text: conf.label }) : null,
        el('span', { class: 'bl-amount', text: fmtMoney(line.amount, cur) }),
        el('span', { class: 'bl-unit', text: line.unit || '' }),
      ]));
    }
    block.appendChild(list);
    host.appendChild(block);
  }
}

/* -------- 右栏：产物文件 -------- */

function renderFiles() {
  const host = dom.filesBody;
  clear(host);
  const files = Array.isArray(state.files) ? state.files : [];

  dom.downloadAll.hidden = files.length === 0;

  if (!files.length) {
    host.appendChild(el('p', { class: 'muted small', text: '暂无产物文件。规划完成后，行程单、预算表、调研记录会在这里列出并可下载。' }));
    return;
  }

  const list = el('ul', { class: 'file-list' });
  for (const file of files) {
    const item = el('button', {
      class: 'file-item',
      type: 'button',
      title: '点击预览，或用下载按钮保存',
      onclick: function () { openFile(file.name); },
    }, [
      el('span', { class: 'file-icon', text: '▤' }),
      el('span', { class: 'file-name', text: file.name }),
      el('span', { class: 'file-size', text: fmtBytes(file.bytes) }),
    ]);
    list.appendChild(el('li', {}, [item]));
  }
  host.appendChild(list);
}

/* -------- 右栏：风险摘要（指向中栏完整卡片） -------- */

function renderRiskSummary() {
  const host = dom.riskBody;
  clear(host);
  const plan = state.plan;
  if (!plan) {
    host.appendChild(el('p', { class: 'muted small', text: '暂无数据。' }));
    return;
  }
  const risks = Array.isArray(plan.risks) ? plan.risks : [];
  const unconfirmed = Array.isArray(plan.unconfirmed) ? plan.unconfirmed : [];

  if (!risks.length && !unconfirmed.length) {
    host.appendChild(el('p', { class: 'muted small', text: '暂无风险项，也没有需要待核实的条目。' }));
    return;
  }

  const summary = el('div', { class: 'risk-summary' });
  for (const risk of risks) {
    const level = risk.level || 'low';
    summary.appendChild(el('button', {
      class: 'risk-chip',
      type: 'button',
      onclick: function () { scrollToBoard('board-risks'); },
    }, [
      el('span', { class: 'lv ' + level, text: level === 'high' ? '高' : level === 'medium' ? '中' : '低' }),
      el('span', { class: 'tx', text: risk.title || '' }),
    ]));
  }
  if (unconfirmed.length) {
    summary.appendChild(el('button', {
      class: 'unc-count',
      type: 'button',
      onclick: function () { scrollToBoard('board-unconfirmed'); },
    }, [
      el('span', { text: '⚠ ' + unconfirmed.length + ' 项待核实' }),
    ]));
  }
  host.appendChild(summary);
}

function scrollToBoard(id) {
  if (window.matchMedia && window.matchMedia('(max-width: 1100px)').matches) {
    document.body.dataset.pane = 'board';
    syncTabs();
  }
  const target = document.getElementById(id);
  if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/* -------------------------------------------------------- 对话流渲染 -- */

function appendUserMessage(text) {
  clearChatEmpty();
  dom.chatStream.appendChild(el('div', { class: 'turn turn-user' }, [
    el('div', { class: 'turn-meta', text: '我' }),
    el('div', { class: 'bubble bubble-user', text: text }),
  ]));
  scrollChat(true);
}

function createTurn() {
  const statusLine = el('div', { class: 'turn-status', hidden: true });
  const todoBox = el('div', { class: 'turn-todos', hidden: true });
  const toolBox = el('div', { class: 'turn-tools', hidden: true });
  const agentBox = el('div', { class: 'turn-agents', hidden: true });
  const textNode = el('div', { class: 'bubble-text' });
  const artBox = el('div', { class: 'turn-artifacts', hidden: true });
  const hitlBox = el('div', { class: 'turn-hitl', hidden: true });

  const root = el('div', { class: 'turn turn-assistant' }, [
    el('div', { class: 'turn-meta', text: '助手' }),
    statusLine,
    todoBox,
    toolBox,
    agentBox,
    el('div', { class: 'bubble bubble-assistant' }, [textNode]),
    artBox,
    hitlBox,
  ]);

  dom.chatStream.appendChild(root);
  scrollChat(true);

  return {
    root: root, statusLine: statusLine, todoBox: todoBox, toolBox: toolBox,
    agentBox: agentBox, textNode: textNode, artBox: artBox, hitlBox: hitlBox,
    tools: [], agents: [], todos: [],
  };
}

function renderStatusEvent(ev, turn) {
  const phase = PHASE_META[ev.phase] || ev.phase || '';
  turn.statusLine.hidden = false;
  turn.statusLine.textContent = (phase ? phase + ' · ' : '') + (ev.message || '');
}

function renderTodoEvent(ev, turn) {
  const todos = Array.isArray(ev.todos) ? ev.todos : [];
  turn.todos = todos;
  clear(turn.todoBox);
  turn.todoBox.hidden = false;

  const done = todos.filter(function (t) { return t.status === 'completed'; }).length;
  turn.todoBox.appendChild(el('div', { class: 'todo-head' }, [
    el('span', { class: 'todo-title', text: '任务进度' }),
    el('span', { class: 'num', text: done + '/' + todos.length }),
  ]));

  const list = el('ul', { class: 'todo-list' });
  for (const todo of todos) {
    const status = todo.status || 'pending';
    list.appendChild(el('li', { class: 'todo-item todo-' + status }, [
      el('span', { class: 'todo-mark', text: TODO_MARK[status] || '☐' }),
      el('span', { class: 'todo-text', text: todo.content || '' }),
    ]));
  }
  turn.todoBox.appendChild(list);
}

function renderToolEvent(ev, turn) {
  turn.toolBox.hidden = false;
  const status = ev.status || 'running';

  let entry = null;
  for (let i = turn.tools.length - 1; i >= 0; i--) {
    if (turn.tools[i].name === ev.name && turn.tools[i].status === 'running') { entry = turn.tools[i]; break; }
  }

  if (!entry) {
    const statusEl = el('span', { class: 'tool-status' });
    const msEl = el('span', { class: 'num tool-ms' });
    const detail = el('div', { class: 'tool-detail' });
    const details = el('details', { class: 'tool-details' }, [
      el('summary', { class: 'tool-summary' }, [
        el('span', { class: 'tool-icon', text: '⚙' }),
        el('span', { class: 'tool-name', text: ev.name || 'tool' }),
        statusEl,
        msEl,
        el('span', { class: 'tool-caret', text: '▾' }),
      ]),
      detail,
    ]);
    turn.toolBox.appendChild(details);
    entry = { name: ev.name, status: 'running', ms: undefined, input: undefined, outputPreview: undefined,
              statusEl: statusEl, msEl: msEl, detail: detail };
    turn.tools.push(entry);
  }

  entry.status = status;
  if (typeof ev.ms === 'number') entry.ms = ev.ms;
  if (ev.input !== undefined) entry.input = ev.input;
  if (ev.outputPreview !== undefined) entry.outputPreview = ev.outputPreview;

  entry.statusEl.textContent = TOOL_STATUS_LABEL[status] || status;
  entry.statusEl.className = 'tool-status ts-' + status;
  entry.msEl.textContent = entry.ms === undefined ? '' : entry.ms + 'ms';

  clear(entry.detail);
  if (entry.input !== undefined && entry.input !== null) {
    entry.detail.appendChild(el('div', { class: 'tool-kv' }, [
      el('b', { text: '输入' }),
      el('pre', { class: 'tool-pre', text: safeStringify(entry.input) }),
    ]));
  }
  if (entry.outputPreview) {
    entry.detail.appendChild(el('div', { class: 'tool-kv' }, [
      el('b', { text: '输出' }),
      el('pre', { class: 'tool-pre', text: String(entry.outputPreview) }),
    ]));
  }
}

function renderSubagentEvent(ev, turn) {
  turn.agentBox.hidden = false;
  const status = ev.status || 'running';

  let entry = null;
  for (let i = turn.agents.length - 1; i >= 0; i--) {
    if (turn.agents[i].name === ev.name && turn.agents[i].status === 'running') { entry = turn.agents[i]; break; }
  }
  if (!entry) {
    entry = { name: ev.name, status: 'running', summary: undefined, statusEl: el('span'), summaryEl: el('span', { class: 'agent-summary' }) };
    turn.agentBox.appendChild(el('div', { class: 'agent-strip' }, [
      el('span', { class: 'agent-tag', text: '委派' }),
      el('span', { class: 'agent-name', text: ev.name || 'agent' }),
      entry.statusEl,
      entry.summaryEl,
    ]));
    turn.agents.push(entry);
  }

  entry.status = status;
  if (ev.summary !== undefined) entry.summary = ev.summary;
  entry.statusEl.textContent = SUBAGENT_STATUS_LABEL[status] || status;
  entry.statusEl.className = 'tool-status ts-' + status;
  entry.summaryEl.textContent = entry.summary ? '· ' + entry.summary : '';
}

function renderTokenEvent(ev, turn) {
  turn.textNode.appendChild(document.createTextNode(String(ev.text === undefined ? '' : ev.text)));
  scrollChat();
}

function renderArtifactEvent(ev, turn) {
  turn.artBox.hidden = false;
  turn.artBox.appendChild(el('div', { class: 'artifact-chip' }, [
    el('span', { class: 'artifact-icon', text: '▤' }),
    el('span', { text: ev.name || '产物' }),
    el('span', { class: 'num artifact-size', text: fmtBytes(ev.bytes) }),
  ]));
  refreshTrip({ keepPlan: true, silent: true });
}

function renderErrorEvent(ev) {
  appendError((ev.message || '未知错误') + (ev.code ? '（' + ev.code + '）' : ''));
  updateComposerState();
}

function renderDoneEvent(ev, turn) {
  turn.statusLine.hidden = false;
  turn.statusLine.textContent = '完成' + (ev.messageId ? ' · messageId ' + ev.messageId : '');
  if (ev.plan) {
    state.plan = ev.plan;
    renderBoard();
    renderBudget();
    renderRiskSummary();
    updateBudgetBadge();
  }
  refreshTrip({ keepPlan: true, silent: true });
  updateComposerState();
}

/* -------- HITL -------- */

function renderInterruptEvent(ev, turn) {
  turn.hitlBox.hidden = false;
  const card = el('div', { class: 'hitl-card' });

  card.appendChild(el('div', { class: 'hitl-head' }, [
    el('span', { class: 'hitl-badge', text: '待确认' }),
    el('span', { class: 'hitl-title', text: ev.title || '需要你确认后继续' }),
  ]));

  const details = Array.isArray(ev.details) ? ev.details : [];
  if (details.length) {
    const list = el('ul', { class: 'hitl-details' });
    for (const detail of details) list.appendChild(el('li', { text: String(detail) }));
    card.appendChild(list);
  }

  if (ev.budget) {
    const b = ev.budget;
    const cur = b.currency || 'CNY';
    const delta = Number(b.delta) || 0;
    const over = delta > 0;
    card.appendChild(el('div', { class: 'hitl-budget ' + (over ? 'is-over' : 'is-under') }, [
      el('span', { class: 'num', text: '计划 ' + fmtMoney(b.planned, cur) }),
      el('span', { class: 'num', text: '实际 ' + fmtMoney(b.total, cur) }),
      el('strong', {
        class: 'num',
        text: over ? '超支 ' + fmtMoney(Math.abs(delta), cur)
                   : (delta === 0 ? '与预算持平' : '结余 ' + fmtMoney(Math.abs(delta), cur)),
      }),
    ]));
  }

  const reasonWrap = el('div', { class: 'hitl-reason', hidden: true });
  const reasonInput = el('textarea', { class: 'hitl-textarea', rows: '2', placeholder: '说明需要修改的地方，例如「把第 2 天的门票砍掉」' });
  reasonWrap.appendChild(reasonInput);

  const approveBtn = el('button', { class: 'btn btn-primary', type: 'button', text: '放行' });
  const rejectBtn = el('button', { class: 'btn btn-ghost-danger', type: 'button', text: '驳回并说明' });
  const confirmBtn = el('button', { class: 'btn btn-danger', type: 'button', text: '确认驳回', hidden: true });

  const actions = el('div', { class: 'hitl-actions' }, [approveBtn, rejectBtn, confirmBtn]);
  card.appendChild(reasonWrap);
  card.appendChild(actions);

  const buttons = [approveBtn, rejectBtn, confirmBtn];
  const resolve = function (approved, reason) { submitApproval(ev, card, actions, buttons, approved, reason, turn); };

  approveBtn.addEventListener('click', function () { resolve(true, undefined); });
  rejectBtn.addEventListener('click', function () {
    reasonWrap.hidden = false;
    confirmBtn.hidden = false;
    rejectBtn.hidden = true;
    reasonInput.focus();
  });
  confirmBtn.addEventListener('click', function () {
    const reason = reasonInput.value.trim();
    if (!reason) {
      toast('驳回必须写明理由', 'warn');
      reasonInput.focus();
      return;
    }
    resolve(false, reason);
  });

  turn.hitlBox.appendChild(card);
  scrollChat(true);
}

async function submitApproval(ev, card, actions, buttons, approved, reason, turn) {
  if (!state.tripId) {
    toast('没有选中的行程，无法提交确认', 'error');
    return;
  }
  for (const btn of buttons) btn.disabled = true;
  card.classList.add('is-resolving');
  try {
    const payload = { interruptId: ev.interruptId, approved: approved };
    if (!approved && reason) payload.reason = reason;
    // 放行后端会继续跑 agent 并以 SSE 回传后续事件 —— 必须按流读，不能用普通 json 请求
    const res = await fetch(API.approve(state.tripId), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      let message = '提交确认失败：HTTP ' + res.status;
      try {
        const body = await res.json();
        if (body && body.error && body.error.message) message = body.error.message;
      } catch (e) { /* 非 JSON 错误体 */ }
      throw new Error(message);
    }
    if (!res.body) throw new Error('当前浏览器不支持流式响应，无法读取续跑事件。');
    card.classList.remove('is-resolving');
    card.classList.add(approved ? 'is-approved' : 'is-rejected');
    clear(actions);
    actions.appendChild(el('span', {
      class: 'hitl-resolved',
      text: approved ? '✓ 已放行，正在继续生成…' : '✕ 已驳回：' + (reason || ''),
    }));
    const streamTurn = turn || createTurn();
    await readSse(res.body, streamTurn);
  } catch (e) {
    card.classList.remove('is-resolving');
    for (const btn of buttons) btn.disabled = false;
    card.appendChild(el('div', { class: 'error-bar small', text: '提交确认失败：' + e.message }));
    scrollChat(true);
  }
}

/* ------------------------------------------------------ SSE 事件分发 -- */

function dispatchEvent(ev, turn) {
  switch (ev.type) {
    case 'status':    renderStatusEvent(ev, turn); break;
    case 'todo':      renderTodoEvent(ev, turn); break;
    case 'tool':      renderToolEvent(ev, turn); break;
    case 'subagent':  renderSubagentEvent(ev, turn); break;
    case 'token':     renderTokenEvent(ev, turn); break;
    case 'artifact':  renderArtifactEvent(ev, turn); break;
    case 'interrupt': renderInterruptEvent(ev, turn); break;
    case 'error':     renderErrorEvent(ev); break;
    case 'done':      renderDoneEvent(ev, turn); break;
    default:
      console.warn('[TripPilot] 未处理的 SSE 事件类型：', ev && ev.type);
  }
}

function handleFrame(frame, turn) {
  const dataLines = [];
  for (const line of String(frame).split('\n')) {
    if (line.indexOf('data:') === 0) dataLines.push(line.slice(5).replace(/^ /, ''));
  }
  if (!dataLines.length) return false;
  const payload = dataLines.join('\n');
  if (!payload.trim()) return false;

  let ev;
  try {
    ev = JSON.parse(payload);
  } catch (e) {
    console.warn('[TripPilot] 无法解析的 SSE 帧：', payload);
    return false;
  }
  if (!ev || typeof ev !== 'object') return false;
  dispatchEvent(ev, turn);
  return ev.type === 'done';
}

async function readSse(body, turn) {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let sawDone = false;

  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    buffer = buffer.replace(/\r\n/g, '\n');
    let index = buffer.indexOf('\n\n');
    while (index !== -1) {
      const frame = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      if (handleFrame(frame, turn)) sawDone = true;
      index = buffer.indexOf('\n\n');
    }
  }

  buffer += decoder.decode();
  buffer = buffer.replace(/\r\n/g, '\n');
  if (buffer.trim() && handleFrame(buffer, turn)) sawDone = true;

  if (!sawDone) throw new Error('连接意外中断，没有收到完成事件（done）。');
}

/* ------------------------------------------------------------ 对话发送 -- */

async function sendMessage(text) {
  if (!state.tripId) {
    toast('请先选择或新建一个行程', 'warn');
    return;
  }
  if (state.streaming) return;

  appendUserMessage(text);
  const turn = createTurn();

  state.streaming = true;
  const controller = new AbortController();
  state.controller = controller;
  updateComposerState();
  dom.chatStatus.textContent = '生成中…';

  try {
    let res;
    try {
      res = await fetch(API.chat(state.tripId), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify({ message: text }),
        signal: controller.signal,
      });
    } catch (e) {
      if (controller.signal.aborted) throw new Error('对话已取消。');
      throw new Error('无法连接后端（' + API.chat(state.tripId) + '）：' + (e && e.message ? e.message : '网络错误'));
    }

    if (!res.ok) {
      let message = '对话请求失败：HTTP ' + res.status;
      try {
        const body = await res.json();
        if (body && body.error && body.error.message) message = body.error.message;
      } catch (e) { /* 忽略非 JSON 错误体 */ }
      throw new Error(message);
    }
    if (!res.body) throw new Error('当前浏览器不支持流式响应，无法读取 SSE 事件。');

    await readSse(res.body, turn);
  } catch (e) {
    appendError(e && e.message ? e.message : String(e));
  } finally {
    state.streaming = false;
    state.controller = null;
    updateComposerState();
    dom.chatStatus.textContent = '就绪';
  }
}

function updateComposerState() {
  const hasTrip = !!state.tripId;
  const enabled = hasTrip && !state.streaming;
  dom.input.disabled = !enabled;
  dom.send.disabled = !enabled;
  dom.send.textContent = state.streaming ? '生成中…' : '发送';
  dom.input.placeholder = hasTrip
    ? '描述你的行程需求，或对当前方案提出修改…（Enter 发送，Shift+Enter 换行）'
    : '请先选择或新建一个行程';
}

/* ------------------------------------------------------------ 数据加载 -- */

async function fetchHealth() {
  try {
    state.health = await jfetch(API.health);
    state.healthError = null;
    state.backendOnline = true;
  } catch (e) {
    state.health = null;
    state.healthError = e.message;
  }
  renderHealth();
}

async function loadTrips() {
  try {
    const res = await jfetch(API.trips);
    state.trips = Array.isArray(res && res.trips) ? res.trips : [];
    state.tripsError = null;
    state.backendOnline = true;
  } catch (e) {
    state.trips = [];
    state.tripsError = e.message;
  }
  renderTripSelect();
  updateComposerState();
}

async function loadTrip(id, opts) {
  const options = opts || {};
  state.tripId = id;
  renderTripSelect();
  updateComposerState();
  try {
    const res = await jfetch(API.trip(id));
    // 过期响应丢弃：请求期间用户可能已经切到别的行程
    if (state.tripId !== id) return;
    state.trip = (res && res.trip) || null;
    if (res && res.plan) state.plan = res.plan;
    else if (!options.keepPlan) state.plan = null;
    state.files = Array.isArray(res && res.files) ? res.files : [];
    state.detailError = null;
  } catch (e) {
    if (state.tripId !== id) return;
    state.detailError = e.message;
    if (!options.silent) appendError('加载行程失败：' + e.message);
  }
  renderBoard();
  renderBudget();
  renderFiles();
  renderRiskSummary();
  updateBudgetBadge();
  updateComposerState();
}

async function refreshTrip(opts) {
  const options = opts || {};
  if (!state.tripId) return;
  const id = state.tripId;
  try {
    const res = await jfetch(API.trip(id));
    // 同理：刷新期间行程被切换，这份响应已经过期
    if (state.tripId !== id) return;
    if (res && res.trip) state.trip = res.trip;
    if (res && res.plan) state.plan = res.plan;
    else if (!options.keepPlan) state.plan = null;
    if (Array.isArray(res && res.files)) state.files = res.files;
    renderBoard();
    renderBudget();
    renderFiles();
    renderRiskSummary();
    updateBudgetBadge();
  } catch (e) {
    if (!options.silent) appendError('刷新行程失败：' + e.message);
  }
}

function selectTrip(id) {
  if (!id) return;
  loadTrip(id);
}

/* ------------------------------------------------------------ 文件预览 -- */

async function openFile(name) {
  if (!state.tripId) {
    toast('没有选中的行程', 'warn');
    return;
  }
  dom.fileName.textContent = name;
  dom.fileContent.textContent = '加载中…';
  dom.fileDownload.href = API.file(state.tripId, name) + '?download=1';
  dom.fileDownload.setAttribute('download', String(name).split('/').pop());
  openDialog(dom.fileDialog);
  try {
    const res = await fetch(API.file(state.tripId, name));
    if (!res.ok) {
      let message = '读取文件失败：HTTP ' + res.status;
      try {
        const body = await res.json();
        if (body && body.error && body.error.message) message = body.error.message;
      } catch (e) { /* 忽略 */ }
      throw new Error(message);
    }
    const text = await res.text();
    dom.fileContent.textContent = text;
  } catch (e) {
    dom.fileContent.textContent = '无法预览：' + (e && e.message ? e.message : String(e));
  }
}

function downloadAll() {
  const files = (state.files || []).slice();
  if (!files.length) return;
  files.forEach(function (file, i) {
    window.setTimeout(function () {
      const link = el('a', {
        href: API.file(state.tripId, file.name) + '?download=1',
        download: String(file.name).split('/').pop(),
      });
      document.body.appendChild(link);
      link.click();
      link.remove();
    }, i * 250);
  });
}

/* ------------------------------------------------------------ 弹窗控制 -- */

function openDialog(node) {
  if (!node) return;
  if (typeof node.showModal === 'function') {
    if (!node.open) node.showModal();
  } else {
    node.setAttribute('open', '');
  }
}

function closeDialog(node) {
  if (!node) return;
  if (typeof node.close === 'function') node.close();
  else node.removeAttribute('open');
}

/* ------------------------------------------------------------ 新建行程 -- */

function buildPreferences() {
  const grid = dom.prefGrid;
  clear(grid);
  for (const pref of PREFERENCE_OPTIONS) {
    const input = el('input', { type: 'checkbox', name: 'prefs', value: pref });
    const label = el('label', { class: 'pref-option' }, [input, el('span', { text: pref })]);
    input.addEventListener('change', function () {
      label.classList.toggle('is-on', input.checked);
    });
    grid.appendChild(label);
  }
}

function showFormError(message) {
  dom.formError.hidden = false;
  dom.formError.textContent = message;
}

async function submitTripForm(event) {
  event.preventDefault();
  dom.formError.hidden = true;

  const fd = new FormData(dom.tripForm);
  const destination = String(fd.get('destination') || '').trim();
  const title = String(fd.get('title') || '').trim();
  const startDate = String(fd.get('startDate') || '');
  const endDate = String(fd.get('endDate') || '');
  const travelers = Number(fd.get('travelers'));
  const budgetTotal = Number(fd.get('budgetTotal'));
  const preferences = fd.getAll('prefs').map(String);

  if (!destination) return showFormError('请填写目的地。');
  if (!startDate || !endDate) return showFormError('请填写开始与结束日期。');
  if (endDate < startDate) return showFormError('结束日期不能早于开始日期。');
  if (!Number.isFinite(travelers) || travelers < 1) return showFormError('人数至少为 1 人。');
  if (!Number.isFinite(budgetTotal) || budgetTotal < 0) return showFormError('总预算不能为负数。');

  const payload = {
    destination: destination,
    startDate: startDate,
    endDate: endDate,
    travelers: travelers,
    budgetTotal: budgetTotal,
    currency: 'CNY',
    preferences: preferences,
  };
  if (title) payload.title = title;

  dom.tripSubmit.disabled = true;
  dom.tripSubmit.textContent = '创建中…';
  try {
    const res = await jfetch(API.trips, { method: 'POST', body: JSON.stringify(payload) });
    const trip = (res && res.trip) || res || {};
    const newId = trip.id || trip.tripId || null;

    closeDialog(dom.tripDialog);
    dom.tripForm.reset();
    buildPreferences();

    await loadTrips();
    if (newId) {
      state.tripId = newId;
      await loadTrip(newId);
    }
    appendSystemNote('已创建行程「' + (trip.title || destination) + '」，在左侧描述你的具体需求即可开始规划。');
  } catch (e) {
    showFormError(e && e.message ? e.message : String(e));
  } finally {
    dom.tripSubmit.disabled = false;
    dom.tripSubmit.textContent = '创建行程';
  }
}

/* ------------------------------------------------------------ 标签切换 -- */

function syncTabs() {
  const pane = document.body.dataset.pane || 'chat';
  const buttons = dom.mobileTabs.querySelectorAll('button[data-pane]');
  for (const btn of buttons) btn.classList.toggle('is-active', btn.dataset.pane === pane);
}

/* ---------------------------------------------------------------- 启动 -- */

function bindEvents() {
  dom.tripSelect.addEventListener('change', function () {
    const id = dom.tripSelect.value;
    if (id) selectTrip(id);
  });

  dom.newTripBtn.addEventListener('click', function () {
    dom.formError.hidden = true;
    openDialog(dom.tripDialog);
  });
  dom.tripCancel.addEventListener('click', function () { closeDialog(dom.tripDialog); });
  dom.tripForm.addEventListener('submit', submitTripForm);

  dom.composer.addEventListener('submit', function (e) {
    e.preventDefault();
    const text = dom.input.value.trim();
    if (!text) return;
    dom.input.value = '';
    sendMessage(text);
  });
  dom.input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      dom.composer.requestSubmit();
    }
  });

  dom.downloadAll.addEventListener('click', downloadAll);
  dom.fileClose.addEventListener('click', function () { closeDialog(dom.fileDialog); });

  dom.mobileTabs.addEventListener('click', function (e) {
    const btn = e.target.closest('button[data-pane]');
    if (!btn) return;
    document.body.dataset.pane = btn.dataset.pane;
    syncTabs();
  });

  window.addEventListener('beforeunload', function () {
    if (state.controller) state.controller.abort();
  });
}

function cacheDom() {
  dom.healthBadge = document.getElementById('health-badge');
  dom.healthList = document.getElementById('health-list');
  dom.healthLlm = document.getElementById('health-llm');
  dom.budgetBadge = document.getElementById('budget-badge');
  dom.tripSelect = document.getElementById('trip-select');
  dom.newTripBtn = document.getElementById('btn-new-trip');

  dom.chatStatus = document.getElementById('chat-status');
  dom.chatStream = document.getElementById('chat-stream');
  dom.chatEmpty = document.getElementById('chat-empty');
  dom.composer = document.getElementById('composer');
  dom.input = document.getElementById('composer-input');
  dom.send = document.getElementById('composer-send');

  dom.board = document.getElementById('board');
  dom.boardSub = document.getElementById('board-sub');

  dom.budgetBody = document.getElementById('budget-body');
  dom.filesBody = document.getElementById('files-body');
  dom.riskBody = document.getElementById('risk-body');
  dom.downloadAll = document.getElementById('btn-download-all');
  dom.sideSub = document.getElementById('side-sub');

  dom.tripDialog = document.getElementById('trip-dialog');
  dom.tripForm = document.getElementById('trip-form');
  dom.tripCancel = document.getElementById('trip-cancel');
  dom.tripSubmit = document.getElementById('trip-submit');
  dom.formError = document.getElementById('trip-form-error');
  dom.prefGrid = document.getElementById('pref-grid');

  dom.fileDialog = document.getElementById('file-dialog');
  dom.fileName = document.getElementById('file-name');
  dom.fileContent = document.getElementById('file-content');
  dom.fileDownload = document.getElementById('file-download');
  dom.fileClose = document.getElementById('file-close');

  dom.mobileTabs = document.getElementById('mobile-tabs');
  dom.toastHost = document.getElementById('toast-host');
}

async function init() {
  cacheDom();
  buildPreferences();
  bindEvents();
  syncTabs();

  // 先渲染完整骨架，后端未启动也能看到界面与引导文案
  renderHealth();
  renderTripSelect();
  renderBoard();
  renderBudget();
  renderFiles();
  renderRiskSummary();
  updateBudgetBadge();
  updateComposerState();

  await Promise.all([fetchHealth(), loadTrips()]);

  const params = new URLSearchParams(window.location.search);
  const wanted = params.get('trip');
  if (wanted) {
    selectTrip(wanted);
  } else if (state.trips.length) {
    selectTrip(state.trips[0].id);
  } else if (state.tripsError) {
    appendSystemNote('后端尚未连接：' + state.tripsError, el('button', {
      class: 'btn btn-tiny retry-btn',
      type: 'button',
      text: '重试',
      onclick: async function () {
        await Promise.all([fetchHealth(), loadTrips()]);
        if (state.trips.length) selectTrip(state.trips[0].id);
        else toast('仍然无法连接后端：' + (state.tripsError || '未知错误'), 'error');
      },
    }));
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
