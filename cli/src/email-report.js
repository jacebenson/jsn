// Human-readable styled views for `jsn email queue` and `jsn email why`.
//
// These renderers only read the data envelopes built by email-analysis.js.
// JSON output keeps the same data without these strings (`_formatted` is
// attached non-enumerably by the command), so scripting is unaffected.

function section(title) {
  return ['', title];
}

function table(rows, { indent = 2, labelWidth = 26 } = {}) {
  return rows.map(([label, value]) => `${' '.repeat(indent)}${String(label).padEnd(labelWidth)}${value}`);
}

function unavailableLines(data) {
  if (!Array.isArray(data.unavailable) || data.unavailable.length === 0) return [];
  return section('Unavailable evidence (not counted as zero)')
    .concat(data.unavailable.map(entry => `  ${entry.table}${entry.source ? ` (${entry.source})` : ''}: ${entry.error}`));
}

function noteLines(data) {
  if (!Array.isArray(data.notes) || data.notes.length === 0) return [];
  return section('Notes').concat(data.notes.map(note => `  • ${note}`));
}

function warningLines(data) {
  if (!Array.isArray(data.warnings) || data.warnings.length === 0) return [];
  return section('Warnings').concat(data.warnings.map(warning => `  ⚠ ${warning}`));
}

function windowLabel(window) {
  if (!window) return 'unknown';
  const base = window.kind === 'relative' ? `last ${window.since}` : `since ${window.since}`;
  return `${base} (${window.query}; ${window.resolution})`;
}

export function formatEmailQueue(data, { instance } = {}) {
  const lines = [];
  lines.push(`Email queue${instance ? ` — ${instance}` : ''}`);
  lines.push(`Window: ${windowLabel(data.window)}`);
  lines.push('');

  if (data.total === null || data.total === undefined) {
    lines.push('Total: unavailable');
  } else {
    lines.push(`Total in window: ${data.total}`);
  }

  if (Array.isArray(data.by_type)) {
    lines.push(...section('By type (provider aggregate)'));
    if (data.by_type.length === 0) lines.push('  (no messages in window)');
    lines.push(...table(data.by_type.map(entry => [entry.value || '(blank)', entry.count])));
    if (Array.isArray(data.zero_types_in_window) && data.zero_types_in_window.length > 0) {
      lines.push(`  zero in window: ${data.zero_types_in_window.join(', ')}`);
    }
  }

  if (Array.isArray(data.by_state)) {
    lines.push(...section('By state (provider aggregate)'));
    if (data.by_state.length === 0) lines.push('  (no messages in window)');
    lines.push(...table(data.by_state.map(entry => [entry.value || '(blank)', entry.count])));
  }

  if (Array.isArray(data.by_mailbox)) {
    lines.push(...section('By mailbox (provider aggregate)'));
    if (data.by_mailbox.length === 0) lines.push('  (no messages in window)');
    lines.push(...table(data.by_mailbox.map(entry => [
      `${entry.mailbox || '(blank)'}${entry.name && entry.name !== entry.mailbox ? ` (${entry.name})` : ''}`,
      entry.count,
    ])));
  }

  const oldest = data.oldest_send_ready;
  lines.push(...section('Oldest send-ready'));
  if (!oldest) {
    lines.push('  none returned');
  } else {
    lines.push(...table([
      ['sys_created_on', `${oldest.sys_created_on} UTC`],
      ['age', oldest.age ?? 'unknown'],
      ['sys_id', oldest.sys_id ?? '—'],
      ['recipient', oldest.recipient ?? '—'],
      ['subject', oldest.subject ?? '—'],
    ]));
  }

  if (data.switches) {
    lines.push(...section('Email switches'));
    lines.push(...table(Object.entries(data.switches)
      .filter(([key]) => key !== 'source')
      .map(([key, value]) => [key, value === null ? 'unknown' : String(value)])));
  }

  if (data.email_accounts) {
    const accounts = data.email_accounts;
    lines.push(...section('Mail accounts (sys_email_account)'));
    lines.push(...table([
      ['total / active', `${accounts.total ?? 'unknown'} / ${accounts.active ?? 'unknown'}`],
      ...accounts.rows.map(row => [row.name || row.sys_id, `${row.type ?? '—'}${row.server ? ` @ ${row.server}` : ''}${row.from ? ` from ${row.from}` : ''}`]),
    ]));
    if (accounts.rows_complete === false) {
      lines.push('  active rows returned do not match the active count; the row list is partial');
    }
  }

  lines.push(...warningLines(data));
  lines.push(...unavailableLines(data));
  lines.push(...noteLines(data));
  return lines.join('\n');
}

export function formatEmailWhy(data, { instance } = {}) {
  const email = data.email || {};
  const lines = [];
  lines.push(`Email ${email.sys_id}${instance ? ` — ${instance}` : ''}`);
  lines.push(`${email.type || 'unknown type'} / ${email.state || 'unknown state'}${email.status ? ` / ${email.status}` : ''} (${email.direction})`);
  lines.push('');
  lines.push(...table([
    ['matched on', data.identifier?.matched_on ?? '—'],
    ['subject', email.subject ?? '—'],
    ['from', email.direct ?? '—'],
    ['recipients', email.recipients ?? '—'],
    ['mailbox', email.mailbox ?? '—'],
    ['error_string', email.error_string ?? '—'],
    ['message_id', email.message_id ?? '—'],
    ['receive/notification', `${email.receive_type ?? '—'} / ${email.notification_type ?? '—'}`],
    ['created', email.sys_created_on ? `${email.sys_created_on} (${email.age ?? 'age unknown'} ago)` : '—'],
  ]));

  if (Array.isArray(data.watermarks)) {
    lines.push(...section('Watermark (sys_watermark)'));
    if (data.watermarks.length === 0) {
      lines.push('  no watermark references this email');
    }
    for (const watermark of data.watermarks) {
      const source = watermark.source;
      const sourceText = source
        ? `${source.table} ${source.sys_id}${source.label ? ` — ${source.label}` : ''}${source.error ? ` (unavailable: ${source.error})` : ''}`
        : '—';
      lines.push(`  number        ${watermark.number ?? '—'}`);
      lines.push(`  source        ${sourceText}`);
    }
    if (data.watermarks_truncated) {
      lines.push(`  showing ${data.watermarks.length} of ${data.watermarks_total}; narrow the question to the message you need`);
    }
  }

  if (data.inbound_actions) {
    lines.push(...section(`Inbound action candidates (expected type: ${data.inbound_actions.expected_type})`));
    const candidates = data.inbound_actions.candidates || [];
    if (candidates.length === 0) lines.push('  none returned');
    for (const action of candidates) {
      const marker = action.matches_message_type ? '*' : ' ';
      lines.push(`  ${marker} ${action.name || action.sys_id} [type ${action.type || '—'}, active ${action.active === null ? 'unknown' : action.active}]`);
    }
    lines.push('  * matches the message type; this is configuration evidence, not proof the action ran');
  } else if (email.direction === 'outbound') {
    lines.push(...section('Inbound actions'));
    lines.push('  not applicable: outbound email');
  }

  if (Array.isArray(data.email_log)) {
    lines.push(...section('Notification log (sys_email_log)'));
    if (data.email_log.length === 0) lines.push('  no rows reference this email');
    for (const row of data.email_log) {
      const notification = row.notification ? `${row.notification.name || row.notification.sys_id}` : '—';
      const event = row.event ? `${row.event.name || row.event.sys_id}${row.event.state ? ` [${row.event.state}]` : ''}` : '—';
      lines.push(`  ${row.sys_created_on || '—'}  ${notification}  event ${event}`);
    }
    if (data.email_log_truncated) {
      lines.push(`  showing ${data.email_log.length} of ${data.email_log_total} rows`);
    }
  }

  if (data.syslog_email) {
    lines.push(...section('syslog_email'));
    if (!data.syslog_email.available) {
      lines.push(`  unavailable: ${data.syslog_email.error}`);
    } else {
      lines.push(`  ${data.syslog_email.rows.length} row(s); row meaning is unconfirmed`);
    }
  }

  lines.push(...unavailableLines(data));
  lines.push(...noteLines(data));
  return lines.join('\n');
}
