/**
 * 屋根（RoomFeature.ROOF）と他の階の整合の判定（純関数。I/O は呼び出し側が注入する peekFn だけ。
 * store.js / snap.js / .jsx を静的 import しない）。ステップ B1b。
 *
 * 屋根は他の階へ何も書き込まない（上の階の同じ位置は元々「屋根の外＝建物の外」の扱い）。ここでは、
 * 屋根を付けた直後に「屋根の上の階の同じ位置に屋内の部屋がある」ことを警告のために調べるだけ。
 * 屋根の下の階に部屋が無い屋根（庇・カーポート）は正当なので、下の階は調べない。
 */
import { RoomKind, RoomFeature } from '@core';
import { cellBoundsFromKey } from '../gridCells.js';

const OVERLAP_EPS = 1e-6;

/**
 * 表示中の階（activePlane）より上の採用フロア（elevation 昇順）。階段・昇降機の階またぎ
 * （finish/stair/stairFloorSync.js syncUpperFloors・finish/equipment/equipmentFloorSync.js
 * runElevatorInstall）と同じ流儀で、planes（project.planes＝採用フロアのみ。検討案・屋根専用平面は
 * 含まれない）に activePlane が無い（検討案の平面がアクティブ）ときは空配列＝上の階は無いものとする。
 * @param {object[]} planes - project.planes
 * @param {object|null|undefined} activePlane
 * @returns {object[]}
 */
export function upperAdoptedPlanes(planes, activePlane) {
  if (!activePlane) return [];
  const idx = planes.findIndex(p => p.id === activePlane.id);
  return idx < 0 ? [] : planes.slice(idx + 1);
}

function overlapsPositively(a, b) {
  return Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1) > OVERLAP_EPS
    && Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1) > OVERLAP_EPS;
}

// 屋内の部屋か。kind が屋外でない部屋（壁・構造の「建物内」判定 structural/wallGate.js isBuildingRoom と
// 同じ kind 軸）。未定義（UNDEFINED。削除後に外壁線だけ残す残置）は部屋とみなさない。
function isIndoorRoom(room) {
  return room.kind === RoomKind.INTERIOR && room.feature !== RoomFeature.UNDEFINED;
}

/**
 * upperGraph に、rects（世界座標の矩形 {x1,y1,x2,y2}）と正の面積で重なる屋内の部屋があるか。
 * セルの対応は CL id ではなく世界座標で取る（階ごとに CL 構成・格子の粒度が違うため。
 * 上の階の格子が細かい・粗い・ずれていても矩形の重なりで当たる）。
 * @param {object} upperGraph
 * @param {Array<{x1:number,y1:number,x2:number,y2:number}>} rects
 * @returns {boolean}
 */
export function hasIndoorRoomOverRects(upperGraph, rects) {
  if (rects.length === 0) return false;
  for (const room of upperGraph.rooms) {
    if (!isIndoorRoom(room)) continue;
    for (const key of room.cells) {
      const b = cellBoundsFromKey(key, upperGraph);
      if (b && rects.some(r => overlapsPositively(r, b))) return true;
    }
  }
  return false;
}

/**
 * 屋根のセル（cells。activeGraph の cellKey 集合）の上の階（自階より上の採用フロアの全て）に、同じ位置の
 * 屋内部屋がある階の名前を階の順（elevation 昇順）で返す。該当なしなら空配列。
 * 上の階は peekFn で読む（読むだけ。書き込まない）。peekFn の失敗（reject・null）は握りつぶさず reject する
 * ——呼び出し側が階段の上階展開（stairFloorSync.js）と同じ流儀でログに出す。
 * @param {object} project
 * @param {object} activeGraph - 屋根を付けた階（表示中）のグラフ
 * @param {Set<string>} cells - 屋根のセル
 * @param {(plane: object) => Promise<object>} peekFn - 他階を読み取り専用の一時グラフへ復元する関数
 * @returns {Promise<string[]>} 階名
 */
export async function findUpperRoomsOverCells(project, activeGraph, cells, peekFn) {
  const rects = [];
  for (const key of cells) {
    const b = cellBoundsFromKey(key, activeGraph);
    if (b) rects.push(b);
  }
  if (rects.length === 0) return [];

  const names = [];
  for (const plane of upperAdoptedPlanes(project.planes, activeGraph.plane)) {
    const upperGraph = await peekFn(plane);
    if (!upperGraph) throw new Error(`findUpperRoomsOverCells: peek が階のグラフを返しませんでした（plane=${plane.id}）`);
    if (hasIndoorRoomOverRects(upperGraph, rects)) names.push(plane.name);
  }
  return names;
}
