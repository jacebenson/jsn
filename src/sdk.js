// ServiceNow REST API client

import { errAuth, errAPI, errNetwork } from './errors.js';
import { getStringField } from './helpers.js';

const DEFAULT_TIMEOUT = 30000;

export class SDKClient {
  constructor(baseURL, authProvider, opts = {}) {
    this.baseURL = baseURL.replace(/\/$/, '');
    this.authProvider = authProvider;
    this.timeout = opts.timeout || DEFAULT_TIMEOUT;
  }

  async _setAuth(req) {
    if (!this.authProvider) {
      throw errAuth('No authentication configured');
    }
    const creds = await this.authProvider.getCredentials();
    if (!creds) {
      throw errAuth('No valid credentials');
    }
    switch (creds.auth_method) {
      case 'basic':
        req.headers.set('Authorization', 'Basic ' + Buffer.from(`${creds.username}:${creds.password}`).toString('base64'));
        break;
      case 'token':
      case 'oauth':
        req.headers.set('Authorization', `Bearer ${creds.access_token}`);
        break;
      default:
        if (creds.username && creds.password) {
          req.headers.set('Authorization', 'Basic ' + Buffer.from(`${creds.username}:${creds.password}`).toString('base64'));
        } else if (creds.access_token) {
          req.headers.set('Authorization', `Bearer ${creds.access_token}`);
        } else {
          throw errAuth('No valid credentials');
        }
    }
  }

  async request(endpoint, opts = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);

    try {
      const req = new Request(endpoint, {
        ...opts,
        signal: controller.signal,
      });
      req.headers.set('Accept', 'application/json');
      if (opts.body && typeof opts.body === 'string') {
        req.headers.set('Content-Type', 'application/json');
      }
      await this._setAuth(req);

      const resp = await fetch(req);
      const body = await resp.text();

      if (!resp.ok) {
        throw errAPI(resp.status, body || resp.statusText);
      }

      if (resp.status === 204 || body === '') {
        return null;
      }

      // Stamp last_seen on successful API call
      try {
        if (this.authProvider && typeof this.authProvider.touchLastSeen === 'function') {
          this.authProvider.touchLastSeen(this.baseURL);
        }
      } catch { /* non-fatal */ }

      return JSON.parse(body);
    } catch (err) {
      if (err.name === 'AbortError') {
        throw errNetwork(new Error('Request timed out'));
      }
      if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND' || err.code === 'ETIMEDOUT') {
        throw errNetwork(err);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  // _fetchWithAuth makes an authenticated fetch and returns the Response object.
  async _fetchWithAuth(endpoint, opts = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);
    try {
      const req = new Request(endpoint, { ...opts, signal: controller.signal });
      await this._setAuth(req);
      return await fetch(req);
    } finally {
      clearTimeout(timer);
    }
  }

  // rawRequest is like request() but returns the response text as-is (no JSON parsing).
  // Used for non-JSON endpoints like sys.scripts.do (returns HTML).
  async rawRequest(endpoint, opts = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);

    try {
      const req = new Request(endpoint, {
        ...opts,
        signal: controller.signal,
      });
      if (opts.body && typeof opts.body === 'string') {
        req.headers.set('Content-Type', opts.headers?.['Content-Type'] || 'application/x-www-form-urlencoded');
      }
      await this._setAuth(req);

      const resp = await fetch(req);
      const body = await resp.text();

      if (!resp.ok) {
        throw errAPI(resp.status, body || resp.statusText);
      }

      return body;
    } catch (err) {
      if (err.name === 'AbortError') {
        throw errNetwork(new Error('Request timed out'));
      }
      if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND' || err.code === 'ETIMEDOUT') {
        throw errNetwork(err);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  async list(table, params = {}) {
    const query = new URLSearchParams(params).toString();
    const endpoint = `${this.baseURL}/api/now/table/${table}${query ? '?' + query : ''}`;
    const result = await this.request(endpoint, { method: 'GET' });
    return result?.result || [];
  }

  async get(table, sysID) {
    const endpoint = `${this.baseURL}/api/now/table/${table}/${sysID}`;
    const result = await this.request(endpoint, { method: 'GET' });
    return result?.result || null;
  }

  async create(table, data) {
    const endpoint = `${this.baseURL}/api/now/table/${table}`;
    const result = await this.request(endpoint, {
      method: 'POST',
      body: JSON.stringify(data),
    });
    return result?.result || null;
  }

  async update(table, sysID, data) {
    const endpoint = `${this.baseURL}/api/now/table/${table}/${sysID}`;
    const result = await this.request(endpoint, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
    return result?.result || null;
  }

  async delete(table, sysID) {
    const endpoint = `${this.baseURL}/api/now/table/${table}/${sysID}`;
    await this.request(endpoint, { method: 'DELETE' });
  }

  async getCurrentUser() {
    const params = new URLSearchParams();
    params.set('sysparm_query', 'user_name=javascript:gs.getUserName()');
    params.set('sysparm_limit', '1');
    params.set('sysparm_display_value', 'all');
    params.set('sysparm_fields', 'sys_id,user_name,name');
    const records = await this.list('sys_user', params);
    if (records.length === 0) return null;
    const r = records[0];
    return {
      sys_id: r.sys_id?.value || r.sys_id,
      user_name: r.user_name?.display_value || r.user_name,
      name: r.name?.display_value || r.name,
    };
  }

  /**
   * Resolve a scope name or sys_id to a sys_id.
   * @param {string} scope - Scope name (e.g. "sn_notif_dashboard") or sys_id
   * @returns {Promise<string|null>} The scope sys_id, or null if not found
   */
  async resolveScope(scope) {
    if (!scope) return null;
    // If it looks like a sys_id (32 hex chars), try it directly
    if (/^[0-9a-fA-F]{32}$/.test(scope)) return scope;

    const params = new URLSearchParams();
    params.set('sysparm_query', `scope=${scope}`);
    params.set('sysparm_limit', '1');
    params.set('sysparm_fields', 'sys_id,name');
    const records = await this.list('sys_scope', params);
    if (records.length === 0) return null;
    return records[0].sys_id?.value || records[0].sys_id;
  }

  async inspectFlow(identifier) {
    const isSysID = identifier.length === 32 && /^[0-9a-fA-F]+$/.test(identifier);

    // 1) Resolve flow
    const flowQuery = new URLSearchParams();
    flowQuery.set('sysparm_display_value', 'all');
    flowQuery.set('sysparm_limit', '1');
    flowQuery.set('sysparm_query', isSysID ? `sys_id=${identifier}` : `name=${identifier}`);
    flowQuery.set('sysparm_fields', 'sys_id,name,active,version,type');

    const flowRecords = await this.list('sys_hub_flow', flowQuery);
    if (!flowRecords || flowRecords.length === 0) {
      const err = new Error(`flow not found: ${identifier}`);
      err.code = 'not_found';
      throw err;
    }

    const flow = flowRecords[0];
    const flowSysID = getStringField(flow, 'sys_id');
    let flowVersion = getStringField(flow, 'version');

    const inspection = {
      flow: {
        name: getStringField(flow, 'name'),
        active: getBoolField(flow, 'active'),
        version: flowVersion,
        type: getStringField(flow, 'type'),
        sysID: flowSysID,
      },
      version: {},
      payload: {},
      triggerInstances: [],
      actionInstances: [],
      flowLogicInstances: [],
      subFlowInstances: [],
      flowInputs: [],
      flowOutputs: [],
    };

    // 2) Fetch latest flow version
    const versionQuery = new URLSearchParams();
    versionQuery.set('sysparm_display_value', 'all');
    versionQuery.set('sysparm_limit', '1');
    versionQuery.set('sysparm_query', `flow=${flowSysID}^ORDERBYDESCsys_updated_on`);
    versionQuery.set('sysparm_fields', 'sys_id,flow,version,payload,sys_updated_on');

    const versionRecords = await this.list('sys_hub_flow_version', versionQuery);
    if (versionRecords && versionRecords.length > 0) {
      inspection.version = versionRecords[0];
      if (!inspection.flow.version) {
        inspection.flow.version = getStringField(versionRecords[0], 'version');
      }

      const payload = getStringField(versionRecords[0], 'payload');
      if (payload) {
        try {
          const payloadData = JSON.parse(payload);
          inspection.payload = payloadData;
          extractPayloadData(inspection, payloadData);
        } catch {
          // ignore parse error
        }
      }
    }

    // 3) Fetch trigger instances
    const triggerQuery = new URLSearchParams();
    triggerQuery.set('sysparm_display_value', 'all');
    triggerQuery.set('sysparm_query', `flow=${flowSysID}`);
    triggerQuery.set('sysparm_fields', 'sys_id,name,trigger_type,display_text,active,trigger_definition');
    triggerQuery.set('sysparm_limit', '20');
    const triggerRecords = await this.list('sys_hub_trigger_instance', triggerQuery);
    if (triggerRecords) {
      inspection.triggerInstances = triggerRecords;
    }

    // 4) Fallbacks when payload did not provide structure arrays
    if (!inspection.actionInstances || inspection.actionInstances.length === 0) {
      const actionQuery = new URLSearchParams();
      actionQuery.set('sysparm_display_value', 'all');
      actionQuery.set('sysparm_query', `flow=${flowSysID}^ORDERBYorder`);
      actionQuery.set('sysparm_fields', 'sys_id,order,name,display_text,comment,action_type');
      actionQuery.set('sysparm_limit', '200');
      const records = await this.list('sys_hub_action_instance', actionQuery);
      if (records) inspection.actionInstances = records;
    }

    if (!inspection.flowLogicInstances || inspection.flowLogicInstances.length === 0) {
      const logicTables = ['sys_hub_flow_logic', 'sys_hub_flow_logic_instance_v2'];
      for (const table of logicTables) {
        const logicQuery = new URLSearchParams();
        logicQuery.set('sysparm_display_value', 'all');
        logicQuery.set('sysparm_query', `flow=${flowSysID}^ORDERBYorder`);
        logicQuery.set('sysparm_fields', 'sys_id,order,name,display_text,comment,parent_ui_id,logic_definition');
        logicQuery.set('sysparm_limit', '200');
        const records = await this.list(table, logicQuery);
        if (records) inspection.flowLogicInstances.push(...records);
      }
      inspection.flowLogicInstances.sort((a, b) => parseOrderField(a) - parseOrderField(b));
    }

    if (!inspection.subFlowInstances || inspection.subFlowInstances.length === 0) {
      const subflowQuery = new URLSearchParams();
      subflowQuery.set('sysparm_display_value', 'all');
      subflowQuery.set('sysparm_query', `flow=${flowSysID}^ORDERBYorder`);
      subflowQuery.set('sysparm_fields', 'sys_id,order,subflow,name,display_text,comment,parent_ui_id');
      subflowQuery.set('sysparm_limit', '200');
      const records = await this.list('sys_hub_sub_flow_instance', subflowQuery);
      if (records) inspection.subFlowInstances = records;
    }

    // Inputs/Outputs fallback
    if (!inspection.flowInputs || inspection.flowInputs.length === 0) {
      const inputsQuery = new URLSearchParams();
      inputsQuery.set('sysparm_display_value', 'all');
      inputsQuery.set('sysparm_query', `model=${flowSysID}^ORDERBYorder`);
      inputsQuery.set('sysparm_fields', 'sys_id,name,label,type,mandatory,order');
      inputsQuery.set('sysparm_limit', '200');
      const records = await this.list('sys_hub_flow_input', inputsQuery);
      if (records) inspection.flowInputs = records;
    }

    if (!inspection.flowOutputs || inspection.flowOutputs.length === 0) {
      const outputsQuery = new URLSearchParams();
      outputsQuery.set('sysparm_display_value', 'all');
      outputsQuery.set('sysparm_query', `model=${flowSysID}^ORDERBYorder`);
      outputsQuery.set('sysparm_fields', 'sys_id,name,label,type,order');
      outputsQuery.set('sysparm_limit', '200');
      const records = await this.list('sys_hub_flow_output', outputsQuery);
      if (records) inspection.flowOutputs = records;
    }

    return inspection;
  }

  async aggregateCount(table, queryStr) {
    const params = new URLSearchParams();
    params.set('sysparm_count', 'true');
    if (queryStr) params.set('sysparm_query', queryStr);
    const endpoint = `${this.baseURL}/api/now/stats/${table}?${params.toString()}`;
    const result = await this.request(endpoint, { method: 'GET' });
    const stats = result?.result?.stats;
    if (!stats) return 0;

    let statsMap = stats;
    if (typeof stats === 'string') {
      try { statsMap = JSON.parse(stats); } catch { return 0; }
    }

    if (statsMap.count != null) {
      const v = statsMap.count;
      if (typeof v === 'number') return v;
      if (typeof v === 'string') {
        const n = parseInt(v, 10);
        return isNaN(n) ? 0 : n;
      }
    }

    for (const value of Object.values(statsMap)) {
      if (value && typeof value === 'object' && value.count != null) {
        const v = value.count;
        if (typeof v === 'number') return v;
        if (typeof v === 'string') {
          const n = parseInt(v, 10);
          return isNaN(n) ? 0 : n;
        }
      }
    }

    return 0;
  }

  // ─── Background Script Execution (3-step OAuth session flow) ───

  /**
   * Execute a background script on the ServiceNow instance via sys.scripts.do.
   * Uses a 3-step session-establishment flow compatible with OAuth tokens:
   *  1. Make a REST API call to get session cookies
   *  2. GET /sys.scripts.do with cookies to extract the CSRF token (sysparm_ck)
   *  3. POST /sys.scripts.do with the script, CSRF token, and cookies
   *
   * @param {string} script - JavaScript code to execute
   * @returns {Promise<string>} The script's output text
   */
  async executeScript(script, scope) {
    // Step 1: Warm up the session by hitting any REST API — this makes
    // ServiceNow issue session cookies for subsequent UI page requests.
    // We capture cookies to forward them (Node.js fetch() has no built-in cookie jar).
    const cookies = await this._warmSession();

    // Step 2: GET /sys.scripts.do to extract the CSRF token from the HTML form.
    const csrfToken = await this._getScriptsPageCSRF(cookies);

    // Step 3: POST the script with form data including the CSRF token.
    const endpoint = `${this.baseURL}/sys.scripts.do`;
    const formBody = new URLSearchParams();
    formBody.set('script', script);
    formBody.set('sysparm_ck', csrfToken);
    formBody.set('runscript', 'Run script');
    formBody.set('sys_scope', scope || 'global');
    formBody.set('record_for_rollback', 'on');
    formBody.set('quota_managed_transaction', 'on');

    const html = await this.rawRequest(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        ...(cookies ? { Cookie: cookies } : {}),
      },
      body: formBody.toString(),
    });

    return this._extractScriptOutput(html);
  }

  /**
   * Fetch a record and related data from multiple tables.
   * @param {string} table - Table to query
   * @param {URLSearchParams} params - Query params for the main record
   * @param {Array<{table: string, queryField: string, queryValue: string, fields: string[], displayAs: string}>} related - Related tables to fetch
   * @returns {Promise<{_record: object, [key: string]: any}>}
   */
  async recordWithRelated(table, params, related) {
    const records = await this.list(table, params);
    if (records.length === 0) throw new Error('Record not found');

    const result = { _record: records[0] };

    for (const rel of related) {
      try {
        const relParams = new URLSearchParams();
        relParams.set('sysparm_display_value', 'all');
        relParams.set('sysparm_fields', (rel.fields || []).join(','));
        relParams.set('sysparm_query', `${rel.queryField}=${rel.queryValue}`);
        relParams.set('sysparm_limit', '100');
        result[rel.displayAs] = await this.list(rel.table, relParams);
      } catch {
        result[rel.displayAs] = [];
      }
    }

    return result;
  }

  /**
   * Fetch attachments for a record.
   * @param {string} tableName - Table name (e.g. sc_req_item)
   * @param {string} tableSysID - Sys ID of the record
   * @returns {Promise<Array>}
   */
  async fetchAttachments(tableName, tableSysID) {
    const params = new URLSearchParams();
    params.set('sysparm_display_value', 'all');
    params.set('sysparm_fields', 'sys_id,file_name,sys_created_on,sys_created_by');
    params.set('sysparm_query', `table_name=${tableName}^table_sys_id=${tableSysID}`);
    return this.list('sys_attachment', params);
  }

  /**
   * Fetch catalog variables for a request item (RITM).
   * @param {string} ritmSysID - Sys ID of the request item
   * @returns {Promise<Array<{question: string, value: string}>>}
   */
  async fetchCatalogVariables(ritmSysID) {
    const params = new URLSearchParams();
    params.set('sysparm_display_value', 'all');
    params.set('sysparm_fields', 'item_option_new,value');
    params.set('sysparm_query', `request_item=${ritmSysID}`);
    params.set('sysparm_limit', '100');

    const optRecords = await this.list('sc_item_option', params);
    const variables = [];

    for (const opt of optRecords) {
      let question = '';
      if (opt.item_option_new && typeof opt.item_option_new === 'object') {
        question = opt.item_option_new.display_value || '';
      }

      let value = '';
      if (opt.value && typeof opt.value === 'object') {
        value = opt.value.display_value || opt.value.value || '';
      } else if (typeof opt.value === 'string') {
        value = opt.value;
      }

      if (question) {
        variables.push({ question, value });
      }
    }

    return variables;
  }

  async _warmSession() {
    try {
      const endpoint = `${this.baseURL}/api/now/table/sys_user?sysparm_limit=1`;
      const resp = await this._fetchWithAuth(endpoint, { method: 'GET', headers: { Accept: 'application/json' } });
      // Extract cookies for subsequent UI page requests
      const setCookie = resp.headers.getSetCookie?.() || resp.headers.get('set-cookie');
      if (setCookie) {
        return Array.isArray(setCookie) ? setCookie.join('; ') : setCookie;
      }
      return '';
    } catch {
      return '';
    }
  }

  async _getScriptsPageCSRF(cookies) {
    const endpoint = `${this.baseURL}/sys.scripts.do`;
    const html = await this.rawRequest(endpoint, {
      method: 'GET',
      headers: cookies ? { Cookie: cookies } : {},
    });

    // Extract <input name="sysparm_ck" type="hidden" value="TOKEN"> from HTML
    const marker = '<input name="sysparm_ck" type="hidden" value="';
    const idx = html.indexOf(marker);
    if (idx !== -1) {
      const start = idx + marker.length;
      const end = html.indexOf('"', start);
      if (end !== -1) return html.substring(start, end);
      const altEnd = html.indexOf('">', start);
      if (altEnd !== -1) return html.substring(start, altEnd);
    }

    // Fallback: try without type attribute
    const altMarker = 'name="sysparm_ck" value="';
    const altIdx = html.indexOf(altMarker);
    if (altIdx !== -1) {
      const start = altIdx + altMarker.length;
      const end = html.indexOf('"', start);
      if (end !== -1) return html.substring(start, end);
    }

    // Not authorized or couldn't extract token
    if (html.includes('not authorized') || html.includes('login.do')) {
      throw new Error('Not authorized to access scripts page. Your OAuth token may not support UI sessions. Try the browser: ' + this.baseURL + '/sys.scripts.do');
    }
    throw new Error('Could not find CSRF token on scripts page (response: ' + html.substring(0, 200) + ')');
  }

  _extractScriptOutput(html) {
    // Convert <BR> and <BR/> to newlines first
    let out = html.replace(/<BR\s*\/?>/gi, '\n').replace(/<br\s*\/?>/gi, '\n');

    // Find <PRE>...</PRE> content
    const preMatch = out.match(/<PRE[^>]*>([\s\S]*?)<\/PRE>/i);
    if (preMatch) {
      out = preMatch[1];
    }

    // Strip remaining HTML tags
    out = out.replace(/<[^>]+>/g, '');

    // Clean up: decode HTML entities, trim lines
    out = out.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');

    // Trim each line and remove empty lines
    const lines = out.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    return lines.join('\n');
  }
}

function getBoolField(record, field) {
  const val = record?.[field];
  if (val == null) return false;
  if (typeof val === 'boolean') return val;
  if (typeof val === 'string') return val === 'true' || val === '1';
  if (typeof val === 'object') {
    const dv = val.display_value;
    if (dv != null) return String(dv) === 'true' || String(dv) === '1';
    const v = val.value;
    if (v != null) return String(v) === 'true' || String(v) === '1';
  }
  return false;
}

function extractPayloadData(inspection, payload) {
  const actions = toMapSlice(payload.actionInstances);
  if (actions) inspection.actionInstances = actions;

  const logic = toMapSlice(payload.flowLogicInstances);
  if (logic) inspection.flowLogicInstances = logic;

  const subflows = toMapSlice(payload.subFlowInstances);
  if (subflows) inspection.subFlowInstances = subflows;

  const inputs = toMapSlice(payload.inputs);
  if (inputs) inspection.flowInputs = inputs;

  const outputs = toMapSlice(payload.outputs);
  if (outputs) inspection.flowOutputs = outputs;

  const triggerInstances = payload.triggerInstances;
  if (!Array.isArray(triggerInstances) || triggerInstances.length === 0) return;

  const first = triggerInstances[0];
  if (!first || typeof first !== 'object') return;

  if (!inspection.version || typeof inspection.version !== 'object') {
    inspection.version = {};
  }

  const triggerName = getStringField(first, 'name');
  if (triggerName) inspection.version.trigger_name = triggerName;

  const triggerType = getStringField(first, 'type');
  if (triggerType) inspection.version.trigger_type = triggerType;

  if (Array.isArray(first.inputs)) {
    for (const input of first.inputs) {
      if (!input || typeof input !== 'object') continue;
      const name = getStringField(input, 'name');
      const value = getStringField(input, 'value');
      if (name === 'table' && value) inspection.version.trigger_table = value;
      if (name === 'time' && value) inspection.version.trigger_time = value;
    }
  }
}

function toMapSlice(v) {
  if (!Array.isArray(v)) return null;
  return v.filter(item => item && typeof item === 'object');
}

function parseOrderField(record) {
  const order = getStringField(record, 'order');
  const n = parseInt(order, 10);
  return isNaN(n) ? 0 : n;
}
