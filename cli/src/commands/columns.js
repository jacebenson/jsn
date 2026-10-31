import { buildDevCmd } from './_generic.js';

export const columnsCmd = (wrap) => {
  const base = buildDevCmd('columns', 'sys_dictionary', ['column', 'col'],
    ['element', 'column_label', 'internal_type', 'mandatory', 'max_length', 'active'],
    wrap, { singular: 'column', scopeValidation: true });

  // Add --table filter
  const origBuilder = base.builder;
  base.builder = (yargs) => {
    const built = origBuilder(yargs);
    // Patch the 'list' subcommand builder to add --table
    const listCmd = built._commands?.find(c => c.name === 'list' || c._aliases?.includes('ls'));
    if (listCmd) {
      const origListBuilder = listCmd.builder;
      listCmd.builder = (y) => (origListBuilder ? origListBuilder(y).option('table', { type: 'string', describe: 'Filter by table (e.g. incident)' }) : y.option('table', { type: 'string' }));
      const origHandler = listCmd.handler;
      listCmd.handler = async (argv) => {
        if (argv.table) argv.query = argv.query ? `${argv.query}^name=${argv.table}` : `name=${argv.table}`;
        return origHandler(argv);
      };
    }
    return built;
  };

  return base;
};
