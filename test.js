// Offline self-check: renders a portal and verifies output. Run: node test.js
const assert = require('assert'), fs = require('fs'), path = require('path');
const { build, merge, toBook } = require('./server');

const doc = { identifier: 'x_1999_v1', title: 'T "q" <b>', creator: ['A B'], year: 1999, description: '<p>hi  there</p>' };
const b = toBook(doc, '');
assert.equal(b.level, 1999); assert.equal(b.info, 'hi there');
assert.equal(b.authorUrl, 'https://archive.org/search?query=creator%3A%22A+B%22');

const m = merge([{ ...b, title: 'edited' }], [b, toBook({ identifier: 'a_2000', year: 2000 }, 'common')]);
assert.equal(m.added, 1); assert.equal(m.books[1].title, 'edited'); assert.equal(m.books[0].info, 'common');

const base = { slug: 'selftest', owner: 'sanchaya', domain: 'sanchaya.net', title: 'My "Portal"', tagline: 't', description: 'd',
  orgName: 'Seva <Trust>', orgUrl: 'https://seva.example', lang: 'kn', readLabel: 'ಓದಿರಿ', gaId: '', query: 'q', books: [b],
  partners: 'Sanchaya | https://sanchaya.org\nbad | javascript:alert(1)' };
const read = (dir, f) => fs.readFileSync(path.join(dir, f), 'utf8');

let { dir, host } = build({ ...base, openMode: 'tab' });
let html = read(dir, 'index.html');
assert.equal(host, 'selftest.sanchaya.net');
assert(!/__[A-Z]+__/.test(html), 'unreplaced placeholder');
assert(html.includes('My &quot;Portal&quot;') && html.includes('https://selftest.sanchaya.net'));
assert(html.includes('Published by <a href="https://seva.example"') && html.includes('Seva &lt;Trust&gt;'));
assert(html.includes('sanchaya.org') && !html.includes('javascript:'), 'partners');
assert(!html.includes('googletagmanager') && !html.includes('id="viewer"'));
assert(html.includes('data-id="{{identifier}}"'));
assert.equal(read(dir, 'CNAME'), 'selftest.sanchaya.net\n');
assert.equal(JSON.parse(read(dir, 'issues.json')).books.length, 1);

({ dir } = build({ ...base, openMode: 'frame', partners: '', orgName: '', footer: '' }));
html = read(dir, 'index.html');
assert(html.includes('id="viewer"') && !html.includes('seeAlsoToggle"'), 'frame / no partners');
fs.rmSync(dir, { recursive: true });
console.log('ok');
