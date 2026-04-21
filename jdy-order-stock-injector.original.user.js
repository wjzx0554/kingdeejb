// ==UserScript==
// @name         金蝶精斗云-订单汇总注入即时库存（原始存档）
// @namespace    http://tampermonkey.net/
// @version      3.0
// @match        *://tf.jdy.com/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function () {
    'use strict';

    const CONFIG = {
        STOCK_STORAGE_KEY: 'JDY_GLOBAL_STOCK_MAP',
        STOCK_TIME_KEY: 'JDY_GLOBAL_STOCK_MAP_TIME',
        STOCK_CACHE_TTL_MS: 6 * 60 * 60 * 1000,
        ORDER_GRID_KEY: 'reportlistap',
        INJECT_FIELD: '__jdy_instant_stock__',
        INJECT_HEADER: '即时库存'
    };

    const originalFetch = window.fetch;

    window.fetch = async (...args) => {
        const response = await originalFetch(...args);
        const url = getFetchUrl(args);

        const mayNeedHandle =
            url.includes('inv_inventory_rpt') ||
            url.includes('loadData') ||
            url.includes('report');

        if (!mayNeedHandle) return response;

        let rawText = '';
        try {
            rawText = await response.text();
        } catch (e) {
            return response;
        }

        if (!isProbablyJson(rawText)) {
            return rebuildResponse(response, rawText);
        }

        let data;
        try {
            data = JSON.parse(rawText);
        } catch (e) {
            return rebuildResponse(response, rawText);
        }

        let changed = false;

        if (url.includes('inv_inventory_rpt')) {
            syncInventoryFromPayload(data);
        }

        if (looksLikeOrderSummaryPayload(data)) {
            const stockMap = readStockMap();
            const result = injectStockColumnIntoPayload(data, stockMap);
            changed = result.changed || changed;
        }

        return rebuildResponse(response, changed ? JSON.stringify(data) : rawText);
    };

    function getFetchUrl(args) {
        const req = args[0];
        if (typeof req === 'string') return req;
        if (req && typeof req.url === 'string') return req.url;
        return '';
    }

    function isProbablyJson(text) {
        if (!text) return false;
        const t = text.trim();
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
        try {
            const s = JSON.stringify(data);
            return (
                s.includes(`"key":"${CONFIG.ORDER_GRID_KEY}"`) &&
                s.includes('"materialid_number"') &&
                s.includes('"rows"') &&
                s.includes('"dataindex"')
            );
        } catch (e) {
            return false;
        }
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
                node.p.forEach(item => {
                    if (item && item.data && Array.isArray(item.data.rows) && item.data.dataindex) {
                        total += collectStockRows(item.data.rows, item.data.dataindex, stockMap);
                    }
                });
            }
        });

        if (total > 0) {
            localStorage.setItem(CONFIG.STOCK_STORAGE_KEY, JSON.stringify(stockMap));
            localStorage.setItem(CONFIG.STOCK_TIME_KEY, String(Date.now()));
        }

        return total;
    }

    function collectStockRows(rows, dataindex, stockMap) {
        const codeIndex = pickFieldIndex(dataindex, ['materialid_number'], 3);
        const nameIndex = pickFieldIndex(dataindex, ['materialid_name'], 5);
        const qtyIndex = pickFieldIndex(dataindex, ['instantqty', 'qty', 'stockqty'], 23);

        let count = 0;
        rows.forEach(row => {
            if (!Array.isArray(row)) return;
            const code = normalizeCell(row[codeIndex]);
            if (!code) return;
            const name = normalizeCell(row[nameIndex]);
            const qty = toNumber(row[qtyIndex]);
            stockMap[code] = { qty, name };
            count++;
        });
        return count;
    }

    function injectStockColumnIntoPayload(data, stockMap) {
        let changed = false;

        deepWalk(data, (node) => {
            if (!node || typeof node !== 'object') return;

            if (
                node.key === CONFIG.ORDER_GRID_KEY &&
                node.methodname === 'createGridColumns' &&
                Array.isArray(node.args) &&
                node.args[0] &&
                Array.isArray(node.args[0].columns)
            ) {
                const didChange = injectColumnDef(node.args[0].columns);
                changed = didChange || changed;
            }

            if (Array.isArray(node.rows) && node.dataindex) {
                const didChange = injectDataRows(node, stockMap);
                changed = didChange || changed;
            }
        });

        return { changed };
    }

    function injectColumnDef(columns) {
        if (columns.some(col => col && col.dataIndex === CONFIG.INJECT_FIELD)) return false;

        const anchorIndex = columns.findIndex(col =>
            col && (col.dataIndex === 'materialid_name' || col.dataIndex === 'materialid_number')
        );
        const insertAt = anchorIndex >= 0 ? anchorIndex + 1 : columns.length;

        columns.splice(insertAt, 0, {
            visible: true,
            dataIndex: CONFIG.INJECT_FIELD,
            header: { zh_CN: CONFIG.INJECT_HEADER, en_US: 'Instant Stock' },
            sort: true,
            fs: 12,
            'text-align': 'right'
        });

        return true;
    }

    function injectDataRows(dataBlock, stockMap) {
        const idx = dataBlock.dataindex;
        const rows = dataBlock.rows;

        if (!idx || !Array.isArray(rows)) return false;
        if (idx[CONFIG.INJECT_FIELD] !== undefined) return false;
        if (idx.materialid_number === undefined) return false;

        const anchorField = idx.materialid_name !== undefined ? 'materialid_name' : 'materialid_number';
        const insertPos = Number(idx[anchorField]) + 1;
        if (!Number.isFinite(insertPos)) return false;

        Object.keys(idx).forEach(key => {
            if (typeof idx[key] === 'number' && idx[key] >= insertPos) idx[key] = idx[key] + 1;
        });
        idx[CONFIG.INJECT_FIELD] = insertPos;

        rows.forEach(row => {
            if (!Array.isArray(row)) return;
            const code = normalizeCell(row[idx.materialid_number]);
            const stockQty = code && stockMap[code] ? stockMap[code].qty : '';
            row.splice(insertPos, 0, stockQty);
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
            const raw = localStorage.getItem(CONFIG.STOCK_STORAGE_KEY) || '{}';
            const obj = JSON.parse(raw);
            return obj && typeof obj === 'object' ? obj : {};
        } catch (e) {
            return {};
        }
    }

    function normalizeCell(val) {
        if (Array.isArray(val)) return normalizeCell(val[0]);
        if (val === null || val === undefined) return '';
        return String(val).trim();
    }

    function toNumber(val) {
        if (Array.isArray(val)) val = val[0];
        if (val === null || val === undefined || val === '') return 0;
        const n = parseFloat(String(val).replace(/,/g, '').trim());
        return Number.isFinite(n) ? n : 0;
    }

    function deepWalk(obj, visitor) {
        if (!obj || typeof obj !== 'object') return;
        visitor(obj);
        if (Array.isArray(obj)) {
            obj.forEach(item => deepWalk(item, visitor));
            return;
        }
        Object.keys(obj).forEach(key => {
            if (obj[key] && typeof obj[key] === 'object') deepWalk(obj[key], visitor);
        });
    }
})();
