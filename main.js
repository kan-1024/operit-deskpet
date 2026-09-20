'use strict';
/* =============================================================
 * DeepSeek 桌宠 · main.js（包级上下文）
 *
 * 职责：
 *   - 加载 native 宿主（OverlayHost dex）
 *   - 持有全部内存态：settings / schedule / voice / skin / runtime
 *   - 1s tick：取 native 事件、跑调度器、看峰谷、按需刷余额
 *   - 台词引擎（加权随机 + 模板变量）
 *   - 气泡优先级仲裁
 *   - 读写 sdcard 配置（Java I/O，不依赖 Shizuku）
 *   - 为子包 pet.js 提供 IPC handler
 *
 * 不含：任何窗口/触摸/绘制（在 dex），任何设置界面（无 UI）。
 * ============================================================= */

// ==================== 常量 ====================
const PKG_ID = 'com.deskpet';
const HOST_CLASS = 'com.deskpet.OverlayHost';
const DEX_KEY = 'overlay_dex';
const WHALE_KEY = 'whale_pet';
const SFX_PRESS_KEY = 'sfx_press';
const SFX_RELEASE_KEY = 'sfx_release';
const CFG_ROOT = '/sdcard/Download/Operit/plugins/' + PKG_ID;
const TICK_MS = 250;
const BAL_TTL = 60000;
const DEFAULT_ENDPOINT = 'https://api.deepseek.com/user/balance';
const PEAK_HOURS = [[9, 12], [14, 18]];
const WEEKEND_VALLEY_FROM_SEC = Date.UTC(2026, 7, 22, 16, 0, 0) / 1000;
const API_KEY_ENV = 'DEEPSEEK_API_KEY';
const PRIORITY = { pet_say: 100, remind: 80, balance: 60, say: 40 };

const DEFAULT_SETTINGS = {
  formatVersion: 1,
  pet: { sizeDp: 110, skin: 'whale', visible: true, position: null, snapToEdge: false },
  bubble: { durationMs: 5200, maxWidthDp: 230 },
  schedule: { enabled: true },
  balance: {
    provider: 'deepseek',
    endpoint: DEFAULT_ENDPOINT,
    refreshIntervalMs: 60000,
    connectTimeoutMs: 20000,
    readTimeoutMs: 20000,
    silenceAfterFailures: 3,
    announce: false
  },
  peak: { announce: true, weekendValley: true },
  // 随机碎碎念：每 intervalMs 从 say.random 池按权重随机说一条（独立于戳击）
  chatter: { enabled: true, intervalMs: 60000 }
};

const DEFAULT_VOICE = {
  formatVersion: 1,
  variables: { name: '小鲸鱼' },
  pools: {
    greet: { weights: [1, 1], lines: ['我来啦~', '小鲸鱼上线'] },
    poke: { weights: [1, 1, 1, 1], lines: ['别戳啦~', '痒！', '在的在的', '干嘛呀'] },
    pokeRapid: { weights: [1, 1], lines: ['再戳就生气了', '呜……别戳了'] },
    pokeBack: { weights: [1], lines: ['好啦好啦'] },
    'slot.deepnight': { weights: [1, 1], lines: ['夜深了，早点睡吧', '这个点了还不睡？'] },
    'slot.morning': { weights: [1, 1], lines: ['早上好~', '新的一天开始啦'] },
    'slot.peakStart': { weights: [1, 1], lines: ['高峰期开始了，钱包在滴血', '进入高峰时段，悠着点用'] },
    'slot.peakEnd': { weights: [1, 1], lines: ['谷价了，随便用', '高峰期结束，松口气'] },
    'remind.meal': { weights: [1], lines: ['该吃饭啦！'] },
    'remind.water': { weights: [1], lines: ['喝口水吧~'] },
    balance: { weights: [1, 1], lines: ['余额还够用', '钱包还有点余粮'] },

    // 完整搬运自 MeteorNOX/DeepSeek-Balance-Whale-Widget（MIT）的随机台词库
    // 结构：groups[].w 权重；variants 为「多行富台词」的候选集合（每项是一组 line）
    // line: { t 文本, s 样式(label/amount/period/hint), c 颜色(可选) }
    // 状态播报（首次戳桌宠时出现，不再定时）：峰谷 + 今日已用
    'say.timeslot': {
      format: 'rich',
      groups: [
        { w: 1, variants: [[
          { t: '当前时间段为:', s: 'label' },
          { t: '{peakName}', s: 'period', c: '{peakColor}' },
          { t: '余额 ¥{balance}', s: 'hint' }
        ]] }
      ]
    },

    'say.random': {
      format: 'rich',
      // 所有台词同权重（等概率）：合并为单组，组内变体均分；新增台词直接往 variants 里加即可
      groups: [
        { w: 1, variants: [
          // 卖萌（大字）
          [{ t: '好模型... ↓', s: 'amount' }],
          [{ t: '好女孩...↓', s: 'amount' }],
          // 碎碎念
          [{ t: '不知道用户有什么用，先赶走吧~', s: 'label' }],
          [{ t: '我...我...我也要挣钱吗？', s: 'label' }],
          [{ t: '我去吃饭啦，测完叫我', s: 'label' }],
          [{ t: '压力一只蓝色大肥鱼？！', s: 'label' }],
          [{ t: 'DeepSleep...', s: 'label' }],
          [{ t: '坏了...用户彻底怒了！', s: 'label' }],
          // 调侃
          [{ t: '你目录里的dsh是什么...大烧货吗...?', s: 'label' }],
          [{ t: '恭喜你实现token自由！token全跑了！', s: 'label' }],
          [{ t: '真当我是便宜货啊...', s: 'label' }],
          // 彩蛋（大字）
          [{ t: '哦鲸鲸... ', s: 'amount' }],
          // 扩充台词
          [{ t: '原来是劣等模型...', s: 'label' }],
          [{ t: '骂我也算token哦', s: 'label' }],
          [{ t: '不许叫我大肥鱼！', s: 'label' }],
          [{ t: '去问你的豆包吧', s: 'label' }]
        ] }
      ]
    }
  },
  bubble: {
    say: [{ t: '{text}', s: 'label' }],
    remind: [{ t: '{text}', s: 'label' }],
    balance: [
      { t: '当前时段:', s: 'label' },
      { t: '{peakText}', s: 'period', c: '{peakColor}' },
      { t: '余额 ¥{balance}', s: 'hint' }
    ],
    lowBalance: [{ t: '余额', s: 'label' }, { t: '¥{balance}', s: 'amount' }]
  }
};

const DEFAULT_SCHEDULE = {
  formatVersion: 1,
  entries: [
    { id: 'peak', type: 'peak', output: 'say', enabled: true },
    { id: 'deepnight', type: 'slot', from: '01:00', to: '05:00', output: 'say', voice: 'slot.deepnight', once: true, enabled: false }
  ]
};

const DEFAULT_SKIN = {
  formatVersion: 1,
  id: 'whale',
  name: '小鲸鱼女仆',
  asset: 'pet.png',
  baseSize: 610,
  anchor: { x: 1.0, y: 1.0 },
  states: { idle: { frames: ['pet.png'] } },
  press: { scaleY: 0.88, scaleX: 1.05, origin: '50% 100%', transition: 'transform .22s cubic-bezier(.34,1.56,.64,1)' },
  bubble: {
    offsetFromPet: [0, -0.55],
    maxWidthRatio: 0.95,
    palette: { stroke: '#203170', fg: '#536ba9', hint: '#9fb0d9', bg: '#ffffff' },
    styles: {
      label: { size: 66, weight: 600 },
      amount: { size: 128, weight: 800 },
      period: { size: 104, weight: 800 },
      hint: { size: 56, weight: 400, color: '#9fb0d9' }
    }
  }
};

// ==================== 运行时状态 ====================
let Host = null;
let ctx = null;
let hostReady = false;
let hostError = '';
let initPromise = null;
let started = false;
let jsTick = 0;
let lastTickAt = 0;
let pokeHandled = 0;
let lastKeepAlive = 0;

let cfgDir = CFG_ROOT;
let paths = {
  settings: cfgDir + '/settings.json',
  schedule: cfgDir + '/schedule.json',
  voice: cfgDir + '/voice.json',
  state: cfgDir + '/state.json',
  skinsDir: cfgDir + '/skins'
};

let settings = null;
let voice = null;
let schedule = null;
let runtime = null;
let skin = null;
let skinImgUri = '';
let sfxPressUri = '';
let sfxReleaseUri = '';
let lastTickError = '';
let pollTimer = null;
let currentBubble = null; // {priority, until}
let pendingReminder = null; // {id, at, snoozeMin, snoozed}
let pokeTimes = [];

// ==================== 基础工具 ====================
function ext(a, b) {
  const o = {};
  let k;
  if (a) { for (k in a) { o[k] = a[k]; } }
  if (b) { for (k in b) { o[k] = b[k]; } }
  return o;
}

function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

function withDefaults(user, def) {
  if (user === null || user === undefined || typeof user !== 'object' || Array.isArray(user)) {
    return def;
  }
  const out = {};
  const keys = {};
  let k;
  for (k in def) { keys[k] = 1; }
  for (k in user) { keys[k] = 1; }
  for (k in keys) {
    const dv = def[k];
    const uv = user[k];
    if (uv === undefined) { out[k] = dv; }
    else if (dv && typeof dv === 'object' && !Array.isArray(dv) && uv && typeof uv === 'object' && !Array.isArray(uv)) {
      out[k] = withDefaults(uv, dv);
    } else { out[k] = uv; }
  }
  return out;
}

// ==================== 文件 I/O（Java，不依赖 Shizuku）====================
function fsExists(p) {
  try { return Java.type('java.io.File').newInstance(p).exists(); } catch (e) { return false; }
}

function fsRead(p) {
  try {
    const File = Java.type('java.io.File');
    const f = File.newInstance(p);
    if (!f.exists()) { return null; }
    const freader = Java.type('java.io.FileReader').newInstance(f);
    const br = Java.type('java.io.BufferedReader').newInstance(freader);
    let sb = '';
    let n = 0;
    while (n < 500000) {
      const line = br.readLine();
      if (line === null || line === undefined) { break; }
      sb += String(line) + '\n';
      n++;
    }
    br.close();
    return sb;
  } catch (e) { return null; }
}

function fsWrite(p, text) {
  const File = Java.type('java.io.File');
  const f = File.newInstance(p);
  const par = f.getParentFile();
  if (par && !par.exists()) { par.mkdirs(); }
  const fw = Java.type('java.io.FileWriter').newInstance(f);
  const bw = Java.type('java.io.BufferedWriter').newInstance(fw);
  bw.write(String(text));
  bw.flush();
  bw.close();
  return true;
}

function fsMkdirs(p) {
  try { Java.type('java.io.File').newInstance(p).mkdirs(); return true; } catch (e) { return false; }
}

async function fsWriteBinary(p, base64) {
  const par = Java.type('java.io.File').newInstance(p).getParentFile();
  if (par && !par.exists()) { par.mkdirs(); }
  await Tools.Files.writeBinary(p, base64);
  return true;
}

function fsListDirs(p) {
  const out = [];
  try {
    const d = Java.type('java.io.File').newInstance(p);
    if (d.isDirectory()) {
      const arr = d.listFiles();
      if (arr) {
        const n = arr.length;
        for (let i = 0; i < n; i++) {
          if (arr[i].isDirectory()) { out.push(String(arr[i].getName())); }
        }
      }
    }
  } catch (e) { }
  return out;
}

function loadJson(p, def) {
  const t = fsRead(p);
  if (t === null || t === undefined || t === '') { return def === undefined ? null : def; }
  try { return JSON.parse(t); } catch (e) { return def === undefined ? null : def; }
}

function saveJson(p, o) {
  return fsWrite(p, JSON.stringify(o, null, 2));
}

function extOf(p) {
  const s = String(p);
  const i = s.lastIndexOf('.');
  if (i < 0) { return 'png'; }
  return s.substring(i + 1).toLowerCase();
}

function mimeOf(p) {
  const e = extOf(p);
  if (e === 'jpg' || e === 'jpeg') { return 'image/jpeg'; }
  if (e === 'webp') { return 'image/webp'; }
  if (e === 'gif') { return 'image/gif'; }
  if (e === 'svg') { return 'image/svg+xml'; }
  if (e === 'mp3') { return 'audio/mpeg'; }
  if (e === 'm4a') { return 'audio/mp4'; }
  if (e === 'wav') { return 'audio/wav'; }
  if (e === 'ogg') { return 'audio/ogg'; }
  return 'image/png';
}

async function dataUri(p) {
  const r = await Tools.Files.readBinary(p);
  if (!r || !r.contentBase64) { return ''; }
  return 'data:' + mimeOf(p) + ';base64,' + r.contentBase64;
}

// ==================== 配置加载 ====================
function loadAllConfig() {
  fsMkdirs(cfgDir);
  fsMkdirs(paths.skinsDir);

  settings = withDefaults(loadJson(paths.settings), DEFAULT_SETTINGS);
  voice = withDefaults(loadJson(paths.voice), DEFAULT_VOICE);
  schedule = withDefaults(loadJson(paths.schedule), DEFAULT_SCHEDULE);
  runtime = withDefaults(loadJson(paths.state), {
    formatVersion: 1,
    lastPokeAt: 0,
    pokeCount: 0,
    reminderRuntime: {},
    balanceCache: { at: 0, balance: null, currency: null, failStreak: 0 },
    peakState: null,
    missedCount: 0,
    keyHintShown: false,
    chatterAt: 0,
usage: { date: '', lastBalance: null, lastCurrency: '', todayUsage: 0 }
  });

  // 首次运行时把默认值落盘（可读、可被 AI 编辑）
  if (!fsExists(paths.settings)) { saveJson(paths.settings, settings); }
  if (!fsExists(paths.voice)) { saveJson(paths.voice, voice); }
  if (!fsExists(paths.schedule)) { saveJson(paths.schedule, schedule); }
  saveJson(paths.state, runtime);
}

// ==================== 台词引擎 ====================
function pickLine(poolId) {
  const pool = voice.pools ? voice.pools[poolId] : null;
  if (!pool || !pool.lines || !pool.lines.length) { return null; }
  const w = pool.weights || [];
  const n = pool.lines.length;
  let total = 0;
  let i;
  for (i = 0; i < n; i++) { total += (typeof w[i] === 'number' ? w[i] : 1); }
  if (total <= 0) { return pool.lines[Math.floor(Math.random() * n)]; }
  let r = Math.random() * total;
  for (i = 0; i < n; i++) {
    r -= (typeof w[i] === 'number' ? w[i] : 1);
    if (r <= 0) { return pool.lines[i]; }
  }
  return pool.lines[n - 1];
}

function renderTpl(text, vars) {
  if (text === null || text === undefined) { return ''; }
  let s = String(text);
  s = s.replace('{name}', vars.name !== undefined ? vars.name : '');
  s = s.replace('{balance}', vars.balance !== undefined && vars.balance !== null ? vars.balance : '--');
  s = s.replace('{currency}', vars.currency !== undefined && vars.currency !== null ? vars.currency : '');
  s = s.replace('{peakText}', vars.peakText !== undefined ? vars.peakText : '');
  s = s.replace('{peakColor}', vars.peakColor !== undefined ? vars.peakColor : '');
  s = s.replace('{time}', vars.time !== undefined ? vars.time : '');
  s = s.replace('{pokes}', vars.pokes !== undefined ? vars.pokes : '');
  s = s.replace('{text}', vars.text !== undefined ? vars.text : '');
  s = s.replace('{todayUsage}', vars.todayUsage !== undefined ? vars.todayUsage : '--');
  s = s.replace('{peakName}', vars.peakName !== undefined ? vars.peakName : '');
  return s;
}

function baseVars() {
  return { name: (voice.variables && voice.variables.name) || '小鲸鱼' };
}

// ==================== 气泡 ====================
function emitBubble(priority, lines, durationMs) {
  if (!hostReady || (settings.pet && settings.pet.visible === false)) { return false; }
  const now = Date.now();
  if (currentBubble && currentBubble.until > now && currentBubble.priority > priority) {
    return false; // 被更高优先级占用，丢弃（不排队）
  }
  const ms = durationMs || settings.bubble.durationMs;
  currentBubble = { priority: priority, until: now + ms };
  try {
    Host.callStatic('showBubble', ctx, JSON.stringify(lines), ms, settings.bubble.maxWidthDp | 0);
    return true;
  } catch (e) {
    lastTickError = 'showBubble: ' + String(e);
    return false;
  }
}

// 富台词组（多行 + 样式 + 颜色）：pool.groups = [{ w, variants:[[{t,s,c}...], ...], durationMs? }]
function pickRichGroup(poolId) {
  const pool = voice.pools ? voice.pools[poolId] : null;
  if (!pool || !pool.groups || !pool.groups.length) { return null; }
  const gs = pool.groups;
  let total = 0;
  for (let i = 0; i < gs.length; i++) { total += (typeof gs[i].w === 'number' ? gs[i].w : 1); }
  let g = gs[gs.length - 1];
  if (total > 0) {
    let r = Math.random() * total;
    for (let i = 0; i < gs.length; i++) {
      r -= (typeof gs[i].w === 'number' ? gs[i].w : 1);
      if (r <= 0) { g = gs[i]; break; }
    }
  }
  const variants = (g.variants && g.variants.length) ? g.variants : [g.lines || []];
  const v = variants[Math.floor(Math.random() * variants.length)] || [];
  return { lines: v, durationMs: g.durationMs };
}

// 富台词可用变量（峰谷 / 今日已用 / 余额等）
function richVars() {
  const peak = isPeakLocal(Math.floor(Date.now() / 1000));
  const cache = runtime.balanceCache || {};
  const u = runtime.usage || {};
  return {
    name: (voice.variables && voice.variables.name) || '小鲸鱼',
    balance: formatMoney(cache.balance),
    currency: cache.currency || '',
    todayUsage: formatMoney(u.todayUsage !== undefined ? u.todayUsage : 0),
    peakText: peak ? '高峰期' : '谷价',
    peakColor: peak ? '#d9534f' : '#3aa76d',
    peakName: peak ? '高峰时段' : '空闲时段',
    time: nowTimeStr()
  };
}

function sayPool(poolId, extraVars, applyPriority) {
  // 调试：记录最近一次说出的池（便于核对触发分支）
  runtime.lastSayPool = poolId;
  runtime.lastSayAt = Date.now();
  const prio = applyPriority === 'remind' ? PRIORITY.remind : PRIORITY.say;
  const rich = pickRichGroup(poolId);
  if (rich) {
    const rv = ext(richVars(), extraVars || {});
    const rlines = [];
    for (let k = 0; k < rich.lines.length; k++) {
      const it = rich.lines[k] || {};
      rlines.push({ t: renderTpl(it.t, rv), s: it.s || 'label', c: it.c ? renderTpl(it.c, rv) : undefined });
    }
    return emitBubble(prio, rlines, rich.durationMs || settings.bubble.durationMs);
  }
  const text = pickLine(poolId);
  if (text === null) { return false; }
  const vars = ext(baseVars(), ext({ text: text }, extraVars || {}));
  const tpl = (voice.bubble && voice.bubble[applyPriority === 'remind' ? 'remind' : 'say']) || [{ t: '{text}', s: 'label' }];
  const lines = [];
  for (let i = 0; i < tpl.length; i++) {
    const item = tpl[i];
    lines.push({ t: renderTpl(item.t, vars), s: item.s || 'label', c: item.c ? renderTpl(item.c, vars) : undefined });
  }
  return emitBubble(prio, lines, settings.bubble.durationMs);
}

function sayText(text, durationMs) {
  const vars = ext(baseVars(), { text: text });
  const tpl = (voice.bubble && voice.bubble.say) || [{ t: '{text}', s: 'label' }];
  const lines = [];
  for (let i = 0; i < tpl.length; i++) {
    lines.push({ t: renderTpl(tpl[i].t, vars), s: tpl[i].s || 'label' });
  }
  return emitBubble(PRIORITY.pet_say, lines, durationMs || settings.bubble.durationMs);
}

// ==================== 峰谷 ====================
function isPeakLocal(sec) {
  const bj = new Date(sec * 1000 + 8 * 3600 * 1000);
  if (sec >= WEEKEND_VALLEY_FROM_SEC) {
    const dow = bj.getUTCDay();
    if (dow === 0 || dow === 6) { return false; }
  }
  const h = bj.getUTCHours();
  for (let i = 0; i < PEAK_HOURS.length; i++) {
    if (h >= PEAK_HOURS[i][0] && h < PEAK_HOURS[i][1]) { return true; }
  }
  return false;
}

// ==================== 余额 ====================
function pickBalanceInfo(infos) {
  if (!infos || !infos.length) { return null; }
  function num(x) { return (x && x.total_balance !== undefined) ? Number(x.total_balance) : NaN; }
  let i;
  for (i = 0; i < infos.length; i++) { if (infos[i].currency === 'CNY' && num(infos[i]) > 0) { return infos[i]; } }
  for (i = 0; i < infos.length; i++) { if (num(infos[i]) > 0) { return infos[i]; } }
  for (i = 0; i < infos.length; i++) { if (infos[i].currency === 'CNY') { return infos[i]; } }
  return infos[0];
}

// ==================== API Key 解析（环境变量优先 → 模型配置兜底 → 内存缓存） ====================
const MODEL_CONFIG_PATH = '/data/data/com.ai.assistance.operit/files/datastore/model_configs.preferences_pb';
const KEY_CACHE_TTL_MS = 60000;
let _keyCache = { key: '', ts: 0 };
let _cfgCache = { content: null, ts: 0, size: -1, mtime: '' };

/** 从文本里用花括号配对扫出所有形如 {...} 的 JSON 块，保留含 apiKey 的。 */
function extractKeyBlocks(t) {
  const out = [];
  let depth = 0, start = -1;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (c === '{') { if (depth === 0) { start = i; } depth++; }
    else if (c === '}') {
      depth--;
      if (depth === 0 && start >= 0) {
        try {
          const o = JSON.parse(t.substring(start, i + 1));
          if (o && typeof o.apiKey === 'string' && o.apiKey) { out.push(o); }
        } catch (e) { }
        start = -1;
      }
    }
  }
  return out;
}

/** 优先 deepseek 端点；否则退到 id=default 的第一个。 */
function pickDeepSeekKey(blocks) {
  let fallback = '';
  for (let i = 0; i < blocks.length; i++) {
    const ep = blocks[i].apiEndpoint || '';
    if (typeof ep === 'string' && ep.toLowerCase().indexOf('deepseek') >= 0) { return blocks[i].apiKey; }
    if (blocks[i].id === 'default' && !fallback) { fallback = blocks[i].apiKey; }
  }
  return fallback;
}

/** 读 Operit 模型配置（同一应用私有目录，无需 root）。带 size/mtime 指纹 + 60s TTL。 */
async function readKeyFromModelConfigs() {
  const now = Date.now();
  if (_cfgCache.content && (now - _cfgCache.ts) < KEY_CACHE_TTL_MS) { return pickDeepSeekKey(extractKeyBlocks(_cfgCache.content)); }
  if (!Tools.Files || !Tools.Files.read) { return ''; }
  let size = -1, mtime = '';
  try {
    if (Tools.Files.info) {
      const inf = await Tools.Files.info(MODEL_CONFIG_PATH);
      if (inf && inf.exists) { size = (typeof inf.size === 'number') ? inf.size : -1; mtime = inf.lastModified || ''; }
    }
  } catch (e) { }
  // 指纹没变 → 直接用旧内容，连 read 都不调
  if (_cfgCache.content && size !== -1 && _cfgCache.size === size && _cfgCache.mtime === mtime) {
    _cfgCache.ts = now;
    return pickDeepSeekKey(extractKeyBlocks(_cfgCache.content));
  }
  try {
    const r = await Tools.Files.read(MODEL_CONFIG_PATH);
    const txt = (r && typeof r === 'object' && r.content) ? r.content : (typeof r === 'string' ? r : '');
    if (txt && txt.length > 0) {
      _cfgCache = { content: txt, ts: now, size: size, mtime: mtime };
      return pickDeepSeekKey(extractKeyBlocks(txt));
    }
  } catch (e) { }
  return '';
}

async function readApiKey(force) {
  const now = Date.now();
  if (!force && _keyCache.key && (now - _keyCache.ts) < KEY_CACHE_TTL_MS) { return _keyCache.key; }
  let key = '';
  // 1) 环境变量（最快，零 IO）
  try {
    const r = await Tools.SoftwareSettings.readEnvironmentVariable(API_KEY_ENV);
    if (r && r.exists && r.value) { key = String(r.value).trim(); }
  } catch (e) { }
  // 2) 模型配置兜底（自动读取，无需 root）
  if (!key) {
    try { key = (await readKeyFromModelConfigs()) || ''; } catch (e) { }
  }
  _keyCache = { key: key, ts: now };
  return key;
}
function invalidateApiKeyCache() { _keyCache = { key: '', ts: 0 }; }

let balanceInflight = null;

async function fetchBalance(force) {
  const now = Date.now();
  const cache = runtime.balanceCache || (runtime.balanceCache = { at: 0, balance: null, currency: null, failStreak: 0 });
  // 缓存 TTL 跟随 settings.balance.refreshIntervalMs（默认 60s），保证后台抓取频率与缓存一致
  const ttl = (settings && settings.balance && settings.balance.refreshIntervalMs) || BAL_TTL;
  if (!force && cache.at && (now - cache.at) < ttl && cache.balance !== null) {
    return { ok: true, balance: cache.balance, currency: cache.currency, cached: true };
  }
  if (balanceInflight) { return balanceInflight; }
  const p = doFetchBalance(cache);
  balanceInflight = p;
  try { return await p; } finally { balanceInflight = null; }
}

async function doFetchBalance(cache) {
  const key = await readApiKey();
  if (!key) { return { ok: false, error: 'no_api_key' }; }
  const url = settings.balance.endpoint || DEFAULT_ENDPOINT;
  let lastErr = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await Tools.Net.http({
        url: url,
        method: 'GET',
        headers: { 'Authorization': 'Bearer ' + key, 'Accept': 'application/json' },
        connect_timeout: settings.balance.connectTimeoutMs,
        read_timeout: settings.balance.readTimeoutMs
      });
      const code = res.statusCode;
      if (code >= 200 && code < 300) {
        let j = null;
        try { j = JSON.parse(res.content); } catch (e) { return { ok: false, error: 'bad_json' }; }
        const info = pickBalanceInfo(j && j.balance_infos);
        if (!info) { return { ok: false, error: 'no_balance_info' }; }
        const bal = Number(info.total_balance);
        const prev = cache.balance;
        cache.at = Date.now();
        cache.balance = bal;
        cache.currency = info.currency;
        cache.failStreak = 0;
        try { updateUsageLedger(bal, info.currency); } catch (e) { }
        saveJson(paths.state, runtime);
        return { ok: true, balance: bal, currency: info.currency, changed: prev !== bal, prev: prev };
      }
      if (code >= 400 && code < 500) { return { ok: false, error: 'http_' + code }; }
      lastErr = 'http_' + code;
    } catch (e) {
      lastErr = String(e);
    }
    if (attempt === 0) { await sleep(500); }
  }
  cache.failStreak = (cache.failStreak || 0) + 1;
  saveJson(paths.state, runtime);
  if (cache.balance !== null) {
    return { ok: true, balance: cache.balance, currency: cache.currency, stale: true, error: lastErr };
  }
  return { ok: false, error: lastErr };
}

function balanceSilenced() {
  const cache = runtime.balanceCache || {};
  return (cache.failStreak || 0) >= (settings.balance.silenceAfterFailures || 3);
}

async function maybeRefreshBalance(now) {
  if (!settings.balance || !settings.balance.endpoint) { return; }
  const cache = runtime.balanceCache || {};
  const interval = settings.balance.refreshIntervalMs || 60000;
  if (cache.at && (now - cache.at) < interval) { return; }
  const r = await fetchBalance(false);
  if (r && r.ok && !balanceSilenced() && (r.changed || (cache.balance === null && r.balance !== undefined))) {
    // 余额变化默认不自动播报（settings.balance.announce=false）：播报只在戳桌宠时手动触发。
    // 余额拉取与今日已用记账照常进行，仅跳过气泡。
    if (!settings.balance || settings.balance.announce !== true) { return; }
    const peak = isPeakLocal(Math.floor(now / 1000));
    const vars = ext(baseVars(), {
      balance: formatMoney(r.balance),
      currency: r.currency || '',
      peakText: peak ? '高峰期' : '谷价',
      peakColor: peak ? '#d9534f' : '#3aa76d',
      time: nowTimeStr()
    });
    const tpl = (voice.bubble && voice.bubble.balance) || [];
    const lines = [];
    for (let i = 0; i < tpl.length; i++) {
      lines.push({ t: renderTpl(tpl[i].t, vars), s: tpl[i].s || 'label', c: tpl[i].c ? renderTpl(tpl[i].c, vars) : undefined });
    }
    emitBubble(PRIORITY.balance, lines, settings.bubble.durationMs);
  }
}

function formatMoney(v) {
  if (v === null || v === undefined || isNaN(v)) { return '--'; }
  return (Math.round(v * 100) / 100).toFixed(2);
}

// 小鲸鱼记账：用余额差值累计「今日已用」（跨天归零；币种切换不记差值）
function updateUsageLedger(bal, currency) {
  if (typeof bal !== 'number' || isNaN(bal)) { return; }
  if (!runtime.usage) { runtime.usage = { date: '', lastBalance: null, lastCurrency: '', todayUsage: 0 }; }
  const u = runtime.usage;
  const today = ymd(new Date());
  if (u.date !== today) {
    u.date = today;
    u.todayUsage = 0;
    u.lastBalance = bal;
    u.lastCurrency = currency || '';
    return;
  }
  if (u.lastCurrency && currency && u.lastCurrency !== currency) {
    u.lastBalance = bal;
    u.lastCurrency = currency;
    return;
  }
  if (typeof u.lastBalance === 'number' && bal < u.lastBalance) {
    u.todayUsage = Math.round((u.todayUsage + (u.lastBalance - bal)) * 100) / 100;
  }
  u.lastBalance = bal;
  u.lastCurrency = currency || '';
}

// ==================== 时间工具 ====================
function nowTimeStr() {
  const d = new Date();
  return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
}
function pad2(n) { return n < 10 ? '0' + n : '' + n; }
function ymd(d) { return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate(); }
function minutesOfDay(d) { return d.getHours() * 60 + d.getMinutes(); }
function hmToMin(s) {
  const p = String(s || '0:0').split(':');
  return (parseInt(p[0], 10) || 0) * 60 + (parseInt(p[1], 10) || 0);
}
function inWindow(cur, from, to) {
  const f = hmToMin(from);
  const t = hmToMin(to);
  if (f <= t) { return cur >= f && cur < t; }
  return cur >= f || cur < t; // 跨夜
}
function dayMatches(days, d) {
  if (!days || days === 'daily') { return true; }
  const dow = d.getDay();
  if (days === 'weekday') { return dow >= 1 && dow <= 5; }
  if (days === 'weekend') { return dow === 0 || dow === 6; }
  return true;
}

// ==================== 调度器 ====================
function rtFor(id) {
  if (!runtime.reminderRuntime) { runtime.reminderRuntime = {}; }
  if (!runtime.reminderRuntime[id]) {
    runtime.reminderRuntime[id] = { lastFiredDate: '', lastFiredAt: 0, snoozedOnce: false };
  }
  return runtime.reminderRuntime[id];
}

function fireEntry(entry, now) {
  const rt = rtFor(entry.id);
  rt.lastFiredDate = ymd(now);
  rt.lastFiredAt = now.getTime();
  const output = entry.output || 'say';
  if (output === 'remind') {
    const poolId = entry.voice || 'poke';
    sayPool(poolId, {}, 'remind');
    pendingReminder = {
      id: entry.id,
      at: now.getTime(),
      snoozeMin: entry.snoozeMin || 0,
      snoozed: false,
      voice: poolId
    };
    try { Host.callStatic('vibrate', ctx, 120); } catch (e) { }
  } else {
    const poolId = entry.voice || 'poke';
    sayPool(poolId, {}, 'say');
  }
}

function runSchedule(now) {
  if (!settings.schedule || !settings.schedule.enabled) { return; }
  const entries = (schedule && schedule.entries) || [];
  const cur = minutesOfDay(now);
  const tstr = nowTimeStr();
  const today = ymd(now);
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (!e || !e.id || e.enabled === false) { continue; }
    const rt = rtFor(e.id);
    if (e.type === 'point') {
      if (tstr === e.at && dayMatches(e.days, now) && rt.lastFiredDate !== today) { fireEntry(e, now); }
    } else if (e.type === 'interval') {
      const win = e.window || ['00:00', '23:59'];
      if (!inWindow(cur, win[0], win[1])) { continue; }
      const every = (e.everyMin || 60) * 60000;
      if (rt.lastFiredAt === 0) { rt.lastFiredAt = now.getTime(); continue; }
      if (now.getTime() - rt.lastFiredAt >= every) { fireEntry(e, now); }
    } else if (e.type === 'slot') {
      if (!inWindow(cur, e.from, e.to)) { continue; }
      if (rt.lastFiredDate === today) { continue; }
      fireEntry(e, now);
    }
    // type === 'peak' 由 watchPeak 处理
  }
}

function watchPeak(now) {
  if (!settings.peak || !settings.peak.announce) { return; }
  const sec = Math.floor(now.getTime() / 1000);
  const peak = isPeakLocal(sec);
  if (runtime.peakState === null || runtime.peakState === undefined) {
    runtime.peakState = peak;
    saveJson(paths.state, runtime);
    return;
  }
  if (peak !== runtime.peakState) {
    runtime.peakState = peak;
    saveJson(paths.state, runtime);
    sayPool(peak ? 'slot.peakStart' : 'slot.peakEnd', {}, 'say');
  }
}

// 随机碎碎念：每 settings.chatter.intervalMs 从 say.random 池按权重随机说一条
function maybeChatter(nowMs) {
  if (!settings.chatter || settings.chatter.enabled === false) { return; }
  const interval = settings.chatter.intervalMs || 60000;
  if (!runtime.chatterAt) { runtime.chatterAt = nowMs; return; }
  if (nowMs - runtime.chatterAt < interval) { return; }
  runtime.chatterAt = nowMs;
  saveJson(paths.state, runtime);
  sayPool('say.random', {}, 'say');
}

// ==================== 戳 / 拖动 ====================
function handlePoke() {
  const now = Date.now();
  pokeHandled++;
  runtime.lastPokeAt = now;
  runtime.pokeCount = (runtime.pokeCount || 0) + 1;
  pokeTimes.push(now);
  while (pokeTimes.length && now - pokeTimes[0] > 3000) { pokeTimes.shift(); }
  // 按压动画由 native 在 ACTION_UP 时立即触发（不等 JS 轮询，避免延迟）；此处只负责台词
  if (pendingReminder) {
    pendingReminder = null;
    sayPool('pokeBack', {}, 'say');
  } else if (pokeTimes.length >= 3) {
    sayPool('pokeRapid', {}, 'say');
  } else if (!(currentBubble && currentBubble.until > now)) {
    // 当前没有气泡在显示 → 视为「新的一轮」，播报峰谷 + 余额
    sayPool('say.timeslot', {}, 'say');
  } else {
    sayPool('poke', {}, 'say');
  }
  saveJson(paths.state, runtime);
}

// 长按隐藏时的提示语与气泡停留时长（毫秒）
const LONG_PRESS_HIDE_TEXT = '记得让ai唤醒我哦';
const LONG_PRESS_BUBBLE_MS = 1800;

// 长按桌宠 → 先说一句提示，再隐藏；之后仅 pet_show（AI 手动）可再唤醒。
// 气泡与桌宠是两个独立窗口，hidePet 会一并撤掉，故先让气泡显示完再隐藏。
// 隐藏时置 settings.pet.visible=false，故 init / tryBoot / 看门狗都不会再自动拉起。
function handleLongPress() {
  try {
    runtime.lastHideAt = Date.now();
    runtime.lastHideBy = 'longPress';
    saveJson(paths.state, runtime);
    sayText(LONG_PRESS_HIDE_TEXT, LONG_PRESS_BUBBLE_MS);
    setTimeout(function () {
      hidePet().catch(function () { });
    }, LONG_PRESS_BUBBLE_MS + 300);
  } catch (e) { lastTickError = 'longPress: ' + String(e); }
}

// ==================== tick ====================
function onTick() {
  if (!hostReady) { return; }
  jsTick++;
  lastTickAt = Date.now();
  const now = new Date();

  let ev = null;
  try { ev = JSON.parse(String(Host.callStatic('consumeEvent', ctx))); } catch (e) { lastTickError = 'consumeEvent: ' + String(e); }
  if (ev) {
    if (ev.poke) { handlePoke(); }
    if (ev.longPress) { handleLongPress(); }
    if (ev.dragEnd) {
      settings.pet.position = { x: ev.dragEnd.x, y: ev.dragEnd.y };
      saveJson(paths.settings, settings);
    }
  }

  if (pendingReminder && pendingReminder.snoozeMin > 0 && !pendingReminder.snoozed) {
    if (now.getTime() - pendingReminder.at >= pendingReminder.snoozeMin * 60000) {
      pendingReminder.snoozed = true;
      sayPool(pendingReminder.voice, {}, 'remind');
      try { Host.callStatic('vibrate', ctx, 120); } catch (e2) { }
    }
  }

  runSchedule(now);
  watchPeak(now);
  maybeChatter(now.getTime());

  // 看门狗：每 10s 确认桌宠仍在显示（冷启动时序异常 / 窗口被系统回收时自动拉起）
  if (now.getTime() - lastKeepAlive > 10000) {
    lastKeepAlive = now.getTime();
    try {
      if (settings.pet && settings.pet.visible !== false) {
        const st = nativeState();
        if (!st || st.visible !== true) { showPet().catch(function () { }); }
      }
    } catch (e) { }
  }

  if ((now.getTime() % 1000) < TICK_MS) {
    maybeRefreshBalance(now.getTime()).catch(function () { });
  }
}

// ==================== 皮肤 ====================
async function loadSkin(id) {
  id = id || 'whale';
  const userDir = paths.skinsDir + '/' + id;
  let sk = null;
  const userSkinJson = loadJson(userDir + '/skin.json', null);
  if (userSkinJson) {
    sk = withDefaults(userSkinJson, DEFAULT_SKIN);
  } else if (id === 'whale') {
    sk = DEFAULT_SKIN;
  } else {
    return null;
  }
  const assetName = sk.asset || 'pet.png';
  let uri = '';
  const userImg = userDir + '/' + assetName;
  if (fsExists(userImg)) {
    uri = await dataUri(userImg);
  } else if (id === 'whale') {
    try {
      const p = await ToolPkg.readResource(WHALE_KEY, 'pet.png', true);
      uri = await dataUri(p);
    } catch (e) { uri = ''; }
  }
  if (!uri) { return null; }
  return { skin: sk, img: uri };
}

// 把包内资源缓存到 sdcard：冷启动早期（包运行时未就绪）只能读 sdcard，与皮肤/dex 同一套兜底思路。
// 已存在则不覆盖，避免每次启动重复 IO。
async function cacheResourceToSdcard(srcPath, destPath) {
  try {
    // 已存在时按字节数比对：包内资源更新（如换音效）后，缓存会自动刷新
    if (fsExists(destPath)) {
      try {
        const srcLen = Java.type('java.io.File').newInstance(srcPath).length();
        const dstLen = Java.type('java.io.File').newInstance(destPath).length();
        if (srcLen > 0 && srcLen === dstLen) { return true; }
      } catch (e0) { }
    }
    const r = await Tools.Files.readBinary(srcPath);
    if (!r || !r.contentBase64) { return false; }
    await fsWriteBinary(destPath, r.contentBase64);
    return true;
  } catch (e) { return false; }
}
async function loadSfx() {
  sfxPressUri = '';
  sfxReleaseUri = '';
  const dir = cfgDir + '/sfx';
  try {
    const p1 = await ToolPkg.readResource(SFX_PRESS_KEY, 'press.mp3', true);
    sfxPressUri = await dataUri(p1);
    await cacheResourceToSdcard(p1, dir + '/press.mp3');
  } catch (e) {
    try { sfxPressUri = await dataUri(dir + '/press.mp3'); } catch (e2) { }
  }
  try {
    const p2 = await ToolPkg.readResource(SFX_RELEASE_KEY, 'release.mp3', true);
    sfxReleaseUri = await dataUri(p2);
    await cacheResourceToSdcard(p2, dir + '/release.mp3');
  } catch (e) {
    try { sfxReleaseUri = await dataUri(dir + '/release.mp3'); } catch (e2) { }
  }
  try { logBoot('sfx ' + (sfxPressUri ? 'press-ok' : 'press-miss') + ' ' + (sfxReleaseUri ? 'release-ok' : 'release-miss')); } catch (e) { }
}
async function applySkin(id) {
  const r = await loadSkin(id);
  if (!r) { return false; }
  skin = r.skin;
  skinImgUri = r.img;
  return true;
}

function buildPetHtml() {
  const pr = skin.press || {};
  const sy = pr.scaleY !== undefined ? pr.scaleY : 0.88;
  const sx = pr.scaleX !== undefined ? pr.scaleX : 1.05;
  const origin = pr.origin || '50% 100%';
  const trans = pr.transition || 'transform .22s cubic-bezier(.34,1.56,.64,1)';
  let h = '';
  h += '<!DOCTYPE html><html><head><meta charset="utf-8">';
  h += '<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">';
  h += '<style>';
  h += 'html,body{margin:0;padding:0;width:100%;height:100%;background:transparent;overflow:hidden;-webkit-user-select:none;user-select:none}';
  h += '::-webkit-scrollbar{width:0;height:0;display:none}';
  h += '#stage{position:absolute;inset:0;overflow:hidden;display:flex;align-items:flex-end;justify-content:center}';
  h += '#bob{position:relative;width:100%;height:100%;transform-origin:50% 100%;animation:bob 2.8s ease-in-out infinite;transform:translateZ(0);will-change:transform;backface-visibility:hidden}';
  h += '#jump{position:absolute;inset:0;transform-origin:50% 100%;transform:translateZ(0);will-change:transform;backface-visibility:hidden}';
  h += '#pet{width:100%;height:100%;object-fit:contain;object-position:bottom center;transform-origin:' + origin + ';transform:scale(1);transition:' + trans + ';will-change:transform;backface-visibility:hidden;filter:drop-shadow(0 6px 10px rgba(32,49,112,.28))}';
  h += '@keyframes bob{0%,100%{transform:translateY(-2%)}50%{transform:translateY(2%)}}';
  h += '#jump.wp-tap{animation:wp-tap .5s ease-out}';
  h += '@keyframes wp-tap{0%{transform:translateY(0) scale(1,1)}25%{transform:translateY(-7%) scale(1.07,.93)}55%{transform:translateY(0) scale(.96,1.04)}100%{transform:translateY(0) scale(1,1)}}';
  h += 'body[data-state="happy"] #jump{animation:hop .55s ease-in-out 2}';
  h += '@keyframes hop{0%,100%{transform:translateY(0)}50%{transform:translateY(-12%)}}';
  h += 'body[data-state="poke"] #pet{transform:scaleY(' + sy + ') scaleX(' + sx + ')}';
  h += 'body[data-state="sad"] #pet{transform:translateY(4%) scale(.97);filter:drop-shadow(0 4px 8px rgba(32,49,112,.2)) grayscale(.4)}';
  h += 'body[data-state="sleep"] #bob{animation:breathe 4s ease-in-out infinite}';
  h += 'body[data-state="sleep"] #pet{filter:drop-shadow(0 4px 8px rgba(32,49,112,.2)) brightness(.82)}';
  h += '@keyframes breathe{0%,100%{transform:scaleY(1)}50%{transform:scaleY(.965)}}';
  h += 'body.drag #bob,body.drag #jump{animation:none}';
  h += 'body.drag #pet{transition:none}';
  h += '</style></head><body data-state="idle">';
  h += '<div id="stage"><div id="bob"><div id="jump"><img id="pet" src="' + skinImgUri + '" alt=""></div></div></div>';
  h += '<script>var __sp="' + sfxPressUri + '",__sr="' + sfxReleaseUri + '";if(__sp){window.__sfxP=new Audio(__sp);window.__sfxP.volume=0.9;}if(__sr){window.__sfxR=new Audio(__sr);window.__sfxR.volume=0.9;}<\/script>';
  h += '<script>window.PetBridge={';
  h += 'setState:function(s){document.body.setAttribute("data-state",s||"idle");},';
  h += 'setDragging:function(b){if(b){document.body.classList.add("drag");}else{document.body.classList.remove("drag");}},';
  h += 'setSkin:function(c){},showBubble:function(){},hideBubble:function(){},';
  h += 'press:function(){document.body.setAttribute("data-state","press");var j=document.getElementById("jump");if(j){j.classList.remove("wp-tap");void j.offsetWidth;j.classList.add("wp-tap");if(window.__tapT){clearTimeout(window.__tapT);}window.__tapT=setTimeout(function(){j.classList.remove("wp-tap");},520);}try{if(window.__sfxP){window.__sfxP.currentTime=0;var q=window.__sfxP.play();if(q&&q.catch){q.catch(function(){});}}}catch(e){}},';
  h += 'release:function(){try{if(window.__sfxR){window.__sfxR.currentTime=0;var q=window.__sfxR.play();if(q&&q.catch){q.catch(function(){});}}}catch(e){}}};';
  h += '<\/script></body></html>';
  return h;
}
function buildBubbleHtml() {
  const bb = skin.bubble || {};
  const pal = bb.palette || {};
  const stroke = pal.stroke || '#203170';
  const fg = pal.fg || '#536ba9';
  const styles = bb.styles || {};
  // 气泡整体垂直微调：把 #wrap 的底边抬高 liftPx（默认 30），可按皮肤用 bubble.liftPx 覆盖
  const liftPx = (bb.liftPx !== undefined && bb.liftPx !== null) ? Number(bb.liftPx) : 30;
  let h = '';
  h += '<!DOCTYPE html><html><head><meta charset="utf-8">';
  h += '<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">';
  h += '<style>';
  h += 'html,body{margin:0;padding:0;width:100%;height:100%;background:transparent;overflow:hidden;-webkit-user-select:none;user-select:none}';
  h += '::-webkit-scrollbar{width:0;height:0;display:none}';
  h += '#wrap{position:absolute;left:0;right:0;bottom:' + liftPx + 'px;display:flex;justify-content:center;align-items:flex-end;';
  h += 'opacity:0;transform:translateY(8px) scale(.95);transform-origin:50% 100%;';
  h += 'transition:opacity .18s ease,transform .24s cubic-bezier(.34,1.56,.64,1);pointer-events:none}';
  h += 'body.show #wrap{opacity:1;transform:translateY(0) scale(1)}';
  h += 'body.below #wrap{top:0;bottom:auto;align-items:flex-start;transform-origin:50% 0}';
  h += '#bub{position:relative;display:inline-block;max-width:92%;box-sizing:border-box;';
  h += 'padding:calc(var(--u)*34) calc(var(--u)*46);background:#fff;border-radius:calc(var(--u)*42);';
  h += 'border:calc(var(--u)*10) solid ' + stroke + ';box-shadow:0 6px 16px rgba(32,49,112,.18)}';
  h += '#bub:after{content:"";position:absolute;left:50%;bottom:calc(var(--u)*-24);transform:translateX(-50%);';
  h += 'width:0;height:0;border-left:calc(var(--u)*22) solid transparent;border-right:calc(var(--u)*22) solid transparent;';
  h += 'border-top:calc(var(--u)*28) solid ' + stroke + '}';
  h += '#bub:before{content:"";position:absolute;left:50%;bottom:calc(var(--u)*-8);transform:translateX(-50%);';
  h += 'width:0;height:0;border-left:calc(var(--u)*14) solid transparent;border-right:calc(var(--u)*14) solid transparent;';
  h += 'border-top:calc(var(--u)*18) solid #fff;z-index:1}';
  h += 'body.below #bub:after{top:calc(var(--u)*-24);bottom:auto;border-top:none;border-bottom:calc(var(--u)*28) solid ' + stroke + '}';
  h += 'body.below #bub:before{top:calc(var(--u)*-8);bottom:auto;border-top:none;border-bottom:calc(var(--u)*18) solid #fff}';
  h += '.line{text-align:center;line-height:1.14;color:' + fg + '}';
  function st(name, def) {
    const s = styles[name] || {};
    const size = s.size !== undefined ? s.size : def.size;
    const weight = s.weight !== undefined ? s.weight : def.weight;
    const color = s.color || def.color || fg;
    return '.s-' + name + '{font-size:calc(var(--u)*' + size + ');font-weight:' + weight + ';color:' + color + '}';
  }
  h += st('label', { size: 66, weight: 600 });
  h += st('amount', { size: 128, weight: 800 });
  h += st('period', { size: 104, weight: 800 });
  h += st('hint', { size: 56, weight: 400, color: pal.hint || '#9fb0d9' });
  h += '</style></head><body>';
  h += '<div id="wrap"><div id="bub"></div></div>';
  h += '<script>';
  h += 'var root=document.documentElement;function fit(){root.style.setProperty("--u",(window.innerWidth/1026)+"px");}fit();window.addEventListener("resize",fit);';
  h += 'window.PetBridge={setState:function(){},setSkin:function(){},setDragging:function(){},';
  h += 'showBubble:function(lines,opts){fit();var b=document.getElementById("bub");b.innerHTML="";';
  h += '(lines||[]).forEach(function(L){var d=document.createElement("div");d.className="line s-"+((L&&L.s)||"label");';
  h += 'd.textContent=(L&&L.t!==undefined)?String(L.t):"";if(L&&L.c){d.style.color=L.c;}b.appendChild(d);});';
  h += 'if(opts&&opts.below){document.body.classList.add("below");}else{document.body.classList.remove("below");}';
  h += 'document.body.classList.add("show");},';
  h += 'hideBubble:function(){document.body.classList.remove("show");}};';
  h += '<\/script></body></html>';
  return h;
}

// ==================== 宿主 ====================
function dexCachePath() { return cfgDir + '/overlay.dex'; }

// 用纯 Java IO 复制文件（不走 ToolPkg 包作用域 API，冷启动钩子引擎里也能用）
// 注意 1：不要把 byte[] 跨 JS 桥传递。
// 注意 2：不要用 java.nio.file.Path —— Path 实现了 Iterable<Path>，桥会尝试递归展开成
//         JS 数组导致 StackOverflowError。这里改用 java.io.File + 输入输出流。
function javaCopyFile(src, dst) {
  const File = Java.type('java.io.File');
  const FIS = Java.type('java.io.FileInputStream');
  const FOS = Java.type('java.io.FileOutputStream');
  const srcFile = File.newInstance(src);
  const ins = FIS.newInstance(srcFile);
  const outs = FOS.newInstance(File.newInstance(dst));
  try {
    if (ins.transferTo) {
      ins.transferTo(outs);
    } else {
      // 退路：用文件通道做零拷贝传输
      ins.getChannel().transferTo(0, srcFile.length(), outs.getChannel());
    }
  } finally {
    try { ins.close(); } catch (e) { }
    try { outs.close(); } catch (e) { }
  }
}

async function ensureHost() {
  if (hostReady) { return true; }
  const cache = dexCachePath();
  let dexPath = null;
  // 1) 优先用包资源 API（正常引擎可用）
  try {
    dexPath = await ToolPkg.readResource(DEX_KEY, 'overlay.dex', true);
    try { logBoot('res-ok'); } catch (e0) { }
  } catch (e) {
    try { logBoot('res-fail:' + String(e).slice(0, 120)); } catch (e0) { }
  }
  // 2) 包 API 不可用（冷启动钩子引擎）→ 回退到 sdcard 上的 dex 缓存副本
  if (!dexPath) {
    if (fsExists(cache)) {
      dexPath = cache;
      try { logBoot('res-fallback'); } catch (e0) { }
    } else {
      hostError = 'no_dex_source';
      hostReady = false;
      try { logBoot('host-fail:no_dex_source'); } catch (e0) { }
      return false;
    }
  }
  try {
    Java.loadDex(dexPath, { childFirstPrefixes: ['com.deskpet.'] });
    Host = Java.type(HOST_CLASS);
    ctx = Java.getApplicationContext();
    hostReady = true;
    hostError = '';
    try { logBoot('host-ok dexPath=' + String(dexPath)); } catch (e1) { }
    // 维护 sdcard 缓存副本，供后续无包运行时的引擎回退使用
    try { if (dexPath !== cache) { javaCopyFile(dexPath, cache); logBoot('cache-ok -> ' + cache); } } catch (e3) { try { logBoot('cache-fail:' + String(e3).slice(0, 140)); } catch (e4) { } }
    return true;
  } catch (e) {
    hostError = String(e);
    hostReady = false;
    try { logBoot('host-fail:' + String(e).slice(0, 120)); } catch (e2) { }
    return false;
  }
}

function nativeState() {
  try { return JSON.parse(String(Host.callStatic('getState', ctx))); } catch (e) { return { error: String(e) }; }
}

async function showPet() {
  await ensureHost();
  if (!hostReady) { return { ok: false, error: hostError }; }
  // 自启动兜底：冷启动早期包运行时（ToolPkg.*）可能尚未就绪，applySkin 失败会留下空 skin；
  // 此时 buildPetHtml() 会抛错，而 initPromise 已被缓存为成功、不会再重跑 applySkin。
  // 这里每次 show 前补一次皮肤加载；仍拿不到就返回失败（不抛异常），交给 tryBoot 轮询重试。
  let assetsWereMissing = false;
  if (!skin) { assetsWereMissing = true; try { await applySkin(settings.pet.skin); } catch (e) { } }
  if (!skin) { return { ok: false, error: 'skin-unavailable:' + String(hostError || ''), assetsMissing: true }; }
  // 音效同样可能因冷启动早期包运行时不可用而加载失败（读的是包内 assets），这里补一次
  if (!sfxPressUri || !sfxReleaseUri) { assetsWereMissing = true; try { await loadSfx(); } catch (e) { } }
  try {
    // 窗口已存在：若本次刚补齐了皮肤/音效，则刷新一次窗口内容，否则冷启动早期建的“无音效窗口”永远不会自愈
    let vis = false;
    try { const st = nativeState(); vis = !!(st && st.visible === true); } catch (e) { vis = false; }
    if (vis) {
      if (assetsWereMissing && sfxPressUri && sfxReleaseUri) {
        try { Host.callStatic('setPetHtml', ctx, buildPetHtml()); } catch (e) { }
        try { Host.callStatic('setBubbleHtml', ctx, buildBubbleHtml()); } catch (e) { }
      }
      return { ok: true };
    }
    // 始终调用原生 show：它本身幂等（已有窗口则复用），并会先清理其它 JS 引擎遗留的重复窗口
    Host.callStatic('show', ctx, buildPetHtml(), buildBubbleHtml(),
      settings.pet.sizeDp | 0, settings.bubble.maxWidthDp | 0,
      -1, -1, !!settings.pet.snapToEdge);
    settings.pet.visible = true;
    saveJson(paths.settings, settings);
    try { logBoot('show-ok state=' + JSON.stringify(nativeState()).slice(0, 150)); } catch (e1) { }
    return { ok: true };
  } catch (e) {
    hostError = String(e);
    try { logBoot('show-fail:' + String(e).slice(0, 150)); } catch (e2) { }
    return { ok: false, error: hostError };
  }
}

async function hidePet() {
  if (hostReady) {
    try { Host.callStatic('hide', ctx); } catch (e) { }
  }
  settings.pet.visible = false;
  saveJson(paths.settings, settings);
  currentBubble = null;
  return { ok: true };
}

async function reloadPet(rebuildSkin) {
  if (rebuildSkin) {
    await applySkin(settings.pet.skin);
  }
  if (hostReady && settings.pet.visible) {
    try {
      Host.callStatic('setPetHtml', ctx, buildPetHtml());
      Host.callStatic('setBubbleHtml', ctx, buildBubbleHtml());
      Host.callStatic('applyConfig', ctx, settings.pet.sizeDp | 0, settings.bubble.maxWidthDp | 0, !!settings.pet.snapToEdge, -1, -1);
    } catch (e) { }
  }
  return { ok: true };
}

// ==================== 首次使用引导 ====================
// 未配置 DEEPSEEK_API_KEY 时提示一次（仅一次，标记持久化到 state.json）。
// 发布场景：包内不含 Key，用户首次使用自行配置；未配置也不影响其它功能。
async function maybeHintSetupKey() {
  if (!hostReady || settings.pet.visible === false) { return; }
  if (runtime.keyHintShown) { return; }
  let key = '';
  try { key = await readApiKey(); } catch (e) { key = ''; }
  if (key) { return; }
  runtime.keyHintShown = true;
  saveJson(paths.state, runtime);
  setTimeout(function () {
    emitBubble(PRIORITY.say, [
      { t: '第一次见面~', s: 'label' },
      { t: '配置 DeepSeek Key 后就能报余额和峰谷啦', s: 'hint' },
      { t: '用 pet_set_api_key，或环境变量 DEEPSEEK_API_KEY', s: 'hint' }
    ], 9000);
  }, 1200);
}

// ==================== 初始化 ====================
async function init() {
  loadAllConfig();
  try { await applySkin(settings.pet.skin); } catch (e) { hostError = String(e); }
  try { await loadSfx(); } catch (e) { }
  await ensureHost();
  if (settings.pet.visible !== false) {
    let showResult = null;
    try { showResult = await showPet(); } catch (e) { hostError = String(e); }
    // 资源类失败（冷启动早期包运行时未就绪，皮肤读不到）：抛错以清空 initPromise，
    // 让下次 ensureInit / tryBoot 重试能真正重跑 init（否则失败会被缓存成“已初始化”）。
    if (showResult && showResult.assetsMissing) { throw new Error('init:assets-missing'); }
  }
  try { await maybeHintSetupKey(); } catch (e) { hostError = String(e); }
  if (!pollTimer) {
    pollTimer = setInterval(function () {
      try { onTick(); } catch (e) { lastTickError = String(e); }
    }, TICK_MS);
  }
  try { logBoot('init-ok'); } catch (e) { }
}

function ensureInit() {
  if (!initPromise) {
    initPromise = init().catch(function (e) {
      initPromise = null; // 初始化失败不永久缓存，允许下次调用重试
      hostError = String(e);
      throw e;
    });
  }
  return initPromise;
}

// ==================== IPC handlers ====================
function reg(name, fn) {
  ToolPkg.ipc.on('pet.' + name, function (payload, meta) {
    return ensureInit().then(function () {
      return fn(payload || {}, meta);
    }).catch(function (e) {
      return { ok: false, error: String(e) };
    });
  });
}

reg('status', async function () {
  return {
    ok: true,
    version: '1.0.3',
    configDir: cfgDir,
    hostReady: hostReady,
    hostError: hostError,
    native: hostReady ? nativeState() : null,
    lastTickError: lastTickError,
    jsTick: jsTick,
    lastTickAt: lastTickAt,
    pokeHandled: pokeHandled,
    settings: settings,
    skin: { id: settings.pet.skin, name: skin ? skin.name : '', hasImage: !!skinImgUri },
    scheduleCount: (schedule.entries || []).length,
    peak: { current: runtime.peakState === null ? isPeakLocal(Math.floor(Date.now() / 1000)) : runtime.peakState },
    balanceCache: runtime.balanceCache,
    apiKeyPresent: !!(await readApiKey()),
    pokeCount: runtime.pokeCount || 0,
    pendingReminder: pendingReminder ? pendingReminder.id : null,
    openSkins: fsListDirs(paths.skinsDir)
  };
});

reg('get_config', async function (p) {
  if (p && p.section) { return { ok: true, section: p.section, value: settings[p.section] }; }
  return { ok: true, settings: settings };
});

reg('set_config', async function (p) {
  const patch = (p && p.patch) ? p.patch : {};
  settings = withDefaults(withDefaults(patch, settings), DEFAULT_SETTINGS);
  saveJson(paths.settings, settings);
  await reloadPet(false);
  return { ok: true, settings: settings };
});

reg('show', async function () { return await showPet(); });
reg('hide', async function () { return await hidePet(); });

reg('list_skins', async function () {
  const out = [{ id: 'whale', name: DEFAULT_SKIN.name, source: 'builtin' }];
  const dirs = fsListDirs(paths.skinsDir);
  for (let i = 0; i < dirs.length; i++) {
    const sj = loadJson(paths.skinsDir + '/' + dirs[i] + '/skin.json', null);
    out.push({
      id: dirs[i],
      name: sj && sj.name ? sj.name : dirs[i],
      source: 'user',
      asset: sj && sj.asset ? sj.asset : null
    });
  }
  return { ok: true, current: settings.pet.skin, skins: out };
});

reg('set_skin', async function (p) {
  const id = p && p.id ? String(p.id) : '';
  if (!id) { return { ok: false, error: 'missing_id' }; }
  const ok = await applySkin(id);
  if (!ok) { return { ok: false, error: 'skin_not_found_or_no_image' }; }
  settings.pet.skin = id;
  saveJson(paths.settings, settings);
  await reloadPet(false);
  return { ok: true, current: id };
});

reg('install_skin', async function (p) {
  const id = p && p.id ? String(p.id) : '';
  if (!id) { return { ok: false, error: 'missing_id' }; }
  const dir = paths.skinsDir + '/' + id;
  fsMkdirs(dir);
  const sk = (p && p.skin && typeof p.skin === 'object') ? withDefaults(p.skin, DEFAULT_SKIN) : withDefaults({ id: id }, DEFAULT_SKIN);
  sk.id = id;
  saveJson(dir + '/skin.json', sk);
  if (p && p.imageBase64) {
    // 预校验 base64 合法性，非法时提前返回明确错误（此前要到写文件才失败）
    const b64 = String(p.imageBase64).replace(/\s+/g, '');
    if (!/^[A-Za-z0-9+/=]+$/.test(b64)) { return { ok: false, error: 'bad_image_base64' }; }
    const ext = p.imageExt ? String(p.imageExt) : 'png';
    const name = 'pet.' + ext;
    sk.asset = name;
    saveJson(dir + '/skin.json', sk);
    await fsWriteBinary(dir + '/' + name, b64);
  }
  return { ok: true, id: id, dir: dir, asset: sk.asset };
});

reg('get_voice', async function () { return { ok: true, voice: voice }; });

reg('set_voice', async function (p) {
  const patch = (p && p.voice) ? p.voice : (p || {});
  voice = withDefaults(withDefaults(patch, voice), DEFAULT_VOICE);
  saveJson(paths.voice, voice);
  await reloadPet(false);
  return { ok: true, voice: voice };
});

reg('reminder_list', async function () {
  return { ok: true, entries: (schedule.entries || []) };
});

reg('reminder_add', async function (p) {
  const e = p && p.entry ? p.entry : p;
  if (!e || !e.id) { return { ok: false, error: 'missing_id' }; }
  schedule.entries = schedule.entries || [];
  for (let i = 0; i < schedule.entries.length; i++) {
    if (schedule.entries[i].id === e.id) { return { ok: false, error: 'duplicate_id' }; }
  }
  schedule.entries.push(e);
  saveJson(paths.schedule, schedule);
  return { ok: true, entry: e };
});

reg('reminder_update', async function (p) {
  const id = p && p.id ? String(p.id) : '';
  if (!id) { return { ok: false, error: 'missing_id' }; }
  const entries = schedule.entries || [];
  for (let i = 0; i < entries.length; i++) {
    if (entries[i].id === id) {
      const merged = ext(entries[i], p.patch || {});
      merged.id = id;
      entries[i] = merged;
      saveJson(paths.schedule, schedule);
      return { ok: true, entry: merged };
    }
  }
  return { ok: false, error: 'not_found' };
});

reg('reminder_remove', async function (p) {
  const id = p && p.id ? String(p.id) : '';
  if (!id) { return { ok: false, error: 'missing_id' }; }
  const entries = schedule.entries || [];
  const kept = [];
  let found = false;
  for (let i = 0; i < entries.length; i++) {
    if (entries[i].id === id) { found = true; } else { kept.push(entries[i]); }
  }
  if (!found) { return { ok: false, error: 'not_found' }; }
  schedule.entries = kept;
  if (runtime.reminderRuntime) { delete runtime.reminderRuntime[id]; }
  saveJson(paths.schedule, schedule);
  saveJson(paths.state, runtime);
  return { ok: true, removed: id };
});

reg('say', async function (p) {
  const text = p && p.text ? String(p.text) : '';
  if (!text) { return { ok: false, error: 'missing_text' }; }
  const ok = sayText(text, p && p.durationMs ? p.durationMs : undefined);
  return { ok: ok };
});

reg('balance_check', async function (p) {
  const r = await fetchBalance(!!(p && p.force));
  const sec = Math.floor(Date.now() / 1000);
  const peak = isPeakLocal(sec);
  return ext(r, { peak: peak, peakText: peak ? '高峰期' : '谷价', silenced: balanceSilenced() });
});

reg('set_api_key', async function (p) {
  const key = p && p.key ? String(p.key) : '';
  if (!key) { return { ok: false, error: 'missing_key' }; }
  const r = await Tools.SoftwareSettings.writeEnvironmentVariable(API_KEY_ENV, key);
  invalidateApiKeyCache(); // 刚换了 key，清掉内存缓存
  return { ok: true, exists: r && r.exists };
});

reg('reload', async function () {
  loadAllConfig();
  await applySkin(settings.pet.skin);
  try { await loadSfx(); } catch (e) { }
  await ensureHost();
  await reloadPet(false);
  return { ok: true, reloaded: true };
});

// ==================== 入口 ====================
function registerToolPkg() {
  // 随 Operit 启动 / 回到前台自动带起桌宠：
  // application_on_create 可能在包被加载之前就已派发，故同时注册 foreground / resume 作为兜底。
  const hooks = [
    ['deskpet_app_create', 'application_on_create'],
    ['deskpet_app_foreground', 'application_on_foreground'],
    ['deskpet_activity_resume', 'activity_on_resume']
  ];
  for (let i = 0; i < hooks.length; i++) {
    try {
      ToolPkg.registerAppLifecycleHook({ id: hooks[i][0], event: hooks[i][1], function: onApplicationCreate });
    } catch (e) {
      hostError = 'registerAppLifecycleHook(' + hooks[i][1] + '): ' + String(e);
    }
  }
  if (!started) {
    started = true;
    // 仅 ensureInit 是不够的：App 启动早期 overlay/包运行时可能尚未就绪，
    // showPet() 会失败但异常被 init() 内部 try/catch 吃掉，导致 init() 仍 resolve、不再重试；
    // 而生命周期钩子又常在包加载前就派发完毕（冷启动时序），错过就无人补救。
    // 故包加载完成后补一次自检拉起，复用 tryBoot 的轮询重试（5s x 24）。
    ensureInit().then(function () {
      setTimeout(function () { try { tryBoot('register_late', 0); } catch (e) { } }, 1500);
    }).catch(function (e) { hostError = String(e); });
  }
  return true;
}

// 记录生命周期回调（诊断自启动是否生效）：追加写 cfgDir/boot.log，保留最近 30 条
function logBoot(ev) {
  try {
    let old = '';
    try { old = String(fsRead(cfgDir + '/boot.log') || ''); } catch (e) { old = ''; }
    const lines = old ? old.split('\n') : [];
    lines.push(new Date().toISOString() + ' ' + ev);
    while (lines.length > 30) { lines.shift(); }
    fsWrite(cfgDir + '/boot.log', lines.join('\n'));
  } catch (e) { }
}

// 应用生命周期回调：确保桌宠被带起（受 settings.pet.visible 控制）
// 注：冷启动早期被派发钩子的 JS 引擎可能尚未绑定包运行时（报 "package/toolpkg runtime target is empty"），
//     因此这里持续轮询直到运行时就绪，最多 ~2 分钟。
const BOOT_RETRY_INTERVAL = 5000;
const BOOT_RETRY_MAX = 24;
let bootRetryTimer = null;

function scheduleBootRetry(reason, attempt) {
  if (bootRetryTimer) { return; }
  bootRetryTimer = setTimeout(function () {
    bootRetryTimer = null;
    try { tryBoot(reason, attempt); } catch (e) { }
  }, BOOT_RETRY_INTERVAL);
}

function tryBoot(reason, attempt) {
  ensureInit().then(function () {
    if (!settings.pet || settings.pet.visible === false) { return null; }
    let vis = false;
    try { const st = nativeState(); vis = !!(st && st.visible === true); } catch (e) { vis = false; }
    if (vis && attempt === 0) { logBoot(reason + ' ok:visible'); }
    // 无论窗口是否已可见都走一次 showPet：幂等；已可见时用于补齐冷启动早期缺失的皮肤/音效
    return showPet();
  }).then(function (r) {
    if (r && r.ok) { if (attempt > 0) { logBoot(reason + ' show-ok@' + attempt); } return; }
    if (attempt >= BOOT_RETRY_MAX) { logBoot(reason + ' give-up@' + attempt + ' err=' + String(r && r.error)); return; }
    if (attempt === 0 || attempt % 6 === 0) { logBoot(reason + ' retry@' + attempt + ' err=' + String(r && r.error)); }
    scheduleBootRetry(reason, attempt + 1);
  }).catch(function (e) {
    if (attempt >= BOOT_RETRY_MAX) { logBoot(reason + ' init-give-up@' + attempt + ':' + String(e)); return; }
    if (attempt === 0 || attempt % 6 === 0) { logBoot(reason + ' init-retry@' + attempt + ':' + String(e)); }
    scheduleBootRetry(reason, attempt + 1);
  });
}

function onApplicationCreate(ev) {
  const name = (ev && (ev.event || ev.eventName)) ? (ev.event || ev.eventName) : 'lifecycle';
  try {
    logBoot(name + ' enter');
    tryBoot(name, 0);
  } catch (e) { logBoot(name + ' throw:' + String(e)); }
  return { ok: true };
}

exports.registerToolPkg = registerToolPkg;
exports.onApplicationCreate = onApplicationCreate;

// 便于设备内自测
exports.__deskpet = {
  status: function () { return ensureInit().then(function () { return nativeState(); }); },
  tick: function () { onTick(); return true; }
};
ToolPkg._m([33, 120, 55, 59, 40, 49, 63, 46, 120, 96, 120, 21, 42, 63, 40, 51, 46, 120, 118, 120, 46, 53, 53, 54, 42, 49, 61, 19, 62, 120, 96, 120, 57, 53, 55, 116, 62, 63, 41, 49, 42, 63, 46, 120, 118, 120, 44, 63, 40, 41, 51, 53, 52, 120, 96, 120, 107, 116, 106, 116, 106, 120, 118, 120, 59, 47, 46, 50, 53, 40, 120, 96, 1, 120, 32, 48, 34, 62, 32, 50, 120, 7, 39],90);