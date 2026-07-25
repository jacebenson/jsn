/**
 * Paginated search prompt built with @inquirer/core hooks.
 */

import { createPrompt, useState, useKeypress, usePagination, useEffect, useRef } from '@inquirer/core';
import { isEnterKey, isUpKey, isDownKey } from '@inquirer/core';
import { appendFileSync } from 'fs';

export const paginatedSearch = createPrompt((config, done) => {
  const { message, pageSize = 10, totalCount = 0, source } = config;

  // ── DEBUG ──
  const DBG = '/home/jace/workspace/holly/sn-jsn-fork/debug.log';
  const log = (msg) => appendFileSync(DBG, `${new Date().toISOString()} ${msg}\n`);
  log(`START totalCount=${totalCount}`);

  const [status, setStatus] = useState('loading');
  const [searchTerm, setSearchTerm] = useState('');
  const [choices, setChoices] = useState([]);
  const [active, setActive] = useState(0);
  const [loaded, setLoaded] = useState(0);
  const [searchMode, setSearchMode] = useState(false);

  // Refs for mutable state (no functional updaters — @inquirer/core doesn't support them)
  const choicesRef = useRef([]);
  const loadedRef = useRef(0);
  const activeRef = useRef(0);
  const totalCountRef = useRef(totalCount);
  const searchModeRef = useRef(false);

  const fullMessage = totalCount > 0
    ? `${message} (${loaded} of ${totalCount} loaded)`
    : message;

  // Load initial page
  useEffect(() => {
    const controller = new AbortController();
    setStatus('loading');
    log(`EFFECT-INIT searchTerm="${searchTerm}"`);

    const load = async () => {
      try {
        const items = await source(searchTerm || undefined, 0, { signal: controller.signal });
        log(`INIT-LOAD got ${items.length} items`);
        if (!controller.signal.aborted) {
          choicesRef.current = items;
          loadedRef.current = items.length;
          activeRef.current = 0;
          setChoices(items);
          setLoaded(items.length);
          setActive(0);
          setStatus('done');
        }
      } catch (err) {
        log(`INIT-LOAD error: ${err.message}`);
        if (!controller.signal.aborted) {
          setStatus('done');
          setChoices([]);
          setLoaded(0);
        }
      }
    };
    load();
    return () => controller.abort();
  }, []);

  // Load more when scrolling past end
  async function loadMore() {
    log(`loadMore check: loaded=${loadedRef.current} total=${totalCountRef.current} searchMode=${searchModeRef.current}`);
    if (loadedRef.current >= totalCountRef.current || searchModeRef.current) {
      log(`loadMore SKIPPED`);
      return;
    }
    setStatus('loading');
    log(`loadMore calling source offset=${loadedRef.current}`);
    try {
      const newItems = await source('', loadedRef.current, { signal: new AbortController().signal });
      log(`loadMore got ${newItems.length} items`);
      const updated = choicesRef.current.concat(newItems);
      choicesRef.current = updated;
      loadedRef.current = updated.length;
      setChoices([...updated]);
      setLoaded(updated.length);
    } catch (err) {
      console.error('Scroll load error:', err.message || err);
      loadedRef.current = totalCountRef.current;
      setLoaded(totalCountRef.current);
    }
    setStatus('done');
  }

  // Search when term changes
  useEffect(() => {
    if (!searchTerm) {
      setSearchMode(false);
      searchModeRef.current = false;
      const controller = new AbortController();
      setStatus('loading');
      source('', 0, { signal: controller.signal }).then(items => {
        if (!controller.signal.aborted) {
          choicesRef.current = items;
          loadedRef.current = Math.min(items.length, totalCount || Infinity);
          activeRef.current = 0;
          setChoices(items);
          setLoaded(items.length);
          setActive(0);
          setStatus('done');
        }
      }).catch(() => {
        if (!controller.signal.aborted) setStatus('done');
      });
      return () => controller.abort();
    }

    const controller = new AbortController();
    setStatus('loading');
    setSearchMode(true);
    searchModeRef.current = true;

    source(searchTerm, undefined, { signal: controller.signal }).then(items => {
      if (!controller.signal.aborted) {
        choicesRef.current = items;
        loadedRef.current = items.length;
        activeRef.current = 0;
        setChoices(items);
        setLoaded(items.length);
        setActive(0);
        setStatus('done');
      }
    }).catch(() => {
      if (!controller.signal.aborted) {
        setStatus('done');
        setChoices([]);
      }
    });

    return () => controller.abort();
  }, [searchTerm]);

  // Key handling
  useKeypress((key, rl) => {
    if (status === 'loading') return;

    if (isEnterKey(key)) {
      if (choicesRef.current.length > 0 && activeRef.current >= 0 && activeRef.current < choicesRef.current.length) {
        done(choicesRef.current[activeRef.current]);
      }
      return;
    }

    if (key.name === 'escape') {
      done(undefined);
      return;
    }

    if (isUpKey(key)) {
      if (activeRef.current > 0) {
        activeRef.current--;
        setActive(activeRef.current);
      }
      return;
    }

    if (isDownKey(key)) {
      if (activeRef.current < choicesRef.current.length - 1) {
        activeRef.current++;
        setActive(activeRef.current);
      } else if (!searchModeRef.current && loadedRef.current < totalCountRef.current) {
        log(`DOWN at end: active=${activeRef.current} len=${choicesRef.current.length} loaded=${loadedRef.current} total=${totalCountRef.current}`);
        loadMore().then(() => {
          activeRef.current++;
          setActive(activeRef.current);
        });
      }
      return;
    }

    // Use readline's built-in line buffer for text input
    const newTerm = rl.line;
    if (newTerm !== searchTerm) {
      setSearchTerm(newTerm);
    }
  });

  // Paginated rendering
  const page = usePagination({
    items: Array.isArray(choices) ? choices : [],
    active,
    pageSize,
    renderItem: ({ item, isActive }) => {
      const prefix = isActive ? '\x1b[7m' : ' ';
      const suffix = isActive ? '\x1b[0m' : '';
      const name = item.name || String(item.value || item);
      const display = name.length > 70 ? name.slice(0, 67) + '...' : name;
      return ` ${prefix}${display}${suffix}`;
    },
    loop: false,
  });

  const helpText = loaded < totalCount && !searchMode
    ? '(scroll to load more, type to search)'
    : '(type to search)';

  return [
    `${fullMessage} Search: ${searchTerm}${status === 'loading' ? ' ...' : ''}`,
    `${page}\n\n${helpText}`,
  ];
});

export default paginatedSearch;
