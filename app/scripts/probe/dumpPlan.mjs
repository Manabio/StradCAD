// 11.stq の各階平面の壁描画セグメントと不良検出結果をJSONへ落とす（詳細LODと標準LOD）。
// 使い方: node --import ./scripts/testSetup.mjs scripts/probe/dumpPlan.mjs <出力先ディレクトリ>
//   詳細LOD … plan-<階>.json / defects-<階>.json / plan-summary.json
//   標準LOD … plan-standard-<階>.json / defects-standard-<階>.json / plan-standard-summary.json
import fs from 'node:fs';
import path from 'node:path';
import { loadDocument } from './loadDoc.mjs';
import { planWallSegments } from './planSegments.mjs';
import { analyzeDefects, summarizeDefects } from './planDefects.mjs';
import { LodLevel } from '../../src/viewport.js';

const outDir = process.argv[2] ?? path.join(import.meta.dirname, 'golden');
const src = process.argv[3] ?? 'D:/tatsuya/Download/11.stq';
fs.mkdirSync(outDir, { recursive: true });

const { project } = loadDocument(src);
for (const [lod, prefix] of [[LodLevel.DETAIL, ''], [LodLevel.STANDARD, 'standard-']]) {
  const summary = [];
  for (const p of project.orderedTabs) {
    const graph = project.graphMap.get(p.id);
    if (!graph) continue;
    const segs = planWallSegments(graph, lod);
    const defects = analyzeDefects(graph, segs);
    const name = p.name.replace(/[^\w一-龥ぁ-んァ-ヶー]/g, '_');
    fs.writeFileSync(path.join(outDir, `plan-${prefix}${name}.json`), JSON.stringify(segs, null, 1));
    fs.writeFileSync(path.join(outDir, `defects-${prefix}${name}.json`), JSON.stringify(defects, null, 1));
    summary.push(summarizeDefects(p.name, segs, defects));
  }
  fs.writeFileSync(path.join(outDir, `plan-${prefix}summary.json`), JSON.stringify(summary, null, 1));
  console.log(lod, JSON.stringify(summary, null, 1));
}
