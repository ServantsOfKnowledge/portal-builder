// Offline self-check: renders portals and verifies output. Run: node test.js
const assert = require('assert'), fs = require('fs'), path = require('path');
const { build, merge, toBook, authorized } = require('./server');

// --- IA mapping and merge
const doc = { identifier: 'x_1999_v1', title: 'T "q" <b>', creator: ['A B'], year: 1999, description: '<p>hi  there</p>',
  imagecount: '64', licenseurl: 'https://creativecommons.org/licenses/by/4.0/' };
const b = toBook(doc, '');
assert.equal(b.level, 1999); assert.equal(b.info, 'hi there'); assert.equal(b.pages, 64);
assert.equal(b.authorUrl, 'https://archive.org/search?query=creator%3A%22A+B%22');

const old = { ...b, title: 'edited' }; delete old.pages; delete old.license;
const m = merge([old], [b, toBook({ identifier: 'a_2000', year: 2000 }, 'common')]);
assert.equal(m.added, 1); assert.equal(m.books[1].title, 'edited'); assert.equal(m.books[0].info, 'common');
assert.equal(m.books[1].pages, 64, 'existing rows gain missing fields without losing edits');

// --- rendering
const mk = (id, title, level, extra = {}) => ({ identifier: id, title, author: 'Au', publisher: '', info: '', tags: 'tag1,tag2', level, authorUrl: '',
  url: 'https://archive.org/details/' + id, cover: 'https://archive.org/services/img/' + id, ...extra });
const books = [
  mk('j_1991_02_v11_i10', 'ಜನಪದ : ಸಂಪುಟ-11, ಸಂಚಿಕೆ-10', 1991, { pages: 80 }),
  mk('j_1991_02_v11_i2', 'ಜನಪದ : ಸಂಪುಟ-11, ಸಂಚಿಕೆ-2', 1991),
  mk('j_1990_07_v10_i1', 'ಜನಪದ : ಸಂಪುಟ-10, ಸಂಚಿಕೆ-1', 1990, { license: 'https://creativecommons.org/licenses/by/4.0/' }),
  mk('z_unknown', 'No year <script>alert(1)</script>', ''),
];
const base = { slug: 'selftest', owner: 'sanchaya', domain: 'sanchaya.net', title: 'My "Portal"', tagline: 't', description: 'd',
  orgName: 'Seva <Trust>', orgUrl: 'https://seva.example', lang: 'kn', readLabel: 'ಓದಿರಿ', gaId: '', query: 'q', books,
  partners: 'Sanchaya | https://sanchaya.org\nbad | javascript:alert(1)' };
const read = (dir, f) => fs.readFileSync(path.join(dir, f), 'utf8');

let { dir, host } = build({ ...base, openMode: 'tab' });
let html = read(dir, 'index.html');
assert.equal(host, 'selftest.sanchaya.net');
assert(!/__[A-Z_]+__/.test(html), 'unreplaced placeholder');
assert(html.includes('My &quot;Portal&quot;') && html.includes('https://selftest.sanchaya.net'));
assert(html.includes('Published by <a href="https://seva.example"') && html.includes('Seva &lt;Trust&gt;'));
assert(html.includes('sanchaya.org') && !html.includes('javascript:'), 'partners');
assert(!html.includes('<script>alert(1)') && html.includes('&lt;script&gt;alert(1)'), 'titles are escaped');
assert(!html.includes('googletagmanager') && !html.includes('id="viewer"') && !html.includes('maximum-scale'));
assert(html.includes('ಸಂಪುಟ 10') && html.includes('ಸಂಪುಟ 11'), 'volume headings');
// chronological: 1990 before 1991; i2 before i10 (numeric order); unknown year last
const at = (s) => html.indexOf(s);
assert(at('data-year="1990"') < at('data-year="1991"') && at('data-year="1991"') < at('data-year="unknown"'));
assert(at('j_1991_02_v11_i2') < at('j_1991_02_v11_i10'), 'natural order');
assert(html.includes('CC BY 4.0') && html.includes('80 ಪುಟಗಳು') && html.includes('archive.org/download/j_1990_07_v10_i1'));
assert(html.includes('loading="lazy"') && html.includes('type="application/ld+json"') && html.includes('"numberOfItems":4'));
assert.equal((html.match(/<li class="card"/g) || []).length, 4);
assert(html.includes('Servants of Knowledge</a> Initiative') && html.includes('./img/sok-logo.png'));
assert(fs.existsSync(path.join(dir, 'img', 'sok-logo.png')), 'logo copied into the portal');
assert.equal(read(dir, 'CNAME'), 'selftest.sanchaya.net\n');
assert(read(dir, 'robots.txt').includes('sitemap.xml') && read(dir, 'sitemap.xml').includes('<loc>https://selftest.sanchaya.net/</loc>'));
assert.equal(JSON.parse(read(dir, 'issues.json')).books.length, 4);

({ dir } = build({ ...base, openMode: 'frame', partners: '', orgName: '', footer: '', lang: 'en' }));
html = read(dir, 'index.html');
assert(html.includes('id="viewer"') && html.includes('var FRAME = true') && !html.includes('class="partners"'), 'frame mode, no partners');
assert(html.includes('Search title, author, year') && html.includes('Vol. 11'), 'english labels');
fs.rmSync(dir, { recursive: true });

// --- auth
const basic = (u, p) => 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64');
assert(authorized(basic('admin', 'p:w'), 'admin', 'p:w'), 'auth ok (password may contain colon)');
assert(!authorized(basic('admin', 'x'), 'admin', 'p:w') && !authorized(basic('bob', 'p:w'), 'admin', 'p:w') && !authorized('', 'admin', 'p:w'));

{ // importing an old portal
  const { fromOldSite } = require('./server.js');
  const p = fromOldSite('sanchaya', 'Janapada-Vichara', { issues: '{"books":[{"identifier":"a","publisher":"Pub"}]}', html: '<html lang="kn"><title>T</title><meta name="description" content="D">G-ABCDEF123', cname: 'jv.sanchaya.net\n', hasFrame: true });
  assert(p.slug === 'janapada-vichara' && p.sub === 'jv' && p.domain === 'sanchaya.net' && p.title === 'T' && p.description === 'D' && p.orgName === 'Pub' && p.openMode === 'frame' && p.gaId === 'G-ABCDEF123' && p.books.length === 1);
}
assert(html.includes('<meta name="portal-design" content="' + require('./server.js').DESIGN_VERSION + '">'));
assert(toBook({ identifier: 'q', subject: ['a; b ;c', 'b', 'd,e'] }).tags === 'a,b,c,d,e', 'subjects split into comma tags');
assert(!html.includes('class="year"'), 'one flat list, no per-year sections');
{ // refresh: IA wins where it has a value, keeps the rest
  const { refreshBooks } = require('./server.js');
  const r = refreshBooks([{ identifier: 'a', title: 'old', author: 'Old', level: 'ಮಾಸಿಕ', publisher: 'P' }, { identifier: 'z', title: 'keep' }], new Map([['a', toBook({ identifier: 'a', title: 'New', year: 1999 })]]));
  assert(r.n === 1 && r.books[0].title === 'New' && r.books[0].level === 1999 && r.books[0].author === 'Old' && r.books[0].publisher === 'P' && r.books[1].title === 'keep');
}
assert(/class="note"[^>]*>desc one/.test(require('./server.js').renderList([{ identifier: 'n1', title: 'T', note: 'desc one' }], { VOL: 'V', ISSUE: 'I', PAGES: 'p', DOWNLOAD: 'd', LICENSE: 'l', UNKNOWN: '?' }, 'Read')), 'item description shown as a note');
assert(require('./server.js').pickCollection([{ collection: ['opensource', 'ServantsOfKnowledge', 'booksbylanguage_kannada'] }, { collection: 'ServantsOfKnowledge' }, { collection: ['texts', 'Other'] }]) === 'ServantsOfKnowledge');
assert(require('./server.js').pickCollection([{ collection: ['JaiGyan', 'ServantsOfKnowledge'] }]) === 'ServantsOfKnowledge', 'tie prefers ServantsOfKnowledge');
{ // a language name in the year slot
  const { cleanBook } = require('./server.js');
  const a = cleanBook({ identifier: 'jst.x0000_1991_03_v1', level: 'ಕನ್ನಡ', tags: 't1' }), b = cleanBook({ identifier: 'nodate', level: 'Kannada', tags: '' }), c = cleanBook({ identifier: 'z', level: '1985' });
  assert(a.level === 1991 && a.tags === 't1,ಕನ್ನಡ' && b.level === '' && b.tags === 'Kannada' && c.level === 1985);
}
console.log('ok');
