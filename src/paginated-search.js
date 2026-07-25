/**
 * Paginated interactive search prompt with server-side pagination.
 *
 * Uses raw stdin for terminal control — no readline interference.
 *
 * Returns the selected choice ({name, value}), or null on cancel.
 */

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
    process.stdout.write('\x1b[0J');

    const buf = [];

    const countInfo = totalCount > 0 ? ` (${loaded} of ${totalCount} loaded)` : '';
    buf.push(`${message}${countInfo}`);

    const start = Math.max(0, active - Math.floor(PAGE / 2));
    const end = Math.min(choices.length, start + PAGE);
    const visible = choices.slice(start, end);

    for (let i = 0; i < visible.length; i++) {
      const choice = visible[i];
      const isActive = (start + i) === active;
      const prefix = isActive ? '\x1b[7m' : '';
      const suffix = isActive ? '\x1b[0m' : '';
      const display = choice.name.length > 70 ? choice.name.slice(0, 67) + '...' : choice.name;
      buf.push(`  ${prefix}${display}${suffix}\x1b[0K`);
    }

    while (buf.length < PAGE + 2) {
      buf.push('\x1b[0K');
    }

    const more = loaded < totalCount;
    const footer = more
      ? `↑↓ navigate • ⏎ select • esc cancel • type to filter • ↓ at end loads more`
      : `↑↓ navigate • ⏎ select • esc cancel • type to filter`;
    buf.push(footer + '\x1b[0K');
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
    process.stdin.removeAllListeners('data');
    process.stdin.pause();
  }

  return new Promise((resolve) => {
    process.stdin.setRawMode(true);
    process.stdin.resume();

    let inputBuf = '';
    let escapeSeq = '';

    async function loadPage() {
      if (loaded >= totalCount) return;
      const startLen = choices.length;
      const newItems = await source('', loaded);
      if (newItems.length > 0) {
        choices = choices.concat(newItems);
        loaded = Math.min(choices.length, totalCount);
      }
      if (choices.length === startLen) {
        loaded = totalCount;
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

    function handleKey(keyName, char) {
      if (keyName === 'escape' || keyName === 'q' || (keyName === 'c' && escapeSeq.startsWith('\x1b'))) {
        cancelled = true;
        cleanup();
        resolve(null);
        return;
      }

      if (keyName === 'return' || char === '\r') {
        if (choices.length > 0 && active >= 0 && active < choices.length) {
          cleanup();
          resolve(choices[active]);
          return;
        }
      }

      if (keyName === 'up' && active > 0) {
        active--;
        render();
        return;
      }

      if (keyName === 'down') {
        if (active < choices.length - 1) {
          active++;
          render();
        } else if (loaded < totalCount) {
          loadPage().then(() => {
            if (active < choices.length - 1) active++;
            render();
          });
        }
        return;
      }

      if (keyName === 'backspace') {
        if (inputBuf.length > 0) {
          inputBuf = inputBuf.slice(0, -1);
          term = inputBuf;
          doSearch();
        }
        return;
      }

      // Printable character
      if (char && char.length === 1 && char >= ' ' && char <= '~') {
        inputBuf += char;
        term = inputBuf;
        doSearch();
        return;
      }
    }

    async function doSearch() {
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
    }

    process.stdin.on('data', (data) => {
      const str = data.toString();

      // Handle escape sequences (arrow keys, etc.)
      if (str === '\x1b') {
        escapeSeq = '\x1b';
        return;
      }

      if (escapeSeq) {
        escapeSeq += str;
        // Full escape sequence received
        if (escapeSeq === '\x1b[A') { handleKey('up'); }
        else if (escapeSeq === '\x1b[B') { handleKey('down'); }
        else if (escapeSeq === '\x1b[C') { handleKey('right'); }
        else if (escapeSeq === '\x1b[D') { handleKey('left'); }
        else if (escapeSeq === '\x1b[3~') { handleKey('delete', '\x7f'); }
        else if (escapeSeq === '\x1b[Z') { handleKey('tab', '\t'); }
        else if (escapeSeq === '\x1b[H') { handleKey('home'); }
        else if (escapeSeq === '\x1b[F') { handleKey('end'); }
        else { handleKey('escape'); }
        escapeSeq = '';
        return;
      }

      // Ctrl+C
      if (str === '\x03') {
        cancelled = true;
        cleanup();
        resolve(null);
        return;
      }

      // Enter
      if (str === '\r' || str === '\n') {
        handleKey('return', '\r');
        return;
      }

      // Backspace (Ctrl+H or DEL)
      if (str === '\x7f' || str === '\x08') {
        handleKey('backspace');
        return;
      }

      // Tab
      if (str === '\t') {
        handleKey('tab', '\t');
        return;
      }

      // Regular character
      handleKey(null, str);
    });
  });
}
