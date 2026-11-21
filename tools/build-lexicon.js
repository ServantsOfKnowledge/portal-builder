// Rebuild lexicon/kn.json from the Kannada text in portals' issues.json files.
// Usage: node tools/build-lexicon.js <folder holding one sub-folder per portal> [more folders...]
const fs = require('fs'), path = require('path'), { buildLexicon } = require('../server');
const texts = [];
for (const root of process.argv.slice(2))
  for (const d of fs.readdirSync(root)) {
    const f = path.join(root, d, 'issues.json');
    if (!fs.existsSync(f)) continue;
    try { const j = JSON.parse(fs.readFileSync(f, 'utf8')); for (const b of Array.isArray(j) ? j : j.books || []) texts.push(b.title, b.author, b.tags, b.publisher); } catch { /* skip unreadable file */ }
  }
const lex = buildLexicon(texts);
fs.mkdirSync(path.join(__dirname, '..', 'lexicon'), { recursive: true });
fs.writeFileSync(path.join(__dirname, '..', 'lexicon', 'kn.json'), JSON.stringify(lex));
console.log(Object.keys(lex).length + ' words from ' + texts.length + ' fields');
