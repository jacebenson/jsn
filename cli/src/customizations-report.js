import fs from 'node:fs';
import path from 'node:path';

const CLASSIFICATIONS = {
  ootb_modifications: {
    label: 'Historical upgrade skip',
    confidence: 'Historical evidence only',
    summary: 'An upgrade record says the platform preserved this artifact. That does not prove it currently differs from the vendor version.',
    next_steps: [
      'Compare the current artifact with a trusted baseline for this exact release.',
      'Review later update-set history for a merge, reversion, or further edit.',
      'Check callers and add a regression test in non-production before considering a revert.',
    ],
  },
  customer_app_artifacts: {
    label: 'Caller-declared customer scope',
    confidence: 'Declaration, not verified ownership',
    summary: 'The scope record matched a scope declared by the person who captured this report. The instance does not verify customer or publisher ownership.',
    next_steps: [
      'Confirm the application owner and publisher with the responsible team.',
      'Check whether the artifact is active or referenced, then review its tests and update-set history.',
      'Treat it as customer-owned only after an owner confirms the declaration.',
    ],
  },
  unclassified: {
    label: 'Unclassified metadata',
    confidence: 'Insufficient evidence',
    summary: 'Visible metadata was found, but this capture could not establish whether it is customer-owned or differs from an out-of-box artifact.',
    next_steps: [
      'Identify the owner using application records, update-set history, and team knowledge.',
      'Check current references and expected behavior before changing or deleting it.',
      'Compare with a trusted vendor baseline only when evidence shows this is vendor-delivered.',
    ],
  },
};

const humanize = value => String(value || '').replace(/^sys_/, '').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').replace(/([a-z0-9])([A-Z])/g, '$1 $2').replaceAll('_', ' ').replace(/\bui\b/gi, 'UI').replace(/\b[a-z]/g, letter => letter.toUpperCase());
const categoryLabel = category => ({ ootb_modifications: 'Historical upgrade skips', customer_app_artifacts: 'Declared customer scopes', unclassified: 'Unclassified metadata' })[category] || humanize(category);
const itemName = item => {
  const { name = '', update_name: updateName = '', table = '', sys_id: sysId = '' } = item.identity || {};
  if (name && name !== sysId && name !== updateName) return /[_]|[a-z][A-Z]/.test(name) ? humanize(name) : name;
  if (updateName) {
    const prefixes = [table, table.replace(/_[^_]+$/, ''), table.replace(/_[^_]+_[^_]+$/, '')].filter(Boolean);
    const prefix = prefixes.find(candidate => updateName.startsWith(`${candidate}_`));
    return humanize(prefix ? updateName.slice(prefix.length + 1) : updateName) || 'Name unavailable';
  }
  return sysId ? 'Name unavailable' : 'Unnamed artifact';
};

export function classifyCustomization(category) {
  const classification = CLASSIFICATIONS[category] || CLASSIFICATIONS.unclassified;
  return {
    code: CLASSIFICATIONS[category] ? category : 'unclassified',
    label: classification.label,
    confidence: classification.confidence,
    summary: classification.summary,
    next_steps: [...classification.next_steps],
    // There is no verified baseline or dependency graph to support safe automatic remediation.
    automated_remediation: false,
  };
}

function recordUrl(instance, table, sysId) {
  if (!/^[a-z0-9_]+$/i.test(String(table || '')) || !sysId) return null;
  try {
    const url = new URL(`${encodeURIComponent(table)}.do`, `${String(instance).replace(/\/+$/, '')}/`);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    url.searchParams.set('sys_id', String(sysId));
    return url.href;
  } catch {
    return null;
  }
}

export function buildActionableReport(report) {
  const artifacts = Object.entries(report.categories || {}).flatMap(([category, items]) => items.map(item => ({
    category,
    category_label: categoryLabel(category),
    identity: item.identity || {},
    name: itemName(item),
    table_label: humanize(item.identity?.table || 'unknown'),
    scope: item.scope?.scope || item.scope?.sys_id || '(unknown scope)',
    updated_by: item.identity?.updated_by || '(unknown updater)',
    evidence: item.evidence || [],
    risk: item.risk || { rating: 'unknown', rationale: 'Risk has not been established.' },
    triage: classifyCustomization(category),
    record_url: recordUrl(report.instance, item.identity?.table, item.identity?.sys_id),
  })));
  return {
    run_id: report.run_id,
    label: report.label || '',
    instance: report.instance,
    status: report.status,
    start_time: report.start_time,
    artifacts,
    coverage: report.coverage,
  };
}

const safeJson = value => JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, character => ({ '<': '\\u003c', '>': '\\u003e', '&': '\\u0026', '\u2028': '\\u2028', '\u2029': '\\u2029' })[character]);
const escapeHtml = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');

export function renderCustomizationHtml(report) {
  const view = buildActionableReport(report);
  const categoryOptions = [...new Set(view.artifacts.map(item => item.category))].map(category => `<option value="${escapeHtml(category)}">${escapeHtml(categoryLabel(category))}</option>`).join('');
  const data = safeJson(view);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Customization review${view.label ? `: ${escapeHtml(view.label)}` : ''}</title>
<style>
:root{color-scheme:light;--ink:#202833;--muted:#526173;--line:#d8dee7;--panel:#fff;--wash:#f3f6fa;--blue:#1358a5;--amber:#825300}*{box-sizing:border-box}body{margin:0;background:var(--wash);color:var(--ink);font:16px/1.5 system-ui,sans-serif}main{max-width:1180px;margin:auto;padding:32px 20px 60px}h1,h2,h3,p{margin-top:0}h1{font-size:1.8rem;margin-bottom:4px}h2{font-size:1.25rem;margin:0 0 14px}h3{font-size:1.1rem;margin:0}small,.muted{color:var(--muted)}.intro,.toolbar,.coverage,.group,.card{background:var(--panel);border:1px solid var(--line);border-radius:10px}.intro,.toolbar,.coverage{padding:18px 20px;margin-bottom:16px}.intro p:last-child{margin-bottom:0}.stats{display:flex;flex-wrap:wrap;gap:10px;margin-top:14px}.stat{background:var(--wash);border-radius:8px;padding:10px 14px}.toolbar{display:flex;flex-wrap:wrap;gap:12px;align-items:end;position:sticky;top:0;z-index:2}.control{display:grid;gap:4px}.control.grow{flex:1;min-width:220px}input,select{font:inherit;padding:8px 10px;border:1px solid #aeb9c7;border-radius:6px;background:white;color:var(--ink)}.group{padding:18px;margin:16px 0}.group>h2{border-bottom:1px solid var(--line);padding-bottom:10px}.card{padding:16px;margin:12px 0}.card-head{display:flex;gap:12px;align-items:flex-start;justify-content:space-between}.badge{display:inline-block;border-radius:100px;background:#e9f0fb;color:#183e71;padding:3px 9px;font-size:.83rem;font-weight:650}.confidence{color:var(--amber);font-size:.9rem;font-weight:650}.meta{display:flex;gap:8px 16px;flex-wrap:wrap;margin:10px 0;color:var(--muted);font-size:.92rem}.card h4{margin:12px 0 4px}.card ul{margin:4px 0 12px;padding-left:22px}.card a{color:var(--blue)}.coverage summary{cursor:pointer;font-weight:650}.coverage li{margin:6px 0}.empty{padding:20px;text-align:center;color:var(--muted)}.notice{border-left:4px solid #d39219;padding:8px 12px;background:#fff7e6;margin:12px 0}
</style>
</head>
<body><main>
<header class="intro"><h1>Customization review</h1><p>${escapeHtml(view.label || view.run_id)} · ${escapeHtml(view.instance)}</p><p class="muted">Status: ${escapeHtml(view.status)}. This report gives review steps, not automatic fixes. Confirm evidence before changing records.</p><div class="stats" id="stats"></div><p class="notice">A historical upgrade skip does not prove a current difference. A scope or updater name does not prove ownership. The broad metadata source is a bounded sample.</p></header>
<section class="toolbar" aria-label="Report filters"><label class="control grow">Search artifacts<input id="search" type="search" placeholder="Name, table, scope, updater, evidence"></label><label class="control">Classification<select id="category"><option value="">All classifications</option>${categoryOptions}</select></label><label class="control">Group by<select id="group-by"><option value="type">File type</option><option value="scope">Scope</option><option value="updated_by">Updated by</option></select></label></section>
<section id="results" aria-live="polite"></section>
<details class="coverage"><summary>Capture coverage and limitations</summary><div id="coverage-content"></div></details>
<script id="report-data" type="application/json">${data}</script>
<script>
'use strict';
const report=JSON.parse(document.getElementById('report-data').textContent);
const results=document.getElementById('results');
const search=document.getElementById('search');
const category=document.getElementById('category');
const groupBy=document.getElementById('group-by');
const el=(tag,text,className='')=>{const node=document.createElement(tag);if(text!==undefined)node.textContent=text;if(className)node.className=className;return node;};
const groupName=item=>groupBy.value==='scope'?item.scope:groupBy.value==='updated_by'?item.updated_by:item.table_label;
const addList=(parent,title,items)=>{parent.append(el('h4',title));const ul=el('ul');for(const text of items)ul.append(el('li',text));parent.append(ul);};
function card(item){
 const article=el('article',undefined,'card');const head=el('div',undefined,'card-head');const title=el('h3',item.name);head.append(title,el('span',item.triage.confidence,'confidence'));article.append(head);
 article.append(el('p',item.triage.summary));const meta=el('div',undefined,'meta');meta.append(el('span',item.table_label+' · '+(item.identity.sys_id||'ID unavailable')),el('span','Scope: '+item.scope),el('span','Updated by: '+item.updated_by));article.append(meta,el('span',item.category_label,'badge'));
 addList(article,'Evidence',item.evidence.length?item.evidence.map(e=>e.source+': '+e.sys_id+'. '+e.basis):['No artifact evidence was captured.']);addList(article,'Next steps',item.triage.next_steps);article.append(el('p','Risk: '+(item.risk.rating||'unknown')+'. '+(item.risk.rationale||'Not established.')));
 if(item.record_url){const link=el('a','Open record in ServiceNow');link.href=item.record_url;link.rel='noopener noreferrer';link.target='_blank';article.append(link);}return article;
}
function render(){
 const term=search.value.trim().toLowerCase();const selected=category.value;
 const filtered=report.artifacts.filter(item=>(!selected||item.category===selected)&&(!term||JSON.stringify(item).toLowerCase().includes(term)));
 results.replaceChildren();if(!filtered.length){results.append(el('p','No artifacts match these filters.','empty'));return;}
 const groups=new Map();for(const item of filtered){const key=groupName(item);if(!groups.has(key))groups.set(key,[]);groups.get(key).push(item);}
 for(const [name,items] of [...groups].sort(([a],[b])=>a.localeCompare(b))){const section=el('section',undefined,'group');section.append(el('h2',name+' ('+items.length+')'));for(const item of items)section.append(card(item));results.append(section);}
}
for(const [categoryName,items] of Object.entries(report.artifacts.reduce((groups,item)=>{groups[item.category]=(groups[item.category]||0)+1;return groups;},{})))document.getElementById('stats').append(el('span',categoryName.replaceAll('_',' ')+': '+items,'stat'));
search.addEventListener('input',render);category.addEventListener('change',render);groupBy.addEventListener('change',render);render();
const coverage=document.getElementById('coverage-content');const ul=el('ul');for(const [source,details] of Object.entries(report.coverage.sources||{})){ul.append(el('li',source+': '+details.status+', '+details.fetched+'/'+(details.available??'unknown')+' rows. '+details.reason));}coverage.append(ul);for(const note of report.coverage.limitations||[])coverage.append(el('p',note));
</script>
</main></body></html>\n`;
}

export function writeCustomizationHtml(report, { out } = {}) {
  const runId = String(report.run_id || 'capture').replace(/[^a-zA-Z0-9_-]/g, '_');
  const target = path.resolve(out || path.join(process.cwd(), `customizations-${runId}.html`));
  fs.writeFileSync(target, renderCustomizationHtml(report), { mode: 0o600, flag: 'wx' });
  return target;
}
