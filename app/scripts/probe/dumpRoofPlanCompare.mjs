// 下屋の平面図形（S5）の関門: 新経路（plan/planSolidsLayerFilter.js planSolidsLayerPrimitives の source.kind==='roof'・自階の
// 線とラベル）の出力を、S5b 直前に採取した golden（scripts/probe/golden-roof/<文書>.json）と文書・階ごとに比べる。
// S5 の時点で旧経路（roofPlanFigure＋端止め）と新経路は線もラベルも一致していたので、golden は旧と新の共通の出力。
// 線は折れ線→線分→同一直線上で重なりを結合（plan/roofPlanCompare.js mergedLinePieces。0.5mm 許容・座標 0.1 丸め）して
// 「x1,y1,x2,y2」の文字列に、ラベルは座標・文字まで（labelKeys）。
// 使い方（app/ から）:
//   node --import ./scripts/testSetup.mjs scripts/probe/dumpRoofPlanCompare.mjs            … golden と比較（差分があれば終了コード 1）
//   node --import ./scripts/testSetup.mjs scripts/probe/dumpRoofPlanCompare.mjs --write    … golden を書き直す（意図した変更のときだけ）
//   文書を指定するときは末尾に *.stq のパスを並べる（golden は同名 .json）。省略すると下記 DEFAULT_DOCS（D:/tatsuya/Download）。
import fs from 'node:fs';
import path from 'node:path';
import { loadDocument } from './loadDoc.mjs';
import { planCutHeightMmOf } from '../../src/core.js';
import { planSolidsLayerPrimitives } from '../../src/plan/planSolidsLayerFilter.js';
import { newLineRecords, mergedLinePieces, labelKeys } from '../../src/plan/roofPlanCompare.js';
import { leanToPlanRegions } from '../../src/structural/roofFramingRegions.js';
import { stairRiserOf } from '../../src/finish/stair/stairDimensions.js';

const DEFAULT_DOCS = [...Array.from({ length: 10 }, (_, i) => `roof-test${i + 1}`), 'moku1-1', 'moku1-2', 'moku1-3', 'moku1-4', 'moku1-5', 'moku1-6',
  'moku4-1', 'moku4-2', 'moku4-3'];
const GOLDEN_DIR = path.resolve(import.meta.dirname, 'golden-roof');
const args = process.argv.slice(2);
const write = args.includes('--write');
const srcArgs = args.filter(a => a.endsWith('.stq'));
const sources = srcArgs.length ? srcArgs : DEFAULT_DOCS.map(n => `D:/tatsuya/Download/${n}.stq`);

let bad = 0;
console.log('doc\tfloor\t線\tラベル\t判定');
for (const src of sources) {
  const doc = path.basename(src, '.stq');
  let project;
  try { ({ project } = loadDocument(src)); } catch (e) { console.log(`${doc}\t(読み込み失敗: ${e.message})`); bad++; continue; }
  const now = {};
  project.planes.forEach((plane, idx) => {
    const graph = project.graphMap.get(plane.id);
    if (!graph || leanToPlanRegions(graph).length === 0) return;
    const below = idx > 0 ? project.planes[idx - 1] : null;
    const belowGraph = below ? project.graphMap.get(below.id) : null;
    const belowPeek = belowGraph ? { graph: belowGraph, floorHeightMm: plane.elevation - below.elevation } : null;
    const prims = planSolidsLayerPrimitives({ graph, belowPeek, selfRiserOf: s => stairRiserOf(s, project, plane), cutZ: planCutHeightMmOf(plane) });
    const selfRoof = prims.filter(p => p.source.kind === 'roof' && (p.source.layerFloorZ ?? 0) === 0);
    now[plane.name] = { lines: mergedLinePieces(newLineRecords(selfRoof)), labels: labelKeys(selfRoof) };
  });
  const goldenPath = path.join(GOLDEN_DIR, `${doc}.json`);
  if (write) {
    fs.mkdirSync(GOLDEN_DIR, { recursive: true });
    fs.writeFileSync(goldenPath, `${JSON.stringify(now, null, 1)}\n`);
  }
  let golden = null;
  try { golden = JSON.parse(fs.readFileSync(goldenPath, 'utf8')); } catch { /* golden なし */ }
  for (const [floor, cur] of Object.entries(now)) {
    const g = golden?.[floor];
    const ok = !!g && JSON.stringify(g) === JSON.stringify(cur);
    if (!ok) bad++;
    console.log(`${doc}\t${floor}\t${cur.lines.length}\t${cur.labels.length}\t${write ? '書込' : ok ? '一致' : g ? '差分' : 'golden なし'}`);
    if (!ok && g) {
      for (const k of ['lines', 'labels']) {
        for (const e of g[k].filter(x => !cur[k].includes(x))) console.log(`   golden のみ(${k}): ${e}`);
        for (const e of cur[k].filter(x => !g[k].includes(x))) console.log(`   新のみ(${k}): ${e}`);
      }
    }
  }
  if (golden) for (const floor of Object.keys(golden)) if (!(floor in now)) { bad++; console.log(`${doc}\t${floor}\t(階が消えた)`); }
}
console.log(bad ? `差分あり: ${bad}` : write ? 'golden を書き込んだ' : '差分なし（golden と一致）');
process.exitCode = bad ? 1 : 0;
