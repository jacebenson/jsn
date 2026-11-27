import { deferredFamilyDefinition } from '../command-families.js';
import { inventoryCompareCommand } from '../instance-inventory.js';
import { readDependencyTree, formatPluginTree } from '../plugins.js';

const showCommand = wrap => ({
  command: 'show <id>', describe: 'Show a plugin and every plugin it requires, nested (read-only)',
  builder: p => p.strict().positional('id', { type: 'string', describe: 'Plugin id, such as com.snc.incident' })
    .epilogue('jsn plugins show com.glide.ui.ng.amb\njsn plugins show com.snc.pa.premium --json\njsn plugins show com.snc.pa.premium --get data.inactive\nA required id v_plugin does not list is reported as not listed, never as missing; a plugin id it does not list is not found. Cycles are named and not followed.'),
  handler: wrap(async (argv, app) => {
    app.requireInstance();
    const data = await readDependencyTree(app.sdk, argv.id);
    Object.defineProperty(data, '_formatted', { value: formatPluginTree(data), enumerable: false });
    app.ok(data, { summary: `${data.plugin.id}: ${data.count} dependencies, ${data.inactive.length} inactive${data.complete ? '' : ' (incomplete)'}` });
  }),
});

export const pluginsCmd = wrap => ({
  ...deferredFamilyDefinition('plugins'),
  builder: p => p.command(inventoryCompareCommand(wrap, 'plugins')).command(showCommand(wrap)),
  handler: wrap(async (_argv, app) => app.ok({ commands: ['compare', 'show'] }, { summary: 'jsn plugins show <id> for a plugin and its nested dependencies; jsn plugins compare --source pdi --target vendor for plugins only; jsn compare for plugins and Store apps' })),
});
