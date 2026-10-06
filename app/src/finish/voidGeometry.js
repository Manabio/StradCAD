/**
 * 吹抜け（feature=VOID）・昇降路（isShaftFeature。昇降機）の×描画
 * （壁内4頂点を対角に結ぶ線分）の幾何計算。
 *
 * 描画ルールをここへ集約し、レンダラ（renderer/VoidLayer.jsx）は結果を Konva 要素へ写像
 * するだけにする（finish/stepSection.js・finish/stair/stairGeometry.js と同じパターン）。
 * 対象は feature===VOID または isShaftFeature(feature) のみ——STAIR_VOID（階段吹抜け）は
 * 一切描画しない自動管理Room（要件）。上部吹抜けラベル（「上部吹抜け」文言）は VOID のみに
 * 付ける（`showsUpperVoidLabel`）。
 *
 * 直下階の破線（上階の吹抜け・昇降路を示す×・外形）は、自階に同じ位置の吹抜け・昇降路が
 * 無いときだけ描く（`visibleUpperVoidCrosses`。2026-10-01 裁定）。上階の cross の元セル集合が
 * 自階の吹抜け・昇降路セル（`ownVoidCellRects`。feature を問わない）の和集合に覆われているなら、
 * その位置に床は無く「上部吹抜け」の破線は不要——昇降路は設置階〜最上階まで同じシャフトが
 * 続くため、この一般判定だけでどの階にも破線が出なくなる（旧裁定Q8のうち「昇降路も破線は出す」
 * 部分はこの一般判定に置き換わった。「昇降路にはラベルを付けない」部分は
 * `showsUpperVoidLabel` として存続——下記コメント参照）。
 * 判定は **セル境界CLの値**（`cellRect`。QA指摘M1: faceRectは壁の内側面で、上階にまだ壁が
 * 無い・自階にはある等で壁厚ぶんズレるため不適）で行い、壁の有無・厚みに左右されない。
 *
 * 昇降路（isShaftFeature）は器具行を1件以上持つRoomなら「器具単位」で×を出す
 * （id は器具行の id。統合でL字になったRoomでも器具ごとに矩形が出る）。器具行の無い
 * 昇降路Room（旧データ）はRoom単位のまま（挙動不変）。同じRoom内の器具どうしの境界には
 * 壁が無いため、faceRectはその境界をCLのeffectiveValueへフォールバックし、隣の器具へ
 * はみ出さず・重ならない矩形になる。
 */
import { RoomFeature, isShaftFeature } from '@core';
import { refreshCells, isRectangularCellSet, cellBoundsList } from './gridCells.js';
import { faceRect, footprintBoundaryCLs } from './wallFaces.js';

// crossを1件組み立てる（矩形でない・壁内頂点が解決できない場合はnull）。
// cellRect はセル境界CLの値そのもの（壁の有無・厚みに左右されない。QA指摘M1対応）——
// rect（faceRect。壁内4頂点）が非nullなら footprintBoundaryCLs も必ず解決できる
// （faceRect内部で同じ関数から計算しているため）。
function buildCross(id, feature, cells, graph) {
  if (!isRectangularCellSet(cells, graph)) return null;
  const rect = faceRect(cells, graph);
  if (!rect) return null;
  const b = footprintBoundaryCLs(cells, graph);
  if (!b) return null;
  const cellRect = { x1: b.left.effectiveValue, y1: b.top.effectiveValue, x2: b.right.effectiveValue, y2: b.bottom.effectiveValue };
  return { id, feature, x1: rect.x1, y1: rect.y1, x2: rect.x2, y2: rect.y2, cellRect };
}

/**
 * 「上部吹抜け」（直下階に描く上階吹抜けの×・外形）の破線パターン（スクリーンpx）。
 * **平面の「見えない線」の破線パターンの供給源**——階段の上り部分（破れ先）の破線
 * （finish/stair/stairLineJoinPrimitives.js の `stairDownviewDashPx`）もこれを参照する。
 * 線種が食い違うと、隣り合ったとき混在して見える（ユーザー決定2026-09）。
 * 自階の吹抜け（一点鎖線）は別の線種で、ここには含めない。階段の見上げ破線（開口の縁）は廃止済み（2026-10-06）。
 */
export const UPPER_VOID_DASH_PX = [8, 4];

/**
 * グラフ全体から吹抜け・昇降路（昇降機）の×描画データを列挙する。
 * 矩形（RoomLabelsLayer.jsx の isRectangular 判定と同じ方式。ただし refreshCells 済みで比較）
 * でない部屋・壁内4頂点が解決できない部屋はスキップする。
 * @returns {{id:string, feature:string, x1:number, y1:number, x2:number, y2:number, cellRect:{x1:number,y1:number,x2:number,y2:number}}[]}
 */
export function computeVoidCrosses(graph) {
  if (!graph) return [];
  const result = [];
  const registeredShaftRoomIds = new Set(
    (graph.equipmentRows ?? []).map(r => r.roomId).filter(Boolean),
  );
  for (const room of graph.rooms) {
    if (room.feature !== RoomFeature.VOID && !isShaftFeature(room.feature)) continue;
    // 器具行を1件以上持つ昇降路Roomは器具単位（下のループ）へ委譲する。
    if (isShaftFeature(room.feature) && registeredShaftRoomIds.has(room.id)) continue;
    const cross = buildCross(room.id, room.feature, refreshCells(room.cells, graph), graph);
    if (cross) result.push(cross);
  }
  for (const row of graph.equipmentRows ?? []) {
    const cells = refreshCells(row.cellKeys, graph);
    if (cells.size === 0) continue; // セルが解決できない（CL無し等）行はスキップ
    const cross = buildCross(row.id, RoomFeature.ELEVATOR_EQUIPMENT, cells, graph);
    if (cross) result.push(cross);
  }
  return result;
}

/**
 * 自階の吹抜け・昇降路（feature を問わない）が占める全セルの矩形（セル境界CLの値。壁は
 * 無関係）を列挙する。`visibleUpperVoidCrosses` の「自階の被覆範囲」に使う——1つの Room・
 * 1つの cross に丸ごと収まるかではなく、複数の部屋・器具にまたがる和集合で判定するため、
 * 部屋単位ではなくセル単位で返す（QA指摘M2: 器具2基分割・非矩形部屋等での見逃し対応）。
 * 非矩形の部屋も含める（cellBoundsList は各セルの矩形を返すため、部屋の形は問わない）。
 * @returns {Array<{x1:number,y1:number,x2:number,y2:number}>}
 */
export function ownVoidCellRects(graph) {
  if (!graph) return [];
  const rects = [];
  for (const room of graph.rooms) {
    if (room.feature !== RoomFeature.VOID && !isShaftFeature(room.feature)) continue;
    const cells = refreshCells(room.cells, graph);
    for (const b of cellBoundsList(cells, graph)) rects.push(b);
  }
  return rects;
}

// セル境界CL値どうしの比較に使う許容差(mm)。cellRect・ownCellRects はどちらも壁を介さず
// CLのeffectiveValueから直接求めるため、壁厚差は原理的に生じない（QA指摘M1対応）。
// eps は浮動小数の丸め誤差だけを吸収すればよいので小さい値でよい。
const CELL_RECT_EPS_MM = 1;

// rect（{x1,y1,x2,y2}）が ownRects（同一グリッドとは限らない矩形群）の和集合に eps 許容で
// 覆われているか。rect を ownRects の境界値でマイクロ格子に分割し、各小矩形の中心が
// いずれかの ownRect に入っているかで判定する（gridCells.js getCellsInRect と同じ考え方）。
function isCoveredByUnion(rect, ownRects, eps) {
  const xs = new Set([rect.x1, rect.x2]);
  const ys = new Set([rect.y1, rect.y2]);
  const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
  for (const o of ownRects) {
    if (o.x1 > rect.x1 && o.x1 < rect.x2) xs.add(o.x1);
    if (o.x2 > rect.x1 && o.x2 < rect.x2) xs.add(o.x2);
    if (o.y1 > rect.y1 && o.y1 < rect.y2) ys.add(o.y1);
    if (o.y2 > rect.y1 && o.y2 < rect.y2) ys.add(o.y2);
  }
  const xVals = [...xs].sort((a, b) => a - b);
  const yVals = [...ys].sort((a, b) => a - b);
  let checked = 0; // 判定した小矩形の数（0件＝rect 自体が退化していて「覆われた」とは言えない）
  for (let i = 0; i < xVals.length - 1; i++) {
    if (xVals[i + 1] - xVals[i] <= eps) continue; // 丸め誤差由来の退化区間は無視
    for (let j = 0; j < yVals.length - 1; j++) {
      if (yVals[j + 1] - yVals[j] <= eps) continue;
      const midX = clamp((xVals[i] + xVals[i + 1]) / 2, rect.x1, rect.x2);
      const midY = clamp((yVals[j] + yVals[j + 1]) / 2, rect.y1, rect.y2);
      const covered = ownRects.some(o =>
        o.x1 - eps <= midX && midX <= o.x2 + eps && o.y1 - eps <= midY && midY <= o.y2 + eps);
      if (!covered) return false;
      checked++;
    }
  }
  return checked > 0;
}

/**
 * upperCrosses（上階の cross）のうち、自階に同位置の吹抜け・昇降路が無いものだけを返す。
 * 上階の cross の `cellRect`（セル境界CLの値）が、`ownCellRects`（`ownVoidCellRects` の
 * 返り値。自階の吹抜け・昇降路が占める全セルの矩形。feature を問わず和集合で見る）に
 * 覆われているなら、その位置には自階に床が無い（上階と同じ開口が続いている）ため除外する
 * ——昇降路は設置階〜最上階に同じシャフトが続くので、この判定だけでどの階にも破線が
 * 出なくなる（2026-10-01 裁定。QA指摘M1・M2対応でCL値ベース・和集合判定に改めた）。
 * @param {Array<{id:string,feature:string,x1:number,y1:number,x2:number,y2:number,cellRect:{x1:number,y1:number,x2:number,y2:number}}>} upperCrosses
 * @param {Array<{x1:number,y1:number,x2:number,y2:number}>} ownCellRects
 * @param {number} [eps]
 * @returns {typeof upperCrosses}
 */
export function visibleUpperVoidCrosses(upperCrosses, ownCellRects, eps = CELL_RECT_EPS_MM) {
  if (!upperCrosses || upperCrosses.length === 0) return [];
  const owns = ownCellRects ?? [];
  if (owns.length === 0) return upperCrosses;
  return upperCrosses.filter(u => !(u.cellRect && isCoveredByUnion(u.cellRect, owns, eps)));
}

/**
 * 直下階から見た「上部吹抜け」ラベル（固定文言）を付けるかどうか。
 * VOID のみ true——昇降路（昇降機）は同じシャフトが階をまたいで続くだけなので、破線を描く
 * 場合（自階に昇降路が無い直下階）もラベルは付けない（裁定Q8のうち存続する部分）。
 * @param {{feature:string}} cross computeVoidCrosses の返り値の要素
 * @returns {boolean}
 */
export function showsUpperVoidLabel(cross) {
  return cross?.feature === RoomFeature.VOID;
}
