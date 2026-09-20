> **【本仓库说明 · 修复与优化分支】**
>
> - 本仓库是 Operit ToolPkg「DeepSeek 桌宠」(包名 `com.deskpet`) 的 **社区修复与优化分支**，版本 **1.0.3**（正式版）。
> - **来源**：来源为社区流传的 `com.deskpet` 包（**未找到公开作者 / 原始仓库**：经 GitHub 全局代码搜索、Operit 相关市场仓库检索均无结果）。若您是原作者或知晓出处，欢迎提交 Issue 告知，我们会补全署名或按您的要求处理。
> - **本分支的修复**：冷启动不自动启动、冷启动后点击音效丢失等（详见 `CHANGELOG-FIXES.md`）。
> - 渲染基线与原设计保持一致；`native` 层（OverlayHost.java / overlay.dex）未改动。
> - 包内原文档（`AI_GUIDE.md` / `DESIGN.md` / `LICENSE`）保持原样。

---

## 原 README（原文如下）

# DeepSeek 桌宠 (Desk Pet)

一个悬浮在系统层的 Operit 桌宠插件：**可自定义形象与台词**，支持**定时提醒**、**DeepSeek 余额查询**与**峰谷提示**。

- **没有设置界面**，全部通过 AI 工具配置（`pet:` 系列，18 个）。
- 形象（皮肤）与台词全部可替换；配置在 sdcard 上可读、可被 AI 编辑。
- 逻辑 100% 在 JS；dex 只负责窗口 / 触摸 / 渲染承载，不含业务。

## 安装

1. 把整个目录通过 `debug_install_toolpkg` 烧录，或打成 `.toolpkg` 放入
   `/sdcard/Android/data/com.ai.assistance.operit/files/packages/`。
2. 启用包 `com.deskpet` 与其子包 `pet`。
3. 调用 `pet_status` 检查运行状态。

## 首次使用：配置 API Key（可选）

桌宠的**余额 / 峰谷查询**需要 DeepSeek API Key；未配置也能正常使用形象、台词、提醒等其它功能。

- 方式一：让 AI 调用 `pet_set_api_key {key:"sk-你的Key"}` —— 仅写入**本机环境变量**，不入包。
- 方式二：在 Operit 的环境变量设置里为 `DEEPSEEK_API_KEY` 填写（子包已声明该变量）。
- Key 在 https://platform.deepseek.com 申请。**包内不含任何 Key**，每位用户只在本机配置一次。

## 快速上手（AI 工具）

- `pet_status` — 看状态
- `pet_say {text:"你好呀"}` — 让它说一句
- `pet_reminder_add {entry:{id:"water",type:"interval",everyMin:120,window:["08:00","23:00"],output:"remind",voice:"remind.water",enabled:true}}` — 加喝水提醒
- `pet_set_api_key {key:"sk-..."}` — 配置余额查询
- `pet_balance_check {force:true}` — 查余额

## 配置位置

`/sdcard/Download/Operit/plugins/com.deskpet/`

- `settings.json` / `schedule.json` / `voice.json` / `state.json`
- `skins/<id>/` 用户皮肤（`skin.json` + 图片）

## 目录结构

```
manifest.json
main.js                     # 包级逻辑
packages/pet.js             # 18 个 AI 工具
resources/native/overlay.dex
native-src/OverlayHost.java # 原生宿主源码
native-src/BUILD.md         # 重编译说明
assets/shell 由 main.js 内联生成
assets/skins/whale/         # 内置皮肤
assets/voices/default.json  # 默认台词参考
AI_GUIDE.md                 # 给 AI 的说明书（拆包即见）
```

## 协议

MIT（见 LICENSE）。内置默认形象「小鲸鱼女仆」为本项目自带素材；视觉参数与默认台词风格取材于
[MeteorNOX/DeepSeek-Balance-Whale-Widget](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget)（MIT）。
架构思路参考 [Vael-KY/AI-Live-Overflow](https://github.com/Vael-KY/AI-Live-Overflow)（CC BY-NC-SA 4.0）。

## 修改原生层

见 `native-src/BUILD.md`。
