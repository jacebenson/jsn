(() => {
  const data = JSON.parse(document.querySelector('#document-data').textContent);
  const content = document.querySelector('#document-content');
  if (!window.marked || !window.DOMPurify) return;
  content.innerHTML = DOMPurify.sanitize(marked.parse(JSNMarkdown.normalize(data.body), { gfm: true, breaks: false }));
  // Markdown escapes/emphasis sometimes appear inside raw HTML table cells.
  // Parse only text leaves, excluding code and links, then sanitize again.
  const textLeaves = [];
  const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (node.parentElement.closest('td,th') && !node.parentElement.closest('code,pre,a') &&
        /\\[()_]|`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\(/.test(node.textContent)) textLeaves.push(node);
  }
  const inlineRenderer = new marked.Renderer();
  inlineRenderer.html = ({ text }) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  textLeaves.forEach(node => {
    const template = document.createElement('template');
    template.innerHTML = DOMPurify.sanitize(marked.parseInline(node.textContent, { renderer: inlineRenderer }));
    node.replaceWith(template.content);
  });
  // The reader already supplies a title; avoid a second competing page heading.
  const firstHeading = content.querySelector('h1');
  const titleKey = text => String(text || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (firstHeading === content.firstElementChild && titleKey(firstHeading?.textContent) === titleKey(data.title)) firstHeading.remove();
  const baseName = (data.title || '').split(/\s+-\s+/)[0];
  const seen = new Map();
  content.querySelectorAll('h1,h2,h3,h4').forEach((heading, index) => {
    const original = heading.textContent;
    const slug = original.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || `section-${index}`;
    const occurrence = seen.get(slug) || 0;
    seen.set(slug, occurrence + 1);
    heading.id = occurrence ? `${slug}-${occurrence}` : slug;
    heading.tabIndex = -1;
    if (heading.matches('h2')) {
      let label = original.replace(/^(Client side|Server side)\s+/i, '');
      if (baseName && label.startsWith(baseName + ' - ')) label = label.slice(baseName.length + 3);
      if (label !== original) heading.textContent = label;
      ['desktop-toc', 'mobile-toc'].forEach(id => {
        const link = document.createElement('a');
        link.href = '#' + heading.id;
        link.textContent = label;
        link.title = original;
        document.getElementById(id).append(link);
      });
    }
    const permalink = document.createElement('a');
    permalink.className = 'heading-permalink';
    permalink.href = '#' + heading.id;
    permalink.setAttribute('aria-label', 'Link to ' + heading.textContent);
    permalink.textContent = '#';
    heading.append(permalink);
  });
  content.querySelectorAll('a[href]').forEach(link => {
    const href = link.getAttribute('href');
    if (href.startsWith('#')) return;
    try {
      let docPath;
      const url = new URL(href, 'https://docs.local/' + data.path);
      const prefix = `/ServiceNow/ServiceNowDocs/${data.branch}/markdown/`;
      if (url.hostname === 'raw.githubusercontent.com' && url.pathname.startsWith(prefix)) {
        docPath = decodeURIComponent(url.pathname.slice(prefix.length));
        if (docPath.startsWith(data.branch + '/')) docPath = docPath.slice(data.branch.length + 1);
      } else if (url.hostname === 'docs.local' && url.pathname.endsWith('.md')) {
        docPath = decodeURIComponent(url.pathname.slice(1));
      }
      if (docPath) link.href = '/documentation/read?' + new URLSearchParams({ path: docPath }) + url.hash;
      else if (url.protocol === 'https:' || url.protocol === 'http:') { link.rel = 'noopener noreferrer'; }
    } catch { /* Leave sanitized, non-document links alone. */ }
  });
  content.querySelectorAll('table').forEach(table => {
    const wrapper = document.createElement('div');
    wrapper.className = 'table-scroll';
    wrapper.tabIndex = 0;
    wrapper.setAttribute('role', 'region');
    wrapper.setAttribute('aria-label', 'Reference table, scroll horizontally if needed');
    table.before(wrapper);
    wrapper.append(table);
  });
  content.querySelectorAll('pre').forEach(pre => {
    const code = pre.querySelector('code');
    if (!code) return;
    const frame = document.createElement('div');
    frame.className = 'code-frame';
    const bar = document.createElement('div');
    bar.className = 'code-toolbar';
    const language = document.createElement('span');
    const declared = [...code.classList].find(name => name.startsWith('language-'))?.slice(9);
    language.textContent = declared || (/\b(var|const|function|new|return)\b/.test(code.textContent) ? 'javascript' : 'example');
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.textContent = 'Copy code';
    copy.setAttribute('aria-live', 'polite');
    const source = code.textContent;
    copy.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(source); copy.textContent = 'Copied ✓'; }
      catch { copy.textContent = 'Select code to copy'; }
    });
    bar.append(language, copy);
    pre.before(frame);
    frame.append(bar, pre);
    // Small, safe lexical coloring. Tokens are text nodes, never injected HTML.
    if (['javascript', 'js'].includes(language.textContent)) {
      const tokens = source.matchAll(/(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|\b(var|let|const|function|return|new|if|else|while|true|false|null|undefined|for)\b|\b(\d+)\b/g);
      code.textContent = '';
      let last = 0;
      for (const token of tokens) {
        code.append(document.createTextNode(source.slice(last, token.index)));
        const span = document.createElement('span');
        span.className = token[1] ? 'syntax-comment' : token[2] ? 'syntax-string' : token[3] ? 'syntax-keyword' : 'syntax-number';
        span.textContent = token[0];
        code.append(span);
        last = token.index + token[0].length;
      }
      code.append(document.createTextNode(source.slice(last)));
    }
  });
  const headings = content.querySelectorAll('h2[id]');
  if (!headings.length) {
    document.querySelector('.reader-toc').hidden = true;
    document.querySelector('.mobile-contents').hidden = true;
  }
  const observer = new IntersectionObserver(entries => {
    const active = entries.find(entry => entry.isIntersecting);
    if (!active) return;
    document.querySelectorAll('#desktop-toc a, #mobile-toc a').forEach(link => {
      const current = link.hash === '#' + active.target.id;
      link.classList.toggle('current', current);
      if (current) link.setAttribute('aria-current', 'location'); else link.removeAttribute('aria-current');
    });
  }, { rootMargin: '-10% 0px -65% 0px' });
  headings.forEach(heading => observer.observe(heading));
})();
