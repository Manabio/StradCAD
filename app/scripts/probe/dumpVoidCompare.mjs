// 吹抜けの注記（S6a）の関門: 旧経路（voidGeometry.js）と新経路（floorOpeningGroups＋planHoleMarks）の出力を文書・階ごとに比べる。
//   自階の×  … 旧 computeVoidCrosses(g)             vs 新 planHoleMarks の role 'cross'（rect＝innerRect）
//   上階破線 … 旧 visibleUpperVoidCrosses(computeVoidCrosses(上階), ownVoidCellRects(g)) vs 新 role 'upperVoid'（rect＋cellRect＋label）
// 許す差分は「穴が無ければ×も無い」の帰結だけ: 孤児器具行（室が無い／昇降路でない室を指す行）と、
// 室のセルが解決できない昇降路（器具行のセルが有効でも穴が無いので×を出さない）の行。それ以外の差分があれば終了コード 1。
// 使い方: node --import ./scripts/testSetup.mjs scripts/probe/dumpVoidCompare.mjs [src.stq ...]
//   src を省略すると 13 / moku1-6 / moku4 / wood-void-test / EV-test1 / void-overhang-test（D:/tatsuya/Download）。
// 環境変数 MUTATE=innerRect-as-cellRect で「innerRect を cellRect にすり替える」変異（検出力の確認用）。
import path from 'node:path';
import { loadDocument } from './loadDoc.mjs';
import { isShaftFeature } from '../../src/core.js';
import { refreshCells } from '../../src/finish/gridCells.js';
import { computeVoidCrosses, ownVoidCellRects, visibleUpperVoidCrosses, showsUpperVoidLabel } from '../../src/finish/voidGeometry.js';
import { floorOpeningGroups } from '../../src/finish/stair/slabOpening.js';
import { planHoleMarks, selfVoidHoleRects } from '../../src/plan/planHoleMarks.js';

const DEFAULT_SRC = ['13', 'moku1-6', 'moku4', 'wood-void-test', 'EV-test1', 'void-overhang-test'].map(n => `D:/tatsuya/Download/${n}.stq`);
const sources = process.argv.length > 2 ? process.argv.slice(2) : DEFAULT_SRC;
const mutate = process.env.MUTATE === 'innerRect-as-cellRect';

const r3 = v => Math.round(v * 1000) / 1000;
const rk = r => (r ? [r.x1, r.y1, r.x2, r.y2].map(r3).join(',') : '-');

// 孤児器具行: 室が無い、または昇降路でない室を指す行
function orphanRowIds(graph) {
  const roomById = new Map(graph.rooms.map(r => [r.id, r]));
  return new Set((graph.equipmentRows ?? [])
    .filter(row => {
      const room = roomById.get(row.roomId);
      return !room || !isShaftFeature(room.feature) || refreshCells(room.cells, graph).size === 0;
    })
    .map(row => row.id));
}

function oldEntries(graph, aboveGraph) {
  const out = computeVoidCrosses(graph).map(c => `cross|${c.id}|${rk(c)}`);
  if (aboveGraph) {
    for (const u of visibleUpperVoidCrosses(computeVoidCrosses(aboveGraph), ownVoidCellRects(graph))) {
      out.push(`upper|${u.id}|cell=${rk(u.cellRect)}|inner=${rk(u)}|label=${showsUpperVoidLabel(u)}`);
    }
  }
  return out;
}

function newEntries(graph, aboveGraph) {
  const selfGroups = floorOpeningGroups(graph, { stairFilter: () => false });
  const aboveGroups = aboveGraph ? floorOpeningGroups(aboveGraph, { stairFilter: () => false }) : null;
  const fix = gs => (mutate ? gs.map(g => (g.cellRect ? { ...g, innerRect: g.cellRect } : g)) : gs);
  const marks = planHoleMarks({ selfGroups: fix(selfGroups), selfVoidCells: selfVoidHoleRects(graph), aboveGroups: aboveGroups && fix(aboveGroups) });
  return marks.map(m => (m.role === 'cross'
    ? `cross|${m.source.id}|${rk(m.rect)}`
    : `upper|${m.source.id}|cell=${rk(m.cellRect)}|inner=${rk(m.rect)}|label=${m.label}`));
}

let bad = 0;
console.log('doc\tfloor\t旧\t新\t一致\t旧のみ(孤児行)\t旧のみ(その他)\t新のみ\t孤児行数');
for (const src of sources) {
  const doc = path.basename(src, '.stq');
  let project;
  try { ({ project } = loadDocument(src)); } catch (e) { console.log(`${doc}\t(読み込み失敗: ${e.message})`); bad++; continue; }
  const planes = project.planes;
  planes.forEach((plane, idx) => {
    const graph = project.graphMap.get(plane.id);
    if (!graph) return;
    const above = planes[idx + 1] ? project.graphMap.get(planes[idx + 1].id) ?? null : null;
    const orphans = orphanRowIds(graph);
    const orphansAbove = above ? orphanRowIds(above) : new Set();
    const o = oldEntries(graph, above), n = newEntries(graph, above);
    const nSet = new Set(n), oSet = new Set(o);
    const oldOnly = o.filter(e => !nSet.has(e));
    const newOnly = n.filter(e => !oSet.has(e));
    const isOrphan = e => { const id = e.split('|')[1]; return orphans.has(id) || orphansAbove.has(id); };
    const oldOnlyOrphan = oldOnly.filter(isOrphan), oldOnlyOther = oldOnly.filter(e => !isOrphan(e));
    const same = o.length - oldOnly.length;
    if (oldOnlyOther.length || newOnly.length) bad++;
    const split = a => `${a.length}(×${a.filter(e => e.startsWith('cross')).length}/破線${a.filter(e => e.startsWith('upper')).length})`;
    console.log(`${doc}\t${plane.name}\t${split(o)}\t${split(n)}\t${same}\t${oldOnlyOrphan.length}\t${oldOnlyOther.length}\t${newOnly.length}\t${orphans.size}`);
    for (const e of oldOnlyOther) console.log(`   旧のみ: ${e}`);
    for (const e of newOnly) console.log(`   新のみ: ${e}`);
  });
}
console.log(bad ? `差分あり: ${bad}` : '差分なし（孤児行を除く）');
process.exitCode = bad ? 1 : 0;
