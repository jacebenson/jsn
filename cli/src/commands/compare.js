import { declareCapabilities } from '../capabilities.js';
import { inventoryCompareCommand, compareInstanceInventory } from '../instance-inventory.js';

declareCapabilities('compare', { skipContextHeader: true, noImpersonateSubcommands: [''] });
export const compareCmd = wrap => ({
  ...inventoryCompareCommand(wrap, 'plugins'),
  command: 'compare',
  describe: 'Compare plugins AND Store apps; report how to align --target to desired --source (read-only)',
  handler: wrap(async (argv, app) => {
    const plugins = await compareInstanceInventory(argv, app, 'plugins', false);
    const store = await compareInstanceInventory(argv, app, 'store', false);
    const data = {
      source: plugins.source, target: plugins.target, complete: plugins.complete && store.complete,
      inventories: { plugins, store },
      counts: Object.fromEntries(Object.keys(plugins.counts).map(key => [key, plugins.counts[key] + store.counts[key]])),
      caveat: 'Distinct plugin and Store inventories can overlap. Counts are unique within each inventory, not a deduplicated product count. Recommendations are review guidance, never executable remediation.',
    };
    Object.defineProperty(data, '_formatted', { value: `${plugins._formatted}\n\n${store._formatted}\n\n${data.caveat}`, enumerable: false });
    app.ok(data, { summary: 'Align target to source: plugins and Store applications' });
    if (!data.complete) process.exitCode = 1;
  }),
});
