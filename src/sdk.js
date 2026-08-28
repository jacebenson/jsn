// ServiceNow REST API client

import { gunzipSync } from 'node:zlib';
import { errAuth, errAPI, errNetwork } from './errors.js';
import { getStringField } from './helpers.js';

const DEFAULT_TIMEOUT = 30000;

// Build the sys.scripts.do POST body for background script execution.
// Extracted for testability (issue #177): maps script-mode options to the
// form fields on ServiceNow's Script Background form. Defaults preserve the
// historical behavior (rollback recording on, quota-managed transaction on).
export function buildScriptFormBody({ script, csrf, scope, rollback = true, quotaManagedTransaction = true, sandbox = false, scriptlet = false }) {
  const formBody = new URLSearchParams();
  formBody.set('script', script);
  formBody.set('sysparm_ck', csrf);
  formBody.set('runscript', 'Run script');
  formBody.set('sys_scope', scope || 'global');
  if (rollback) formBody.set('record_for_rollback', 'on');
  if (quotaManagedTransaction) formBody.set('quota_managed_transaction', 'on');
  if (sandbox) formBody.set('sandbox', 'on');
  if (scriptlet) formBody.set('scriptlet', 'on');
  return formBody;
}

export class SDKClient {
  constructor(baseURL, authProvider, opts = {}) {
    this.baseURL = baseURL.replace(/\/$/, '');
    this.authProvider = authProvider;
    this.timeout = opts.timeout || DEFAULT_TIMEOUT;
    this.domain = opts.domain || '';
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
      case 'gck':
        req.headers.set('X-UserToken', creds.access_token);
        if (creds.cookies) req.headers.set('Cookie', creds.cookies);
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
    const { timeout = this.timeout, ...requestOptions } = opts;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
      const req = new Request(endpoint, {
        ...requestOptions,
        signal: controller.signal,
      });
      req.headers.set('Accept', 'application/json');
      if (requestOptions.body && typeof requestOptions.body === 'string') {
        req.headers.set('Content-Type', 'application/json');
      }
      if (this.domain) {
        req.headers.set('X-Now-Domain', this.domain);
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

  // ─── Attachments ───

  /**
   * List attachments on a record.
   * @param {string} sysID - record sys_id
   * @returns {Promise<Array>} attachment metadata rows
   */
  async listAttachments(sysID) {
    const params = new URLSearchParams();
    params.set('sysparm_query', `table_sys_id=${sysID}`);
    params.set('sysparm_display_value', 'all');
    params.set('sysparm_fields', 'sys_id,file_name,size_bytes,content_type,sys_created_by,sys_created_on');
    const endpoint = `${this.baseURL}/api/now/attachment?${params.toString()}`;
    const result = await this.request(endpoint, { method: 'GET' });
    return result?.result || [];
  }

  /**
   * Download an attachment's file contents as a Buffer.
   * @param {string} sysID - attachment sys_id
   * @returns {Promise<Buffer>}
   */
  async getAttachment(sysID) {
    const endpoint = `${this.baseURL}/api/now/attachment/${sysID}/file`;
    const resp = await this._fetchWithAuth(endpoint, { method: 'GET', headers: { Accept: 'application/octet-stream' } });
    if (!resp.ok) {
      throw errAPI(resp.status, String(resp.statusText));
    }
    const buf = Buffer.from(await resp.arrayBuffer());
    return buf;
  }

  /**
   * Upload a file as a new attachment on a record.
   * @param {string} table - parent table name (e.g. 'incident')
   * @param {string} sysID - parent record sys_id
   * @param {Buffer|string} content - file bytes or path
   * @param {string} fileName - display file name
   * @returns {Promise<object>} created attachment row
   */
  async addAttachment(table, sysID, content, fileName) {
    const form = new FormData();
    const blob = Buffer.isBuffer(content) ? new Blob([content]) : new Blob([String(content)]);
    form.append('file', blob, fileName);
    const endpoint = `${this.baseURL}/api/now/attachment?table_name=${encodeURIComponent(table)}&table_sys_id=${encodeURIComponent(sysID)}`;
    const result = await this.request(endpoint, { method: 'POST', body: form });
    return result?.result || null;
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
      flowVariables: [],
    };

    // 2) Prefer the ProcessFlow API — the Flow Designer UI's own source.
    //    Returns complete structure for both V2 and legacy V1 flows (the
    //    version payload field is empty for V1 flows).
    let payloadLoaded = false;
    try {
      const pfResponse = await this.request(`${this.baseURL}/api/now/processflow/flow/${flowSysID}`, { method: 'GET' });
      const pfData = pfResponse?.result?.data;
      if (isUsableFlowPayload(pfData) && !pfResponse?.result?.errorMessage) {
        inspection.payload = pfData;
        if (!inspection.flow.version) {
          const pfVersion = getStringField(pfData, 'version');
          if (pfVersion) inspection.flow.version = pfVersion;
        }
        hydrateFlowBlocks(inspection.payload);
        extractPayloadData(inspection, inspection.payload);
        payloadLoaded = true;
      }
    } catch {
      // ProcessFlow API may not exist on older instances — fall through
    }

    // 2b) Fallback: latest flow version payload
    if (!payloadLoaded) {
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
            if (isUsableFlowPayload(payloadData)) {
              inspection.payload = payloadData;
              extractPayloadData(inspection, payloadData);
            }
          } catch {
            // ignore parse error
          }
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
      const logicTables = [
        { table: 'sys_hub_flow_logic', payloadField: 'inputs' },
        { table: 'sys_hub_flow_logic_instance_v2', payloadField: 'values' },
      ];
      for (const { table, payloadField } of logicTables) {
        const logicQuery = new URLSearchParams();
        logicQuery.set('sysparm_display_value', 'all');
        logicQuery.set('sysparm_query', `flow=${flowSysID}^ORDERBYorder`);
        logicQuery.set('sysparm_fields', `sys_id,order,name,display_text,comment,parent_ui_id,logic_definition,${payloadField}`);
        logicQuery.set('sysparm_limit', '200');
        const records = await this.list(table, logicQuery);
        if (records) {
          for (const rec of records) {
            const decoded = decodeGzipJson(rec[payloadField]);
            if (decoded) rec._decodedValues = decoded;
          }
          inspection.flowLogicInstances.push(...records);
        }
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

    // Flow variables fallback (payload.flowVariables may be empty on legacy
    // payload shapes, but sys_hub_flow_variable rows exist for every flow).
    // Note: the table only carries name/label/order — type is empty there, so
    // prefer payload.flowVariables when available.
    if (!inspection.flowVariables || inspection.flowVariables.length === 0) {
      const varsQuery = new URLSearchParams();
      varsQuery.set('sysparm_display_value', 'all');
      varsQuery.set('sysparm_query', `model=${flowSysID}^ORDERBYorder`);
      varsQuery.set('sysparm_fields', 'sys_id,name,label,type,order');
      varsQuery.set('sysparm_limit', '200');
      const records = await this.list('sys_hub_flow_variable', varsQuery);
      if (records) inspection.flowVariables = records;
    }

    await this._loadFlowCatalogRecords(inspection);
    return inspection;
  }

  async _loadFlowCatalogRecords(inspection) {
    const refs = new Map();
    const tokenRe = /([0-9a-f]{32}):([a-z_]+)/g;
    const addInputs = inputs => {
      if (!Array.isArray(inputs)) return;
      for (const input of inputs) {
        const value = getStringField(input, 'displayValue') || getStringField(input, 'value');
        for (const [, id, table] of String(value).matchAll(tokenRe)) {
          if (!refs.has(`${table}:${id}`)) refs.set(`${table}:${id}`, { id, table });
        }
      }
    };
    const walk = items => {
      if (!Array.isArray(items)) return;
      for (const item of items) {
        addInputs(item?.inputs);
        walk(item?.flowBlock);
      }
    };
    walk(inspection.actionInstances);
    walk(inspection.flowLogicInstances);
    for (const logic of inspection.flowLogicInstances) addInputs(logic?._decodedValues?.inputs);
    Object.defineProperty(inspection, 'catalogRecords', {
      value: [],
      enumerable: false,
      configurable: true,
      writable: true,
    });
    for (const { id, table } of refs.values()) {
      try {
        const params = new URLSearchParams({ sysparm_query: `sys_id=${id}`, sysparm_fields: 'sys_id,name,question_text', sysparm_display_value: 'all', sysparm_limit: '1' });
        const record = (await this.list(table, params))[0];
        if (record) inspection.catalogRecords.push({ ...record, table });
      } catch {
        // Catalog labels are optional enrichment.
      }
    }
  }

  /**
   * Resolve a custom action and return its internal step instances.
   * The action reference on sys_hub_step_instance points at the shared
   * Action Type Base, so the action definition sys_id is the query value.
   *
   * @param {string} identifier - action name or sys_id
   * @returns {Promise<{action: object, steps: object[]}|null>}
   */
  async inspectCustomAction(identifier) {
    if (!identifier) return null;
    const isSysID = /^[0-9a-fA-F]{32}$/.test(String(identifier));
    const actionQuery = new URLSearchParams();
    actionQuery.set('sysparm_display_value', 'all');
    actionQuery.set('sysparm_limit', '1');
    actionQuery.set('sysparm_query', isSysID ? `sys_id=${identifier}` : `name=${identifier}`);
    actionQuery.set('sysparm_fields', 'sys_id,name,master_snapshot,latest_snapshot,state,active');

    const actions = await this.list('sys_hub_action_type_definition', actionQuery);
    if (!actions || actions.length === 0) return null;

    const action = actions[0];
    const actionSysID = getStringField(action, 'sys_id');
    if (!actionSysID) return null;

    const stepQuery = new URLSearchParams();
    stepQuery.set('sysparm_display_value', 'all');
    stepQuery.set('sysparm_query', `action=${actionSysID}^ORDERBYorder`);
    stepQuery.set('sysparm_fields', 'sys_id,label,action,step_type,order,section,inputs,outputs,extended_inputs,extended_outputs,error_handling_type');
    stepQuery.set('sysparm_limit', '200');
    const steps = await this.list('sys_hub_step_instance', stepQuery);

    return { action, steps: steps || [] };
  }

  async aggregateCount(table, queryStr, options = {}) {
    const params = new URLSearchParams();
    params.set('sysparm_count', 'true');
    if (queryStr) params.set('sysparm_query', queryStr);
    const endpoint = `${this.baseURL}/api/now/stats/${table}?${params.toString()}`;
    const result = await this.request(endpoint, {
      method: 'GET',
      ...(options.timeout ? { timeout: options.timeout } : {}),
    });
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

  async aggregate(table, options = {}) {
    const params = new URLSearchParams();
    const fields = (value) => Array.isArray(value) ? value.filter(Boolean).join(',') : String(value || '');
    const groupBy = fields(options.groupBy);
    const orderBy = fields(options.orderBy);

    if (options.query) params.set('sysparm_query', options.query);
    if (options.count !== false) params.set('sysparm_count', 'true');
    if (groupBy) params.set('sysparm_group_by', groupBy);
    if (fields(options.averageFields)) params.set('sysparm_avg_fields', fields(options.averageFields));
    if (fields(options.sumFields)) params.set('sysparm_sum_fields', fields(options.sumFields));
    if (fields(options.minimumFields)) params.set('sysparm_min_fields', fields(options.minimumFields));
    if (fields(options.maximumFields)) params.set('sysparm_max_fields', fields(options.maximumFields));
    if (orderBy) params.set('sysparm_order_by', orderBy);

    const endpoint = `${this.baseURL}/api/now/stats/${table}?${params.toString()}`;
    const result = await this.request(endpoint, { method: 'GET' });
    const payload = result?.result || {};
    const numericKeys = Object.keys(payload).filter(key => /^\d+$/.test(key));
    if (numericKeys.length > 0 && numericKeys.length === Object.keys(payload).length) {
      return { groups: numericKeys.sort((a, b) => Number(a) - Number(b)).map(key => payload[key]) };
    }
    return payload;
  }


  /**
   * Export an update set to XML via the fluent export endpoint.
   * Same session dance as executeScript: warm the session for cookies,
   * grab the CSRF token from sys.scripts.do, then GET the export endpoint.
   *
   * @param {string} updateSetSysId - sys_id of the sys_update_set record
   * @param {string} appSysId - sys_scope sys_id (scope of the update set)
   * @returns {Promise<string>} The update set XML document
   */
  async exportUpdateSet(updateSetSysId, appSysId = '') {
    const cookies = await this._warmSession();
    const csrfToken = await this._getScriptsPageCSRF(cookies);

    const params = new URLSearchParams();
    params.set('sysparm_ck', csrfToken);
    params.set('sysparm_sys_id', updateSetSysId);
    params.set('sysparm_app_sys_id', appSysId);

    const endpoint = `${this.baseURL}/fluent_update_set_export.do?${params.toString()}`;
    return this.rawRequest(endpoint, {
      method: 'GET',
      headers: cookies ? { Cookie: cookies } : {},
    });
  }

  /**
   * Execute a background script on the ServiceNow instance via sys.scripts.do.
   * Uses a 3-step session-establishment flow compatible with OAuth tokens:
   *  1. Make a REST API call to get session cookies
   *  2. GET /sys.scripts.do with cookies to extract the CSRF token (sysparm_ck)
   *  3. POST /sys.scripts.do with the script, CSRF token, and cookies
   *
   * @param {string} script - JavaScript code to execute
   * @param {string} scope - Scope sys_id to run under ('' = global)
   * @param {object} [opts] - Script-mode flags (issue #177), mapping to the
   *   Script Background form checkboxes:
   *   - rollback (default true) → record_for_rollback
   *   - quotaManagedTransaction (default true) → quota_managed_transaction
   *   - sandbox (default false) → sandbox (KittyScript, single expression)
   *   - scriptlet (default false) → scriptlet
   * @returns {Promise<string>} The script's output text
   */
  async executeScript(script, scope, opts = {}) {
    // Step 1: Warm up the session by hitting any REST API — this makes
    // ServiceNow issue session cookies for subsequent UI page requests.
    // We capture cookies to forward them (Node.js fetch() has no built-in cookie jar).
    const cookies = await this._warmSession();

    // Step 2: GET /sys.scripts.do to extract the CSRF token from the HTML form.
    const csrfToken = await this._getScriptsPageCSRF(cookies);

    // Step 3: POST the script with form data including the CSRF token.
    const endpoint = `${this.baseURL}/sys.scripts.do`;
    const formBody = buildScriptFormBody({
      script,
      csrf: csrfToken,
      scope,
      rollback: opts.rollback,
      quotaManagedTransaction: opts.quotaManagedTransaction,
      sandbox: opts.sandbox,
      scriptlet: opts.scriptlet,
    });

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

function isUsableFlowPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  return ['actionInstances', 'flowLogicInstances', 'subFlowInstances', 'triggerInstances', 'inputs', 'outputs', 'flowVariables']
    .some(key => Array.isArray(payload[key]) && payload[key].some(item => item && typeof item === 'object' && !Array.isArray(item)));
}

function extractPayloadData(inspection, payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return;

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

  const flowVariables = toMapSlice(payload.flowVariables);
  if (flowVariables) inspection.flowVariables = flowVariables;

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

/**
 * The ProcessFlow API returns flow structure as flat arrays where children
 * reference their parent logic step via a `parent` / `parent_ui_id` field
 * (a uiUniqueIdentifier value). The payload-based renderer expects nested
 * `flowBlock` arrays on each logic instance. Rebuild that nesting here so
 * both data sources render identically.
 */
export function hydrateFlowBlocks(payload) {
  const blockKeys = ['actionInstances', 'flowLogicInstances', 'subFlowInstances'];
  const items = [];
  for (const key of blockKeys) {
    if (Array.isArray(payload[key])) {
      for (const item of payload[key]) {
        if (item && typeof item === 'object') items.push(item);
      }
    }
  }
  if (items.length === 0) return;

  // If the payload already has nested flowBlock arrays (version-payload
  // shape), leave it alone.
  const logicItems = Array.isArray(payload.flowLogicInstances) ? payload.flowLogicInstances : [];
  if (logicItems.some(l => l && typeof l === 'object' && Array.isArray(l.flowBlock))) return;

  // Build parent → children map keyed by uiUniqueIdentifier
  const childrenByParent = new Map();
  for (const item of items) {
    const parentId = getStringField(item, 'parent_ui_id') || getStringField(item, 'parent');
    if (!parentId) continue;
    if (!childrenByParent.has(parentId)) childrenByParent.set(parentId, []);
    childrenByParent.get(parentId).push(item);
  }

  // Attach sorted flowBlock to each logic instance
  for (const logic of logicItems) {
    if (!logic || typeof logic !== 'object') continue;
    const uid = getStringField(logic, 'uiUniqueIdentifier');
    const children = uid ? childrenByParent.get(uid) : null;
    if (Array.isArray(children) && children.length > 0) {
      children.sort((a, b) => parseOrderField(a) - parseOrderField(b));
      logic.flowBlock = children;
    }
  }
}

function parseOrderField(record) {
  const order = getStringField(record, 'order');
  const n = parseInt(order, 10);
  return isNaN(n) ? 0 : n;
}

/**
 * Decode a ServiceNow flow-logic "values" field: base64-gzip JSON.
 * Returns the parsed object, or null when the field is empty / not gzip / unparseable.
 */
export function decodeGzipJson(value) {
  if (!value) return null;
  const s = (typeof value === 'object' && value !== null)
    ? (value.value ?? value.display_value ?? '')
    : String(value);
  const trimmed = s.trim();
  if (!trimmed.startsWith('H4sI')) return null; // not gzip base64
  try {
    const decoded = gunzipSync(Buffer.from(trimmed, 'base64')).toString('utf-8');
    return JSON.parse(decoded);
  } catch {
    return null;
  }
}
