// CL種別間の共存規約（core/centerLineKindPolicy.js）のステップ5移行（同位置の相手の走査を
// sameCoordCounterparts 経由へ・findFloorsWithCounterpartCL の戻り値を種別つきへ）を実データで
// 確認するprobe（調査・回帰用。製品コードからは参照しない）。
//
// 各階の既存CL（全種別）の座標ごとに、4種別（struct/center/aux/beam）で addCenterLineFromDialog を
// 試行→done/toast/昇格（中心線削除→通り芯追加）の有無を記録→undoで復元。
// 加えて、全 center CL について checkPromoteToGridGuards、全 struct CL について
// checkDemoteToCenterGuards、findFloorsWithCounterpartCL（promote方向=center CL、
// demote方向=struct CL）の結果を記録する。
//
// findFloorsWithCounterpartCL の peek は実IDBではなく、loadDocument が既にメモリへ復元済みの
// project.graphMap から直接返す（wallRefreshProbe.mjs・structureToggleProbe.mjsと同じ方式）——
// 省略される「IDBの非同期I/O」はこのprobeの検証対象（同座標CL探索ロジック）に影響しない。
// 戻り値の形（ステップ5移行前=Plane配列、移行後=[{plane,kind}]）が移行前後で変わるため、
// describeDupFloors でフロア名の集合だけへ正規化する——移行前後で共通に比較できる最小の情報に
// 絞ることで、HEAD版（移行前）ソースへ一時差し替えても同じprobeスクリプトで実行できるようにする
// （種別つきの新情報自体は addCenterLineFromDialog 側の promoteGuards/demoteGuards の toast 文言や
// 【手順】の別ラン（after限定）で別途確認する）。
//
// 【実データ3本（moku2-5.stq/moku4.stq/13.stq）が踏まない経路（QA指摘m-7・実測値）】
// - checkPromoteToGridGuards が「同座標にstructGraph側の通り芯が既にある」（dupStruct）で拒否する
//   ケースは3本とも0件（moku2-5=0/15・moku4=0/15・13=0/24）——拒否9件（moku2-5・moku4）は
//   全て梁芯（dupBeam）由来で、struct同士の重複は一度も踏まれていない。
// - checkDemoteToCenterGuards がガード（NO_GRID/LAST_GRID/ATTACHED/同座標重複のいずれか）で拒否する
//   ケースは3本とも0件（moku2-5=0/12・moku4=0/12・13=0/6）——降格ガード自体の分岐（特にDUP判定）は
//   このprobeでは一度も踏まれていない。
// - 他階の階またぎトースト（counterpartFloorToasts）で実際に現れる種別は3本とも「中心線」のみ
//   （promote方向15/27・15/27・9/30件、いずれもkind='center'）——補助線・梁芯が他階の相手になる
//   ケース、複数種別混在で「、」連結が発生するケースは実データでは0件（ユニット/統合テストで
//   別途カバー。centerLineOps.test.jsの「複数階・種別混在」「相手が梁芯/補助線のみ」テスト参照）。
//   demote方向の階またぎ重複も3本とも0件。
//
// 【add→undo後の列挙順についての注意（QA指摘m-7）】
// graph.centerLines は Map（shapeMap／structGraph.shapeMap）の挿入順を返す。単発CL（struct/center/
// aux）の add→undo は追加分をremoveCenterLineで消すだけなので既存分の相対順序は変わらないが、
// 梁芯（beam）の add→undo はグラフスナップショット方式（serializeGraph→restoreGraph でグラフ全体を
// 作り直す）——シリアライズ・復元が挿入順を保存している限り順序は保たれるが、これは実装詳細であり
// 契約ではない。本probeの出力（before/afterのJSON）を配列のindexで突き合わせて差分を取ると、
// 内容が同じでも列挙順が変わっただけで「差分」と誤検出しうる——比較は id・plane名・kind・value等の
// 安定したキーで行うこと（本ラウンドの before/after 比較は `diff` によるテキスト差分で行い、実際に
// 列挙順のズレは観測されなかったが、これは現在の実装がたまたま順序保存的であることに依存しており、
// 将来にわたって保証されているわけではない）。
//
// 使い方: node --import ./scripts/testSetup.mjs scripts/probe/clCoexistProbe.mjs [入力.stq]
import { loadDocument } from './loadDoc.mjs';
import { CenterLineType } from '../../src/core/constants.js';
import { centerLineKind } from '../../src/core/centerLine.js';
import { floorSwapManager } from '../../src/storage/FloorSwapManager.js';
import { undoManager } from '../../src/undoManager.js';
import { addCenterLineFromDialog, promoteCenterToGridWithUndo, demoteGridToCenterWithUndo } from '../../src/transform/centerLineOps.js';
import { checkPromoteToGridGuards, checkDemoteToCenterGuards } from '../../src/transform/centerLineConvert.js';
import { findFloorsWithCounterpartCL } from '../../src/transform/centerLineFloorSync.js';
import { ERR_CL_CENTER_UPGRADED } from '../../src/error.js';

const src = process.argv[2] ?? 'D:/tatsuya/Download/moku2-5.stq';
const { project } = loadDocument(src);
const viewport = { scaleDenominator: 100 };

// IDBを使わず project.graphMap を返す（wallRefreshProbe.mjs・structureToggleProbe.mjsと同じ方式。
// loadDoc.mjsが全階を既にメモリへ復元済みのため、同期的に引くだけでよい）。
floorSwapManager.peek = async (plane) => project.graphMap.get(plane.id) ?? null;

// 移行前（HEAD。Plane配列）・移行後（[{plane,kind}]）の両方に対応する正規化。
function describeDupFloors(result) {
  return result.map(e => (e && e.plane ? e.plane.name : e.name)).sort();
}

const results = { addDialog: [], promoteGuards: [], demoteGuards: [], counterpartFloors: [] };

// ---- 1) addCenterLineFromDialog: 各階の既存CL座標ごとに4種別を試行 ----
for (const plane of project.planes) {
  const graph = project.graphMap.get(plane.id);
  if (!graph) continue;
  const seenCoords = new Set();
  for (const existing of graph.centerLines) {
    const type = existing.centerLineType === CenterLineType.VERTICAL ? 'vertical'
      : existing.centerLineType === CenterLineType.HORIZONTAL ? 'horizontal' : null;
    if (!type) continue; // RADIALは対象外（addCenterLineFromDialogの重複判定はVERTICAL/HORIZONTAL前提）
    const coordKey = `${type}:${Math.round(existing.value)}`;
    if (seenCoords.has(coordKey)) continue; // 同座標は1回だけ試す（複数種別が同座標にあっても座標単位でまとめる）
    seenCoords.add(coordKey);
    const worldCoord = existing.value;

    for (const kind of ['struct', 'center', 'aux', 'beam']) {
      const beforeTop = undoManager.peekUndo();
      const result = addCenterLineFromDialog(
        graph, project,
        { clDialog: { type, worldCoord, perpCoord: 0 }, value: worldCoord, kind, refId: null, refOffset: 0 },
        viewport,
      );
      results.addDialog.push({
        plane: plane.name, type, kind, worldCoord: Math.round(worldCoord),
        done: result.done, toast: result.toast,
        promoted: result.toast === ERR_CL_CENTER_UPGRADED,
      });
      if (undoManager.peekUndo() !== beforeTop) undoManager.undo();
    }
  }
}

// ---- 2) checkPromoteToGridGuards: 全 center CL ----
for (const plane of project.planes) {
  const graph = project.graphMap.get(plane.id);
  if (!graph) continue;
  for (const cl of graph.centerLines) {
    if (centerLineKind(cl) !== 'center') continue;
    const error = checkPromoteToGridGuards(graph, project.structGraph, cl);
    results.promoteGuards.push({ plane: plane.name, id: cl.id, value: Math.round(cl.value), error });
  }
}

// ---- 3) checkDemoteToCenterGuards: 全 struct CL ----
// outermostGridExtentRefs/isLastGridOnAxis は graph.gridXs/gridYs（structGraph込み）だけを見るため、
// どの階を graph として渡しても同じ結果になる——代表として先頭階を使う（clMoveRangeProbe.mjsのstruct
// 走査と同じ考え方）。
const firstPlane = project.planes[0];
const firstGraph = firstPlane ? project.graphMap.get(firstPlane.id) : null;
if (firstGraph) {
  for (const cl of project.structGraph.centerLines) {
    const error = checkDemoteToCenterGuards(firstGraph, project.structGraph, cl);
    results.demoteGuards.push({ id: cl.id, value: Math.round(cl.value), error });
  }
}

// ---- 4) findFloorsWithCounterpartCL: 全 center CL（昇格方向）・全 struct CL（降格方向） ----
// 同期ガード（checkPromoteToGridGuards/checkDemoteToCenterGuards）が既にエラーを返すCLは、
// promoteCenterToGridWithUndo/demoteGridToCenterWithUndo がfindFloorsWithCounterpartCLへ進む前に
// 早期returnする（N5。centerLineOps.js参照）——「階またぎ重複のトースト文言」を実際に踏むのは
// 同期ガードを通過したCLのみのため、5)ではその集合だけを対象にする。
const promoteSyncOkIds = new Set(results.promoteGuards.filter(e => !e.error).map(e => e.id));
const demoteSyncOkIds  = new Set(results.demoteGuards.filter(e => !e.error).map(e => e.id));

for (const plane of project.planes) {
  const graph = project.graphMap.get(plane.id);
  if (!graph) continue;
  for (const cl of graph.centerLines) {
    if (centerLineKind(cl) !== 'center') continue;
    const dup = await findFloorsWithCounterpartCL(project, graph, cl);
    results.counterpartFloors.push({
      direction: 'promote', plane: plane.name, id: cl.id, value: Math.round(cl.value), floors: describeDupFloors(dup),
    });
  }
}
if (firstGraph) {
  for (const cl of project.structGraph.centerLines) {
    const dup = await findFloorsWithCounterpartCL(project, firstGraph, cl);
    results.counterpartFloors.push({ direction: 'demote', id: cl.id, value: Math.round(cl.value), floors: describeDupFloors(dup) });
  }
}

// ---- 5) 階またぎ重複トースト文言そのもの（ERR_CL_CONVERT_DUP_FLOOR/_DEMOTE）を
//         promoteCenterToGridWithUndo/demoteGridToCenterWithUndo 経由で実際に踏んで記録する ----
// 対象は「同期ガードは通過したが findFloorsWithCounterpartCL が非空」のCLのみ（4)の結果から絞り込む。
// この経路は dupFloors.length>0 で即 return する（グラフ変更・saveFloor呼び出しは無い——
// centerLineOps.js promoteCenterToGridWithUndo/demoteGridToCenterWithUndo 参照）ため、
// saveFloorFnにスタブを渡しつつ念のため try/catch で囲み、undoが積まれていれば直ちに戻す
// （本来積まれないはずだが、実データでの想定外を静かに握り潰さず記録する）。
const noopSaveFloorFn = async () => {};
for (const entry of results.counterpartFloors) {
  if (entry.floors.length === 0) continue;
  const graph = entry.direction === 'promote' ? project.graphMap.get(project.planes.find(p => p.name === entry.plane)?.id) : firstGraph;
  if (!graph) continue;
  const eligible = entry.direction === 'promote' ? promoteSyncOkIds.has(entry.id) : demoteSyncOkIds.has(entry.id);
  if (!eligible) continue; // 同期ガードで既に拒否される（beam等）CLは4)と同じ理由で対象外
  const cl = (entry.direction === 'promote' ? graph : project.structGraph).shapeMap.get(entry.id);
  if (!cl) continue;
  const beforeTop = undoManager.peekUndo();
  let toast = null, error = null;
  try {
    const fn = entry.direction === 'promote' ? promoteCenterToGridWithUndo : demoteGridToCenterWithUndo;
    ({ toast } = await fn(graph, project, cl, { saveFloorFn: noopSaveFloorFn }));
  } catch (e) {
    error = String(e);
  }
  if (undoManager.peekUndo() !== beforeTop) undoManager.undo(); // 想定外にundoが積まれていた場合の保険
  results.counterpartFloorToasts = results.counterpartFloorToasts ?? [];
  results.counterpartFloorToasts.push({ direction: entry.direction, id: entry.id, value: entry.value, toast, error });
}

console.log(JSON.stringify(results, null, 2));
