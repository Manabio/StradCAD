// 平面の断面解決（S4 の新レイヤ PlanSolidsLayer が描く線）を、文書・階ごとに JSON へ落とす。
// 各階を「その階をアクティブにしたとき」と同じ入口（plan/planSolidsLayerFilter.js planSolidsLayerPrimitives。
// 自階＋直下の採用階）で解決し、線を安定キー順に並べて出力する。あわせて層（自階／下階）×cls×kind の件数と所要時間を表で出す。
// 検査（S6c。いずれも 0 が正常。0 でなければ終了コード 1）:
//   下階cut   … 下階の層（layerFloorZ<0）の線で cls が 'cut' のもの（下階の立体は全部 below＝細線のはず）
//   穴の外    … 下階の層の線で、端点・中点が自階の床の穴の和（閉区間）の外にあるもの（窓の外に出ていないか）
// 参考値（二重描画の見積もり）:
//   階段吹抜け内の壁 … 下階の壁の線の中点が自階の stairVoid の穴の中にあるもの（21 文書で 251 本）。StairLayer の隔て壁の輪郭
//                      （partitionOutlineOf）と重なるのは実測 8 本だけで、残りは今回はじめて見える線（S6c 時点の件数。S7b 以降は段より低い
//                      壁の部分だけ消える〔28.3m＝下階の壁の総延長 375.6m の約 7%〕。段より高い壁は残る。分割で 251→265 本）
//   短線(<20mm) … 隙間の規則（plan/planSectionFigure.js PLAN_GAP_CLOSE_MM）の効果を見る
// 使い方: node --import ./scripts/testSetup.mjs scripts/probe/dumpPlanSolids.mjs [--up] <出力先ディレクトリ> [src.stq ...]
//   src を省略すると 13 / moku4 / moku1-6 / wood-void-test / plan-solids-test（D:/tatsuya/Download）。
//   出力: <出力先>/planSolids-<文書名>-<階名>.json と summary.json
//   --up（天伏の見上げ）: 各階を自階＋直上階で解く（planSolidsLayerPrimitivesUp）。出力は planSolidsUp-<文書名>-<階名>.json と
//     summary-up.json。件数は層（自階／上階）×cls×kind と細線／太線の本数、所要時間。下階cut・穴の外の検査は見下げ専用なので行わない。
import fs from 'node:fs';
import path from 'node:path';
import { loadDocument } from './loadDoc.mjs';
import { planCutHeightMmOf } from '../../src/core.js';
import { planSolidsLayerPrimitives, planSolidsLayerPrimitivesUp, planSolidsLayerSolids } from '../../src/plan/planSolidsLayerFilter.js';
import { stairRiserOf } from '../../src/finish/stair/stairDimensions.js';
import { floorOpeningCellRects } from '../../src/finish/stair/slabOpening.js';
import { stairFilterFor } from '../../src/structural/openingBeamAxes.js';

const UP = process.argv.includes('--up');
const args = process.argv.slice(2).filter(a => a !== '--up');
const outDir = args[0] ?? path.join(import.meta.dirname, 'golden-plan-solids');
const DEFAULT_SRC = ['13', 'moku4', 'moku1-6', 'wood-void-test', 'plan-solids-test'].map(n => `D:/tatsuya/Download/${n}.stq`);
const sources = args.length > 1 ? args.slice(1) : DEFAULT_SRC;
fs.mkdirSync(outDir, { recursive: true });

const safe = s => s.replace(/[^\w一-龥ぁ-んァ-ヶー-]/g, '_');
const r1 = v => Math.round(v * 1000) / 1000;
const TOL = 1e-3;
const inRects = (rects, x, y) => rects.some(h => x >= h.x1 - TOL && x <= h.x2 + TOL && y >= h.y1 - TOL && y <= h.y2 + TOL);
const summary = [];
let bad = 0;
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
    const selfRiserOf = s => stairRiserOf(s, project, plane);
    if (UP) {
      const above = idx + 1 < planes.length ? planes[idx + 1] : null;
      const aboveGraph = above ? project.graphMap.get(above.id) : null;
      const abovePeek = aboveGraph ? { graph: aboveGraph, floorHeightMm: above.elevation - plane.elevation } : null;
      const u0 = performance.now();
      const upPrims = planSolidsLayerPrimitivesUp({ graph, abovePeek, selfRiserOf, cutZ: planCutHeightMmOf(plane) });
      const upMs = performance.now() - u0;
      const upLines = upPrims.filter(p => p.kind === 'line').map(p => ({
        key: p.key, cls: p.cls, kind: p.source.kind, id: p.source.id, layerFloorZ: p.source.layerFloorZ ?? 0,
        weight: p.weight, points: p.points.map(r1),
      })).sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
      fs.writeFileSync(path.join(outDir, `planSolidsUp-${safe(doc)}-${safe(plane.name)}.json`), JSON.stringify(upLines, null, 1));
      const upCounts = {};
      for (const l of upLines) {
        const k = `${l.layerFloorZ > 0 ? '上階' : '自階'}:${l.cls}/${l.kind}`;
        upCounts[k] = (upCounts[k] ?? 0) + 1;
      }
      summary.push({
        doc, floor: plane.name, above: above?.name ?? null, lines: upLines.length, thin: upLines.filter(l => l.weight === 'thin').length,
        thick: upLines.filter(l => l.weight === 'thick').length, counts: upCounts, ms: Math.round(upMs),
      });
      return;
    }
    const t0 = performance.now();
    const prims = planSolidsLayerPrimitives({ graph, belowPeek, selfRiserOf, cutZ: planCutHeightMmOf(plane) });
    const ms = performance.now() - t0;
    // S5 から下屋の傾斜ラベル（arrow・text）も出るので、線（kind:'line'）だけを数える（ラベルは roof の線と別に labels で出す）
    const labels = prims.filter(p => p.kind !== 'line').length;
    const lines = prims.filter(p => p.kind === 'line').map(p => ({
      key: p.key, cls: p.cls, kind: p.source.kind, id: p.source.id, layerFloorZ: p.source.layerFloorZ ?? 0,
      weight: p.weight, points: p.points.map(r1),
    })).sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    fs.writeFileSync(path.join(outDir, `planSolids-${safe(doc)}-${safe(plane.name)}.json`), JSON.stringify(lines, null, 1));
    const counts = {};
    for (const l of lines) {
      const k = `${l.layerFloorZ < 0 ? '下階' : '自階'}:${l.cls}/${l.kind}`;
      counts[k] = (counts[k] ?? 0) + 1;
    }
    // 隙間の規則の効果: 20mm 未満の短線
    const short = lines.filter(l => Math.hypot(l.points[2] - l.points[0], l.points[3] - l.points[1]) < 20);
    // 下階の層の検査
    const lower = lines.filter(l => l.layerFloorZ < 0);
    const belowCut = lower.filter(l => l.cls === 'cut').length;
    const solids = planSolidsLayerSolids({ graph, belowPeek, selfRiserOf });
    const holes = solids.filter(s => s.kind === 'floor' && (s.source.layerFloorZ ?? 0) === 0).flatMap(s => s.footprint.holes ?? []);
    const mid = l => [(l.points[0] + l.points[2]) / 2, (l.points[1] + l.points[3]) / 2];
    const outside = lower.filter(l => !inRects(holes, l.points[0], l.points[1]) || !inRects(holes, l.points[2], l.points[3]) || !inRects(holes, ...mid(l))).length;
    const stairVoidRects = floorOpeningCellRects(graph, { riserOf: selfRiserOf, stairFilter: stairFilterFor(graph, belowGraph), sources: ['stairVoid'] });
    const stairVoidWalls = lower.filter(l => l.kind === 'wall' && inRects(stairVoidRects, ...mid(l))).length;
    if (belowCut > 0 || outside > 0) bad++;
    summary.push({
      doc, floor: plane.name, below: below?.name ?? null, lines: lines.length, labels, counts, short: short.length,
      shortLines: short.map(l => ({ key: l.key, points: l.points })), lower: lower.length, belowCut, outside, stairVoidWalls, ms: Math.round(ms),
    });
  });
}
if (UP) {
  fs.writeFileSync(path.join(outDir, 'summary-up.json'), JSON.stringify(summary, null, 1));
  for (const s of summary) {
    console.log(`${s.doc}\t${s.floor}\t上階=${s.above ?? '-'}\t${s.lines}本(細線${s.thin}・太線${s.thick})\t${JSON.stringify(s.counts)}\t${s.ms}ms`);
  }
  const total = key => summary.reduce((n, s) => n + s[key], 0);
  console.log(`見上げ 合計: ${total('lines')}本（細線${total('thin')}・太線${total('thick')}）`);
  process.exit(0);
}
fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 1));
for (const s of summary) {
  console.log(`${s.doc}\t${s.floor}\t下階=${s.below ?? '-'}\t${s.lines}本\tラベル${s.labels}\t短線(<20mm)=${s.short}\t下階層=${s.lower}本(下階cut=${s.belowCut}・穴の外=${s.outside}・階段吹抜け内の壁=${s.stairVoidWalls})\t${JSON.stringify(s.counts)}\t${s.ms}ms`);
}
const sum = key => summary.reduce((n, s) => n + s[key], 0);
console.log(`短線(<20mm) 合計: ${sum('short')}／下階層の線 合計: ${sum('lower')}／下階cut 合計: ${sum('belowCut')}／穴の外 合計: ${sum('outside')}／階段吹抜け内の下階の壁 合計: ${sum('stairVoidWalls')}`);
console.log(bad ? `検査 NG: ${bad} 階（下階cut・穴の外が 0 でない）` : '検査 OK（下階cut=0・穴の外=0）');
process.exitCode = bad ? 1 : 0;
