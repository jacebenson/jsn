import { formatRecordForDisplay, interactiveList, getStringField } from '../../helpers.js';

function logIcon(level) {
  level = (level || '').toLowerCase();
  if (level === 'error') return '❌';
  if (level === 'warning') return '⚠️';
  if (level === 'information' || level === 'info') return 'ℹ️';
  return '📝';
}

export function logsCmd(wrap) {
  return {
    command: 'logs [subcommand]',
    aliases: ['log'],
    describe: 'Query system logs',
    builder: (yargs) => {
      return yargs
        .command({
          command: 'list',
          aliases: ['ls'],
          describe: 'List system logs',
          builder: (y) => y
            .option('query', { type: 'string', describe: 'Encoded query (e.g. "level=error" or "sourceLIKEscript")' })
            .option('columns', { alias: ['c', 'fields'], type: 'string', describe: 'Comma-separated columns' })
            .option('limit', { alias: 'l', type: 'number', default: 50, describe: 'Max records' }),
          handler: wrap(async (argv, app) => {
            app.requireInstance();
            const columns = argv.columns ? argv.columns.split(',') : ['level', 'message', 'source', 'sys_created_on', 'sys_id', 'context_map'];
            const query = argv.query || '';

            const picked = await interactiveList({
              app, table: 'syslog', singular: 'log entry', columns, limit: argv.limit, query, labelField: 'message',
              formatLabel: r => {
                const level = getStringField(r, 'level') || '';
                const msg = (getStringField(r, 'message') || '').substring(0, 80);
                const src = getStringField(r, 'source') || '';
                return `${logIcon(level)} ${msg}${src ? `  [${src}]` : ''}`;
              },
            });
            if (picked === undefined) return;
            if (picked) {
              const sysID = getStringField(picked, 'sys_id') || '';
              // Fetch full record for rich display (like jsn logs show)
              const full = await app.sdk.get('syslog', sysID) || picked;
              full._context = { instance_url: app.getEffectiveInstance(), table: 'syslog' };
              // Parse and pretty-print context_map JSON (SN API may return as string or object)
              const cm = full.context_map;
              if (cm) {
                try {
                  const parsed = typeof cm === 'string' ? JSON.parse(cm) : cm;
                  full.context_map = Object.entries(parsed).map(([k, v]) => `${k}: ${v}`).join('\n');
                } catch { /* leave as-is */ }
              }
              const level = getStringField(full, 'level') || '?';
              const instance = app.getEffectiveInstance();
              return app.ok(full, {
                summary: `${logIcon(level)} ${level}: ${(getStringField(full, 'message') || '').substring(0, 80)}`,
                breadcrumbs: [
                  { action: 'list', cmd: 'jsn logs list', description: 'Back to all logs' },
                  { action: 'view', cmd: `jsn logs show ${sysID}`, description: 'View full details' },
                  ...(instance && sysID ? [{ action: 'open', label: `${instance}/syslog_list.do?sysparm_query=sys_id=${sysID}`, description: 'Open in ServiceNow' }] : []),
                ],
              });
            }

            // Fall back to text/table
            const params = new URLSearchParams();
            params.set('sysparm_limit', String(argv.limit));
            params.set('sysparm_display_value', 'all');
            params.set('sysparm_fields', ['sys_id', ...columns].join(','));
            const q = query ? query + '^ORDERBYDESCsys_created_on' : 'ORDERBYDESCsys_created_on';
            params.set('sysparm_query', q);
            const records = await app.sdk.list('syslog', params);
            app.ok({
              table: 'syslog',
              count: records.length,
              columns,
              records: records.map(r => formatRecordForDisplay(r, columns)),
              context: { instance_url: app.getEffectiveInstance() },
            }, { summary: `${records.length} log entry(s)` });
          }),
        })
        .command({
          command: 'show <sys_id>',
          aliases: ['get'],
          describe: 'Show a log entry by sys_id',
          handler: wrap(async (argv, app) => {
            const record = await app.sdk.get('syslog', argv.sys_id);
            if (!record) {
              throw new Error(`Log entry not found: ${argv.sys_id}`);
            }
            const level = getStringField(record, 'level') || '?';
            app.ok(record, { summary: `${logIcon(level)} ${level}: ${(getStringField(record, 'message') || '').substring(0, 80)}` });
          }),
        })
        .command({
          command: 'follow',
          describe: 'Tail system logs in real time (Ctrl+C to stop)',
          builder: (y) => y
            .option('query', { type: 'string', describe: 'Additional encoded query filter (e.g. "sourceLIKEscript")' })
            .option('level', { type: 'string', describe: 'Filter by level (error, warning, information)' })
            .option('source', { type: 'string', describe: 'Filter by source' })
            .option('tail', { type: 'number', default: 0, describe: 'Show the last N existing entries first, then follow' })
            .option('interval', { type: 'number', default: 2000, describe: 'Poll interval in ms (min 500)' }),
          handler: wrap(async (argv, app) => {
            app.requireInstance();
            const filters = [argv.query || ''];
            if (argv.level) filters.push(`level=${argv.level}`);
            if (argv.source) filters.push(`sourceLIKE${argv.source}`);
            const base = filters.filter(Boolean).join('^');
            const intervalMs = Math.max(500, argv.interval || 2000);
            let watermark = '';
            const seen = new Set();

            // sys_created_on> comparisons run in UTC; the display_value is server-local
            // time, so a display-based watermark never advances on a non-UTC instance.
            // Normalize the raw UTC .value to 'YYYY-MM-DD HH:mm:ss' for the query and
            // lexicographic comparison. The sys_id seen-set guarantees a row can never
            // re-print even if two polls fall in the same timestamp bucket.
            const toQueryTs = (v) => {
              if (typeof v !== 'string') return v;
              return v.replace('T', ' ').replace(/\.\d{1,3}[Zz]?$/, '').replace(/[Zz]$/, '');
            };
            const rawTs = (r) => {
              const f = r.sys_created_on;
              if (f && typeof f === 'object') {
                const v = f.value != null ? f.value : f.display_value;
                return v ? toQueryTs(String(v)) : '';
              }
              return f ? toQueryTs(String(f)) : '';
            };
            const sysIdOf = (r) => getStringField(r, 'sys_id');

            const formatRow = (r) => {
              const ts = getStringField(r, 'sys_created_on');
              const level = getStringField(r, 'level');
              const src = getStringField(r, 'source');
              const msg = getStringField(r, 'message');
              return `${ts} ${logIcon(level).padEnd(2)} [${src}] ${msg}`;
            };

            const emit = (r) => {
              const id = sysIdOf(r);
              if (id) {
                if (seen.has(id)) return; // never re-print a row this run
                seen.add(id);
              }
              const ts = rawTs(r);
              if (ts && !watermark) watermark = ts;
              else if (ts && ts > watermark) watermark = ts;
              process.stdout.write(formatRow(r) + '\n');
            };

            const fetchNew = async () => {
              const params = new URLSearchParams();
              params.set('sysparm_display_value', 'all');
              params.set('sysparm_fields', 'sys_created_on,level,source,message,sys_id');
              params.set('sysparm_limit', '100');
              let q = watermark ? `sys_created_on>${watermark}^ORDERBYsys_created_on` : 'ORDERBYsys_created_on';
              if (base) q = `${base}^${q}`;
              params.set('sysparm_query', q);
              let records;
              try { records = await app.sdk.list('syslog', params); } catch (err) {
                process.stderr.write(`⚠ poll error: ${err.message}\n`);
                return;
              }
              for (const r of records) emit(r);
            };

            // Optional backfill: show last N newest-first, then follow.
            if (argv.tail > 0) {
              const params = new URLSearchParams();
              params.set('sysparm_display_value', 'all');
              params.set('sysparm_fields', 'sys_created_on,level,source,message,sys_id');
              let q = base ? `${base}^ORDERBYDESCsys_created_on` : 'ORDERBYDESCsys_created_on';
              params.set('sysparm_query', q);
              params.set('sysparm_limit', String(argv.tail));
              try {
                const recent = await app.sdk.list('syslog', params);
                const ordered = [...recent].reverse(); // oldest->newest on screen
                for (const r of ordered) emit(r);
              } catch (err) { process.stderr.write(`⚠ backfill error: ${err.message}\n`); }
            }

            await fetchNew();
            const timer = setInterval(fetchNew, intervalMs);
            process.stdout.write(`\n[jsn logs follow] watching syslog every ${intervalMs}ms — Ctrl+C to stop\n`);
            const stop = () => { clearInterval(timer); process.exit(0); };
            process.on('SIGINT', stop);
            process.on('SIGTERM', stop);
          }),
        });
    },
    handler: () => {
      console.log('View system logs from the syslog table.');
      console.log('');
      console.log('Available subcommands:');
      console.log('  list                List log entries');
      console.log('  show <sys_id>       Show a log entry by sys_id');
      console.log('');
      console.log('Run "jsn logs <command> --help" for details.');
    },
  };
}
