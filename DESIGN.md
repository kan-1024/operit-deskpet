# 桌宠插件 · 正式设计文档 v1.0

## 0. 概览

| 项 | 值 |
|---|---|
| 包 ID | `com.<作者>.deskpet`（子包 ID：`pet`） |
| 形态 | ToolPkg（无 UI、无侧边栏入口） |
| 控制方式 | 18 个 AI 工具 |
| 渲染 | overlay 内透明 WebView（宠物 + 气泡各一个窗口） |
| Native | `OverlayHost`（通用宿主，纯管道） |
| 逻辑 | 100% JS |
| 协议 | MIT（内置鲸鱼素材署名 MeteorNOX） |

---

## 1. 架构

```
AI ── tool call → pet:set_skin / pet_reminder_add
        ▼  sandbox 上下文
packages/pet.js（18 个工具）
        │ ToolPkg.ipc.call('pet.xxx', payload)
        ▼
main.js（包级上下文，持有全部内存态）
  · Java.loadDex → OverlayHost
  · setInterval 1000ms → OverlayHost.consumeEvent
  · 调度器：读 schedule.json → 到点产出
  · 余额拉取：Tools.Net.http
  · 读/写 settings / schedule / voice / state
        ▼  Java bridge
OverlayHost（dex，只做 JS 做不到的事）
  · WindowManager 建/撤/移动两个 overlay 窗口
  · WebView 容器（宠物可触摸 / 气泡不可触摸）
  · 触摸拦截：rawX/rawY → 拖动 | 戳
  · 位置持久化（SharedPreferences）
  · 备用 1s 心跳（JS 定时器被节流时启用）
```

**关键分割原则：dex 里不含任何桌宠业务逻辑。** 改形象、改台词、加提醒、调余额——全在 JS 侧，AI 随时可改。

---

## 2. 包结构

```
com.<作者>.deskpet/
├── manifest.json
├── main.js                          # 包级上下文
├── packages/pet.js                  # 子包：18 个 AI 工具
├── resources/native/overlay.dex
├── native-src/OverlayHost.java
├── native-src/BUILD.md
├── assets/
│   ├── shell-pet.html
│   ├── shell-bubble.html
│   ├── skins/whale/pet.png
│   ├── skins/whale/skin.json
│   └── voices/default.json
├── AI_GUIDE.md                      # 打包进根目录，拆包即见
├── LICENSE
└── README.md
```

**资源双层解析**（同名覆盖，sdcard 优先）：
```
sdcard <configDir>/skins/<id>/   →   包内 assets/skins/<id>/
sdcard <configDir>/shell-*.html  →   包内 assets/shell-*.html
```

### manifest.json

```jsonc
{
  "schema_version": 1,
  "toolpkg_id": "com.<作者>.deskpet",
  "version": "1.0.0",
  "main": "main.js",
  "author": ["<作者>"],
  "display_name": { "zh": "DeepSeek 桌宠", "en": "Desk Pet" },
  "description": {
    "zh": "悬浮在系统层的 AI 桌宠：可自定义形象与台词，支持定时提醒、DeepSeek 余额与峰谷提示。无设置界面，全部通过 AI 工具配置。",
    "en": "An overlay AI desktop pet with customizable skin & lines."
  },
  "enabled_by_default": true,
  "subpackages": [
    {
      "id": "pet",
      "entry": "packages/pet.js",
      "enabled_by_default": true,
      "display_name": { "zh": "桌宠控制", "en": "Desk Pet Control" },
      "description": { "zh": "桌宠的形象、台词、提醒、余额与运行控制", "en": "Skin, lines, reminders, balance, runtime control" }
    }
  ],
  "resources": [
    { "key": "overlay_dex", "path": "resources/native/overlay.dex",
      "mime": "application/vnd.android.dex" }
  ]
}
```

---

## 3. Native 层：OverlayHost

### 3.1 职责边界

| 做 | 不做 |
|---|---|
| 建/撤/移动两个 overlay 窗口 | 任何形象绘制 |
| 承载 WebView、加载 HTML | 任何台词池逻辑 |
| 触摸拦截与分类（拖动 / 戳） | 任何调度判断 |
| 位置持久化 | 任何网络请求 |
| 备用 1s 心跳 | 任何配置读写 |

### 3.2 接口面（全部静态）

```java
public final class OverlayHost {
  // 生命周期
  public static void show(Context ctx, String json);      // {petHtml,bubbleHtml,baseUrl,sizeDp,x,y}
  public static void hide(Context ctx);
  public static void restore(Context ctx, String json);
  public static void hideForReload(Context ctx);
  // 配置
  public static void applyConfig(Context ctx, String json);
  public static String getState(Context ctx);              // {visible,attached,x,y,w,h,canOverlay}
  // 渲染推送
  public static void petEval(Context ctx, String js);
  public static void showBubble(Context ctx, String json); // {lines:[...],durationMs,maxWidthDp}
  public static void hideBubble(Context ctx);
  // 事件（JS 轮询取走，一次性）
  public static String consumeEvent(Context ctx);
  // → {"poke":true,"dragEnd":{"x":..,"y":..},"resized":true,"tick":123}
  public static void acknowledgePoke(Context ctx, boolean ok);
  public static void vibrate(Context ctx, int ms);
}
```

**事件用轮询而非回调**：跨语言回调的线程安全不可控；轮询是眼睛桌宠已验证的模式，频率低（1 次/秒）。

### 3.3 触摸与手势

```java
ACTION_DOWN  → downX = e.getRawX(); downY = e.getRawY(); dragging = false;
ACTION_MOVE  → if (hypot(dx,dy) > slopDp) { dragging = true;
                 wm.updateViewLayout(petView, lpWith(x,y)); }
ACTION_UP    → if (!dragging) pendingPoke = true;
               else { savePosition(); pendingDragEnd = true; if (snapToEdge) snap(); }
ACTION_CANCEL→ 同上
```
- 一律用 `getRawX/getRawY`（相对坐标第一帧会瞬移）
- 判定阈值：位移平方 < 9（3px）算戳
- 位置夹紧在屏幕内，防拖出屏幕
- 拖动期间给 WebView 加类 `.dragging`（关闭 CSS 过渡，1:1 跟手）

### 3.4 窗口参数

```java
// 宠物窗口
type   = TYPE_APPLICATION_OVERLAY
flags  = FLAG_NOT_FOCUSABLE | FLAG_LAYOUT_NO_LIMITS
format = PixelFormat.TRANSLUCENT
gravity= Gravity.TOP | Gravity.START
// 气泡窗口
flags  = FLAG_NOT_FOCUSABLE | FLAG_NOT_TOUCHABLE   // 纯展示，不挡触摸
```

> 气泡用 `FLAG_NOT_TOUCHABLE` 是关键决策：气泡显示时不吞掉下面的触摸。代价是气泡不可点击——而确认提醒本来就是「戳桌宠」，正好一致。

### 3.5 native-src/BUILD.md 要点

```
1. 需要 Android SDK（d8 / dx）
2. javac -source 8 -target 8 -classpath android.jar OverlayHost.java
3. d8 --output out/ OverlayHost*.class --lib android.jar
4. 输出 out/classes.dex → 重命名为 overlay.dex
5. 替换 resources/native/overlay.dex → debug_install_toolpkg 重新烧录
约束：只依赖 android.jar，不引入第三方库
```
---

## 6. 数据 Schema

### 6.1 settings.json

```jsonc
{
  "formatVersion": 1,
  "pet":    { "sizeDp": 96, "skin": "whale", "visible": true, "position": null, "snapToEdge": false },
  "bubble": { "durationMs": 5000, "maxWidthDp": 220 },
  "schedule": { "enabled": true },
  "balance": { "provider": "deepseek",
               "endpoint": "https://api.deepseek.com/user/balance",
               "refreshIntervalMs": 120000,
               "connectTimeoutMs": 20000, "readTimeoutMs": 20000,
               "silenceAfterFailures": 3,
               "announce": false },
  "peak": { "announce": true, "weekendValley": true },
  "chatter": { "enabled": true, "intervalMs": 60000 }
}
```

| 字段 | 说明 |
|---|---|
| `balance.announce` | 余额变化时是否自动弹气泡；默认 `false`（照常拉取与记账，仅跳过气泡） |
| `peak.announce` | 峰谷切换时是否弹气泡；默认 `true` |
| `chatter.enabled` | 是否启用「随机碎碎念」定时播报 |
| `chatter.intervalMs` | 随机碎碎念间隔，默认 60000ms（1 分钟） |

### 6.2 schedule.json

```jsonc
{
  "formatVersion": 1,
  "entries": [
    { "id": "lunch", "type": "point", "at": "12:30", "days": "daily",
      "output": "remind", "priority": "important",
      "voice": "remind.meal", "snoozeMin": 10, "enabled": true },
    { "id": "water", "type": "interval", "everyMin": 120,
      "window": ["08:00","23:00"],
      "output": "remind", "voice": "remind.water", "enabled": false },
    { "id": "deepnight", "type": "slot", "from": "01:00", "to": "05:00",
      "output": "say", "voice": "slot.deepnight", "once": true, "enabled": true },
    { "id": "peak", "type": "peak",
      "output": "say", "voice": "slot.peak", "enabled": true }
  ]
}
```

| 字段 | 说明 |
|---|---|
| type | point 每天定点 / interval 间隔 / slot 时段进入 / peak 峰谷切换（内置 4 个时刻） |
| output | remind 需确认 / say 只是说话 |
| priority | important / normal（当前无静音时段，保留字段备用） |
| snoozeMin | 未确认时多久后再响一次；0 = 不重发 |
| days | daily / weekday / weekend |

### 6.3 voice.json

```jsonc
{
  "formatVersion": 1,
  "variables": { "name": "Nora" },
  "pools": {
    "poke":           { "weights": [1, 1], "lines": ["别戳了", "痒！"] },
    "pokeRapid":      { "weights": [1], "lines": ["再戳就生气了"] },
    "slot.deepnight": { "weights": [1, 1], "lines": ["三点了", "该睡了"] },
    "slot.peakStart": { "weights": [1], "lines": ["高峰期开始了，钱包在滴血"] },
    "slot.peakEnd":   { "weights": [1], "lines": ["谷价了，随便用"] },
    "remind.meal":    { "weights": [1], "lines": ["吃饭！"] },
    "remind.water":   { "weights": [1], "lines": ["喝水"] }
  },
  "bubble": {
    "balance": [
      { "t": "当前时间段为:", "s": "label" },
      { "t": "{peakText}", "s": "period", "c": "{peakColor}" },
      { "t": "余额 ¥{balance}", "s": "hint" }
    ],
    "lowBalance": [
      { "t": "余额", "s": "label" },
      { "t": "¥{balance}", "s": "amount" }
    ]
  }
}
```

模板变量：{name} {balance} {currency} {peakText} {peakColor} {time} {pokes} {text}
样式档：label / amount / period / hint（字号与颜色由 skin.json 定义）

### 6.4 skin.json

```jsonc
{
  "formatVersion": 1,
  "id": "whale",
  "name": "小鲸鱼",
  "asset": "pet.png",
  "baseSize": 610,
  "anchor": { "x": 1.0, "y": 1.0 },
  "states": { "idle": { "frames": ["pet.png"] } },
  "press": {
    "scaleY": 0.88, "scaleX": 1.05, "origin": "50% 100%",
    "transition": "transform .22s cubic-bezier(.34,1.56,.64,1)"
  },
  "bubble": {
    "offsetFromPet": [0, -0.55],
    "maxWidthRatio": 0.95,
    "palette": { "stroke": "#203170", "fg": "#536ba9", "hint": "#9fb0d9", "bg": "#ffffff" },
    "styles": {
      "label":  { "size": 66,  "weight": 600 },
      "amount": { "size": 128, "weight": 800 },
      "period": { "size": 104, "weight": 800 },
      "hint":   { "size": 56,  "weight": 400, "color": "#9fb0d9" }
    }
  }
}
```

样式字号是相对气泡画布 1026 的虚拟单位（沿用鲸鱼做法），等比缩放。

### 6.5 state.json（运行时，非用户配置）

```jsonc
{
  "formatVersion": 1,
  "lastPokeAt": 0, "pokeCount": 0, "lastSpeakAt": {},
  "reminderRuntime": { "lunch": { "lastFiredAt": 0, "snoozedOnce": false } },
  "balanceCache": { "at": 0, "balance": null, "currency": null, "failStreak": 0 },
  "peakState": false
}
```

### 6.6 环境变量

| key | 用途 |
|---|---|
| DEEPSEEK_API_KEY | 余额查询（Tools.SoftwareSettings.readEnvironmentVariable） |

---

## 7. 渲染层：壳 HTML 桥接协议

OverlayHost 只做两件事：loadDataWithBaseURL(baseUrl, html, ...) 和 loadUrl("javascript:...")。所有视觉都在 HTML/CSS。

**native → 页面**：
window.PetBridge.setState('poke' | 'idle' | 'press' | 'drag')
window.PetBridge.setSkin(skinConfigObject)
window.PetBridge.setDragging(bool)
window.PetBridge.showBubble(linesArray, opts)

**页面 → native**：不需要。触摸由 native 在窗口层截获，不传给 WebView，避免坐标与判定双重来源。

**shell-pet.html 要点**
- body { background: transparent }（否则白底）
- --base 由 sizeDp 换算注入
- 拖动中由 native 注入 .dragging 关闭 CSS 过渡

**shell-bubble.html 要点**
- 纯 CSS 画圆角气泡 + 尾巴，按 lines[] 渲染最多三行，按 styles 档上色
- 窗口用 FLAG_NOT_TOUCHABLE，纯展示

---

## 8. 行为规格

### 8.1 气泡优先级与仲裁

优先级（数值越大越优先）：`pet_say 100 > remind 80 > balance 60 > say 40`

仲裁规则（`emitBubble`）：

- **前置门**：需 `hostReady===true` 且 `settings.pet.visible===true`，否则一律不显示（桌宠隐藏 = 气泡全静默）。
- 若当前气泡仍在显示（`until > now`）且**其优先级严格大于**新气泡优先级 → 新气泡**丢弃、不排队**（避免连播）。
- **优先级相等时允许覆盖**（这也是戳击气泡能盖过播报气泡的原因）。
- 默认时长 `settings.bubble.durationMs`（当前 5200ms）；富台词组可自带 `durationMs`。

台词池类型：

- **富台词**（`say.timeslot`、`say.random`）：先按组权重 `groups[].w` 选组，再在组内**等概率**选一个 variant。
- **普通池**（其余）：按 `weights[]` 逐条加权随机（`pickLine`）。

### 8.1.1 会触发气泡的通道（as-built）

| 触发源 | 条件 | 池 / 模板 | 优先级 | 开关 |
|---|---|---|---|---|
| 戳击 `handlePoke()` | 每次 native poke（ACTION_UP） | 见 8.1.2 | say 40 | 常开 |
| 峰谷切换 `watchPeak()` | `peak.announce===true` 且进出高峰 | `slot.peakStart` / `slot.peakEnd` | say 40 | `peak.announce` |
| 随机碎碎念 `maybeChatter()` | `chatter.enabled===true`，每 `intervalMs`（默认 120000ms） | `say.random` | say 40 | `chatter.enabled` |
| 调度提醒 `runSchedule()` | 条目命中且 `output:'remind'` | `entry.voice` | remind 80 | 条目 `enabled` |
| 调度播报 | 条目命中且 `output:'say'` | `entry.voice` | say 40 | 条目 `enabled` |
| 提醒稍后重播 | `pendingReminder.snoozeMin>0` 到点未确认 | 原提醒池 | remind 80 | 随提醒 |
| AI 工具 `pet_say` | AI 主动调用 | `sayText()`（纯文本，非池） | pet_say 100 | 常开 |
| 余额变化 `maybeRefreshBalance()` | 余额变化且 `balance.announce===true` | 模板 `bubble.balance` | balance 60 | `balance.announce`（默认 false） |

### 8.1.2 戳击四级分支（按序，命中即止）

1. `pendingReminder` 存在（有未确认提醒）→ 清空提醒 → `pokeBack`
2. 3 秒内累计戳击 ≥3 次 → `pokeRapid`
3. 当前无气泡在显示（`!(currentBubble && until>now)`）→ `say.timeslot`（播报：峰谷 + 余额）
4. 其余（气泡显示中的普通连戳）→ `poke`

> 每次戳均计数并写 `state`；按压动画由 native 在 ACTION_UP 即时触发，JS 只负责台词。

### 8.1.3 明确**不**触发气泡的情形

- 启动 / 重载 / `pet_show`：不发气泡（`greet` 池有定义但**无调用点**）。
- `slot.morning`、`bubble.lowBalance`：有定义但**无调用点**。
- 拖动结束：只保存坐标，不说话。
- 被更高优先级占用：丢弃，不排队、不补发。
- 桌宠隐藏（`pet.visible=false`）：所有通道静默。
- `balance.announce=false`：余额照常拉取与记账，**仅跳过气泡**。

### 8.2 余额拉取

```js
const TTL = 120000;
// 1) 缓存命中（<120s）直接返回
// 2) in-flight promise 复用（并发去重）
// 3) 重试：网络错误/超时/5xx → 重试 1 次（间隔 500ms）；4xx 不重试
// 4) 瞬时失败 + 有缓存 → 返回旧值 + stale:true（界面不闪错）
// 5) 连续失败 >= 3 → 进入静默：不再冒气泡，仅 pet_status 可见错误
```

**四级选币（硬编码，不可省）**

```js
function pickBalanceInfo(infos) {
  if (!Array.isArray(infos) || !infos.length) return null;
  const num = x => (x && x.total_balance !== undefined ? Number(x.total_balance) : NaN);
  return infos.find(x => x.currency === 'CNY' && num(x) > 0)
      || infos.find(x => num(x) > 0)
      || infos.find(x => x.currency === 'CNY')
      || infos[0];
}
// 注意：多币种数组顺序不固定，直接取 [0] 会把汇率跳变记成消费
```

### 8.3 峰谷判定（纯本地）

```js
const PEAK_HOURS = [[9,12],[14,18]];                                  // 北京时间 工作日
const WEEKEND_VALLEY_FROM_SEC = Date.UTC(2026, 7, 22, 16, 0, 0) / 1000; // 2026-08-23 00:00 CST

function isPeakTime(sec) {
  const bj = new Date(sec * 1000 + 8 * 3600 * 1000);
  if (sec >= WEEKEND_VALLEY_FROM_SEC) {
    const dow = bj.getUTCDay();
    if (dow === 0 || dow === 6) return false;   // 周末全天谷价
  }
  const h = bj.getUTCHours();
  return PEAK_HOURS.some(([s, e]) => h >= s && h < e);
}
```

峰谷提示：状态翻转时（进峰/出峰）触发 type:"peak" 条目 → 播放 slot.peakStart / slot.peakEnd。**受 `settings.peak.announce` 控制**（默认 true）；首次初始化只记录 `peakState`、不打扰。

### 8.4 提醒生命周期

到点 → 取 voice 池加权随机一句 → 冒气泡 + vibrate
     → 等确认（戳桌宠）
        ├ 确认 → 结束
        └ 超时 snoozeMin>0 → 重发一次（仅一次）
     → 休眠/进程被杀后恢复：不补发，合并为「错过了 N 次」

### 8.5 时间发言

type:"slot" → 进入时段时触发一次（once:true）；跨越时段由 1 秒 tick 检测，同一天只触发一次。

### 8.6 随机碎碎念（say.random）

`maybeChatter()` 在 tick 中调用，每 `settings.chatter.intervalMs`（默认 60000ms = 1 分钟）从 `say.random` 池按权重随机播报一条：

- 独立于戳击与峰谷；受 `settings.chatter.enabled` 开关控制。
- `runtime.chatterAt` 持久化，重启后不会立刻重复触发（首个周期只初始化计时）。
- 以 `PRIORITY.say` 发出，被更高优先级（remind / pet_say）占用时自动让位。

**`say.random` 权重设计（as-built）**：按「单条台词」均衡，而非按组。

| 组 | 条数 | 权重 | 单条概率 |
|---|---|---|---|
| 卖萌（好模型 / 好女孩） | 2 | 4 | ~8.7% |
| 碎碎念 | 6 | 12 | ~8.7% |
| 调侃 | 3 | 6 | ~8.7% |
| 彩蛋（哦鲸鲸） | 1 | 1 | ~4.3% |

> 权重和为 23（原为 7/7/3/1，因各组条数不同导致单条概率严重失衡）。所有普通台词单条出现概率基本均等，彩蛋保留为稀有项（约每 46 分钟一次）。改稀有度只需调 `DEFAULT_VOICE.pools['say.random'].groups[].w`。

---

## 9. AI_GUIDE.md（打包进包根目录）

```markdown
# AI 使用指南 · DeepSeek 桌宠

> 这份文件是给 AI 读的。你要改这个插件之前，先读完第 3、4 节。

## 1. 这个插件是什么
悬浮在系统层的桌宠。无设置界面，全部通过 pet: 系列工具配置。

## 2. 文件地图
| 路径 | 作用 | 可改 |
|---|---|---|
| settings.json | 全局配置 | 是 |
| schedule.json | 提醒与时段发言表 | 是 |
| voice.json | 台词池与气泡模板 | 是 |
| skins/<id>/ | 用户皮肤 | 是 |
| resources/native/overlay.dex | 原生宿主 | 否（需重编译） |
| native-src/ | dex 源码 | 可读 |

## 3. 能改清单
| 你想做的 | 用什么 |
|---|---|
| 换皮肤 / 加皮肤 | pet_set_skin / pet_install_skin |
| 改台词 / 加台词池 | pet_set_voice |
| 加提醒 | pet_reminder_add |
| 关掉峰谷提示 | pet_set_config |
| 让桌宠现在说一句 | pet_say |
| 换 API key | pet_set_api_key |
| 改尺寸 / 位置 | pet_set_config |

## 4. 不能改清单
| 你想做的 | 为什么 | 该怎么走 |
|---|---|---|
| 充电时换表情 | 需要新增感知 + 状态映射 | 改代码：JS 侧加电池监听 |
| 提醒递减音量 | 无音量系统 | 改代码：需新增模块 |
| 改悬浮窗行为本身 | 在 dex 里 | 改 native-src → 见 BUILD.md → 重烧录 |

## 5. 数据 Schema
（见设计文档第 6 节）

## 6. 自迭代流程
1. 改 sdcard 配置 → pet_reload 生效
2. 改插件代码 → 改 dev_package/<id>/ → debug_install_toolpkg 烧录
3. pet_status 验证

## 7. 禁忌
- 不要改 manifest 的 toolpkg_id / subpackage id
- 不要改 OverlayHost 的静态方法签名
- 不要往 native-src 引入第三方依赖

## 8. 版本
formatVersion: 1
```

---

## 10. 里程碑与待验证项

| # | 事项 | 状态 |
|---|---|---|
| M1 | overlay + 透明 WebView + 拖动 | **已通过**（2026-09-11） |
| M2 | JS setInterval 在 Operit 后台是否被节流 | 待验，决定调度放 JS 还是 native 心跳 |
| M3 | 两个 WebView 的内存开销 | 待验 |
| M4 | LayoutParams 构造重载匹配 | 已验，可用 |
| M5 | WebView 从 file:// 加载 sdcard 皮肤 | 待验，兜底为 base64 内联 |
| M6 | 设备内重编译 dex | **已打通**（JDK17 + android.jar + r8，见 BUILD 记录） |

### M1 实测结论

- 透明 overlay WebView **可行**：TYPE_APPLICATION_OVERLAY + FLAG_NOT_FOCUSABLE + PixelFormat.TRANSLUCENT
- **JS 引擎跑在 OperitQuickJsRuntime 后台线程，没有 Looper** → overlay 必须在 native 侧 Handler(Looper.getMainLooper()).post 里创建。这是 dex 方案的根本理由。
- 跨线程静态字段读回存在可见性问题：petView 等字段必须加 volatile，否则 JS 侧读到旧值（M1 中曾出现 visible:false 但窗口实际已显示）
- 子包 → IPC → main → dex 静态方法 的完整链路验证通过
- 设备内编译链已跑通：javac(source/target 8) + d8 --min-api 26 --lib android.jar

### 设备内编译环境（已就绪）

工具位置：/tmp/m1/（JDK17 apt 安装；android.jar 12.9MB；r8.jar 9.4.17 / 20.6MB）
依赖源：repo1.maven.org（Maven Central）、dl.google.com（Google Maven）、cdn.jsdelivr.net
注意：Operit 的文件类工具与 debug_install_toolpkg 依赖 Shizuku，需保持 Shizuku 运行

---

## 11. 实际实现记录（as-built，2026-09-11）

> 用户决定：M1 验证已足够，跳过 M2/M3/M5 的预先验证，直接全面开发。
> 以下记录实现与设计的偏差，以及实测结论。

### 11.1 与设计的偏差

| 项 | 设计 | 实际 | 原因 |
|---|---|---|---|
| 包 ID | `com.<作者>.deskpet` | **`com.deskpet`** | 避免与内置 `com.operit.*` 混淆 |
| OverlayHost 入参 | `show(ctx, jsonString)` | **强类型参数** | android.jar(API16) 无 org.json；native 不引第三方库，输入改用 int/String/bool，输出手工拼 JSON |
| 壳 HTML | `assets/shell-*.html` | **main.js 内联生成** | 由 skin 配置动态生成，避免多一次资源读取与 token 替换 |
| 皮肤图片加载 | file:// 或 base64 | **base64 data URI** | 规避 WebView file 访问风险（M5 直接略过） |
| 气泡窗口 | 独立窗口、`FLAG_NOT_TOUCHABLE` | 一致（未验证 M3 内存） | — |
| 调度器 | 待定（JS 或 native 心跳） | **JS setInterval(1000)** + native 备用 tick | M1 已证 setInterval 可用 |
| 配置 I/O | `Tools.Files` | **Java I/O（java.io）** | 不依赖 Shizuku，运行时确认在 Operit 进程内可直接读写 sdcard |

### 11.2 实测结论（设备内）

- 宿主加载：`ToolPkg.readResource` → `Java.loadDex` → `Java.type('com.deskpet.OverlayHost')` 全链路可用。
- 双窗口：宠物窗（touchable）+ 气泡窗（NOT_TOUCHABLE）同时创建成功；气泡独立显示/自动收起正常。
- **volatile 修复验证通过**：`getState()` 现能实时反映 `visible=true`、`tick` 递增（M1 的可见性 bug 已修）。
- `applyConfig` 运行时改尺寸即时生效（110dp→150dp：w 358px→488px）。
- 配置落盘：`/sdcard/Download/Operit/plugins/com.deskpet/{settings,schedule,voice,state}.json` 全部有效 JSON。
- 余额：未配 key 时安全返回 `{ok:false,error:"no_api_key"}`，不崩、不冒错泡。
- 18 个工具全部注册成功（`pet:` 前缀），IPC 子包↔main 双向通。

### 11.3 待用户侧确认

- 戳的 Q 弹延迟是否已可接受（已改为 native 即时触发）
- 鲸鱼拖到屏幕顶部时，气泡是否改为显示在鲸鱼正下方（小间隙）
- 拖动跟手与位置持久化（已确认跟手；position 已写入 settings.json）

### 11.4 未做的验证（已按最保守方案实现，留待后续按需回归）

- M2 JS 定时器后台节流：调度器已放 JS（现 250ms tick），native 已保留 tick 兜底。
- M3 双 WebView 内存：未测；若过高可把气泡退回 native 绘制。
- M5 file:// 皮肤：未测；已用 base64 内联规避。

### 11.5 调试期缺陷修复记录（实机）

1. **形象只显示一半身体**
   - 根因：内置 `assets/skins/whale/pet.png` 是**截断文件**（42124B，仓库真实 255988B），zlib 流不完整（`incomplete or truncated stream`），WebView 只能解码上半部分。
   - 修复：改用 Operit 原生 `download_file` 通道重新下载完整 PNG 覆盖（`super_admin` 终端里的 curl 访问 raw.githubusercontent / cdn.jsdelivr 均不可用）。**教训：设备内下载大文件优先用 `download_file`。**

2. **戳/拖动全无反馈**
   - 根因 A（事件识别）：native `SLOP_PX=9`（位移平方），即**位移 >3px 就判为拖动**，手指轻点几乎必被判成拖动，不产生 poke。→ 改为运行时按密度计算的 `slopPx = 12dp`。
   - 根因 B（渲染）：两个 WebView **从未 `setJavaScriptEnabled(true)`**（Android 默认关闭 JS）。鲸鱼是 `<img>` 不受影响，故能显示；但 Q 弹的 `PetBridge.setState()` 与气泡的 `PetBridge.showBubble()` 全是空操作 → 气泡窗口"可见但全透明"。→ 两个 WebView 均开启 JS + DOM Storage。**教训：native 状态标志（`bubbleShown`）≠ 实际渲染，排查视觉问题必须以肉眼/渲染结果为准。**

3. **Q 弹反应慢**
   - 根因：戳的视觉反馈放在 JS 轮询里（`TICK_MS=1000`），最坏延迟 1s。
   - 修复：`ACTION_UP` 时由 native **立即** `petEvalDirect("setState('press')")` 并 300ms 后复位（`idleAnim`）；JS 侧不再负责按压动画，只负责台词。`TICK_MS` 由 1000 降到 250ms。

4. **气泡出现位置（固定锚定鲸鱼左上角）**
   - 早期问题：气泡位置被单独夹取边界（`by<0 → 0`），鲸鱼上移时气泡被钉在屏幕边缘而与鲸鱼脱开 → 出现间隔。
   - 最终实现（按需求）：**永远固定锚定在鲸鱼左上角，不翻转**：
     - 锚点 `anchorX = petX + 0.12*size`、`anchorY = petY + 0.10*size`。
     - `bx = anchorX - bubbleWpx/2`（仅水平夹取 ≥0，保证文字不被左边缘裁掉）。
     - `by = anchorY - bubbleHpx + 0.10*bubbleHpx`（**不夹取 y**）→ 气泡底边恒在锚点附近，任何拖动位置都不会与鲸鱼脱开。
     - 代价：鲸鱼非常靠顶时，气泡会向上超出屏幕被裁切（"永远左上角"的必然结果，已与用户确认）。
   - 同时：鲸鱼拖动夹取在屏幕内，避免把鲸鱼拖出屏幕丢失。

5. **震动不可用（环境限制，非缺陷）**
   - Operit 自身未声明 `android.permission.VIBRATE`，应用无法申请未声明的权限，故 `vibrate` 抛 `SecurityException`。已在 native `doVibrate` 前加权限检查并静默跳过，避免污染 `lastError`。**该限制无法从插件侧绕过，需宿主补权限声明。**

6. **余额凭证（As-built）**
   - 密钥来源：沙盒环境变量 `DEEPSEEK_API_KEY`，由 `pet:pet_set_api_key` 写入；`readApiKey()` 读取后拼 `Authorization: Bearer`，请求 `https://api.deepseek.com/user/balance`（GET）。
   - 已验证（脱敏）：`apiKeyPresent` 为真、`balanceCache` 返回有效余额（数值不记录）、`failStreak:0`、时段判定正确。
   - **发布约定：包内不包含任何真实 Key。** Key 由用户首次使用时自行配置（见子包 `METADATA.env` 声明的 `DEEPSEEK_API_KEY`，或调用 `pet:pet_set_api_key`），仅写入本机环境变量，不随包分发。

7. **「复用平台凭证」可行性调研（结论：不可行）**
   - 沙盒可通过 `SoftwareSettings.listModelConfigs()` 读取平台模型配置，但 `ModelConfigResultItem` 仅暴露脱敏字段（`apiKeySet` / `apiKeyPreview`，如 `sk-****`），**不含明文 Key**。
   - 明文 Key 存于 app 私有目录（`/data/data/com.ai.assistance.operit/...`），当前环境为 Shizuku（无 root），访问 `Permission denied`；`sdcard/Download/Operit/backup/*.yaml.bak` 中的 `DEEPSEEK_API_KEY` 与模型配置所用 Key 并不一致，且属备份、可能滞后。
   - `Chat.call()` 可借用平台 Key 发起调用，但仅支持对话语义，无法命中 DeepSeek `/user/balance`（非 chat 接口）。
   - 结论：余额查询仍需独立配置 Key；如需免手填，应改由宿主侧提供「凭证读取」或「HTTP 代理」接口。

### 11.6 正式版打磨记录（as-built，2026-09-12）

本轮为发布前的功能收尾，共四项改动，均已编码、`node --check` 通过、设备内重烧录并实机验证。

1. **多窗口缺陷根治（屏幕上多个小鲸鱼）**
   - 根因：反复重装 / 重载产生多个 JS 引擎，各自 `Java.loadDex` 加载一份 dex、持有独立静态 `petView`/`bubbleView`，旧引擎窗口未回收。
   - 排查中被排除的三个错误假设：`WindowManagerGlobal.removeView/removeViewImmediate` 反射可用（实为隐藏 API 拦截，抛 `NoSuchMethodException`）；`isOverlayRoot` 反射读 `mWindowAttributes` 可用（实为被拦截恒 false）；「有父容器就不是 overlay」（本 ROM 上 addView 进 WM 的 View 也有 parent）。
   - 最终方案：`removeStaleOverlays(ctx)` 反射枚举 `WindowManagerGlobal.mRoots` → `getView()`；跳过当前 `petView`/`bubbleView`；`isStaleOverlay(root,view)` 按「空 tag + 是 WebView + 尺寸等于 `petSizePx` 或 `bubbleWpx×bubbleHpx`」判定，`isOverlayRoot` 仅作旧配置尺寸不符时的兜底；用**公开 API** `WindowManager.removeViewImmediate(View)` 移除；**多轮扫描**（最多 4 轮，因移除过程中 `mRoots` 会变动）。新增 `TAG_PET="deskpet_pet"`、`TAG_BUBBLE="deskpet_bubble"` 用于标识。
   - 诊断字段 `state.native.cleanup`（如 `passes=1 victims=0 roots=3`）是排查窗口问题的关键证据；修复后正常值只剩 `DecorView + deskpet_pet + deskpet_bubble`。

2. **取消「播报优先级提权」设计**
   - `PRIORITY` 删除 `timeslot:45`，现为 `{ pet_say:100, remind:80, balance:60, say:40 }`；`sayPool()` 取优先级简化为 `applyPriority==='remind' ? PRIORITY.remind : PRIORITY.say`。
   - 效果：`emitBubble` 判据为严格大于（`>`），改后播报与戳击同为 40，**戳击可正常覆盖正在显示的播报气泡**。

3. **自动播报通道收口**
   - 余额自动播报：`maybeRefreshBalance()` 在余额变化分支加 `balance.announce!==true` 提前 return（余额拉取与今日已用记账照常，仅跳过气泡）；默认 `balance.announce:false`。
   - 峰谷切换播报：先关闭（默认 false），后按用户要求**恢复为默认 `true`**（见 8.3）。
   - `greet` 池无调用点，启动不说话。至此「非戳击」的自动气泡只剩峰谷切换 + 随机碎碎念。

4. **新增随机碎碎念 + 权重优化**
   - 新增 `maybeChatter()`（见 8.6），使原本无触发源的 4 组台词（卖萌/碎碎念/调侃/彩蛋）按权重定时随机播报一条（间隔默认 1 分钟，可配）。
   - `say.random` 组权重 `7/7/3/1 → 4/12/6/1`，按「单条台词」均衡（普通台词均约 8.7%，彩蛋约 4.3%）。
   - 配置项：`chatter.{enabled, intervalMs}`；运行态 `chatterAt` 记录在 `state.json`。

5. **自启动修复（应用启动带起桌宠）—— 含「冷启动钩子引擎边界」攻坚**
   - 现象：重启 Operit 后桌宠不自动出现（多轮复现）。
   - 排查过程（逐层定位）：
     1. 原实现只注册 `application_on_create`，而该事件可能在包（main.js）被加载、钩子注册**之前**就已派发，钩子永远错过 → 改为同时注册 `application_on_create` + `application_on_foreground` + `activity_on_resume` 三个事件（对齐已验证可行插件 `com.lioran.eyepet`）。
     2. 钩子已触发但桌宠仍不出现 → `boot.log` 显示回调进入、`ensureInit()` 却静默失败 → 判定为 rejected promise 被永久缓存 → `ensureInit()` 失败时清空 `initPromise` 允许重试；`init()` 内 `applySkin` / `showPet` / `maybeHintSetupKey` 各自 try/catch。
     3. 仍失败 → `boot.log` 拿到确切错误 `Error: package/toolpkg runtime target is empty`，且 30s 后重试依旧 → 判定**冷启动早期被派发钩子的那个 JS 引擎自始至终未绑定「包运行时」**：包作用域 API（`ToolPkg.*`）不可用，但同一引擎内 `Java.type(...)` / `java.io.*` **可用**（`logBoot` 用 `java.io.File` 成功写文件为证，是判断「该引擎能做什么」的可靠探针）。
   - 最终方案：
     - 回调改为 `tryBoot()` 轮询式拉起：每 5s 重试、最多 24 次（约 2 分钟），分级日志 `retry@N` / `show-ok@N` / `give-up@N`。
     - tick 看门狗：每 10s 检查 `nativeState().visible`，丢失则补 `showPet()`。
     - `ensureHost()` 不再依赖包 API 加载 dex：① 先试 `ToolPkg.readResource(DEX_KEY,'overlay.dex',true)`（正常引擎可用）；② 失败则回退读 sdcard 缓存 `cfgDir/overlay.dex`；③ `Java.loadDex` + `Java.type(HOST_CLASS)` + `Java.getApplicationContext()`；④ 成功后用 `javaCopyFile` 把包内 dex 复制到 sdcard 缓存，供后续冷启动钩子引擎回退。
     - 关键：`ToolPkg.readResource` 返回的是应用私有缓存路径（`…/cache/Operit/cleanOnExit/overlay.dex`），**退出即清理**，故冷启动时必不存在；sdcard 缓存副本是自启成功的必要条件（需正常引擎跑过一次以预热缓存）。
   - **JS 桥两个坑（均表现为 `StackOverflowError`，务必回避）**：
     - 不要跨桥传 `byte[]`（`Files.readAllBytes` / `Files.write`）→ 桥重载解析递归。
     - 不要用 `java.nio.file.Path`（`Path` 实现 `Iterable<Path>`，桥递归展开成数组）→ `Files.copy(Paths.get(...))` 亦炸。
     - 正解：`java.io.File` + 流的实例方法，复制全程留在 Java 侧（`FileInputStream.newInstance(File.newInstance(src))` + `ins.transferTo(outs)`，退路为通道 `transferTo`）。
   - 实测：2026-09-12 冷启动（杀进程重开）桌宠自动出现，`boot.log` 记录 `res-fallback → host-ok`；切后台再回前台亦正常恢复且仍为单窗口。经验已沉淀至记忆库（`[平台] Operit ToolPkg 自启动与冷启动钩子引擎边界`）。

> 编译部署流程不变：改 JS 用 `debug_install_toolpkg(source_path=...)` 重装；改 native 需先重编 dex（javac + D8，见 BUILD.md）。注意插件存在「已安装副本」与「dev_package 源」两份，`pet_reload` 只读已安装副本。本轮验证：`pet358=1`、`bubble748=1`、`cleanup roots=3`、`hostReady:true`、戳击 `lastSayPool` 符合预期、随机碎碎念实测触发成功、`chatter.intervalMs=60000`（1 分钟）、**冷启动自启动实测通过**（`boot.log` 记录 `res-fallback → host-ok`，sdcard dex 缓存 `…/com.deskpet/overlay.dex` 已生成）。


6. **自启动资源兜底（1.2.3~1.2.6 迭代）—— “冷启动可见但音效丢失”修复**
   - 现象：冷启动时桌宠能自动出现，但点击音效缺失；且失败被静默缓存，之后永不恢复。
   - 根因链（三轮定位）：
     1. 冷启动早期派发钩子的引擎里 `ToolPkg.readResource` 不可用（`runtime target is empty`）。皮肤因 `loadSkin` **先读 sdcard**（`cfgDir/skins/<id>/`）而幸免；音效 `loadSfx` 只有“读包内”一条路，失败后 `sfxPressUri` 空置。
     2. `init()` 内 `showPet()` 的失败被 try/catch 吞掉 → `initPromise` 被缓存为成功 → `tryBoot` 后续 24 次轮询全部复用旧 promise，不再重跑 `applySkin` / `loadSfx`。
     3. 窗口建立后 `tryBoot` 见到 `visible=true` 直接短路，没有任何触发点去补资源。
   - 修复（与 dex 缓存同一套思路）：
     - `loadSfx()` 读到包内资源后**缓存到 `cfgDir/sfx/`**；包内不可用时回退读 sdcard 缓存。缓存按**字节数比对**，包内资源更新后自动刷新。
     - `showPet()` 内置兜底：`skin` 为空现场补 `applySkin`；音效为空补 `loadSfx`；窗口已存在且本次补齐了资源时刷新一次 `setPetHtml`。
     - `tryBoot()` 不再对 `visible=true` 短路，每轮都过一次幂等的 `showPet()` 以补齐资源。
     - `init()` 中“资源类失败”（`assetsMissing`）改为抛出以清空 `initPromise`，让后续轮询真正重跑初始化；非资源类失败（如无悬浮窗权限）仍静默不重试。
   - 实测：2026-09-20 冷启动（杀进程）自动出现且音效正常，`boot.log` 记录 `sfx press-ok release-ok → res-fallback → host-ok → show-ok → init-ok`。
