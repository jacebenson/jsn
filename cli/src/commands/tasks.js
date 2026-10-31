import { buildTicketCommands } from './_ticket.js';

const taskDefaultColumns = ['number', 'short_description', 'state', 'assigned_to'];

export function tasksCmd(wrap) {
  return buildTicketCommands('sc_task', 'tasks', 'task', taskDefaultColumns, {}, null, wrap);
}
