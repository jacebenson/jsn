import { buildProfileCommand } from '../record-profiles.js';

export function changesCmd(wrap) {
  return buildProfileCommand('changes', wrap);
}
