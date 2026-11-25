// Cascade preview for records delete-many: one Data Management delete job (sys_dm_delete) that is
// never executed, previewed by the Data Management Console's "Preview Cascade Delete Records" data
// broker (OnetimeDeleteRuleManager.fetchCascadeDeletePreview -> createPreviewCascadeCounts).
import { listRecords, recordListParams } from './records-engine.js';
import { errUsage } from './errors.js';

const BROKER = '2a397460ff603210755cffffffffffab';
const absent = (error) => (error?.status === 404 ? null : Promise.reject(error));

async function readPreview(sdk, { table, count, id }) {
  const response = await sdk.request(`${sdk.baseURL}/api/now/uxf/databroker/exec`, { method: 'POST',
    body: JSON.stringify([{ definitionSysId: BROKER, inputValues: { ruleId: { type: 'JSON_LITERAL', value: id } } }]) });
  const result = response?.result?.[0];
  const output = result?.executionResult?.output;
  // An unknown job answers 200 with no rows, so an empty preview is a failure, never "nothing cascades".
  if (result?.status !== 200 || result.errors?.length || !Array.isArray(output?.rows) || !output.rows.length || !Array.isArray(output.messages)) {
    throw new Error(`Cascade preview returned no result${result?.errors?.length ? `: ${JSON.stringify(result.errors)}` : ''}.`);
  }
  // The broker's table column is a display label; read raw names joined on the job's sys_id.
  const rows = await listRecords(sdk, { table: 'sys_dm_delete_count',
    params: recordListParams({ query: `dm_delete=${id}`, fields: ['table', 'preview_record_count'], limit: 1000, displayValue: 'false' }) });
  if (rows.length !== output.rows.length) throw new Error(`Cascade preview listed ${output.rows.length} table(s) but sys_dm_delete_count holds ${rows.length} for the job.`);
  const tables = rows.map(r => ({ table: r.table, count: Number(r.preview_record_count) })).sort((a, b) => b.count - a.count);
  if (tables.some(t => !t.table || !Number.isSafeInteger(t.count) || t.count < 0)) throw new Error('Cascade preview returned an unreadable table or count.');
  if (!tables.some(t => t.table === table && t.count === count)) throw new Error(`Cascade preview did not count ${count} record(s) in ${table}, the live count.`);
  // The broker always adds its replication-lag note and puts the "more levels" warning before it.
  return { tables, more_levels: output.messages.length > 1, messages: output.messages };
}

export async function previewCascade(sdk, { table, query, count, keepJob }) {
  if (!await sdk.get('sys_ux_data_broker_transform', BROKER).catch(absent)) {
    throw errUsage(`This instance has no Data Management cascade preview (data broker ${BROKER}). No delete job was created.`);
  }
  const job = await sdk.create('sys_dm_delete', { table, condition: query, name: `jsn cascade preview: ${table}`,
    description: 'Created by jsn records delete-many --preview-cascade. It previews only and deletes nothing unless executed.' });
  const id = job?.sys_id;
  if (!/^[0-9a-f]{32}$/.test(id || '')) throw new Error('Delete job insert returned no sys_id; look for a "jsn cascade preview" job in sys_dm_delete.');
  let preview;
  let failure;
  try { preview = await readPreview(sdk, { table, count, id }); }
  catch (error) { failure = error; }
  let status = 'kept';
  if (!keepJob) {
    try {
      await sdk.delete('sys_dm_delete', id);
      status = await sdk.get('sys_dm_delete', id).catch(absent) ? 'still present' : 'deleted';
    } catch (error) { status = `delete failed: ${error.message}`; }
  }
  if (failure) {
    failure.message += status === 'deleted' ? ' The preview job was deleted.' : ` Delete job ${job.number} (${id}) was left in sys_dm_delete: ${status}.`;
    throw failure;
  }
  return { job: { number: job.number, sys_id: id, status }, ...preview };
}
