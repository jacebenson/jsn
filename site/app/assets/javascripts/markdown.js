// Compatibility fixes for upstream Markdown. This is presentation-only: the
// stored source and REST document body remain untouched.
(() => {
  function normalize(source) {
    const lines = String(source || '').replace(/\r\n?/g, '\n').split('\n');
    const output = [];
    let fence = null;
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index];
      const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
      if (fence) {
        output.push(line);
        if (marker && marker[1][0] === fence.char && marker[1].length >= fence.length && !marker[2].trim()) fence = null;
        continue;
      }
      if (marker) {
        fence = { char: marker[1][0], length: marker[1].length };
        output.push(line);
        continue;
      }
      // Indented code is literal too. Never repair HTML inside a code example.
      if (/^(?: {4}|\t)/.test(line)) { output.push(line); continue; }
      // GitHub source sometimes joins a closing HTML block and a GFM table,
      // or provides no blank line between them. Marked then treats the table
      // as raw HTML text. Only split at an actual block close at line start.
      const joined = line.replace(/^(\s*<\/(?:table|div|details|section|figure)>)[ \t]*(?=\|)/i, '$1\n\n');
      output.push(joined);
      if (/<\/(?:table|div|details|section|figure)>\s*$/i.test(joined) &&
          /^\s*(?:\|[^\n]+\||#{1,6}\s|[-*+]\s|\d+\.\s)/.test(lines[index + 1] || '')) {
        output.push('');
      }
    }
    return output.join('\n');
  }
  globalThis.JSNMarkdown = Object.freeze({ normalize });
})();
