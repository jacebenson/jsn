// Prepare site-owned assets/data only. Markdown is rendered live by Rails.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import features from '../site/data/showcases.js';
const root = fileURLToPath(new URL('../', import.meta.url));
const site = path.join(root, 'site');
fs.writeFileSync(path.join(site, 'config/features.json'), JSON.stringify(features, null, 2) + '\n');
const destination = path.join(site, 'public');
fs.mkdirSync(destination, { recursive: true });
// public is exclusively generated; static sources live in site/static.
for (const name of fs.readdirSync(destination)) if (name !== '.keep') fs.rmSync(path.join(destination, name), { recursive: true, force: true });
fs.cpSync(path.join(site, 'static'), destination, { recursive: true });
const origin = 'https://jsn.jace.pro';
const guides = JSON.parse(fs.readFileSync(path.join(site, 'config/guides.json'), 'utf8'));
const urls = ['/', '/features/', '/docs/', ...features.map(f => `/features/${f.canonicalSlug}/`), ...Object.keys(guides).map(slug => `/docs/${slug}/`)];
fs.writeFileSync(path.join(destination, 'robots.txt'), `User-agent: *\nAllow: /\n\nSitemap: ${origin}/sitemap.xml\n`);
fs.writeFileSync(path.join(destination, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.map(url => `<url><loc>${origin}${url}</loc></url>`).join('')}</urlset>\n`);
const llms = fs.readFileSync(path.join(site, 'data/llms.txt'), 'utf8');
fs.writeFileSync(path.join(destination, 'llms.txt'), llms + '\nfeature_pages:\n' + features.map(f => `- /features/${f.canonicalSlug}/ - ${f.seoTitle}`).join('\n') + '\n');
fs.mkdirSync(path.join(site, 'tmp'), { recursive: true });
fs.copyFileSync(path.join(site, 'config/preserved-urls.json'), path.join(site, 'tmp/preserved-urls.json'));
console.log(`Prepared assets, ${features.length} features and ${Object.keys(guides).length} Rails Markdown guides; no npm dependencies or static HTML generator.`);
