// ==UserScript==
// @name         金蝶精斗云-订单汇总注入即时库存（可配置模板）
// @namespace    http://tampermonkey.net/
// @version      1.0.0
// @match        *://tf.jdy.com/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  const CONFIG = {
    debug: false,

    // 本地缓存
    stockStorageKey: 'JDY_GLOBAL_STOCK_MAP',
    stockTimeKey: 'JDY_GLOBAL_STOCK_MAP_TIME',
    stockCacheTtlMs: 6 * 60 * 60 * 1000,

    // 接口与目标网格
    inventoryUrlKeywords: ['inv_inventory_rpt'],
    possibleBusinessKeywords: ['loadData', 'report'],
    orderGridKeys: ['reportlistap'],

    // 注入列
    injectField: '__jdy_instant_stock__',
    injectHeader: {
      zh_CN: '即时库存',
      zh_TW: '即時庫存',
      en_US: 'Instant Stock'
    },

    // 库存解析字段候选 + 兜底索引
    stockFieldCandidates: {
      code: ['materialid_number', 'material_number', 'number', 'item_number', 'itemnumber', 'code'],
      name: ['materialid_name', 'material_name', 'name', 'item_name', 'itemname'],
      qty: ['instantqty', 'qty', 'stockqty', 'inventoryqty', 'availqty', 'availableqty', 'baseqty']
    },
    stockFieldFallback: { code: 3, name: 5, qty: 23 },

    // 注入位置：锚点字段后
    injectAfterCandidates: ['materialid_name', 'materialid_number'],

    // 消息
    msgDurationMs: 2500
  };

  const log = (...args) => CONFIG.debug && console.log('[库存注入模板]', ...args);
  const warn = (...args) => console.warn('[库存注入模板]', ...args);

  const rawFetch = window.fetch;
  window.fetch = async (...args) => {
    const res = await rawFetch(...args);
    const url = getFetchUrl(args);

    if (!shouldHandleUrl(url)) return res;

    let rawText;
    try {
      rawText = await res.text();
    } catch (e) {
      warn('读取响应失败', e);
      return res;
    }

    if (!isProbablyJson(rawText)) return rebuildResponse(res, rawText);

    let payload;
    try {
      payload = JSON.parse(rawText);
    } catch {
      return rebuildResponse(res, rawText);
    }

    let changed = false;

    if (isInventoryUrl(url)) {
      const synced = syncInventoryFromPayload(payload);
      if (synced > 0) showStatusMsg(`✅ 已同步库存 ${synced} 项`, '#52c41a');
    }

    if (looksLikeOrderSummaryPayload(payload)) {
      const stockMap = readStockMap();
      if (!Object.keys(stockMap).length) {
        showStatusMsgOnce('⚠️ 请先到库存查询页面执行一次查询，再刷新汇总表', '#faad14');
      }
      const result = injectStockColumnIntoPayload(payload, stockMap);
      changed = result.changed || changed;
    }

    return rebuildResponse(res, changed ? JSON.stringify(payload) : rawText);
  };

  function getFetchUrl(args) {
    const req = args[0];
    if (typeof req === 'string') return req;
    if (req && typeof req.url === 'string') return req.url;
    return '';
  }

  function shouldHandleUrl(url) {
    if (!url) return false;
    return [...CONFIG.inventoryUrlKeywords, ...CONFIG.possibleBusinessKeywords].some((k) => url.includes(k));
  }

  function isInventoryUrl(url) {
    return CONFIG.inventoryUrlKeywords.some((k) => url.includes(k));
  }

  function isProbablyJson(text) {
    const t = String(text || '').trim();
    return t.startsWith('{') || t.startsWith('[');
  }

  function rebuildResponse(originResponse, text) {
    const headers = new Headers(originResponse.headers);
    headers.delete('content-length');
    return new Response(text, {
      status: originResponse.status,
      statusText: originResponse.statusText,
      headers
    });
  }

  function looksLikeOrderSummaryPayload(data) {
    let targetHit = false;

    deepWalk(data, (node) => {
      if (!node || typeof node !== 'object' || targetHit) return;
      if (CONFIG.orderGridKeys.includes(node.key) && node.methodname === 'createGridColumns') targetHit = true;
    });

    return targetHit;
  }

  function syncInventoryFromPayload(data) {
    const stockMap = {};
    let total = 0;

    deepWalk(data, (node) => {
      if (!node || typeof node !== 'object') return;

      if (Array.isArray(node.rows) && node.dataindex) {
        total += collectStockRows(node.rows, node.dataindex, stockMap);
      }

      if (Array.isArray(node.p)) {
        node.p.forEach((item) => {
          if (item?.data?.rows && item?.data?.dataindex) {
            total += collectStockRows(item.data.rows, item.data.dataindex, stockMap);
          }
        });
      }
    });

    if (total > 0) {
      localStorage.setItem(CONFIG.stockStorageKey, JSON.stringify(stockMap));
      localStorage.setItem(CONFIG.stockTimeKey, String(Date.now()));
    }

    return total;
  }

  function collectStockRows(rows, dataindex, stockMap) {
    const codeIndex = pickFieldIndex(dataindex, CONFIG.stockFieldCandidates.code, CONFIG.stockFieldFallback.code);
    const nameIndex = pickFieldIndex(dataindex, CONFIG.stockFieldCandidates.name, CONFIG.stockFieldFallback.name);
    const qtyIndex = pickFieldIndex(dataindex, CONFIG.stockFieldCandidates.qty, CONFIG.stockFieldFallback.qty);

    let count = 0;
    rows.forEach((row) => {
      if (!Array.isArray(row)) return;

      const code = normalizeCell(row[codeIndex]);
      if (!code) return;

      stockMap[code] = {
        name: normalizeCell(row[nameIndex]),
        qty: toNumber(row[qtyIndex])
      };
      count += 1;
    });

    return count;
  }

  function injectStockColumnIntoPayload(data, stockMap) {
    let changed = false;

    deepWalk(data, (node) => {
      if (!node || typeof node !== 'object') return;

      if (
        CONFIG.orderGridKeys.includes(node.key) &&
        node.methodname === 'createGridColumns' &&
        Array.isArray(node.args) &&
        Array.isArray(node.args[0]?.columns)
      ) {
        changed = injectColumnDef(node.args[0].columns) || changed;
      }

      if (Array.isArray(node.rows) && node.dataindex) {
        changed = injectDataRows(node, stockMap) || changed;
      }

      if (Array.isArray(node.p)) {
        node.p.forEach((item) => {
          if (item?.data?.rows && item?.data?.dataindex) {
            changed = injectDataRows(item.data, stockMap) || changed;
          }
        });
      }
    });

    return { changed };
  }

  function injectColumnDef(columns) {
    if (columns.some((col) => col?.dataIndex === CONFIG.injectField)) return false;

    const anchorIndex = columns.findIndex((col) => col && CONFIG.injectAfterCandidates.includes(col.dataIndex));
    const insertAt = anchorIndex >= 0 ? anchorIndex + 1 : columns.length;

    columns.splice(insertAt, 0, {
      filter: false,
      editor: { sc: 10, sz: true, type: 'number' },
      ln: false,
      visible: true,
      dataIndex: CONFIG.injectField,
      w: { zh_CN: '90' },
      header: CONFIG.injectHeader,
      isuf: true,
      sort: true,
      isFixed: false,
      fs: 12,
      entity: 'entries',
      'text-align': 'right'
    });

    return true;
  }

  function injectDataRows(dataBlock, stockMap) {
    const idx = dataBlock.dataindex;
    const rows = dataBlock.rows;

    if (!idx || !Array.isArray(rows)) return false;
    if (idx[CONFIG.injectField] !== undefined) return false;
    if (idx.materialid_number === undefined) return false;

    const anchorField = idx.materialid_name !== undefined ? 'materialid_name' : 'materialid_number';
    const insertPos = Number(idx[anchorField]) + 1;
    if (!Number.isFinite(insertPos)) return false;

    Object.keys(idx).forEach((key) => {
      if (typeof idx[key] === 'number' && idx[key] >= insertPos) idx[key] += 1;
    });
    idx[CONFIG.injectField] = insertPos;

    rows.forEach((row) => {
      if (!Array.isArray(row)) return;
      const code = normalizeCell(row[idx.materialid_number]);
      const qty = code && stockMap[code] ? stockMap[code].qty : '';
      row.splice(insertPos, 0, qty);
    });

    return true;
  }

  function pickFieldIndex(dataindex, candidates, fallback) {
    for (const key of candidates) {
      if (dataindex[key] !== undefined) return dataindex[key];
    }
    return fallback;
  }

  function readStockMap() {
    try {
      const raw = localStorage.getItem(CONFIG.stockStorageKey) || '{}';
      const ts = Number(localStorage.getItem(CONFIG.stockTimeKey) || 0);
      if (ts && Date.now() - ts > CONFIG.stockCacheTtlMs) {
        warn('库存缓存超过 6 小时，建议重新查询');
      }
      const obj = JSON.parse(raw);
      return obj && typeof obj === 'object' ? obj : {};
    } catch {
      return {};
    }
  }

  function normalizeCell(v) {
    if (Array.isArray(v)) return normalizeCell(v[0]);
    if (v == null) return '';
    return String(v).trim();
  }

  function toNumber(v) {
    if (Array.isArray(v)) v = v[0];
    const n = parseFloat(String(v == null ? '' : v).replace(/,/g, '').trim());
    return Number.isFinite(n) ? n : 0;
  }

  function deepWalk(obj, visitor, seen = new WeakSet()) {
    if (!obj || typeof obj !== 'object' || seen.has(obj)) return;
    seen.add(obj);
    visitor(obj);

    if (Array.isArray(obj)) {
      obj.forEach((item) => deepWalk(item, visitor, seen));
      return;
    }

    Object.keys(obj).forEach((key) => {
      if (obj[key] && typeof obj[key] === 'object') deepWalk(obj[key], visitor, seen);
    });
  }

  function showStatusMsg(text, color = '#1677ff') {
    const render = () => {
      const box = document.createElement('div');
      box.style.cssText = [
        'position: fixed',
        'top: 15px',
        'left: 50%',
        'transform: translateX(-50%)',
        `background: ${color}`,
        'color: #fff',
        'padding: 8px 15px',
        'z-index: 9999999',
        'border-radius: 20px',
        'font-size: 12px',
        'box-shadow: 0 4px 12px rgba(0,0,0,.15)'
      ].join(';');
      box.innerText = text;
      document.body.appendChild(box);
      setTimeout(() => box.remove(), CONFIG.msgDurationMs);
    };

    if (document.body) render();
    else window.addEventListener('DOMContentLoaded', render, { once: true });
  }

  function showStatusMsgOnce(text, color = '#1677ff') {
    const key = `__JDY_STOCK_MSG_ONCE__${text}`;
    if (sessionStorage.getItem(key)) return;
    sessionStorage.setItem(key, '1');
    showStatusMsg(text, color);
  }

  log('脚本已启动');
})();
