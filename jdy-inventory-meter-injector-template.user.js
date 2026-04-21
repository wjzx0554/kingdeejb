// ==UserScript==
// @name         金蝶精斗云-库存查询米数注入（可配置模板）
// @namespace    http://tampermonkey.net/
// @version      1.0.0
// @match        *://*.jdy.com/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  const CONFIG = {
    debug: false,

    formKey: 'inv_inventory_rpt',
    gridKey: 'reportlistap',

    codePrefix: 'SP0101',

    field: {
      code: 'materialid_number',
      name: 'materialid_name',
      qty: 'qty',
      convertOverride: 'custom_field__2__510q96vtxq5h##materialid_id##',
      convertHeaderKeyword: '米数换算',
      meter: '__jdy_meter_qty__'
    },

    header: {
      meter: { zh_CN: '米数', zh_TW: '米數', en_US: 'Meters' }
    },

    decimalPlaces: 2,
    maxAutoPages: 20
  };

  const state = {
    rawFetch: window.fetch.bind(window),
    convertField: '',
    latestTotalMeters: '',
    pageTotals: {},
    processingExtraPages: false
  };

  const log = (...args) => CONFIG.debug && console.log('[库存米数模板]', ...args);

  const safeJsonParse = (text) => {
    try { return JSON.parse(text); } catch { return null; }
  };

  const normalize = (v) => {
    if (Array.isArray(v)) v = v[0];
    if (v == null) return '';
    return String(v).trim();
  };

  const toNumber = (v) => {
    if (Array.isArray(v)) v = v[0];
    if (v == null || v === '') return NaN;
    const n = parseFloat(String(v).replace(/,/g, '').trim());
    return Number.isFinite(n) ? n : NaN;
  };

  const round = (n) => (Number.isFinite(n) ? Number(n.toFixed(CONFIG.decimalPlaces)) : '');

  function walk(obj, fn, seen = new WeakSet()) {
    if (!obj || typeof obj !== 'object' || seen.has(obj)) return;
    seen.add(obj);
    fn(obj);

    if (Array.isArray(obj)) {
      obj.forEach((x) => walk(x, fn, seen));
    } else {
      Object.keys(obj).forEach((k) => walk(obj[k], fn, seen));
    }
  }

  const isInventoryUrl = (url) => String(url || '').includes(`f=${CONFIG.formKey}`);
  const getFetchUrl = (input) => (typeof input === 'string' ? input : input?.url || '');
  const getBodyText = (init) => (typeof init?.body === 'string' ? init.body : '');

  const getHeaderText = (col) => {
    const h = col?.header;
    if (!h) return '';
    if (typeof h === 'string') return h;
    return [h.zh_CN, h.zh_TW, h.en_US].filter(Boolean).join('|');
  };

  function findColumnNodes(data) {
    const nodes = [];
    walk(data, (node) => {
      if (
        node?.key === CONFIG.gridKey &&
        node.methodname === 'createGridColumns' &&
        Array.isArray(node.args) &&
        node.args[0] &&
        Array.isArray(node.args[0].columns)
      ) {
        nodes.push(node);
      }
    });
    return nodes;
  }

  function findInventoryBlocks(data) {
    const blocks = [];
    const seen = new Set();

    walk(data, (node) => {
      const tryPush = (block) => {
        if (!block || seen.has(block)) return;
        const idx = block.dataindex;
        if (idx && Array.isArray(block.rows) && idx[CONFIG.field.code] !== undefined && idx[CONFIG.field.qty] !== undefined) {
          seen.add(block);
          blocks.push(block);
        }
      };

      if (node?.data?.rows && node?.data?.dataindex) tryPush(node.data);
      if (node?.rows && node?.dataindex) tryPush(node);
    });

    return blocks;
  }

  function detectConvertFieldFromColumns(data) {
    let found = '';
    for (const node of findColumnNodes(data)) {
      const columns = node.args[0].columns;
      const byOverride = columns.find((c) => c?.dataIndex === CONFIG.field.convertOverride);
      if (byOverride) {
        found = byOverride.dataIndex;
        break;
      }
      const byHeader = columns.find(
        (c) => c?.dataIndex && getHeaderText(c).includes(CONFIG.field.convertHeaderKeyword)
      );
      if (byHeader) {
        found = byHeader.dataIndex;
        break;
      }
    }

    if (found) state.convertField = found;
    return found || state.convertField || CONFIG.field.convertOverride;
  }

  function injectColumnDefinition(data, convertField) {
    let changed = false;

    findColumnNodes(data).forEach((node) => {
      const columns = node.args[0].columns;
      if (columns.some((c) => c?.dataIndex === CONFIG.field.meter)) return;

      const convertPos = columns.findIndex((c) => c?.dataIndex === convertField);
      const qtyPos = columns.findIndex((c) => c?.dataIndex === CONFIG.field.qty);
      const insertAt = convertPos >= 0 ? convertPos + 1 : qtyPos >= 0 ? qtyPos + 1 : columns.length;

      columns.splice(insertAt, 0, {
        filter: false,
        editor: { sc: 10, sz: true, type: 'number' },
        ln: false,
        visible: true,
        dataIndex: CONFIG.field.meter,
        w: { zh_CN: '100' },
        header: CONFIG.header.meter,
        isuf: true,
        sum: 1,
        sort: true,
        isFixed: false,
        fs: 12,
        entity: 'entries',
        'text-align': 'right'
      });

      changed = true;
      log('已插入米数列', { insertAt });
    });

    return changed;
  }

  function addFieldToDataIndex(block, convertField) {
    const idx = block.dataindex;

    if (idx[CONFIG.field.meter] !== undefined) return { pos: idx[CONFIG.field.meter], newlyAdded: false };
    if (idx[convertField] === undefined) return { pos: -1, newlyAdded: false };

    const insertPos = Number(idx[convertField]) + 1;
    Object.keys(idx).forEach((k) => {
      if (typeof idx[k] === 'number' && idx[k] >= insertPos) idx[k] += 1;
    });
    idx[CONFIG.field.meter] = insertPos;

    if (block.sumformat?.[CONFIG.field.qty] && !block.sumformat?.[CONFIG.field.meter]) {
      block.sumformat[CONFIG.field.meter] = block.sumformat[CONFIG.field.qty];
    }

    return { pos: insertPos, newlyAdded: true };
  }

  function isServerSummaryRow(row, idx) {
    const code = normalize(row[idx[CONFIG.field.code]]);
    const name = idx[CONFIG.field.name] !== undefined ? normalize(row[idx[CONFIG.field.name]]) : '';

    if (name === '合计' || name === '合計') return true;
    if (!code && name.includes('合计')) return true;

    const datatype = idx.datatype !== undefined ? normalize(row[idx.datatype]) : '';
    return !!(datatype && datatype !== '0');
  }

  function calcMetersForRow(row, idx, convertField) {
    const code = normalize(row[idx[CONFIG.field.code]]);
    if (!code.startsWith(CONFIG.codePrefix)) return '';

    const qty = toNumber(row[idx[CONFIG.field.qty]]);
    const convert = toNumber(row[idx[convertField]]);

    if (!Number.isFinite(qty) || !Number.isFinite(convert) || convert === 0) return '';
    return round(qty / convert);
  }

  function patchDataBlock(block, convertField, options = {}) {
    const idx = block.dataindex;
    if (idx[convertField] === undefined) return { changed: false, count: 0, sum: 0 };

    const addResult = options.patchRows === false
      ? { pos: idx[CONFIG.field.meter] ?? -1, newlyAdded: false }
      : addFieldToDataIndex(block, convertField);

    const meterPos = addResult.pos;
    if (meterPos < 0 && options.patchRows !== false) return { changed: false, count: 0, sum: 0 };

    let count = 0;
    let sum = 0;

    block.rows.forEach((row) => {
      if (!Array.isArray(row)) return;

      if (addResult.newlyAdded) row.splice(meterPos, 0, '');

      if (isServerSummaryRow(row, idx)) {
        if (options.patchRows !== false && meterPos >= 0) row[meterPos] = '';
        return;
      }

      const meters = calcMetersForRow(row, idx, convertField);
      if (meters !== '') {
        count += 1;
        sum += Number(meters);
      }

      if (options.patchRows !== false && meterPos >= 0) row[meterPos] = meters;
    });

    return { changed: options.patchRows !== false, count, sum: round(sum) };
  }

  function getPageMetaFromBlock(block) {
    if (!block) return null;
    return {
      pageindex: Number(block.pageindex || 1) || 1,
      pagecount: Number(block.pagecount || 1) || 1,
      pagerows: Number(block.pagerows || block.length || 100) || 100,
      queryId: block.queryId || ''
    };
  }

  function buildPagedBody(originalBody, pageNo, meta) {
    try {
      const usp = new URLSearchParams(originalBody || '');
      const raw = usp.get('params');
      if (!raw) return '';

      const params = JSON.parse(raw);
      if (!Array.isArray(params)) return '';

      params.forEach((action) => {
        if (!Array.isArray(action.postData)) action.postData = [{}, []];
        if (!action.postData[0] || typeof action.postData[0] !== 'object') action.postData[0] = {};

        action.postData[0].pageindex = pageNo;
        action.postData[0].startIndex = (pageNo - 1) * meta.pagerows;
        if (meta.queryId) action.postData[0].queryId = meta.queryId;
        if (meta.pagerows) action.postData[0].pagerows = meta.pagerows;
      });

      usp.set('params', JSON.stringify(params));
      return usp.toString();
    } catch {
      return '';
    }
  }

  async function calcAllPagesTotal(url, init, originalBody, firstPayload, convertField, firstSum) {
    const firstBlock = findInventoryBlocks(firstPayload)[0];
    const meta = getPageMetaFromBlock(firstBlock);

    if (!meta || meta.pagecount <= 1 || !originalBody) {
      state.latestTotalMeters = round(firstSum);
      return state.latestTotalMeters;
    }

    state.pageTotals = { [meta.pageindex]: Number(firstSum || 0) };
    if (state.processingExtraPages) return round(Object.values(state.pageTotals).reduce((a, b) => a + Number(b || 0), 0));
    state.processingExtraPages = true;

    try {
      const lastPage = Math.min(meta.pagecount, CONFIG.maxAutoPages);
      for (let pageNo = 2; pageNo <= lastPage; pageNo += 1) {
        const body = buildPagedBody(originalBody, pageNo, meta);
        if (!body) break;

        const res = await state.rawFetch(url, {
          method: 'POST',
          credentials: 'include',
          headers: init?.headers,
          body
        });

        const payload = safeJsonParse(await res.text());
        if (!payload) break;

        let pageSum = 0;
        findInventoryBlocks(payload).forEach((block) => {
          const result = patchDataBlock(block, convertField, { patchRows: false });
          pageSum += Number(result.sum || 0);
        });

        state.pageTotals[pageNo] = pageSum;
      }
    } finally {
      state.processingExtraPages = false;
    }

    const total = Object.values(state.pageTotals).reduce((a, b) => a + Number(b || 0), 0);
    state.latestTotalMeters = round(total);
    return state.latestTotalMeters;
  }

  function patchFloatBottomData(data, totalMeters) {
    let changed = false;
    walk(data, (node) => {
      if (
        node?.key === CONFIG.gridKey &&
        node.methodname === 'setFloatButtomData' &&
        Array.isArray(node.args) &&
        node.args[0] &&
        typeof node.args[0] === 'object'
      ) {
        node.args[0][CONFIG.field.meter] = totalMeters !== undefined && totalMeters !== '' ? String(totalMeters) : String(state.latestTotalMeters || '');
        changed = true;
      }
    });
    return changed;
  }

  async function patchPayload(data, ctx) {
    const convertField = detectConvertFieldFromColumns(data);
    if (!convertField) return false;

    let changed = injectColumnDefinition(data, convertField);

    const blocks = findInventoryBlocks(data);
    let currentPayloadSum = 0;
    blocks.forEach((block) => {
      const result = patchDataBlock(block, convertField, { patchRows: true });
      if (result.changed) changed = true;
      currentPayloadSum += Number(result.sum || 0);
    });

    if (blocks.length > 0) {
      const total = await calcAllPagesTotal(ctx.url, ctx.init, ctx.bodyText, data, convertField, currentPayloadSum);
      patchFloatBottomData(data, total);
    } else if (patchFloatBottomData(data, state.latestTotalMeters)) {
      changed = true;
    }

    return changed;
  }

  function rebuildResponse(oldRes, text) {
    const headers = new Headers(oldRes.headers);
    headers.delete('content-length');
    return new Response(text, { status: oldRes.status, statusText: oldRes.statusText, headers });
  }

  window.fetch = async function (input, init) {
    const res = await state.rawFetch(input, init);
    const url = getFetchUrl(input);
    if (!isInventoryUrl(url)) return res;

    const text = await res.clone().text().catch(() => '');
    if (!text) return res;

    const data = safeJsonParse(text);
    if (!data) return res;

    const changed = await patchPayload(data, { url, init, bodyText: getBodyText(init) });
    return changed ? rebuildResponse(res, JSON.stringify(data)) : res;
  };

  log('脚本已启动：库存查询米数注入模板');
})();
