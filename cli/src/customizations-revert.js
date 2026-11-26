// Reverts a Store or repository application's customised files to their base system versions,
// one file at a time through records revert. Files added on the instance are listed, never deleted.
import { createHash } from 'node:crypto';
import { errUsage } from './errors.js';
import { malformed, raw, read } from './records/versions.js';
import { applyRevert, planRevert } from './records/revert.js';

const SCOPE = /^[a-z][a-z0-9_]*$/;
const ID = /^[0-9a-f]{32}$/;
const NAME = /^[A-Za-z0-9_.$-]+$/;
export const BATCH = 100;
const ROWS = 1000;
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export async function previewAppRevert(sdk, { scope, after, instance = '' } = {}) {
  if (!SCOPE.test(String(scope ?? '')) || scope === 'global') throw errUsage('--scope must be the scope of an application installed from the Store or a repository, such as sn_hr_core.');
  if (after !== undefined && !NAME.test(String(after))) throw errUsage('--after must be an update name from a preview, such as sys_script_include_<sys_id>.');
  const apps = await read(sdk, 'sys_scope', `scope=${scope}`, 'sys_id,scope,name,sys_class_name', 2, 'false');
  if (apps.some(row => raw(row.scope) !== scope)) throw malformed(`sys_scope returned an application other than ${scope}.`);
  if (apps.length !== 1) throw errUsage(apps.length ? `More than one application has the scope ${scope}.` : `No application has the scope ${scope}.`);
  const application = { sys_id: raw(apps[0].sys_id), scope, name: raw(apps[0].name), sys_class_name: raw(apps[0].sys_class_name) };
  if (!ID.test(application.sys_id)) throw malformed(`The application ${scope} has no readable sys_id.`);
  // Only Store and repository installs write base system versions.
  if (application.sys_class_name !== 'sys_store_app') throw errUsage(`${scope} was built on this instance, so its files have no base system version to revert to.`);

  // An upgrade skips a file whose update has replace_on_upgrade=false: those are the customised files.
  const updates = await read(sdk, 'sys_update_xml', `application=${application.sys_id}^replace_on_upgrade=false${after === undefined ? '' : `^name>${after}`}^ORDERBYname`, 'name,application,replace_on_upgrade', ROWS + 1, 'false');
  if (updates.some(row => raw(row.application) !== application.sys_id || raw(row.replace_on_upgrade) !== 'false')) throw malformed('sys_update_xml returned an update outside the application\'s customised files.');
  const names = [...new Set(updates.slice(0, ROWS).map(row => raw(row.name)))];
  const more = names.length > BATCH || updates.length > ROWS;
  const plans = [], added = [], at_base = [], refused = [];
  const batch = names.slice(0, BATCH);
  // Files left unreverted keep their mark, so the next run starts after this batch rather than at the top.
  const next_after = more ? batch.at(-1) : null;
  for (const name of batch.filter(name => !NAME.test(name))) refused.push({ update_name: name, reason: 'The update name holds characters jsn will not put into a query.' });

  const files = new Map();
  const safe = batch.filter(name => NAME.test(name));
  for (let i = 0; i < safe.length; i += 25) {
    const chunk = safe.slice(i, i + 25);
    for (const row of await read(sdk, 'sys_metadata', `sys_update_nameIN${chunk.join(',')}`, 'sys_id,sys_class_name,sys_update_name,sys_scope', chunk.length * 2, 'false')) {
      if (!chunk.includes(raw(row.sys_update_name))) throw malformed('sys_metadata returned a record for an update name jsn did not ask for.');
      files.set(raw(row.sys_update_name), [...files.get(raw(row.sys_update_name)) || [], row]);
    }
  }
  for (const name of safe) {
    const rows = files.get(name) || [];
    if (rows.length !== 1) { refused.push({ update_name: name, reason: rows.length ? 'More than one record has this update name.' : 'No record has this update name; it may have been deleted on this instance.' }); continue; }
    const [file] = rows;
    if (raw(file.sys_scope) !== application.sys_id) { refused.push({ update_name: name, table: raw(file.sys_class_name), sys_id: raw(file.sys_id), reason: 'The record now belongs to another scope.' }); continue; }
    try {
      plans.push(await planRevert(sdk, { table: raw(file.sys_class_name), identifier: raw(file.sys_id) }));
    } catch (err) {
      if (err.code !== 'usage_error') throw err;
      const entry = { update_name: name, table: raw(file.sys_class_name), sys_id: raw(file.sys_id) };
      if (err.reason === 'no_base') added.push(entry);
      else if (err.reason === 'at_target') at_base.push(entry);
      else refused.push({ ...entry, reason: err.message });
    }
  }
  const preview = { instance, application, plans, added, at_base, refused, more, next_after };
  // The token covers what would be written: each file's version now and the version it goes to.
  return { ...preview, confirmation_token: digest({ instance, application: application.sys_id, files: plans.map(plan => [plan.update_name, plan.from_version, plan.to_version]) }), writes_performed: false };
}

export async function applyAppRevert(sdk, preview) {
  const results = [];
  for (const plan of preview.plans) {
    try {
      const done = await applyRevert(sdk, plan);
      results.push({ update_name: plan.update_name, table: plan.table, sys_id: plan.sys_id, success: true, from_version: done.from_version, to_version: done.to_version, new_version: done.new_version });
    } catch (err) {
      results.push({ update_name: plan.update_name, table: plan.table, sys_id: plan.sys_id, success: false, code: err.code || 'revert_failed', message: err.message });
    }
  }
  const success_count = results.filter(result => result.success).length;
  return { application: preview.application, results, success_count, failure_count: results.length - success_count, added: preview.added, at_base: preview.at_base, refused: preview.refused, more: preview.more, next_after: preview.next_after };
}

const listed = (title, rows, detail = () => '') => rows.length ? [`${title} (${rows.length}):`, ...rows.map(row => `  ${row.update_name}${detail(row)}`)] : [];

export function formatAppRevertPreview(preview) {
  return [
    `${preview.application.name} (${preview.application.scope}) on ${preview.instance}`,
    ...listed('Reverts to the base system version', preview.plans, plan => `: ${plan.changed_fields.join(', ') || 'other records in the update'}`),
    ...listed('Added on this instance, left as they are (jsn never deletes them)', preview.added),
    ...listed('Already at the base system version', preview.at_base),
    ...listed('Refused', preview.refused, row => `: ${row.reason}`),
    ...(preview.more ? [`More than ${BATCH} customised files: after this batch, run again with --after ${preview.next_after} for the rest.`] : []),
    preview.plans.length ? `Confirmation token: ${preview.confirmation_token}` : `Nothing to revert${preview.more ? ' in this batch' : ''}.`,
    'Nothing has been reverted.',
  ].join('\n');
}

export function formatAppRevert(result) {
  return [
    ...result.results.map(row => row.success ? `Reverted ${row.update_name}: new version [${row.new_version}]` : `FAILED ${row.update_name}: ${row.message}`),
    ...listed('Added on this instance, left as they are', result.added),
    ...listed('Refused', result.refused, row => `: ${row.reason}`),
    ...(result.more ? [`More than ${BATCH} customised files: run again with --after ${result.next_after} for the rest.`] : []),
  ].join('\n');
}
