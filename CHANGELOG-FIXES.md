# deskpet 修复与优化说明（1.0.3 · 正式版）

对本地 com.deskpet 的修复迭代记录。所有改动均遵守包内 AI_GUIDE.md 约束（不扩大范围、保持渲染基线）。

## 修复

### 1. 冷启动不自动启动（核心）
- 现象：杀进程重开 Operit，桌宠不自动出现。
- 根因：`init()` 内 `showPet()` 失败被 try/catch 吞掉 → `initPromise` 被缓存为“已成功” → `tryBoot` 后续 24 次轮询全部复用旧 promise，不再重跑 `applySkin`；且窗口建立后 `tryBoot` 对 `visible=true` 直接短路，导致“冷启动早期以缺资源状态建出的窗口”永不修复。
- 修复：
  - `showPet()` 内置资源兜底：`skin` 为空现场补 `applySkin`；音效为空补 `loadSfx`；已可见且刚补齐资源时刷新一次 `setPetHtml`。
  - `tryBoot()` 不再对 `visible=true` 短路，每轮都过一次幂等的 `showPet()`。
  - `init()` 对资源类失败（`assetsMissing`）抛出以清空 `initPromise`，让轮询真正重跑；非资源类失败（如无悬浮窗权限）仍静默。
  - 包加载完成后补一次延迟 `tryBoot('register_late')`（生命周期钩子常在包加载前派发完毕）。

### 2. 冷启动后点击音效丢失
- 现象：自启动成功，但按下/松开音效缺失且永不恢复。
- 根因：冷启动早期派发钩子的引擎里 `ToolPkg.readResource` 不可用；皮肤因 `loadSkin` 先读 sdcard 而幸免，音效 `loadSfx` 只有“读包内”一条路，失败后永久空置。
- 修复：`loadSfx()` 读到包内资源后缓存到 `cfgDir/sfx/`；包内不可用时回退读 sdcard 缓存（与 dex/皮肤同一套思路）。缓存按字节数比对，资源更新后自动刷新。

## 优化
- `install_skin` 增加 base64 预校验，非法时提前返回明确错误（`bad_image_base64`）。
- `emitBubble` 可见性判断写法统一（`settings.pet && settings.pet.visible === false`）。
- `runSchedule` slot 分支冗余合并；`tryBoot` 尾部冗余合并。
- `DESIGN.md` 新增「自启动资源兜底（1.0.x 迭代）」章节。

## 保持不变
- 渲染基线：三层 DOM（#bob/#jump/#pet）+ wp-tap 弹跳 + 合成层三件套，严格对齐原设计。
- native 层（OverlayHost.java / overlay.dex）未改动；用户配置结构未改动。

## 交付物
- `com.deskpet-v1.0.3.toolpkg` — 完整包，可直接烧录或放入 packages 目录。
- 涉及文件：`main.js`、`manifest.json`、`DESIGN.md`。
