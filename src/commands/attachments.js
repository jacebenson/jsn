import fs from 'node:fs/promises';
import path from 'node:path';
import { confirmDelete, getStringField } from '../helpers.js';
import { errUsage } from '../errors.js';
import { declareCapabilities } from '../capabilities.js';

declareCapabilities('attachments', { mutationSubcommands: ['upload', 'add'] });
const identifier = value => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) throw errUsage('Supply a safe record or attachment sys_id.');
  return value;
};

// A server-provided filename may never choose directories or platform devices.
export function attachmentFilename(value, id) {
  const name = path.posix.basename(String(value || '').replaceAll('\\', '/'))
    .replace(/[<>:"|?*\p{Cc}]/gu, '_').replace(/[. ]+$/g, '');
  return !name || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name) ? `${id}.bin` : name;
}

export const attachmentsCmd = wrap => ({
  command: 'attachments [subcommand]',
  aliases: ['attachment'],
  describe: 'List, download and upload files attached to any record',
  builder: y => y
    .epilogue([
      'List files: jsn attachments list --sys-id <record-id>',
      'Download by attachment ID: jsn attachments download <attachment-id> --out ./file.bin',
      'Upload: jsn attachments upload ./file.txt --table incident --sys-id <record-id>',
      'download/get and upload/add are aliases. The former records attachments subtree has moved here.',
      'Downloads use a safe basename and refuse to overwrite existing local files unless --overwrite is supplied.',
    ].join('\n'))
    .command({
      command: 'list',
      describe: 'List attachment metadata for a parent record',
      builder: y => y
        .option('sys-id', { alias: 's', type: 'string', demandOption: true, describe: 'Parent record sys_id' })
        .option('table', { type: 'string', describe: 'Parent table (output context only)' }),
      handler: wrap(async (argv, app) => {
        const id = identifier(argv['sys-id']);
        app.requireInstance();
        const attachments = await app.sdk.listAttachments(id);
        app.ok({ sys_id: id, table: argv.table || '', count: attachments.length, attachments,
          context: { instance_url: app.getEffectiveInstance() } }, { summary: `${attachments.length} attachment(s) on record ${id}` });
      }),
    })
    .command({
      command: 'download <attachment-id>',
      aliases: ['get'],
      describe: 'Download file bytes by attachment ID; no parent record ID needed',
      builder: y => y
        .positional('attachment-id', { type: 'string', describe: 'Attachment sys_id' })
        .option('out', { alias: 'o', type: 'string', describe: 'Local output path (default: safe attachment filename in cwd)' })
        .option('overwrite', { type: 'boolean', default: false, describe: 'Replace an existing local file' }),
      handler: wrap(async (argv, app) => {
        const id = identifier(argv.attachmentId ?? argv['attachment-id']);
        app.requireInstance();
        let out = argv.out;
        if (!out) {
          const metadata = await app.sdk.request(`${app.sdk.baseURL}/api/now/attachment/${id}`, { method: 'GET' });
          out = attachmentFilename(getStringField(metadata?.result, 'file_name'), id);
        }
        const bytes = await app.sdk.getAttachment(id);
        await fs.writeFile(out, bytes, { flag: argv.overwrite ? 'w' : 'wx' });
        app.ok({ sys_id: id, out, bytes: bytes.length }, { summary: `Wrote ${bytes.length} bytes to ${out}` });
      }),
    })
    .command({
      command: 'upload <file>',
      aliases: ['add'],
      describe: 'Upload a local file to a record (requires confirmation)',
      builder: y => y
        .positional('file', { type: 'string', describe: 'Local file to upload' })
        .option('sys-id', { alias: 's', type: 'string', demandOption: true, describe: 'Parent record sys_id' })
        .option('table', { type: 'string', demandOption: true, describe: 'Parent table, for example incident' })
        .option('name', { type: 'string', describe: 'Attachment filename (default: local basename)' })
        .option('force', { type: 'boolean', default: false, describe: 'Skip upload confirmation after approval' }),
      handler: wrap(async (argv, app) => {
        const id = identifier(argv['sys-id']);
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(argv.table)) throw errUsage('Supply a valid parent table name.');
        app.requireInstance();
        await confirmDelete(app, argv, `Upload "${argv.file}" as an attachment on ${argv.table} ${id}?`);
        const content = await fs.readFile(argv.file);
        const fileName = argv.name || path.basename(argv.file);
        const created = await app.sdk.addAttachment(argv.table, id, content, fileName);
        app.ok({ sys_id: getStringField(created, 'sys_id'), file_name: fileName, table: argv.table, recordsys_id: id }, { summary: `Attached ${fileName}` });
      }),
    }),
});
