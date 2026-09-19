# AI 使用指南 · DeepSeek 桌宠

> 这份文件是给 AI 读的。你要改这个插件之前，先读完第 3、4 节。

## 1. 这个插件是什么

悬浮在系统层的桌宠（overlay + 透明 WebView）。**没有设置界面**，全部通过 `pet:` 系列工具配置。
使用者想改任何东西，都必须通过 AI 调工具完成。

- 包 ID：`com.deskpet`，子包 ID：`pet`（18 个工具，前缀 `pet_`）
- 配置目录：`/sdcard/Download/Operit/plugins/com.deskpet/`
- 逻辑 100% 在 JS（main.js + packages/pet.js）；dex 只做窗口/触摸/渲染承载。

## 2. 文件地图

| 路径 | 作用 | 可改 |
|---|---|---|
| `settings.json` | 全局配置（尺寸/皮肤/气泡/余额/峰谷） | 是 |
| `schedule.json` | 调度表：提醒 point / interval / slot / peak | 是 |
| `voice.json` | 台词池（加权随机）与气泡模板 | 是 |
| `state.json` | 运行时状态（poke 计数/余额缓存/峰谷态） | 一般不改 |
| `skins/<id>/skin.json` | 用户皮肤定义 | 是 |
| `skins/<id>/<图片>` | 用户形象图 | 是 |
| `resources/native/overlay.dex` | 原生宿主 | 否（需重编译） |
| `native-src/OverlayHost.java` | dex 源码 | 可读 |
| `native-src/BUILD.md` | 重编译说明 | 可读 |

## 3. 能改清单

| 你想做的 | 用什么工具 |
|---|---|
| 换皮肤 / 加皮肤 | `pet_set_skin` / `pet_install_skin` |
| 改台词 / 加台词池 | `pet_set_voice` |
| 加提醒 | `pet_reminder_add`（改/删用 `pet_reminder_update` / `pet_reminder_remove`） |
| 关掉 / 打开峰谷提示 | `pet_set_config` → `{peak:{announce:false}}` |
| 让桌宠现在说一句 | `pet_say` |
| 让桌宠隐藏 / 唤醒 | 用户**长按桌宠约 2 秒**隐藏；唤醒用 `pet_show`（见第 9 节） |
| 换 API key | `pet_set_api_key`（写入环境变量 DEEPSEEK_API_KEY） |
| 改尺寸 / 贴边 / 气泡时长 | `pet_set_config` |
| 重载配置 | `pet_reload` |
| 查状态 / 查余额 | `pet_status` / `pet_balance_check` |

## 4. 不能改清单

| 你想做的 | 为什么 | 该怎么走 |
|---|---|---|
| 充电时换表情 | 需要新增「感知 + 状态映射」 | 改代码：在 main.js 加电池监听 + 状态 |
| 提醒递减音量 | 无音量系统（气泡不可发声） | 改代码：需新增模块 |
| 改悬浮窗行为本身（触摸判定/窗口类型） | 在 dex 里 | 改 `native-src/OverlayHost.java` → 见 BUILD.md → 重烧录 |
| 改工具名字 / 去掉工具 | 在 packages/pet.js 的 METADATA 里 | 改 pet.js → 重新烧录 |

## 5. 数据 Schema（速查）

### settings.json
```jsonc
{
  "formatVersion": 1,
  "pet":    { "sizeDp": 110, "skin": "whale", "visible": true, "position": null, "snapToEdge": false },
  "bubble": { "durationMs": 5200, "maxWidthDp": 230 },
  "schedule": { "enabled": true },
  "balance": { "provider": "deepseek", "endpoint": "https://api.deepseek.com/user/balance",
               "refreshIntervalMs": 120000, "connectTimeoutMs": 20000, "readTimeoutMs": 20000,
               "silenceAfterFailures": 3 },
  "peak": { "announce": true, "weekendValley": true }
}
```

### schedule.json 条目
| 字段 | 说明 |
|---|---|
| type | `point` 每天定点 / `interval` 间隔 / `slot` 时段进入 / `peak` 峰谷切换（内置） |
| output | `remind` 需戳桌宠确认 / `say` 只说 |
| voice | 台词池 id（如 `remind.meal`） |
| at / days | point：`"12:30"` + `daily|weekday|weekend` |
| everyMin / window | interval：间隔分钟 + `["08:00","23:00"]` |
| from / to / once | slot：时段 |
| snoozeMin | remind 未确认多久后再响一次；0=不重发 |

### voice.json
- `pools.<id> = { weights:[...], lines:[...] }`，加权随机。
- `bubble.<kind>` 是气泡行模板数组：`{t:文本, s:样式档, c:可选颜色}`。
- 模板变量：`{name} {balance} {currency} {peakText} {peakColor} {time} {pokes} {text}`
- 样式档：`label` / `amount` / `period` / `hint`（字号与颜色来自 skin.json）。

### skin.json
- `asset`：图片文件名；`press`：按压 Q 弹参数；`bubble.palette` 与 `bubble.styles`：气泡视觉。
- 样式字号是相对气泡画布 **1026** 的虚拟单位，等比缩放。

## 6. 自迭代流程

1. 改 sdcard 配置 → `pet_reload` 生效（或直接调相应 `pet_*` 工具）。
2. 改插件代码 → 改 `dev_package/deskpet/` → `debug_install_toolpkg` 重新烧录。
3. `pet_status` 验证宿主/皮肤/配置是否正常。

## 7. 禁忌

- 不要改 manifest 的 `toolpkg_id` / 子包 `id`（会导致配置目录与工具前缀失配）。
- 不要改 `OverlayHost` 的静态方法签名（main.js 依赖它）。
- 不要往 `native-src` 引入第三方依赖（编译环境只有 android.jar）。
- 不要删 `resources/native/overlay.dex`。

## 8. 版本

- formatVersion: 1
- 宿主接口见 `native-src/OverlayHost.java` 注释。

## 9. 长按隐藏 / AI 唤醒（重要交互）

- **长按桌宠约 2 秒** → 桌宠先冒一条气泡「记得让ai唤醒我哦」，随后**隐藏**。
- 隐藏后**不会自动复活**：`settings.pet.visible` 被置为 `false`，冷启动钩子 / 看门狗 / 重载都尊重该标志。
- **只有 AI 调用 `pet_show` 才能把它再唤醒**（会同步把 `visible` 置回 `true`）。
- 普通点按（戳一下）仍是戳击，**不会**隐藏；拖动也不触发长按。
- 实现：长按判定在 native（`OverlayHost.java` 的 `LONG_PRESS_MS = 2000`，按下超时且未拖动则置 `pendingLongPress`），JS 在 `onTick` 消费该事件后执行 `handleLongPress()`。
- 想改**长按时长**：改 `native-src/OverlayHost.java` 的 `LONG_PRESS_MS` → 按 BUILD.md 重编译 dex → 重烧录。
- 想改**提示语 / 气泡停留时长**：改 `main.js` 的 `LONG_PRESS_HIDE_TEXT` / `LONG_PRESS_BUBBLE_MS`（纯 JS，无需重编译）。
