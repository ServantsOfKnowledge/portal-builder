// Local portal builder: edits project configs, pulls items from archive.org,
// renders the static portal, and pushes it to GitHub Pages via git + gh.
const http = require('http'), fs = require('fs'), path = require('path');
const { execFile } = require('child_process'), { promisify } = require('util');
const run = promisify(execFile);

const ROOT = __dirname;
const DATA = path.join(ROOT, 'data'), WS = path.join(ROOT, 'workspace'), TPL = path.join(ROOT, 'template');
const DB = path.join(DATA, 'projects.json');
const GIT_NAME = process.env.GIT_NAME || 'Omshivaprakash';
const GIT_EMAIL = process.env.GIT_EMAIL || 'omshivaprakash@gmail.com';
const PORT = +process.env.PORT || 4300;
const HOST = process.env.HOST || '127.0.0.1';
const { ADMIN_USER = 'admin', ADMIN_PASSWORD = '' } = process.env;

// Constant-time Basic-auth check; hashing first makes the buffers equal length.
const sha = (x) => require('crypto').createHash('sha256').update(String(x)).digest();
const same = (a, b) => require('crypto').timingSafeEqual(sha(a), sha(b));
function authorized(header, user, pass) {
  const m = /^Basic (.+)$/.exec(header || '');
  if (!m) return false;
  const [u, ...rest] = Buffer.from(m[1], 'base64').toString().split(':');
  return same(u, user) & same(rest.join(':'), pass) ? true : false;
}

const load = () => (fs.existsSync(DB) ? JSON.parse(fs.readFileSync(DB, 'utf8')) : {});
const save = (db) => { fs.mkdirSync(DATA, { recursive: true }); fs.writeFileSync(DB, JSON.stringify(db, null, 2)); };
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const arr = (v) => [].concat(v ?? []);
const strip = (s) => s.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

// ---- archive.org -----------------------------------------------------------
async function iaFetch(q) {
  const docs = [];
  for (let page = 1; ; page++) {
    const u = new URL('https://archive.org/advancedsearch.php');
    u.searchParams.set('q', q);
    for (const f of ['identifier', 'title', 'creator', 'publisher', 'description', 'subject', 'date', 'year', 'imagecount', 'licenseurl', 'volume', 'issue']) u.searchParams.append('fl[]', f);
    u.searchParams.append('sort[]', 'identifier asc');
    u.searchParams.set('rows', '500'); u.searchParams.set('page', page); u.searchParams.set('output', 'json');
    const r = await fetch(u);
    if (!r.ok) throw new Error('archive.org returned ' + r.status);
    const { response } = await r.json();
    docs.push(...response.docs);
    if (!response.docs.length || docs.length >= response.numFound) return docs;
  }
}

// IA packs subjects as 'a; b; c'. Portals filter on comma-separated tags, so split on ; and , and rejoin with commas.
const normTags = (v) => [...new Set(arr(v).flatMap((s) => String(s).split(/[;,]/)).map((t) => t.trim()).filter(Boolean))].join(',');
function toBook(d, info) {
  const author = arr(d.creator).join(', ');
  return {
    identifier: d.identifier,
    title: arr(d.title)[0] || d.identifier,
    author,
    publisher: arr(d.publisher).join(', '),
    info: info || strip(arr(d.description).join(' ')),
    tags: normTags(d.subject),
    level: Number(d.year) || (d.date ? Number(d.date.slice(0, 4)) : '') || '',
    authorUrl: author ? `https://archive.org/search?query=creator%3A%22${encodeURIComponent(author).replace(/%20/g, '+')}%22` : '',
    url: `https://archive.org/details/${d.identifier}`,
    cover: `https://archive.org/services/img/${d.identifier}`,
    pages: Number(d.imagecount) || '',
    license: arr(d.licenseurl)[0] || '',
    volume: String(arr(d.volume)[0] || ''),
    issue: String(arr(d.issue)[0] || ''),
  };
}

// Refresh: archive.org wins, but only for fields it actually has (publication year, title, author, ...).
const REFRESH = ['title', 'author', 'publisher', 'tags', 'level', 'authorUrl', 'pages', 'license', 'volume', 'issue'];
function refreshBooks(books, fresh) {
  let n = 0;
  const out = books.map((b) => {
    const f = fresh.get(b.identifier);
    if (!f) return b;
    n++;
    return { ...b, ...Object.fromEntries(REFRESH.filter((k) => f[k] !== '' && f[k] != null).map((k) => [k, f[k]])) };
  });
  return { books: out, n };
}
async function refreshFromIA(books, log) {
  const fresh = new Map(), ids = books.map((b) => b.identifier);
  try {
    for (let i = 0; i < ids.length; i += 40)
      for (const d of await iaFetch(`identifier:(${ids.slice(i, i + 40).map((x) => `"${x}"`).join(' OR ')})`)) fresh.set(d.identifier, toBook(d));
  } catch (e) { log.push(`(could not reach archive.org: ${e.message}; kept the existing details)`); return books; }
  const r = refreshBooks(books, fresh);
  log.push(`Refreshed ${r.n} of ${books.length} items from archive.org (publication year, title, author, publisher, subjects, pages, licence).`);
  return r.books;
}

// Existing rows win (so hand edits stay), but gain any fields they were missing (pages, licence, ...).
function merge(existing, fresh) {
  const byId = new Map(fresh.map((b) => [b.identifier, b]));
  const have = new Set(existing.map((b) => b.identifier));
  const added = fresh.filter((b) => !have.has(b.identifier));
  const kept = existing.map((b) => ({ ...byId.get(b.identifier), ...b, tags: normTags(b.tags) }));
  return { books: [...kept, ...added].sort((a, b) => a.identifier.localeCompare(b.identifier)), added: added.length };
}

// ---- site rendering --------------------------------------------------------
const GA = (id) => id && `<script async src="https://www.googletagmanager.com/gtag/js?id=${esc(id)}"></script>
    <script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','${esc(id)}');</script>`;

function validate(p) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(p.slug || '')) throw new Error('slug: lowercase letters, digits, hyphens');
  if (!/^[A-Za-z0-9-]+$/.test(p.owner || '')) throw new Error('GitHub owner (org/user) is invalid');
  if (!/^[A-Za-z0-9._-]+$/.test(p.repo || p.slug)) throw new Error('repo name is invalid');
  if (!/^[a-z0-9][a-z0-9.-]*$/.test(p.domain || '')) throw new Error('base domain is invalid');
  if (!/^[a-z0-9][a-z0-9-]*$/.test(p.sub || p.slug)) throw new Error('subdomain is invalid');
}

const safeUrl = (u) => (/^https?:\/\//.test(u || '') ? esc(u) : '');

const UI = {
  en: { SEARCH: 'Search title, author, year…', SEARCHLABEL: 'Search', ALL: 'All', RANDOM: 'Random issue', SKIP: 'Skip to the list',
    ABOUT: 'About this collection', NONE: 'Nothing matches your search.', PREV: 'Previous', NEXT: 'Next', CLOSE: 'Close',
    NEWTAB: 'Open in new tab', ITEMS: 'items', PAGES: 'pages', DOWNLOAD: 'Download', VOL: 'Vol.', ISSUE: 'No.', UNKNOWN: 'Year unknown', LICENSE: 'Licence' },
  kn: { SEARCH: 'ಶೀರ್ಷಿಕೆ, ಲೇಖಕ, ವರ್ಷ ಹುಡುಕಿ…', SEARCHLABEL: 'ಹುಡುಕಿ', ALL: 'ಎಲ್ಲಾ', RANDOM: 'ಯಾದೃಚ್ಛಿಕ ಸಂಚಿಕೆ', SKIP: 'ಪಟ್ಟಿಗೆ ಹೋಗಿ',
    ABOUT: 'ಈ ಸಂಗ್ರಹದ ಬಗ್ಗೆ', NONE: 'ಹುಡುಕಾಟಕ್ಕೆ ಹೊಂದುವ ಸಂಚಿಕೆಗಳಿಲ್ಲ.', PREV: 'ಹಿಂದಿನದು', NEXT: 'ಮುಂದಿನದು', CLOSE: 'ಮುಚ್ಚಿ',
    NEWTAB: 'ಹೊಸ ಟ್ಯಾಬ್‌ನಲ್ಲಿ ತೆರೆಯಿರಿ', ITEMS: 'ಸಂಚಿಕೆಗಳು', PAGES: 'ಪುಟಗಳು', DOWNLOAD: 'ಡೌನ್‌ಲೋಡ್', VOL: 'ಸಂಪುಟ', ISSUE: 'ಸಂಚಿಕೆ', UNKNOWN: 'ವರ್ಷ ತಿಳಿದಿಲ್ಲ', LICENSE: 'ಪರವಾನಗಿ' },
};

const pick = (re, s) => (re.exec(s || '') || [])[1] || '';
const volOf = (b) => b.volume || pick(/(?:ಸಂಪುಟ|vol(?:ume)?\.?)[\s\-:.]*(\d+)/i, b.title);
const issOf = (b) => b.issue || pick(/(?:ಸಂಚಿಕೆ|issue|no\.?)[\s\-:.]*(\d+)/i, b.title);
const yearOf = (b) => (b.level === '' || b.level == null ? '' : String(b.level));

function licenseLabel(url, fallback) {
  const m = /creativecommons\.org\/(licenses|publicdomain)\/([a-z-]+)\/([\d.]+)/.exec(url);
  return !m ? fallback : m[1] === 'publicdomain' ? 'CC0' : `CC ${m[2].toUpperCase()} ${m[3]}`;
}

// Chronological: by year (unknown last), then identifier with numbers compared as numbers.
function sortBooks(books) {
  const y = (b) => (yearOf(b) === '' ? Infinity : +b.level);
  return [...books].sort((a, b) => (y(a) < y(b) ? -1 : y(a) > y(b) ? 1 : a.identifier.localeCompare(b.identifier, 'en', { numeric: true })));
}

const qOf = (b) => [b.title, b.author, b.publisher, b.tags, b.level, volOf(b), issOf(b), b.identifier].join(' ').normalize('NFC').toLowerCase();
// Bump when the portal template gains something worth rolling out to existing portals.
// 1 = the original design (carries no marker), 2 = centred white design, SOK credit, paged loading, search index,
// 3 = one flat list (no per-year sections), comma-separated subject tags, 4 = logo left with the title centred.
const DESIGN_VERSION = 4;
const PAGE = 30; // cards per page; later pages load as the reader scrolls
function cardHtml(b, h, ui, read) {
  const vol = volOf(b), iss = issOf(b), id = esc(b.identifier);
  const author = b.author ? (safeUrl(b.authorUrl) ? `<a href="${safeUrl(b.authorUrl)}" target="_blank" rel="noopener">${esc(b.author)}</a>` : esc(b.author)) : '';
  const facts = [iss && `${ui.ISSUE} ${esc(iss)}`, b.pages && `${esc(b.pages)} ${ui.PAGES}`].filter(Boolean).join(' · ');
  const open = (cls, label) => `<a class="open ${cls}" data-id="${id}" data-title="${esc(b.title)}" href="${esc(b.url)}" target="_blank" rel="noopener">${label}</a>`;
  return `<li class="card" data-id="${id}" data-year="${esc(yearOf(b) || 'unknown')}">
<a class="cover open" data-id="${id}" data-title="${esc(b.title)}" href="${esc(b.url)}" target="_blank" rel="noopener" tabindex="-1" aria-hidden="true"><img src="${esc(b.cover)}" alt="" loading="lazy" decoding="async" width="300" height="400"></a>
<${h}>${open('t', esc(b.title))}</${h}>
${author ? `<p class="meta">${author}</p>` : ''}${facts ? `<p class="meta">${facts}</p>` : ''}
<p class="links">${open('read', esc(read))}<a href="https://archive.org/download/${id}" target="_blank" rel="noopener">${ui.DOWNLOAD}</a>${safeUrl(b.license) ? `<a href="${safeUrl(b.license)}" target="_blank" rel="noopener">${esc(licenseLabel(b.license, ui.LICENSE))}</a>` : ''}</p>
</li>`;
}

// Whole list is rendered at build time: crawlers and no-JS readers get real content; JS only filters it.
function renderList(books, ui, read) {
  let out = '', v;
  const closeVol = () => { if (v !== undefined) out += '</ul></div>'; v = undefined; };
  for (const b of sortBooks(books)) {
    const vol = volOf(b);
    if (vol !== v) {
      closeVol();
      out += `<div class="vol" data-vol="${esc(vol)}">${vol ? `<h2>${ui.VOL} ${esc(vol)}</h2>` : ''}<ul class="cards">`; v = vol;
    }
    out += cardHtml(b, vol ? 'h3' : 'h2', ui, read);
  }
  closeVol();
  return out;
}

function pillsHtml(books, ui) {
  const years = [...new Set(books.map(yearOf))].sort((a, b) => (a === '' ? 1 : b === '' ? -1 : a - b));
  const pill = (val, label, on) => `<button type="button" class="pill" data-year="${esc(val)}" aria-pressed="${on}">${esc(label)}</button>`;
  if (years.length < 2) return ''; // a single group needs no filter
  return pill('any', ui.ALL, true) + years.map((yr) => pill(yr || 'unknown', yr || ui.UNKNOWN, false)).join('');
}

function jsonLd(p, site, books) {
  return JSON.stringify({
    '@context': 'https://schema.org', '@type': 'CollectionPage', name: p.title, description: p.description, url: site + '/', inLanguage: p.lang || undefined,
    publisher: p.orgName ? { '@type': 'Organization', name: p.orgName, url: p.orgUrl || undefined } : undefined,
    mainEntity: { '@type': 'ItemList', numberOfItems: books.length, itemListElement: books.map((b, i) => ({
      '@type': 'ListItem', position: i + 1,
      item: { '@type': 'CreativeWork', name: b.title, url: b.url, author: b.author ? { '@type': 'Person', name: b.author } : undefined,
        datePublished: yearOf(b) || undefined, license: b.license || undefined },
    })) },
  }).replace(/</g, '\\u003c');
}

// "Name | https://site | optional logo URL" per line
function partnersHtml(text) {
  const items = String(text || '').split('\n').map((l) => l.split('|').map((x) => x.trim())).filter(([n, u]) => n && safeUrl(u));
  if (!items.length) return '';
  return '<ul class="partners">' + items.map(([n, u, img]) =>
    `<li><a href="${safeUrl(u)}" target="_blank" rel="noopener">${safeUrl(img) ? `<img src="${safeUrl(img)}" alt="" loading="lazy" height="20"> ` : ''}${esc(n)}</a></li>`).join('') + '</ul>';
}

function creditHtml(p) {
  if (p.footer) return esc(p.footer);
  if (!p.orgName) return '';
  const link = safeUrl(p.orgUrl);
  return 'Published by ' + (link ? `<a href="${link}" target="_blank" rel="noopener">${esc(p.orgName)}</a>` : esc(p.orgName)) + '.';
}

function build(p) {
  validate(p);
  const dir = path.join(WS, p.slug);
  fs.mkdirSync(dir, { recursive: true });
  for (const d of ['css', 'img']) fs.cpSync(path.join(TPL, d), path.join(dir, d), { recursive: true });
  const assets = path.join(DATA, 'assets', p.slug);
  const logo = path.join(assets, 'logo.png'), fav = path.join(assets, 'favicon.png');
  if (fs.existsSync(logo)) fs.copyFileSync(logo, path.join(dir, 'img', 'logo.png'));
  if (fs.existsSync(fav)) for (const n of ['favicon-32x32.png', 'android-chrome-192x192.png']) fs.copyFileSync(fav, path.join(dir, 'img', 'ico', n));
  const host = `${p.sub || p.slug}.${p.domain}`, site = 'https://' + host;
  const ui = UI[String(p.lang || 'en').split('-')[0]] || UI.en;
  const read = p.readLabel || 'Read';
  const sorted = sortBooks(p.books);
  const v = {
    LANG: esc(p.lang || 'kn'), TITLE: esc(p.title), TAGLINE: esc(p.tagline), DESC: esc(p.description),
    AUTHOR: esc(p.orgName), SITE: site, OGIMG: esc(sorted[0]?.cover || ''), GA: GA(p.gaId) || '',
    PARTNERS: partnersHtml(p.partners), CREDIT: creditHtml(p),
    LIST: renderList(sorted.slice(0, PAGE), ui, read) + (sorted.length > PAGE ? '<div id="more" data-pages="' + Math.ceil(sorted.length / PAGE) + '"></div>' : ''), PILLS: pillsHtml(p.books, ui), COUNT: `${p.books.length} / ${p.books.length} ${esc(ui.ITEMS)}`,
    LDJSON: jsonLd(p, site, sorted), FRAME: String(p.openMode === 'frame'), TJSON: JSON.stringify({ items: ui.ITEMS }).replace(/</g, '\\u003c'),
    SOK: `${fs.existsSync(path.join(TPL, 'img', 'sok-logo.png')) ? '<img src="./img/sok-logo.png" alt="">' : ''}<span>A <a href="https://archive.org/details/ServantsOfKnowledge" target="_blank" rel="noopener">Servants of Knowledge</a> Initiative</span>`,
    DESIGN: DESIGN_VERSION, READ: esc(read), ...Object.fromEntries(Object.entries(ui).map(([k, t]) => ['T_' + k, esc(t)])),
  };
  const viewer = p.openMode === 'frame' ? fs.readFileSync(path.join(TPL, 'viewer.html'), 'utf8') : '';
  const html = fs.readFileSync(path.join(TPL, 'index.html'), 'utf8').replace('__VIEWER__', () => viewer)
    .replace(/__([A-Z_]+)__/g, (m, k) => (k in v ? v[k] : m));
  fs.writeFileSync(path.join(dir, 'index.html'), html);
  fs.rmSync(path.join(dir, 'p'), { recursive: true, force: true });
  if (sorted.length > PAGE) fs.mkdirSync(path.join(dir, 'p'));
  for (let i = PAGE, n = 1; i < sorted.length; i += PAGE, n++) fs.writeFileSync(path.join(dir, 'p', n + '.html'), renderList(sorted.slice(i, i + PAGE), ui, read));
  fs.writeFileSync(path.join(dir, 'search.json'), JSON.stringify(sorted.map((b, i) => [b.identifier, yearOf(b) || 'unknown', qOf(b), Math.floor(i / PAGE)])));
  fs.writeFileSync(path.join(dir, 'issues.json'), JSON.stringify({ books: p.books }, null, 2));
  fs.writeFileSync(path.join(dir, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${site}/</loc><lastmod>${new Date().toISOString().slice(0, 10)}</lastmod></url></urlset>\n`);
  fs.writeFileSync(path.join(dir, 'robots.txt'), `User-agent: *\nAllow: /\nSitemap: ${site}/sitemap.xml\n`);
  fs.writeFileSync(path.join(dir, 'CNAME'), host + '\n');
  fs.writeFileSync(path.join(dir, '.gitignore'), '.DS_Store\n');
  fs.writeFileSync(path.join(dir, 'README.md'), `# ${p.title}\n\nDigital archive hosted at **https://${host}**\n\nPublished by ${p.orgName || p.owner}. Items come from Internet Archive query:\n\n    ${p.query}\n`);
  fs.writeFileSync(path.join(dir, 'push.sh'), '#!/bin/sh\ngit push origin master\ngit push origin master:gh-pages\n', { mode: 0o755 });
  return { dir, host };
}

// ---- git / GitHub ----------------------------------------------------------
async function sh(cmd, args, cwd, log) {
  log.push('$ ' + [cmd, ...args].join(' '));
  try {
    const { stdout, stderr } = await run(cmd, args, { cwd });
    const out = (stdout + stderr).trim();
    if (out) log.push(out);
    return stdout;
  } catch (e) {
    log.push(((e.stderr || '') + (e.stdout || '') || e.message).trim());
    throw e;
  }
}

async function launch(p, log) {
  const { dir, host } = build(p);
  const g = (...a) => sh('git', a, dir, log);
  const br = p.defaultBranch || 'master';
  const fresh = !fs.existsSync(path.join(dir, '.git'));
  if (fresh) await g('init', '-b', br);
  await g('config', 'user.name', GIT_NAME);
  await g('config', 'user.email', GIT_EMAIL);
  await g('add', '-A');
  if ((await run('git', ['status', '--porcelain'], { cwd: dir })).stdout.trim())
    await g('commit', '-m', fresh ? 'Initial portal' : 'Update issues');
  else log.push('(nothing new to commit)');

  const repo = `${p.owner}/${p.repo || p.slug}`;
  const url = `${process.env.GITHUB_BASE || 'https://github.com'}/${repo}.git`;
  const exists = await sh('gh', ['repo', 'view', repo], dir, log).then(() => true, () => false);
  if (!exists) await sh('gh', ['repo', 'create', repo, '--public', '--description', p.title.slice(0, 340)], dir, log);
  const hasOrigin = (await run('git', ['remote'], { cwd: dir })).stdout.split('\n').includes('origin');
  await g('remote', hasOrigin ? 'set-url' : 'add', 'origin', url);
  await g('push', '-u', 'origin', br);
  await g('push', 'origin', `${br}:gh-pages`);
  await sh('gh', ['api', '-X', 'POST', `repos/${repo}/pages`, '-f', 'source[branch]=gh-pages', '-f', 'source[path]=/'], dir, log)
    .catch(() => log.push('(Pages already enabled, or enable it in repo Settings → Pages)'));
  log.push(`\nDone. Add DNS: ${p.sub || p.slug}  CNAME  ${p.owner.toLowerCase()}.github.io.`);
  log.push(`Then tick "Enforce HTTPS" in the repo's Pages settings once DNS resolves → https://${host}`);
}


// ---- existing portals on GitHub: list, import, modernise -------------------
const ghJson = async (args) => (await run('gh', ['api', ...args], { maxBuffer: 50e6 })).stdout;
const ownerOk = (o) => { if (!/^[A-Za-z0-9-]+$/.test(o || '')) throw new Error('GitHub owner is invalid'); return o; };
const ndjson = (t) => t.split('\n').filter(Boolean).map((l) => JSON.parse(l));

// Every repo of an org (or user) that has an issues.json in its root, i.e. a portal.
async function listPortals(owner) {
  ownerOk(owner);
  const jq = '.[] | {name,default_branch,description,archived,pushed_at}';
  let repos;
  try { repos = ndjson(await ghJson([`orgs/${owner}/repos?per_page=100&type=public`, '--paginate', '--jq', jq])); }
  catch { repos = ndjson(await ghJson([`users/${owner}/repos?per_page=100&type=owner`, '--paginate', '--jq', jq])); }
  const db = load(), out = [];
  for (let i = 0; i < repos.length; i += 6) {
    await Promise.all(repos.slice(i, i + 6).map(async (r) => {
      try {
        const names = JSON.parse(await ghJson([`repos/${owner}/${r.name}/contents/?ref=${encodeURIComponent(r.default_branch)}`, '--jq', '[.[].name]']));
        if (!names.includes('issues.json')) return;
        const cname = names.includes('CNAME') ? (await ghJson([`repos/${owner}/${r.name}/contents/CNAME`, '-H', 'Accept: application/vnd.github.raw'])).trim() : '';
        const slug = slugOfRepo(r.name);
        out.push({ ...r, domain: cname, slug, imported: !!db[slug], modernised: !!db[slug]?.modernised });
      } catch { /* unreadable repo: skip */ }
    }));
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
const slugOfRepo = (n) => n.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// Turn an old portal's files into a project config (best effort; everything stays editable).
function fromOldSite(owner, repo, f) {
  const j = JSON.parse(f.issues);
  const books = (Array.isArray(j) ? j : j.books || []).filter((b) => b && b.identifier).map((b) => ({ ...b, tags: normTags(b.tags) }));
  const m = (re) => (re.exec(f.html || '') || [])[1] || '';
  const host = (f.cname || '').trim().toLowerCase(), [sub, ...rest] = host.split('.');
  const lang = m(/<html[^>]*\blang=["']([\w-]+)/i) || 'kn';
  const slug = slugOfRepo(repo);
  const title = strip(m(/<title[^>]*>([\s\S]*?)<\/title>/i)) || repo;
  const desc = strip(m(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)/i));
  return {
    slug, owner, repo, sub: sub || slug, domain: rest.join('.') || 'sanchaya.net',
    title, tagline: '', description: desc, orgName: books.find((b) => b.publisher)?.publisher || owner, orgUrl: '',
    lang, readLabel: lang.startsWith('kn') ? 'ಓದಿರಿ' : 'Read', openMode: f.hasFrame ? 'frame' : 'tab',
    gaId: m(/\b(G-[A-Z0-9]{6,})\b/), partners: '', footer: '', query: '', info: '', books,
    projectName: '', prefix: '', collaborator: '', program: '', about: '',
    dirty: { title: 1, tagline: 1, description: 1, orgName: 1, query: 1, info: 1, slug: 1 },
    imported: true, modernised: false,
  };
}

async function importPortal(owner, repo, log) {
  ownerOk(owner);
  if (!/^[A-Za-z0-9._-]+$/.test(repo)) throw new Error('repo name is invalid');
  const slug = slugOfRepo(repo), dir = path.join(WS, slug);
  if (fs.existsSync(path.join(dir, '.git'))) await sh('git', ['pull', '--ff-only'], dir, log);
  else { fs.mkdirSync(WS, { recursive: true }); await sh('gh', ['repo', 'clone', `${owner}/${repo}`, dir], WS, log); }
  const rd = (n) => (fs.existsSync(path.join(dir, n)) ? fs.readFileSync(path.join(dir, n), 'utf8') : '');
  const p = fromOldSite(owner, repo, { issues: rd('issues.json'), html: rd('index.html'), cname: rd('CNAME'), hasFrame: fs.existsSync(path.join(dir, 'frame.html')) });
  p.designVersion = +(/<meta name="portal-design" content="(\d+)"/.exec(rd('index.html')) || [])[1] || 1;
  p.defaultBranch = (await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dir })).stdout.trim();
  const logo = path.join(dir, 'img', 'logo.png');
  if (fs.existsSync(logo)) { const a = path.join(DATA, 'assets', slug); fs.mkdirSync(a, { recursive: true }); fs.copyFileSync(logo, path.join(a, 'logo.png')); }
  const db = load(); validate(p); db[slug] = { ...p, ...Object.fromEntries(Object.entries(db[slug] || {}).filter(([k]) => ['modernised'].includes(k))) }; save(db);
  log.push(`Imported ${owner}/${repo}: ${p.books.length} items, ${p.sub}.${p.domain}`);
  return slug;
}

// Back up the live design on branches, replace the repo content with the new design, push everything.
async function modernise(p, log) {
  const dir = path.join(WS, p.slug), g = (...a) => sh('git', a, dir, log);
  if (!fs.existsSync(path.join(dir, '.git'))) throw new Error('import this portal first');
  const br = p.defaultBranch || 'master', t = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12);
  await g('config', 'user.name', GIT_NAME); await g('config', 'user.email', GIT_EMAIL);
  await g('fetch', 'origin');
  await g('checkout', br);
  await g('reset', '--hard', `origin/${br}`);
  const heads = (await run('git', ['ls-remote', '--heads', 'origin'], { cwd: dir })).stdout;
  const hasPages = /\srefs\/heads\/gh-pages$/m.test(heads);
  await g('push', 'origin', `HEAD:refs/heads/backup-old-design-${t}`);
  if (hasPages) await g('push', 'origin', `origin/gh-pages:refs/heads/backup-old-design-pages-${t}`);
  log.push(`Old design kept on branch backup-old-design-${t}`);
  await g('rm', '-rq', '--ignore-unmatch', '.');
  p.books = await refreshFromIA(p.books, log);
  build(p);
  await g('add', '-A');
  if ((await run('git', ['status', '--porcelain'], { cwd: dir })).stdout.trim()) await g('commit', '-m', `Modernise portal design (old design kept on backup-old-design-${t})`);
  else log.push('(design already up to date)');
  await g('push', 'origin', br);
  if (hasPages) await g('push', 'origin', `${br}:gh-pages`).catch(() => g('push', '--force-with-lease', 'origin', `${br}:gh-pages`)); // old gh-pages is backed up above
  else await sh('gh', ['api', '-X', 'POST', `repos/${p.owner}/${p.repo || p.slug}/pages`, '-f', `source[branch]=${br}`, '-f', 'source[path]=/'], dir, log).catch(() => log.push('(Pages already enabled)'));
  log.push(`\nDone. GitHub Pages will refresh in a minute or two → https://${p.sub || p.slug}.${p.domain}`);
}

// ---- http ------------------------------------------------------------------
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png' };
const send = (res, code, body, type = 'application/json') => { res.writeHead(code, { 'Content-Type': type }); res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body)); };

function serveFile(res, base, rel) {
  let f = path.resolve(base, '.' + path.sep + decodeURIComponent(rel));
  if (!f.startsWith(base + path.sep)) return send(res, 403, 'forbidden', 'text/plain');
  if (fs.existsSync(f) && fs.statSync(f).isDirectory()) f = path.join(f, 'index.html');
  if (!fs.existsSync(f)) return send(res, 404, 'not found', 'text/plain');
  send(res, 200, fs.readFileSync(f), TYPES[path.extname(f)] || 'application/octet-stream');
}

async function api(req, res, url) {
  const db = load();
  const [, , name, slug] = url.pathname.split('/');
  if (req.method === 'GET' && name === 'projects') return send(res, 200, db);
  if (req.method === 'GET' && name === 'meta') return send(res, 200, { designVersion: DESIGN_VERSION });
  if (req.method === 'GET' && name === 'gh') {
    try { return send(res, 200, await listPortals(url.searchParams.get('owner'))); }
    catch (e) { return send(res, 200, { error: 'Could not list repos: ' + ((e.stderr || e.message) + '').trim().slice(0, 300) }); }
  }
  let body = '';
  for await (const c of req) { body += c; if (body.length > 30e6) throw new Error('body too large'); }
  const b = body ? JSON.parse(body) : {};

  if (name === 'projects' && req.method === 'PUT') {
    validate(b); db[b.slug] = { ...b, books: b.books || [] }; save(db); return send(res, 200, { ok: true });
  }
  if (name === 'projects' && req.method === 'DELETE') { delete db[slug]; save(db); return send(res, 200, { ok: true }); }
  if (name === 'fetch') {
    if (!b.query) throw new Error('enter an Internet Archive query');
    const r = merge(b.books || [], (await iaFetch(b.query)).map((d) => toBook(d, b.info)));
    return send(res, 200, r);
  }
  if (name === 'asset') { // POST /api/asset/<slug>/<logo|favicon>
    const kind = url.pathname.split('/')[4];
    if (!/^[a-z0-9-]+$/.test(slug) || !['logo', 'favicon'].includes(kind)) throw new Error('bad asset');
    const dir = path.join(DATA, 'assets', slug);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, kind + '.png'), Buffer.from(b.dataUrl.split(',')[1], 'base64'));
    return send(res, 200, { ok: true });
  }
  if (name === 'import') {
    const log = [], done = [];
    for (const r of b.repos || []) { try { done.push(await importPortal(b.owner, r, log)); } catch (e) { log.push(`${r}: ${((e.stderr || e.message) + '').trim().slice(0, 300)}`); } }
    return send(res, 200, { slugs: done, log, projects: load() });
  }
  if (name === 'modernise') {
    const log = [], p = db[slug];
    try {
      if (!p || !p.imported) throw new Error('only imported portals can be modernised');
      await modernise(p, log); p.modernised = true; p.designVersion = DESIGN_VERSION; save({ ...db, [slug]: p });
      send(res, 200, { ok: true, log });
    } catch (e) { log.push(e.message); send(res, 200, { ok: false, log }); }
    return;
  }
  if (name === 'build') { build(db[slug]); return send(res, 200, { preview: `/preview/${slug}/` }); }
  if (name === 'launch') {
    const log = [];
    try { await launch(db[slug], log); db[slug].designVersion = DESIGN_VERSION; save(db); send(res, 200, { ok: true, log }); }
    catch (e) { send(res, 200, { ok: false, log }); }
    return;
  }
  send(res, 404, { error: 'unknown endpoint' });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/health') return send(res, 200, 'ok', 'text/plain');
    if (ADMIN_PASSWORD) {
      if (!authorized(req.headers.authorization, ADMIN_USER, ADMIN_PASSWORD)) {
        res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="portal-builder"' });
        return res.end('login required');
      }
    } else if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(req.headers.host || '')) {
      // No password: local-only. Blocks DNS rebinding; the JSON content-type below forces a CORS preflight.
      return send(res, 403, 'forbidden', 'text/plain');
    }
    if (url.pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && !(req.headers['content-type'] || '').includes('application/json')) return send(res, 415, { error: 'json only' });
      return await api(req, res, url);
    }
    if (url.pathname.startsWith('/assets/')) return serveFile(res, path.join(DATA, 'assets'), url.pathname.slice('/assets/'.length));
    if (url.pathname.startsWith('/preview/')) return serveFile(res, WS, url.pathname.slice('/preview/'.length));
    serveFile(res, path.join(ROOT, 'public'), url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
  } catch (e) {
    send(res, 400, { error: e.message });
  }
});

if (require.main === module) {
  if (!ADMIN_PASSWORD && !['127.0.0.1', 'localhost'].includes(HOST)) {
    console.error(`Refusing to listen on ${HOST} without ADMIN_PASSWORD (this app can push to GitHub).`);
    process.exit(1);
  }
  server.listen(PORT, HOST, () => console.log(`portal-builder → http://${HOST}:${PORT}`));
}
module.exports = { refreshBooks, DESIGN_VERSION, fromOldSite, build, merge, toBook, server, authorized };
