// 下屋の平面図形の新旧比較（S5 の関門）。旧＝finish/roof/roofPlanFigure.js roofPlanFigure(graph)（端止め trim 済みの線とラベル）、
// 新＝plan/planSolidsLayerFilter.js planSolidsLayerPrimitives の source.kind==='roof'（自階）の線とラベル。
// 線は折れ線→線分→同一直線上で重なりを結合→区間の突き合わせ（0.5mm 許容。plan/roofPlanCompare.js）で 一致／旧のみ／新のみ に分け、
// 差分の区間を原因の目安で分類する（壁の覆い・短い断片・他の下屋の覆い・壁の近傍・未説明。目安は座標の幾何だけで推定）。
// ラベルは座標・文字まで完全一致を見る。
// 使い方: node --import ./scripts/testSetup.mjs scripts/probe/dumpRoofPlanCompare.mjs <出力先ディレクトリ> [src.stq ...]
//   src を省略すると roof-test1〜10 と moku1-6（D:/tatsuya/Download）。出力: <出力先>/roofCompare-<文書>-<階>.json と summary.json
import fs from 'node:fs';
import path from 'node:path';
import { loadDocument } from './loadDoc.mjs';
import { planCutHeightMmOf } from '../../src/core.js';
import { planSolidsLayerPrimitives } from '../../src/plan/planSolidsLayerFilter.js';
import { planSolids } from '../../src/plan/planSolids.js';
import { oldLineRecords, newLineRecords, comparePieces, labelKeys } from '../../src/plan/roofPlanCompare.js';
import { roofPlanFigure } from '../../src/finish/roof/roofPlanFigure.js';
import { leanToPlanRegions } from '../../src/structural/roofFramingRegions.js';
import { wallConcealRange } from '../../src/finish/columnWrap.js';
import { stairRiserOf } from '../../src/finish/stair/stairDimensions.js';

const outDir = process.argv[2] ?? path.join(import.meta.dirname, 'out', 'roofCompare');
const DEFAULT_SRC = [...Array.from({ length: 10 }, (_, i) => `roof-test${i + 1}`), 'moku1-6'].map(n => `D:/tatsuya/Download/${n}.stq`);
const sources = process.argv.length > 3 ? process.argv.slice(3) : DEFAULT_SRC;
fs.mkdirSync(outDir, { recursive: true });

const safe = s => s.replace(/[^\w一-龥ぁ-んァ-ヶー-]/g, '_');
const r1 = v => Math.round(v * 10) / 10;

const rectsOfWalls = graph => (graph.walls ?? []).map(w => {
  const cr = wallConcealRange(w);
  if (!cr) return null;
  const lo = Math.min(w.coord1, w.coord2), hi = Math.max(w.coord1, w.coord2);
  return w.isVertical ? { x1: cr.lo, x2: cr.hi, y1: lo, y2: hi } : { x1: lo, x2: hi, y1: cr.lo, y2: cr.hi };
}).filter(Boolean);

const insideRect = (r, x, y, pad = 0) => x > r.x1 - pad && x < r.x2 + pad && y > r.y1 - pad && y < r.y2 + pad;

function pointInPoly(poly, x, y) {
  let c = false;
  const n = poly.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = poly[2 * i], yi = poly[2 * i + 1], xj = poly[2 * j], yj = poly[2 * j + 1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

function explain(piece, walls, roofPolys) {
  const [x1, y1, x2, y2] = piece.points;
  const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
  if (piece.len < 20) return 'short<20(b)';
  if (walls.some(r => insideRect(r, mx, my))) return 'in-wall(a)';
  if (roofPolys.some(poly => pointInPoly(poly, mx, my))) return 'inside-roof-footprint(c?)';
  if (walls.some(r => insideRect(r, mx, my, 130) || insideRect(r, x1, y1, 130) || insideRect(r, x2, y2, 130))) return 'near-wall(a)';
  return 'UNEXPLAINED';
}

const summary = [];
for (const src of sources) {
  const doc = path.basename(src, '.stq');
  const { project } = loadDocument(src);
  const planes = project.planes;
  planes.forEach((plane, idx) => {
    const graph = project.graphMap.get(plane.id);
    if (!graph) return;
    const regions = leanToPlanRegions(graph);
    if (regions.length === 0) return;
    const below = idx > 0 ? planes[idx - 1] : null;
    const belowGraph = below ? project.graphMap.get(below.id) : null;
    const belowPeek = belowGraph ? { graph: belowGraph, floorHeightMm: plane.elevation - below.elevation } : null;
    const cutZ = planCutHeightMmOf(plane);
    const prims = planSolidsLayerPrimitives({ graph, belowPeek, selfRiserOf: s => stairRiserOf(s, project, plane), cutZ });
    const selfRoof = prims.filter(p => p.source.kind === 'roof' && (p.source.layerFloorZ ?? 0) === 0);
    const oldFig = roofPlanFigure(graph);

    const pieces = comparePieces(oldLineRecords(oldFig), newLineRecords(selfRoof));
    const walls = rectsOfWalls(graph);
    const roofSolids = planSolids([{ graph, floorZMm: 0, role: 'self' }], {}).filter(s => s.kind === 'roof');
    const roofPolys = roofSolids.map(s => s.footprint.poly);
    for (const p of pieces) if (p.cls !== 'both') p.why = explain(p, walls, roofPolys);

    const oldLabels = labelKeys(oldFig);
    const newLabels = labelKeys(selfRoof);
    const labelsEqual = JSON.stringify(oldLabels) === JSON.stringify(newLabels);

    const counts = { both: 0, old: 0, new: 0 };
    for (const p of pieces) counts[p.cls]++;
    const why = {};
    for (const p of pieces) if (p.cls !== 'both') why[`${p.cls}/${p.why}`] = (why[`${p.cls}/${p.why}`] ?? 0) + 1;
    const maxKTMax = Math.max(0, ...roofSolids.map(s => s.zHi - s.zLo));
    const multiLoop = regions.filter(r => (r.outline ?? []).length >= 2).length;
    const diffs = pieces.filter(p => p.cls !== 'both');
    fs.writeFileSync(path.join(outDir, `roofCompare-${safe(doc)}-${safe(plane.name)}.json`), JSON.stringify({ counts, why, labelsEqual, oldLabels, newLabels, diffs }, null, 1));
    summary.push({ doc, floor: plane.name, regions: regions.length, ...counts, why, labels: `${oldLabels.length}/${newLabels.length}`, labelsEqual, maxKTMax: r1(maxKTMax), multiLoop, cutZ });
  });
}
fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 1));
for (const s of summary) {
  console.log(`${s.doc}\t${s.floor}\tregion=${s.regions}\t一致=${s.both}\t旧のみ=${s.old}\t新のみ=${s.new}\t理由=${JSON.stringify(s.why)}\tラベル=${s.labels}${s.labelsEqual ? '(一致)' : '(不一致!)'}\tmax k·tMax=${s.maxKTMax}(cut ${s.cutZ})\t複数ループ=${s.multiLoop}`);
}
