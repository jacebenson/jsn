import { declareCapabilities } from '../capabilities.js';
import { DOCUMENT_BUDGETS, collectInstanceDocumentation, renderInstanceDocumentation, writeDocumentFile } from '../instance-documentation.js';

declareCapabilities('document', { mutationSubcommands: [], skipDailyChecks: true });

export function documentCmd(wrap) {
  return {
    command: 'document',
    describe: 'Create bounded read-only instance configuration documentation',
    builder: y => y.command({
      command: 'instance',
      describe: 'Generate deterministic Markdown/Mermaid from safe metadata. Requires --profile.',
      builder: child => {
        child.option('output', { type: 'string', describe: 'New Markdown file; never overwrites. POSIX mode 0600; Windows inherits directory ACLs; use a private directory.' });
        for (const [name, [fallback, min, max]] of Object.entries(DOCUMENT_BUDGETS)) {
          const flag = name.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`);
          child.option(flag, { type: 'number', default: fallback, describe: `${name} budget (${min}–${max})` });
        }
        return child;
      },
      handler: wrap(async (argv, app) => {
        const data = await collectInstanceDocumentation(argv, app);
        data.markdown = renderInstanceDocumentation(data);
        app.output.validateExtraction(data);
        if (argv.output) writeDocumentFile(argv.output, data.markdown);
        const human = !app.output.jqFilter && ['styled', 'markdown'].includes(app.output.effectiveFormat());
        app.output.ok(human ? data.markdown : data);
      }),
    }).demandCommand(1),
  };
}
