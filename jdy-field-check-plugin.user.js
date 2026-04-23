// ==UserScript==
// @name         JDY 字段一致性校验插件（Core版）
// @namespace    http://tampermonkey.net/
// @version      0.1.0
// @description  依赖 TM Core Runtime 的示例插件：发现字段异常时提示
// @match        *://tf.jdy.com/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  function waitCore(retry = 0) {
    const core = window.__TM_CORE_RUNTIME__;
    if (core) return Promise.resolve(core);
    if (retry > 80) return Promise.reject(new Error('TM Core Runtime 未加载'));
    return new Promise((resolve) => setTimeout(resolve, 100)).then(() => waitCore(retry + 1));
  }

  waitCore()
    .then((core) => {
      core.registerPlugin('jdy-field-check', {
        async start(api) {
          const CONFIG = {
            tableEntityKey: 'material_entity',
            fields: {
              left: 'material_model',
              right: 'conversionrate',
              name: 'material_name'
            },
            epsilon: 1e-6
          };

          function pickDisplay(v) {
            if (v == null) return '';
            if (Array.isArray(v)) return api.normalizeText(v[1] != null ? v[1] : v[0]);
            if (typeof v === 'object') return api.normalizeText(v.zh_CN || JSON.stringify(v));
            return api.normalizeText(v);
          }

          function extractFirstNumber(text) {
            const t = api.normalizeText(text);
            const m = t.match(/-?\d+(?:\.\d+)?/);
            return m ? Number(m[0]) : NaN;
          }

          function extractFormulaNumber(text) {
            const t = api.normalizeText(text).replace(/，/g, ',');
            const eq = t.match(/[=＝]\s*(-?\d+(?:\.\d+)?)/);
            if (eq) return Number(eq[1]);
            const nums = t.match(/-?\d+(?:\.\d+)?/g);
            if (nums && nums.length >= 2) return Number(nums[1]);
            return nums && nums.length ? Number(nums[0]) : NaN;
          }

          function findEntity(root) {
            let found = null;
            api.deepWalk(root, (obj) => {
              if (found) return;
              if (
                obj?.k === CONFIG.tableEntityKey &&
                obj?.data?.dataindex &&
                Array.isArray(obj?.data?.rows)
              ) {
                found = obj.data;
              }
            });
            return found;
          }

          function countMismatches(entity) {
            if (!entity?.dataindex || !Array.isArray(entity.rows)) return 0;
            const di = entity.dataindex;
            const leftIdx = di[CONFIG.fields.left];
            const rightIdx = di[CONFIG.fields.right];
            const nameIdx = di[CONFIG.fields.name];
            if (leftIdx == null || rightIdx == null) return 0;

            let count = 0;
            const names = [];
            for (const row of entity.rows) {
              const left = extractFirstNumber(pickDisplay(row[leftIdx]));
              const right = extractFormulaNumber(pickDisplay(row[rightIdx]));
              if (!Number.isFinite(left) || !Number.isFinite(right)) continue;
              if (Math.abs(left - right) > CONFIG.epsilon) {
                count += 1;
                if (names.length < 3) names.push(pickDisplay(row[nameIdx]));
              }
            }

            if (count > 0) {
              api.showToast(`检测到 ${count} 条字段异常：${names.filter(Boolean).join('、')}`, '#d4380d', 2600);
            }
            return count;
          }

          api.hookFetchJson(async ({ url, json }) => {
            if (!/loadData|report|inv_inventory_rpt|polling\.do/i.test(url || '')) {
              return { changed: false, json };
            }

            const entity = findEntity(json);
            if (!entity) return { changed: false, json };
            countMismatches(entity);
            return { changed: false, json };
          });
        }
      });

      core.start();
    })
    .catch((err) => {
      console.warn('[JDY Field Check Plugin] 启动失败：', err.message || err);
    });
})();
