// 【S0 専用】case1/case2 の出力は k1 前のコミット d0d8fa8 のコードでしか作れない（k1 以後は current のみ）。
// 課題(k) S0: kOpeningBeamProbe.mjs の出力3本（current / case1 / case2）を比べる。
// 引数: <current.json> <case1.json> <case2.json> [--edges]
//   既定: 階ごとに digest（梁芯・梁・柱）の差の件数（案1・案2 を current と比較）と、主構造別の開口の源の件数を出す。
//   --edges: 辺ごとの表（status・辺に乗る梁芯・梁・覆い長さ）も出す（current と案で違う辺だけ。--edges-all で全辺）。
// 読み取り専用。
import fs from 'node:fs';

const [pa, pb, pc] = process.argv.slice(2, 5);
if (!pa || !pb || !pc) { console.error('usage: kCompare.mjs <current.json> <case1.json> <case2.json> [--edges|--edges-all]'); process.exit(1); }
const showEdges = process.argv.includes('--edges') || process.argv.includes('--edges-all');
const allEdges = process.argv.includes('--edges-all');
const docs = [pa, pb, pc].map(p => JSON.parse(fs.readFileSync(p, 'utf8')));
const names = ['current', 'case1', 'case2'];

function setDiff(a, b) { // 多重集合の差（b にあって a に無い／a にあって b に無い）
  const cnt = new Map();
  for (const x of a) cnt.set(x, (cnt.get(x) ?? 0) + 1);
  const added = [];
  for (const x of b) { if ((cnt.get(x) ?? 0) > 0) cnt.set(x, cnt.get(x) - 1); else added.push(x); }
  const removed = [];
  for (const [x, n] of cnt) for (let i = 0; i < n; i++) removed.push(x);
  return { added, removed };
}
const fmtAxes = (e) => e.axes.map(a => `${a.kind}/${a.origin ?? '-'}[${a.ext[0] ?? ''}..${a.ext[1] ?? ''}]`).join(' + ') || '(なし)';
const fmtBeams = (e) => e.beams.map(b => `${b.role}${b.len}`).join(',') || '(なし)';

const total = { planes: 0, changed1: 0, changed2: 0, axes1: 0, axes2: 0, beams1: 0, beams2: 0, cols1: 0, cols2: 0 };
const byStruct = new Map();
console.log(`# ${docs[0].src}`);
for (let i = 0; i < docs[0].planes.length; i++) {
  const [p0, p1, p2] = docs.map(d => d.planes[i]);
  total.planes++;
  const d1 = { axes: setDiff(p0.digest.beamAxes, p1.digest.beamAxes), beams: setDiff(p0.digest.beams, p1.digest.beams), cols: setDiff(p0.digest.columns, p1.digest.columns) };
  const d2 = { axes: setDiff(p0.digest.beamAxes, p2.digest.beamAxes), beams: setDiff(p0.digest.beams, p2.digest.beams), cols: setDiff(p0.digest.columns, p2.digest.columns) };
  const n = (d) => d.axes.added.length + d.axes.removed.length;
  const nb = (d) => d.beams.added.length + d.beams.removed.length;
  const nc = (d) => d.cols.added.length + d.cols.removed.length;
  if (n(d1) + nb(d1) + nc(d1) > 0) total.changed1++;
  if (n(d2) + nb(d2) + nc(d2) > 0) total.changed2++;
  total.axes1 += n(d1); total.axes2 += n(d2); total.beams1 += nb(d1); total.beams2 += nb(d2); total.cols1 += nc(d1); total.cols2 += nc(d2);
  const s = byStruct.get(p0.structure) ?? { planes: 0, planesWithOpenings: 0, sources: 0, edges: 0, covered: 0, excluded: 0, unsupported: 0, rule: p0.openingRule, rangeAwareNow: p0.rangeAwareNow };
  s.planes++; if (p0.counts.edgeCount > 0) s.planesWithOpenings++;
  s.sources += p0.counts.sources; s.edges += p0.counts.edgeCount; s.covered += p0.counts.covered; s.excluded += p0.counts.excluded; s.unsupported += p0.counts.unsupported;
  byStruct.set(p0.structure, s);
  const changed = n(d1) + nb(d1) + nc(d1) + n(d2) + nb(d2) + nc(d2) > 0;
  console.log(`${p0.plane} [${p0.structure}] 案1: 梁芯±${n(d1)} 梁±${nb(d1)} 柱±${nc(d1)} / 案2: 梁芯±${n(d2)} 梁±${nb(d2)} 柱±${nc(d2)}`);
  if (changed) {
    for (const [lbl, d] of [['案1', d1], ['案2', d2]]) {
      for (const x of d.axes.added) console.log(`    ${lbl} 梁芯+ ${x}`);
      for (const x of d.axes.removed) console.log(`    ${lbl} 梁芯- ${x}`);
      for (const x of d.beams.added) console.log(`    ${lbl} 梁+ ${x}`);
      for (const x of d.beams.removed) console.log(`    ${lbl} 梁- ${x}`);
      for (const x of d.cols.added) console.log(`    ${lbl} 柱+ ${x}`);
      for (const x of d.cols.removed) console.log(`    ${lbl} 柱- ${x}`);
    }
  }
  if (showEdges) {
    for (let j = 0; j < p0.edges.length; j++) {
      const es = [p0, p1, p2].map(p => p.edges[j]);
      const same = es.every(e => JSON.stringify([e.status, e.axes, e.beams]) === JSON.stringify([es[0].status, es[0].axes, es[0].beams]));
      if (same && !allEdges) continue;
      console.log(`  辺 ${es[0].key} (${es[0].source}) 長さ${es[0].edgeLen}${same ? ' [差なし]' : ''}`);
      es.forEach((e, k) => console.log(`    ${names[k].padEnd(7)} status=${e.status} 梁芯=${fmtAxes(e)} 梁=${fmtBeams(e)} 覆い=${e.coveredLen}/${e.edgeLen} 小梁${e.secondaryCount}大梁${e.primaryCount}`));
    }
  }
}
console.log(`\n合計: 階${total.planes} / 案1で変化した階${total.changed1} (梁芯±${total.axes1} 梁±${total.beams1} 柱±${total.cols1}) / 案2で変化した階${total.changed2} (梁芯±${total.axes2} 梁±${total.beams2} 柱±${total.cols2})`);
for (const [k, v] of byStruct) console.log(`  主構造 ${k}: 階${v.planes} 開口あり${v.planesWithOpenings} 開口梁芯の規則=${v.rule} 現状rangeAware=${v.rangeAwareNow} 源${v.sources} 辺${v.edges} (被覆${v.covered} 除外${v.excluded} 支え不足${v.unsupported})`);
