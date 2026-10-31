import { buildTicketCommands } from './_ticket.js';

const incidentDefaultColumns = ['number', 'short_description', 'priority', 'state', 'assigned_to'];

export function incidentsCmd(wrap) {
  return buildTicketCommands('incident', 'incidents', 'inc', incidentDefaultColumns, {}, null, wrap);
}
