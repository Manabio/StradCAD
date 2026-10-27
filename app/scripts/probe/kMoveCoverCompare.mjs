// 課題(k) k2: kMoveCoverProbe.mjs の出力2つ（修正前 base・修正後 new）を比べる。
// 出すもの: 静止時と移動試行の覆われない辺の数、収束回数の分布、試行ごとの改善/同数/悪化、悪化した試行の辺の差、
//   覆われるようになった／なくなった辺の延べ数、残った覆われない辺（辺ごとの試行数）、最終の開口梁芯/梁の数が違う試行。
// 引数: <base.json> <new.json>
// 使い方（app/ で実行）: node scripts/probe/kMoveCoverCompare.mjs base.json new.json
import fs from 'node:fs';

const [basePath, newPath] = process.argv.slice(2);
if (!basePath || !newPath) { console.error('usage: kMoveCoverCompare.mjs <base.json> <new.json>'); process.exit(1); }
const a = JSON.parse(fs.readFileSync(basePath, 'utf8'));
const b = JSON.parse(fs.readFileSync(newPath, 'utf8'));
console.log('静止(移動前) 覆われない辺: base', a.base.partial, '(0覆い', a.base.zero, ')/辺', a.base.edges, ' new', b.base.partial, '(0覆い', b.base.zero, ')/辺', b.base.edges);
const sum = (t, k) => t.reduce((s, x) => s + (x[k] ?? 0), 0);
const dist = (t) => { const m = {}; for (const x of t) m[x.convergedAt] = (m[x.convergedAt] ?? 0) + 1; return m; };
console.log('試行', a.trials.length, b.trials.length);
console.log('収束回数分布 base', JSON.stringify(dist(a.trials)), 'new', JSON.stringify(dist(b.trials)));
console.log('覆われない辺の延べ数 base', sum(a.trials, 'partial'), 'new', sum(b.trials, 'partial'), ' うち覆い0 base', sum(a.trials, 'zero'), 'new', sum(b.trials, 'zero'));
console.log('覆われない辺ありの試行 base', a.trials.filter(t => t.partial > 0).length, 'new', b.trials.filter(t => t.partial > 0).length);
const worse = [];
let better = 0, same = 0, finalDiff = 0, countsDiff = 0;
for (let i = 0; i < a.trials.length; i++) {
  const x = a.trials[i], y = b.trials[i];
  if (x.plane !== y.plane || x.from !== y.from || x.to !== y.to || x.dir !== y.dir) { console.log('試行の対応が崩れた', i); continue; }
  if (y.partial > x.partial || y.zero > x.zero) worse.push(i);
  else if (y.partial < x.partial) better++; else same++;
  if (JSON.stringify(x.final) !== JSON.stringify(y.final)) finalDiff++;
  if (x.convergedAt !== y.convergedAt) countsDiff++;
}
console.log(`試行ごと: 改善${better} 同数${same} 悪化${worse.length}  最終位置が違う試行${finalDiff}  収束回数が違う試行${countsDiff}`);
for (const i of worse) {
  const x = a.trials[i], y = b.trials[i];
  console.log(`悪化 #${i} ${x.plane} ${x.dir} ${x.from}->${x.to} partial ${x.partial}->${y.partial} zero ${x.zero}->${y.zero}`);
  const sa = new Set(x.uncovered), sb = new Set(y.uncovered);
  for (const u of sb) if (!sa.has(u)) console.log('   +', u);
  for (const u of sa) if (!sb.has(u)) console.log('   -', u);
}
const edgeKey = (u) => u.split('|').slice(0, 4).join('|');
let gain = 0, loss = 0;
for (let i = 0; i < a.trials.length; i++) {
  const sa = new Set(a.trials[i].uncovered.map(edgeKey)), sb = new Set(b.trials[i].uncovered.map(edgeKey));
  for (const u of sa) if (!sb.has(u)) gain++;
  for (const u of sb) if (!sa.has(u)) loss++;
}
console.log('覆われるようになった辺（延べ）', gain, ' 覆われなくなった辺（延べ）', loss);
console.log('残った覆われない辺 new（辺ごとの試行数）');
const rem = new Map();
for (const t of b.trials) for (const u of t.uncovered) { const p = u.split('|'); const k = `${edgeKey(u)} ${p[4]} ${p[5]}`; rem.set(k, (rem.get(k) ?? 0) + 1); }
for (const [k, n] of [...rem].sort()) console.log('  ', n, k);
const cnt = (t) => t.counts.at(-1);
let cdiff = 0;
for (let i = 0; i < a.trials.length; i++) if (cnt(a.trials[i]) !== cnt(b.trials[i])) cdiff++;
console.log('最終の 開口梁芯/梁 数が違う試行', cdiff);
