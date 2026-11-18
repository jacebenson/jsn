/**
 * JSN's interactive prompt surface, implemented on the local engine
 * (src/prompt-engine.js) instead of @inquirer/prompts.
 *
 * Callers use `prompt(config, { input, output, signal })`. Escape cancels
 * ordinary prompts with PromptCancelled; record pickers live in
 * paginated-search.js and resolve undefined instead.
 */

import { runPrompt, normalizeChoices, truncate, PromptCancelled, escapeResult } from './prompt-engine.js';
export { PromptCancelled };

const ESC_HINT = ' (Esc to cancel)';

function withHint(config) {
  const message = String(config.message ?? '');
  return message.includes(ESC_HINT) ? message : `${message}${ESC_HINT}`;
}

function applyValidate(validate, value) {
  if (typeof validate !== 'function') return null;
  const result = validate(value);
  return result instanceof Promise ? result : result;
}

async function validateAnswer(validate, value) {
  const result = await applyValidate(validate, value);
  if (result === true || result === undefined || result === '') return null;
  return typeof result === 'string' ? result : result === false ? 'Invalid value.' : null;
}

function textPrompt({ secret = false, defaultValue = null } = {}) {
  return async (config = {}, context = {}) => runPrompt({ ...config, message: withHint(config) }, context, {
    init: () => ({ buffer: '', error: '' }),
    async key(state, key, api) {
      if (key.name === 'return' || key.name === 'enter') {
        const value = state.buffer.length ? state.buffer : (config.default ?? defaultValue ?? '');
        const message = await validateAnswer(config.validate, value);
        if (message) { state.error = message; api.redraw(); return; }
        return { done: value };
      }
      if (key.name === 'backspace') {
        state.buffer = state.buffer.slice(0, -1);
        state.error = '';
        api.redraw();
        return;
      }
      if (key.name === 'space') {
        state.buffer += ' ';
        state.error = '';
        api.redraw();
        return;
      }
      if (key.text) {
        state.buffer += key.text;
        state.error = '';
        api.redraw();
        return;
      }
      if (key.name === 'c' && key.ctrl) return { cancel: true };
      api.redraw();
    },
    render(state) {
      const label = withHint(config);
      const suffix = config.default !== undefined && !secret ? ` (${config.default})` : '';
      // Secrets are never echoed: the placeholder has a fixed width, so
      // nothing about the typed value (characters or length) reaches stdout.
      const shown = secret ? (state.buffer.length ? '******' : '') : state.buffer;
      const error = state.error ? `\n  ${state.error}` : '';
      return `${label}${suffix}\n> ${shown}${error}`;
    },
  });
}

export const input = textPrompt();

export const password = textPrompt({ secret: true });

// Use the shared Escape contract and a masked prompt; codes stay ephemeral.
export async function mfaCode(config = {}, context = {}) {
  return password({
    ...config, mask: '*',
    validate: answer => /^\d{6}$/.test(String(answer ?? '').replace(/[\s-]/g, ''))
      || 'Enter the 6-digit code from your authenticator app.',
  }, context);
}

export async function confirm(config = {}, context = {}) {
  const fallback = config.default === undefined ? true : Boolean(config.default);
  return runPrompt({ ...config, message: withHint(config) }, context, {
    init: () => ({ value: '', error: '' }),
    key(state, key, api) {
      if (key.name === 'return' || key.name === 'enter') {
        const answer = /^y/i.test(state.value) ? true : /^n/i.test(state.value) ? false : fallback;
        return { done: answer };
      }
      if (key.name === 'backspace') state.value = state.value.slice(0, -1);
      else if (key.text) state.value += key.text;
      api.redraw();
    },
    render(state) {
      const hint = fallback ? '[Y/n]' : '[y/N]';
      return `${withHint(config)} ${hint} ${state.value}`;
    },
  });
}

export async function select(config = {}, context = {}) {
  const choices = normalizeChoices(config.choices || []);
  return runPrompt({ ...config, message: withHint(config) }, context, {
    init: () => ({ active: Math.max(firstEnabled(choices), choices.findIndex(choice => !choice.disabled && choice.value === config.default)) }),
    key(state, key, api) {
      if (key.name === 'return' || key.name === 'enter') {
        const choice = choices[state.active];
        if (!choice || choice.disabled) return;
        return { done: choice.value };
      }
      if (key.name === 'up') { state.active = move(choices, state.active, -1); api.redraw(); return; }
      if (key.name === 'down') { state.active = move(choices, state.active, 1); api.redraw(); return; }
      if (key.name === 'k') { state.active = move(choices, state.active, -1); api.redraw(); return; }
      if (key.name === 'j') { state.active = move(choices, state.active, 1); api.redraw(); return; }
    },
    render(state) {
      const lines = [withHint(config)];
      choices.forEach((choice, index) => {
        const marker = index === state.active ? '>' : ' ';
        lines.push(`${marker} ${choice.disabled ? `(disabled) ${choice.name}` : choice.name}`);
      });
      lines.push('', '  Use arrow keys, Enter to select.');
      return lines;
    },
  });
}

export async function search(config = {}, context = {}) {
  let request;
  const state = { term: '', choices: [], active: 0, loading: false, token: 0, error: '' };
  async function load(api) {
    request?.abort();
    request = new AbortController();
    const signal = context.signal ? AbortSignal.any([request.signal, context.signal]) : request.signal;
    const token = ++state.token;
    state.loading = true;
    state.error = '';
    state.active = 0;
    api.redraw();
    try {
      const items = await config.source?.(state.term, { signal });
      if (token !== state.token) return;
      state.choices = normalizeChoices(items || []);
    } catch (error) {
      if (token !== state.token) return;
      state.choices = [];
      state.error = error?.message || String(error);
    }
    if (token !== state.token) return;
    state.loading = false;
    state.active = firstEnabled(state.choices);
    api.redraw();
  }
  try {
    return await runPrompt({ ...config, message: withHint(config) }, context, {
      init: () => state,
      onReady: api => { void load(api); },
      key(_state, key, api) {
        if (key.name === 'return' || key.name === 'enter') {
          const choice = state.choices[state.active];
          if (!state.loading && choice && !choice.disabled) return { done: choice.value };
          return;
        }
        if (key.name === 'up' || key.name === 'down') {
          state.active = move(state.choices, state.active, key.name === 'up' ? -1 : 1);
          api.redraw();
          return;
        }
        const previous = state.term;
        if (key.name === 'backspace') state.term = state.term.slice(0, -1);
        else if (key.text) state.term += key.text;
        if (state.term !== previous) void load(api);
      },
      render() {
        const lines = [`${withHint(config)} Search: ${state.term}${state.loading ? ' ...' : ''}`];
        if (state.error) lines.push(`  ${state.error}`);
        else if (!state.choices.length) lines.push(state.loading ? '  Loading...' : '  No matches');
        else state.choices.forEach((choice, index) => lines.push(`${index === state.active ? '>' : ' '} ${truncate(choice.name)}`));
        lines.push('', '  Type to filter, arrows to move, Enter to select.');
        return lines;
      },
    });
  } finally {
    state.token += 1;
    request?.abort();
  }
}

export async function checkbox(config = {}, context = {}) {
  const choices = normalizeChoices(config.choices || []);
  return runPrompt({ ...config, message: withHint(config) }, context, {
    init: () => ({ active: firstEnabled(choices), picked: new Set(choices.flatMap((choice, index) => choice.checked && !choice.disabled ? [index] : [])), error: '' }),
    key(state, key, api) {
      if (key.name === 'return' || key.name === 'enter') {
        const values = choices.filter((_choice, index) => state.picked.has(index)).map(choice => choice.value);
        if (config.required && values.length === 0) {
          state.error = 'Select at least one option.';
          api.redraw();
          return;
        }
        return { done: values };
      }
      if (key.name === 'space') {
        if (choices[state.active] && !choices[state.active].disabled) {
          if (state.picked.has(state.active)) state.picked.delete(state.active);
          else state.picked.add(state.active);
          state.error = '';
          api.redraw();
        }
        return;
      }
      if (key.name === 'a' && key.ctrl) {
        choices.forEach((choice, index) => { if (!choice.disabled) state.picked.add(index); });
        api.redraw();
        return;
      }
      if (key.name === 'up') { state.active = move(choices, state.active, -1); api.redraw(); return; }
      if (key.name === 'down') { state.active = move(choices, state.active, 1); api.redraw(); return; }
    },
    render(state) {
      const lines = [withHint(config)];
      choices.forEach((choice, index) => {
        lines.push(`${index === state.active ? '>' : ' '} [${state.picked.has(index) ? 'x' : ' '}] ${choice.name}`);
      });
      if (state.error) lines.push(`  ${state.error}`);
      lines.push('', '  Space toggles, arrows move, Enter confirms.');
      return lines;
    },
  });
}

function firstEnabled(choices) {
  const index = choices.findIndex(choice => !choice.disabled);
  return index < 0 ? 0 : index;
}

function move(choices, active, delta) {
  let next = active + delta;
  while (next >= 0 && next < choices.length && choices[next].disabled) next += delta;
  if (next < 0 || next >= choices.length) return active;
  return next;
}

/**
 * Enter launches $EDITOR by default. Escape cancels before launch; once the
 * editor owns the keyboard, its own controls apply.
 */
export async function editor(config = {}, context = {}) {
  if (config.waitForUserInput !== false) {
    await runPrompt(config, context, {
      init: () => ({}),
      key(_state, key) {
        if (key.name === 'return' || key.name === 'enter') return { done: true };
      },
      render: () => [withHint(config), 'Press Enter to launch your preferred editor.'],
    });
  } else {
    (context.output || process.stdout).write(`${withHint(config)}\n`);
  }
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { spawn } = await import('node:child_process');

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jsn-editor-'));
  const file = path.join(directory, 'draft.txt');
  try {
    fs.writeFileSync(file, config.default ?? '', 'utf8');
    const [command, ...args] = editorCommand();
    await new Promise((resolve, reject) => {
      const child = spawn(command, [...args, file], {
        stdio: 'inherit',
        signal: context.signal,
        env: process.env,
      });
      child.on('error', reject);
      child.on('exit', (code, signal) => {
        if (code === 0) resolve();
        else reject(new Error(`Editor exited with ${signal ? `signal ${signal}` : `code ${code}`}`));
      });
    });
    return fs.readFileSync(file, 'utf8');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function editorCommand() {
  const spec = process.env.VISUAL || process.env.EDITOR || 'vi';
  return spec.trim().split(/\s+/);
}

/**
 * Kept for callers/tests that wrapped an Inquirer prompt with the Escape
 * contract. The engine owns Escape now, so this is a pass-through that
 * preserves the previous signature.
 */
export function cancellablePrompt(prompt) {
  return async (config, context = {}) => prompt(config, context);
}

export { escapeResult };
