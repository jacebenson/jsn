/**
 * Paginated, searchable record picker built on src/prompt-engine.js.
 *
 * Contract (unchanged from the Inquirer version):
 *   paginatedSearch({ message, pageSize, totalCount, source }, context?)
 *   source(term, offset, { signal }) -> [{ name, value }]
 *   Enter resolves the active choice object; Escape resolves undefined.
 *   Down at the last loaded row loads more while loaded < totalCount;
 *   a null totalCount is unknown and continues until a successful empty page.
 *
 * Additions for hosts that measure the total in parallel with the picker:
 *   - totalCount is re-read on every render, so a property getter may supply
 *     a count that arrives late; it shows up on the next redraw.
 *   - onReady(handle) receives { redraw } so the host can trigger that redraw.
 *   - search-as-you-type is debounced (searchDebounceMs, default 200ms); the
 *     initial page load is not. Clearing the term loads immediately.
 */

import { pickerRows, pickerFooter } from './picker-ui.js';
import { runPrompt, normalizeChoices, escapeResult } from './prompt-engine.js';

export const SEARCH_DEBOUNCE_MS = 200;

export const paginatedSearch = async (config = {}, context = {}) => {
  const { message, pageSize = 10, source } = config;
  // totalCount is read on every render, not destructured once: a picker
  // whose count is still in flight receives a live getter from its host and
  // shows the total as soon as one was measured.
  const totalCount = () => {
    const value = config.totalCount;
    return value === undefined ? 0 : value;
  };
  const searchDebounceMs = Number.isFinite(config.searchDebounceMs)
    ? Math.max(0, config.searchDebounceMs)
    : SEARCH_DEBOUNCE_MS;
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
    debounce: null,
    inflight: null,
    appliedTerm: '',
  };

  const cancelDebounce = () => {
    if (state.debounce) {
      clearTimeout(state.debounce);
      state.debounce = null;
    }
  };

  const canLoadMore = () => !state.searchMode && !state.exhausted
    && (totalCount() == null || state.loaded < totalCount());

  // Every request gets a token. A response may only be applied while its
  // token is still current, so a stale (slower) search can never replace
  // newer results or be selected by a later Enter.
  const isCurrent = token => token === state.token && state.status !== 'cancelled';

  // True while the rows on screen belong to an older term: either the
  // debounce has not fired yet or the current term's request is in flight.
  const awaitingTermResults = () => state.searchMode
    && (state.debounce !== null || state.status === 'loading');

  // A navigation/selection key must never act on the stale list. Flush the
  // pending debounce right away (the user is done typing) and resolve only
  // once the current term's page has been applied.
  async function flushPendingSearch() {
    if (state.status === 'cancelled') return;
    if (state.debounce) {
      cancelDebounce();
      await load(state.term, undefined);
    } else if (state.status === 'loading' && state.inflight) {
      await state.inflight;
    }
    api?.redraw();
  }

  function load(term, offset, { append = false } = {}) {
    const run = (async () => {
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
        state.exhausted = items.length === 0;
        state.active = Math.min(state.active, Math.max(0, state.choices.length - 1));
        state.appliedTerm = term || '';
        state.status = 'done';
      } catch (error) {
        if (!isCurrent(token)) return;
        state.status = 'done';
        state.error = error?.message || String(error);
        if (!append) {
          state.choices = [];
          state.loaded = 0;
          state.appliedTerm = term || '';
        }
        // A failed load-more keeps the rows already on screen.
      }
    })();
    state.inflight = run;
    return run;
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
      config.onReady?.(handle);
      state.pending.then(() => {
        if (state.status !== 'cancelled') api.redraw();
      });
    },
    async key(_state, key, handle) {
      api = handle;
      if ((key.name === 'up' || key.name === 'down' || key.name === 'return' || key.name === 'enter')
        && awaitingTermResults()) {
        // The visible rows belong to an older term. Issue the search now and
        // wait for it before this key is allowed to move or select anything;
        // the keypress queue serializes any keys that follow it.
        await flushPendingSearch();
      }
      if (key.name === 'return' || key.name === 'enter') {
        // No selecting a row while a request is in flight: the list on
        // screen may be about to change.
        if (state.status === 'loading' || !state.choices.length) return;
        const choice = state.choices[state.active];
        if (!choice || choice.disabled) return;
        cancelDebounce();
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
        } else if (canLoadMore()) {
          const before = state.loaded;
          const pending = load('', state.loaded, { append: true });
          const token = state.token;
          void pending.then(() => {
            if (!isCurrent(token)) return;
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
        // Clearing the term is an explicit "show everything" action: load
        // the unfiltered page right away instead of waiting out the
        // search-as-you-type debounce.
        cancelDebounce();
        state.searchMode = false;
        state.active = 0;
        void load('', 0).then(() => api?.redraw());
        api?.redraw();
        return;
      }
      state.searchMode = true;
      state.active = 0;
      // Debounce search-as-you-type: five keystrokes in a row must issue one
      // request, for the final term. Abort/invalidate whatever is in flight
      // now so an older term's page cannot land while this term is pending.
      cancelDebounce();
      request?.abort();
      state.token += 1;
      state.status = 'loading';
      state.error = '';
      const term = state.term;
      state.debounce = setTimeout(() => {
        state.debounce = null;
        if (state.status === 'cancelled' || state.term !== term) return;
        void load(term, undefined).then(() => api?.redraw());
      }, searchDebounceMs);
      api?.redraw();
    },
    render() {
      const total = totalCount();
      const pages = Math.max(1, Math.ceil(state.choices.length / pageSize));
      const current = Math.min(pages - 1, Math.floor(state.active / pageSize));
      const start = current * pageSize;
      const visible = state.choices.slice(start, start + pageSize);
      const header = total > 0 && !state.searchMode
        ? `${message} (${state.loaded} of ${total} loaded)`
        : message;
      const lines = [header ?? '', `Search: ${state.term}${state.status === 'loading' ? ' ...' : ''}`];
      if (state.error) lines.push(`  ${state.error}`);
      else if (!state.choices.length) lines.push(state.status === 'loading' ? '  Loading...' : '  No matches');
      lines.push(...pickerRows(visible, state.active - start));
      lines.push(...pickerFooter({ more: canLoadMore() }));
      return lines;
    },
  });

  return prompt.then(value => {
    // Mark the prompt so an in-flight source response cannot redraw or
    // apply after the picker closed, and drop any scheduled search.
    cancelDebounce();
    state.status = 'cancelled';
    state.token += 1;
    request?.abort();
    return value;
  }, error => {
    cancelDebounce();
    state.status = 'cancelled';
    state.token += 1;
    request?.abort();
    throw error;
  }).then(value => value);
};

export default paginatedSearch;
