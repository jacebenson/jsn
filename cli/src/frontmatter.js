import yaml from 'js-yaml';

const DEFAULT_DELIMITERS = ['---', '---'];

function delimiters(options = {}) {
  const value = options.delimiters || DEFAULT_DELIMITERS;
  if (!Array.isArray(value) || value.length !== 2 || value.some((item) => typeof item !== 'string')) {
    throw new TypeError('delimiters must be a two-item string array');
  }
  return value;
}

/** Parse the YAML frontmatter format used by the docs commands. */
export function parseFrontmatter(input, options = {}) {
  const source = String(input).replace(/^\uFEFF/, '');
  const [open, close] = delimiters(options);
  const empty = { data: {}, content: source };

  if (!source.startsWith(open) || source.charAt(open.length) === open.slice(-1)) return empty;

  let frontmatter = source.slice(open.length);
  // gray-matter accepts an optional language suffix, which is only relevant
  // here for the YAML spelling (`---yaml`).
  if (frontmatter.startsWith('yaml\r\n') || frontmatter.startsWith('yaml\n')) {
    frontmatter = frontmatter.slice(4);
  }

  const closeIndex = frontmatter.indexOf(`\n${close}`);
  const raw = closeIndex === -1 ? frontmatter : frontmatter.slice(0, closeIndex);
  const parsed = yaml.load(raw);
  const data = parsed === undefined ? {} : parsed;

  if (closeIndex === -1) return { data, content: '' };

  let content = frontmatter.slice(closeIndex + close.length + 1);
  if (content.startsWith('\r')) content = content.slice(1);
  if (content.startsWith('\n')) content = content.slice(1);
  return { data, content };
}

/** Serialize docs metadata and body using gray-matter-compatible YAML framing. */
export function stringifyFrontmatter(body, data, options = {}) {
  const [open, close] = delimiters(options);
  const yamlText = yaml.dump(data, options).trim();
  const prefix = yamlText === '{}' ? '' : `${open}\n${yamlText}\n${close}\n`;
  const content = String(body);
  return prefix + (content.endsWith('\n') ? content : `${content}\n`);
}
