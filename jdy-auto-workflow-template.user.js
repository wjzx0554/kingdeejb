// ==UserScript==
// @name         金蝶-自动表格处理流程模板
// @namespace    http://tampermonkey.net/
// @version      0.1.0
// @description  可复用流程模板：切页签、批量修正表格字段、删除空行、保存确认
// @author       Codex
// @match        https://tf.jdy.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const CONFIG = {
    debug: true,
    pollMs: 120,

    tabs: {
      rootSelector: '#tabbills span span:nth-child(1)',
      activeClass: '_1D1HxDOs'
    },

    // 可配置流程：按顺序执行
    workflow: [
      {
        name: '切换采购订单',
        action: 'switchTab',
        tabText: '采购订单'
      },
      {
        name: '修正表格字段并清理空行',
        action: 'fixGrid'
      },
      {
        name: '保存变更单',
        action: 'save',
        saveBtn: '#alter_save',
        confirmBtn: '#kd-theme a.btn-follow-theme'
      },
      {
        name: '切换销售订单',
        action: 'switchTab',
        tabText: '销售订单'
      }
    ],

    // ag-Grid 列配置（按你的单据表格改）
    grid: {
      root: '.ag-root',
      rowSelector: '.ag-center-cols-viewport [role="row"]',
      // 左列有值且右列不等于左列 => 将右列改成左列
      sourceColIndex: 6,
      targetColIndex: 4,
      // 判定“空目标行可删除”使用的列
      emptyCheckColIndex: 6,
      rowHasDataColIndex: 0,
      deleteIconSelector: '.kdfont-yidongduanshanchu',
      // 如果能拿到 ag 组件，按库存列排序后从第一行判断是否继续循环
      sortColId: 'uninqty',
      continueWhenTopRowGt: 0
    }
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function log(...args) {
    if (CONFIG.debug) console.log('[JDY自动流程模板]', ...args);
  }

  async function waitForSelector(selector, timeoutMs = 20000) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const el = document.querySelector(selector);
      if (el) return el;
      await sleep(CONFIG.pollMs);
    }
    throw new Error(`超时未找到元素: ${selector}`);
  }

  async function waitUntil(fn, timeoutMs = 20000, failMsg = 'waitUntil timeout') {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      if (await fn()) return true;
      await sleep(CONFIG.pollMs);
    }
    throw new Error(failMsg);
  }

  function triggerReactInput(inputEl, nextValue) {
    if (!inputEl) return;
    const key = Object.keys(inputEl).find((k) => k.startsWith('__reactEventHandlers'));
    if (key && inputEl[key]?.onChange) {
      inputEl[key].onChange({ target: { value: nextValue } });
      return;
    }

    inputEl.value = nextValue;
    inputEl.dispatchEvent(new Event('input', { bubbles: true }));
    inputEl.dispatchEvent(new Event('change', { bubbles: true }));
  }

  async function switchTab(tabText) {
    const tabNodes = [...document.querySelectorAll(CONFIG.tabs.rootSelector)];
    const target = tabNodes.find((el) => (el.textContent || '').includes(tabText));
    if (!target) throw new Error(`未找到页签: ${tabText}`);

    if (target.classList.contains(CONFIG.tabs.activeClass)) {
      log(`页签已激活: ${tabText}`);
      return;
    }

    target.click();
    await waitUntil(() => target.classList.contains(CONFIG.tabs.activeClass), 20000, `切换页签失败: ${tabText}`);
    log(`切换页签完成: ${tabText}`);
  }

  function getGridApi(gridRoot) {
    const comp = gridRoot?.__agComponent;
    const api = comp?.gridApi;
    if (!api) return null;
    return {
      sortBy(colId) {
        api.setSortModel([{ colId, sort: 'desc' }]);
      },
      topRowData() {
        return api.getDisplayedRowAtIndex(0)?.data || null;
      }
    };
  }

  async function fixGridOnce() {
    const viewport = await waitForSelector('.ag-center-cols-viewport');
    const rows = [...viewport.querySelectorAll('[role="row"]')];

    for (const row of rows) {
      const cells = row.children;
      const sourceCell = cells[CONFIG.grid.sourceColIndex];
      const targetCell = cells[CONFIG.grid.targetColIndex];
      if (!sourceCell || !targetCell) continue;

      const sourceVal = (sourceCell.textContent || '').trim();
      const targetVal = (targetCell.textContent || '').trim();
      if (!sourceVal || sourceVal === targetVal) continue;

      targetCell.click();
      await sleep(80);
      const input = targetCell.querySelector('input') || row.querySelector('input');
      triggerReactInput(input, sourceVal);
      await sleep(80);
    }

    // 删除“目标列为空但行首有数据”的行
    const pinned = await waitForSelector('.ag-pinned-left-cols-container');
    const centerRows = [...viewport.querySelectorAll('[role="row"]')];
    const pinnedRows = [...pinned.querySelectorAll('[role="row"]')];

    let deleted = 0;
    for (const [idx, row] of centerRows.entries()) {
      const cells = row.children;
      const checkVal = (cells[CONFIG.grid.emptyCheckColIndex]?.textContent || '').trim();
      const rowHasData = (cells[CONFIG.grid.rowHasDataColIndex]?.textContent || '').trim();
      if (checkVal || !rowHasData) continue;

      const delBtn = pinnedRows[idx]?.querySelector(CONFIG.grid.deleteIconSelector);
      if (delBtn) {
        delBtn.click();
        deleted += 1;
        await sleep(120);
      }
    }

    return { rowCount: rows.length, deleted };
  }

  async function fixGrid() {
    const gridRoot = await waitForSelector(CONFIG.grid.root);
    const api = getGridApi(gridRoot);

    if (api) api.sortBy(CONFIG.grid.sortColId);

    let round = 0;
    while (true) {
      round += 1;
      const top = api?.topRowData();
      const topNum = Number(top?.[CONFIG.grid.sortColId] ?? 0);
      if (api && !(topNum > CONFIG.grid.continueWhenTopRowGt)) break;

      const result = await fixGridOnce();
      log(`第${round}轮修正`, result);

      if (!result.deleted && round >= 2) break;
      await sleep(400);
    }
  }

  async function save(saveBtn, confirmBtn) {
    (await waitForSelector(saveBtn)).click();
    await sleep(600);

    const okBtn = document.querySelector(confirmBtn);
    if (okBtn) {
      okBtn.click();
      await sleep(600);
    }

    log('保存动作完成');
  }

  async function runStep(step) {
    log(`开始步骤: ${step.name}`);

    switch (step.action) {
      case 'switchTab':
        await switchTab(step.tabText);
        break;
      case 'fixGrid':
        await fixGrid();
        break;
      case 'save':
        await save(step.saveBtn, step.confirmBtn);
        break;
      default:
        throw new Error(`未知步骤动作: ${step.action}`);
    }

    log(`结束步骤: ${step.name}`);
  }

  async function runWorkflow() {
    for (const step of CONFIG.workflow) {
      await runStep(step);
      await sleep(300);
    }
    log('流程执行完毕');
  }

  function mountPanel() {
    const panel = document.createElement('div');
    panel.style.cssText = [
      'position: fixed',
      'left: 12px',
      'top: 12px',
      'z-index: 999999',
      'display: flex',
      'gap: 8px',
      'background: rgba(0,0,0,.65)',
      'padding: 8px',
      'border-radius: 8px'
    ].join(';');

    const runBtn = document.createElement('button');
    runBtn.textContent = '运行自动流程';
    runBtn.style.cssText = 'padding:6px 10px;cursor:pointer;';
    runBtn.addEventListener('click', async () => {
      try {
        runBtn.disabled = true;
        runBtn.textContent = '执行中...';
        await runWorkflow();
      } catch (err) {
        console.error(err);
        alert(`执行失败: ${err.message || err}`);
      } finally {
        runBtn.disabled = false;
        runBtn.textContent = '运行自动流程';
      }
    });

    panel.appendChild(runBtn);
    document.body.appendChild(panel);
  }

  window.__JDY_AUTO_WORKFLOW__ = {
    run: runWorkflow,
    config: CONFIG
  };

  waitForSelector('body').then(mountPanel).catch(console.error);
})();
