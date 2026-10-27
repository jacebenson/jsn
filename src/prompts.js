import * as prompts from '@inquirer/prompts';

export class PromptCancelled extends Error {
  constructor() {
    super('Cancelled.');
    this.name = 'PromptCancelled';
  }
}

/** Add Escape cancellation to an Inquirer prompt without changing its answers. */
export function cancellablePrompt(prompt) {
  return async (config, context = {}) => {
    const input = context.input || process.stdin;
    const controller = new AbortController();
    const onKey = (_value, key) => {
      if (key?.name === 'escape') controller.abort(new PromptCancelled());
    };
    input.on('keypress', onKey);
    try {
      return await prompt({ ...config, message: `${config.message} (Esc to cancel)` }, {
        ...context,
        signal: context.signal ? AbortSignal.any([context.signal, controller.signal]) : controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) throw controller.signal.reason;
      throw error;
    } finally {
      input.removeListener('keypress', onKey);
    }
  };
}

export const input = cancellablePrompt(prompts.input);
export const password = cancellablePrompt(prompts.password);
export const select = cancellablePrompt(prompts.select);
export const search = cancellablePrompt(prompts.search);
export const confirm = cancellablePrompt(prompts.confirm);
export const checkbox = cancellablePrompt(prompts.checkbox);

// The editor prompt hands the keyboard to $EDITOR, so Escape belongs to that
// editor. It lives here so every command imports prompts from one module;
// cancelling an editor still uses Inquirer's Ctrl+C abort.
export const editor = prompts.editor;
