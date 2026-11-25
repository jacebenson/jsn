import { deferredFamilyDefinition } from '../command-families.js';
import { inventoryCompareCommand } from '../instance-inventory.js';

export const pluginsCmd = wrap => ({
  ...deferredFamilyDefinition('plugins'),
  builder: p => p.command(inventoryCompareCommand(wrap, 'plugins')),
  handler: wrap(async (_argv, app) => app.ok({ commands: ['compare'] }, { summary: 'Use jsn compare --source pdi --target vendor for both inventories; jsn plugins compare --source pdi --target vendor for plugins only' })),
});
