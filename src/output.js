// Output formatting: JSON, Markdown, Styled, Quiet

import process from 'node:process';
import chalk from 'chalk';

export const FormatAuto = 'auto';
export const FormatJSON = 'json';
export const FormatMarkdown = 'markdown';
export const FormatStyled = 'styled';
export const FormatQuiet = 'quiet';

export function hyperlink(text, url) {
  if (!url) return text;
  return `\x1b]8;;${url}\x07${text}\x1b]8;;\x07`;
}

function stripAnsi(str) {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*[a-zA-Z]|\x1b\]8;;[^\x07]*\x07|\x1b\]8;;\x07/g, '');
}

function _visibleWidth(str) {
  return stripAnsi(str).length;
}

export function isTTY(writer) {
  if (!writer) writer = process.stdout;
  return writer.isTTY === true;
}

export class OutputWriter {
  constructor(opts = {}) {
    this.format = opts.format || FormatAuto;
    this.writer = opts.writer || process.stdout;
    this.jqFilter = opts.jqFilter || '';
  }

  getFormat() {
    return this.format;
  }

  effectiveFormat() {
    if (this.format === FormatAuto) {
      return isTTY(this.writer) ? FormatStyled : FormatJSON;
    }
    return this.format;
  }

  ok(data, opts = {}) {
    const format = this.effectiveFormat();
    switch (format) {
      case FormatJSON:
        return this.writeJSON(data, opts);
      case FormatMarkdown:
        return this.writeMarkdown(data, opts);
      case FormatQuiet:
        return this.writeQuiet(data);
      case FormatStyled:
        return this.writeStyled(data, opts);
      default:
        return this.writeJSON(data, opts);
    }
  }

  err(error) {
    const format = this.effectiveFormat();
    const e = error.code ? error : { code: 'unknown', message: String(error), hint: '' };
    const resp = { ok: false, error: e.message, code: e.code, hint: e.hint || '' };
    switch (format) {
      case FormatJSON:
      case FormatQuiet:
        this.writer.write(JSON.stringify(resp, null, 2) + '\n');
        break;
      case FormatMarkdown:
        this.writer.write(`**Error (${e.code})**: ${e.message}\n`);
        if (e.hint) this.writer.write(`\n*Hint: ${e.hint}*\n`);
        break;
      default:
        if (isTTY(this.writer)) {
          this.writer.write(chalk.red(`Error (${e.code}): ${e.message}\n`));
          if (e.hint) this.writer.write(chalk.yellow(`Hint: ${e.hint}\n`));
        } else {
          this.writer.write(JSON.stringify(resp, null, 2) + '\n');
        }
    }
  }

  writeJSON(data, opts) {
    const resp = { ok: true, data, summary: opts.summary || '', breadcrumbs: opts.breadcrumbs || [] };
    if (opts.notice) resp.notice = opts.notice;
    if (opts.context) resp.context = opts.context;
    if (opts.meta) resp.meta = opts.meta;
    this.writer.write(JSON.stringify(resp, null, 2) + '\n');
  }

  writeQuiet(data) {
    this.writer.write(JSON.stringify(data, null, 2) + '\n');
  }

  writeMarkdown(data, opts) {
    if (opts.summary) {
      this.writer.write(opts.summary + '\n\n');
    }

    if (Array.isArray(data)) {
      this.writeMarkdownTable(data);
    } else if (data && typeof data === 'object') {
      if (Array.isArray(data.records) && data.records.length > 0) {
        this.writeMarkdownTable(data.records);
      } else {
        this.writer.write('```json\n');
        this.writer.write(JSON.stringify(data, null, 2));
        this.writer.write('\n```\n');
      }
    } else {
      this.writer.write(String(data) + '\n');
    }

    if (opts.breadcrumbs && opts.breadcrumbs.length > 0) {
      this.writer.write('\n### Hints\n');
      for (const bc of opts.breadcrumbs) {
        this.writer.write(`- **${bc.action}**: \`${bc.cmd}\` — ${bc.description}\n`);
      }
    }
  }

  writeMarkdownTable(rows) {
    if (!Array.isArray(rows) || rows.length === 0) {
      this.writer.write('(no results)\n');
      return;
    }
    const columns = Object.keys(rows[0]);
    // Header
    this.writer.write('| ' + columns.join(' | ') + ' |\n');
    // Separator
    this.writer.write('| ' + columns.map(c => '-'.repeat(c.length)).join(' | ') + ' |\n');
    // Rows
    for (const row of rows) {
      const cells = columns.map(col => {
        const val = row[col];
        if (val == null) return '';
        if (typeof val === 'object') {
          if (val.display_value != null) return String(val.display_value);
          if (val.value != null) return String(val.value);
          return JSON.stringify(val);
        }
        return String(val);
      });
      this.writer.write('| ' + cells.join(' | ') + ' |\n');
    }
  }

  writeStyled(data, opts) {
    const hasFormatted = data && typeof data === 'object' && data._formatted;

    if (opts.summary && !hasFormatted) {
      this.writer.write(opts.summary + '\n\n');
    }

    if (Array.isArray(data)) {
      for (const row of data) {
        const firstVal = Object.values(row)[0];
        this.writer.write(String(firstVal) + '\n');
      }
    } else if (data && typeof data === 'object') {
      if (data._formatted) {
        this.writer.write(data._formatted);
      }

      const { isRecord, tableName } = detectRecord(data);
      if (isRecord) {
        this.writeFormattedRecord(data, tableName);
      }

      if (Array.isArray(data.profiles) && data.profiles.length > 0) {
        this.writer.write('\n');
        for (const p of data.profiles) {
          const prefix = p.default ? '* ' : '  ';
          const status = p.authenticated ? '✓' : '✗';
          if (p.username) {
            this.writer.write(`${prefix}${status} ${p.instance} (as ${p.username})\n`);
          } else {
            this.writer.write(`${prefix}${status} ${p.instance}\n`);
          }
        }
      }

      if (Array.isArray(data.records) && data.records.length > 0) {
        this.writeRecordsTable(data);
      }
    } else {
      if (!opts.summary) {
        this.writer.write(String(data) + '\n');
      }
    }

    if (opts.breadcrumbs && opts.breadcrumbs.length > 0) {
      this.writer.write('\n');
      for (const bc of opts.breadcrumbs) {
        this.writer.write(`  → ${bc.action}: ${bc.cmd} — ${bc.description}\n`);
      }
    }
  }

  writeRecordsTable(data) {
    const records = data.records;
    const columns = data.columns || (records.length > 0 ? Object.keys(records[0]) : []);
    const table = data.table || '';
    const instanceURL = data.context?.instance_url || '';

    const colWidths = {
      number: 14,
      short_description: 48,
      priority: 14,
      state: 10,
      assigned_to: 15,
      risk: 10,
      name: 30,
      user_name: 15,
      email: 30,
      sys_id: 32,
      sys_updated_on: 22,
      sys_created_on: 22,
      opened_at: 22,
      closed_at: 22,
      sys_updated_by: 20,
      sys_created_by: 20,
      opened_by: 20,
      u_category: 20,
      u_subcategory: 20,
    };

    this.writer.write('\n');

    // Header
    for (const col of columns) {
      const width = colWidths[col] || 20;
      this.writer.write(col + ' '.repeat(Math.max(0, width - col.length)) + '  ');
    }
    this.writer.write('\n');

    // Separator
    for (const col of columns) {
      const width = colWidths[col] || 20;
      this.writer.write('-'.repeat(width) + '  ');
    }
    this.writer.write('\n');

    // Rows (limit to 20)
    const limit = Math.min(records.length, 20);
    for (let i = 0; i < limit; i++) {
      const row = records[i];
      for (let j = 0; j < columns.length; j++) {
        const col = columns[j];
        let val = row[col] || '';
        const width = colWidths[col] || 20;

        if (j === 0 && instanceURL && table && row.sys_id) {
          const url = `${instanceURL}/${table}.do?sys_id=${row.sys_id}`;
          val = hyperlink(val, url);
        }

        const visible = stripAnsi(val);
        let display = val;
        if (visible.length > width) {
          display = visible.slice(0, width - 3) + '...';
          if (val !== visible) {
            if (j === 0 && instanceURL && table && row.sys_id) {
              const url = `${instanceURL}/${table}.do?sys_id=${row.sys_id}`;
              display = hyperlink(display, url);
            }
          }
        }

        this.writer.write(display);
        this.writer.write(' '.repeat(Math.max(0, width - stripAnsi(display).length)) + '  ');
      }
      this.writer.write('\n');
    }

    if (records.length > limit) {
      this.writer.write(`\n... and ${records.length - limit} more\n`);
    }
  }

  writeFormattedRecord(data, table) {
    // Get instance URL from _context
    let instanceURL = '';
    if (data._context && typeof data._context === 'object') {
      instanceURL = data._context.instance_url || '';
      delete data._context;
    }

    let title = '';
    if (data.number) {
      title = getDisplayValue(data.number);
    }
    if (!title && data.name) {
      title = getDisplayValue(data.name);
    }
    if (!title && table) title = table;

    this.writer.write(`\n${title} (${table})\n\n`);

    const groups = {
      Core: ['number', 'sys_id', 'sys_class_name', 'state', 'active', 'short_description', 'description', 'priority', 'urgency', 'impact', 'risk', 'type'],
      People: ['opened_by', 'assigned_to', 'assignment_group', 'closed_by', 'requested_by', 'additional_assignee_list', 'watch_list'],
      'Status': ['approval', 'approval_set', 'approval_history', 'escalation', 'made_sla', 'on_hold', 'on_hold_reason'],
      'Dates & Times': ['opened_at', 'sys_created_on', 'sys_updated_on', 'closed_at', 'work_start', 'work_end', 'due_date', 'expected_start', 'sla_due', 'activity_due'],
      System: ['sys_domain', 'sys_domain_path', 'sys_created_by', 'sys_updated_by', 'sys_mod_count', 'sys_tags'],
    };

    const displayed = new Set();

    for (const [groupName, fields] of Object.entries(groups)) {
      let hasFields = false;
      let groupContent = '';
      for (const field of fields) {
        if (field in data) {
          displayed.add(field);
          const displayVal = getDisplayValue(data[field]);
          if (displayVal !== '' || field === 'description' || field === 'short_description') {
            if (!hasFields) {
              hasFields = true;
              groupContent = `─ ${groupName} ─\n`;
            }
            if (displayVal.includes('\n')) {
              groupContent += `  ${field}:\n`;
              for (const line of displayVal.split('\n')) {
                groupContent += `    ${line}\n`;
              }
            } else {
              groupContent += `  ${field}:  ${displayVal}\n`;
            }
          }
        }
      }
      if (hasFields) {
        this.writer.write(groupContent);
        this.writer.write('\n');
      }
    }

    const otherFields = Object.keys(data).filter(f => !displayed.has(f) && !f.startsWith('_')).sort();
    if (otherFields.length > 0) {
      this.writer.write('─ Other ─\n');
      for (const field of otherFields) {
        const displayVal = getDisplayValue(data[field]);
        if (displayVal.includes('\n')) {
          this.writer.write(`  ${field}:\n`);
          for (const line of displayVal.split('\n')) {
            this.writer.write(`    ${line}\n`);
          }
        } else {
          this.writer.write(`  ${field}:  ${displayVal}\n`);
        }
      }
      this.writer.write('\n');
    }

    // ── Attachments ──
    if (data._attachments && Array.isArray(data._attachments) && data._attachments.length > 0) {
      this.writer.write('─ Attachments ─\n');
      for (const att of data._attachments) {
        const fileName = getDisplayValue(att.file_name);
        const createdBy = getDisplayValue(att.sys_created_by);
        const createdOn = getDisplayValue(att.sys_created_on);
        this.writer.write(`  ${fileName}  (by ${createdBy}, ${createdOn})\n`);
      }
      this.writer.write('\n');
    }

    // ── Catalog Variables ──
    if (data._variables && Array.isArray(data._variables) && data._variables.length > 0) {
      this.writer.write('─ Catalog Variables ─\n');
      for (const v of data._variables) {
        const q = v.question || '';
        const val = v.value || '';
        if (val.includes('\n')) {
          this.writer.write(`  ${q}:\n`);
          for (const line of val.split('\n')) {
            this.writer.write(`    ${line}\n`);
          }
        } else {
          this.writer.write(`  ${q}:  ${val}\n`);
        }
      }
      this.writer.write('\n');
    }

    if (instanceURL && table) {
      const sysID = getDisplayValue(data.sys_id);
      if (sysID) {
        const urlTable = table.toLowerCase().replace(/\s+/g, '_');
        const recordURL = `${instanceURL}/${urlTable}.do?sys_id=${sysID}`;
        this.writer.write(`Link:  ${recordURL}\n\n`);
      }
    }
  }
}

function detectRecord(data) {
  let hasSysID = false;
  let hasSysClass = false;
  let tableName = '';

  if (data.sys_id) hasSysID = true;
  if (data.sys_class_name) {
    hasSysClass = true;
    const sc = data.sys_class_name;
    if (typeof sc === 'object') {
      tableName = sc.display_value || sc.value || '';
    } else {
      tableName = sc;
    }
  }

  if (!tableName && data.number) {
    const num = data.number;
    const numStr = typeof num === 'object' ? (num.display_value || num.value) : num;
    if (numStr && numStr.length > 3) {
      const prefix = numStr.slice(0, 3);
      const map = { INC: 'incident', CHG: 'change_request', RIT: 'sc_req_item', SCT: 'sc_task', PRB: 'problem' };
      if (map[prefix]) tableName = map[prefix];
    }
  }

  return { isRecord: hasSysID && (hasSysClass || tableName), tableName };
}

export function getDisplayValue(val) {
  if (val == null) return '';
  if (typeof val === 'string') return val;
  if (typeof val === 'object') {
    if (val.display_value != null) return String(val.display_value);
    if (val.value != null) return String(val.value);
    return JSON.stringify(val);
  }
  return String(val);
}
