// ==UserScript==
// @name         虫虫钢琴解锁助手（可配置模板）
// @namespace    http://tampermonkey.net/
// @version      1.0.0
// @description  双模跳转 + 打印优化 + 去水印（配置化模板）
// @match        *://*.gangqinpu.com/*
// @grant        GM_addStyle
// @run-at       document-end
// ==/UserScript==

(function () {
  'use strict';

  const CONFIG = {
    panelId: 'ccmz-tool-panel',
    logId: 'ccmz-log',
    panelTitle: '曲谱助手模板',
    showJumpOnlyWhenUrlIncludes: 'cchtml',

    playerUrlRegex: /["'](https?:\/\/[^"']+\/player\/[^"']+)["']/,
    playerIframeSelector: 'iframe',

    modeParam: 'jianpuMode',
    modeLabels: {
      staff: '进入五线谱页',
      jianpu: '进入简谱页'
    },

    printButtonText: '系统打印 (自然分页)',

    hiddenSelectorsOnScreen: [
      '.print',
      '.watermark',
      '.page-watermark',
      '.sheet-watermark',
      '#watermark',
      '.user-mask',
      'image[x="75"]'
    ],

    hiddenSelectorsOnPrint: [
      '#ccmz-tool-panel',
      '.header',
      '.footer',
      '.sidebar',
      '.noprint'
    ],

    targetVisibleRootsOnPrint: ['#app', '#container', 'svg'],

    removeBeforePrintSelectors: ['rect[opacity="0"]'],

    panelStyle: {
      right: '10px',
      top: '15%',
      width: '160px'
    }
  };

  function injectStyles() {
    const hideScreen = CONFIG.hiddenSelectorsOnScreen.join(', ');
    const hidePrint = CONFIG.hiddenSelectorsOnPrint.join(', ');
    const showPrint = CONFIG.targetVisibleRootsOnPrint.map((s) => `${s}, ${s} *`).join(', ');

    GM_addStyle(`
      #${CONFIG.panelId} {
        position: fixed;
        right: ${CONFIG.panelStyle.right};
        top: ${CONFIG.panelStyle.top};
        z-index: 2147483647;
        width: ${CONFIG.panelStyle.width};
        background: #2c3e50;
        color: #fff;
        padding: 10px;
        border-radius: 8px;
        box-shadow: 0 5px 15px rgba(0,0,0,0.5);
        font-family: sans-serif;
      }
      #${CONFIG.panelId} button {
        width: 100%; margin: 4px 0; padding: 10px; cursor: pointer;
        border: none; border-radius: 5px; background: #3498db; color: #fff; font-weight: bold;
      }
      #${CONFIG.panelId} .btn-jump { background: #e67e22 !important; }
      #${CONFIG.panelId} .btn-print { background: #27ae60 !important; }

      ${hideScreen} {
        display:none !important;
        opacity:0 !important;
        visibility:hidden !important;
      }

      @media print {
        body * { visibility: hidden !important; }
        ${hidePrint} { display: none !important; }

        ${showPrint} { visibility: visible !important; }

        svg image.print,
        svg image[class*="print"],
        svg g[class*="watermark"] {
          display: none !important;
          opacity: 0 !important;
        }

        svg {
          zoom: 1 !important;
          transform: none !important;
          width: 100% !important;
          height: auto !important;
          display: block !important;
          position: relative !important;
        }
      }
    `);
  }

  function setLog(text) {
    const el = document.getElementById(CONFIG.logId);
    if (el) el.textContent = text;
  }

  function isMainPage() {
    return window.location.href.includes(CONFIG.showJumpOnlyWhenUrlIncludes);
  }

  function detectPlayerUrl() {
    const iframe = document.querySelector(CONFIG.playerIframeSelector);
    if (iframe?.src) return iframe.src;

    const scripts = document.querySelectorAll('script');
    for (const s of scripts) {
      const m = s.textContent.match(CONFIG.playerUrlRegex);
      if (m) return m[1];
    }

    return '';
  }

  function doJump(mode) {
    const baseUrl = detectPlayerUrl();
    if (!baseUrl) {
      alert('未找到播放器地址，请尝试先点击播放。');
      setLog('跳转失败：未找到播放器地址');
      return;
    }

    const targetUrl = new URL(baseUrl);
    targetUrl.searchParams.set(CONFIG.modeParam, mode);
    window.open(targetUrl.toString(), '_blank');
    setLog(`已跳转：${mode === 0 ? '五线谱' : '简谱'}`);
  }

  function doPrint() {
    const svg = document.querySelector('svg');
    if (svg) {
      CONFIG.removeBeforePrintSelectors.forEach((selector) => {
        svg.querySelectorAll(selector).forEach((el) => el.remove());
      });
    }
    setLog('调用系统打印...');
    window.print();
  }

  function mountPanel() {
    if (document.getElementById(CONFIG.panelId)) return;

    const main = isMainPage();
    const panel = document.createElement('div');
    panel.id = CONFIG.panelId;
    panel.innerHTML = `
      <div style="font-size:12px; margin-bottom:8px; text-align:center;">${CONFIG.panelTitle}</div>
      ${main ? `
        <button id="btn-jump-5" class="btn-jump">${CONFIG.modeLabels.staff}</button>
        <button id="btn-jump-j" class="btn-jump">${CONFIG.modeLabels.jianpu}</button>
      ` : ''}
      <button id="btn-print-fixed" class="btn-print">${CONFIG.printButtonText}</button>
      <div id="${CONFIG.logId}" style="font-size:10px; color:#bdc3c7; text-align:center; margin-top:5px;">准备就绪</div>
    `;

    document.body.appendChild(panel);

    if (main) {
      document.getElementById('btn-jump-5').onclick = () => doJump(0);
      document.getElementById('btn-jump-j').onclick = () => doJump(1);
    }

    document.getElementById('btn-print-fixed').onclick = doPrint;
  }

  injectStyles();
  mountPanel();

  window.__GANGQINPU_UNLOCKER__ = {
    config: CONFIG,
    jump: doJump,
    print: doPrint,
    detectPlayerUrl
  };
})();
