/**
 * Capture command definitions registered by a yargs command module.
 * The mock keeps the builder chainable while preserving string and object
 * command definitions in one normalized shape.
 */
export function captureCommands(command) {
  const commands = [];
  const yargs = {
    command(definition, builder, handler) {
      commands.push(typeof definition === 'string'
        ? { command: definition, builder, handler }
        : definition);
      return yargs;
    },
    option: () => yargs,
    options: () => yargs,
    positional: () => yargs,
    demandCommand: () => yargs,
    strict: () => yargs,
    check: () => yargs,
    middleware: () => yargs,
  };
  command.builder(yargs);
  return commands;
}

export const captureSubcommands = captureCommands;

export function findCommand(command, definition) {
  const commands = Array.isArray(command) ? command : captureCommands(command);
  return commands.find((entry) => entry?.command === definition
    || (typeof entry?.command === 'string' && entry.command.split(' ')[0] === definition));
}

export function findHandler(command, definition) {
  return findCommand(command, definition)?.handler;
}

/** Adapt command handlers to the production convention: app lives on argv. */
export function wrapHandler(handler) {
  return async (argv) => handler(argv, argv.app);
}
