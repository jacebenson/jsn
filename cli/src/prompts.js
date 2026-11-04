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

export const input = lazyPrompt('input');
export const password = lazyPrompt('password');
export const select = lazyPrompt('select');
export const search = lazyPrompt('search');
export const confirm = lazyPrompt('confirm');
export const checkbox = lazyPrompt('checkbox');

// Masked six-digit authenticator code. It reuses the password prompt so the
// code never echoes to the terminal, and only accepts the TOTP shape the
// instance will accept anyway. The value stays in memory for the duration of
// the challenge request and is never written to config, history, or logs.
export const mfaCode = async (config = {}) => {
  const prompts = await import('@inquirer/prompts');
  const value = await cancellablePrompt(prompts.password)({
    mask: '*',
    ...config,
    validate: (answer) => /^\d{6}$/.test(String(answer ?? '').replace(/[\s-]/g, ''))
      || 'Enter the 6-digit code from your authenticator app.',
  });
  return String(value ?? '');
};

// The editor prompt hands the keyboard to $EDITOR, so Escape belongs to that
// editor. It lives here so every command imports prompts from one module;
// cancelling an editor still uses Inquirer's Ctrl+C abort.
export const editor = async (...args) => (await import('@inquirer/prompts')).editor(...args);

// Load Inquirer only when a prompt is actually shown.
function lazyPrompt(name) {
  return async (...args) => {
    const prompts = await import('@inquirer/prompts');
    return cancellablePrompt(prompts[name])(...args);
  };
}
