// The Rails adapter uses this JSON-lines bridge to the same Node search engine.
import readline from 'node:readline';
import { DocumentationIndex, documentationSummary } from './index.js';
let index;
try {
  for await (const line of readline.createInterface({ input: process.stdin, crlfDelay: Infinity })) {
    try {
      const { operation, arguments: args = {} } = JSON.parse(line);
      if (operation !== 'summary') index ||= new DocumentationIndex(process.env.DOCS_STORAGE_DIR);
      const value = operation === 'summary' ? documentationSummary(args) : operation === 'revision' ? index.revision()
        : operation === 'search' ? index.search(args) : operation === 'document' ? index.document(args) : null;
      process.stdout.write(JSON.stringify({ value }) + '\n');
    } catch (error) { process.stdout.write(JSON.stringify({ error: error.status ? error.message : 'Documentation search is temporarily unavailable.', status: error.status || 503 }) + '\n'); }
  }
} finally { index?.close(); }
