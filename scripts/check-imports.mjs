// Run from stead-frontend:  node scripts/check-imports.mjs
import fs from 'fs';
import path from 'path';

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(dir, e.name))
      : e.name.endsWith('.js') ? [path.join(dir, e.name)] : []
  );
}

function exportsOf(file) {
  const src = fs.readFileSync(file, 'utf8');
  if (/export\s*\*\s*from/.test(src)) return null; // wildcard: can't check
  const names = new Set();
  for (const m of src.matchAll(/export\s+(?:async\s+)?(?:function\*?|const|let|var|class)\s+([\w$]+)/g)) names.add(m[1]);
  for (const m of src.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const p = part.trim();
      if (!p) continue;
      const bits = p.split(/\s+as\s+/);
      names.add((bits[1] || bits[0]).trim());
    }
  }
  if (/export\s+default\b/.test(src)) names.add('default');
  return names;
}

let problems = 0;
const cache = new Map();
const importRe = /import\s+([^'";]*?)\s+from\s+['"](\.{1,2}\/[^'"]+)['"]/g;
const bareRe = /import\s+['"](\.{1,2}\/[^'"]+)['"]/g;

for (const file of walk('src')) {
  const src = fs.readFileSync(file, 'utf8');
  for (const m of src.matchAll(bareRe)) {
    const target = path.resolve(path.dirname(file), m[1]);
    if (!fs.existsSync(target)) { problems++; console.log(`MISSING FILE  ${file}  ->  ${m[1]}`); }
  }
  for (const m of src.matchAll(importRe)) {
    const clause = m[1].trim();
    const spec = m[2];
    const target = path.resolve(path.dirname(file), spec);
    if (!fs.existsSync(target)) { problems++; console.log(`MISSING FILE  ${file}  ->  ${spec}`); continue; }
    if (!cache.has(target)) cache.set(target, exportsOf(target));
    const have = cache.get(target);
    if (have === null) continue;
    const brace = clause.match(/\{([^}]*)\}/);
    const wanted = [];
    if (brace) for (const p of brace[1].split(',')) { const n = p.trim().split(/\s+as\s+/)[0].trim(); if (n) wanted.push(n); }
    const before = clause.replace(/\{[^}]*\}/, '').replace(/,/g, '').trim();
    if (before && !before.startsWith('*')) wanted.push('default');
    for (const n of wanted) {
      if (!have.has(n)) { problems++; console.log(`BAD IMPORT    ${file}  needs '${n}' from ${spec}`); }
    }
  }
}

// Service worker precache paths must exist
const swPath = 'public/service-worker.js';
if (fs.existsSync(swPath)) {
  const sw = fs.readFileSync(swPath, 'utf8');
  for (const m of sw.matchAll(/['"`](\/[\w\-./]+\.(?:js|css|html|json|png|svg|ico|webp))['"`]/g)) {
    const rel = m[1].slice(1);
    if (!fs.existsSync(path.join('public', rel)) && !fs.existsSync(rel)) {
      problems++; console.log(`SW PRECACHE MISSING  ${m[1]}`);
    }
  }
}

console.log(problems ? `\n${problems} problem(s) found` : 'All imports OK');
process.exit(problems ? 1 : 0);