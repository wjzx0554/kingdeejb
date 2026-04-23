// ==UserScript==
// @name         JDY 12 场景字段校验插件（Core骨架）
// @namespace    http://tampermonkey.net/
// @version      0.1.0
// @description  基于 TM Core Runtime 的 12.js 场景插件骨架：支持切单识别、条件比较、数值精度处理
// @author       Codex
// @match        *://tf.jdy.com/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  /**
   * 你只需要重点改这里：
   * 1) tableEntityKeyCandidates
   * 2) fields
   * 3) compareRules
   * 4) watchUrlPatterns
   */
  const CONFIG = {
    debug: false,

    tableEntityKeyCandidates: ['material_entity', 'entryentity', 'subentry', 'materialentry'],

    fields: {
      seq: 'seq',
      name: 'material_name',
      code: 'materialid',
      category: 'materialgroup',
      left: 'material_model',
      right: 'conversionrate'
    },

    // 按“单据类型 + 编码 + 类别”命中规则
    compareRules: [
      {
        id: 'default-number',
        enabled: true,
        formTypeIncludes: [],
        codeIncludes: [],
        categoryIncludes: [],
        compareAs: 'number' // 'number' | 'text'
      }
    ],

    epsilon: 1e-6,
    decimalPlaces: 6,

    // 只处理这些 URL（避免噪音）
    watchUrlPatterns: [/loadData/i, /save/i, /submit/i, /audit/i, /polling\.do/i],

    // 轻提示
    toast: {
      okColor: '#1677ff',
      errColor: '#d4380d',
      duration: 2600
    }
  };

  function waitCore(retry = 0) {
    const core = window.__TM_CORE_RUNTIME__;
    if (core) return Promise.resolve(core);
    if (retry > 100) return Promise.reject(new Error('TM Core Runtime 未加载'));
    return new Promise((resolve) => setTimeout(resolve, 100)).then(() => waitCore(retry + 1));
  }

  function normalizeText(val) {
    return String(val == null ? '' : val).replace(/\s+/g, ' ').trim();
  }

  function pickDisplay(v) {
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
    return nums && nums.length ? Number(nums[0]) : null;
  }

  function roundTo(num, places) {
    if (!Number.isFinite(num)) return null;
    const p = 10 ** places;
    return Math.round(num * p) / p;
  }

  function numberEquals(a, b) {
    if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
    const ar = roundTo(a, CONFIG.decimalPlaces);
    const br = roundTo(b, CONFIG.decimalPlaces);
    return Math.abs(ar - br) <= CONFIG.epsilon;
  }

  function textEquals(a, b) {
    return normalizeText(a) === normalizeText(b);
  }

  function urlWatched(url) {
    return CONFIG.watchUrlPatterns.some((r) => r.test(url || ''));
  }

  function getDocType(root, api) {
    let out = '';
    api.deepWalk(root, (obj) => {
      if (out || !obj || typeof obj !== 'object') return;
      if (obj.billtypename) out = pickDisplay(obj.billtypename);
      else if (obj.billtype) out = pickDisplay(obj.billtype);
      else if (obj.formid && typeof obj.formid === 'string') out = obj.formid;
    });
    return out;
  }

  function findEntity(root, api) {
    let found = null;
    api.deepWalk(root, (obj) => {
      if (found || !obj || typeof obj !== 'object') return;

      if (
        obj.k &&
        CONFIG.tableEntityKeyCandidates.includes(String(obj.k).toLowerCase()) &&
        obj.data?.dataindex &&
        Array.isArray(obj.data?.rows)
      ) {
        found = obj.data;
        return;
      }

      if (obj.dataindex && Array.isArray(obj.rows)) {
        const di = obj.dataindex;
        const hasLeft = Object.prototype.hasOwnProperty.call(di || {}, CONFIG.fields.left);
        const hasRight = Object.prototype.hasOwnProperty.call(di || {}, CONFIG.fields.right);
        if (hasLeft || hasRight) found = obj;
      }
    });
    return found;
  }

  function matchRule(docType, code, category) {
    const dt = normalizeText(docType);
    const c = normalizeText(code);
    const cg = normalizeText(category);

    for (const rule of CONFIG.compareRules) {
      if (!rule || rule.enabled === false) continue;
      const passDoc = !rule.formTypeIncludes?.length || rule.formTypeIncludes.some((x) => dt.includes(normalizeText(x)));
      const passCode = !rule.codeIncludes?.length || rule.codeIncludes.some((x) => c.includes(normalizeText(x)));
      const passCategory = !rule.categoryIncludes?.length || rule.categoryIncludes.some((x) => cg.includes(normalizeText(x)));
      if (passDoc && passCode && passCategory) return rule;
    }
    return null;
  }

  function analyzeEntity(entity, docType) {
    if (!entity?.dataindex || !Array.isArray(entity.rows)) return { checked: 0, mismatches: [] };

    const di = entity.dataindex;
    const idxSeq = di[CONFIG.fields.seq];
    const idxName = di[CONFIG.fields.name];
    const idxCode = di[CONFIG.fields.code];
    const idxCategory = di[CONFIG.fields.category];
    const idxLeft = di[CONFIG.fields.left];
    const idxRight = di[CONFIG.fields.right];

    if (idxLeft == null || idxRight == null) return { checked: 0, mismatches: [] };

    const mismatches = [];

    for (let i = 0; i < entity.rows.length; i += 1) {
      const row = entity.rows[i];
      const seq = pickDisplay(row[idxSeq]) || String(i + 1);
      const name = pickDisplay(row[idxName]);
      const code = pickDisplay(row[idxCode]);
      const category = pickDisplay(row[idxCategory]);
      const leftText = pickDisplay(row[idxLeft]);
      const rightText = pickDisplay(row[idxRight]);

      const rule = matchRule(docType, code, category);
      if (!rule) continue;

      const compareType = rule.compareAs === 'text' ? 'text' : 'number';
      const leftNum = extractFirstNumber(leftText);
      const rightNum = extractFormulaNumber(rightText);

      const mismatch = compareType === 'text' ? !textEquals(leftText, rightText) : !numberEquals(leftNum, rightNum);
      if (!mismatch) continue;

      mismatches.push({
        seq,
        name,
        code,
        category,
        leftText,
        rightText,
        leftNum,
        rightNum,
        compareType,
        ruleId: rule.id || 'unnamed-rule'
      });
    }

    return {
      checked: entity.rows.length,
      mismatches
    };
  }

  waitCore()
    .then((core) => {
      core.registerPlugin('jdy-12-core-plugin', {
        async start(api) {
          let lastDigest = '';

          api.hookFetchJson(async ({ url, json }) => {
            if (!urlWatched(url)) return { changed: false, json };

            const entity = findEntity(json, api);
            if (!entity) return { changed: false, json };

            const docType = getDocType(json, api);
            const { checked, mismatches } = analyzeEntity(entity, docType);
            const digest = JSON.stringify({ docType, checked, bad: mismatches.map((x) => [x.seq, x.code, x.ruleId]) });

            if (digest !== lastDigest) {
              lastDigest = digest;
              if (mismatches.length) {
                const first = mismatches.slice(0, 3).map((x) => x.name || x.code || x.seq).filter(Boolean).join('、');
                api.showToast(`【${docType || '未知单据'}】命中 ${mismatches.length} 条异常：${first}`, CONFIG.toast.errColor, CONFIG.toast.duration);
                if (CONFIG.debug) console.log('[jdy-12-core-plugin] mismatches', mismatches);
              } else if (CONFIG.debug) {
                api.showToast(`【${docType || '未知单据'}】已检查 ${checked} 行，未发现异常`, CONFIG.toast.okColor, 1800);
              }
            }

            return { changed: false, json };
          });

          api.hookXhrJson(async ({ url, json }) => {
            if (!urlWatched(url)) return;
            const entity = findEntity(json, api);
            if (!entity) return;

            const docType = getDocType(json, api);
            const { mismatches } = analyzeEntity(entity, docType);
            if (mismatches.length && CONFIG.debug) {
              console.log('[jdy-12-core-plugin][xhr] mismatches', { url, docType, mismatches });
            }
          });
        }
      });

      core.start();
    })
    .catch((err) => {
      console.warn('[jdy-12-core-plugin] 启动失败：', err.message || err);
    });
})();
