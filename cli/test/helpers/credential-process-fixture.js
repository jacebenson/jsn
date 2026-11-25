// Subprocess test transport only. This module is never imported by production.
// Model an empty secure store with unavailable writes, rather than depending on
// PATH tricks or reading the operator's real Linux/Windows credential backend.
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';

const original = childProcess.execFileSync;
childProcess.execFileSync = function(command, args, options) {
  const name = String(command).split(/[\\/]/).at(-1).toLowerCase();
  if (name === 'secret-tool') {
    if (args[0] === 'lookup' || args[0] === 'clear') return '';
    throw new Error('Synthetic secure-store writes unavailable');
  }
  if (name === 'powershell.exe' || name === 'pwsh.exe') {
    const request = JSON.parse(options.input);
    if (request.operation === 'read' || request.operation === 'delete') return '{"status":"missing"}';
    if (request.operation === 'read_many') {
      return JSON.stringify({ status: 'ok', values: request.targets.map(target => ({ target, value: null })) });
    }
    throw new Error('Synthetic secure-store writes unavailable');
  }
  return original.call(this, command, args, options);
};
syncBuiltinESMExports();
