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
    for (const f of ['identifier', 'title', 'creator', 'publisher', 'description', 'subject', 'date', 'year']) u.searchParams.append('fl[]', f);
    u.searchParams.append('sort[]', 'identifier asc');
    u.searchParams.set('rows', '500'); u.searchParams.set('page', page); u.searchParams.set('output', 'json');
    const r = await fetch(u);
    if (!r.ok) throw new Error('archive.org returned ' + r.status);
    const { response } = await r.json();
    docs.push(...response.docs);
    if (!response.docs.length || docs.length >= response.numFound) return docs;
  }
}

function toBook(d, info) {
  const author = arr(d.creator).join(', ');
  return {
    identifier: d.identifier,
    title: arr(d.title)[0] || d.identifier,
    author,
    publisher: arr(d.publisher).join(', '),
    info: info || strip(arr(d.description).join(' ')),
    tags: arr(d.subject).join(','),
    level: Number(d.year) || (d.date ? Number(d.date.slice(0, 4)) : '') || '',
    authorUrl: author ? `https://archive.org/search?query=creator%3A%22${encodeURIComponent(author).replace(/%20/g, '+')}%22` : '',
    url: `https://archive.org/details/${d.identifier}`,
    cover: `https://archive.org/services/img/${d.identifier}`,
  };
}

// Existing rows (and any hand edits) win; only new identifiers are appended.
function merge(existing, fresh) {
  const have = new Set(existing.map((b) => b.identifier));
  const added = fresh.filter((b) => !have.has(b.identifier));
  return { books: [...existing, ...added].sort((a, b) => a.identifier.localeCompare(b.identifier)), added: added.length };
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

// "Name | https://site | optional logo url" per line
function partnersHtml(text) {
  const items = String(text || '').split('\n').map((l) => l.split('|').map((x) => x.trim())).filter(([n, u]) => n && safeUrl(u));
  if (!items.length) return '';
  const links = items.map(([n, u, img]) => {
    const logo = safeUrl(img) || `https://www.google.com/s2/favicons?sz=128&domain=${encodeURIComponent(new URL(u).hostname)}`;
    return `<a href="${safeUrl(u)}" target="_blank" rel="noopener" title="${esc(n)}"><img src="${logo}" alt="${esc(n)}"><span>${esc(n)}</span></a>`;
  });
  return `<div class="pythonbooks span12"><a href="#" id="seeAlsoToggle">See also &#9654;</a><div class="partner-logos" style="display: none;">${links.join('')}</div></div>`;
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
  for (const d of ['css', 'js', 'img']) fs.cpSync(path.join(TPL, d), path.join(dir, d), { recursive: true });
  const assets = path.join(DATA, 'assets', p.slug);
  const logo = path.join(assets, 'logo.png'), fav = path.join(assets, 'favicon.png');
  if (fs.existsSync(logo)) fs.copyFileSync(logo, path.join(dir, 'img', 'logo.png'));
  if (fs.existsSync(fav)) for (const n of ['favicon-32x32.png', 'android-chrome-192x192.png']) fs.copyFileSync(fav, path.join(dir, 'img', 'ico', n));
  const host = `${p.sub || p.slug}.${p.domain}`;
  const v = {
    LANG: esc(p.lang || 'kn'), TITLE: esc(p.title), TAGLINE: esc(p.tagline), DESC: esc(p.description),
    AUTHOR: esc(p.orgName), SITE: 'https://' + host, OGIMG: esc(p.books[0]?.cover || ''),
    READ: esc(p.readLabel || 'Read'), GA: GA(p.gaId) || '',
    PARTNERS: partnersHtml(p.partners), CREDIT: creditHtml(p),
    FRAME: p.openMode === 'frame' ? fs.readFileSync(path.join(TPL, 'frame.html'), 'utf8') : '',
  };
  const html = fs.readFileSync(path.join(TPL, 'index.html'), 'utf8').replace(/__([A-Z]+)__/g, (m, k) => (k in v ? v[k] : m));
  fs.writeFileSync(path.join(dir, 'index.html'), html);
  fs.writeFileSync(path.join(dir, 'issues.json'), JSON.stringify({ books: p.books }, null, 2));
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
  const fresh = !fs.existsSync(path.join(dir, '.git'));
  if (fresh) await g('init', '-b', 'master');
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
  await g('push', '-u', 'origin', 'master');
  await g('push', 'origin', 'master:gh-pages');
  await sh('gh', ['api', '-X', 'POST', `repos/${repo}/pages`, '-f', 'source[branch]=gh-pages', '-f', 'source[path]=/'], dir, log)
    .catch(() => log.push('(Pages already enabled, or enable it in repo Settings → Pages)'));
  log.push(`\nDone. Add DNS: ${p.sub || p.slug}  CNAME  ${p.owner.toLowerCase()}.github.io.`);
  log.push(`Then tick "Enforce HTTPS" in the repo's Pages settings once DNS resolves → https://${host}`);
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
  if (name === 'build') { build(db[slug]); return send(res, 200, { preview: `/preview/${slug}/` }); }
  if (name === 'launch') {
    const log = [];
    try { await launch(db[slug], log); send(res, 200, { ok: true, log }); }
    catch (e) { send(res, 200, { ok: false, log }); }
    return;
  }
  send(res, 404, { error: 'unknown endpoint' });
}

const server = http.createServer(async (req, res) => {
  try {
    // Local-only: blocks DNS rebinding, and the JSON content-type forces a CORS preflight for other sites.
    if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(req.headers.host || '')) return send(res, 403, 'forbidden', 'text/plain');
    const url = new URL(req.url, 'http://localhost');
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

if (require.main === module) server.listen(PORT, '127.0.0.1', () => console.log(`portal-builder → http://localhost:${PORT}`));
module.exports = { build, merge, toBook, server };
