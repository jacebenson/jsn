import TurndownService from 'turndown';
import { formatCommandList, quoteShellArg } from '../helpers.js';
import { errAPI, errUsage } from '../errors.js';

const API = '/api/sn_km_api/knowledge/articles';
const markdown = new TurndownService();
const sysId = /^[a-f0-9]{32}$/i;
const articleId = value => typeof value === 'string' && (sysId.test(value) || /^KB\d+$/i.test(value));

function emit(app, argv, data, summary, breadcrumbs = []) {
  const connection = argv.profile ? ` --profile ${quoteShellArg(argv.profile)}`
    : argv.instance ? ` --instance ${quoteShellArg(argv.instance)}` : '';
  app.ok(data, { summary, breadcrumbs: breadcrumbs.map(h => ({ ...h, cmd: h.cmd + connection })) });
}

async function read(sdk, path, params) {
  const response = await sdk.request(`${sdk.baseURL}${API}${path}?${params}`, { method: 'GET' });
  const result = response?.result;
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw errAPI(200, 'Malformed Knowledge API response.');
  const code = result.meta?.status?.code;
  if (code !== undefined && Number(code) !== 200) throw errAPI(Number(code) || 500, 'Knowledge API rejected the request.');
  return result;
}

export function knowledgeCmd(wrap) {
  return {
    command: 'knowledge [subcommand]', aliases: ['kb'],
    describe: 'Search and read knowledge articles through the Knowledge API',
    handler: wrap(async (argv, app) => emit(app, argv,
      { subcommands: argv.subcommands || [], _formatted: formatCommandList({ title: 'Knowledge articles', commands: argv.subcommands || [] }) },
      'Search and read knowledge articles', [{ action: 'search', cmd: 'jsn knowledge search <text>', description: 'Find accessible articles' }])),
    builder: y => y
      .epilogue('Requires the Knowledge API (sn_km_api). Uses its access checks; no fallback to direct knowledge-table reads. Reading does not request view-count updates.')
      .command({ command: 'search <text>', describe: 'Search accessible knowledge articles',
        builder: p => p.positional('text', { type: 'string', describe: 'Search text; quote multiple words' })
          .option('limit', { type: 'number', default: 20, describe: 'Maximum articles (1–100)' })
          .option('offset', { type: 'number', default: 0, describe: 'Starting result offset' })
          .option('kb', { type: 'string', describe: 'Comma-separated knowledge-base sys_ids' })
          .option('language', { type: 'string', describe: 'Two-letter language codes, comma-separated, or all' }),
        handler: wrap(async (argv, app) => {
          if (typeof argv.text !== 'string' || !argv.text.trim()) throw errUsage('Provide nonempty search text.');
          if (!Number.isInteger(argv.limit) || argv.limit < 1 || argv.limit > 100) throw errUsage('--limit must be from 1 to 100.');
          if (!Number.isInteger(argv.offset) || argv.offset < 0) throw errUsage('--offset must be a nonnegative integer.');
          if (argv.kb !== undefined && !String(argv.kb).split(',').every(id => sysId.test(id))) throw errUsage('--kb requires knowledge-base sys_ids.');
          if (argv.language !== undefined && !/^(all|[a-z]{2}(,[a-z]{2})*)$/i.test(argv.language)) throw errUsage('Use two-letter --language codes or all.');
          const params = new URLSearchParams({ query: argv.text.trim(), limit: String(argv.limit), offset: String(argv.offset) });
          if (argv.kb) params.set('kb', argv.kb);
          if (argv.language) params.set('language', argv.language);
          const result = await read(app.sdk, '', params);
          if (!Array.isArray(result.articles) || result.articles.some(a => !a || typeof a !== 'object' || Array.isArray(a))) throw errAPI(200, 'Knowledge API returned no valid article list.');
          const breadcrumbs = result.articles.flatMap(a => {
            const id = articleId(a.number) ? a.number : String(a.id || '').replace(/^kb_knowledge:/, '');
            return articleId(id) ? [{ action: 'show', cmd: `jsn knowledge show ${id}`, description: a.title || id }] : [];
          });
          const base = `jsn knowledge search ${quoteShellArg(argv.text.trim())} --limit ${argv.limit}`
            + (argv.kb ? ` --kb ${quoteShellArg(argv.kb)}` : '') + (argv.language ? ` --language ${quoteShellArg(argv.language)}` : '');
          const total = result.meta?.count;
          const hasMore = typeof total === 'number' ? argv.offset + result.articles.length < total : result.articles.length === argv.limit;
          if (hasMore) breadcrumbs.push({ action: 'next', cmd: `${base} --offset ${argv.offset + argv.limit}`, description: 'Next result page' });
          emit(app, argv, { ...result, count: result.articles.length,
            _formatted: result.articles.map(a => `${a.number || a.id || ''}  ${a.title || ''}\n${a.snippet || ''}`).join('\n\n') || 'No accessible articles matched.' },
          `${result.articles.length} knowledge article(s)`, breadcrumbs);
        }) })
      .command({ command: 'show <id>', describe: 'Read an article by KB number or sys_id',
        builder: p => p.positional('id', { type: 'string' }),
        handler: wrap(async (argv, app) => {
          if (!articleId(argv.id)) throw errUsage('Use a KB number or full article sys_id.');
          const article = await read(app.sdk, `/${encodeURIComponent(argv.id)}`, new URLSearchParams());
          if (!sysId.test(article.sys_id || '') || typeof article.content !== 'string') throw errAPI(200, 'Knowledge API returned no readable article content.');
          emit(app, argv, { ...article, _formatted: `${article.number || argv.id}: ${article.short_description || ''}\n\n${markdown.turndown(article.content)}` },
            article.short_description || article.number || argv.id,
            [{ action: 'search', cmd: 'jsn knowledge search <text>', description: 'Find more articles' }]);
        }) }),
  };
}
