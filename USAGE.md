# 使用文档（重点：TM Core Runtime + 12.js 场景）

> 这份文档专门回答“这个怎么使用”。
> 如果你只看 3 分钟，请先看 **快速开始**。

---

## 1. 快速开始（最推荐）

### 1.1 你需要启用哪些脚本

在 Tampermonkey 里按顺序启用：

1. `tm-core-runtime.user.js`（必须先启）
2. `jdy-12-core-plugin-template.user.js`（推荐，12.js 场景骨架）

> 如果你暂时不用 Core 插件模式，也可以只用 `12.js` / `jdy-check-template.user.js` 单脚本模式。

### 1.2 最少要改哪些配置

打开 `jdy-12-core-plugin-template.user.js`，只改 `CONFIG` 这 4 块：

- `tableEntityKeyCandidates`
- `fields`
- `compareRules`
- `watchUrlPatterns`

改完保存，刷新 `https://tf.jdy.com/*` 页面即可生效。

---

## 2. 两种使用模式（你选一个就行）

## 模式 A：单脚本模式（上手快）

可选脚本：

- `12.js`
- 或 `jdy-check-template.user.js`

特点：

- 一份脚本就能跑（有拦截按钮 + banner/modal）。
- 适合“先跑起来再说”的阶段。

你主要改：

- `fields`
- `tableEntityKeyCandidates`
- `compareRules`
- `actionWhitelist`

## 模式 B：Core + 插件模式（长期维护推荐）

脚本组合：

- `tm-core-runtime.user.js`
- `jdy-12-core-plugin-template.user.js`

特点：

- Core 负责通用能力（fetch/xhr 拦截、工具函数、插件生命周期）。
- 插件只写业务规则，后续扩展更稳。
- 适合你现在这种“功能越来越多”的场景。

---

## 3. 关键配置怎么填

下面示例是“按单据类型 + 编码/类别”做条件比较。

```js
compareRules: [
  {
    id: 'sale-fabric-number',
    enabled: true,
    formTypeIncludes: ['销售出库单'],
    codeIncludes: ['A', 'B'],
    categoryIncludes: ['面料'],
    compareAs: 'number'
  },
  {
    id: 'purchase-text',
    enabled: true,
    formTypeIncludes: ['采购入库单'],
    codeIncludes: [],
    categoryIncludes: [],
    compareAs: 'text'
  }
]
```

比较说明：

- `compareAs: 'number'`：按数值比较（会做小数精度处理）。
- `compareAs: 'text'`：按文本规范化后比较（去多空格）。

数值误差建议：

- `decimalPlaces: 6`
- `epsilon: 1e-6`

这样可以规避“前端看起来一样，后台存很多小数位”的误判。

---

## 4. 针对你提的 5 个问题，这套脚本是怎么处理的

1. **切换单据识别错误**
   - 用 `tableEntityKeyCandidates` + 字段兜底扫描（不是只盯一个 key）。
2. **切换后表头表体识别不到**
   - 识别条件是 `dataindex + rows`，并按字段索引读取。
3. **动态输入难识别**
   - 单脚本模式里会尽量通过请求/响应及事件刷新数据；
   - Core 插件模式建议优先监听核心 load/save 相关接口。
4. **文本/数值混合比较**
   - 通过规则指定 `compareAs: 'text' | 'number'`。
5. **按单据类型 + 商品编码/类别过滤比较**
   - 通过 `compareRules` 的 `formTypeIncludes / codeIncludes / categoryIncludes` 组合实现。

---

## 5. 调试方法（很重要）

## 5.1 开启 debug

在脚本里把：

```js
CONFIG.debug = true
```

你会在控制台看到命中规则和异常详情。

## 5.2 常用排查顺序

1. 先确认 core 是否存在：

```js
window.__TM_CORE_RUNTIME__
```

2. 再确认插件是否注册：

```js
window.__TM_CORE_RUNTIME__?.state?.plugins
```

3. 在 Network 看是否命中你配置的 `watchUrlPatterns`。
4. 检查 `fields.left/right/code/category` 是否与当前单据 `dataindex` 一致。

---

## 6. 常见问题 FAQ

### Q1：为什么没提示？

通常是以下原因：

- URL 没命中 `watchUrlPatterns`。
- `fields` 配错，读不到 `left/right`。
- `compareRules` 没命中（例如单据类型关键字不包含）。

### Q2：提示太多，影响录单

- 缩小 `watchUrlPatterns`。
- 增加 `compareRules` 的过滤条件。
- 先把 `debug` 关掉。

### Q3：我想先只提示，不拦截动作

- 优先用 `jdy-12-core-plugin-template.user.js`（默认 toast 提示）。
- 需要强拦截时再切到 `12.js / jdy-check-template.user.js` 的拦截模式。

---

## 7. 推荐落地方式（给你当前阶段）

1. 第 1 周：先用 `jdy-12-core-plugin-template.user.js` 做“提示式校验”，把规则跑准。
2. 第 2 周：规则稳定后，再把关键动作拦截开启（使用 `12.js` / `jdy-check-template.user.js`）。
3. 后续：新场景都走 Core 插件化，避免一个大脚本越来越难维护。

