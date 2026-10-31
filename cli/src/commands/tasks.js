import { buildProfileCommand } from '../record-profiles.js';

export function tasksCmd(wrap) {
  return buildProfileCommand('tasks', wrap);
}
