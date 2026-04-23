// ==UserScript==
// @name         JDY-单据字段一致性校验模板
// @namespace    http://tampermonkey.net/
// @version      0.2.0
// @description  通用模板：拦截保存/提交/审核类动作，检查明细字段一致性并阻断误操作（支持单据切换、动态输入、条件规则）
// @author       Codex
// @match        *://tf.jdy.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const CONFIG = {
    debug: false,

    actionWhitelist: {
      btnKey: new Set(['special_save', 'bar_save', 'bar_savenew', 'bar_submit', 'bar_submitandnew', 'bar_audit', 'bar_out']),
      id: new Set(['special_save', 'bar_save', 'bar_savenew', 'bar_submit', 'bar_submitandnew', 'bar_audit', 'bar_out']),
      opk: new Set(['special_save', 'save', 'submit', 'audit', 'out_stock'])
    },

    // 兼容更多单据结构：优先 key 命中，fallback 用字段命中
    tableEntityKeyCandidates: ['material_entity', 'entryentity', 'subentry', 'materialentry'],

    fields: {
      seq: 'seq',
      name: 'material_name',
      code: 'materialid',
      category: 'materialgroup',
      left: 'material_model',
      right: 'conversionrate'
    },

    // 条件规则：按单据类型 + 商品编码/类别匹配后再比对
    compareRules: [
      {
        id: 'default',
        enabled: true,
        formTypeIncludes: [], // 例如 ['销售出库单']
        codeIncludes: [], // 例如 ['A', 'B']
        categoryIncludes: [], // 例如 ['面料']
        compareAs: 'number' // 'number' | 'text'
      }
    ],

    maxPopupItems: 50,
    autoPopupWhenDetected: false,

    // 小数比较策略
    epsilon: 1e-6,
    decimalPlaces: 6,

    // 动态输入防抖（ms）
    dynamicInputDebounce: 200,

    uiText: {
      bannerTitle: (count) => `检测到 ${count} 条字段异常`,
      bannerDesc: '点击保存/提交/审核/出库时会弹出详细提示。',
      modalTitle: '请先检查单据',
      modalDesc: '当前单据存在关键字段不一致。请根据“第几行 + 商品名称”定位并修改，确认无误后再继续保存、提交、审核或出库。',
      closeBtn: '我知道了，先去修改'
    }
  };

  const STYLE_ID = '__jdy_check_tpl_style__';
  const BANNER_ID = '__jdy_check_tpl_banner__';
  const MODAL_ID = '__jdy_check_tpl_modal__';

  const state = {
    latestEntity: null,
    latestMismatches: [],
    latestRows: [],
    latestDocType: '',
    lastDataHash: '',
    bannerDismissedAt: 0,
    lastInterceptAt: 0,
    lastTouchedAt: 0,
    lastEntityAt: 0,
    reanalyzeTimer: 0
  };

  function log(...args) {
    if (CONFIG.debug) console.log('[JDY校验模板]', ...args);
  }

  function normalizeText(val) {
    return String(val == null ? '' : val).replace(/\s+/g, ' ').trim();
  }

  function safeJsonParse(text) {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  function escapeHtml(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function deepWalk(node, visitor, seen = new WeakSet()) {
    if (!node || typeof node !== 'object' || seen.has(node)) return;
    seen.add(node);
    visitor(node);
    if (Array.isArray(node)) {
      for (const item of node) deepWalk(item, visitor, seen);
      return;
    }
    for (const k of Object.keys(node)) deepWalk(node[k], visitor, seen);
  }

  function pickDisplayValue(v) {
    if (v == null) return '';
    if (Array.isArray(v)) return normalizeText(v[1] != null ? v[1] : v[0]);
    if (typeof v === 'object') {
      if ('zh_CN' in v) return normalizeText(v.zh_CN);
      if ('name' in v) return normalizeText(v.name);
      if ('text' in v) return normalizeText(v.text);
      return normalizeText(JSON.stringify(v));
    }
    return normalizeText(v);
  }

  function extractFirstNumber(text) {
    const t = normalizeText(text).replace(/,/g, '');
    const m = t.match(/-?\d+(?:\.\d+)?/);
    return m ? Number(m[0]) : null;
  }

  function extractFormulaNumber(text) {
    const t = normalizeText(text).replace(/，/g, ',').replace(/,/g, '');
    const eq = t.match(/[=＝]\s*(-?\d+(?:\.\d+)?)/);
    if (eq) return Number(eq[1]);
    const nums = t.match(/-?\d+(?:\.\d+)?/g);
    if (nums && nums.length >= 2) return Number(nums[1]);
    return nums && nums.length === 1 ? Number(nums[0]) : null;
  }

  function roundTo(num, places) {
    if (!Number.isFinite(num)) return null;
    const p = 10 ** places;
    return Math.round(num * p) / p;
  }

  function numberEquals(a, b) {
    if (a == null || b == null || !Number.isFinite(a) || !Number.isFinite(b)) return false;
    const ar = roundTo(a, CONFIG.decimalPlaces);
    const br = roundTo(b, CONFIG.decimalPlaces);
    return Math.abs(ar - br) <= CONFIG.epsilon;
  }

  function textEquals(a, b) {
    return normalizeText(a) === normalizeText(b);
  }

  function getDocTypeFromRoot(root) {
    if (!root || typeof root !== 'object') return '';
    let found = '';
    deepWalk(root, (obj) => {
      if (found || !obj || typeof obj !== 'object') return;
      if (obj.billtypename) found = pickDisplayValue(obj.billtypename);
      else if (obj.billtype) found = pickDisplayValue(obj.billtype);
      else if (obj.formid && typeof obj.formid === 'string') found = obj.formid;
    });
    return found;
  }

  function hasAnyField(dataindex, key) {
    return Object.prototype.hasOwnProperty.call(dataindex || {}, key);
  }

  function findTableEntity(root) {
    let found = null;
    deepWalk(root, (obj) => {
      if (found || !obj || typeof obj !== 'object') return;

      if (obj.k && CONFIG.tableEntityKeyCandidates.includes(String(obj.k).toLowerCase()) && obj.data?.dataindex && Array.isArray(obj.data?.rows)) {
        found = obj.data;
        return;
      }

      if (obj.dataindex && Array.isArray(obj.rows)) {
        const di = obj.dataindex;
        if (hasAnyField(di, CONFIG.fields.left) || hasAnyField(di, CONFIG.fields.right)) found = obj;
      }
    });
    return found;
  }

  function matchedRule(docType, code, category) {
    const dt = normalizeText(docType);
    const c = normalizeText(code);
    const cg = normalizeText(category);

    const active = CONFIG.compareRules.filter((r) => r && r.enabled !== false);
    for (const rule of active) {
      const passDoc = !rule.formTypeIncludes?.length || rule.formTypeIncludes.some((x) => dt.includes(normalizeText(x)));
      const passCode = !rule.codeIncludes?.length || rule.codeIncludes.some((x) => c.includes(normalizeText(x)));
      const passCate = !rule.categoryIncludes?.length || rule.categoryIncludes.some((x) => cg.includes(normalizeText(x)));
      if (passDoc && passCode && passCate) return rule;
    }
    return null;
  }

  function analyzeEntity(entity, docType) {
    if (!entity?.dataindex || !Array.isArray(entity.rows)) return { rows: [], mismatches: [] };

    const di = entity.dataindex;
    const idxSeq = di[CONFIG.fields.seq];
    const idxName = di[CONFIG.fields.name];
    const idxCode = di[CONFIG.fields.code];
    const idxCategory = di[CONFIG.fields.category];
    const idxLeft = di[CONFIG.fields.left];
    const idxRight = di[CONFIG.fields.right];

    if (idxLeft == null || idxRight == null) return { rows: [], mismatches: [] };

    const rows = entity.rows.map((row, i) => {
      const seq = pickDisplayValue(row[idxSeq]) || String(i + 1);
      const name = pickDisplayValue(row[idxName]);
      const code = pickDisplayValue(row[idxCode]);
      const category = pickDisplayValue(row[idxCategory]);
      const leftText = pickDisplayValue(row[idxLeft]);
      const rightText = pickDisplayValue(row[idxRight]);

      const leftNum = extractFirstNumber(leftText);
      const rightNum = extractFormulaNumber(rightText);
      const rule = matchedRule(docType, code, category);

      let mismatch = false;
      let compareType = 'skip';
      if (rule) {
        compareType = rule.compareAs === 'text' ? 'text' : 'number';
        if (compareType === 'text') mismatch = !textEquals(leftText, rightText);
        else {
          const bothNotNumeric = !Number.isFinite(leftNum) && !Number.isFinite(rightNum);
          mismatch = bothNotNumeric ? !textEquals(leftText, rightText) : !numberEquals(leftNum, rightNum);
        }
      }

      return {
        rowIndex: i + 1,
        seq,
        name,
        code,
        category,
        leftText,
        rightText,
        leftNum,
        rightNum,
        compareType,
        ruleId: rule?.id || '',
        mismatch
      };
    });

    return { rows, mismatches: rows.filter((x) => x.mismatch) };
  }

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      #${BANNER_ID}{position:fixed;right:16px;bottom:16px;z-index:999999;background:#fff2f0;border:1px solid #ffccc7;color:#a8071a;border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.15);padding:12px 36px 12px 14px;max-width:520px;font-size:13px;line-height:1.6}
      #${BANNER_ID} .close-x{position:absolute;right:10px;top:6px;cursor:pointer;font-size:16px;color:#8c8c8c;user-select:none}
      #${MODAL_ID}{position:fixed;inset:0;z-index:1000000;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center}
      #${MODAL_ID} .box{width:min(900px,calc(100vw - 32px));max-height:80vh;overflow:auto;background:#fff;border-radius:12px;box-shadow:0 12px 36px rgba(0,0,0,.25);padding:20px;color:#262626}
      #${MODAL_ID} .title{font-size:18px;font-weight:700;color:#cf1322;margin-bottom:12px}
      #${MODAL_ID} .desc{color:#595959;margin-bottom:12px;line-height:1.8}
      #${MODAL_ID} ol{padding-left:20px}
      #${MODAL_ID} li{margin-bottom:10px;line-height:1.8;background:#fff7e6;border:1px solid #ffe7ba;border-radius:8px;padding:10px 12px;list-style-position:inside}
      #${MODAL_ID} .actions{margin-top:16px;text-align:right}
      #${MODAL_ID} button{border:none;background:#cf1322;color:#fff;padding:8px 16px;border-radius:6px;cursor:pointer}
    `;
    document.documentElement.appendChild(style);
  }

  function makeDataHash(docType, rows, mismatches) {
    return JSON.stringify({
      docType,
      rows: rows.length,
      mismatchRows: mismatches.map((x) => [x.seq, x.code, x.leftText, x.rightText, x.ruleId])
    });
  }

  function closeModal() {
    document.getElementById(MODAL_ID)?.remove();
  }

  function showModal(mismatches) {
    ensureStyle();
    closeModal();

    const modal = document.createElement('div');
    modal.id = MODAL_ID;

    const listHtml = mismatches
      .slice(0, CONFIG.maxPopupItems)
      .map(
        (item) => `
      <li>
        <div><b>第 ${escapeHtml(item.seq)} 行</b>${item.name ? `　商品：<b>${escapeHtml(item.name)}</b>` : ''}${item.code ? `　编码：<b>${escapeHtml(item.code)}</b>` : ''}</div>
        <div>左字段：<b>${escapeHtml(item.leftText || '-')}</b></div>
        <div>右字段：<b>${escapeHtml(item.rightText || '-')}</b></div>
        <div>规则：<b>${escapeHtml(item.ruleId || 'default')}</b>（${escapeHtml(item.compareType)}）</div>
      </li>`
      )
      .join('');

    modal.innerHTML = `
      <div class="box">
        <div class="title">${escapeHtml(CONFIG.uiText.modalTitle)}</div>
        <div class="desc">${escapeHtml(CONFIG.uiText.modalDesc)}</div>
        <ol>${listHtml}</ol>
        <div class="actions"><button type="button" id="__jdy_check_tpl_close_btn__">${escapeHtml(CONFIG.uiText.closeBtn)}</button></div>
      </div>`;

    document.body.appendChild(modal);
    document.getElementById('__jdy_check_tpl_close_btn__')?.addEventListener('click', closeModal);
    modal.addEventListener('click', (e) => e.target === modal && closeModal());
  }

  function removeBanner() {
    document.getElementById(BANNER_ID)?.remove();
  }

  function updateBanner(forceShow) {
    ensureStyle();
    if (!state.latestMismatches.length) {
      removeBanner();
      return;
    }

    const now = Date.now();
    if (!forceShow && state.bannerDismissedAt && now - state.bannerDismissedAt < 1500) return;

    let banner = document.getElementById(BANNER_ID);
    if (!banner) {
      banner = document.createElement('div');
      banner.id = BANNER_ID;
      document.body.appendChild(banner);
    }

    banner.innerHTML = `
      <div class="close-x" id="__jdy_check_tpl_banner_close__">×</div>
      <div><strong>${escapeHtml(CONFIG.uiText.bannerTitle(state.latestMismatches.length))}</strong></div>
      <div>${escapeHtml(CONFIG.uiText.bannerDesc)}</div>
      <div>当前单据类型：${escapeHtml(state.latestDocType || '-')}</div>`;

    document.getElementById('__jdy_check_tpl_banner_close__')?.addEventListener('click', () => {
      state.bannerDismissedAt = Date.now();
      removeBanner();
    });
  }

  function applyPayload(root, source) {
    const entity = findTableEntity(root);
    if (!entity) return false;

    const docType = getDocTypeFromRoot(root) || state.latestDocType;
    const { rows, mismatches } = analyzeEntity(entity, docType);
    const hash = makeDataHash(docType, rows, mismatches);
    const changed = hash !== state.lastDataHash;

    state.latestEntity = entity;
    state.latestRows = rows;
    state.latestMismatches = mismatches;
    state.latestDocType = docType;
    state.lastDataHash = hash;
    state.lastEntityAt = Date.now();

    if (mismatches.length) updateBanner(changed);
    else removeBanner();

    if (CONFIG.autoPopupWhenDetected && mismatches.length && changed) showModal(mismatches);

    log('applyPayload', source, { docType, rows: rows.length, mismatches: mismatches.length });
    return true;
  }

  function reanalyzeFromLatest(source = 'local-reanalyze') {
    if (!state.latestEntity) return false;
    const { rows, mismatches } = analyzeEntity(state.latestEntity, state.latestDocType);
    const hash = makeDataHash(state.latestDocType, rows, mismatches);
    const changed = hash !== state.lastDataHash;

    state.latestRows = rows;
    state.latestMismatches = mismatches;
    state.lastDataHash = hash;

    if (mismatches.length) updateBanner(changed);
    else removeBanner();

    log('reanalyzeFromLatest', source, { rows: rows.length, mismatches: mismatches.length });
    return true;
  }

  function scheduleReanalyze(source) {
    if (state.reanalyzeTimer) clearTimeout(state.reanalyzeTimer);
    state.reanalyzeTimer = window.setTimeout(() => {
      state.reanalyzeTimer = 0;
      reanalyzeFromLatest(source);
    }, CONFIG.dynamicInputDebounce);
  }

  function tryHandleResponseData(data, source) {
    if (!data) return;
    try {
      applyPayload(data, source);
    } catch (e) {
      log('处理返回数据失败', source, e);
    }
  }

  function tryHandleRequestBody(body, source) {
    if (!body) return;
    if (body instanceof FormData) {
      for (const key of ['payload', 'data', 'model', 'formData']) {
        const v = body.get(key);
        if (typeof v !== 'string') continue;
        const json = safeJsonParse(v);
        if (json) {
          tryHandleResponseData(json, `${source}:request-${key}`);
          return;
        }
      }
      return;
    }

    const text = typeof body === 'string' ? body : body instanceof URLSearchParams ? body.toString() : null;
    if (!text) return;

    // 常见请求体格式：payload=JSON / data=JSON / 直接 JSON
    const direct = safeJsonParse(text);
    if (direct) {
      tryHandleResponseData(direct, `${source}:request-json`);
      return;
    }

    const params = new URLSearchParams(text);
    for (const key of ['payload', 'data', 'model', 'formData']) {
      const v = params.get(key);
      if (!v) continue;
      const json = safeJsonParse(v);
      if (json) {
        tryHandleResponseData(json, `${source}:request-${key}`);
        return;
      }
    }
  }

  function patchFetch() {
    if (!window.fetch) return;
    const rawFetch = window.fetch;
    window.fetch = async function (...args) {
      const reqInit = args[1] || {};
      const requestObj = args[0] instanceof Request ? args[0] : null;
      tryHandleRequestBody(reqInit.body ?? requestObj?.body, 'fetch');

      const res = await rawFetch.apply(this, args);
      try {
        const json = safeJsonParse(await res.clone().text());
        if (json) tryHandleResponseData(json, 'fetch');
      } catch (e) {
        log('fetch 拦截失败', e);
      }
      return res;
    };
  }

  function patchXHR() {
    const rawOpen = XMLHttpRequest.prototype.open;
    const rawSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
      this.__jdy_url__ = url;
      return rawOpen.call(this, method, url, ...rest);
    };

    XMLHttpRequest.prototype.send = function (...args) {
      tryHandleRequestBody(args[0], 'xhr');

      this.addEventListener('load', function () {
        try {
          if (typeof this.responseText !== 'string') return;
          const json = safeJsonParse(this.responseText);
          if (json) tryHandleResponseData(json, 'xhr');
        } catch (e) {
          log('xhr 拦截失败', e);
        }
      });
      return rawSend.apply(this, args);
    };
  }

  function isInsideOurUi(node) {
    return node instanceof Element && !!node.closest(`#${MODAL_ID}, #${BANNER_ID}`);
  }

  function findMatchedActionRoot(target) {
    if (!(target instanceof Element) || isInsideOurUi(target)) return null;

    let node = target;
    for (let i = 0; node && i < 10; i += 1) {
      const btnKey = node.getAttribute?.('data-btn-key');
      const opk = node.getAttribute?.('data-opk');
      const id = node.id || '';

      if (CONFIG.actionWhitelist.btnKey.has(btnKey) || CONFIG.actionWhitelist.opk.has(opk) || CONFIG.actionWhitelist.id.has(id)) {
        return node;
      }

      if (btnKey || opk || id) {
        const isToolbarButton = node.getAttribute?.('data-type') === 'baritem' || node.hasAttribute?.('buttontype');
        if (isToolbarButton) return null;
      }
      node = node.parentElement;
    }
    return null;
  }

  function shouldDebounceIntercept() {
    const now = Date.now();
    if (now - state.lastInterceptAt < 800) return true;
    state.lastInterceptAt = now;
    return false;
  }

  function blockAndShow(evt) {
    if (!state.latestMismatches.length) return false;
    if (shouldDebounceIntercept()) {
      evt.preventDefault();
      evt.stopPropagation();
      evt.stopImmediatePropagation?.();
      return true;
    }

    evt.preventDefault();
    evt.stopPropagation();
    evt.stopImmediatePropagation?.();

    updateBanner(true);
    showModal(state.latestMismatches);
    return true;
  }

  function interceptActions() {
    const handler = (evt) => {
      if (!state.latestMismatches.length) return;
      if (!findMatchedActionRoot(evt.target)) return;
      blockAndShow(evt);
    };

    document.addEventListener('pointerdown', handler, true);
    document.addEventListener('click', handler, true);
    document.addEventListener('submit', (evt) => state.latestMismatches.length && blockAndShow(evt), true);
    document.addEventListener(
      'keydown',
      (evt) => {
        const isSaveHotkey = (evt.ctrlKey || evt.metaKey) && String(evt.key).toLowerCase() === 's';
        if (isSaveHotkey && state.latestMismatches.length) blockAndShow(evt);
      },
      true
    );
  }

  function monitorDocSwitchAndInput() {
    const markTouched = () => {
      state.lastTouchedAt = Date.now();
      scheduleReanalyze('input/change');
    };

    document.addEventListener('input', markTouched, true);
    document.addEventListener('change', markTouched, true);

    const observer = new MutationObserver(() => {
      // 大量节点变化通常来自切单/切页签/行编辑完成
      state.lastTouchedAt = Date.now();
      scheduleReanalyze('mutation');
    });

    const startObserve = () => {
      if (!document.body) return;
      observer.observe(document.body, { childList: true, subtree: true });
    };

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', startObserve, { once: true });
    } else {
      startObserve();
    }
  }

  function exposeHelpers() {
    window.__JDY_CHECK_TEMPLATE__ = {
      getState: () => state,
      show: () => showModal(state.latestMismatches),
      close: () => closeModal(),
      refreshBanner: () => updateBanner(true),
      checkResponse: (payload) => {
        applyPayload(payload, 'manual');
        return state.latestMismatches;
      }
    };
  }

  function init() {
    ensureStyle();
    patchFetch();
    patchXHR();
    interceptActions();
    monitorDocSwitchAndInput();
    exposeHelpers();
    log('脚本已启动');
  }

  init();
})();
