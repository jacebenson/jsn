/**
 * Paginated interactive search prompt with server-side pagination.
 *
 * Uses raw readline for terminal control — @inquirer/search doesn't support
 * scroll-based pagination (source only fires on keystrokes, not on scroll).
 *
 * Returns the selected choice ({name, value}), or null on cancel.
 */

import readline from 'node:readline';

export async function paginatedSearch({ message, pageSize, totalCount, pageSize: pgSize, source }) {
  const PAGE = pageSize || pgSize || 10;
  let choices = [];
  let active = 0;
  let loaded = 0;
  let cancelled = false;
  let term = '';
  let outputLines = 0;

  // Write + track: returns number of newlines written
  function writeLines(lines) {
    const out = lines.join('\n');
    process.stdout.write(out);
    return lines.length - 1;
  }

  function render() {
    // Re-render: go back to anchor and clear everything below
    if (outputLines > 0) {
      process.stdout.moveCursor(0, -outputLines);
    }
    // Clear from cursor to end of screen (covers first render too)
    process.stdout.write('\x1b[0J');

    const buf = [];

    const countInfo = totalCount > 0 ? ` (${loaded} of ${totalCount} loaded)` : '';
    buf.push(`${message}${countInfo}`);

    // Visible window: center active item
    const start = Math.max(0, active - Math.floor(PAGE / 2));
    const end = Math.min(choices.length, start + PAGE);
    const visible = choices.slice(start, end);

    for (let i = 0; i < visible.length; i++) {
      const choice = visible[i];
      const isActive = (start + i) === active;
      const prefix = isActive ? '\x1b[7m' : '';
      const suffix = isActive ? '\x1b[0m' : '';
      const display = choice.name.length > 70 ? choice.name.slice(0, 67) + '...' : choice.name;
      const line = `  ${prefix}${display}${suffix}`;
      // Clear to end of line to prevent residual characters
      buf.push(line + '\x1b[0K');
    }

    // Pad to constant height
    while (buf.length < PAGE + 2) {
      buf.push('\x1b[0K');
    }

    // Footer
    const more = loaded < totalCount;
    const footer = more
      ? `↑↓ navigate • ⏎ select • esc cancel • type to filter • ↓ at end loads more`
      : `↑↓ navigate • ⏎ select • esc cancel • type to filter`;
    buf.push(footer + '\x1b[0K');

    // Search bar
    buf.push(`> ${term}\x1b[0K`);

    outputLines = writeLines(buf);
  }

  function cleanup() {
    if (outputLines > 0) {
      process.stdout.moveCursor(0, -outputLines);
      process.stdout.write('\x1b[0J');
      outputLines = 0;
    }
    try { process.stdin.setRawMode(false); } catch { /* ok */ }
  }

  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: false,  // Prevents readline from echoing/positioning cursor
    });
    try { process.stdin.setRawMode(true); } catch { /* non-TTY */ }

    let inputBuf = '';

    async function loadPage() {
      if (loaded >= totalCount) return;
      const startLen = choices.length;
      const newItems = await source('', loaded);
      if (newItems.length > 0) {
        choices = choices.concat(newItems);
        loaded = Math.min(choices.length, totalCount);
      }
      // If source returned fewer items than expected or nothing, we're done
      if (choices.length === startLen) {
        loaded = totalCount;  // prevent infinite retries
      }
    }

    // Initial load
    (async () => {
      const initial = await source('', 0);
      if (cancelled) return;
      choices = initial;
      loaded = Math.min(choices.length, totalCount || Infinity);
      active = 0;
      render();
    })();

    rl.input.on('keypress', async (_str, key) => {
      if (key.name === 'escape' || key.name === 'q' || (key.ctrl && key.name === 'c')) {
        cancelled = true;
        rl.close();
        return;
      }

      if (key.name === 'return' || key.name === 'enter') {
        if (choices.length > 0 && active >= 0 && active < choices.length) {
          rl.close();
          return;
        }
      }

      if (key.name === 'up' && active > 0) {
        active--;
        render();
        return;
      }

      if (key.name === 'down') {
        if (active < choices.length - 1) {
          active++;
          render();
        } else if (loaded < totalCount) {
          await loadPage();
          if (active < choices.length - 1) active++;
          render();
        }
        return;
      }

      if (key.name === 'backspace') {
        if (inputBuf.length > 0) inputBuf = inputBuf.slice(0, -1);
      } else if (key.sequence && key.sequence.length === 1 && !key.meta && !key.ctrl) {
        inputBuf += key.sequence;
      } else {
        return;
      }

      // Search
      term = inputBuf;
      if (term) {
        const results = await source(term, 0);
        choices = results;
        loaded = results.length;
      } else {
        const results = await source('', 0);
        choices = results;
        loaded = Math.min(results.length, totalCount || Infinity);
      }
      active = 0;
      render();
    });

    rl.on('close', () => {
      cleanup();
      const choice = (!cancelled && active >= 0 && active < choices.length) ? choices[active] : null;
      resolve(cancelled ? null : choice);
    });
  });
}
