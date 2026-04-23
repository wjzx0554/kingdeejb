// ==UserScript==
// @name         金蝶精斗云-双单位换算校验（1.2.0 原始存档）
// @namespace    http://tampermonkey.net/
// @version      1.2.0
// @description  用户提供版本存档：规格>换算强拦截；规格<换算提示确认
// @match        *://tf.jdy.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const CONFIG = {
    debug: false,
    allowedBtnKeys: new Set(['special_save', 'bar_save', 'bar_savenew', 'bar_submit', 'bar_submitandnew', 'bar_audit', 'bar_out']),
    allowedIds: new Set(['special_save', 'bar_save', 'bar_savenew', 'bar_submit', 'bar_submitandnew', 'bar_audit', 'bar_out']),
    allowedOpk: new Set(['special_save', 'save', 'submit', 'audit', 'out_stock']),
    maxPopupItems: 50
  };

  const STYLE_ID = '__jdy_unit_check_style__';
  const BANNER_ID = '__jdy_unit_check_banner__';
  const MODAL_ID = '__jdy_unit_check_modal__';

  const state = {
    latestEntity: null,
    blockingItems: [],
    warningItems: [],
    lastDataHash: '',
    bannerDismissedAt: 0,
    lastInterceptAt: 0,
    bypassRoot: null,
    bypassUntil: 0,
    bypassRemaining: 0
  };

  const log = (...args) => CONFIG.debug && console.log('[金蝶双单位校验1.2]', ...args);

  const normalizeText = (val) => String(val == null ? '' : val).replace(/\s+/g, ' ').trim();
  const safeJsonParse = (text) => {
    try { return JSON.parse(text); } catch { return null; }
  };

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
      for (const x of node) deepWalk(x, visitor, seen);
      return;
    }
    Object.keys(node).forEach((k) => deepWalk(node[k], visitor, seen));
  }

  function pickDisplayValue(v) {
    if (v == null) return '';
    if (Array.isArray(v)) return normalizeText(v[1] != null ? v[1] : v[0]);
    if (typeof v === 'object') {
      if ('zh_CN' in v) return normalizeText(v.zh_CN);
      return normalizeText(JSON.stringify(v));
    }
    return normalizeText(v);
  }

  function extractSpecNumber(text) {
    const m = normalizeText(text).match(/-?\d+(?:\.\d+)?/);
    return m ? Number(m[0]) : null;
  }

  function extractFormulaNumber(text) {
    const t = normalizeText(text).replace(/，/g, ',');
    const eq = t.match(/[=＝]\s*(-?\d+(?:\.\d+)?)/);
    if (eq) return Number(eq[1]);
    const nums = t.match(/-?\d+(?:\.\d+)?/g);
    if (nums && nums.length >= 2) return Number(nums[1]);
    return null;
  }

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      #${BANNER_ID}{position:fixed;right:16px;bottom:16px;z-index:999999;background:#fff2f0;border:1px solid #ffccc7;color:#a8071a;border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.15);padding:12px 36px 12px 14px;max-width:520px;font-size:13px;line-height:1.6}
      #${BANNER_ID} .close-x{position:absolute;right:10px;top:6px;cursor:pointer;font-size:16px;color:#8c8c8c;user-select:none}
      #${MODAL_ID}{position:fixed;inset:0;z-index:1000000;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center}
      #${MODAL_ID} .box{width:min(860px,calc(100vw - 32px));max-height:80vh;overflow:auto;background:#fff;border-radius:12px;box-shadow:0 12px 36px rgba(0,0,0,.25);padding:20px;color:#262626}
      #${MODAL_ID} .title{font-size:18px;font-weight:700;color:#cf1322;margin-bottom:12px}
      #${MODAL_ID} .desc{color:#595959;margin-bottom:12px;line-height:1.8}
      #${MODAL_ID} ol{padding-left:20px}
      #${MODAL_ID} li{margin-bottom:10px;line-height:1.8;background:#fff7e6;border:1px solid #ffe7ba;border-radius:8px;padding:10px 12px;list-style-position:inside}
      #${MODAL_ID} .actions{margin-top:16px;text-align:right}
      #${MODAL_ID} button{border:none;background:#cf1322;color:#fff;padding:8px 16px;border-radius:6px;cursor:pointer;margin-left:8px}
      #${MODAL_ID} .secondary{background:#8c8c8c}
    `;
    document.documentElement.appendChild(style);
  }

  const makeDataHash = (blockingItems, warningItems) => JSON.stringify({
    block: blockingItems.map((x) => [x.seq, x.specValue, x.formulaValue]),
    warn: warningItems.map((x) => [x.seq, x.specValue, x.formulaValue])
  });

  function findMaterialEntity(root) {
    let found = null;
    deepWalk(root, (obj) => {
      if (found) return;
      if (obj?.k === 'material_entity' && obj?.data?.dataindex && Array.isArray(obj?.data?.rows)) {
        found = obj.data;
        return;
      }
      if (obj?.dataindex && Array.isArray(obj?.rows) && (Object.prototype.hasOwnProperty.call(obj.dataindex, 'material_model') || Object.prototype.hasOwnProperty.call(obj.dataindex, 'conversionrate'))) {
        found = obj;
      }
    });
    return found;
  }

  function analyzeMaterialEntity(entity) {
    if (!entity?.dataindex || !Array.isArray(entity.rows)) return { blockingItems: [], warningItems: [] };
    const di = entity.dataindex;
    const idxSeq = di.seq;
    const idxMaterialName = di.material_name;
    const idxMaterialId = di.materialid;
    const idxMaterialModel = di.material_model;
    const idxConversionRate = di.conversionrate;
    if (idxMaterialModel == null || idxConversionRate == null) return { blockingItems: [], warningItems: [] };

    const blockingItems = [];
    const warningItems = [];

    entity.rows.forEach((row, i) => {
      const seq = pickDisplayValue(row[idxSeq]) || String(i + 1);
      const materialName = pickDisplayValue(row[idxMaterialName]);
      const materialCode = pickDisplayValue(row[idxMaterialId]);
      const specText = pickDisplayValue(row[idxMaterialModel]);
      const formulaText = pickDisplayValue(row[idxConversionRate]);
      const specValue = extractSpecNumber(specText);
      const formulaValue = extractFormulaNumber(formulaText);
      if (specValue == null || formulaValue == null) return;

      const item = { rowIndex: i + 1, seq, materialName, materialCode, specText, formulaText, specValue, formulaValue };
      if (specValue > formulaValue) blockingItems.push(item);
      else if (specValue < formulaValue) warningItems.push(item);
    });

    return { blockingItems, warningItems };
  }

  const closeModal = () => document.getElementById(MODAL_ID)?.remove();

  function renderItemList(items) {
    return items.slice(0, CONFIG.maxPopupItems).map((item) => `
      <li>
        <div><b>第 ${escapeHtml(item.seq)} 行</b>${item.materialName ? `　商品：<b>${escapeHtml(item.materialName)}</b>` : ''}</div>
        <div>规格型号：<b>${escapeHtml(item.specText || '-')}</b></div>
        <div>换算公式：<b>${escapeHtml(normalizeText(item.formulaText) || '-')}</b></div>
        <div>对比结果：<b>${escapeHtml(item.specValue)}</b> ${item.specValue > item.formulaValue ? '&gt;' : '&lt;'} <b>${escapeHtml(item.formulaValue)}</b></div>
      </li>
    `).join('');
  }

  function showBlockingModal(items) {
    ensureStyle();
    closeModal();
    const modal = document.createElement('div');
    modal.id = MODAL_ID;
    modal.innerHTML = `
      <div class="box">
        <div class="title">当前单据不能继续操作</div>
        <div class="desc">检测到以下商品存在 <b>规格型号大于换算公式</b>，请先修改后再操作。</div>
        <ol>${renderItemList(items)}</ol>
        <div class="actions"><button type="button" id="__jdy_unit_check_close_btn__">我知道了</button></div>
      </div>`;
    document.body.appendChild(modal);
    document.getElementById('__jdy_unit_check_close_btn__')?.addEventListener('click', closeModal);
    modal.addEventListener('click', (e) => e.target === modal && closeModal());
  }

  function showWarningModal(items, onContinue) {
    ensureStyle();
    closeModal();
    const modal = document.createElement('div');
    modal.id = MODAL_ID;
    modal.innerHTML = `
      <div class="box">
        <div class="title">请确认是否继续操作</div>
        <div class="desc">检测到以下商品存在 <b>规格型号小于换算公式</b>，建议先核对后再继续。</div>
        <ol>${renderItemList(items)}</ol>
        <div class="actions">
          <button type="button" class="secondary" id="__jdy_unit_check_back_btn__">返回修改</button>
          <button type="button" id="__jdy_unit_check_continue_btn__">继续操作</button>
        </div>
      </div>`;
    document.body.appendChild(modal);

    document.getElementById('__jdy_unit_check_back_btn__')?.addEventListener('click', closeModal);
    document.getElementById('__jdy_unit_check_continue_btn__')?.addEventListener('click', () => {
      closeModal();
      if (typeof onContinue === 'function') onContinue();
    });
    modal.addEventListener('click', (e) => e.target === modal && closeModal());
  }

  const removeBanner = () => document.getElementById(BANNER_ID)?.remove();

  function updateBanner(forceShow) {
    ensureStyle();
    const blockCount = state.blockingItems.length;
    const warnCount = state.warningItems.length;
    if (!blockCount && !warnCount) return removeBanner();

    const now = Date.now();
    if (!forceShow && state.bannerDismissedAt && now - state.bannerDismissedAt < 1500) return;

    let desc = '';
    if (blockCount && warnCount) desc = `强拦截 ${blockCount} 条，提示确认 ${warnCount} 条。`;
    else if (blockCount) desc = `强拦截 ${blockCount} 条，修改后才能继续操作。`;
    else desc = `提示确认 ${warnCount} 条，点击操作时会二次确认。`;

    let banner = document.getElementById(BANNER_ID);
    if (!banner) {
      banner = document.createElement('div');
      banner.id = BANNER_ID;
      document.body.appendChild(banner);
    }

    banner.innerHTML = `
      <div class="close-x" id="__jdy_unit_check_banner_close__">×</div>
      <div><strong>检测到双单位差异</strong></div>
      <div>${escapeHtml(desc)}</div>`;

    document.getElementById('__jdy_unit_check_banner_close__')?.addEventListener('click', () => {
      state.bannerDismissedAt = Date.now();
      removeBanner();
    });
  }

  function applyPayload(root, source) {
    const entity = findMaterialEntity(root);
    if (!entity) return false;

    const result = analyzeMaterialEntity(entity);
    const hash = makeDataHash(result.blockingItems, result.warningItems);
    const changed = hash !== state.lastDataHash;

    state.latestEntity = entity;
    state.blockingItems = result.blockingItems;
    state.warningItems = result.warningItems;
    state.lastDataHash = hash;

    if (state.blockingItems.length || state.warningItems.length) updateBanner(changed);
    else removeBanner();

    log('applyPayload', source, { blocking: state.blockingItems.length, warning: state.warningItems.length });
    return true;
  }

  function tryHandleResponseData(data, source) {
    if (!data) return;
    try { applyPayload(data, source); } catch (e) { log('处理返回数据失败', e); }
  }

  function patchFetch() {
    if (!window.fetch) return;
    const rawFetch = window.fetch;
    window.fetch = async function (...args) {
      const res = await rawFetch.apply(this, args);
      try {
        const json = safeJsonParse(await res.clone().text());
        if (json) tryHandleResponseData(json, 'fetch');
      } catch (e) { log('fetch 拦截失败', e); }
      return res;
    };
  }

  function patchXHR() {
    const rawSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function (...args) {
      this.addEventListener('load', function () {
        try {
          if (typeof this.responseText !== 'string') return;
          const json = safeJsonParse(this.responseText);
          if (json) tryHandleResponseData(json, 'xhr');
        } catch (e) { log('xhr 拦截失败', e); }
      });
      return rawSend.apply(this, args);
    };
  }

  const isInsideOurUi = (node) => node instanceof Element && !!node.closest(`#${MODAL_ID}, #${BANNER_ID}`);

  function findMatchedActionRoot(target) {
    if (!(target instanceof Element) || isInsideOurUi(target)) return null;

    let node = target;
    let depth = 0;
    while (node && depth < 10) {
      const btnKey = node.getAttribute?.('data-btn-key') || '';
      const opk = node.getAttribute?.('data-opk') || '';
      const id = node.id || '';

      if (CONFIG.allowedBtnKeys.has(btnKey) || CONFIG.allowedOpk.has(opk) || CONFIG.allowedIds.has(id)) return node;

      if (btnKey || opk || id) {
        const isToolbarButton = node.getAttribute?.('data-type') === 'baritem' || node.hasAttribute?.('buttontype');
        if (isToolbarButton) return null;
      }
      node = node.parentElement;
      depth += 1;
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
      try { root.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, composed: true })); } catch {}
      try { root.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, composed: true })); } catch {}
      try { root.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, composed: true })); } catch {}
      try { root.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, composed: true })); } catch { try { root.click(); } catch {} }
    }, 0);
  }

  function blockEvent(evt) {
    evt.preventDefault();
    evt.stopPropagation();
    evt.stopImmediatePropagation?.();
  }

  function interceptActions() {
    const handler = (evt) => {
      const matchedRoot = findMatchedActionRoot(evt.target);
      if (!matchedRoot) return;
      if (consumeBypassIfMatch(matchedRoot)) return;

      const hasBlocking = state.blockingItems.length > 0;
      const hasWarning = state.warningItems.length > 0;
      if (!hasBlocking && !hasWarning) return;
      if (shouldDebounceIntercept()) return;

      blockEvent(evt);
      updateBanner(true);

      if (hasBlocking) return showBlockingModal(state.blockingItems);
      if (hasWarning) showWarningModal(state.warningItems, () => replayAction(matchedRoot));
    };

    document.addEventListener('pointerdown', handler, true);
    document.addEventListener('click', handler, true);
  }

  function exposeHelpers() {
    window.__JDY_UNIT_CHECK__ = {
      getState: () => state,
      showBlock: () => showBlockingModal(state.blockingItems),
      showWarn: () => showWarningModal(state.warningItems),
      close: () => closeModal(),
      refreshBanner: () => updateBanner(true),
      checkResponse: (payload) => {
        applyPayload(payload, 'manual');
        return { blockingItems: state.blockingItems, warningItems: state.warningItems };
      }
    };
  }

  function init() {
    ensureStyle();
    patchFetch();
    patchXHR();
    interceptActions();
    exposeHelpers();
    log('脚本已启动');
  }

  init();
})();
