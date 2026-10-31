import { buildProfileCommand } from '../record-profiles.js';

export function incidentsCmd(wrap) {
  return buildProfileCommand('incidents', wrap);
}
