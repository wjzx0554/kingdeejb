// ==UserScript==
// @name         金蝶精斗云-规则面板终版
// @namespace    http://tampermonkey.net/
// @version      4.8.0
// @description  基于当前HAR重构：当前单据识别、字段抓取、按钮抓取、动态输入增量合并、保存前重查
// @author       ChatGPT
// @match        *://tf.jdy.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  // =========================================================
  // 一、常量
  // =========================================================
  const STORAGE_KEY = '__JDY_RULE_PANEL_CONFIG_V480__';

  const STYLE_ID = '__jdy_rule_panel_style__';
  const FAB_ID = '__jdy_rule_panel_fab__';
  const PANEL_WRAP_ID = '__jdy_rule_panel_wrap__';
  const PANEL_ID = '__jdy_rule_panel__';
  const BANNER_ID = '__jdy_rule_banner__';
  const MODAL_ID = '__jdy_rule_modal__';

  // =========================================================
  // 二、默认配置
  // =========================================================
  const DEFAULT_CONFIG = {
    debug: false,

    entityKey: 'material_entity',

    preferredFields: [
      'seq',
      'material_name',
      'materialid',
      'material_model',
      'conversionrate',
      'qty',
      'auxqty',
      'baseunit',
      'baseqty',
      'billdate'
    ],

    customFields: [],

    buttonsCatalog: [],

    rules: [
      {
        id: uid(),
        name: '规格大于换算 => 拦截',
        enabled: true,
        action: 'block',
        matchMode: 'all',
        scopeType: 'all',
        scopeValue: '',
        conditions: [
          {
            id: uid(),
            leftField: 'material_model',
            leftTransform: 'firstNumber',
            operator: 'gt',
            rightType: 'field',
            rightField: 'conversionrate',
            rightTransform: 'formulaRightNumber',
            rightValue: ''
          }
        ]
      },
      {
        id: uid(),
        name: '规格小于换算 => 提示',
        enabled: true,
        action: 'warn',
        matchMode: 'all',
        scopeType: 'all',
        scopeValue: '',
        conditions: [
          {
            id: uid(),
            leftField: 'material_model',
            leftTransform: 'firstNumber',
            operator: 'lt',
            rightType: 'field',
            rightField: 'conversionrate',
            rightTransform: 'formulaRightNumber',
            rightValue: ''
          }
        ]
      }
    ],

    ui: {
      maxPopupItems: 50,
      bannerHideMs: 1500
    },

    messages: {
      bannerTitle: '检测到规则命中',
      blockTitle: '当前单据不能继续操作',
      blockDesc: '检测到命中“拦截”规则的明细，请先修改后再继续操作。',
      warnTitle: '请确认是否继续操作',
      warnDesc: '检测到命中“提示”规则的明细，系统允许继续，但建议先核对。',
      blockButtonText: '我知道了',
      warnBackButtonText: '返回修改',
      warnContinueButtonText: '继续操作'
    }
  };

  // =========================================================
  // 三、状态
  // =========================================================
  const state = {
    config: loadConfig(),

    latestPayload: null,
    latestEntity: null,

    latestFieldCatalog: {},
    latestHeadFieldCatalog: {},
    latestHeadValues: {},
    latestButtonCatalog: [],
    latestButtonHintKeys: [],
    latestPageScopes: [],

    lastSeenFormMeta: {
      formId: '',
      formName: '',
      appId: '',
      pageId: '',
      seenAt: 0
    },

    currentPageMeta: {
      formId: '',
      formName: '',
      appId: '',
      pageId: '',
      source: ''
    },

    latestBodyEditDeltas: {},
    latestHeadEditDeltas: {},
    activeBodyRowZeroIndex: null,

    liveRows: [],

    blockItems: [],
    warnItems: [],
    lastDataHash: '',

    bannerDismissedAt: 0,
    lastInterceptAt: 0,

    bypassRoot: null,
    bypassUntil: 0,
    bypassRemaining: 0,

    panelOpen: false,
    panelDirty: false
  };

  // =========================================================
  // 四、基础工具
  // =========================================================
  function uid() {
    return 'id_' + Math.random().toString(36).slice(2, 10);
  }

  function clone(obj) {
    return JSON.parse(JSON.stringify(obj));
  }

  function normalizeText(val) {
    return String(val == null ? '' : val).replace(/\s+/g, ' ').trim();
  }

  function escapeHtml(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function safeJsonParse(text) {
    try {
      return JSON.parse(text);
    } catch (e) {
      return null;
    }
  }

  function num(v) {
    if (typeof v === 'number') return v;
    const n = Number(v);
    return Number.isNaN(n) ? NaN : n;
  }

  function log() {
    if (state.config.debug) {
      console.log('[JDY-规则面板]', ...arguments);
    }
  }

  function debounce(fn, wait) {
    let timer = null;
    return function () {
      clearTimeout(timer);
      const args = arguments;
      const ctx = this;
      timer = setTimeout(() => fn.apply(ctx, args), wait);
    };
  }

  function deepWalk(node, visitor, seen = new WeakSet()) {
    if (!node || typeof node !== 'object') return;
    if (seen.has(node)) return;
    seen.add(node);

    visitor(node);

    if (Array.isArray(node)) {
      for (const item of node) deepWalk(item, visitor, seen);
    } else {
      for (const key of Object.keys(node)) deepWalk(node[key], visitor, seen);
    }
  }

  function pickDisplayValue(v) {
    if (v == null) return '';

    if (Array.isArray(v)) {
      return normalizeText(v[1] != null ? v[1] : v[0]);
    }

    if (typeof v === 'object') {
      if ('zh_CN' in v) return normalizeText(v.zh_CN);
      return normalizeText(JSON.stringify(v));
    }

    return normalizeText(v);
  }

  function isElementVisible(el) {
    if (!(el instanceof Element)) return false;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    if (el.offsetParent === null && style.position !== 'fixed') return false;
    return true;
  }

  function parseQueryString(url) {
    try {
      const u = new URL(url, location.origin);
      const obj = {};
      u.searchParams.forEach((v, k) => {
        obj[k] = v;
      });
      return obj;
    } catch (e) {
      return {};
    }
  }

  function bodyToString(body) {
    if (typeof body === 'string') return body;
    if (body instanceof URLSearchParams) return body.toString();
    return '';
  }

  function parseFormBody(body) {
    const str = bodyToString(body);
    if (!str) return {};
    const obj = {};
    str.split('&').forEach(pair => {
      const idx = pair.indexOf('=');
      if (idx === -1) return;
      const k = decodeURIComponent(pair.slice(0, idx));
      const v = decodeURIComponent(pair.slice(idx + 1));
      obj[k] = v;
    });
    return obj;
  }

  function formIdToName(formId) {
    const map = {
      sal_bill_order: '销售订单',
      sal_out_stock: '销售出库单',
      sal_return_order: '销售退货单',
      pur_bill_order: '采购订单',
      stk_bill_in: '采购入库单',
      stk_bill_out: '其他出库单',
      batch_fill_entry_stock: '批量填充仓库',
      inv_pick_bill: '拣货单'
    };
    return map[formId] || '';
  }

  function parseFormIdFromText(text) {
    const t = normalizeText(text);
    if (!t) return '';

    const regs = [
      /(sal_[a-z0-9_]+)/i,
      /(pur_[a-z0-9_]+)/i,
      /(stk_[a-z0-9_]+)/i,
      /(inv_[a-z0-9_]+)/i,
      /(batch_fill_entry_stock)/i
    ];

    for (const reg of regs) {
      const m = t.match(reg);
      if (m && m[1]) return m[1];
    }

    return '';
  }

  function parseAnalyticsFormMeta(body) {
    const text = bodyToString(body);
    const result = {
      formId: '',
      formName: '',
      appId: '',
      pageId: ''
    };

    if (!text) return result;

    let m = text.match(/"ptl":"([^"|]+)\|([^"]+)"/);
    if (m) {
      result.appId = m[1] || '';
      result.formId = m[2] || '';
    }

    m = text.match(/"formId":"([^"]+)"/);
    if (m && m[1]) result.formId = m[1];

    m = text.match(/"formName":"([^"]+)"/);
    if (m && m[1]) result.formName = m[1];

    m = text.match(/"pageId":"([^"]+)"/);
    if (m && m[1]) result.pageId = m[1];

    if (!result.formName && result.formId) {
      result.formName = formIdToName(result.formId);
    }

    return result;
  }

  function tryParseParamsJsonFromBody(body) {
    try {
      const obj = parseFormBody(body);
      if (!obj.params) return null;
      return JSON.parse(obj.params);
    } catch (e) {
      return null;
    }
  }

  function parseActionContextFromRequest(url, body) {
    const result = {
      activeBodyRowZeroIndex: null
    };

    try {
      const q = parseQueryString(url);
      const ac = q.ac || '';
      const params = tryParseParamsJsonFromBody(body);

      if (!params || !Array.isArray(params)) return result;

      params.forEach(item => {
        if (!item || typeof item !== 'object') return;

        if (ac === 'entryRowClick') {
          if (Array.isArray(item.args) && typeof item.args[0] === 'number') {
            result.activeBodyRowZeroIndex = item.args[0];
          }
        }

        if (Array.isArray(item.postData)) {
          item.postData.forEach(pd => {
            if (pd && pd.material_entity && typeof pd.material_entity.row === 'number') {
              result.activeBodyRowZeroIndex = pd.material_entity.row;
            }
          });
        }
      });
    } catch (e) {
      log('parseActionContextFromRequest fail', e);
    }

    return result;
  }

  function parseFormMetaFromRequest(url, body) {
    const q = parseQueryString(url);
    const b = parseFormBody(body);

    const result = {
      formId: '',
      formName: '',
      appId: '',
      pageId: ''
    };

    if (q.f) result.formId = q.f;
    if (q.appId) result.appId = q.appId;
    if (q.pageId) result.pageId = q.pageId;

    if (!result.appId && b.appId) result.appId = b.appId;
    if (!result.pageId && b.pageId) result.pageId = b.pageId;

    if (!result.formName && result.formId) {
      result.formName = formIdToName(result.formId);
    }

    if (!result.formId || !result.formName) {
      const fromTrack = parseAnalyticsFormMeta(body);
      if (!result.appId && fromTrack.appId) result.appId = fromTrack.appId;
      if (!result.formId && fromTrack.formId) result.formId = fromTrack.formId;
      if (!result.formName && fromTrack.formName) result.formName = fromTrack.formName;
      if (!result.pageId && fromTrack.pageId) result.pageId = fromTrack.pageId;
    }

    return result;
  }

  function mergeLatestSeenFormMeta(meta) {
    if (!meta) return;

    const next = { ...state.lastSeenFormMeta };

    if (meta.formId) next.formId = meta.formId;
    if (meta.formName) next.formName = meta.formName;
    if (meta.appId) next.appId = meta.appId;
    if (meta.pageId) next.pageId = meta.pageId;

    if (next.formId && !next.formName) {
      next.formName = formIdToName(next.formId);
    }

    next.seenAt = Date.now();
    state.lastSeenFormMeta = next;
  }

  function mergeLatestActionContext(ctx) {
    if (!ctx) return;
    if (typeof ctx.activeBodyRowZeroIndex === 'number' && ctx.activeBodyRowZeroIndex >= 0) {
      state.activeBodyRowZeroIndex = ctx.activeBodyRowZeroIndex;
    }
  }

  function clearDocumentCaches() {
    state.latestPayload = null;
    state.latestEntity = null;
    state.latestFieldCatalog = {};
    state.latestHeadFieldCatalog = {};
    state.latestHeadValues = {};
    state.latestBodyEditDeltas = {};
    state.latestHeadEditDeltas = {};
    state.liveRows = [];
    state.blockItems = [];
    state.warnItems = [];
    state.lastDataHash = '';
    removeBanner();
  }

  // =========================================================
  // 五、当前单据识别
  // =========================================================
  function getDomCurrentFormMeta() {
    const result = {
      formId: '',
      formName: '',
      appId: '',
      pageId: '',
      source: ''
    };

    // 1）优先看 common_tool / common_content 的 data-page-id
    const domAnchors = Array.from(document.querySelectorAll(
      '#common_tool[data-page-id], #common_content[data-page-id], [data-page-id*="_common_tool"], [data-page-id*="_common_content"]'
    )).filter(isElementVisible);

    for (const el of domAnchors) {
      const pid = normalizeText(el.getAttribute('data-page-id'));
      const formId = parseFormIdFromText(pid);
      if (formId) {
        result.formId = formId;
        result.formName = formIdToName(formId);
        result.pageId = pid;
        result.source = 'dom-page-id';
        return result;
      }
    }

    // 2）再看标题/页签文本
    const textNodes = Array.from(document.querySelectorAll('[title], ._8CrArYyY, .ant-tabs-tab-active, .el-tabs__item.is-active'))
      .filter(isElementVisible)
      .map(el => normalizeText(el.getAttribute('title') || el.textContent))
      .filter(Boolean);

    const known = {
      销售订单: 'sal_bill_order',
      采购订单: 'pur_bill_order',
      销售出库单: 'sal_out_stock',
      采购入库单: 'stk_bill_in',
      拣货单: 'inv_pick_bill'
    };

    for (const t of textNodes) {
      if (known[t]) {
        result.formName = t;
        result.formId = known[t];
        result.source = 'dom-title';
        return result;
      }
    }

    return result;
  }

  function computeCurrentPageMeta() {
    const domMeta = getDomCurrentFormMeta();
    if (domMeta.formId || domMeta.formName) return domMeta;

    const seen = state.lastSeenFormMeta;
    if ((seen.formId || seen.formName) && Date.now() - (seen.seenAt || 0) < 30000) {
      return {
        formId: seen.formId || '',
        formName: seen.formName || formIdToName(seen.formId || ''),
        appId: seen.appId || '',
        pageId: seen.pageId || '',
        source: 'recent-request'
      };
    }

    return {
      formId: '',
      formName: '',
      appId: '',
      pageId: '',
      source: ''
    };
  }

  function syncCurrentPageMeta() {
    const prevFormId = state.currentPageMeta.formId || '';
    const nextMeta = computeCurrentPageMeta();

    if (nextMeta.formId && prevFormId && nextMeta.formId !== prevFormId) {
      clearDocumentCaches();
    }

    if (nextMeta.formId || nextMeta.formName || nextMeta.pageId) {
      state.currentPageMeta = nextMeta;
    }
  }

  function getLikelyPageCnName() {
    syncCurrentPageMeta();
    if (normalizeText(state.currentPageMeta.formName)) return normalizeText(state.currentPageMeta.formName);
    if (normalizeText(state.currentPageMeta.formId)) return formIdToName(state.currentPageMeta.formId) || state.currentPageMeta.formId;
    return '当前单据页';
  }

  function getPageContext() {
    syncCurrentPageMeta();

    const pageIds = Array.from(document.querySelectorAll('[data-page-id]'))
      .filter(isElementVisible)
      .map(el => normalizeText(el.getAttribute('data-page-id')))
      .filter(Boolean);

    return {
      url: location.href,
      title: document.title || '',
      pageIds,
      formId: normalizeText(state.currentPageMeta.formId),
      formName: normalizeText(state.currentPageMeta.formName)
    };
  }

  // =========================================================
  // 六、规则 / 转换
  // =========================================================
  const TRANSFORMS = [
    { value: 'raw', label: '原文本' },
    { value: 'trim', label: '去空格文本' },
    { value: 'lower', label: '小写文本' },
    { value: 'upper', label: '大写文本' },
    { value: 'firstNumber', label: '提取第一个数字' },
    { value: 'formulaRightNumber', label: '提取换算右值' },
    { value: 'length', label: '文本长度' }
  ];

  const OPERATORS = [
    { value: 'gt', label: '>' },
    { value: 'lt', label: '<' },
    { value: 'ge', label: '>=' },
    { value: 'le', label: '<=' },
    { value: 'eq', label: '=' },
    { value: 'ne', label: '!=' },
    { value: 'contains', label: '包含' },
    { value: 'notContains', label: '不包含' },
    { value: 'regex', label: '正则匹配' }
  ];

  const ACTION_OPTIONS = [
    { value: 'block', label: '拦截' },
    { value: 'warn', label: '提示' },
    { value: 'pass', label: '放行' }
  ];

  const MATCH_MODE_OPTIONS = [
    { value: 'all', label: '全部条件都满足（AND）' },
    { value: 'any', label: '任一条件满足（OR）' }
  ];

  const RIGHT_TYPE_OPTIONS = [
    { value: 'field', label: '字段' },
    { value: 'value', label: '固定值' }
  ];

  const SCOPE_OPTIONS = [
    { value: 'all', label: '全部单据页生效' },
    { value: 'formIdEq', label: '单据类型(formId)等于（推荐）' },
    { value: 'formNameContains', label: '单据中文名包含（推荐）' },
    { value: 'pageIdIncludes', label: '页面ID包含' },
    { value: 'urlIncludes', label: 'URL包含（备用）' },
    { value: 'pageTitleIncludes', label: '页面标题包含（备用）' }
  ];

  function extractFirstNumber(text) {
    const t = normalizeText(text);
    const m = t.match(/-?\d+(?:\.\d+)?/);
    return m ? Number(m[0]) : null;
  }

  function extractFormulaRightNumber(text) {
    const t = normalizeText(text).replace(/，/g, ',');
    let m = t.match(/[=＝]\s*(-?\d+(?:\.\d+)?)/);
    if (m) return Number(m[1]);
    const nums = t.match(/-?\d+(?:\.\d+)?/g);
    if (nums && nums.length >= 2) return Number(nums[1]);
    return null;
  }

  function applyTransform(value, transformName) {
    const raw = normalizeText(value);

    switch (transformName) {
      case 'raw': return value == null ? '' : String(value);
      case 'trim': return raw;
      case 'lower': return raw.toLowerCase();
      case 'upper': return raw.toUpperCase();
      case 'firstNumber': return extractFirstNumber(raw);
      case 'formulaRightNumber': return extractFormulaRightNumber(raw);
      case 'length': return raw.length;
      default: return raw;
    }
  }

  function compareValues(left, operator, right) {
    switch (operator) {
      case 'gt': return num(left) > num(right);
      case 'lt': return num(left) < num(right);
      case 'ge': return num(left) >= num(right);
      case 'le': return num(left) <= num(right);
      case 'eq': return String(left) === String(right);
      case 'ne': return String(left) !== String(right);
      case 'contains': return String(left).includes(String(right));
      case 'notContains': return !String(left).includes(String(right));
      case 'regex':
        try {
          return new RegExp(String(right)).test(String(left));
        } catch (e) {
          return false;
        }
      default:
        return false;
    }
  }

  function severity(action) {
    if (action === 'block') return 3;
    if (action === 'warn') return 2;
    return 1;
  }

  function ruleMatchesScope(rule) {
    const ctx = getPageContext();
    const value = normalizeText(rule.scopeValue);

    switch (rule.scopeType) {
      case 'all':
        return true;
      case 'formIdEq':
        return !value || ctx.formId === value;
      case 'formNameContains':
        return !value || ctx.formName.includes(value);
      case 'pageIdIncludes':
        return !value || ctx.pageIds.some(id => id.includes(value));
      case 'urlIncludes':
        return !value || ctx.url.includes(value);
      case 'pageTitleIncludes':
        return !value || ctx.title.includes(value);
      default:
        return true;
    }
  }

  // =========================================================
  // 七、字段目录 / 按钮目录（按 HAR 学到的结构）
  // =========================================================
  function findEntity(root) {
    let found = null;

    deepWalk(root, (obj) => {
      if (found) return;

      if (
        obj &&
        obj.k === state.config.entityKey &&
        obj.data &&
        obj.data.dataindex &&
        Array.isArray(obj.data.rows)
      ) {
        found = obj.data;
        return;
      }

      if (
        obj &&
        obj.dataindex &&
        Array.isArray(obj.rows) &&
        (
          Object.prototype.hasOwnProperty.call(obj.dataindex, 'material_model') ||
          Object.prototype.hasOwnProperty.call(obj.dataindex, 'conversionrate') ||
          Object.prototype.hasOwnProperty.call(obj.dataindex, 'qty')
        )
      ) {
        found = obj;
      }
    });

    return found;
  }

  function hasCreateGridColumns(root) {
    let yes = false;
    deepWalk(root, (obj) => {
      if (obj && obj.key === state.config.entityKey && obj.methodname === 'createGridColumns') {
        yes = true;
      }
    });
    return yes;
  }

  function hasHeadMetadata(root) {
    let yes = false;
    deepWalk(root, (obj) => {
      if (obj && obj.a === 'updateControlMetadata' && Array.isArray(obj.p)) {
        yes = true;
      }
    });
    return yes;
  }

  function isFullPayload(root) {
    const entity = findEntity(root);
    if (entity && entity.dataindex && Array.isArray(entity.rows) && Object.keys(entity.dataindex).length > 5) {
      return true;
    }
    if (entity && (hasCreateGridColumns(root) || hasHeadMetadata(root))) {
      return true;
    }
    return false;
  }

  function buildFieldCatalogFromPayload(root) {
    const catalog = {};

    function putField(key, label, sample, source) {
      if (!key) return;

      if (!catalog[key]) {
        catalog[key] = {
          key,
          label: label || key,
          sample: sample || '',
          source: source || ''
        };
      } else {
        if (label && (!catalog[key].label || catalog[key].label === catalog[key].key)) {
          catalog[key].label = label;
        }
        if (sample && !catalog[key].sample) {
          catalog[key].sample = sample;
        }
      }
    }

    // 1）列定义：createGridColumns
    deepWalk(root, (obj) => {
      if (
        obj &&
        obj.key === state.config.entityKey &&
        obj.methodname === 'createGridColumns' &&
        Array.isArray(obj.args) &&
        obj.args[0] &&
        Array.isArray(obj.args[0].columns)
      ) {
        obj.args[0].columns.forEach(col => {
          const key = col?.dataIndex;
          const label = col?.header?.zh_CN || col?.editor?.caption?.zh_CN;
          putField(key, label, '', 'gridColumns');
        });
      }
    });

    // 2）页面配置里也有 dataIndex/header/editor.type
    deepWalk(root, (obj) => {
      if (
        obj &&
        typeof obj === 'object' &&
        typeof obj.dataIndex === 'string' &&
        obj.header &&
        obj.header.zh_CN
      ) {
        putField(obj.dataIndex, obj.header.zh_CN, '', 'columnMeta');
      }
    });

    // 3）material_entity visible/init keys
    deepWalk(root, (obj) => {
      if (
        obj &&
        obj.init === true &&
        Array.isArray(obj.keys)
      ) {
        obj.keys.forEach(k => {
          if (Array.isArray(k) && k[0] === 'material_entity' && typeof k[1] === 'string') {
            putField(k[1], k[1], '', 'visibleKeys');
          }
        });
      }
    });

    // 4）dataindex
    const entity = findEntity(root);
    if (entity && entity.dataindex) {
      Object.keys(entity.dataindex).forEach(key => {
        putField(key, key, '', 'dataindex');
      });

      if (Array.isArray(entity.rows) && entity.rows[0]) {
        const row = entity.rows[0];
        Object.keys(entity.dataindex).forEach(key => {
          const idx = entity.dataindex[key];
          putField(key, catalog[key]?.label || key, pickDisplayValue(row[idx]), 'sample');
        });
      }
    }

    // 5）用户手工字段
    (state.config.customFields || []).forEach(f => {
      putField(f.key, f.label || f.key, '', 'custom');
    });

    return catalog;
  }

  function buildHeadFieldCatalogFromPayload(root) {
    const catalog = {};

    function putField(key, label, sample, source) {
      if (!key) return;
      if (key === 'material_entity' || key === 'express_entity') return;

      if (!catalog[key]) {
        catalog[key] = {
          key,
          label: label || key,
          sample: sample || '',
          source: source || ''
        };
      } else {
        if (label && (!catalog[key].label || catalog[key].label === catalog[key].key)) {
          catalog[key].label = label;
        }
        if (sample && !catalog[key].sample) {
          catalog[key].sample = sample;
        }
      }
    }

    // updateControlMetadata 交替数组：key + meta.caption.zh_CN
    deepWalk(root, (obj) => {
      if (obj && obj.a === 'updateControlMetadata' && Array.isArray(obj.p)) {
        for (let i = 0; i < obj.p.length - 1; i++) {
          const key = obj.p[i];
          const meta = obj.p[i + 1];

          if (
            typeof key === 'string' &&
            meta &&
            typeof meta === 'object' &&
            meta.caption &&
            meta.caption.zh_CN
          ) {
            putField(key, meta.caption.zh_CN, '', 'updateControlMetadata');
          }
        }
      }
    });

    // 表头值
    deepWalk(root, (obj) => {
      if (Array.isArray(obj)) {
        obj.forEach(item => {
          if (
            item &&
            typeof item === 'object' &&
            !Array.isArray(item) &&
            typeof item.k === 'string' &&
            Object.prototype.hasOwnProperty.call(item, 'v')
          ) {
            if (item.k !== 'material_entity' && item.k !== 'express_entity') {
              putField(item.k, catalog[item.k]?.label || item.k, pickDisplayValue(item.v), 'head-value');
            }
          }
        });
      }
    });

    return catalog;
  }

  function buildHeadValuesFromPayload(root) {
    const values = {};

    deepWalk(root, (obj) => {
      if (Array.isArray(obj)) {
        obj.forEach(item => {
          if (
            item &&
            typeof item === 'object' &&
            !Array.isArray(item) &&
            typeof item.k === 'string' &&
            Object.prototype.hasOwnProperty.call(item, 'v')
          ) {
            if (item.k !== 'material_entity' && item.k !== 'express_entity') {
              values[item.k] = pickDisplayValue(item.v);
            }
          }
        });
      }
    });

    return values;
  }

  function buildButtonHintKeysFromPayload(root) {
    const found = new Set();

    deepWalk(root, (obj) => {
      if (
        obj &&
        typeof obj === 'object' &&
        Array.isArray(obj.keys)
      ) {
        obj.keys.forEach(k => {
          if (typeof k === 'string') {
            if (
              /^bar_/.test(k) ||
              /^special_save$/.test(k) ||
              /^generated_by_bom$/.test(k) ||
              /^btn_/.test(k)
            ) {
              found.add(k);
            }
          }
        });
      }
    });

    return Array.from(found);
  }

  function getSortedFields() {
    const arr = Object.values(state.latestFieldCatalog || {});
    const preferred = state.config.preferredFields || [];

    arr.sort((a, b) => {
      const ai = preferred.indexOf(a.key);
      const bi = preferred.indexOf(b.key);
      if (ai !== -1 && bi !== -1) return ai - bi;
      if (ai !== -1) return -1;
      if (bi !== -1) return 1;
      return String(a.label).localeCompare(String(b.label), 'zh-CN');
    });

    return arr;
  }

  function buildFieldOptions(fieldList) {
    return fieldList.map(f => ({
      value: f.key,
      label: `${f.label} (${f.key})`
    }));
  }

  function isHeadField(fieldKey) {
    return Object.prototype.hasOwnProperty.call(state.latestHeadFieldCatalog || {}, fieldKey);
  }

  function isBodyField(fieldKey) {
    return Object.prototype.hasOwnProperty.call(state.latestFieldCatalog || {}, fieldKey);
  }

  function getAnyFieldLabel(fieldKey) {
    if (isHeadField(fieldKey)) {
      const f = state.latestHeadFieldCatalog[fieldKey];
      return `[表头] ${f.label} (${f.key})`;
    }

    if (isBodyField(fieldKey)) {
      const f = state.latestFieldCatalog[fieldKey];
      return `[表体] ${f.label} (${f.key})`;
    }

    const custom = (state.config.customFields || []).find(x => x.key === fieldKey);
    if (custom) return `${custom.label || custom.key} (${custom.key})`;

    return fieldKey;
  }

  function getHeadFieldValue(fieldKey) {
    if (Object.prototype.hasOwnProperty.call(state.latestHeadEditDeltas, fieldKey)) {
      return state.latestHeadEditDeltas[fieldKey];
    }
    return state.latestHeadValues[fieldKey] || '';
  }

  function getContextFieldValue(row, fieldKey) {
    if (row && row.displayValues && Object.prototype.hasOwnProperty.call(row.displayValues, fieldKey)) {
      return row.displayValues[fieldKey];
    }
    return getHeadFieldValue(fieldKey);
  }

  // =========================================================
  // 八、动态输入增量合并（按 HAR 的 fieldstates / r 学）
  // =========================================================
  function mergeInputReturnDeltas(root) {
    let changed = false;
    const bodyDelta = {};
    const headDelta = {};

    deepWalk(root, (obj) => {
      if (!obj || obj.a !== 'u' || !Array.isArray(obj.p)) return;

      obj.p.forEach(part => {
        if (!part || typeof part !== 'object') return;

        // 表体字段：material_entity.fieldstates
        if (part.k === 'material_entity' && Array.isArray(part.fieldstates)) {
          part.fieldstates.forEach(fs => {
            const k = fs.k;
            let r = Number(fs.r);

            if (Number.isNaN(r) || r < 0) {
              if (typeof state.activeBodyRowZeroIndex === 'number' && state.activeBodyRowZeroIndex >= 0) {
                r = state.activeBodyRowZeroIndex;
              }
            }

            if (!Number.isNaN(r) && r >= 0 && k) {
              if (!bodyDelta[r]) bodyDelta[r] = {};
              bodyDelta[r][k] = pickDisplayValue(fs.v);
              changed = true;
            }
          });
          return;
        }

        // 表头 fieldstates
        if (Array.isArray(part.fieldstates)) {
          part.fieldstates.forEach(fs => {
            if (fs && fs.k) {
              headDelta[fs.k] = pickDisplayValue(fs.v);
              changed = true;
            }
          });
          return;
        }

        // 表头单值
        if (
          typeof part.k === 'string' &&
          Object.prototype.hasOwnProperty.call(part, 'v') &&
          part.k !== 'material_entity' &&
          part.k !== 'express_entity'
        ) {
          headDelta[part.k] = pickDisplayValue(part.v);
          changed = true;
        }
      });
    });

    if (!changed) return false;

    Object.keys(bodyDelta).forEach(r => {
      if (!state.latestBodyEditDeltas[r]) state.latestBodyEditDeltas[r] = {};
      Object.assign(state.latestBodyEditDeltas[r], bodyDelta[r]);
    });

    Object.assign(state.latestHeadEditDeltas, headDelta);
    return true;
  }

  function applyRowDeltas(displayValues, displayRowIndex, zeroBasedIndex) {
    const zeroDelta = state.latestBodyEditDeltas[String(zeroBasedIndex)];
    const displayDelta = state.latestBodyEditDeltas[String(displayRowIndex)];

    if (zeroDelta) {
      Object.keys(zeroDelta).forEach(k => {
        displayValues[k] = zeroDelta[k];
      });
    }

    if (displayDelta) {
      Object.keys(displayDelta).forEach(k => {
        displayValues[k] = displayDelta[k];
      });
    }

    return displayValues;
  }

  // =========================================================
  // 九、DOM 抓取（按 HAR 里的 material_entity DOM 结构学）
  // =========================================================
  function getCellLiveText(td) {
    const input = td.querySelector('input, textarea, select');
    if (input) {
      return normalizeText(input.value || input.getAttribute('value') || input.innerText || input.textContent);
    }

    const editor = td.querySelector('[contenteditable="true"]');
    if (editor) {
      return normalizeText(editor.innerText || editor.textContent);
    }

    return normalizeText(td.innerText || td.textContent);
  }

  function mapHeaderTextToFieldKey(title) {
    const text = normalizeText(title);
    const fieldList = Object.values(state.latestFieldCatalog || {});

    let matched = fieldList.find(f =>
      normalizeText(f.label) === text ||
      normalizeText(f.key) === text ||
      text.includes(normalizeText(f.label))
    );

    if (!matched && text === '商品名称') matched = fieldList.find(f => f.key === 'material_name');
    if (!matched && text === '规格型号') matched = fieldList.find(f => f.key === 'material_model');
    if (!matched && (text === '换算公式' || text === '换算关系')) matched = fieldList.find(f => f.key === 'conversionrate');
    if (!matched && text === '数量') matched = fieldList.find(f => f.key === 'qty');
    if (!matched && text === '辅助单位') matched = fieldList.find(f => f.key === 'auxunitid');
    if (!matched && text === '辅助数量') matched = fieldList.find(f => f.key === 'auxqty');
    if (!matched && text === '基本单位') matched = fieldList.find(f => f.key === 'baseunit');
    if (!matched && text === '基本数量') matched = fieldList.find(f => f.key === 'baseqty');
    if (!matched && (text === '序号' || text === '行号')) matched = fieldList.find(f => f.key === 'seq');

    return matched ? matched.key : '';
  }

  function findMaterialEntityRoot() {
    return document.querySelector('#material_entity') || document.querySelector('[id="material_entity"]');
  }

  function collectHeadersFromMaterialRoot(root) {
    if (!root) return [];
    return Array.from(root.querySelectorAll('.kd-table-header th, thead th, tr th'))
      .filter(isElementVisible)
      .map(el => normalizeText(el.innerText || el.textContent))
      .filter(Boolean);
  }

  function pickBestBodyTable(root) {
    if (!root) return null;

    const tables = Array.from(root.querySelectorAll('.kd-table-body table, table'))
      .filter(isElementVisible);

    let best = null;
    let bestScore = -1;

    tables.forEach(table => {
      const rowCount = table.querySelectorAll('tbody tr').length;
      const cellCount = table.querySelectorAll('tbody tr td').length;
      const score = rowCount * 100 + cellCount;
      if (score > bestScore) {
        bestScore = score;
        best = table;
      }
    });

    return best;
  }

  function collectRowsFromMaterialTableDom() {
    const root = findMaterialEntityRoot();
    if (!root) return [];

    const headers = collectHeadersFromMaterialRoot(root);
    if (!headers.length) return [];

    const headerMap = headers.map(h => mapHeaderTextToFieldKey(h));
    const hasCoreFields = headerMap.includes('material_model') || headerMap.includes('conversionrate');
    if (!hasCoreFields) return [];

    const table = pickBestBodyTable(root);
    if (!table) return [];

    const rows = [];
    const bodyRows = Array.from(table.querySelectorAll('tbody tr')).filter(tr => {
      if (!isElementVisible(tr)) return false;
      return tr.querySelectorAll('td').length > 0;
    });

    bodyRows.forEach((tr, i) => {
      const cells = Array.from(tr.querySelectorAll('td'));
      const displayValues = {};

      cells.forEach((td, idx) => {
        const fieldKey = headerMap[idx];
        if (!fieldKey) return;
        displayValues[fieldKey] = getCellLiveText(td);
      });

      const firstCellText = cells[0] ? getCellLiveText(cells[0]) : '';
      const rowSeq = displayValues.seq || (/^\d+$/.test(firstCellText) ? firstCellText : String(i + 1));

      if (Object.keys(displayValues).length) {
        applyRowDeltas(displayValues, i + 1, i);

        rows.push({
          rowIndex: i + 1,
          seq: rowSeq,
          materialName: displayValues.material_name || '',
          displayValues,
          source: 'dom-material-table',
          matchedRules: []
        });
      }
    });

    return rows;
  }

  function collectRowsFromGenericTables() {
    const rows = [];
    const tables = Array.from(document.querySelectorAll('table')).filter(isElementVisible);
    if (!tables.length) return rows;

    tables.forEach(table => {
      const headerEls = Array.from(table.querySelectorAll('thead th, tr th')).filter(isElementVisible);
      if (!headerEls.length) return;

      const headerMap = headerEls.map(th => mapHeaderTextToFieldKey(normalizeText(th.innerText || th.textContent)));
      const hasCoreFields = headerMap.includes('material_model') || headerMap.includes('conversionrate');
      if (!hasCoreFields) return;

      const bodyRows = Array.from(table.querySelectorAll('tbody tr')).filter(tr => {
        if (!isElementVisible(tr)) return false;
        return tr.querySelectorAll('td').length > 0;
      });

      bodyRows.forEach((tr, i) => {
        const cells = Array.from(tr.querySelectorAll('td'));
        const displayValues = {};

        cells.forEach((td, idx) => {
          const fieldKey = headerMap[idx];
          if (!fieldKey) return;
          displayValues[fieldKey] = getCellLiveText(td);
        });

        if (Object.keys(displayValues).length) {
          applyRowDeltas(displayValues, i + 1, i);

          rows.push({
            rowIndex: i + 1,
            seq: displayValues.seq || String(i + 1),
            materialName: displayValues.material_name || '',
            displayValues,
            source: 'dom-generic-table',
            matchedRules: []
          });
        }
      });
    });

    return rows;
  }

  function convertEntityToRows(entity) {
    if (!entity || !entity.dataindex || !Array.isArray(entity.rows)) return [];

    const keys = Object.keys(entity.dataindex);
    return entity.rows.map((row, i) => {
      const displayValues = {};
      keys.forEach(key => {
        displayValues[key] = pickDisplayValue(row[entity.dataindex[key]]);
      });

      applyRowDeltas(displayValues, i + 1, i);

      return {
        rowIndex: i + 1,
        seq: displayValues.seq || String(i + 1),
        materialName: displayValues.material_name || '',
        displayValues,
        source: 'payload+inputReturn',
        matchedRules: []
      };
    });
  }

  function getLatestRowsForCheck() {
    const domRows1 = collectRowsFromMaterialTableDom();
    if (domRows1.length) {
      state.liveRows = domRows1;
      return domRows1;
    }

    const domRows2 = collectRowsFromGenericTables();
    if (domRows2.length) {
      state.liveRows = domRows2;
      return domRows2;
    }

    const payloadRows = convertEntityToRows(state.latestEntity);
    state.liveRows = payloadRows;
    return payloadRows;
  }

  // =========================================================
  // 十、按钮抓取（DOM + 可见性清单）
  // =========================================================
  function scanButtonsFromDom() {
    const found = [];

    const toolRoots = Array.from(document.querySelectorAll('#common_tool, [id="common_tool"]'));
    toolRoots.forEach(root => {
      const nodes = Array.from(
        root.querySelectorAll('[data-type="baritem"][data-btn-key], [data-type="baritem"][id]')
      );

      nodes.forEach(node => {
        const btnKey = normalizeText(node.getAttribute('data-btn-key'));
        const id = normalizeText(node.id);
        const opk = normalizeText(node.getAttribute('data-opk'));
        const title =
          normalizeText(node.getAttribute('data-title')) ||
          normalizeText(node.getAttribute('title')) ||
          normalizeText(node.textContent);

        if (!btnKey && !id && !opk) return;

        found.push({
          title: title || btnKey || id || opk,
          btnKey,
          id,
          opk,
          enabled: false
        });
      });
    });

    // 从 payload 的 visible keys 里补一层
    (state.latestButtonHintKeys || []).forEach(k => {
      const exists = found.find(x => x.btnKey === k || x.id === k || x.opk === k);
      if (!exists) {
        found.push({
          title: k,
          btnKey: k,
          id: k,
          opk: '',
          enabled: false
        });
      }
    });

    const uniq = [];
    const seen = new Set();

    found.forEach(btn => {
      const key = [btn.btnKey, btn.id, btn.opk].join('|');
      if (!seen.has(key)) {
        seen.add(key);
        uniq.push(btn);
      }
    });

    const currentCfg = state.config.buttonsCatalog || [];

    const merged = uniq.map(btn => {
      const exists = currentCfg.find(x =>
        x.btnKey === btn.btnKey &&
        x.id === btn.id &&
        x.opk === btn.opk
      );

      const autoEnabled = /save|submit|audit|out|close|special_save|generated_by_bom/i.test(
        [btn.btnKey, btn.id, btn.opk, btn.title].join(' ')
      );

      return {
        ...btn,
        enabled: exists ? !!exists.enabled : autoEnabled
      };
    });

    currentCfg.forEach(btn => {
      const exists = merged.find(x =>
        x.btnKey === btn.btnKey &&
        x.id === btn.id &&
        x.opk === btn.opk
      );
      if (!exists) merged.push(btn);
    });

    state.latestButtonCatalog = merged;
    state.config.buttonsCatalog = merged;
  }

  // =========================================================
  // 十一、页面范围预设
  // =========================================================
  function scanPageScopesFromDom() {
    syncCurrentPageMeta();

    const scopes = [];
    const cnName = getLikelyPageCnName();
    const urlText = location.pathname + location.search;
    const ctx = getPageContext();

    if (normalizeText(ctx.formId)) {
      scopes.push({
        type: 'formIdEq',
        value: normalizeText(ctx.formId),
        label: `${cnName} / formId = ${normalizeText(ctx.formId)}`
      });
    }

    if (normalizeText(ctx.formName)) {
      scopes.push({
        type: 'formNameContains',
        value: normalizeText(ctx.formName),
        label: `${cnName} / 中文名 = ${normalizeText(ctx.formName)}`
      });
    }

    const commonContent = document.querySelector('#common_content[data-page-id]');
    const commonTool = document.querySelector('#common_tool[data-page-id]');

    if (commonContent) {
      const pid = normalizeText(commonContent.getAttribute('data-page-id'));
      if (pid) {
        scopes.push({
          type: 'pageIdIncludes',
          value: pid,
          label: `${cnName} / 内容区`
        });
      }
    }

    if (commonTool) {
      const pid = normalizeText(commonTool.getAttribute('data-page-id'));
      if (pid) {
        scopes.push({
          type: 'pageIdIncludes',
          value: pid,
          label: `${cnName} / 业务工具栏`
        });
      }
    }

    if (urlText) {
      scopes.push({
        type: 'urlIncludes',
        value: urlText,
        label: `${cnName} / 当前URL`
      });
    }

    const uniq = [];
    const seen = new Set();

    scopes.forEach(item => {
      const key = `${item.type}|${item.value}`;
      if (!seen.has(key)) {
        seen.add(key);
        uniq.push(item);
      }
    });

    state.latestPageScopes = uniq;
  }

  function getPageScopeOptions() {
    return (state.latestPageScopes || []).map(item => ({
      value: `${item.type}|||${item.value}`,
      label: item.label
    }));
  }

  // =========================================================
  // 十二、规则判断
  // =========================================================
  function evalCondition(condition, row) {
    const leftRaw = getContextFieldValue(row, condition.leftField);
    const leftValue = applyTransform(leftRaw, condition.leftTransform || 'raw');

    let rightRaw = '';
    let rightValue = '';

    if (condition.rightType === 'field') {
      rightRaw = getContextFieldValue(row, condition.rightField);
      rightValue = applyTransform(rightRaw, condition.rightTransform || 'raw');
    } else {
      rightRaw = condition.rightValue;
      rightValue = applyTransform(condition.rightValue, condition.rightTransform || 'raw');
    }

    return {
      matched: compareValues(leftValue, condition.operator, rightValue),
      leftRaw,
      leftValue,
      rightRaw,
      rightValue
    };
  }

  function evalRule(rule, row) {
    if (!rule.enabled) return { matched: false, details: [] };
    if (!ruleMatchesScope(rule)) return { matched: false, details: [] };

    const details = (rule.conditions || []).map(cond => evalCondition(cond, row));
    const matched = rule.matchMode === 'any'
      ? details.some(d => d.matched)
      : details.every(d => d.matched);

    return { matched, details };
  }

  function analyzeRowsByRules(rows) {
    const blockItems = [];
    const warnItems = [];

    rows.forEach((row, i) => {
      const item = {
        rowIndex: row.rowIndex || i + 1,
        seq: row.seq || String(i + 1),
        materialName: row.materialName || '',
        displayValues: row.displayValues || {},
        source: row.source || '',
        matchedRules: []
      };

      let finalAction = 'pass';

      (state.config.rules || []).forEach(rule => {
        const result = evalRule(rule, item);
        if (!result.matched) return;

        item.matchedRules.push({
          id: rule.id,
          name: rule.name,
          action: rule.action,
          details: result.details
        });

        if (severity(rule.action) > severity(finalAction)) {
          finalAction = rule.action;
        }
      });

      if (finalAction === 'block') blockItems.push(item);
      if (finalAction === 'warn') warnItems.push(item);
    });

    return { blockItems, warnItems };
  }

  function makeDataHash(blockItems, warnItems) {
    return JSON.stringify({
      block: blockItems.map(item => [item.seq, item.materialName, item.matchedRules.map(r => r.name).join('|')]),
      warn: warnItems.map(item => [item.seq, item.materialName, item.matchedRules.map(r => r.name).join('|')])
    });
  }

  function applyAnalysisResult(result, source) {
    const hash = makeDataHash(result.blockItems, result.warnItems);
    const changed = hash !== state.lastDataHash;

    state.blockItems = result.blockItems;
    state.warnItems = result.warnItems;
    state.lastDataHash = hash;

    if (state.blockItems.length || state.warnItems.length) {
      updateBanner(changed);
    } else {
      removeBanner();
    }

    if (!state.panelOpen) {
      renderPanelContent();
    } else {
      state.panelDirty = true;
    }

    log('applyAnalysisResult', source, result);
  }

  function applyPayload(root, source, clearDeltas) {
    const entity = findEntity(root);
    if (!entity) return false;

    if (clearDeltas) {
      state.latestBodyEditDeltas = {};
      state.latestHeadEditDeltas = {};
    }

    state.latestPayload = root;
    state.latestEntity = entity;
    state.latestFieldCatalog = buildFieldCatalogFromPayload(root);
    state.latestHeadFieldCatalog = buildHeadFieldCatalogFromPayload(root);
    state.latestHeadValues = buildHeadValuesFromPayload(root);
    state.latestButtonHintKeys = buildButtonHintKeysFromPayload(root);

    scanButtonsFromDom();
    scanPageScopesFromDom();

    return true;
  }

  function runLiveCheck(source) {
    syncCurrentPageMeta();
    scanButtonsFromDom();
    scanPageScopesFromDom();

    const rows = getLatestRowsForCheck();
    const analyzed = analyzeRowsByRules(rows);
    applyAnalysisResult(analyzed, source || 'live');
  }

  function tryHandleResponseData(data, source) {
    if (!data) return;

    syncCurrentPageMeta();

    const full = isFullPayload(data);
    if (full) {
      applyPayload(data, source, true);
    }

    const deltaChanged = mergeInputReturnDeltas(data);

    if (full || deltaChanged) {
      runLiveCheck(full && deltaChanged ? 'full+inputReturn' : full ? 'full-payload' : 'input-return-delta');
    }
  }

  // =========================================================
  // 十三、请求拦截
  // =========================================================
  function patchFetch() {
    if (!window.fetch) return;
    const rawFetch = window.fetch;

    window.fetch = async function () {
      try {
        const input = arguments[0];
        const init = arguments[1] || {};
        const url = typeof input === 'string' ? input : (input && input.url ? input.url : '');
        const body = init && init.body ? init.body : '';

        const meta = parseFormMetaFromRequest(url, body);
        const ctx = parseActionContextFromRequest(url, body);

        mergeLatestSeenFormMeta(meta);
        mergeLatestActionContext(ctx);
        syncCurrentPageMeta();
      } catch (e) {
        log('fetch request parse fail', e);
      }

      const res = await rawFetch.apply(this, arguments);

      try {
        const text = await res.clone().text();
        const json = safeJsonParse(text);
        if (json) tryHandleResponseData(json, 'fetch');
      } catch (e) {
        log('fetch parse response fail', e);
      }

      return res;
    };
  }

  function patchXHR() {
    const rawOpen = XMLHttpRequest.prototype.open;
    const rawSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function (method, url) {
      this.__jdy_method__ = method || '';
      this.__jdy_url__ = url || '';
      return rawOpen.apply(this, arguments);
    };

    XMLHttpRequest.prototype.send = function (body) {
      try {
        const meta = parseFormMetaFromRequest(this.__jdy_url__ || '', body || '');
        const ctx = parseActionContextFromRequest(this.__jdy_url__ || '', body || '');

        mergeLatestSeenFormMeta(meta);
        mergeLatestActionContext(ctx);
        syncCurrentPageMeta();
      } catch (e) {
        log('xhr request parse fail', e);
      }

      this.addEventListener('load', function () {
        try {
          if (typeof this.responseText !== 'string') return;
          const json = safeJsonParse(this.responseText);
          if (json) tryHandleResponseData(json, 'xhr');
        } catch (e) {
          log('xhr parse response fail', e);
        }
      });

      return rawSend.apply(this, arguments);
    };
  }

  // =========================================================
  // 十四、按钮拦截
  // =========================================================
  function isInsideOurUi(node) {
    return node instanceof Element && !!node.closest(`#${MODAL_ID}, #${BANNER_ID}, #${PANEL_ID}, #${FAB_ID}`);
  }

  function hasExactActionMatch(node) {
    const btnKey = normalizeText(node.getAttribute?.('data-btn-key'));
    const opk = normalizeText(node.getAttribute?.('data-opk'));
    const id = normalizeText(node.id);

    return (state.config.buttonsCatalog || []).some(btn =>
      btn.enabled && (
        (btn.btnKey && btn.btnKey === btnKey) ||
        (btn.id && btn.id === id) ||
        (btn.opk && btn.opk === opk)
      )
    );
  }

  function findMatchedActionRoot(target) {
    if (!(target instanceof Element)) return null;
    if (isInsideOurUi(target)) return null;

    let node = target;
    let depth = 0;

    while (node && depth < 10) {
      if (hasExactActionMatch(node)) return node;

      const btnKey = normalizeText(node.getAttribute?.('data-btn-key'));
      const id = normalizeText(node.id);
      const opk = normalizeText(node.getAttribute?.('data-opk'));
      const isToolbarButton = node.getAttribute?.('data-type') === 'baritem' || node.hasAttribute?.('buttontype');

      if (isToolbarButton && (btnKey || id || opk)) {
        return null;
      }

      node = node.parentElement;
      depth++;
    }

    return null;
  }

  function shouldDebounceIntercept() {
    const now = Date.now();
    if (now - state.lastInterceptAt < 800) return true;
    state.lastInterceptAt = now;
    return false;
  }

  function armBypass(root, count) {
    state.bypassRoot = root;
    state.bypassUntil = Date.now() + 1500;
    state.bypassRemaining = count;
  }

  function consumeBypassIfMatch(root) {
    if (!root) return false;
    if (state.bypassRoot !== root) return false;
    if (Date.now() > state.bypassUntil) return false;
    if (state.bypassRemaining <= 0) return false;

    state.bypassRemaining -= 1;
    if (state.bypassRemaining <= 0) {
      state.bypassRoot = null;
      state.bypassUntil = 0;
    }
    return true;
  }

  function replayAction(root) {
    if (!(root instanceof Element)) return;
    armBypass(root, 4);

    setTimeout(() => {
      try { root.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, composed: true })); } catch (e) {}
      try { root.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, composed: true })); } catch (e) {}
      try { root.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, composed: true })); } catch (e) {}
      try { root.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, composed: true })); } catch (e) {
        try { root.click(); } catch (_) {}
      }
    }, 0);
  }

  function blockEvent(evt) {
    evt.preventDefault();
    evt.stopPropagation();
    if (typeof evt.stopImmediatePropagation === 'function') {
      evt.stopImmediatePropagation();
    }
  }

  function interceptActions() {
    const handler = function (evt) {
      const matchedRoot = findMatchedActionRoot(evt.target);
      if (!matchedRoot) return;

      if (consumeBypassIfMatch(matchedRoot)) return;
      if (shouldDebounceIntercept()) return;

      blockEvent(evt);

      syncCurrentPageMeta();
      scanButtonsFromDom();
      scanPageScopesFromDom();

      const rows = getLatestRowsForCheck();
      const analyzed = analyzeRowsByRules(rows);
      applyAnalysisResult(analyzed, 'before-submit');
      updateBanner(true);

      if (state.blockItems.length) {
        showBlockModal(state.blockItems);
        return;
      }

      if (state.warnItems.length) {
        showWarnModal(state.warnItems, () => replayAction(matchedRoot));
        return;
      }

      replayAction(matchedRoot);
    };

    document.addEventListener('pointerdown', handler, true);
    document.addEventListener('click', handler, true);
  }

  // =========================================================
  // 十五、样式 / 弹窗 / Banner
  // =========================================================
  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;

    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      #${FAB_ID} {
        position: fixed;
        left: 16px;
        bottom: 16px;
        z-index: 2147483646;
        background: #1677ff;
        color: #fff;
        border-radius: 999px;
        padding: 10px 14px;
        font-size: 13px;
        cursor: pointer;
        box-shadow: 0 8px 24px rgba(0,0,0,.2);
        user-select: none;
      }

      #${PANEL_WRAP_ID} {
        position: fixed;
        left: 16px;
        bottom: 58px;
        z-index: 2147483646;
      }

      #${PANEL_ID} {
        width: 620px;
        max-height: 78vh;
        overflow: auto;
        background: #fff;
        border: 1px solid #d9d9d9;
        border-radius: 12px;
        box-shadow: 0 12px 36px rgba(0,0,0,.2);
        color: #262626;
        font-size: 13px;
      }

      #${PANEL_ID} .hd {
        position: sticky;
        top: 0;
        background: #fff;
        padding: 12px 14px;
        border-bottom: 1px solid #f0f0f0;
        z-index: 2;
      }

      #${PANEL_ID} .title { font-size: 16px; font-weight: 700; }
      #${PANEL_ID} .sub { margin-top: 4px; color: #8c8c8c; line-height: 1.6; }
      #${PANEL_ID} .sec { padding: 12px 14px; border-bottom: 1px solid #f5f5f5; }
      #${PANEL_ID} .sec h4 { margin: 0 0 8px 0; font-size: 14px; }

      #${PANEL_ID} .row {
        display: flex;
        gap: 8px;
        align-items: center;
        margin-bottom: 8px;
        flex-wrap: wrap;
      }

      #${PANEL_ID} input[type="text"],
      #${PANEL_ID} select {
        border: 1px solid #d9d9d9;
        border-radius: 6px;
        padding: 6px 8px;
        font-size: 12px;
      }

      #${PANEL_ID} button {
        border: none;
        background: #1677ff;
        color: #fff;
        padding: 6px 10px;
        border-radius: 6px;
        cursor: pointer;
        font-size: 12px;
      }

      #${PANEL_ID} button.gray { background: #8c8c8c; }
      #${PANEL_ID} button.red { background: #ff4d4f; }

      #${PANEL_ID} .field-table,
      #${PANEL_ID} .rule-card,
      #${PANEL_ID} .btn-table {
        border: 1px solid #f0f0f0;
        border-radius: 8px;
        padding: 8px;
        margin-top: 8px;
      }

      #${PANEL_ID} .field-table table,
      #${PANEL_ID} .btn-table table {
        width: 100%;
        border-collapse: collapse;
        font-size: 12px;
      }

      #${PANEL_ID} .field-table th,
      #${PANEL_ID} .field-table td,
      #${PANEL_ID} .btn-table th,
      #${PANEL_ID} .btn-table td {
        border-bottom: 1px solid #f5f5f5;
        text-align: left;
        padding: 6px 4px;
        vertical-align: top;
      }

      #${PANEL_ID} .condition {
        border: 1px dashed #d9d9d9;
        border-radius: 8px;
        padding: 8px;
        margin-top: 8px;
      }

      #${PANEL_ID} .tiny {
        color: #8c8c8c;
        font-size: 12px;
      }

      #${BANNER_ID} {
        position: fixed;
        right: 16px;
        bottom: 16px;
        z-index: 2147483645;
        background: #fff2f0;
        border: 1px solid #ffccc7;
        color: #a8071a;
        border-radius: 10px;
        box-shadow: 0 8px 24px rgba(0,0,0,0.15);
        padding: 12px 36px 12px 14px;
        max-width: 520px;
        font-size: 13px;
        line-height: 1.6;
      }

      #${BANNER_ID} .close-x {
        position: absolute;
        right: 10px;
        top: 6px;
        cursor: pointer;
        font-size: 16px;
        color: #8c8c8c;
      }

      #${MODAL_ID} {
        position: fixed;
        inset: 0;
        z-index: 2147483647;
        background: rgba(0,0,0,.45);
        display: flex;
        align-items: center;
        justify-content: center;
      }

      #${MODAL_ID} .box {
        width: min(920px, calc(100vw - 32px));
        max-height: 80vh;
        overflow: auto;
        background: #fff;
        border-radius: 12px;
        box-shadow: 0 12px 36px rgba(0,0,0,.25);
        padding: 20px;
      }

      #${MODAL_ID} .title {
        font-size: 18px;
        font-weight: 700;
        color: #cf1322;
        margin-bottom: 12px;
      }

      #${MODAL_ID} .desc {
        color: #595959;
        margin-bottom: 12px;
        line-height: 1.8;
      }

      #${MODAL_ID} ol { padding-left: 20px; }

      #${MODAL_ID} li {
        margin-bottom: 10px;
        line-height: 1.8;
        background: #fff7e6;
        border: 1px solid #ffe7ba;
        border-radius: 8px;
        padding: 10px 12px;
        list-style-position: inside;
      }

      #${MODAL_ID} .actions {
        margin-top: 16px;
        text-align: right;
      }

      #${MODAL_ID} button {
        border: none;
        background: #cf1322;
        color: #fff;
        padding: 8px 16px;
        border-radius: 6px;
        cursor: pointer;
        margin-left: 8px;
      }

      #${MODAL_ID} .secondary { background: #8c8c8c; }
    `;

    document.documentElement.appendChild(style);
  }

  function removeBanner() {
    const banner = document.getElementById(BANNER_ID);
    if (banner) banner.remove();
  }

  function updateBanner(forceShow) {
    ensureStyle();

    const blockCount = state.blockItems.length;
    const warnCount = state.warnItems.length;

    if (!blockCount && !warnCount) {
      removeBanner();
      return;
    }

    const now = Date.now();
    if (!forceShow && state.bannerDismissedAt && now - state.bannerDismissedAt < state.config.ui.bannerHideMs) {
      return;
    }

    let desc = '';
    if (blockCount && warnCount) {
      desc = `拦截 ${blockCount} 条，提示 ${warnCount} 条。`;
    } else if (blockCount) {
      desc = `拦截 ${blockCount} 条。`;
    } else {
      desc = `提示 ${warnCount} 条。`;
    }

    let banner = document.getElementById(BANNER_ID);
    if (!banner) {
      banner = document.createElement('div');
      banner.id = BANNER_ID;
      document.body.appendChild(banner);
    }

    banner.innerHTML = `
      <div class="close-x" id="__jdy_rule_banner_close__">×</div>
      <div><strong>${escapeHtml(state.config.messages.bannerTitle)}</strong></div>
      <div>${escapeHtml(desc)}</div>
      <div style="margin-top:4px;color:#8c8c8c;">做单时会实时轻提示；保存类按钮点击时会再重查一次</div>
    `;

    const closeBtn = document.getElementById('__jdy_rule_banner_close__');
    if (closeBtn) {
      closeBtn.onclick = () => {
        state.bannerDismissedAt = Date.now();
        removeBanner();
      };
    }
  }

  function closeModal() {
    const modal = document.getElementById(MODAL_ID);
    if (modal) modal.remove();
  }

  function getReferencedFields(items) {
    const keys = new Set(['seq', 'material_name', 'materialid']);

    items.forEach(item => {
      (item.matchedRules || []).forEach(rule => {
        const ruleCfg = (state.config.rules || []).find(r => r.id === rule.id);
        if (!ruleCfg) return;
        (ruleCfg.conditions || []).forEach(cond => {
          if (cond.leftField) keys.add(cond.leftField);
          if (cond.rightType === 'field' && cond.rightField) keys.add(cond.rightField);
        });
      });
    });

    return Array.from(keys);
  }

  function renderPopupItems(items) {
    const fields = getReferencedFields(items);

    return items.slice(0, state.config.ui.maxPopupItems).map(item => {
      const rulesText = (item.matchedRules || []).map(r => `${r.name}【${r.action}】`).join('；');

      const fieldRows = fields.map(key => {
        const label = getAnyFieldLabel(key);
        const value = getContextFieldValue(item, key);
        return `<div><span style="color:#8c8c8c;">${escapeHtml(label)}：</span><b>${escapeHtml(value || '-')}</b></div>`;
      }).join('');

      return `
        <li>
          <div><b>第 ${escapeHtml(item.seq)} 行</b>${item.materialName ? `　商品：<b>${escapeHtml(item.materialName)}</b>` : ''}</div>
          <div style="margin:6px 0;color:#cf1322;">命中规则：${escapeHtml(rulesText || '-')}</div>
          <div style="margin:6px 0;color:#8c8c8c;">数据来源：${escapeHtml(item.source || '-')}</div>
          ${fieldRows}
        </li>
      `;
    }).join('');
  }

  function showBlockModal(items) {
    ensureStyle();
    closeModal();

    const modal = document.createElement('div');
    modal.id = MODAL_ID;
    modal.innerHTML = `
      <div class="box">
        <div class="title">${escapeHtml(state.config.messages.blockTitle)}</div>
        <div class="desc">${escapeHtml(state.config.messages.blockDesc)}</div>
        <ol>${renderPopupItems(items)}</ol>
        <div class="actions">
          <button type="button" id="__jdy_rule_block_close__">${escapeHtml(state.config.messages.blockButtonText)}</button>
        </div>
      </div>
    `;

    document.body.appendChild(modal);

    const btn = document.getElementById('__jdy_rule_block_close__');
    if (btn) btn.addEventListener('click', closeModal);

    modal.addEventListener('click', e => {
      if (e.target === modal) closeModal();
    });
  }

  function showWarnModal(items, onContinue) {
    ensureStyle();
    closeModal();

    const modal = document.createElement('div');
    modal.id = MODAL_ID;
    modal.innerHTML = `
      <div class="box">
        <div class="title">${escapeHtml(state.config.messages.warnTitle)}</div>
        <div class="desc">${escapeHtml(state.config.messages.warnDesc)}</div>
        <ol>${renderPopupItems(items)}</ol>
        <div class="actions">
          <button type="button" class="secondary" id="__jdy_rule_warn_back__">${escapeHtml(state.config.messages.warnBackButtonText)}</button>
          <button type="button" id="__jdy_rule_warn_continue__">${escapeHtml(state.config.messages.warnContinueButtonText)}</button>
        </div>
      </div>
    `;

    document.body.appendChild(modal);

    const backBtn = document.getElementById('__jdy_rule_warn_back__');
    if (backBtn) backBtn.addEventListener('click', closeModal);

    const continueBtn = document.getElementById('__jdy_rule_warn_continue__');
    if (continueBtn) {
      continueBtn.addEventListener('click', () => {
        closeModal();
        if (typeof onContinue === 'function') onContinue();
      });
    }

    modal.addEventListener('click', e => {
      if (e.target === modal) closeModal();
    });
  }

  // =========================================================
  // 十六、面板
  // =========================================================
  function optionHtml(options, currentValue) {
    return options.map(opt => `
      <option value="${escapeHtml(opt.value)}" ${String(opt.value) === String(currentValue) ? 'selected' : ''}>
        ${escapeHtml(opt.label)}
      </option>
    `).join('');
  }

  function bindClick(id, fn) {
    const el = document.getElementById(id);
    if (el) el.onclick = fn;
  }

  function qsa(selector) {
    return Array.from(document.querySelectorAll(selector));
  }

  function qs(selector) {
    return document.querySelector(selector);
  }

  function val(selectorOrId) {
    const el = selectorOrId.startsWith('[') || selectorOrId.startsWith('#')
      ? qs(selectorOrId)
      : document.getElementById(selectorOrId);
    return el ? el.value : '';
  }

  function checked(selector) {
    const el = qs(selector);
    return !!el?.checked;
  }

  function css(s) {
    return String(s).replace(/"/g, '\\"');
  }

  function newRule() {
    return {
      id: uid(),
      name: '新规则',
      enabled: true,
      action: 'warn',
      matchMode: 'all',
      scopeType: 'all',
      scopeValue: '',
      conditions: [newCondition()]
    };
  }

  function newCondition() {
    const field = state.config.preferredFields[0] || 'seq';
    return {
      id: uid(),
      leftField: field,
      leftTransform: 'raw',
      operator: 'eq',
      rightType: 'value',
      rightField: '',
      rightTransform: 'raw',
      rightValue: ''
    };
  }

  function renderHeadFieldsHtml() {
    const rows = Object.values(state.latestHeadFieldCatalog || {});

    if (!rows.length) {
      return `<div class="tiny">当前还没有抓到单据表头字段。先打开一张单据，再点“重新渲染”。</div>`;
    }

    rows.sort((a, b) => String(a.label).localeCompare(String(b.label), 'zh-CN'));

    return `
      <div class="field-table">
        <table>
          <thead>
            <tr>
              <th>中文名</th>
              <th>字段key</th>
              <th>示例值</th>
              <th>来源</th>
            </tr>
          </thead>
          <tbody>
            ${rows.map(f => `
              <tr>
                <td>${escapeHtml(f.label)}</td>
                <td>${escapeHtml(f.key)}</td>
                <td>${escapeHtml(getHeadFieldValue(f.key) || f.sample || '')}</td>
                <td>${escapeHtml(f.source || '')}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;
  }

  function renderButtonsTableHtml() {
    const rows = state.latestButtonCatalog || [];

    if (!rows.length) {
      return `<div class="tiny">当前页面还没有抓到按钮。先打开单据页工具栏，再点“重新渲染”。</div>`;
    }

    return `
      <div class="btn-table">
        <table>
          <thead>
            <tr>
              <th>启用</th>
              <th>按钮中文</th>
              <th>btnKey</th>
              <th>id/opk</th>
            </tr>
          </thead>
          <tbody>
            ${rows.map((btn, idx) => `
              <tr>
                <td><input type="checkbox" data-role="btn-enabled" data-btn-idx="${idx}" ${btn.enabled ? 'checked' : ''}></td>
                <td>${escapeHtml(btn.title || '')}</td>
                <td>${escapeHtml(btn.btnKey || '')}</td>
                <td>${escapeHtml(btn.id || btn.opk || '')}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;
  }

  function renderRulesHtml(fieldOptions) {
    return (state.config.rules || []).map(rule => `
      <div class="rule-card" data-rule-id="${escapeHtml(rule.id)}">
        <div class="row">
          <input type="text" data-role="rule-name" data-rule-id="${escapeHtml(rule.id)}" value="${escapeHtml(rule.name || '')}" placeholder="规则名称" style="width:180px;">
          <select data-role="rule-action" data-rule-id="${escapeHtml(rule.id)}">
            ${optionHtml(ACTION_OPTIONS, rule.action)}
          </select>
          <select data-role="rule-match" data-rule-id="${escapeHtml(rule.id)}">
            ${optionHtml(MATCH_MODE_OPTIONS, rule.matchMode)}
          </select>
          <label><input type="checkbox" data-role="rule-enabled" data-rule-id="${escapeHtml(rule.id)}" ${rule.enabled ? 'checked' : ''}> 启用</label>
          <button class="red" data-role="remove-rule" data-rule-id="${escapeHtml(rule.id)}">删除规则</button>
        </div>

        <div class="row">
          <select data-role="rule-scope-type" data-rule-id="${escapeHtml(rule.id)}">
            ${optionHtml(SCOPE_OPTIONS, rule.scopeType)}
          </select>
          <input type="text" data-role="rule-scope-value" data-rule-id="${escapeHtml(rule.id)}" value="${escapeHtml(rule.scopeValue || '')}" placeholder="作用范围值，优先推荐 formIdEq" style="width:260px;">
        </div>

        <div class="row">
          <select data-role="rule-scope-preset" data-rule-id="${escapeHtml(rule.id)}" style="min-width:420px;">
            <option value="">从当前单据预设选择（可选）</option>
            ${optionHtml(getPageScopeOptions(), '')}
          </select>
        </div>

        ${(rule.conditions || []).map(cond => `
          <div class="condition" data-cond-id="${escapeHtml(cond.id)}">
            <div class="row">
              <select data-role="cond-left-field" data-rule-id="${escapeHtml(rule.id)}" data-cond-id="${escapeHtml(cond.id)}" style="min-width:260px;">
                ${optionHtml(fieldOptions, cond.leftField)}
              </select>
              <select data-role="cond-left-transform" data-rule-id="${escapeHtml(rule.id)}" data-cond-id="${escapeHtml(cond.id)}">
                ${optionHtml(TRANSFORMS.map(x => ({ value: x.value, label: x.label })), cond.leftTransform)}
              </select>
              <select data-role="cond-operator" data-rule-id="${escapeHtml(rule.id)}" data-cond-id="${escapeHtml(cond.id)}">
                ${optionHtml(OPERATORS.map(x => ({ value: x.value, label: x.label })), cond.operator)}
              </select>
            </div>

            <div class="row">
              <select data-role="cond-right-type" data-rule-id="${escapeHtml(rule.id)}" data-cond-id="${escapeHtml(cond.id)}">
                ${optionHtml(RIGHT_TYPE_OPTIONS, cond.rightType)}
              </select>

              ${
                cond.rightType === 'field'
                  ? `
                    <select data-role="cond-right-field" data-rule-id="${escapeHtml(rule.id)}" data-cond-id="${escapeHtml(cond.id)}" style="min-width:260px;">
                      ${optionHtml(fieldOptions, cond.rightField)}
                    </select>
                    <select data-role="cond-right-transform" data-rule-id="${escapeHtml(rule.id)}" data-cond-id="${escapeHtml(cond.id)}">
                      ${optionHtml(TRANSFORMS.map(x => ({ value: x.value, label: x.label })), cond.rightTransform)}
                    </select>
                  `
                  : `
                    <input type="text" data-role="cond-right-value" data-rule-id="${escapeHtml(rule.id)}" data-cond-id="${escapeHtml(cond.id)}" value="${escapeHtml(cond.rightValue || '')}" placeholder="固定值" style="width:240px;">
                    <select data-role="cond-right-transform" data-rule-id="${escapeHtml(rule.id)}" data-cond-id="${escapeHtml(cond.id)}">
                      ${optionHtml(TRANSFORMS.map(x => ({ value: x.value, label: x.label })), cond.rightTransform)}
                    </select>
                  `
              }

              <button class="red" data-role="remove-cond" data-rule-id="${escapeHtml(rule.id)}" data-cond-id="${escapeHtml(cond.id)}">删除条件</button>
            </div>
          </div>
        `).join('')}

        <div class="row" style="margin-top:8px;">
          <button data-role="add-cond" data-rule-id="${escapeHtml(rule.id)}">新增条件</button>
        </div>
      </div>
    `).join('');
  }

  function readPanelConfigToState() {
    qsa('[data-role="btn-enabled"]').forEach(chk => {
      const idx = Number(chk.getAttribute('data-btn-idx'));
      if (!Number.isNaN(idx) && state.config.buttonsCatalog[idx]) {
        state.config.buttonsCatalog[idx].enabled = !!chk.checked;
      }
    });

    (state.config.rules || []).forEach(rule => {
      rule.name = val(`[data-role="rule-name"][data-rule-id="${css(rule.id)}"]`);
      rule.action = val(`[data-role="rule-action"][data-rule-id="${css(rule.id)}"]`);
      rule.matchMode = val(`[data-role="rule-match"][data-rule-id="${css(rule.id)}"]`);
      rule.enabled = checked(`[data-role="rule-enabled"][data-rule-id="${css(rule.id)}"]`);
      rule.scopeType = val(`[data-role="rule-scope-type"][data-rule-id="${css(rule.id)}"]`);
      rule.scopeValue = val(`[data-role="rule-scope-value"][data-rule-id="${css(rule.id)}"]`);

      (rule.conditions || []).forEach(cond => {
        cond.leftField = val(`[data-role="cond-left-field"][data-rule-id="${css(rule.id)}"][data-cond-id="${css(cond.id)}"]`);
        cond.leftTransform = val(`[data-role="cond-left-transform"][data-rule-id="${css(rule.id)}"][data-cond-id="${css(cond.id)}"]`);
        cond.operator = val(`[data-role="cond-operator"][data-rule-id="${css(rule.id)}"][data-cond-id="${css(cond.id)}"]`);
        cond.rightType = val(`[data-role="cond-right-type"][data-rule-id="${css(rule.id)}"][data-cond-id="${css(cond.id)}"]`);
        cond.rightTransform = val(`[data-role="cond-right-transform"][data-rule-id="${css(rule.id)}"][data-cond-id="${css(cond.id)}"]`);

        if (cond.rightType === 'field') {
          cond.rightField = val(`[data-role="cond-right-field"][data-rule-id="${css(rule.id)}"][data-cond-id="${css(cond.id)}"]`);
          cond.rightValue = '';
        } else {
          cond.rightValue = val(`[data-role="cond-right-value"][data-rule-id="${css(rule.id)}"][data-cond-id="${css(cond.id)}"]`);
          cond.rightField = '';
        }
      });
    });

    if (state.latestPayload) {
      runLiveCheck('panel-save');
    }
  }

  function renderPanelContent() {
    const panel = document.getElementById(PANEL_ID);
    const wrap = document.getElementById(PANEL_WRAP_ID);
    if (!panel || !wrap) return;

    wrap.style.display = state.panelOpen ? 'block' : 'none';
    if (!state.panelOpen) return;

    syncCurrentPageMeta();

    const fieldList = getSortedFields();

    const headFields = Object.values(state.latestHeadFieldCatalog || {}).map(f => ({
      value: f.key,
      label: `[表头] ${f.label} (${f.key})`
    }));

    const bodyFields = buildFieldOptions(fieldList).map(f => ({
      value: f.value,
      label: `[表体] ${f.label}`
    }));

    const fieldOptions = [...headFields, ...bodyFields];

    panel.innerHTML = `
      <div class="hd">
        <div class="title">双单位规则面板</div>
        <div class="sub">
          这版只按你当前这个 HAR 重构。<br>
          当前单据识别优先级：DOM pageId → 最近请求参数。
        </div>
        <div class="row" style="margin-top:8px;">
          <button id="__panel_save__">保存配置</button>
          <button class="gray" id="__panel_reload__">重新渲染</button>
          <button class="gray" id="__panel_export__">导出JSON</button>
          <button class="gray" id="__panel_import__">导入JSON</button>
          <button class="red" id="__panel_reset__">恢复默认</button>
          <button class="gray" id="__panel_close__">关闭面板</button>
        </div>
      </div>

      <div class="sec">
        <h4>零、单据页面总览</h4>
        <div class="tiny">
          当前单据中文名：<b>${escapeHtml(getLikelyPageCnName())}</b><br>
          当前识别来源：${escapeHtml(state.currentPageMeta.source || '-')}<br>
          当前 formId：${escapeHtml(state.currentPageMeta.formId || '-')}
        </div>
      </div>

      <div class="sec">
        <h4>一、单据表头字段</h4>
        ${renderHeadFieldsHtml()}
      </div>

      <div class="sec">
        <h4>二、表体字段总览</h4>
        <div class="tiny">
          ${state.panelDirty ? '<span style="color:#cf1322;">当前数据已更新，点“重新渲染”可刷新显示。</span>' : ''}
        </div>

        <div class="field-table">
          <table>
            <thead>
              <tr>
                <th>中文名</th>
                <th>字段key</th>
                <th>示例值</th>
                <th>来源</th>
              </tr>
            </thead>
            <tbody>
              ${
                fieldList.length
                  ? fieldList.map(f => `
                    <tr>
                      <td>${escapeHtml(f.label)}</td>
                      <td>${escapeHtml(f.key)}</td>
                      <td>${escapeHtml(f.sample || '')}</td>
                      <td>${escapeHtml(f.source || '')}</td>
                    </tr>
                  `).join('')
                  : `<tr><td colspan="4" style="color:#8c8c8c;">当前还没有抓到表体字段数据</td></tr>`
              }
            </tbody>
          </table>
        </div>

        <div class="row" style="margin-top:10px;">
          <input type="text" id="__custom_field_key__" placeholder="自定义字段key，如 my_field" style="width:180px;">
          <input type="text" id="__custom_field_label__" placeholder="中文名，如 我的字段" style="width:180px;">
          <button id="__add_custom_field__">新增自定义字段</button>
        </div>
      </div>

      <div class="sec">
        <h4>三、按钮总览与拦截选择</h4>
        ${renderButtonsTableHtml()}
      </div>

      <div class="sec">
        <h4>四、规则配置</h4>
        <div id="__rules_container__">${renderRulesHtml(fieldOptions)}</div>
        <div class="row" style="margin-top:8px;">
          <button id="__add_rule__">新增规则</button>
        </div>
      </div>

      <div class="sec">
        <h4>五、当前命中结果</h4>
        <div class="tiny">
          拦截：${state.blockItems.length} 条；提示：${state.warnItems.length} 条；<br>
          当前行数据来源优先为实际表格 DOM，读不到时才回退 payload + inputReturn。
        </div>
        <div class="row" style="margin-top:8px;">
          <button id="__show_block__">查看拦截明细</button>
          <button class="gray" id="__show_warn__">查看提示明细</button>
        </div>
      </div>
    `;

    bindPanelEvents();
    state.panelDirty = false;
  }

  function bindPanelEvents() {
    bindClick('__panel_save__', () => {
      readPanelConfigToState();
      saveConfig();
      renderPanelContent();
      alert('配置已保存');
    });

    bindClick('__panel_reload__', () => {
      syncCurrentPageMeta();
      scanButtonsFromDom();
      scanPageScopesFromDom();

      if (state.latestPayload) {
        state.latestFieldCatalog = buildFieldCatalogFromPayload(state.latestPayload);
        state.latestHeadFieldCatalog = buildHeadFieldCatalogFromPayload(state.latestPayload);
        state.latestHeadValues = buildHeadValuesFromPayload(state.latestPayload);
        state.latestButtonHintKeys = buildButtonHintKeysFromPayload(state.latestPayload);
      }

      state.panelDirty = false;
      renderPanelContent();
    });

    bindClick('__panel_export__', () => {
      prompt('复制下面的 JSON 配置：', JSON.stringify(state.config, null, 2));
    });

    bindClick('__panel_import__', () => {
      const text = prompt('请粘贴配置 JSON：');
      if (!text) return;

      try {
        state.config = mergeConfig(clone(DEFAULT_CONFIG), JSON.parse(text));
        saveConfig();
        scanButtonsFromDom();
        scanPageScopesFromDom();
        renderPanelContent();
        runLiveCheck('import');
        alert('导入成功');
      } catch (e) {
        alert('JSON 格式不正确');
      }
    });

    bindClick('__panel_reset__', () => {
      if (!confirm('确定恢复默认配置吗？')) return;
      state.config = clone(DEFAULT_CONFIG);
      saveConfig();
      scanButtonsFromDom();
      scanPageScopesFromDom();
      renderPanelContent();
      runLiveCheck('reset');
    });

    bindClick('__panel_close__', () => {
      state.panelOpen = false;
      renderPanelContent();
    });

    bindClick('__add_custom_field__', () => {
      const key = normalizeText(document.getElementById('__custom_field_key__')?.value);
      const label = normalizeText(document.getElementById('__custom_field_label__')?.value);
      if (!key) return alert('请输入字段key');

      const exists = (state.config.customFields || []).find(x => x.key === key);
      if (exists) {
        exists.label = label || key;
      } else {
        state.config.customFields.push({ key, label: label || key });
      }

      saveConfig();
      if (state.latestPayload) {
        state.latestFieldCatalog = buildFieldCatalogFromPayload(state.latestPayload);
      }
      renderPanelContent();
    });

    bindClick('__add_rule__', () => {
      state.config.rules.push(newRule());
      renderPanelContent();
    });

    bindClick('__show_block__', () => {
      if (!state.blockItems.length) return alert('当前没有拦截明细');
      showBlockModal(state.blockItems);
    });

    bindClick('__show_warn__', () => {
      if (!state.warnItems.length) return alert('当前没有提示明细');
      showWarnModal(state.warnItems);
    });

    qsa('[data-role="remove-rule"]').forEach(btn => {
      btn.onclick = () => {
        const rid = btn.getAttribute('data-rule-id');
        state.config.rules = state.config.rules.filter(r => r.id !== rid);
        renderPanelContent();
      };
    });

    qsa('[data-role="add-cond"]').forEach(btn => {
      btn.onclick = () => {
        const rid = btn.getAttribute('data-rule-id');
        const rule = state.config.rules.find(r => r.id === rid);
        if (!rule) return;
        rule.conditions.push(newCondition());
        renderPanelContent();
      };
    });

    qsa('[data-role="remove-cond"]').forEach(btn => {
      btn.onclick = () => {
        const rid = btn.getAttribute('data-rule-id');
        const cid = btn.getAttribute('data-cond-id');
        const rule = state.config.rules.find(r => r.id === rid);
        if (!rule) return;
        rule.conditions = rule.conditions.filter(c => c.id !== cid);
        renderPanelContent();
      };
    });

    qsa('[data-role="cond-right-type"]').forEach(sel => {
      sel.onchange = () => {
        const rid = sel.getAttribute('data-rule-id');
        const cid = sel.getAttribute('data-cond-id');
        const rule = state.config.rules.find(r => r.id === rid);
        const cond = rule && rule.conditions.find(c => c.id === cid);
        if (!cond) return;
        cond.rightType = sel.value;
        renderPanelContent();
      };
    });

    qsa('[data-role="rule-scope-preset"]').forEach(sel => {
      sel.onchange = () => {
        const rid = sel.getAttribute('data-rule-id');
        const rule = state.config.rules.find(r => r.id === rid);
        if (!rule) return;

        const value = sel.value;
        if (!value) return;

        const parts = value.split('|||');
        if (parts.length !== 2) return;

        rule.scopeType = parts[0];
        rule.scopeValue = parts[1];

        renderPanelContent();
      };
    });
  }

  function ensurePanel() {
    ensureStyle();

    let fab = document.getElementById(FAB_ID);
    if (!fab) {
      fab = document.createElement('div');
      fab.id = FAB_ID;
      fab.textContent = '规则面板';
      fab.onclick = () => {
        state.panelOpen = !state.panelOpen;
        renderPanelContent();
      };
      document.documentElement.appendChild(fab);
    }

    let wrap = document.getElementById(PANEL_WRAP_ID);
    if (!wrap) {
      wrap = document.createElement('div');
      wrap.id = PANEL_WRAP_ID;
      document.documentElement.appendChild(wrap);
    }

    let panel = document.getElementById(PANEL_ID);
    if (!panel) {
      panel = document.createElement('div');
      panel.id = PANEL_ID;
      wrap.innerHTML = '';
      wrap.appendChild(panel);
    }

    renderPanelContent();
  }

  function installPanelAutoMount() {
    const tryMount = () => {
      try {
        ensurePanel();
      } catch (e) {
        console.error('[JDY-规则面板] 面板挂载失败:', e);
      }
    };

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', tryMount, { once: true });
    } else {
      tryMount();
    }

    window.addEventListener('load', tryMount);

    const rawPushState = history.pushState;
    history.pushState = function () {
      const ret = rawPushState.apply(this, arguments);
      setTimeout(tryMount, 50);
      setTimeout(tryMount, 500);
      return ret;
    };

    const rawReplaceState = history.replaceState;
    history.replaceState = function () {
      const ret = rawReplaceState.apply(this, arguments);
      setTimeout(tryMount, 50);
      setTimeout(tryMount, 500);
      return ret;
    };

    window.addEventListener('popstate', () => {
      setTimeout(tryMount, 50);
      setTimeout(tryMount, 500);
    });

    const mo = new MutationObserver(() => {
      const fab = document.getElementById(FAB_ID);
      const panel = document.getElementById(PANEL_ID);
      if (!fab || !panel) {
        tryMount();
      }
    });

    mo.observe(document.documentElement, {
      childList: true,
      subtree: true
    });

    setInterval(() => {
      const fab = document.getElementById(FAB_ID);
      const panel = document.getElementById(PANEL_ID);
      if (!fab || !panel) {
        tryMount();
      }
      syncCurrentPageMeta();
    }, 1500);
  }

  // =========================================================
  // 十七、实时检查
  // =========================================================
  function isPanelBusy() {
    if (!state.panelOpen) return false;
    const active = document.activeElement;
    return active instanceof Element && !!active.closest(`#${PANEL_ID}`);
  }

  function installLiveCheck() {
    const trigger = debounce(() => {
      if (isPanelBusy()) return;
      syncCurrentPageMeta();
      runLiveCheck('editing');
    }, 300);

    document.addEventListener('input', e => {
      if (isInsideOurUi(e.target)) return;
      trigger();
    }, true);

    document.addEventListener('change', e => {
      if (isInsideOurUi(e.target)) return;
      trigger();
    }, true);

    document.addEventListener('blur', e => {
      if (isInsideOurUi(e.target)) return;
      trigger();
    }, true);

    const mo = new MutationObserver(() => {
      if (isPanelBusy()) return;
      trigger();
    });

    mo.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true
    });

    setInterval(() => {
      syncCurrentPageMeta();
      scanButtonsFromDom();
      scanPageScopesFromDom();
    }, 2000);
  }

  // =========================================================
  // 十八、配置存储
  // =========================================================
  function mergeConfig(base, ext) {
    const result = Array.isArray(base) ? [...base] : { ...base };
    for (const k in ext) {
      const bv = result[k];
      const ev = ext[k];
      if (Array.isArray(ev)) {
        result[k] = ev;
      } else if (ev && typeof ev === 'object' && bv && typeof bv === 'object' && !Array.isArray(bv)) {
        result[k] = mergeConfig(bv, ev);
      } else {
        result[k] = ev;
      }
    }
    return result;
  }

  function loadConfig() {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (!saved) return clone(DEFAULT_CONFIG);
      return mergeConfig(clone(DEFAULT_CONFIG), JSON.parse(saved));
    } catch (e) {
      return clone(DEFAULT_CONFIG);
    }
  }

  // =========================================================
  // 十九、调试接口
  // =========================================================
  function exposeHelpers() {
    window.__JDY_RULE_PANEL__ = {
      getState() {
        return state;
      },
      getConfig() {
        return state.config;
      },
      openPanel() {
        state.panelOpen = true;
        ensurePanel();
        renderPanelContent();
      },
      closePanel() {
        state.panelOpen = false;
        renderPanelContent();
      },
      recheck() {
        runLiveCheck('manual-recheck');
      },
      syncPage() {
        syncCurrentPageMeta();
        renderPanelContent();
        return state.currentPageMeta;
      },
      checkResponse(payload) {
        if (isFullPayload(payload)) {
          applyPayload(payload, 'manual', true);
        } else {
          mergeInputReturnDeltas(payload);
        }
        runLiveCheck('manual-checkResponse');
        return {
          currentPageMeta: state.currentPageMeta,
          bodyFields: state.latestFieldCatalog,
          headFields: state.latestHeadFieldCatalog,
          buttons: state.latestButtonCatalog,
          pageScopes: state.latestPageScopes,
          blockItems: state.blockItems,
          warnItems: state.warnItems
        };
      }
    };
  }

  // =========================================================
  // 二十、启动
  // =========================================================
  function init() {
    patchFetch();
    patchXHR();
    interceptActions();
    installLiveCheck();
    exposeHelpers();
    installPanelAutoMount();
    log('规则面板终版（仅按当前HAR重构）已启动');
  }

  init();
})();
