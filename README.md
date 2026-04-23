# JDY 用户脚本模板仓库

这个仓库用于沉淀两类内容：

1. 你后续给我的“原始可用脚本存档（original）”。
2. 基于原始脚本抽象出的“可复用模板脚本（template）”。

## 当前文件

- `jdy-check-template.user.js`：通用字段一致性校验模板（拦保存/提交/审核等关键动作）。
- `12.js`：当前联调版字段一致性脚本（与 `jdy-check-template.user.js` 同步）。
- `jdy-auto-workflow-template.user.js`：通用自动流程模板（切页签、修正表格、删空行、保存确认）。
- `jdy-auto-edit-11111.original.user.js`：自动修改表格脚本（original 存档）。
- `jdy-order-stock-injector.original.user.js`：订单汇总注入即时库存脚本（original 存档）。
- `jdy-order-stock-injector-template.user.js`：订单汇总注入即时库存（可配置模板）。
- `jdy-inventory-meter-injector.original.user.js`：库存查询表注入米数脚本（original 存档）。
- `jdy-inventory-meter-injector-template.user.js`：库存查询表注入米数（可配置模板）。
- `jdy-dev-dict-v18.original.user.js`：开发字典助手 V18（original 存档）。
- `jdy-dev-dict-v18-template.user.js`：开发字典助手 V18（可配置模板）。
- `gangqinpu-unlocker-v7.original.user.js`：虫虫钢琴解锁脚本 V7（original 存档）。
- `gangqinpu-unlocker-template.user.js`：虫虫钢琴解锁脚本（可配置模板）。
- `tm-core-runtime.user.js`：Core 运行时（插件注册、fetch/xhr拦截、公共工具）。
- `jdy-field-check-plugin.user.js`：基于 Core 的 JDY 字段校验插件示例。
- `jdy-12-core-plugin-template.user.js`：12.js 场景 Core 插件骨架（按单据类型/编码/类别条件比对）。
- `jdy-unit-check-v1.2.0.original.user.js`：双单位换算校验 1.2.0（original 存档）。
- `jdy-unit-check-v1.2.0-template.user.js`：双单位换算校验 1.2.0（可配置模板）。


## Core + Plugin 架构（新）

已新增可扩展内核：

- `tm-core-runtime.user.js` 提供：
  - `registerPlugin(name, plugin)`
  - `hookFetchJson(handler)` / `hookXhrJson(handler)`
  - `deepWalk / safeJsonParse / normalizeText / toNumber / showToast`
- `jdy-field-check-plugin.user.js` 为示例插件（依赖 Core）。

> 使用顺序：先启用 `tm-core-runtime.user.js`，再启用插件脚本。

- 推荐：12.js 场景可直接使用 `jdy-12-core-plugin-template.user.js`，重点修改其 `CONFIG.fields` 与 `CONFIG.compareRules`。

## 如何复用模板（建议）

### A) 字段一致性模板（`jdy-check-template.user.js`）

主要改 `CONFIG`：

- `tableEntityKeyCandidates`
- `fields`（`seq/name/code/left/right`）
- `actionWhitelist`
- `uiText`

### B) 自动流程模板（`jdy-auto-workflow-template.user.js`）

主要改 `CONFIG`：

- `workflow`：定义步骤顺序（切页签 / 修表格 / 保存）
- `tabs`：页签选择器和激活 class
- `grid`：列索引与删除行规则

### C) 库存注入模板（`jdy-order-stock-injector-template.user.js`）

主要改 `CONFIG`：

- `inventoryUrlKeywords` / `possibleBusinessKeywords`
- `orderGridKeys`
- `stockFieldCandidates` / `stockFieldFallback`
- `injectField` / `injectHeader` / `injectAfterCandidates`


### D) 库存米数注入模板（`jdy-inventory-meter-injector-template.user.js`）

主要改 `CONFIG`：

- `formKey` / `gridKey`
- `field.code` / `field.qty` / `field.convertOverride`
- `codePrefix`（按物料编码前缀筛选）
- `decimalPlaces` / `maxAutoPages`


### E) 开发字典模板（`jdy-dev-dict-v18-template.user.js`）

主要改 `CONFIG`：

- `storageKey` / `version` / `maxHits`
- `pollingUrlPattern`（抓包入口）
- `backendNamePattern` / `rootNamePattern`（分类规则）
- `ui.title` / `ui.position`


### F) 虫虫钢琴解锁模板（`gangqinpu-unlocker-template.user.js`）

主要改 `CONFIG`：

- `showJumpOnlyWhenUrlIncludes` / `playerUrlRegex`
- `modeParam` / `modeLabels`
- `hiddenSelectorsOnScreen` / `hiddenSelectorsOnPrint`
- `removeBeforePrintSelectors`


### G) 双单位换算 1.2 模板（`jdy-unit-check-v1.2.0-template.user.js`）

主要改 `CONFIG`：

- `allowedBtnKeys` / `allowedIds` / `allowedOpk`
- `maxPopupItems`
- 规则逻辑：`spec > formula`（强拦截）、`spec < formula`（提示确认）

> 建议：每次给新脚本时都“先存档 `*.original.user.js`”，再产出一个 `*-template.user.js` 可配置版本。


## 使用文档

- 详细使用说明见：`USAGE.md`（包含快速开始、Core+插件模式、12.js 场景配置、FAQ）。

## 安装方式

1. 安装 Tampermonkey。
2. 新建脚本，复制对应 `.user.js` 文件内容。
3. 打开 `https://tf.jdy.com/*` 页面运行。

## 调试入口

- `window.__JDY_CHECK_TEMPLATE__`
- `window.__JDY_AUTO_WORKFLOW__`
- `window.KD_DEV_V18`
- `window.__GANGQINPU_UNLOCKER__`
- `window.__TM_CORE_RUNTIME__`
- `window.__JDY_UNIT_CHECK__`
