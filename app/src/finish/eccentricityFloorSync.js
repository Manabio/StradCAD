/**
 * CL偏芯（内壁指定のあるCLの偏芯仕様）の階またぎ連動。
 *
 * 階段に面する壁の偏芯は設置階〜最上階まで、吹抜け（feature=VOID）に面する壁の偏芯は
 * その吹抜けの階と直下階の間で共通（連動）にする。同一CL上に壁は1つだけ（要件）のため、
 * この2ルールだけで延長上の壁（同一CLを共有する他の内壁区間）も自然に共有される
 * ——CL単位で spec を複製すれば足り、壁1本ずつを個別に追従させる実装は不要。
 *
 * 方式: spec レコードの複製。floorSwapManager.peek → set/removeCLEccentricity →
 * applyCLEccentricity → saveFloor という stairFloorSync.js と同じ階またぎ同期パターンに乗る
 * （syncUpperStairInteriors 参照）。連動対象階は保存せず、呼び出しのたびにグラフから
 * （階段・吹抜けの Room feature を辿って）導出する。
 *
 * push（propagateCLEccentricities）とpull（pullCLEccentricities）の2方向がある:
 *   push … 自階で偏芯を指定・変更した直後、連動先の他階へ複製する（handleEccConfirm・
 *          モード境界の再伝播）。
 *   pull … 仕上げモード突入時、自階にまだレコードが無いCLについて、連動先（他階）に既存の
 *          指定があれば取り込む。push だけでは、連動先がまだ仕上げモードに入っていない・
 *          内壁指定（部屋名）がまだ無い等でグラフ上のリンクが見えず伝播できない期間が
 *          埋まらないため（F3）。
 * どちらも階ごとに peek 1回・buildCellToRoom 1回に畳む（planePeeks。F5）。
 */
import { runInAction } from 'mobx';
import { floorSwapManager } from '../storage/FloorSwapManager.js';
import { serializeGraph, restoreGraph } from '../graphSnapshot.js';
import { saveFloor } from '../storage/db.js';
import { undoManager } from '../undoManager.js';
import { translateCLId } from './floorCLMap.js';
import { buildCellToRoom, roomsAdjacentToCL } from './edgeClassify.js';
import { applyCLEccentricity } from './clEccentricity.js';
import { RoomFeature } from '@core';

/**
 * clId 上の内壁が接する部屋の feature から、その階が「階段」「吹抜け」いずれの連動ルールに
 * 関わるかを返す（stair: STAIR|STAIR_VOID に接する内壁、void: VOID に接する内壁）。
 * STAIR_VOID を stair 側に含めるのは、最上階の階段吹抜け直下（＝階段設置階の続き）も
 * 階段連動グループに含めるため。
 */
function linkFlagsOnGraph(graph, clId, cellToRoom) {
  const rooms = roomsAdjacentToCL(graph, clId, cellToRoom);
  let stair = false, isVoid = false;
  for (const room of rooms) {
    if (room.feature === RoomFeature.STAIR || room.feature === RoomFeature.STAIR_VOID) stair = true;
    if (room.feature === RoomFeature.VOID) isVoid = true;
  }
  return { stair, void: isVoid };
}

/**
 * 全採用階（project.planes）を1回ずつ peek し、{plane, graph, cellToRoom} を planes 配列と
 * 同じ並びで返す（アクティブ階は peek せず activeGraph をそのまま使う）。
 * F5: 階ごとの peek・buildCellToRoom をこの呼び出し1回に集約し、複数CL・push/pull の
 * どちらの呼び出しからも同じ結果を使い回す（clId ごとに毎回 peek していた旧実装を解消）。
 */
async function planePeeks(project, activeGraph) {
  const planes = project.planes;
  const active = activeGraph?.plane;
  return Promise.all(planes.map(async (plane) => {
    const graph = plane.id === active?.id ? activeGraph : await floorSwapManager.peek(plane, project.structGraph);
    return { plane, graph, cellToRoom: buildCellToRoom(graph) };
  }));
}

/**
 * clId の連動先階インデックス集合（peeks 配列内インデックス。アクティブ階自身は含まない）と、
 * 各階での対応CL id（未解決なら null）を、既に peek 済みの peeks から求める（新たな peek は
 * 発生しない）。グループは transitive にしない（アクティブ階が属するルールの集合のみ）。
 */
function linkedGroupFor(clId, activeGraph, structGraph, peeks, activeIdx) {
  const localIds = peeks.map(({ graph }) => translateCLId(clId, activeGraph, structGraph, graph));
  const stairSet = new Set(), voidSet = new Set();
  localIds.forEach((localId, i) => {
    if (!localId) return;
    const flags = linkFlagsOnGraph(peeks[i].graph, localId, peeks[i].cellToRoom);
    if (flags.stair) stairSet.add(i);
    if (flags.void) { voidSet.add(i); if (i > 0) voidSet.add(i - 1); }
  });
  const group = new Set();
  if (stairSet.has(activeIdx)) for (const i of stairSet) group.add(i);
  if (voidSet.has(activeIdx))  for (const i of voidSet)  group.add(i);
  group.delete(activeIdx); // 対象は非アクティブ階のみ
  return { group, localIds };
}

/**
 * clIds（複数）の CL偏芯（graph.clEccentricities.get(clId)。undefined＝解除）を、階段・吹抜けの
 * 連動ルールで結ばれた他階へ複製する（プッシュ側）。呼び出し側でアクティブ階自身への適用
 * （set/removeCLEccentricity + applyCLEccentricity）を済ませた後に呼ぶこと。
 *
 * F5: 階ごとに peek 1回・buildCellToRoom 1回・（変更があれば）saveFloor 1回に畳む
 * （clId ごとの繰り返し呼び出しで階数×CL数回 peek していた旧実装を解消）。
 *
 * undo: opts.undoEntry（handleEccConfirm が push した undo エントリ）を渡すと、変更した
 * 各階の before/after をシリアライズ済みバイト列で記録し、そのエントリへ合成
 * （undoManager.amend）する——stairFloorSync.js の syncUpperFloors と同じパターン。
 * undoEntry を渡さない呼び出し（モード境界での自動再伝播）は従来どおり undo 対象外。
 *
 * @param {object} project
 * @param {object} activeGraph - 偏芯を指定・変更した階（アクティブ）のグラフ
 * @param {string[]} clIds - 呼び出し側でスナップショット済みの配列であること（observable map の
 *   keys() を await をまたいで直接 iterate しない。F9）
 * @param {{materialMap: Map, undoEntry?: object|null}} opts
 */
export async function propagateCLEccentricities(project, activeGraph, clIds, { materialMap, undoEntry = null } = {}) {
  if (clIds.length === 0) return;
  const planes = project.planes;
  const active = activeGraph?.plane;
  const activeIdx = planes.findIndex(p => p.id === active?.id);
  if (activeIdx < 0) return;

  const peeks = await planePeeks(project, activeGraph);

  const perClId = clIds.map(clId => {
    const { group, localIds } = linkedGroupFor(clId, activeGraph, project.structGraph, peeks, activeIdx);
    return { group, localIds, spec: activeGraph.clEccentricities.get(clId) };
  });

  const targetFloorIdx = new Set();
  for (const { group } of perClId) for (const i of group) targetFloorIdx.add(i);
  if (targetFloorIdx.size === 0) return; // 連動対象なし（自階のみ）→ no-op

  const undoRecords = []; // { planeId, before, after }（undoEntry がある場合のみ収集）
  for (const i of targetFloorIdx) {
    const { plane, graph: temp } = peeks[i];
    const before = undoEntry ? serializeGraph(temp) : null;
    let changed = false;
    for (const { group, localIds, spec } of perClId) {
      if (!group.has(i)) continue;
      const localClId = localIds[i];
      if (!localClId) continue; // 対応不能 → 安全側でスキップ（CLを勝手に追加しない）
      if (spec) temp.setCLEccentricity(localClId, spec);
      else      temp.removeCLEccentricity(localClId);
      applyCLEccentricity(temp, localClId, { materialMap });
      changed = true;
    }
    if (!changed) continue;
    await saveFloor(plane.id, serializeGraph(temp));
    if (undoEntry) undoRecords.push({ planeId: plane.id, before, after: serializeGraph(temp) });
  }

  if (undoEntry && undoRecords.length > 0) {
    const applyBytes = (which) => {
      for (const rec of undoRecords) {
        if (project.activePlane?.id === rec.planeId) {
          restoreGraph(project.activeGraph, rec[which]); // undo 時にその階がアクティブなら生きているグラフへ復元
        } else {
          saveFloor(rec.planeId, rec[which]).catch(console.error); // 非アクティブ階は IDB のみが正
        }
      }
    };
    undoManager.amend(undoEntry, () => applyBytes('before'), () => applyBytes('after'));
  }
}

/** propagateCLEccentricities の単一CL版（handleEccConfirm 用の薄いラッパ）。 */
export async function propagateCLEccentricity(project, activeGraph, clId, opts = {}) {
  return propagateCLEccentricities(project, activeGraph, [clId], opts);
}

/**
 * プル側（F3）: 自階の INTERIOR_WALL エッジが乗る CL のうち、まだ偏芯レコードを持たない
 * （＝ユーザー未編集）ものについて、連動先（階段は設置階〜最上階、吹抜けはその階と直下階）に
 * 既存の偏芯指定があれば取り込む。自階に既にレコードがある CL は上書きしない。
 * 複数の連動先に指定がある場合は階インデックスが近い方を優先する（同点はどちらでもよい）。
 *
 * push（propagateCLEccentricities）だけでは、連動先がまだ仕上げモードに入っていない・
 * 内壁指定（部屋名）がまだ無い等でグラフ上のリンクが見えない間は伝播できない——このケースを
 * 仕上げモード突入時に埋める。ensureUnderStairSplit（FinishModeState.js:104-110）と同格の
 * 自動同期——アクティブグラフ自身を突入時に修復する処理であり、entry 境界の undo エントリ
 * （App.jsx runFinishEntryBoundary の entryUndoFns/entryRedoFns）には積まない。
 *
 * @param {object} project
 * @param {object} activeGraph - 突入した階（アクティブ）のグラフ
 * @param {{materialMap: Map}} opts
 * @returns {Promise<void>}
 */
export async function pullCLEccentricities(project, activeGraph, { materialMap } = {}) {
  const active = activeGraph?.plane;
  const planes = project.planes;
  const activeIdx = planes.findIndex(p => p.id === active?.id);
  if (activeIdx < 0) return;

  const candidateClIds = new Set();
  for (const edge of activeGraph.edges) {
    if (edge.masterType === 'INTERIOR_WALL' && !activeGraph.clEccentricities.has(edge.axisCLId)) {
      candidateClIds.add(edge.axisCLId);
    }
  }
  if (candidateClIds.size === 0) return;

  const peeks = await planePeeks(project, activeGraph);

  for (const clId of candidateClIds) {
    const { group, localIds } = linkedGroupFor(clId, activeGraph, project.structGraph, peeks, activeIdx);
    if (group.size === 0) continue;

    let found = null;
    for (const i of [...group].sort((a, b) => Math.abs(a - activeIdx) - Math.abs(b - activeIdx))) {
      const localId = localIds[i];
      if (!localId) continue;
      const rec = peeks[i].graph.clEccentricities.get(localId);
      if (rec) { found = rec; break; }
    }
    if (!found) continue;

    runInAction(() => {
      activeGraph.setCLEccentricity(clId, found);
      applyCLEccentricity(activeGraph, clId, { materialMap });
    });
  }
}
