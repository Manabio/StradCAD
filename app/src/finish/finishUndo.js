// ================================================================
// 仕上げモード内操作の undo/redo。
//
// 操作ごとに逆関数を組むのではなく、仕上げモードが編集しうる graph 上の
// 状態（部屋・階段・外部仕上げ行・per-floor 材設定）を before/after で
// スナップショットし、差分があれば「まるごと復元」1エントリとして
// undoManager に積む（モード境界の同期 undo — App.jsx — と同じ方式。
// 境界エッジはモード内では変更されないため対象外＝境界側の undo が担う）。
// ================================================================

import { runInAction } from 'mobx';
import { undoManager } from '../undoManager.js';
import { snapshotRoomsState, restoreRoomsState } from './roomReinterpret.js';
import { snapshotUnderSplitCLs, restoreUnderSplitCLs } from './stair/stairUnderSplit.js';
import { ExteriorFinishRow } from '@core';

const EXTERIOR_CATEGORIES = ['exteriorRows', 'exteriorFittingRows', 'structureRows'];
// roomId（階段連動リンク）も対象に含める。含めないと undo → redo で行は残っても
// リンクだけ失われ、以後の階段削除で連動削除（removeExteriorRowsByRoomId）が効かなくなる。
const EXTERIOR_FIELDS     = ['part', 'finish', 'base', 'note', 'roomId'];

// per-floor 材設定・部屋既定値（field → setter 名）
const PER_FLOOR_SETTERS = {
  exteriorWallBacking:  'setExteriorWallBacking',
  interiorWallBacking:  'setInteriorWallBacking',
  ceilingBacking:       'setCeilingBacking',
  floorBacking:         'setFloorBacking',
  defaultFloorLevel:    'setDefaultFloorLevel',
  defaultCeilingHeight: 'setDefaultCeilingHeight',
};

function snapshotStairs(graph) {
  return {
    stairOrder: [...graph.stairOrder],
    stairs: graph.stairOrder.filter(id => graph.stairMap.has(id)).map(id => {
      const s = graph.stairMap.get(id);
      return {
        id: s.id, type: s.type, structure: s.structure, cells: [...s.cells],
        totalSteps: s.totalSteps, tread: s.tread, riser: s.riser ?? null,
        nosing: s.nosing, width: s.width, upDirection: s.upDirection,
        flip: s.flip, sections: s.sections ? [...s.sections] : null,
        roomId: s.roomId ?? null,
      };
    }),
  };
}

function restoreStairs(graph, snap) {
  for (const id of [...graph.stairMap.keys()]) graph.removeStair(id);
  for (const d of snap.stairs) {
    graph.addStair({
      type: d.type, structure: d.structure, cells: new Set(d.cells),
      totalSteps: d.totalSteps, tread: d.tread, riser: d.riser,
      nosing: d.nosing, width: d.width, upDirection: d.upDirection,
      flip: d.flip, sections: d.sections, roomId: d.roomId,
    }, d.id);
  }
  graph.stairOrder.replace(snap.stairOrder.filter(id => graph.stairMap.has(id)));
}

/** 仕上げモードが編集する graph 状態のスナップショット（plain object・JSON 比較可能）。 */
export function snapshotFinishState(graph) {
  return {
    rooms:  snapshotRoomsState(graph),
    stairs: snapshotStairs(graph),
    // 中心線は仕上げ状態の対象外だが、直進階段の階段下分割CL（stairUnderSplit.js）だけは
    // 階段操作（変換・編集・削除）と不可分のため対象に含める（幾何導出で同定・同一IDで復元）
    splitCLs: snapshotUnderSplitCLs(graph),
    exterior: Object.fromEntries(EXTERIOR_CATEGORIES.map(cat => [
      cat,
      graph[cat].map(r => Object.fromEntries([['id', r.id], ...EXTERIOR_FIELDS.map(f => [f, r[f]])])),
    ])),
    perFloor: Object.fromEntries(Object.keys(PER_FLOOR_SETTERS).map(f => [f, graph[f]])),
  };
}

function restoreFinishState(graph, snap) {
  // 分割CLの同定（幾何導出）には復元前の stairs が必要なため、先に現在分を採取しておく
  const currentSplitCLs = snapshotUnderSplitCLs(graph);
  restoreRoomsState(graph, snap.rooms);
  restoreStairs(graph, snap.stairs);
  restoreUnderSplitCLs(graph, currentSplitCLs, snap.splitCLs);
  for (const cat of EXTERIOR_CATEGORIES) {
    graph[cat].replace(snap.exterior[cat].map(d => {
      const row = new ExteriorFinishRow();
      row.id = d.id; // 同一 ID で復元し undo → redo → undo のサイクルを保つ
      for (const f of EXTERIOR_FIELDS) {
        // roomId は旧スナップショット（フィールド追加前・キー欠落）だと undefined になりうるため null 正規化する
        row.setField(f, f === 'roomId' ? (d[f] ?? null) : d[f]);
      }
      return row;
    }));
  }
  for (const [f, setter] of Object.entries(PER_FLOOR_SETTERS)) graph[setter](snap.perFloor[f]);
}

/**
 * before から現在までの差分を undo エントリとして積む。差分が無ければ積まない。
 * @returns {object|null} 積んだエントリ（undoManager.amend 用）。差分なしなら null。
 */
export function pushFinishUndo(graph, before) {
  const after = snapshotFinishState(graph);
  if (JSON.stringify(before) === JSON.stringify(after)) return null;
  return undoManager.push(
    () => runInAction(() => restoreFinishState(graph, before)),
    () => runInAction(() => restoreFinishState(graph, after)),
  );
}

/** fn を実行し、その前後差分を1つの undo エントリとして積む汎用ラッパー。 */
export function withFinishUndo(graph, fn) {
  if (!graph) return fn();
  const before = snapshotFinishState(graph);
  const result = fn();
  pushFinishUndo(graph, before);
  return result;
}

// ---- 自由入力フィールド用（フォーカス〜ブラーの編集を1エントリに集約） ----
// onChange のたびに積むとキーストローク単位のエントリになるため、
// フォーカス時にスナップショットを取り、ブラー時に差分があれば1件だけ積む。
// 同時にフォーカスされる入力は1つなのでモジュール単一の保留スロットでよい。

let fieldUndoPending = null; // { graph, before } | null

export function beginFieldUndo(graph) {
  if (!graph) return;
  fieldUndoPending = { graph, before: snapshotFinishState(graph) };
}

export function endFieldUndo(graph) {
  const pending = fieldUndoPending;
  fieldUndoPending = null;
  if (!pending || pending.graph !== graph) return;
  pushFinishUndo(graph, pending.before);
}
