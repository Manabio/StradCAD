// 保存済みの平面セグメント（plan-<階>.json）を入力に、現行の不良メトリクス（planDefects.mjs）で数え直す。
// ゴールデンは現行実装に依存せず保存した描画結果なので、メトリクスを改訂したときはこれで前後を同じ
// 物差しで比べる（ゴールデンの JSON は再生成しない）。
// 使い方: node --import ./scripts/testSetup.mjs scripts/probe/recountDefects.mjs <入力ディレクトリ> [出力JSON] [prefix]
//   prefix: 'plan-'（詳細LOD。既定）または 'plan-standard-'（標準LOD）
import fs from 'node:fs';
import path from 'node:path';
import { loadDocument } from './loadDoc.mjs';
import { analyzeDefects, summarizeDefects } from './planDefects.mjs';

const inDir = process.argv[2] ?? path.join(import.meta.dirname, 'golden');
const outFile = process.argv[3] && process.argv[3] !== '-' ? process.argv[3] : null;
const prefix = process.argv[4] ?? 'plan-';
const src = 'D:/tatsuya/Download/11.stq';

const { project } = loadDocument(src);
const summary = [];
const details = {};
for (const p of project.orderedTabs) {
  const graph = project.graphMap.get(p.id);
  if (!graph) continue;
  const name = p.name.replace(/[^\w一-龥ぁ-んァ-ヶー]/g, '_');
  const file = path.join(inDir, `${prefix}${name}.json`);
  if (!fs.existsSync(file)) continue;
  const segs = JSON.parse(fs.readFileSync(file, 'utf8'));
  const defects = analyzeDefects(graph, segs);
  details[p.name] = defects;
  summary.push(summarizeDefects(p.name, segs, defects));
}
if (outFile) fs.writeFileSync(outFile, JSON.stringify({ summary, details }, null, 1));
console.log(JSON.stringify(summary, null, 1));
