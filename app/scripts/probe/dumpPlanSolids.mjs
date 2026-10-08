// 平面の断面解決（S4 の新レイヤ PlanSolidsLayer が描く線）を、文書・階ごとに JSON へ落とす。
// 各階を「その階をアクティブにしたとき」と同じ入口（plan/planSolidsLayerFilter.js planSolidsLayerPrimitives。
// 自階＋直下の採用階）で解決し、線を安定キー順に並べて出力する。あわせて cls×kind の件数と所要時間を表で出す。
// 使い方: node --import ./scripts/testSetup.mjs scripts/probe/dumpPlanSolids.mjs <出力先ディレクトリ> [src.stq ...]
//   src を省略すると 13 / moku4 / moku1-6 / wood-void-test / plan-solids-test（D:/tatsuya/Download）。
//   出力: <出力先>/planSolids-<文書名>-<階名>.json と summary.json
import fs from 'node:fs';
import path from 'node:path';
import { loadDocument } from './loadDoc.mjs';
import { planCutHeightMmOf } from '../../src/core.js';
import { planSolidsLayerPrimitives } from '../../src/plan/planSolidsLayerFilter.js';
import { stairRiserOf } from '../../src/finish/stair/stairDimensions.js';

const outDir = process.argv[2] ?? path.join(import.meta.dirname, 'golden-plan-solids');
const DEFAULT_SRC = ['13', 'moku4', 'moku1-6', 'wood-void-test', 'plan-solids-test'].map(n => `D:/tatsuya/Download/${n}.stq`);
const sources = process.argv.length > 3 ? process.argv.slice(3) : DEFAULT_SRC;
fs.mkdirSync(outDir, { recursive: true });

const safe = s => s.replace(/[^\w一-龥ぁ-んァ-ヶー-]/g, '_');
const r1 = v => Math.round(v * 1000) / 1000;
const summary = [];
for (const src of sources) {
  const doc = path.basename(src, '.stq');
  const { project } = loadDocument(src);
  const planes = project.planes; // 採用階（elevation 昇順。屋根専用平面・検討案を除く）
  planes.forEach((plane, idx) => {
    const graph = project.graphMap.get(plane.id);
    if (!graph) return;
    const below = idx > 0 ? planes[idx - 1] : null;
    const belowGraph = below ? project.graphMap.get(below.id) : null;
    const belowPeek = belowGraph ? { graph: belowGraph, floorHeightMm: plane.elevation - below.elevation } : null;
    const t0 = performance.now();
    const prims = planSolidsLayerPrimitives({
      graph, belowPeek, selfRiserOf: s => stairRiserOf(s, project, plane), cutZ: planCutHeightMmOf(plane),
    });
    const ms = performance.now() - t0;
    // S5 から下屋の傾斜ラベル（arrow・text）も出るので、線（kind:'line'）だけを数える（ラベルは roof の線と別に labels で出す）
    const labels = prims.filter(p => p.kind !== 'line').length;
    const lines = prims.filter(p => p.kind === 'line').map(p => ({
      key: p.key, cls: p.cls, kind: p.source.kind, id: p.source.id, layerFloorZ: p.source.layerFloorZ ?? 0,
      weight: p.weight, points: p.points.map(r1),
    })).sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    fs.writeFileSync(path.join(outDir, `planSolids-${safe(doc)}-${safe(plane.name)}.json`), JSON.stringify(lines, null, 1));
    const counts = {};
    for (const l of lines) counts[`${l.cls}/${l.kind}`] = (counts[`${l.cls}/${l.kind}`] ?? 0) + 1;
    summary.push({ doc, floor: plane.name, below: below?.name ?? null, lines: lines.length, labels, counts, ms: Math.round(ms) });
  });
}
fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 1));
for (const s of summary) console.log(`${s.doc}\t${s.floor}\t下階=${s.below ?? '-'}\t${s.lines}本\tラベル${s.labels}\t${JSON.stringify(s.counts)}\t${s.ms}ms`);
