// 吹抜けの注記（S6）の関門: 新経路（floorOpeningGroups＋planHoleMarks）の出力を、S6a コミット(5a175eb)時点で採取した
// golden（scripts/probe/golden-void/<文書>.json）と文書・階ごとに比べる。S6a 時点では旧経路（voidGeometry.js の
// computeVoidCrosses／visibleUpperVoidCrosses）と新経路が全文書・全階で一致していたので、golden は旧と新の共通の出力。
//   自階の×  … role 'cross'（rect＝innerRect）
//   上階破線 … role 'upperVoid'（rect＋cellRect＋label）
// 使い方（app/ から）:
//   node --import ./scripts/testSetup.mjs scripts/probe/dumpVoidCompare.mjs            … golden と比較（差分があれば終了コード 1）
//   node --import ./scripts/testSetup.mjs scripts/probe/dumpVoidCompare.mjs --write    … golden を書き直す（意図した変更のときだけ）
//   文書を指定するときは末尾に *.stq のパスを並べる（golden は同名 .json）。省略すると下記 DEFAULT_DOCS（D:/tatsuya/Download）。
// 環境変数 MUTATE=innerRect-as-cellRect で「innerRect を cellRect にすり替える」変異（検出力の確認用）。
import fs from 'node:fs';
import path from 'node:path';
import { loadDocument } from './loadDoc.mjs';
import { floorOpeningGroups } from '../../src/finish/stair/slabOpening.js';
import { planHoleMarks, selfVoidHoleRects } from '../../src/plan/planHoleMarks.js';

const DEFAULT_DOCS = ['13', '14', 'moku1-1', 'moku1-2', 'moku1-3', 'moku1-4', 'moku1-5', 'moku1-6', 'moku4', 'moku4-2', 'moku4-3',
  'wood-void-test', 'wood-ev-test', 'EV-test1', 'void-overhang-test', 'opening-test', '7', '8', '10', '11'];
const GOLDEN_DIR = path.resolve(import.meta.dirname, 'golden-void');
const args = process.argv.slice(2);
const write = args.includes('--write');
const srcArgs = args.filter(a => a.endsWith('.stq'));
const sources = srcArgs.length ? srcArgs : DEFAULT_DOCS.map(n => `D:/tatsuya/Download/${n}.stq`);
const mutate = process.env.MUTATE === 'innerRect-as-cellRect';

const r3 = v => Math.round(v * 1000) / 1000;
const rk = r => (r ? [r.x1, r.y1, r.x2, r.y2].map(r3).join(',') : '-');

function entries(graph, aboveGraph) {
  const selfGroups = floorOpeningGroups(graph, { stairFilter: () => false });
  const aboveGroups = aboveGraph ? floorOpeningGroups(aboveGraph, { stairFilter: () => false }) : null;
  const fix = gs => (mutate ? gs.map(g => (g.cellRect ? { ...g, innerRect: g.cellRect } : g)) : gs);
  const marks = planHoleMarks({ selfGroups: fix(selfGroups), selfVoidCells: selfVoidHoleRects(graph), aboveGroups: aboveGroups && fix(aboveGroups) });
  return marks.map(m => (m.role === 'cross'
    ? `cross|${m.source.id}|${rk(m.rect)}`
    : `upper|${m.source.id}|cell=${rk(m.cellRect)}|inner=${rk(m.rect)}|label=${m.label}`)).sort();
}

let bad = 0;
console.log('doc\tfloor\t件数(×/破線)\t判定');
for (const src of sources) {
  const doc = path.basename(src, '.stq');
  let project;
  try { ({ project } = loadDocument(src)); } catch (e) { console.log(`${doc}\t(読み込み失敗: ${e.message})`); bad++; continue; }
  const now = {};
  project.planes.forEach((plane, idx) => {
    const graph = project.graphMap.get(plane.id);
    if (!graph) return;
    const above = project.planes[idx + 1] ? project.graphMap.get(project.planes[idx + 1].id) ?? null : null;
    now[plane.name] = entries(graph, above);
  });
  const goldenPath = path.join(GOLDEN_DIR, `${doc}.json`);
  if (write) {
    fs.mkdirSync(GOLDEN_DIR, { recursive: true });
    fs.writeFileSync(goldenPath, `${JSON.stringify(now, null, 1)}\n`);
  }
  let golden = null;
  try { golden = JSON.parse(fs.readFileSync(goldenPath, 'utf8')); } catch { /* golden なし */ }
  for (const [floor, list] of Object.entries(now)) {
    const split = `${list.length}(×${list.filter(e => e.startsWith('cross')).length}/破線${list.filter(e => e.startsWith('upper')).length})`;
    const g = golden?.[floor];
    const ok = !!g && JSON.stringify(g) === JSON.stringify(list);
    if (!ok) bad++;
    console.log(`${doc}\t${floor}\t${split}\t${write ? '書込' : ok ? '一致' : g ? '差分' : 'golden なし'}`);
    if (!ok && g) {
      for (const e of g.filter(x => !list.includes(x))) console.log(`   golden のみ: ${e}`);
      for (const e of list.filter(x => !g.includes(x))) console.log(`   新のみ: ${e}`);
    }
  }
  if (golden) for (const floor of Object.keys(golden)) if (!(floor in now)) { bad++; console.log(`${doc}\t${floor}\t(階が消えた)`); }
}
console.log(bad ? `差分あり: ${bad}` : write ? 'golden を書き込んだ' : '差分なし（golden と一致）');
process.exitCode = bad ? 1 : 0;
