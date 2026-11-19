import { declareCapabilities } from '../capabilities.js';
import { inventoryCompareCommand } from '../instance-inventory.js';

declareCapabilities('plugins', { skipContextHeader: true });
export const pluginsCmd = wrap => ({
  command: 'plugins', describe: 'Inspect platform plugin differences across instances',
  builder: p => p.command(inventoryCompareCommand(wrap, 'plugins')),
  handler: wrap(async (_argv, app) => app.ok({ commands: ['compare'] }, { summary: 'Use jsn compare --source pdi --target vendor for both inventories; jsn plugins compare --source pdi --target vendor for plugins only' })),
});
