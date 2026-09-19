/* METADATA
{
  "name": "pet",
  "description": { "zh": "桌宠控制：形象、台词、提醒、余额与运行", "en": "Desk pet control: skin, lines, reminders, balance, runtime" },
  "enabledByDefault": true,
  "env": [
    {
      "name": "DEEPSEEK_API_KEY",
      "description": {
        "zh": "DeepSeek API Key，用于余额与峰谷查询（可留空，仅此功能不可用）。在 platform.deepseek.com 申请。",
        "en": "DeepSeek API Key, used for balance & peak/valley lookup (optional; only this feature is disabled if empty). Obtain at platform.deepseek.com."
      },
      "required": false
    }
  ],
  "tools": [
    { "name": "pet_status", "description": { "zh": "读取桌宠完整状态：可见性/位置/宿主/配置/皮肤/余额缓存/峰谷", "en": "Read full pet status" }, "parameters": [] },

    { "name": "pet_get_config", "description": { "zh": "读取全局配置 settings.json；可指定 section（pet/bubble/schedule/balance/peak）", "en": "Get global config" },
      "parameters": [ { "name": "section", "type": "string", "description": "可选，配置分区名", "required": false } ] },

    { "name": "pet_set_config", "description": { "zh": "合并写入全局配置（深合并，只改提供的字段）。例：{patch:{pet:{sizeDp:130}}}", "en": "Merge global config" },
      "parameters": [ { "name": "patch", "type": "object", "description": "要合并的配置片段", "required": true } ] },

    { "name": "pet_show", "description": { "zh": "显示桌宠悬浮窗（若已显示则无操作）", "en": "Show the pet overlay" }, "parameters": [] },
    { "name": "pet_hide", "description": { "zh": "隐藏桌宠悬浮窗", "en": "Hide the pet overlay" }, "parameters": [] },

    { "name": "pet_list_skins", "description": { "zh": "列出内置与用户皮肤", "en": "List skins" }, "parameters": [] },

    { "name": "pet_set_skin", "description": { "zh": "切换当前皮肤（需已存在）", "en": "Switch current skin" },
      "parameters": [ { "name": "id", "type": "string", "description": "皮肤 ID", "required": true } ] },

    { "name": "pet_install_skin", "description": { "zh": "安装/覆盖一套皮肤：写入 skin.json 与图片（imageBase64 可选）", "en": "Install a skin" },
      "parameters": [
        { "name": "id", "type": "string", "description": "皮肤 ID", "required": true },
        { "name": "skin", "type": "object", "description": "skin.json 内容（可选，缺省用默认模板）", "required": false },
        { "name": "imageBase64", "type": "string", "description": "形象图片的 base64（不含 data: 前缀）", "required": false },
        { "name": "imageExt", "type": "string", "description": "图片扩展名，默认 png", "required": false }
      ] },

    { "name": "pet_get_voice", "description": { "zh": "读取台词配置 voice.json", "en": "Get voice config" }, "parameters": [] },

    { "name": "pet_set_voice", "description": { "zh": "合并写入台词配置（深合并）", "en": "Merge voice config" },
      "parameters": [ { "name": "voice", "type": "object", "description": "要合并的 voice 片段", "required": true } ] },

    { "name": "pet_reminder_list", "description": { "zh": "列出全部调度条目（提醒/时段/峰谷）", "en": "List reminders" }, "parameters": [] },

    { "name": "pet_reminder_add", "description": { "zh": "新增一条调度条目（需含唯一 id）", "en": "Add a reminder" },
      "parameters": [ { "name": "entry", "type": "object", "description": "条目对象，例：{id,type:'point',at:'12:30',days:'daily',output:'remind',voice:'remind.meal',snoozeMin:10,enabled:true}", "required": true } ] },

    { "name": "pet_reminder_update", "description": { "zh": "按 id 局部更新一条调度条目", "en": "Update a reminder" },
      "parameters": [
        { "name": "id", "type": "string", "description": "条目 ID", "required": true },
        { "name": "patch", "type": "object", "description": "要合并的字段", "required": true }
      ] },

    { "name": "pet_reminder_remove", "description": { "zh": "按 id 删除一条调度条目", "en": "Remove a reminder" },
      "parameters": [ { "name": "id", "type": "string", "description": "条目 ID", "required": true } ] },

    { "name": "pet_say", "description": { "zh": "让桌宠立刻说一句指定台词（不落库，说完即焚）", "en": "Make the pet say something now" },
      "parameters": [
        { "name": "text", "type": "string", "description": "要说的内容", "required": true },
        { "name": "durationMs", "type": "number", "description": "气泡停留毫秒（可选）", "required": false }
      ] },

    { "name": "pet_balance_check", "description": { "zh": "查询 DeepSeek 余额（force=true 跳过缓存）；返回余额/币种/峰谷/是否静默", "en": "Check DeepSeek balance" },
      "parameters": [ { "name": "force", "type": "boolean", "description": "是否强制刷新", "required": false } ] },

    { "name": "pet_set_api_key", "description": { "zh": "写入 DEEPSEEK_API_KEY 环境变量（非明文落盘于配置文件）", "en": "Set DeepSeek API key" },
      "parameters": [ { "name": "key", "type": "string", "description": "API Key", "required": true } ] },

    { "name": "pet_reload", "description": { "zh": "从磁盘重载全部配置并重建界面", "en": "Reload config from disk" }, "parameters": [] }
  ]
}
*/

'use strict';

function go(channel, payload) {
  try {
    return Promise.resolve(ToolPkg.ipc.call(channel, payload)).then(function (r) {
      complete(r);
    }).catch(function (e) {
      complete({ ok: false, error: String(e) });
    });
  } catch (e) {
    complete({ ok: false, error: String(e) });
    return null;
  }
}

exports.pet_status = function () { return go('pet.status', {}); };

exports.pet_get_config = function (params) {
  params = params || {};
  return go('pet.get_config', { section: params.section });
};

exports.pet_set_config = function (params) {
  params = params || {};
  return go('pet.set_config', { patch: params.patch || {} });
};

exports.pet_show = function () { return go('pet.show', {}); };
exports.pet_hide = function () { return go('pet.hide', {}); };
exports.pet_list_skins = function () { return go('pet.list_skins', {}); };

exports.pet_set_skin = function (params) {
  params = params || {};
  return go('pet.set_skin', { id: params.id });
};

exports.pet_install_skin = function (params) {
  params = params || {};
  return go('pet.install_skin', {
    id: params.id,
    skin: params.skin,
    imageBase64: params.imageBase64,
    imageExt: params.imageExt
  });
};

exports.pet_get_voice = function () { return go('pet.get_voice', {}); };

exports.pet_set_voice = function (params) {
  params = params || {};
  return go('pet.set_voice', { voice: params.voice || {} });
};

exports.pet_reminder_list = function () { return go('pet.reminder_list', {}); };

exports.pet_reminder_add = function (params) {
  params = params || {};
  return go('pet.reminder_add', { entry: params.entry });
};

exports.pet_reminder_update = function (params) {
  params = params || {};
  return go('pet.reminder_update', { id: params.id, patch: params.patch || {} });
};

exports.pet_reminder_remove = function (params) {
  params = params || {};
  return go('pet.reminder_remove', { id: params.id });
};

exports.pet_say = function (params) {
  params = params || {};
  return go('pet.say', { text: params.text, durationMs: params.durationMs });
};

exports.pet_balance_check = function (params) {
  params = params || {};
  return go('pet.balance_check', { force: !!params.force });
};

exports.pet_set_api_key = function (params) {
  params = params || {};
  return go('pet.set_api_key', { key: params.key });
};

exports.pet_reload = function () { return go('pet.reload', {}); };