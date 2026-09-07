// 11.stq の各階の構造（柱・梁の実体と、平面へ効く柱の仕上げ包み外形）をJSONへ落とす。
import fs from 'node:fs';
import path from 'node:path';
import { loadDocument } from './loadDoc.mjs';
import { columnWrapSolids } from '../../src/finish/columnWrap.js';

const outDir = process.argv[2] ?? path.join(import.meta.dirname, 'golden');
const src = process.argv[3] ?? 'D:/tatsuya/Download/11.stq';
fs.mkdirSync(outDir, { recursive: true });
const r = (v) => (typeof v === 'number' ? Math.round(v * 1000) / 1000 : null);

const { project } = loadDocument(src);
const summary = [];
for (const p of project.orderedTabs) {
  const graph = project.graphMap.get(p.id);
  if (!graph) continue;
  const columns = (graph.columns ?? []).map(c => ({ id: c.id, role: c.role ?? null, no: c.memberNo ?? null }))
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  const beams = (graph.beams ?? []).map(b => ({ id: b.id, role: b.role ?? null, no: b.memberNo ?? null }))
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  const wraps = columnWrapSolids(graph).map(({ column, wrapped, hidden }) => ({
    column: column.id, hidden,
    xLo: r(wrapped.xLo), xHi: r(wrapped.xHi), yLo: r(wrapped.yLo), yHi: r(wrapped.yHi),
    finishes: Object.fromEntries(Object.entries(wrapped.finishes ?? {}).map(([k, v]) => [k, r(v)])),
    trimmed: wrapped.trimmed, continued: wrapped.continued,
  })).sort((a, b) => (a.column < b.column ? -1 : 1));
  const name = p.name.replace(/[^\w一-龥ぁ-んァ-ヶー]/g, '_');
  fs.writeFileSync(path.join(outDir, `struct-${name}.json`), JSON.stringify({ columns, beams, wraps }, null, 1));
  summary.push({ plane: p.name, columns: columns.length, beams: beams.length, wraps: wraps.length });
}
fs.writeFileSync(path.join(outDir, 'struct-summary.json'), JSON.stringify(summary, null, 1));
console.log(JSON.stringify(summary));
