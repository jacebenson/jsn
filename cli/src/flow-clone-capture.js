import { SaxesParser } from 'saxes';
import { isSysId } from './resolve-record.js';

// Reuse the previously reviewed strict parent/version XML contract.
export function verifyCopyCapture(payload, flowId, versionId) {
  if (typeof payload !== 'string' || !isSysId(versionId)) return false;
  const parser = new SaxesParser({ xmlns: false });
  const stack = [];
  const parents = [];
  let parent;
  let invalid = false;
  parser.on('doctype', () => { invalid = true; });
  parser.on('error', () => { invalid = true; });
  parser.on('opentag', tag => {
    stack.push(tag.name);
    if (tag.name === 'sys_hub_flow') {
      if (parent) invalid = true;
      parent = { depth: stack.length, fields: {} };
      parents.push(parent);
    } else if (parent && stack.length === parent.depth + 1 && ['sys_id', 'version_record'].includes(tag.name)) {
      if (Object.hasOwn(parent.fields, tag.name)) invalid = true;
      parent.fields[tag.name] = '';
    }
  });
  const text = value => {
    if (parent && stack.length === parent.depth + 1 && Object.hasOwn(parent.fields, stack.at(-1))) parent.fields[stack.at(-1)] += value;
  };
  parser.on('text', text);
  parser.on('cdata', text);
  parser.on('closetag', () => {
    if (parent && stack.length === parent.depth) parent = undefined;
    stack.pop();
  });
  try { parser.write(payload).close(); } catch { return false; }
  return !invalid && parents.length === 1 && parents[0].fields.sys_id?.trim() === flowId && parents[0].fields.version_record?.trim() === versionId;
}
