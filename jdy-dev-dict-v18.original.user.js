// ==UserScript==
// @name         金蝶开发字典助手 V18（前后台智能分离版）（原始存档）
// @namespace    http://tampermonkey.net/
// @version      18.0
// @description  专抓 polling.do：目录(children) + 详情(entities/properties/relations)，前后台按目录类型+上下文+中文特征智能分离
// @author       ChatGPT
// @match        *://*.jdy.com/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function () {
  const STORAGE_KEY = "KD_DEV_DICT_V18";
  const MAX_HITS = 120;
  let saveTimer = null;
  let uiReady = false;

  function getOfficialDict() {
    return window.KD_OFFICIAL || { officialTables: [] };
  }

  function defaultStore() {
    return {
      meta: { version: "18.0", updatedAt: "" },
      catalogs: { frontend: {}, backend: {} },
      objects: { frontend: {}, backend: {} },
      relations: { frontend: {}, backend: {} },
      hits: []
    };
  }

  function getStore() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return defaultStore();
      const parsed = JSON.parse(raw);
      return Object.assign(defaultStore(), parsed);
    } catch {
      return defaultStore();
    }
  }

  let memStore = getStore();

  function saveStoreDebounced() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      memStore.meta.updatedAt = new Date().toISOString();
      localStorage.setItem(STORAGE_KEY, JSON.stringify(memStore));
      window.dispatchEvent(new Event("storage"));
    }, 250);
  }

  const now = () => new Date().toISOString();

  function csvCell(value) {
    if (value === null || value === undefined) return "";
    const s = typeof value === "string" ? value : JSON.stringify(value);
    return `"${String(s).replace(/"/g, '""')}"`;
  }

  function download(content, name, type = "text/plain;charset=utf-8") {
    const blob = new Blob([content], { type });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  function tryParseJSON(text) {
    if (typeof text !== "string") return text;
    const s = text.trim();
    if (!s) return null;
    if ((s.startsWith("{") && s.endsWith("}")) || (s.startsWith("[") && s.endsWith("]"))) {
      try { return JSON.parse(s); } catch { return null; }
    }
    return null;
  }

  const hasChinese = (s = "") => /[\u4e00-\u9fff]/.test(String(s));
  const isTechBackendName = (name = "") => /^(t_|fct_|fs_|dim_|dwd_|ads_|ods_|tmp_|mid_)/i.test(String(name || ""));
  const looksRootCategoryName = (name = "") => name === "root" || String(name).startsWith("root\u0001");

  function dedupePushHit(hit) {
    const last = memStore.hits[0];
    if (last && last.source === hit.source && last.url === hit.url && last.kind === hit.kind && last.preview === hit.preview) return;
    memStore.hits.unshift(hit);
    memStore.hits = memStore.hits.slice(0, MAX_HITS);
  }

  function addHit(meta = {}, payloadPreview = "") {
    dedupePushHit({ ts: now(), source: meta.source || "", url: meta.url || "", kind: meta.kind || "", preview: String(payloadPreview || "").slice(0, 280) });
  }

  function classifyCatalogItem(item) {
    const type = item?.type || "";
    const name = item?.name || "";
    const displayName = item?.displayName || "";
    const commentInfo = item?.commentInfo || "";

    if (type === "entity") return { side: "frontend", reason: "catalog:type=entity" };
    if (type === "table") return { side: "backend", reason: "catalog:type=table" };
    if (looksRootCategoryName(name) && (hasChinese(displayName) || hasChinese(commentInfo))) return { side: "frontend", reason: "catalog:root+chineseDisplay" };
    if (isTechBackendName(name)) return { side: "backend", reason: "catalog:techNamePrefix" };
    if (hasChinese(displayName) || hasChinese(commentInfo)) return { side: "frontend", reason: "catalog:chineseDisplay" };
    if (/_/.test(name) && !hasChinese(name) && !hasChinese(displayName)) return { side: "backend", reason: "catalog:underscoreNoChinese" };
    return { side: "frontend", reason: "catalog:defaultFrontend" };
  }

  function findInCatalog(side, name) {
    if (!name) return false;
    return Object.values(memStore.catalogs[side] || {}).some(x => x.name === name || x.commentInfo === name || x.name.endsWith("\u0001" + name));
  }

  function findOfficialTable(name) {
    const official = getOfficialDict();
    const n = String(name || "").toLowerCase();
    return Array.isArray(official.officialTables) && official.officialTables.includes(n);
  }

  function classifyDetailRoot(root) {
    const ent = Array.isArray(root?.entities) && root.entities.length ? root.entities[0] : {};
    const name = root?.name || ent?.name || "";
    const fields = ent?.properties || ent?.fields || [];

    if (findInCatalog("backend", name)) return { side: "backend", reason: "detail:catalogBackend" };
    if (findInCatalog("frontend", name)) return { side: "frontend", reason: "detail:catalogFrontend" };
    if (findOfficialTable(name)) return { side: "backend", reason: "detail:officialTableHit" };

    let frontScore = 0;
    let backScore = 0;
    const reasons = [];

    if (isTechBackendName(name)) { backScore += 3; reasons.push("techNamePrefix"); }
    if (hasChinese(ent?.alias || "") || hasChinese(root?.displayName || "") || hasChinese(ent?.commentInfo || "")) { frontScore += 3; reasons.push("hasChineseObjectLabel"); }

    const total = fields.length || 1;
    let chineseAliasCount = 0, englishAliasEqNameCount = 0, fPrefixCount = 0, dottedAssociateCount = 0, fkCount = 0;

    for (const f of fields) {
      const alias = String(f?.alias || "");
      const fname = String(f?.name || "");
      const assoc = String(f?.associateName || "");

      if (hasChinese(alias)) chineseAliasCount++;
      if (alias && alias === fname && !hasChinese(alias)) englishAliasEqNameCount++;
      if (/^f[a-z0-9_]+$/i.test(fname)) fPrefixCount++;
      if (assoc.includes(".")) dottedAssociateCount++;
      if (f?.foreignKey) fkCount++;
    }

    if (chineseAliasCount / total > 0.25) { frontScore += 4; reasons.push("fieldChineseAliasRatio"); }
    if (englishAliasEqNameCount / total > 0.8) { backScore += 4; reasons.push("fieldAliasEqNameRatio"); }
    if (fPrefixCount / total > 0.5) { backScore += 2; reasons.push("fieldFPrefixRatio"); }
    if (dottedAssociateCount / total > 0.2) { frontScore += 2; reasons.push("fieldDottedAssociateRatio"); }
    if (fkCount > 0 && chineseAliasCount > 0) { frontScore += 1; reasons.push("fieldFkWithChineseAlias"); }

    return frontScore >= backScore
      ? { side: "frontend", reason: "detail:scoreFrontend(" + reasons.join("|") + ")" }
      : { side: "backend", reason: "detail:scoreBackend(" + reasons.join("|") + ")" };
  }

  function classifyRelation(rel) {
    const from = rel?.fromEntity || "";
    const to = rel?.toEntity || "";

    if (findInCatalog("backend", from) || findInCatalog("backend", to) || findOfficialTable(from) || findOfficialTable(to)) return { side: "backend", reason: "relation:backendContext" };
    if (findInCatalog("frontend", from) || findInCatalog("frontend", to)) return { side: "frontend", reason: "relation:frontendContext" };
    if (isTechBackendName(from) || isTechBackendName(to)) return { side: "backend", reason: "relation:techNamePrefix" };
    return { side: "frontend", reason: "relation:defaultFrontend" };
  }

  function upsertCatalog(side, item, parentName = "", meta = {}, judgeReason = "") {
    if (!item || !item.name) return;
    const key = `${item.type || "unknown"}|${item.name}`;

    if (!memStore.catalogs[side][key]) {
      memStore.catalogs[side][key] = { type: item.type || "", name: item.name || "", displayName: item.displayName || item.name || "", commentInfo: item.commentInfo || "", parentName: parentName || "", firstSeen: now(), lastSeen: now(), sourceUrl: meta.url || "", judgeReason };
    } else {
      const obj = memStore.catalogs[side][key];
      obj.displayName ||= item.displayName || item.name || "";
      obj.commentInfo ||= item.commentInfo || "";
      obj.parentName ||= parentName || "";
      obj.lastSeen = now();
      obj.sourceUrl ||= meta.url || "";
      obj.judgeReason ||= judgeReason;
    }
  }

  function ensureObject(side, name, ent = {}, root = {}, meta = {}, judgeReason = "") {
    if (!name) return null;
    if (!memStore.objects[side][name]) {
      memStore.objects[side][name] = { name, label: ent.alias || root.displayName || root.alias || root.name || name, associateName: ent.associateName || root.associateName || "", parentName: ent.parentName || root.parentName || "", commentInfo: ent.commentInfo || root.commentInfo || "", source: ent.source || root.source || "", directModel: !!(ent.directModel ?? root.directModel), firstSeen: now(), lastSeen: now(), sourceUrl: meta.url || "", objectType: "unknown", judgeReason, fields: {} };
    } else {
      const obj = memStore.objects[side][name];
      obj.label ||= ent.alias || root.displayName || root.alias || root.name || name;
      obj.associateName ||= ent.associateName || root.associateName || "";
      obj.parentName ||= ent.parentName || root.parentName || "";
      obj.commentInfo ||= ent.commentInfo || root.commentInfo || "";
      obj.source ||= ent.source || root.source || "";
      obj.lastSeen = now();
      obj.sourceUrl ||= meta.url || "";
      obj.judgeReason ||= judgeReason;
    }
    return memStore.objects[side][name];
  }

  function upsertField(side, objectName, f) {
    if (!f || !f.name) return;
    const obj = memStore.objects[side][objectName];
    if (!obj) return;

    const old = obj.fields[f.name] || {};
    obj.fields[f.name] = {
      name: f.name,
      label: old.label || f.alias || f.commentInfo || f.caption || f.name,
      associateName: old.associateName || f.associateName || "",
      commentInfo: old.commentInfo || f.commentInfo || "",
      type: old.type || f.dataType || f.appointedDataType || f.type || "",
      pk: typeof old.pk === "boolean" ? old.pk : !!f.primaryKey,
      fk: typeof old.fk === "boolean" ? old.fk : !!f.foreignKey,
      refEntity: old.refEntity || f.foreignKey?.entityAssociateName || "",
      refField: old.refField || f.foreignKey?.pkPropertyName || "",
      refDisplayField: old.refDisplayField || f.foreignKey?.displayPropertyName || "",
      relatedBaseProperty: old.relatedBaseProperty || f.relatedBaseProperty || "",
      hide: typeof old.hide === "boolean" ? old.hide : !!f.hide,
      hideInDataModeling: typeof old.hideInDataModeling === "boolean" ? old.hideInDataModeling : !!f.hideInDataModeling,
      isVoidEnumProp: typeof old.isVoidEnumProp === "boolean" ? old.isVoidEnumProp : !!f.isVoidEnumProp,
      hasChild: typeof old.hasChild === "boolean" ? old.hasChild : !!f.hasChild,
      isInvalidForParent: typeof old.isInvalidForParent === "boolean" ? old.isInvalidForParent : !!f.isInvalidForParent,
      isNotExisted: typeof old.isNotExisted === "boolean" ? old.isNotExisted : !!f.isNotExisted,
      enumValue: old.enumValue || f.enumValue || null
    };
  }

  function tagObjectType(name, fieldsObj) {
    const lowerName = String(name || "").toLowerCase();
    const fieldNames = Object.keys(fieldsObj || {});
    if (!fieldNames.length) return "unknown";

    if (/_entry\b/i.test(lowerName) || /\bentry\b/i.test(lowerName)) return "entry_table";
    if (/_lk\b/i.test(lowerName)) return "link_table";
    if (/_l\b/i.test(lowerName)) return "lang_table";
    if (/_c\b/i.test(lowerName)) return "ext_table";

    const patternFields = fieldNames.filter(f => /^f_(text|date|decimal|assistant_id|basedata_id)_\d+$/i.test(f)).length;
    if (patternFields >= 8) return "ext_table";

    if (fieldNames.some(f => /^fbill(no|date|type|status)$/i.test(f)) || fieldNames.some(f => /^fcustomerid$/i.test(f)) || fieldNames.some(f => /^fmaterialid$/i.test(f))) {
      return "business_table";
    }
    return "unknown";
  }

  function upsertRelation(rel, meta = {}) {
    if (!rel || !rel.fromEntity || !rel.toEntity) return;
    const cls = classifyRelation(rel);
    const side = cls.side;
    const key = [rel.fromEntity || "", rel.toEntity || "", rel.fromProperty || "", rel.toProperty || "", rel.related || rel.relationType || ""].join("|");

    if (!memStore.relations[side][key]) {
      memStore.relations[side][key] = { from: rel.fromEntity || "", to: rel.toEntity || "", fromProp: rel.fromProperty || "", toProp: rel.toProperty || "", type: rel.related || rel.relationType || "", firstSeen: now(), lastSeen: now(), sourceUrl: meta.url || "", judgeReason: cls.reason };
    } else {
      const obj = memStore.relations[side][key];
      obj.lastSeen = now();
      obj.sourceUrl ||= meta.url || "";
      obj.judgeReason ||= cls.reason;
    }
  }

  function processDataRoot(root, meta = {}) {
    if (!root || typeof root !== "object") return;
    let touchedCatalog = false, touchedDetail = false, touchedRelation = false;

    if (Array.isArray(root.children)) {
      root.children.forEach(child => {
        if (!child || !child.name) return;
        const cls = classifyCatalogItem(child);
        upsertCatalog(cls.side, child, root.name || "", meta, cls.reason);
        touchedCatalog = true;
      });
      if (touchedCatalog) addHit({ ...meta, kind: "catalog" }, root.name || "[children]");
    }

    if (Array.isArray(root.entities)) {
      const cls = classifyDetailRoot(root);
      const side = cls.side;
      root.entities.forEach(ent => {
        const name = ent.name || root.name || "";
        if (!name) return;
        ensureObject(side, name, ent, root, meta, cls.reason);
        (ent.properties || ent.fields || []).forEach(f => upsertField(side, name, f));
        memStore.objects[side][name].objectType = tagObjectType(name, memStore.objects[side][name].fields);
        touchedDetail = true;
      });
      if (touchedDetail) addHit({ ...meta, kind: "detail" }, root.name || "[entities]");
    }

    if (Array.isArray(root.relations)) {
      root.relations.forEach(rel => upsertRelation(rel, meta));
      if (root.relations.length) {
        touchedRelation = true;
        addHit({ ...meta, kind: "relation" }, root.name || "[relations]");
      }
    }

    if (touchedCatalog || touchedDetail || touchedRelation) saveStoreDebounced();
  }

  function walkNode(node, meta = {}, seen = new WeakSet()) {
    if (!node || typeof node !== "object" || seen.has(node)) return;
    seen.add(node);

    if (Array.isArray(node)) {
      node.forEach(item => walkNode(item, meta, seen));
      return;
    }

    if (node.data && node.data.data && typeof node.data.data === "object") processDataRoot(node.data.data, meta);
    if (Array.isArray(node.children) || Array.isArray(node.entities) || Array.isArray(node.relations)) processDataRoot(node, meta);
    Object.values(node).forEach(v => walkNode(v, meta, seen));
  }

  function safeConsume(payload, meta = {}) {
    try {
      if (meta.url && !/polling\.do/i.test(meta.url)) return;
      const parsed = typeof payload === "string" ? tryParseJSON(payload) : payload;
      if (!parsed || typeof parsed !== "object") return;
      walkNode(parsed, meta);
    } catch (e) {
      console.warn("[KD V18] consume failed:", e);
    }
  }

  const rawOpen = XMLHttpRequest.prototype.open;
  const rawSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url) {
    this.__kd_url = url;
    return rawOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function () {
    this.addEventListener("load", function () {
      try {
        if (typeof this.responseText === "string") safeConsume(this.responseText, { source: "xhr", url: this.__kd_url || "" });
      } catch (e) {}
    });
    return rawSend.apply(this, arguments);
  };

  if (window.fetch) {
    const rawFetch = window.fetch;
    window.fetch = async function (...args) {
      const res = await rawFetch.apply(this, args);
      try {
        const text = await res.clone().text();
        safeConsume(text, { source: "fetch", url: typeof args[0] === "string" ? args[0] : (args[0]?.url || "") });
      } catch (e) {}
      return res;
    };
  }

  function buildSideCSV(side) {
    let csv = "\uFEFF";
    csv += `[${side === "frontend" ? "前端目录" : "后台目录"}]\n`;
    csv += ["对象类型","名称","显示名","备注","父节点","首次发现","最后发现","来源URL","judgeReason"].join(",") + "\n";

    Object.values(memStore.catalogs[side]).forEach(o => {
      csv += [csvCell(o.type), csvCell(o.name), csvCell(o.displayName), csvCell(o.commentInfo), csvCell(o.parentName), csvCell(o.firstSeen), csvCell(o.lastSeen), csvCell(o.sourceUrl), csvCell(o.judgeReason)].join(",") + "\n";
    });

    csv += `\n[${side === "frontend" ? "前端详情" : "后台详情"}]\n`;
    csv += ["对象名","对象别名","对象路径","父实体","对象备注","对象类型","judgeReason","字段","字段名","字段路径","类型","主键","外键","引用实体","引用主键","引用显示字段","relatedBaseProperty","hide","hideInDataModeling","isVoidEnumProp","hasChild","isInvalidForParent","isNotExisted","枚举JSON","来源URL"].join(",") + "\n";

    Object.values(memStore.objects[side]).forEach(obj => {
      Object.values(obj.fields).forEach(f => {
        csv += [csvCell(obj.name), csvCell(obj.label), csvCell(obj.associateName), csvCell(obj.parentName), csvCell(obj.commentInfo), csvCell(obj.objectType || "unknown"), csvCell(obj.judgeReason), csvCell(f.name), csvCell(f.label), csvCell(f.associateName), csvCell(f.type), csvCell(f.pk), csvCell(f.fk), csvCell(f.refEntity), csvCell(f.refField), csvCell(f.refDisplayField), csvCell(f.relatedBaseProperty), csvCell(f.hide), csvCell(f.hideInDataModeling), csvCell(f.isVoidEnumProp), csvCell(f.hasChild), csvCell(f.isInvalidForParent), csvCell(f.isNotExisted), csvCell(f.enumValue), csvCell(obj.sourceUrl)].join(",") + "\n";
      });
    });

    csv += `\n[${side === "frontend" ? "前端关系" : "后台关系"}]\n`;
    csv += ["源对象","目标对象","源属性","目标属性","关系类型","首次发现","最后发现","来源URL","judgeReason"].join(",") + "\n";

    Object.values(memStore.relations[side]).forEach(r => {
      csv += [csvCell(r.from), csvCell(r.to), csvCell(r.fromProp), csvCell(r.toProp), csvCell(r.type), csvCell(r.firstSeen), csvCell(r.lastSeen), csvCell(r.sourceUrl), csvCell(r.judgeReason)].join(",") + "\n";
    });

    return csv;
  }

  const exportFrontendCSV = () => download(buildSideCSV("frontend"), "开发字典_前端_V18.csv", "text/csv;charset=utf-8");
  const exportBackendCSV = () => download(buildSideCSV("backend"), "开发字典_后台_V18.csv", "text/csv;charset=utf-8");
  const exportAllJSON = () => download(JSON.stringify(memStore, null, 2), "开发字典_V18.json", "application/json;charset=utf-8");

  function clearStore() {
    if (!confirm("确认清空 V18 已抓取的数据？")) return;
    memStore = defaultStore();
    localStorage.removeItem(STORAGE_KEY);
    saveStoreDebounced();
    renderStats();
  }

  function renderStats() {
    const setText = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = String(val); };
    setText("kd18_fc", Object.keys(memStore.catalogs.frontend).length);
    setText("kd18_fo", Object.keys(memStore.objects.frontend).length);
    setText("kd18_fr", Object.keys(memStore.relations.frontend).length);
    setText("kd18_bc", Object.keys(memStore.catalogs.backend).length);
    setText("kd18_bo", Object.keys(memStore.objects.backend).length);
    setText("kd18_br", Object.keys(memStore.relations.backend).length);
    setText("kd18_hits", memStore.hits.length);
    setText("kd18_time", memStore.meta.updatedAt || "-");
  }

  function renderUI() {
    if (uiReady || window.self !== window.top || document.getElementById("kd-dev-ui-v18")) return;
    if (!document.body) { setTimeout(renderUI, 300); return; }

    const ui = document.createElement("div");
    ui.id = "kd-dev-ui-v18";
    ui.style.cssText = "position:fixed; bottom:20px; left:20px; z-index:999999; width:300px; background:#fff; border:2px solid #E91E63; border-radius:10px; padding:12px; box-shadow:0 6px 16px rgba(0,0,0,.18); font-size:12px; color:#333;";
    ui.innerHTML = `
      <div style="font-weight:bold;color:#E91E63;margin-bottom:10px;">金蝶开发字典助手 V18</div>
      <div style="border:1px solid #f3c2d3;border-radius:8px;padding:8px;margin-bottom:8px;"><div style="font-weight:bold;margin-bottom:6px;">前端业务</div><div>目录：<span id="kd18_fc">0</span>　详情：<span id="kd18_fo">0</span>　关系：<span id="kd18_fr">0</span></div></div>
      <div style="border:1px solid #f3c2d3;border-radius:8px;padding:8px;margin-bottom:8px;"><div style="font-weight:bold;margin-bottom:6px;">后台表</div><div>目录：<span id="kd18_bc">0</span>　详情：<span id="kd18_bo">0</span>　关系：<span id="kd18_br">0</span></div></div>
      <div style="margin-bottom:10px;color:#666;">命中：<span id="kd18_hits">0</span><br>更新时间：<span id="kd18_time">-</span></div>
      <button id="kd18_export_front" style="width:100%;margin-bottom:6px;">导出前端 CSV</button>
      <button id="kd18_export_back" style="width:100%;margin-bottom:6px;">导出后台 CSV</button>
      <button id="kd18_export_json" style="width:100%;margin-bottom:6px;">导出完整 JSON</button>
      <button id="kd18_clear" style="width:100%;border:1px dashed #ccc;background:none;color:#666;padding:6px;">清空数据</button>
    `;

    document.body.appendChild(ui);
    document.getElementById("kd18_export_front").onclick = exportFrontendCSV;
    document.getElementById("kd18_export_back").onclick = exportBackendCSV;
    document.getElementById("kd18_export_json").onclick = exportAllJSON;
    document.getElementById("kd18_clear").onclick = clearStore;

    window.addEventListener("storage", () => { memStore = getStore(); renderStats(); });
    renderStats();
    uiReady = true;
  }

  function bootUI() {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", renderUI, { once: true });
      window.addEventListener("load", renderUI, { once: true });
      setTimeout(renderUI, 2000);
    } else {
      setTimeout(renderUI, 800);
    }
  }

  bootUI();

  window.KD_DEV_V18 = { getStore, exportFrontendCSV, exportBackendCSV, exportAllJSON, clearStore };
})();
