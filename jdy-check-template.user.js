// ==UserScript==
// @name         JDY-单据字段一致性校验模板
// @namespace    http://tampermonkey.net/
// @version      0.1.0
// @description  通用模板：拦截保存/提交/审核类动作，检查明细字段一致性并阻断误操作
// @author       Codex
// @match        *://tf.jdy.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  /**
   * =============================
   * 1) 只改这一段配置即可复用脚本
   * =============================
   */
  const CONFIG = {
    debug: false,

    // 允许拦截的按钮（精确匹配）
    actionWhitelist: {
      btnKey: new Set([
        'special_save',
        'bar_save',
        'bar_savenew',
        'bar_submit',
        'bar_submitandnew',
        'bar_audit',
        'bar_out'
      ]),
      id: new Set([
        'special_save',
        'bar_save',
        'bar_savenew',
        'bar_submit',
        'bar_submitandnew',
        'bar_audit',
        'bar_out'
      ]),
      opk: new Set(['special_save', 'save', 'submit', 'audit', 'out_stock'])
    },

    // 在响应 JSON 中定位目标表体的候选 key（按优先级）
    tableEntityKeyCandidates: ['material_entity'],

    // 必须字段：行号、展示名称、左侧校验字段、右侧校验字段
    // value extractors 可按业务改写。
    fields: {
      seq: 'seq',
      name: 'material_name',
      code: 'materialid',
      left: 'material_model',
      right: 'conversionrate'
    },

    // 弹窗最多显示多少条异常
    maxPopupItems: 50,

    // 自动探测到异常时是否立刻弹窗（一般 false，避免打断录单）
    autoPopupWhenDetected: false,

    // 差值容忍
    epsilon: 1e-6,

    // 标题/文案
    uiText: {
      bannerTitle: (count) => `检测到 ${count} 条字段异常`,
      bannerDesc: '点击保存/提交/审核/出库时会弹出详细提示。',
      modalTitle: '请先检查单据',
      modalDesc:
        '当前单据存在关键字段不一致。请根据“第几行 + 商品名称”定位并修改，确认无误后再继续保存、提交、审核或出库。',
      closeBtn: '我知道了，先去修改'
    }
  };

  /**
   * =============================
   * 2) 通用运行时（通常无需改）
   * =============================
   */
  const STYLE_ID = '__jdy_check_tpl_style__';
  const BANNER_ID = '__jdy_check_tpl_banner__';
  const MODAL_ID = '__jdy_check_tpl_modal__';

  const state = {
    latestEntity: null,
    latestMismatches: [],
    lastDataHash: '',
    bannerDismissedAt: 0,
    lastInterceptAt: 0
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
      return normalizeText(JSON.stringify(v));
    }
    return normalizeText(v);
  }

  function extractFirstNumber(text) {
    const t = normalizeText(text);
    const m = t.match(/-?\d+(?:\.\d+)?/);
    return m ? Number(m[0]) : null;
  }

  function extractFormulaNumber(text) {
    const t = normalizeText(text).replace(/，/g, ',');
    const eq = t.match(/[=＝]\s*(-?\d+(?:\.\d+)?)/);
    if (eq) return Number(eq[1]);

    const nums = t.match(/-?\d+(?:\.\d+)?/g);
    if (nums && nums.length >= 2) return Number(nums[1]);

    return nums && nums.length === 1 ? Number(nums[0]) : null;
  }

  function defaultCompare(leftNum, rightNum) {
    if (leftNum == null || rightNum == null) return false;
    return Math.abs(Number(leftNum) - Number(rightNum)) > CONFIG.epsilon;
  }

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      #${BANNER_ID}{position:fixed;right:16px;bottom:16px;z-index:999999;background:#fff2f0;border:1px solid #ffccc7;color:#a8071a;border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.15);padding:12px 36px 12px 14px;max-width:460px;font-size:13px;line-height:1.6}
      #${BANNER_ID} .close-x{position:absolute;right:10px;top:6px;cursor:pointer;font-size:16px;color:#8c8c8c;user-select:none}
      #${MODAL_ID}{position:fixed;inset:0;z-index:1000000;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center}
      #${MODAL_ID} .box{width:min(820px,calc(100vw - 32px));max-height:80vh;overflow:auto;background:#fff;border-radius:12px;box-shadow:0 12px 36px rgba(0,0,0,.25);padding:20px;color:#262626}
      #${MODAL_ID} .title{font-size:18px;font-weight:700;color:#cf1322;margin-bottom:12px}
      #${MODAL_ID} .desc{color:#595959;margin-bottom:12px;line-height:1.8}
      #${MODAL_ID} ol{padding-left:20px}
      #${MODAL_ID} li{margin-bottom:10px;line-height:1.8;background:#fff7e6;border:1px solid #ffe7ba;border-radius:8px;padding:10px 12px;list-style-position:inside}
      #${MODAL_ID} .actions{margin-top:16px;text-align:right}
      #${MODAL_ID} button{border:none;background:#cf1322;color:#fff;padding:8px 16px;border-radius:6px;cursor:pointer}
    `;
    document.documentElement.appendChild(style);
  }

  function makeDataHash(mismatches) {
    return JSON.stringify(mismatches.map((x) => [x.seq, x.name, x.leftNum, x.rightNum]));
  }

  function hasAnyField(dataindex, key) {
    return Object.prototype.hasOwnProperty.call(dataindex || {}, key);
  }

  function findTableEntity(root) {
    let found = null;
    deepWalk(root, (obj) => {
      if (found || !obj || typeof obj !== 'object') return;

      if (obj.k && CONFIG.tableEntityKeyCandidates.includes(obj.k) && obj.data?.dataindex && Array.isArray(obj.data?.rows)) {
        found = obj.data;
        return;
      }

      if (obj.dataindex && Array.isArray(obj.rows)) {
        const di = obj.dataindex;
        if (hasAnyField(di, CONFIG.fields.left) || hasAnyField(di, CONFIG.fields.right)) {
          found = obj;
        }
      }
    });

    return found;
  }

  function analyzeEntity(entity) {
    if (!entity?.dataindex || !Array.isArray(entity.rows)) return [];

    const di = entity.dataindex;
    const idxSeq = di[CONFIG.fields.seq];
    const idxName = di[CONFIG.fields.name];
    const idxCode = di[CONFIG.fields.code];
    const idxLeft = di[CONFIG.fields.left];
    const idxRight = di[CONFIG.fields.right];

    if (idxLeft == null || idxRight == null) return [];

    return entity.rows
      .map((row, i) => {
        const seq = pickDisplayValue(row[idxSeq]) || String(i + 1);
        const name = pickDisplayValue(row[idxName]);
        const code = pickDisplayValue(row[idxCode]);

        const leftText = pickDisplayValue(row[idxLeft]);
        const rightText = pickDisplayValue(row[idxRight]);

        const leftNum = extractFirstNumber(leftText);
        const rightNum = extractFormulaNumber(rightText);
        const mismatch = defaultCompare(leftNum, rightNum);

        return { rowIndex: i + 1, seq, name, code, leftText, rightText, leftNum, rightNum, mismatch };
      })
      .filter((item) => item.mismatch);
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
        <div><b>第 ${escapeHtml(item.seq)} 行</b>${item.name ? `　商品：<b>${escapeHtml(item.name)}</b>` : ''}</div>
        <div>左字段：<b>${escapeHtml(item.leftText || '-')}</b></div>
        <div>右字段：<b>${escapeHtml(item.rightText || '-')}</b></div>
        <div>比对结果：<b>${escapeHtml(item.leftNum)}</b> ≠ <b>${escapeHtml(item.rightNum)}</b></div>
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
      <div>${escapeHtml(CONFIG.uiText.bannerDesc)}</div>`;

    document.getElementById('__jdy_check_tpl_banner_close__')?.addEventListener('click', () => {
      state.bannerDismissedAt = Date.now();
      removeBanner();
    });
  }

  function applyPayload(root, source) {
    const entity = findTableEntity(root);
    if (!entity) return false;

    const mismatches = analyzeEntity(entity);
    const hash = makeDataHash(mismatches);
    const changed = hash !== state.lastDataHash;

    state.latestEntity = entity;
    state.latestMismatches = mismatches;
    state.lastDataHash = hash;

    if (mismatches.length) updateBanner(changed);
    else removeBanner();

    if (CONFIG.autoPopupWhenDetected && mismatches.length && changed) showModal(mismatches);

    log('applyPayload', source, mismatches);
    return true;
  }

  function tryHandleResponseData(data, source) {
    if (!data) return;
    try {
      applyPayload(data, source);
    } catch (e) {
      log('处理返回数据失败', source, e);
    }
  }

  function patchFetch() {
    if (!window.fetch) return;
    const rawFetch = window.fetch;
    window.fetch = async function (...args) {
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
    const rawSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function (...args) {
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

      if (
        CONFIG.actionWhitelist.btnKey.has(btnKey) ||
        CONFIG.actionWhitelist.opk.has(opk) ||
        CONFIG.actionWhitelist.id.has(id)
      ) {
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
    if (shouldDebounceIntercept()) return true;

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
    exposeHelpers();
    log('脚本已启动');
  }

  init();
})();
