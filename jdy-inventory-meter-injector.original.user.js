// ==UserScript==
// @name         金蝶精斗云-库存查询表注入米数稳定版（原始存档）
// @namespace    http://tampermonkey.net/
// @version      2.0
// @match        *://*.jdy.com/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function () {
    'use strict';

    const CFG = {
        DEBUG: true,
        FORM_KEY: 'inv_inventory_rpt',
        GRID_KEY: 'reportlistap',
        CODE_PREFIX: 'SP0101',
        CODE_FIELD: 'materialid_number',
        NAME_FIELD: 'materialid_name',
        QTY_FIELD: 'qty',
        CONVERT_FIELD_OVERRIDE: 'custom_field__2__510q96vtxq5h##materialid_id##',
        CONVERT_HEADER_KEYWORD: '米数换算',
        METER_FIELD: '__jdy_meter_qty__',
        METER_HEADER: '米数',
        DECIMAL_PLACES: 2,
        MAX_AUTO_PAGES: 20
    };

    const STATE = {
        rawFetch: window.fetch.bind(window),
        convertField: '',
        latestTotalMeters: '',
        latestQueryId: '',
        pageTotals: {},
        processingExtraPages: false
    };

    function log(...args) { if (CFG.DEBUG) console.log('[库存米数注入]', ...args); }
    function warn(...args) { console.warn('[库存米数注入]', ...args); }
    function safeJsonParse(text) { try { return JSON.parse(text); } catch { return null; } }

    function normalize(v) {
        if (Array.isArray(v)) v = v[0];
        if (v === null || v === undefined) return '';
        return String(v).trim();
    }

    function toNumber(v) {
        if (Array.isArray(v)) v = v[0];
        if (v === null || v === undefined || v === '') return NaN;
        const n = parseFloat(String(v).replace(/,/g, '').trim());
        return Number.isFinite(n) ? n : NaN;
    }

    function round(n) {
        if (!Number.isFinite(n)) return '';
        return Number(n.toFixed(CFG.DECIMAL_PLACES));
    }

    function walk(obj, fn) {
        if (!obj || typeof obj !== 'object') return;
        fn(obj);
        if (Array.isArray(obj)) obj.forEach(x => walk(x, fn));
        else Object.keys(obj).forEach(k => walk(obj[k], fn));
    }

    function isInventoryUrl(url) { return String(url || '').includes(`f=${CFG.FORM_KEY}`); }
    function getFetchUrl(input) { return typeof input === 'string' ? input : (input?.url || ''); }
    function getBodyText(init) { return init && typeof init.body === 'string' ? init.body : ''; }

    function getHeaderText(col) {
        const h = col && col.header;
        if (!h) return '';
        if (typeof h === 'string') return h;
        return [h.zh_CN, h.zh_TW, h.en_US].filter(Boolean).join('|');
    }

    function findColumnNodes(data) {
        const nodes = [];
        walk(data, node => {
            if (node && node.key === CFG.GRID_KEY && node.methodname === 'createGridColumns' && Array.isArray(node.args) && node.args[0] && Array.isArray(node.args[0].columns)) {
                nodes.push(node);
            }
        });
        return nodes;
    }

    function findInventoryBlocks(data) {
        const blocks = [];
        const seen = new Set();

        walk(data, node => {
            const tryPush = block => {
                if (!block || seen.has(block)) return;
                const idx = block.dataindex;
                if (idx && Array.isArray(block.rows) && idx[CFG.CODE_FIELD] !== undefined && idx[CFG.QTY_FIELD] !== undefined) {
                    seen.add(block);
                    blocks.push(block);
                }
            };

            if (node && node.data && node.data.rows && node.data.dataindex) tryPush(node.data);
            if (node && node.rows && node.dataindex) tryPush(node);
        });

        return blocks;
    }

    function detectConvertFieldFromColumns(data) {
        let found = '';
        const nodes = findColumnNodes(data);

        for (const node of nodes) {
            const columns = node.args[0].columns;
            const byOverride = columns.find(c => c && c.dataIndex === CFG.CONVERT_FIELD_OVERRIDE);
            if (byOverride) { found = byOverride.dataIndex; break; }

            const byHeader = columns.find(c => c && c.dataIndex && getHeaderText(c).includes(CFG.CONVERT_HEADER_KEYWORD));
            if (byHeader) { found = byHeader.dataIndex; break; }
        }

        if (found) STATE.convertField = found;
        return found || STATE.convertField || CFG.CONVERT_FIELD_OVERRIDE;
    }

    function injectColumnDefinition(data, convertField) {
        let changed = false;
        findColumnNodes(data).forEach(node => {
            const columns = node.args[0].columns;
            if (columns.some(c => c && c.dataIndex === CFG.METER_FIELD)) return;

            const newCol = {
                filter: false, editor: { sc: 10, sz: true, type: 'number' }, ln: false, visible: true,
                dataIndex: CFG.METER_FIELD, w: { zh_CN: '100' },
                header: { zh_CN: CFG.METER_HEADER, zh_TW: '米數', en_US: 'Meters' },
                isuf: true, sum: 1, sort: true, isFixed: false, fs: 12, entity: 'entries', 'text-align': 'right'
            };

            const convertPos = columns.findIndex(c => c && c.dataIndex === convertField);
            const qtyPos = columns.findIndex(c => c && c.dataIndex === CFG.QTY_FIELD);
            const insertAt = convertPos >= 0 ? convertPos + 1 : qtyPos >= 0 ? qtyPos + 1 : columns.length;
            columns.splice(insertAt, 0, newCol);
            changed = true;
        });

        return changed;
    }

    function addFieldToDataIndex(block, convertField) {
        const idx = block.dataindex;
        if (idx[CFG.METER_FIELD] !== undefined) return { pos: idx[CFG.METER_FIELD], newlyAdded: false };
        if (idx[convertField] === undefined) return { pos: -1, newlyAdded: false };

        const insertPos = Number(idx[convertField]) + 1;
        Object.keys(idx).forEach(k => { if (typeof idx[k] === 'number' && idx[k] >= insertPos) idx[k] += 1; });
        idx[CFG.METER_FIELD] = insertPos;

        if (block.sumformat && block.sumformat[CFG.QTY_FIELD] && !block.sumformat[CFG.METER_FIELD]) {
            block.sumformat[CFG.METER_FIELD] = block.sumformat[CFG.QTY_FIELD];
        }

        return { pos: insertPos, newlyAdded: true };
    }

    function isServerSummaryRow(row, idx) {
        const code = normalize(row[idx[CFG.CODE_FIELD]]);
        const name = idx[CFG.NAME_FIELD] !== undefined ? normalize(row[idx[CFG.NAME_FIELD]]) : '';
        if (name === '合计' || name === '合計') return true;
        if (!code && name.includes('合计')) return true;
        const datatype = idx.datatype !== undefined ? normalize(row[idx.datatype]) : '';
        return !!(datatype && datatype !== '0');
    }

    function calcMetersForRow(row, idx, convertField) {
        const code = normalize(row[idx[CFG.CODE_FIELD]]);
        if (!code.startsWith(CFG.CODE_PREFIX)) return '';

        const qty = toNumber(row[idx[CFG.QTY_FIELD]]);
        const convert = toNumber(row[idx[convertField]]);
        if (!Number.isFinite(qty) || !Number.isFinite(convert) || convert === 0) return '';

        return round(qty / convert);
    }

    function patchDataBlock(block, convertField, options = {}) {
        const idx = block.dataindex;
        if (idx[convertField] === undefined) return { changed: false, count: 0, sum: 0 };

        const addResult = options.patchRows === false ? { pos: idx[CFG.METER_FIELD] ?? -1, newlyAdded: false } : addFieldToDataIndex(block, convertField);
        const meterPos = addResult.pos;
        if (meterPos < 0 && options.patchRows !== false) return { changed: false, count: 0, sum: 0 };

        let count = 0;
        let sum = 0;

        block.rows.forEach(row => {
            if (!Array.isArray(row)) return;
            if (addResult.newlyAdded) row.splice(meterPos, 0, '');
            if (isServerSummaryRow(row, idx)) {
                if (options.patchRows !== false && meterPos >= 0) row[meterPos] = '';
                return;
            }

            const meters = calcMetersForRow(row, idx, convertField);
            if (meters !== '') { count += 1; sum += Number(meters); }
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

            params.forEach(action => {
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
            STATE.latestTotalMeters = round(firstSum);
            return STATE.latestTotalMeters;
        }

        STATE.pageTotals = { [meta.pageindex]: Number(firstSum || 0) };
        if (STATE.processingExtraPages) return round(Object.values(STATE.pageTotals).reduce((a, b) => a + Number(b || 0), 0));
        STATE.processingExtraPages = true;

        try {
            const lastPage = Math.min(meta.pagecount, CFG.MAX_AUTO_PAGES);
            for (let pageNo = 2; pageNo <= lastPage; pageNo++) {
                const body = buildPagedBody(originalBody, pageNo, meta);
                if (!body) break;

                const res = await STATE.rawFetch(url, {
                    method: 'POST',
                    credentials: 'include',
                    headers: init && init.headers ? init.headers : undefined,
                    body
                });

                const payload = safeJsonParse(await res.text());
                if (!payload) break;

                let pageSum = 0;
                findInventoryBlocks(payload).forEach(block => {
                    const result = patchDataBlock(block, convertField, { patchRows: false });
                    pageSum += Number(result.sum || 0);
                });

                STATE.pageTotals[pageNo] = pageSum;
            }
        } catch (e) {
            warn('补算分页失败', e);
        } finally {
            STATE.processingExtraPages = false;
        }

        const total = Object.values(STATE.pageTotals).reduce((a, b) => a + Number(b || 0), 0);
        STATE.latestTotalMeters = round(total);
        return STATE.latestTotalMeters;
    }

    function patchFloatBottomData(data, totalMeters) {
        let changed = false;
        walk(data, node => {
            if (node && node.key === CFG.GRID_KEY && node.methodname === 'setFloatButtomData' && Array.isArray(node.args) && node.args[0] && typeof node.args[0] === 'object') {
                node.args[0][CFG.METER_FIELD] = totalMeters !== undefined && totalMeters !== '' ? String(totalMeters) : String(STATE.latestTotalMeters || '');
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

        blocks.forEach(block => {
            const result = patchDataBlock(block, convertField, { patchRows: true });
            if (result.changed) changed = true;
            currentPayloadSum += Number(result.sum || 0);
        });

        if (blocks.length > 0) {
            const total = await calcAllPagesTotal(ctx.url, ctx.init, ctx.bodyText, data, convertField, currentPayloadSum);
            patchFloatBottomData(data, total);
        } else if (patchFloatBottomData(data, STATE.latestTotalMeters)) {
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
        const res = await STATE.rawFetch(input, init);
        const url = getFetchUrl(input);
        if (!isInventoryUrl(url)) return res;

        const text = await res.clone().text().catch(() => '');
        if (!text) return res;

        const data = safeJsonParse(text);
        if (!data) return res;

        const changed = await patchPayload(data, { url, init, bodyText: getBodyText(init) });
        return changed ? rebuildResponse(res, JSON.stringify(data)) : res;
    };

    log('脚本已启动：库存查询表米数注入稳定版');
})();
