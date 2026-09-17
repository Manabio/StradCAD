// .stq の各階平面を丸ごと復元し、finish/wallRegeneration.js の regenerateWalls で壁を
// 再生成した「後」の壁描画セグメントを JSON へ落とす（壁の再生成をFinishModeStateから
// 独立させる計画のステップ1: 挙動不変を実データで裏取りするための golden-regen 採取）。
// dumpPlan.mjs（保存済み状態のダンプ）と対で使う——同じ .stq を dumpPlan.mjs と両方かけて
// diffPlanRegen.mjs（key/wallId/idsのUUIDを落として幾何だけ比較する）に渡せば
// 「保存済み vs 再生成後」の乖離が分かる。
//
// 【QA F6】app/scripts/probe/golden-regen/ の中身（コミット済み）は、このスクリプト自身と
// finish/wallRegeneration.js だけでなく、未コミットの app/scripts/probe/planSegments.mjs
// （在来木造ステップ5作業。セグメント種別 through/join → penetrate/split/overlap 等の変更）にも
// 依存する——plan-<階>.json のセグメント形状はこのファイル経由で決まるため。同変更がコミット
// された後のコミット以降でしか、このスクリプトの再実行結果は golden-regen/ の中身と一致しない
// （それ以前にこのスクリプトを再実行すると golden/ 系との比較が無意味な差分だらけになる。
// 実際に本タスクの Step0 でも観測済み）。
//
// 使い方: node --import ./scripts/testSetup.mjs scripts/probe/dumpPlanRegen.mjs <出力先ディレクトリ> <入力.stq>
//   出力: plan-<階名>.json（詳細LOD。dumpPlan.mjs の plan-<階>.json と同形式）
//
// golden-regen/ はこのスクリプト（conformWoodBacking経由。実アプリの境界処理と同じ経路）で採取する
// ——conformWoodBackingを経由しないと、各階柱寸法（graph.woodColumnWidthMm）と保存済み下地材コードが
// 食い違っている文書（実データにありうる）で実アプリと異なる寸法のまま比較してしまう（QA F3裁定）。
//
// stairUnderEntries・extraStairOpenings は finish/stair/stairUnderRooms.js の resolveStairContext
// （wallRefresh.js の全階sweep・finish/finishBoundary.js の仕上げ脱出境界と同じ単一ソース）へ、
// 「project.graphMap に全階が既にメモリ展開済み」であることを利用した同期peek相当を注入して解決する
// （IndexedDB抜き）。
import fs from 'node:fs';
import path from 'node:path';
import { runInAction } from 'mobx';
import { loadDocument } from './loadDoc.mjs';
import { planWallSegments } from './planSegments.mjs';
import { LodLevel } from '../../src/viewport.js';
import { resolveStairContext } from '../../src/finish/stair/stairUnderRooms.js';
import { regenerateWalls, loadMaterialMap } from '../../src/finish/wallRegeneration.js';
import { conformWoodBacking } from '../../src/structural/woodAutoFill.js';

const outDir = process.argv[2] ?? path.join(import.meta.dirname, 'golden-regen');
const src = process.argv[3] ?? 'D:/tatsuya/Download/11.stq';
fs.mkdirSync(outDir, { recursive: true });

const { project } = loadDocument(src);
const materialMap = await loadMaterialMap();
const planes = project.planes; // elevation昇順
// graphMap に全階が既に展開済みのため peek は同期的に引くだけでよい（IDB抜き）。
const graphMapPeek = async (plane) => project.graphMap.get(plane.id) ?? null;

const summary = [];
for (const p of planes) {
  const graph = project.graphMap.get(p.id);
  if (!graph) continue;

  // 在来木造: 共通仕様の壁下地材を柱同寸×30へ自動選択する（実アプリの境界処理
  // finishBoundary.js runFinishEntryBoundary/wallRefresh.js refreshWallsForGraph と同じ手順。
  // QA F3: これを呼ばずに柱寸法だけ変えると、下地材コードがWに追従していない一時状態のまま
  // bandShiftが発火し、実アプリの経路と食い違う）。
  runInAction(() => conformWoodBacking(graph, project));

  const { stairUnderEntries, extraStairOpenings } = await resolveStairContext(graph, project, graphMapPeek);

  await regenerateWalls(graph, { materialMap, project, stairUnderEntries, extraStairOpenings });

  const segs = planWallSegments(graph, LodLevel.DETAIL);
  const name = p.name.replace(/[^\w一-龥ぁ-んァ-ヶー]/g, '_');
  fs.writeFileSync(path.join(outDir, `plan-${name}.json`), JSON.stringify(segs, null, 1));
  summary.push({ plane: p.name, segs: segs.length });
}
fs.writeFileSync(path.join(outDir, 'plan-summary.json'), JSON.stringify(summary, null, 1));
console.log(JSON.stringify(summary, null, 1));
