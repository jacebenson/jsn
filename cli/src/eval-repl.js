// Interactive background-script mode for `jsn eval --repl` (issue #397).
//
// The line-handling state machine lives here, apart from the readline/TTY
// plumbing, so it can be unit-tested without a terminal. Each `.exec`
// submission is a separate server request: variables do not carry over, and
// rollback context is recorded but never applied automatically.

import readline from 'node:readline';

export const REPL_COMMANDS = ['.exec', '.clear', '.help', '.exit'];

export const REPL_HELP = [
  'Interactive background-script mode.',
  '',
  '  .exec   Run everything typed since the last submission',
  '  .clear  Throw away the current buffer without running it',
  '  .help   Show this help',
  '  .exit   Leave the REPL (Ctrl+D does the same)',
  '',
  'A blank line keeps the buffer open; it never submits. Only .exec runs.',
  'Line starting with a dot is a REPL command, so a script line cannot begin',
  'with one.',
  '',
  'Each .exec is its own server request. JavaScript variables do not persist',
  'between submissions, while database writes do. Rollback context is recorded',
  'on the instance; it is not an automatic undo.',
].join('\n');

export function createReplState() {
  return { script: '' };
}

// Returns one of:
//   { action: 'continue' }            line appended, keep reading
//   { action: 'exec', script }        run this script, buffer cleared
//   { action: 'empty' }               .exec with nothing to run
//   { action: 'clear' }               buffer discarded
//   { action: 'help' }                print REPL_HELP
//   { action: 'exit' }                leave the REPL
export function handleReplLine(state, line) {
  const command = line.trim();

  if (command === '.exec') {
    if (!state.script.trim()) return { action: 'empty' };
    const script = state.script;
    state.script = '';
    return { action: 'exec', script };
  }
  if (command === '.clear') {
    state.script = '';
    return { action: 'clear' };
  }
  if (command === '.help') return { action: 'help' };
  if (command === '.exit') return { action: 'exit' };

  // Every other line accumulates, blank lines included. A blank line must not
  // submit a half-written script.
  state.script = state.script === '' ? line : `${state.script}\n${line}`;
  return { action: 'continue' };
}

export const REPL_BANNER_NOTE = 'One request per .exec. Variables do not persist; DB writes do.';

// TTY plumbing. `runScript` is supplied by the eval command so the REPL reuses
// the same execution path, scope resolution and mutation guards as --script.
export function runRepl({ runScript, instance, scope }) {
  return new Promise((resolve) => {
    const out = process.stdout;
    const state = createReplState();

    out.write(`jsn eval --repl  ·  instance: ${instance}  ·  scope: ${scope}\n`);
    out.write(`${REPL_BANNER_NOTE}\n`);
    out.write('.help for commands, .exec to run, Ctrl+D to exit.\n\n');

    const rl = readline.createInterface({
      input: process.stdin,
      output: out,
      terminal: true,
      prompt: 'jsn> ',
    });

    // EOF (Ctrl+D) can close readline while a script is still in flight, so
    // every prompt/resume has to check this. Calling resume() or prompt() on a
    // closed interface throws ERR_USE_AFTER_CLOSE.
    let closed = false;

    const prompt = () => {
      if (closed) return;
      rl.setPrompt(state.script ? '...> ' : 'jsn> ');
      rl.prompt();
    };

    rl.on('SIGINT', () => {
      if (state.script) {
        state.script = '';
        out.write('\n(buffer cleared)\n');
        prompt();
        return;
      }
      out.write('\n');
      rl.close();
    });

    rl.on('line', async (line) => {
      if (closed) return;
      const result = handleReplLine(state, line);

      if (result.action === 'exit') {
        rl.close();
        return;
      }
      if (result.action === 'clear') {
        out.write('(buffer cleared)\n');
        prompt();
        return;
      }
      if (result.action === 'help') {
        out.write(`\n${REPL_HELP}\n\n`);
        prompt();
        return;
      }
      if (result.action === 'empty') {
        out.write('(nothing to run)\n');
        prompt();
        return;
      }
      if (result.action === 'continue') {
        prompt();
        return;
      }

      // action === 'exec'
      out.write('\n');
      rl.pause();
      try {
        const output = await runScript(result.script);
        out.write(`${output ?? ''}\n`);
      } catch (err) {
        out.write(`Error: ${err.message}\n`);
      } finally {
        if (!closed) {
          rl.resume();
          out.write('\n');
          prompt();
        }
      }
    });

    rl.on('close', () => {
      closed = true;
      out.write('\n');
      resolve();
    });
  });
}

