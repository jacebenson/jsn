/**
 * Paginated, searchable record picker built on src/prompt-engine.js.
 *
 * Contract (unchanged from the Inquirer version):
 *   paginatedSearch({ message, pageSize, totalCount, source }, context?)
 *   source(term, offset, { signal }) -> [{ name, value }]
 *   Enter resolves the active choice object; Escape resolves undefined.
 *   Down at the last loaded row loads more while loaded < totalCount.
 */

import { runPrompt, normalizeChoices, truncate, escapeResult } from './prompt-engine.js';

export const paginatedSearch = async (config = {}, context = {}) => {
  const { message, pageSize = 10, totalCount = 0, source } = config;
  let request;
  const state = {
    status: 'loading',
    term: '',
    choices: [],
    active: 0,
    loaded: 0,
    searchMode: false,
    token: 0,
    error: '',
  };

  // Every request gets a token. A response may only be applied while its
  // token is still current, so a stale (slower) search can never replace
  // newer results or be selected by a later Enter.
  const isCurrent = token => token === state.token && state.status !== 'cancelled';

  async function load(term, offset, { append = false } = {}) {
    request?.abort();
    request = new AbortController();
    const signal = context.signal ? AbortSignal.any([request.signal, context.signal]) : request.signal;
    const token = ++state.token;
    state.status = 'loading';
    state.error = '';
    try {
      const items = normalizeChoices(await source(term || undefined, offset, { signal }) || []);
      if (!isCurrent(token)) return;
      state.choices = append ? state.choices.concat(items) : items;
      state.loaded = state.choices.length;
      state.active = Math.min(state.active, Math.max(0, state.choices.length - 1));
      state.status = 'done';
    } catch (error) {
      if (!isCurrent(token)) return;
      state.status = 'done';
      state.error = error?.message || String(error);
      if (!append) {
        state.choices = [];
        state.loaded = 0;
      }
      // A failed load-more keeps the rows already on screen.
    }
  }

  let api;
  const prompt = runPrompt({ ...config, message }, context, {
    escapeValue: escapeResult(undefined),
    init() {
      // Kick off the first page. Enter is ignored while status is 'loading',
      // so nothing is selectable until this resolves.
      state.pending = load('', 0);
      return state;
    },
    onReady(handle) {
      api = handle;
      state.pending.then(() => {
        if (state.status !== 'cancelled') api.redraw();
      });
    },
    key(_state, key, handle) {
      api = handle;
      if (key.name === 'return' || key.name === 'enter') {
        // No selecting a row while a request is in flight: the list on
        // screen may be about to change.
        if (state.status === 'loading' || !state.choices.length) return;
        const choice = state.choices[state.active];
        if (!choice) return;
        return { done: choice };
      }
      if (key.name === 'up') {
        if (state.active > 0) state.active -= 1;
        api?.redraw();
        return;
      }
      if (key.name === 'down') {
        if (state.status === 'loading') return;
        if (state.active < state.choices.length - 1) {
          state.active += 1;
          api?.redraw();
        } else if (!state.searchMode && state.loaded < totalCount) {
          const before = state.loaded;
          void load('', state.loaded, { append: true }).then(() => {
            if (state.status === 'done' && state.loaded > before) state.active = before;
            api?.redraw();
          });
          api?.redraw();
        }
        return;
      }
      const previous = state.term;
      if (key.name === 'backspace') state.term = state.term.slice(0, -1);
      else if (key.name === 'space') state.term += ' ';
      else if (key.text) state.term += key.text;
      else return;
      if (state.term === previous) return;

      if (!state.term) {
        state.searchMode = false;
        state.active = 0;
        void load('', 0).then(() => api?.redraw());
        api?.redraw();
        return;
      }
      state.searchMode = true;
      state.active = 0;
      void load(state.term, undefined).then(() => api?.redraw());
      api?.redraw();
    },
    render() {
      const pages = Math.max(1, Math.ceil(state.choices.length / pageSize));
      const current = Math.min(pages - 1, Math.floor(state.active / pageSize));
      const start = current * pageSize;
      const visible = state.choices.slice(start, start + pageSize);
      const header = totalCount > 0 && !state.searchMode
        ? `${message} (${state.loaded} of ${totalCount} loaded)`
        : message;
      const lines = [`${header} Search: ${state.term}${state.status === 'loading' ? ' ...' : ''}`];
      if (state.error) lines.push(`  ${state.error}`);
      else if (!state.choices.length) lines.push(state.status === 'loading' ? '  Loading...' : '  No matches');
      visible.forEach((choice, index) => {
        const absolute = start + index;
        lines.push(`${absolute === state.active ? '>' : ' '} ${truncate(choice.name)}`);
      });
      const help = state.loaded < totalCount && !state.searchMode
        ? '(scroll to load more, type to search, Esc to cancel)'
        : '(type to search, Esc to cancel)';
      lines.push('', help);
      return lines;
    },
  });

  return prompt.then(value => {
    // Mark the prompt so an in-flight source response cannot redraw or
    // apply after the picker closed.
    state.status = 'cancelled';
    state.token += 1;
    request?.abort();
    return value;
  }, error => {
    state.status = 'cancelled';
    state.token += 1;
    request?.abort();
    throw error;
  }).then(value => value);
};

export default paginatedSearch;
