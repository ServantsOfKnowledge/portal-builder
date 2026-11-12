// Offline self-check: renders a portal and verifies output. Run: node test.js
const assert = require('assert'), fs = require('fs'), path = require('path');
const { build, merge, toBook } = require('./server');

const doc = { identifier: 'x_1999_v1', title: 'T "q" <b>', creator: ['A B'], year: 1999, description: '<p>hi  there</p>' };
const b = toBook(doc, '');
assert.equal(b.level, 1999); assert.equal(b.info, 'hi there');
assert.equal(b.authorUrl, 'https://archive.org/search?query=creator%3A%22A+B%22');

const m = merge([{ ...b, title: 'edited' }], [b, toBook({ identifier: 'a_2000', year: 2000 }, 'common')]);
assert.equal(m.added, 1); assert.equal(m.books[1].title, 'edited'); assert.equal(m.books[0].info, 'common');

const { dir, host } = build({
  slug: 'selftest', org: 'sanchaya', domain: 'sanchaya.net', title: 'My "Portal"', tagline: 't', description: 'd',
  author: 'Auth', lang: 'kn', readLabel: 'ಓದಿರಿ', gaId: '', query: 'q', books: [b],
});
const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
assert.equal(host, 'selftest.sanchaya.net');
assert(!/__[A-Z]+__/.test(html), 'unreplaced placeholder');
assert(html.includes('My &quot;Portal&quot;') && html.includes('https://selftest.sanchaya.net'));
assert(!html.includes('googletagmanager'));
assert.equal(fs.readFileSync(path.join(dir, 'CNAME'), 'utf8'), 'selftest.sanchaya.net\n');
assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'issues.json'))).books.length, 1);
fs.rmSync(dir, { recursive: true });
console.log('ok');
