// ==UserScript==
// @name         TM Core Runtime（脚本内核模板）
// @namespace    http://tampermonkey.net/
// @version      0.1.0
// @description  通用内核：拦截 fetch/xhr、深度遍历、消息提示、插件注册
// @match        *://*/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  if (window.__TM_CORE_RUNTIME__) return;

  const state = {
    plugins: {},
    started: false
  };

  function deepWalk(node, visitor, seen = new WeakSet()) {
    if (!node || typeof node !== 'object' || seen.has(node)) return;
    seen.add(node);
    visitor(node);

    if (Array.isArray(node)) {
      for (const item of node) deepWalk(item, visitor, seen);
      return;
    }
    Object.keys(node).forEach((k) => deepWalk(node[k], visitor, seen));
  }

  function safeJsonParse(text) {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  function normalizeText(val) {
    return String(val == null ? '' : val).replace(/\s+/g, ' ').trim();
  }

  function toNumber(v) {
    if (Array.isArray(v)) v = v[0];
    if (v == null || v === '') return NaN;
    const n = parseFloat(String(v).replace(/,/g, '').trim());
    return Number.isFinite(n) ? n : NaN;
  }

  function showToast(text, color = '#1677ff', durationMs = 2200) {
    const render = () => {
      const box = document.createElement('div');
      box.style.cssText = [
        'position: fixed',
        'top: 12px',
        'left: 50%',
        'transform: translateX(-50%)',
        `background: ${color}`,
        'color:#fff',
        'font-size:12px',
        'padding:8px 12px',
        'border-radius:14px',
        'z-index: 2147483647',
        'box-shadow: 0 4px 10px rgba(0,0,0,.2)'
      ].join(';');
      box.textContent = text;
      document.body.appendChild(box);
      setTimeout(() => box.remove(), durationMs);
    };

    if (document.body) render();
    else window.addEventListener('DOMContentLoaded', render, { once: true });
  }

  function hookFetchJson(handler) {
    if (!window.fetch) return;
    const rawFetch = window.fetch;

    window.fetch = async function (...args) {
      const res = await rawFetch.apply(this, args);
      const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';

      let text;
      try {
        text = await res.clone().text();
      } catch {
        return res;
      }

      const json = safeJsonParse(text);
      if (!json) return res;

      const result = await handler({ url, json, response: res, args });
      if (!result || !result.changed) return res;

      const headers = new Headers(res.headers);
      headers.delete('content-length');
      return new Response(JSON.stringify(result.json || json), {
        status: res.status,
        statusText: res.statusText,
        headers
      });
    };
  }

  function hookXhrJson(handler) {
    const rawSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.send = function (...args) {
      this.addEventListener('load', () => {
        const url = this.responseURL || '';
        if (typeof this.responseText !== 'string') return;
        const json = safeJsonParse(this.responseText);
        if (!json) return;
        handler({ url, json, xhr: this, args }).catch(() => {});
      });
      return rawSend.apply(this, args);
    };
  }

  function registerPlugin(name, plugin) {
    state.plugins[name] = plugin;
  }

  async function start() {
    if (state.started) return;
    state.started = true;

    for (const [name, plugin] of Object.entries(state.plugins)) {
      try {
        await plugin.start?.(runtimeApi);
      } catch (e) {
        console.error(`[TM CORE] 插件启动失败: ${name}`, e);
      }
    }
  }

  const runtimeApi = {
    deepWalk,
    safeJsonParse,
    normalizeText,
    toNumber,
    showToast,
    hookFetchJson,
    hookXhrJson,
    registerPlugin,
    start,
    state
  };

  window.__TM_CORE_RUNTIME__ = runtimeApi;

  setTimeout(start, 0);
})();
