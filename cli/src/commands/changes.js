import { buildTicketCommands } from './_ticket.js';

const changeDefaultColumns = ['number', 'short_description', 'risk', 'state', 'assigned_to'];

export function changesCmd(wrap) {
  return buildTicketCommands('change_request', 'changes', 'chg', changeDefaultColumns, {}, null, wrap);
}
