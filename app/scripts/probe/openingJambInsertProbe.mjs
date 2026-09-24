// 建具の確定・削除直後に自階の構造が自動再計算されること（structural/structuralSync.js。
// 旧 openingStructuralSync.js を一般化・改名したもの。2026-09-25）の実データ確認用probe。
// tategu-test3.stqの縦内壁（X1+3640, Y1-1820付近。y は負方向）に
// placeOpeningWithDefaults で建具を挿入する——App.jsxと同じ setOpeningGeometryListener 配線を
// 冒頭で張り、openingEdit.js の geometryListener 呼び出し（本番配線）だけを起動口にする
// （QA指摘: probe自身が structuralSync.request を直接呼ぶと、本番配線
// （openingEdit.js の geometryListener?.(graph, project) 呼び出し）を一切経由せずに済んでしまい、
// listener呼び出しを外しても probe が NG にならない＝検出力ゼロになる。手動でautoFillWoodColumns/
// recomputeStructuralForGraph/structuralSync.requestを直接呼ばない）。
//
// 確認する事実:
//   1) 挿入直後（再計算前）はまだ建具上の柱が残っている（自動発火が同期的ではないことの対照）
//   2) 配線経由の自動発火の完了（whenIdle）後、建具上の柱が消え、両袖に袖柱2本が立つ
//   3) 建具を削除して配線経由の自動発火の完了後、袖柱が消え元の柱が復活する
//
// 使い方: node --import ./scripts/testSetup.mjs scripts/probe/openingJambInsertProbe.mjs [入力.stq]
import { loadDocument } from './loadDoc.mjs';
import { floorSwapManager } from '../../src/storage/FloorSwapManager.js';
import { placeOpeningWithDefaults, removeOpeningWithUndo, setOpeningGeometryListener } from '../../src/openings/openingEdit.js';
import { structuralSync, OPENING_STRUCTURAL_SYNC } from '../../src/structural/structuralSync.js';
import { OpeningCategory } from '../../src/core.js';

const src = process.argv[2] ?? 'D:/tatsuya/Download/tategu-test3.stq';
const { project } = loadDocument(src);
// loadDoc.mjs は実IDBを使わないインメモリ復元のため、非アクティブ階のpeekはgraphMapから直接返す
// （woodJambColumnProbe.mjs等と同じ差し替え。structuralSyncの既定recompute＝recomputeActiveStructural
// はscope='active'だが、在来木造は3b（上階柱直下の柱）のため1つ上の実体階を読み取り専用でpeekする
// ——実際に使われる（n-2・QA指摘。'active'が保証するのは他階を"書き換えない"ことであり、
// "一切peekしない"ことではない。structuralOrchestration.test.js m-3参照）。
floorSwapManager.peek = async (plane) => project.graphMap.get(plane.id) ?? null;

// App.jsxと同一の配線（唯一の起動口）。これが無ければ以降のplace/removeは一切構造を再計算しない。
setOpeningGeometryListener((g, p) => structuralSync.request(g, p, OPENING_STRUCTURAL_SYNC));

const g = project.activeGraph;
console.log(`=== ${src} ===`);
console.log('主構造:', project.structuralInfo.mainStructure, 'plane:', g.plane.name);

const cls = g.centerLines;
const x1 = cls.find(c => c.isVertical && c.label === 'X1')?.effectiveValue ?? 0;
const y1 = cls.find(c => !c.isVertical && c.label === 'Y1')?.effectiveValue ?? 0;
const target = { x: x1 + 3640, y: y1 - 1820 }; // y は負方向

// 対象位置の柱（挿入前に存在するはずの既存柱）を近傍探索で1本見つける。
const findColumnNear = (pt, tolMm = 5) => g.columns.find(c => Math.hypot(c.x - pt.x, c.y - pt.y) < tolMm);
const beforeColumn = findColumnNear(target);
if (!beforeColumn) {
  console.log(`NG: 挿入前提の柱が (${target.x},${target.y}) 付近に見つからない（フィクスチャの前提が崩れている）`);
  process.exitCode = 1;
}

// target に最も近い縦内壁を1本選ぶ（軸距離＋範囲外距離が最小の壁）。
const candidates = g.walls.filter(w => !w.isExteriorWall && w.isVertical).map(w => {
  const axis = w.axisCL.effectiveValue + w.axisOffset;
  const lo = Math.min(w.coord1, w.coord2), hi = Math.max(w.coord1, w.coord2);
  const d = Math.abs(target.x - axis) + Math.max(0, lo - target.y, target.y - hi);
  return { w, d };
}).sort((a, b) => a.d - b.d);
const wall = candidates[0]?.w;
if (!wall) {
  console.log('NG: 対象位置の近傍に縦内壁が見つからない');
  process.exitCode = 1;
  process.exit(process.exitCode);
}

const { opening, error } = placeOpeningWithDefaults(g, project, wall, target, OpeningCategory.FITTING);
if (error || !opening) {
  console.log(`NG: 建具の配置に失敗（error=${error}）`);
  process.exitCode = 1;
  process.exit(process.exitCode);
}
console.log(`配置: opening=${opening.id.slice(0, 8)} [${Math.round(opening.coord1)},${Math.round(opening.coord2)}] ${opening.subType}`);

// (1) 再計算前はまだ自動発火していない（対照）——ここで再計算されてしまっていたら
// structuralSyncを経由せず何か別経路が動いている（回帰の兆候）ため明示的に確認する。
const stillThereBeforeSync = !!findColumnNear(target);
if (!stillThereBeforeSync) {
  console.log('NG（対照）: request()を呼ぶ前から柱が消えている（structuralSync以外の経路が動いている疑い）');
  process.exitCode = 1;
}

// (2) 本番配線（geometryListener経由で自動起動済みのrequest）の完了を待つだけ。
await structuralSync.whenIdle();

const overlappingGone = !findColumnNear(target);
const jambs = g.columns.filter(c => c.woodJambRef?.openingId === opening.id);
console.log(`再計算後: 建具上の柱=${overlappingGone ? '消滅' : '残存'} / 袖柱=${jambs.length}本`);
for (const c of jambs.sort((a, b) => a.woodJambRef.side - b.woodJambRef.side)) {
  console.log(`  side=${c.woodJambRef.side} → x=${Math.round(c.x)}, y=${Math.round(c.y)}`);
}
if (!overlappingGone || jambs.length !== 2) {
  console.log('NG: 建具上の柱が消えて両袖に2本立つはずが一致しない');
  process.exitCode = 1;
}

// (3) 削除→本番配線経由の自動起動→完了待ちで元の柱が戻る。
removeOpeningWithUndo(g, project, opening);
await structuralSync.whenIdle();

const restored = !!findColumnNear(target);
const jambsAfterRemove = g.columns.filter(c => c.woodJambRef?.openingId === opening.id).length;
console.log(`削除後の再計算: 元の柱=${restored ? '復活' : '不在'} / 袖柱=${jambsAfterRemove}本`);
if (!restored || jambsAfterRemove !== 0) {
  console.log('NG: 削除後に元の柱が復活し袖柱0本に戻るはずが一致しない');
  process.exitCode = 1;
}

if (!process.exitCode) {
  console.log('OK: 建具の確定・削除直後にstructuralSync経由で自階の構造が自動再計算される');
}
