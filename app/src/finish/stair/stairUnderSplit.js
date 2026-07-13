// ================================================================
// 直進階段（STRAIGHT）の階段下指定用セル分割。
//
// 直進階段は破れ線がセル内部を横切るため「破れ線先セル」が丸ごと存在せず、
// 階段下エリアの部屋ドラッグ（FinishModeState startDrag 優先4）に乗らない。
// そこで破れ線位置（FL+1600。breakStepOf と同一ソース＝straightBreakMm）に
// 分割CL（per-floor・無ラベルARCH・階段外形に extent 限定）を置いてセルを
// 分割し、破れ線先のセルを部屋ドラッグで指定可能にする。直進階段が編集
// されたら分割セルへの指定を外して元に戻す（reset）。階段の削除・直進以外
// への変更では分割CL自体も取り除く。
//
// 分割CLは専用フラグを持たず、幾何（階段外形の内部を横切り、extent が外形の
// 直交範囲と一致する無ラベルARCH実線）から導出して同定する。value は破れ位置
// ＝蹴上依存で動く（編集で移動する）ため同定には使わない。CL は既存のグラフ
// シリアライズで永続化されるため、スキーマ変更なしでリロード後も追跡できる。
// 同定は縦横両軸で照合し、upDirection の軸違いの旧分割CLも拾う。
// ================================================================

import { CenterLineType, Discipline, RoomFeature, StairType } from '@core';
import { cellBoundsFromKey, getCellsInRect, roomBounds } from '../gridCells.js';
import { straightBreakMm } from './stairGeometry.js';

const EPS = 1e-6;       // mm — extent 同定の一致許容（生成時と同じ値をそのまま持つため実質完全一致）
const VALUE_EPS = 0.01; // mm — 破れ位置 value の一致許容（蹴上経由の float 算術の揺れ吸収）

// stair 外形 bounds（解決不能・退化は null）
function stairBounds(stair, graph) {
  const b = roomBounds(stair.cells, graph);
  if (![b.x1, b.y1, b.x2, b.y2].every(Number.isFinite) || !(b.x2 > b.x1) || !(b.y2 > b.y1)) return null;
  return b;
}

// cl が stair 外形 b の階段下分割CLとみなせるか。
// 「外形の内部を横切り、extent が外形の直交範囲と一致する（＝この階段のためだけの分割線）」
// 無ラベルARCH実線（isDividerCL 相当）であること。value は蹴上依存で動くため照合しない。
function isSplitCLFor(cl, b) {
  if (cl.labeled || cl.discipline !== Discipline.ARCH || cl.lineType === 'dashed') return false;
  if (cl.extentLo == null || cl.extentHi == null) return false;
  if (cl.centerLineType === CenterLineType.HORIZONTAL) {
    return cl.value > b.y1 + EPS && cl.value < b.y2 - EPS &&
      Math.abs(cl.extentLo - b.x1) < EPS && Math.abs(cl.extentHi - b.x2) < EPS;
  }
  if (cl.centerLineType === CenterLineType.VERTICAL) {
    return cl.value > b.x1 + EPS && cl.value < b.x2 - EPS &&
      Math.abs(cl.extentLo - b.y1) < EPS && Math.abs(cl.extentHi - b.y2) < EPS;
  }
  return false;
}

/**
 * stair（type=STRAIGHT）の破れ線位置（FL+1600）の分割CL仕様。
 * STRAIGHT 以外・bounds 不定・破れ位置が外形の端に退化する場合は null。
 * @param {number|null} riser - 蹴上(mm)。null なら破れ位置は既定比率（breakStepOf）にフォールバック。
 */
function desiredSplit(stair, graph, riser) {
  if (stair.type !== StairType.STRAIGHT) return null;
  const b = stairBounds(stair, graph);
  if (!b) return null;
  const vertical = stair.upDirection === 'up' || stair.upDirection === 'down';
  const runLength = vertical ? b.y2 - b.y1 : b.x2 - b.x1;
  const breakMm = straightBreakMm(stair, runLength, riser);
  if (breakMm == null || breakMm <= EPS || breakMm >= runLength - EPS) return null;
  // 走行軸 t=0（上り口）の原点・向きは makeFrame の coordAt と同じ対応
  let value;
  switch (stair.upDirection) {
    case 'down':  value = b.y1 + breakMm; break;
    case 'right': value = b.x1 + breakMm; break;
    case 'left':  value = b.x2 - breakMm; break;
    default:      value = b.y2 - breakMm; break; // 'up'
  }
  return vertical
    ? { centerLineType: CenterLineType.HORIZONTAL, value, extentLo: b.x1, extentHi: b.x2 }
    : { centerLineType: CenterLineType.VERTICAL,   value, extentLo: b.y1, extentHi: b.y2 };
}

// cl が仕様 spec（desiredSplit の結果）と一致するか（維持判定用。ここでは value も照合する）
function matchesSpec(cl, spec) {
  return cl.centerLineType === spec.centerLineType &&
    Math.abs(cl.value - spec.value) < VALUE_EPS &&
    cl.extentLo != null && Math.abs(cl.extentLo - spec.extentLo) < EPS &&
    cl.extentHi != null && Math.abs(cl.extentHi - spec.extentHi) < EPS;
}

/**
 * stair の分割CLを幾何から同定して返す（縦横両軸で照合。upDirection 変更後の旧軸や、
 * 蹴上変更で位置がずれた旧分割CLも拾う）。該当なしは空配列。
 * @returns {import('@core').CenterLine[]}
 */
export function findUnderStairSplitCLs(stair, graph) {
  const b = stairBounds(stair, graph);
  if (!b) return [];
  return graph.centerLines.filter(cl => isSplitCLFor(cl, b));
}

// 自動管理 Room（階段ペア・階段吹抜け）か。階段下の「指定」ではないため指定解除の対象外とし、
// 分割CL削除時はキーを現行分割へ張り替えて footprint を保つ（消すと Stair.roomId が孤児化し、
// 外壁生成が階段エリアを「無名屋外」とみなす——data-model.md の不変条件）。
function isManagedRoom(room) {
  return room.feature === RoomFeature.STAIR || room.feature === RoomFeature.STAIR_VOID;
}

// cl をセル境界（4-part キーの構成CL）に持つ部屋のセルを外す＝階段下の指定を元に戻す
// （空になった部屋は削除）。cl 自体は削除しない。自動管理 Room は対象外。
function clearRoomsOnSplitCL(graph, cl) {
  for (const room of [...graph.rooms]) {
    if (isManagedRoom(room)) continue;
    const dead = [...room.cells].filter(key => key.split(':').includes(cl.id));
    if (dead.length === 0) continue;
    for (const key of dead) room.removeCell(key);
    if (room.cells.size === 0) graph.removeRoom(room.id);
  }
}

// 分割CLを削除する（指定解除＋自動管理 Room のキー張り替え込み）。
// 自動管理 Room が cl 参照キーを持つ場合（分割後に ensureStairRooms が細分化キーで補完した等）、
// 削除でキーが解決不能になるため、削除前に矩形を控えて現行分割のキーへ展開し直す。
function removeSplitCL(graph, cl) {
  clearRoomsOnSplitCL(graph, cl);
  const repairs = []; // { room, key, bounds }
  for (const room of graph.rooms) {
    if (!isManagedRoom(room)) continue;
    for (const key of room.cells) {
      if (key.split(':').includes(cl.id)) repairs.push({ room, key, bounds: cellBoundsFromKey(key, graph) });
    }
  }
  graph.removeCenterLine(cl.id);
  for (const { room, key, bounds } of repairs) {
    room.removeCell(key);
    if (!bounds) continue;
    for (const c of getCellsInRect(bounds.x1, bounds.y1, bounds.x2, bounds.y2, graph)) room.addCell(c.key);
  }
}

/**
 * stair の分割状態を現在の仕様へ同期する（冪等）。
 * - STRAIGHT: 破れ線位置（FL+1600）の分割CLを保証する（別位置・別軸の旧分割CLは指定ごと除去）
 * - STRAIGHT 以外: 分割CLを指定ごと除去してセルを元に戻す
 * 仕様に一致する分割CLが既にあれば維持する（階段下の指定も保たれる）。
 * @param {number|null} riser - 蹴上(mm)。stair.riser ?? 階高/総段数（呼び出し側で解決して渡す）。
 * @returns {boolean} 変更したか
 */
export function ensureUnderStairSplit(stair, graph, riser) {
  const desired = desiredSplit(stair, graph, riser);
  let changed = false;
  let exists = false;
  for (const cl of findUnderStairSplitCLs(stair, graph)) {
    if (desired && matchesSpec(cl, desired)) { exists = true; continue; }
    removeSplitCL(graph, cl);
    changed = true;
  }
  if (desired && !exists) {
    graph.addCenterLine(desired.centerLineType, desired.value, {
      labeled: false, trim: false,
      extentLo: desired.extentLo, extentHi: desired.extentHi,
    });
    changed = true;
  }
  return changed;
}

/**
 * 直進階段が編集されたとき: 分割されたセルへの指定（階段下の部屋）を外して元に戻し、
 * 分割CL自体は現在の仕様へ同期する（STRAIGHT のままなら指定経路は維持される。
 * 蹴上・段数の編集で破れ位置が動けば分割CLも作り直される）。
 */
export function resetUnderStairSplit(stair, graph, riser) {
  if (!graph) return;
  for (const cl of findUnderStairSplitCLs(stair, graph)) clearRoomsOnSplitCL(graph, cl);
  ensureUnderStairSplit(stair, graph, riser);
}

/**
 * 階段の削除・部屋への復帰時: 分割CLを指定ごと取り除き、セルを完全に元へ戻す。
 * graph.removeStair より前（同定に stair の cells/bounds が必要）に呼ぶこと。
 */
export function removeUnderStairSplit(stair, graph) {
  for (const cl of findUnderStairSplitCLs(stair, graph)) removeSplitCL(graph, cl);
}

/**
 * graph 上の全階段の分割CLを plain object で列挙する（仕上げ undo スナップショット用。
 * finishUndo.js の snapshotFinishState / restoreFinishState から使う）。
 * @returns {Array<{id, centerLineType, value, extentLo, extentHi}>} id 昇順
 */
export function snapshotUnderSplitCLs(graph) {
  const map = new Map();
  for (const stair of graph.stairs) {
    for (const cl of findUnderStairSplitCLs(stair, graph)) {
      map.set(cl.id, {
        id: cl.id, centerLineType: cl.centerLineType, value: cl.value,
        extentLo: cl.extentLo, extentHi: cl.extentHi,
      });
    }
  }
  return [...map.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/**
 * 分割CL集合をスナップショットの状態へ入れ替える（undo/redo 用）。
 * currentSplitCLs は復元前（現在の stairs 基準）に snapshotUnderSplitCLs で採取したもの。
 * 部屋のセルキーが分割CLの id を参照するため、同一 id で復元して参照を保つ。
 */
export function restoreUnderSplitCLs(graph, currentSplitCLs, snapSplitCLs) {
  const keep = new Set((snapSplitCLs ?? []).map(d => d.id));
  for (const d of currentSplitCLs) {
    if (!keep.has(d.id)) graph.removeCenterLine(d.id);
  }
  for (const d of snapSplitCLs ?? []) {
    if (graph.shapeMap.has(d.id)) continue;
    graph.addCenterLine(d.centerLineType, d.value, {
      labeled: false, trim: false, extentLo: d.extentLo, extentHi: d.extentHi,
    }, d.id);
  }
}
