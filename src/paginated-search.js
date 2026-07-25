/**
 * Paginated search prompt built with @inquirer/core hooks.
 *
 * Uses the same rendering engine as @inquirer/search but adds
 * scroll-based server pagination: when the user arrows past the
 * last loaded item, it fetches the next page from the server.
 */

import { createPrompt, useState, useKeypress, usePagination, useEffect, useRef } from '@inquirer/core';
import { isEnterKey, isUpKey, isDownKey } from '@inquirer/core';

export const paginatedSearch = createPrompt((config, done) => {
  const { message, pageSize = 10, totalCount = 0, source } = config;

  const [status, setStatus] = useState('loading');
  const [searchTerm, setSearchTerm] = useState('');
  const [choices, setChoices] = useState([]);
  const [active, setActive] = useState(0);
  const [loaded, setLoaded] = useState(0);
  const [searchMode, setSearchMode] = useState(false);

  // Refs to avoid stale closures in async callbacks
  const loadedRef = useRef(loaded);
  loadedRef.current = loaded;
  const totalCountRef = useRef(totalCount);
  totalCountRef.current = totalCount;
  const searchModeRef = useRef(searchMode);
  searchModeRef.current = searchMode;

  const fullMessage = totalCount > 0
    ? `${message} (${loaded} of ${totalCount} loaded)`
    : message;

  // Load initial page
  useEffect(() => {
    const controller = new AbortController();
    setStatus('loading');

    const load = async () => {
      try {
        const items = await source(searchTerm || undefined, 0, { signal: controller.signal });
        if (!controller.signal.aborted) {
          setChoices(items);
          setLoaded(items.length);
          setActive(0);
          setStatus('done');
        }
      } catch (err) {
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
    if (loadedRef.current >= totalCountRef.current || searchModeRef.current) return;
    setStatus('loading');
    const newItems = await source('', loadedRef.current, { signal: new AbortController().signal });
    setChoices(prev => {
      const updated = prev.concat(newItems);
      setLoaded(Math.min(updated.length, totalCountRef.current));
      return updated;
    });
    setStatus('done');
  }

  // Search when term changes
  useEffect(() => {
    if (!searchTerm) {
      setSearchMode(false);
      // Reset to browse mode: reload first page
      const controller = new AbortController();
      setStatus('loading');
      source('', 0, { signal: controller.signal }).then(items => {
        if (!controller.signal.aborted) {
          setChoices(items);
          setLoaded(Math.min(items.length, totalCount || Infinity));
          setActive(0);
          setStatus('done');
        }
      }).catch(() => {
        if (!controller.signal.aborted) {
          setStatus('done');
        }
      });
      return () => controller.abort();
    }

    const controller = new AbortController();
    setStatus('loading');
    setSearchMode(true);

    source(searchTerm, undefined, { signal: controller.signal }).then(items => {
      if (!controller.signal.aborted) {
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
      if (choices.length > 0 && active >= 0 && active < choices.length) {
        done(choices[active]);
      }
      return;
    }

    if (key.name === 'escape') {
      done(undefined);
      return;
    }

    if (isUpKey(key)) {
      if (active > 0) {
        setActive(active - 1);
      }
      return;
    }

    if (isDownKey(key)) {
      if (active < choices.length - 1) {
        setActive(active + 1);
      } else if (!searchModeRef.current && loadedRef.current < totalCountRef.current) {
        loadMore().then(() => setActive(prev => prev + 1));
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
    items: choices,
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
    `${fullMessage}\n${page}`,
    status === 'loading' ? '  Loading...' : `  > ${searchTerm}  ${helpText}`,
  ];
});

export default paginatedSearch;
