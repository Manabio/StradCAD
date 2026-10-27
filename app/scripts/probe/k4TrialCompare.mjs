// 課題(k) k4: k4TrialProbe.mjs の出力2つ（修正前 base・修正後 new）を比べる。
// 出すもの: 重なり対の延べ・重なりのある試行・収束回数・覆われない辺・重複梁芯の集計、最終配置の違う試行（違いが小梁の撤去のみか）、
//   収束回数が違う／覆われない辺が増えた／重なりが増えた試行の数。-v を付けると試行ごとの差分を出す。
// 引数: <base.json> <new.json> [-v]
// 使い方（app/ で実行）: node scripts/probe/k4TrialCompare.mjs base.json new.json
import fs from 'node:fs';

const [basePath, newPath, flag] = process.argv.slice(2);
if (!basePath || !newPath) { console.error('usage: k4TrialCompare.mjs <base.json> <new.json> [-v]'); process.exit(1); }
const [a, b] = [basePath, newPath].map(p => JSON.parse(fs.readFileSync(p, 'utf8')).trials);
const diff = (x, y) => {
  const c = new Map(); for (const k of x) c.set(k, (c.get(k) ?? 0) + 1);
  const add = []; for (const k of y) { if ((c.get(k) ?? 0) > 0) c.set(k, c.get(k) - 1); else add.push(k); }
  const rem = []; for (const [k, n] of c) for (let i = 0; i < n; i++) rem.push(k);
  return { add, rem };
};
const sum = (t, f) => t.reduce((s, x) => s + (f(x) ?? 0), 0);
const row = (n, t) => ({ n, trials: t.length, 重なり延べ: sum(t, x => x.overlaps), 重なりのある試行: t.filter(x => x.overlaps > 0).length,
  収束回数合計: sum(t, x => x.convergedAt), 最大収束: Math.max(...t.map(x => x.convergedAt ?? 99)), 収束回数1: t.filter(x => x.convergedAt === 1).length,
  覆われない辺_延べ: sum(t, x => x.partial), 覆われない辺のある試行: t.filter(x => x.partial > 0).length, 重複梁芯: sum(t, x => x.dupAxes) });
console.log(JSON.stringify([row('base', a), row('new', b)], null, 0));
let same = 0, diffT = 0, onlyRemSecondary = 0, other = 0, conv = 0, partialUp = 0, ovWorse = 0;
const detail = [];
for (let i = 0; i < a.length; i++) {
  const x = a[i], y = b[i];
  if (x.convergedAt !== y.convergedAt) conv++;
  if (y.partial > x.partial) partialUp++;
  if (y.overlaps > x.overlaps) ovWorse++;
  let nd = 0, onlySec = true; const lines = [];
  for (const pl of Object.keys(x.final)) for (const k of ['axes', 'beams', 'columns']) {
    const d = diff(x.final[pl][k], y.final[pl][k]);
    for (const s of d.rem) { nd++; lines.push(`  ${pl} ${k}- ${s}`); if (!(k === 'beams' && s.startsWith('secondary:'))) onlySec = false; }
    for (const s of d.add) { nd++; lines.push(`  ${pl} ${k}+ ${s}`); onlySec = false; }
  }
  if (nd === 0) same++;
  else {
    diffT++; if (onlySec) onlyRemSecondary++; else other++;
    detail.push(`#${i} ${x.plane} ${x.dir}${x.from}->${x.to} ov ${x.overlaps}->${y.overlaps} conv ${x.convergedAt}->${y.convergedAt} partial ${x.partial}->${y.partial}\n` + lines.join('\n'));
  }
}
console.log(JSON.stringify({ 最終配置同一: same, 最終配置が違う: diffT, 違いが小梁の撤去のみ: onlyRemSecondary, それ以外を含む: other, 収束回数が違う: conv, 覆われない辺が増えた試行: partialUp, 重なりが増えた試行: ovWorse }));
if (flag === '-v') console.log(detail.join('\n'));
