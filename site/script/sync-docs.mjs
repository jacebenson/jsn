// Compatibility entry point for the website's scheduled task.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { syncDocumentation } from '../../cli/src/commands/docs/sync-service.js';
export { syncDocumentation };
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.stdout.write(JSON.stringify(await syncDocumentation()) + '\n'); }
  catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1; }
}
