/**
 * Minimal paginated interactive search prompt.
 *
 * Replaces @inquirer/search with a direct readline implementation that
 * supports true server-side pagination — when the user arrows down past
 * the last loaded item, the next page is fetched from the source callback.
 *
 * Returns the selected choice (with .value and .name), or null on cancel.
 */

import readline from 'node:readline';

export async function paginatedSearch({ message, pageSize, totalCount, source }) {
  let choices = [];
  let active = 0;
  let loaded = 0;
  let cancelled = false;
  let selected = null;
  let currentTerm = '';
  let hasRendered = false;

  // Render the picker to stdout — uses ANSI save/restore to anchor in place
  function render(term) {
    const buf = [];

    // ANSI: restore cursor to anchor point and clear below
    if (hasRendered) {
      buf.push('\x1b[u\x1b[J');
    }

    // Header
    buf.push(message);

    // Visible page
    const startIdx = Math.max(0, active - Math.floor(pageSize / 2));
    const endIdx = Math.min(choices.length, startIdx + pageSize);
    const visibleSlice = choices.slice(startIdx, endIdx);

    for (let i = 0; i < visibleSlice.length; i++) {
      const choice = visibleSlice[i];
      const isActive = (startIdx + i) === active;
      const prefix = isActive ? '\x1b[7m' : '';
      const suffix = isActive ? '\x1b[0m' : '';
      const name = choice.name.length > 60 ? choice.name.slice(0, 57) + '...' : choice.name;
      buf.push(`  ${prefix}${name}${suffix}`);
    }

    // Fill empty slots so the picker height stays constant
    const maxVisible = Math.min(pageSize, totalCount);
    while (buf.length < maxVisible + 2) { // +1 for header, +1 more for spacing
      buf.push('');
    }

    // Footer with progress
    const moreAvailable = loaded < totalCount;
    const footer = moreAvailable
      ? `${loaded} of ${totalCount} loaded • ↓ for more • ↑↓ navigate • ⏎ select • esc cancel • type to filter`
      : `${loaded} of ${totalCount} • ↑↓ navigate • ⏎ select • esc cancel • type to filter`;
    buf.push('');
    buf.push(footer);

    // Search bar
    buf.push(`> ${term}`);

    // First render: save cursor position so re-renders anchor here
    if (!hasRendered) {
      process.stdout.write('\x1b[s');
      hasRendered = true;
    }

    process.stdout.write(buf.join('\n'));
  }

  function cleanup() {
    // Restore cursor to anchor and clear below
    if (hasRendered) {
      process.stdout.write('\x1b[u\x1b[J');
      hasRendered = false;
    }
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }
  }

  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });

    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }

    let inputBuffer = '';

    async function loadMore() {
      if (loaded >= totalCount) return;
      const newChoices = await source(currentTerm, loaded);
      if (newChoices.length > 0) {
        choices.push(...newChoices);
        loaded = choices.length;
      }
    }

    // Initial load
    (async () => {
      const initialChoices = await source(currentTerm, 0);
      if (cancelled) return;
      choices = initialChoices;
      loaded = choices.length;
      active = 0;
      render(currentTerm);
    })();

    rl.input.on('keypress', async (_char, key) => {
      if (key.name === 'escape' || key.name === 'q' || (key.ctrl && key.name === 'c')) {
        cancelled = true;
        rl.close();
        return;
      }

      if (key.name === 'return' || key.name === 'enter') {
        if (choices.length > 0 && active >= 0 && active < choices.length) {
          selected = choices[active];
        }
        rl.close();
        return;
      }

      if (key.name === 'up') {
        if (active > 0) {
          active--;
          render(currentTerm);
        }
        return;
      }

      if (key.name === 'down') {
        if (active < choices.length - 1) {
          active++;
          render(currentTerm);
        } else if (loaded < totalCount) {
          await loadMore();
          if (active < choices.length - 1) {
            active++;
          }
          render(currentTerm);
        }
        return;
      }

      if (key.name === 'backspace') {
        if (inputBuffer.length > 0) {
          inputBuffer = inputBuffer.slice(0, -1);
        }
      } else if (key.sequence && key.sequence.length === 1 && !key.meta && !key.ctrl) {
        inputBuffer += key.sequence;
      } else {
        return;
      }

      // Search/filter — re-fetch from server
      currentTerm = inputBuffer;
      const results = await source(currentTerm, 0);
      choices = results;
      loaded = results.length;
      active = 0;
      render(currentTerm);
    });

    rl.on('close', () => {
      cleanup();
      resolve(cancelled ? null : selected);
    });
  });
}
