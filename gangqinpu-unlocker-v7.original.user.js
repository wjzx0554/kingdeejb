// ==UserScript==
// @name         虫虫钢琴 高清全能解锁版 V7.0 (回归经典打印逻辑)（原始存档）
// @namespace    http://tampermonkey.net/
// @version      7.0
// @description  双模跳转 + 恢复自动分页打印 + 深度去水印
// @author       Gemini
// @match        *://*.gangqinpu.com/*
// @grant        GM_addStyle
// @run-at       document-end
// ==/UserScript==

(function () {
    'use strict';

    GM_addStyle(`
        #ccmz-tool-panel {
            position: fixed; right: 10px; top: 15%; z-index: 2147483647;
            width: 160px; background: #2c3e50; color: #fff;
            padding: 10px; border-radius: 8px; box-shadow: 0 5px 15px rgba(0,0,0,0.5);
            font-family: sans-serif;
        }
        #ccmz-tool-panel button {
            width: 100%; margin: 4px 0; padding: 10px; cursor: pointer;
            border: none; border-radius: 5px; background: #3498db; color: #fff; font-weight: bold;
        }
        #ccmz-tool-panel .btn-jump { background: #e67e22 !important; }
        #ccmz-tool-panel .btn-print { background: #27ae60 !important; }

        .print, .watermark, .page-watermark, .sheet-watermark, #watermark, .user-mask, image[x="75"] {
            display:none !important; opacity:0 !important; visibility:hidden !important;
        }

        @media print {
            body * { visibility: hidden !important; }
            #ccmz-tool-panel, .header, .footer, .sidebar, .noprint { display: none !important; }

            #app, #app *, #container, #container *, svg, svg * {
                visibility: visible !important;
            }

            svg image.print, svg image[class*="print"], svg g[class*="watermark"] {
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

    const currentURL = window.location.href;
    const isMainPage = currentURL.includes('cchtml');

    const panel = document.createElement('div');
    panel.id = 'ccmz-tool-panel';
    panel.innerHTML = `
        <div style="font-size:12px; margin-bottom:8px; text-align:center;">曲谱助手 V7.0</div>
        ${isMainPage ? `
            <button id="btn-jump-5" class="btn-jump">进入五线谱页</button>
            <button id="btn-jump-j" class="btn-jump">进入简谱页</button>
        ` : ''}
        <button id="btn-print-fixed" class="btn-print">系统打印 (自然分页)</button>
        <div id="ccmz-log" style="font-size:10px; color:#bdc3c7; text-align:center; margin-top:5px;">准备就绪</div>
    `;
    document.body.appendChild(panel);

    function doJump(mode) {
        let baseUrl = "";
        const iframe = document.querySelector('iframe');
        if (iframe && iframe.src) {
            baseUrl = iframe.src;
        } else {
            const scripts = document.querySelectorAll('script');
            for (let s of scripts) {
                const m = s.textContent.match(/["'](https?:\/\/[^"']+\/player\/[^"']+)["']/);
                if (m) { baseUrl = m[1]; break; }
            }
        }

        if (baseUrl) {
            let targetUrl = new URL(baseUrl);
            targetUrl.searchParams.set('jianpuMode', mode);
            window.open(targetUrl.toString(), '_blank');
        } else {
            alert("未找到播放器地址，请尝试先点击播放。");
        }
    }

    if (isMainPage) {
        document.getElementById('btn-jump-5').onclick = () => doJump(0);
        document.getElementById('btn-jump-j').onclick = () => doJump(1);
    }

    document.getElementById('btn-print-fixed').onclick = () => {
        const svg = document.querySelector('svg');
        if (svg) {
            svg.querySelectorAll('rect[opacity="0"]').forEach(r => r.remove());
        }
        window.print();
    };
})();
