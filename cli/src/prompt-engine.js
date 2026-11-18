/**
 * A small terminal prompt engine built on node:readline keypress events.
 *
 * This is deliberately not a general prompt library: it exists so JSN's
 * observed prompt surface (input, password, confirm, select, search,
 * checkbox, editor, paginated pickers) runs on Node built-ins with no
 * runtime dependency, while keeping the existing caller contract
 * `prompt(config, { input, output, signal })`.
 *
 * Every prompt restores raw mode and removes its listener in `finally`,
 * on success, Escape, Ctrl+C and thrown errors alike.
 */

import readline from 'node:readline';

export class PromptCancelled extends Error {
  constructor() {
    super('Cancelled.');
    this.name = 'PromptCancelled';
  }
}

/** Choices may be strings or { name, value, disabled }. */
export function normalizeChoices(choices = []) {
  return choices.map(choice => {
    if (choice && typeof choice === 'object') {
      return {
        name: String(choice.name ?? choice.value ?? ''),
        value: 'value' in choice ? choice.value : choice.name,
        disabled: Boolean(choice.disabled),
        checked: Boolean(choice.checked),
      };
    }
    return { name: String(choice), value: choice, disabled: false };
  });
}

export function truncate(text, width = 70) {
  const value = String(text ?? '');
  return value.length > width ? `${value.slice(0, width - 3)}...` : value;
}

/**
 * Run one interactive prompt.
 *
 * @param {object} config prompt config ({ message, ... })
 * @param {object} context { input, output, signal }
 * @param {object} spec
 *   init(config, context) -> state
 *   key(state, key, api) -> directive | undefined | Promise<...>
 *     directive: { done: value } finishes, { cancel: true } throws
 *                PromptCancelled, { escape: true } resolves undefined.
 *   render(config, state) -> string | string[]
 *   escapeValue — when the caller treats Escape as "leave this screen",
 *     pass a sentinel produced by `escapeResult(value)`.
 */
export async function runPrompt(config, context, spec) {
  const input = context.input || process.stdin;
  const output = context.output || process.stdout;
  const canRaw = typeof input.setRawMode === 'function';
  const previousRaw = canRaw ? Boolean(input.isRaw) : false;

  let state;
  let height = 0;
  let settled = false;
  let resolveDone;
  let rejectDone;

  const done = new Promise((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });

  const draw = () => {
    if (settled) return;
    const rendered = spec.render(state);
    const text = Array.isArray(rendered) ? rendered.join('\n') : String(rendered ?? '');
    if (output.isTTY && height > 0) output.write(`\x1b[${height}A\x1b[0J`);
    output.write(`${text}\n`);
    height = text.split('\n').length;
  };

  const finish = value => {
    if (settled) return;
    settled = true;
    resolveDone(value);
  };
  const fail = error => {
    if (settled) return;
    settled = true;
    rejectDone(error);
  };

  const api = { finish, fail, redraw: draw };
  let queue = Promise.resolve();
  const onKeypress = (_chunk, key) => {
    if (!key || settled) return;
    // Cancellation cannot wait behind validation or a source request.
    if (key.name === 'escape') {
      if (spec.escapeValue !== undefined) finish(spec.escapeValue.value);
      else fail(new PromptCancelled());
      return;
    }
    if (key.ctrl && (key.name === 'c' || key.name === 'd')) {
      fail(new PromptCancelled());
      return;
    }
    key = { ...key, text: !key.ctrl && !key.meta && typeof _chunk === 'string' && Array.from(_chunk).every(char => char.codePointAt(0) >= 32 && char.codePointAt(0) !== 127) ? _chunk : '' };
    // Serialize handling: a chunk can carry several keys at once, and async
    // handlers (search/load-more) must not reorder Enter ahead of arrows.
    queue = queue.then(async () => {
      if (settled) return;

      const directive = await spec.key(state, key, api);
      if (!directive || settled) return;
      if ('done' in directive) finish(directive.done);
      else if (directive.cancel) fail(new PromptCancelled());
      else if (directive.escape) finish(undefined);
    }).catch(error => fail(error));
  };

  const onAbort = () => fail(context.signal.reason || new PromptCancelled());
  const onEnd = () => fail(new PromptCancelled());

  try {
    readline.emitKeypressEvents(input);
    if (canRaw) input.setRawMode(true);
    input.on('keypress', onKeypress);
    input.on('end', onEnd);
    input.on('close', onEnd);
    input.on('error', fail);
    if (context.signal) {
      if (context.signal.aborted) onAbort();
      else context.signal.addEventListener('abort', onAbort, { once: true });
    }
    state = spec.init(config, context);
    if (input.readableEnded || input.destroyed) onEnd();
    if (typeof input.resume === 'function') input.resume();
    draw();
    spec.onReady?.(api);
    return await done;
  } finally {
    input.removeListener('keypress', onKeypress);
    input.removeListener('end', onEnd);
    input.removeListener('close', onEnd);
    input.removeListener('error', fail);
    if (context.signal) context.signal.removeEventListener('abort', onAbort);
    if (canRaw) {
      try { input.setRawMode(previousRaw); } catch { /* stream already closed */ }
    }
    if (typeof input.pause === 'function' && input.isTTY) input.pause();
  }
}

/** Escape resolves `value` instead of cancelling (record pickers). */
export function escapeResult(value) {
  return { value };
}
