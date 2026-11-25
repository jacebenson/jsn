import { registerHooks } from 'node:module';
import fs from 'node:fs';
const loaded = [];
registerHooks({ load(url, context, nextLoad) {
  const result = nextLoad(url, context);
  if (url.includes('/src/')) loaded.push(url);
  return result;
} });
process.on('exit', () => fs.writeFileSync(process.env.JSN_TEST_MODULE_TRACE, JSON.stringify(loaded)));
