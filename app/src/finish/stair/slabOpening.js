/**
 * 上階スラブの開口（＝上階に床が無い領域）と、その境界線の解決（純モジュール）。
 *
 * 「破れ線から先＝当該平面の切断高より上に続く階段」を点線で描くとき、どこまで見えるかは
 * 上階の床が開いている範囲で決まる。問題仕様の
 *   「上階床面の吹抜け形状 − 当該階天井高さの壁形状 − 上階の階段とりつき部」
 * のうち第1項と第3項は「上階に床が無い領域」という1つの概念に還元できる
 * （とりつき部＝上階でスラブが残る側なので、最初から開口に含まれない）。第2項の壁は
 * `slabOpeningEdges` が当該階の壁スパンを差し引くことで効かせる
 * （階段側面線の `resolveStairSideLines` と同じ規約）。
 *
 * store.js / snap.js / .jsx に依存しない（node:test から単体 import 可）。
 */
import { RoomFeature } from '@core';
import { cellBoundsList, refreshCells, roomBounds, getCellsInRect } from '../gridCells.js';
import { faceRect } from '../wallFaces.js';
import { cellsBeyondBreak, subtractIntervals } from './stairGeometry.js';

// 境界CL一致判定の許容差(mm)。resolveStairSideLines の WALL_AXIS_CL_EPS と同一規約
// （壁は境界CLに帰属するため通常ほぼ0。丸め・端数対策の余裕）。
const WALL_AXIS_CL_EPS = 0.5;

// 開口を成すセル集合を列挙する。`kind` は縁を誰が描くかの区別
// （'void'＝renderer/VoidLayer.jsx が「上部吹抜け」として外形を描く / 'stair'＝階段側が描く）。
// - 吹抜け（VOID）Room … 占有セル全体が開口。kind='void'
// - 階段吹抜け（STAIR_VOID）Room … 占有セル全体が開口。VoidLayer は描画対象外のため kind='stair'
// - 上階の階段 … 破れ線より先のセルが開口（破れ手前＝階段とりつき部はスラブが残る）。kind='stair'
function openingCellSets(upperGraph, riserOf) {
  const sets = [];
  for (const room of upperGraph.rooms) {
    if (room.feature !== RoomFeature.VOID && room.feature !== RoomFeature.STAIR_VOID) continue;
    const cells = refreshCells(room.cells, upperGraph);
    if (cells.size > 0) sets.push({ cells, kind: room.feature === RoomFeature.VOID ? 'void' : 'stair' });
  }
  for (const stair of upperGraph.stairs) {
    const beyond = cellsBeyondBreak(stair, upperGraph, riserOf(stair));
    if (beyond.size > 0) sets.push({ cells: beyond, kind: 'stair' });
  }
  return sets;
}

/**
 * 上階スラブの開口をワールド矩形の配列で返す。破れ先の破線を切るクリップ範囲に使う。
 * 矩形の開口は**実際に描かれる縁と同じ壁面矩形**（`slabOpeningEdges` の描画位置と一致）を返す
 * ——CL位置の粗い矩形を返すと、線が縁より外へ半壁厚ぶん突き抜ける（過去の不良）。
 * 非矩形の開口だけセル矩形群へフォールバックする。
 * 世界座標は全階共通のため、返り値はそのまま下階の描画クリップに使える。
 * @param {object|null} upperGraph 直上の採用フロアの（peek 済み）グラフ。null なら null を返す
 * @param {{riserOf?: (stair:object)=>number|null}} [opts] 上階階段の蹴上（破れ位置の決定に使う）
 * @returns {{x1:number,y1:number,x2:number,y2:number}[]|null}
 *   null＝上階が無い／未解決（呼び出し側はクリップしない）。空配列＝開口を導出できなかった。
 */
export function slabOpeningRects(upperGraph, { riserOf = () => null } = {}) {
  if (!upperGraph) return null;
  return openingParts(upperGraph, riserOf)
    .flatMap(p => (p.face ? [p.face] : cellBoundsList(p.cells, upperGraph)));
}

/**
 * 開口ごとの「境界CL矩形」と「実際に描く壁面矩形」の対を返す（境界線の描画用）。
 * 描く位置は上階の壁の内面（＝開口側の面。腰壁なら外面にあたる）で、壁が無い辺はCLへ落ちる
 * （`faceRect` の規約）。壁の有無判定は境界CLで行うため、両方を持つ必要がある。
 * 非矩形の開口は1つの矩形で境界を表せないためスキップする（voidGeometry.js と同じ方針）。
 *
 * 上階の吹抜け（VOID）Roomは除く（ユーザー決定2026-09）——その外形は renderer/VoidLayer.jsx が
 * 「上部吹抜け」の破線として既に描いており、ここでも描くと同じ矩形に線種・太さの違う破線が
 * 二重に乗る（VoidLayer は insetRect ぶん内側、dash も別）。開口としての範囲そのものは
 * `slabOpeningRects`（破れ先破線のクリップ用）が引き続きVOIDを含めて返す。
 * STAIR_VOID は VoidLayer の描画対象外（voidGeometry.js）なので、ここが縁を描き続ける。
 * @returns {{cl:object, face:object}[]|null} null＝上階が無い／未解決
 */
export function slabOpeningFrames(upperGraph, { riserOf = () => null } = {}) {
  if (!upperGraph) return null;
  return openingParts(upperGraph, riserOf)
    .filter(p => p.face && p.kind !== 'void')
    .map(p => ({ cl: p.cl, face: p.face }));
}

// 開口1つぶんの {cells, cl, face}。非矩形（1つの矩形で境界を表せない）は cl/face を null にし、
// 呼び出し側がセル矩形へフォールバックする（voidGeometry.js と同じ「矩形のみ」方針）。
function openingParts(upperGraph, riserOf) {
  return openingCellSets(upperGraph, riserOf).map(({ cells, kind }) => {
    const cl = roomBounds(cells, upperGraph);
    if (!Number.isFinite(cl.x1) || !(cl.x2 > cl.x1 && cl.y2 > cl.y1)) return { cells, kind, cl: null, face: null };
    const inBounds = getCellsInRect(cl.x1, cl.y1, cl.x2, cl.y2, upperGraph);
    if (!inBounds.every(c => cells.has(c.key))) return { cells, kind, cl: null, face: null };
    return { cells, kind, cl, face: faceRect(cells, upperGraph) ?? cl };
  });
}

/**
 * 開口の境界線のうち、当該階の壁に覆われていない区間を返す（見上げの破線として描く分）。
 * 壁に覆われた区間は当該平面に実線が既にあるため描かない——これが仕様の
 * 「当該階天井高さの壁形状を差し引く」にあたる。
 * @param {ReturnType<typeof slabOpeningFrames>} frames
 * @param {object} graph 当該階（表示中の階）のグラフ
 * @returns {{x1:number,y1:number,x2:number,y2:number}[]}
 */
export function slabOpeningEdges(frames, graph) {
  if (!frames?.length || !graph) return [];
  const walls = graph.walls;
  const out = [];
  // clValue=壁の有無を照合する境界CL、drawValue=実際に描く座標（上階の壁面）。
  const emit = (isVertical, clValue, drawValue, lo, hi) => {
    const covers = walls
      .filter(w => w.isVertical === isVertical && Math.abs(w.axisCL.value - clValue) < WALL_AXIS_CL_EPS)
      .map(w => [Math.min(w.coord1, w.coord2), Math.max(w.coord1, w.coord2)]);
    for (const [a, b] of subtractIntervals(lo, hi, covers)) {
      out.push(isVertical
        ? { x1: drawValue, y1: a, x2: drawValue, y2: b }
        : { x1: a, y1: drawValue, x2: b, y2: drawValue });
    }
  };
  for (const { cl, face } of frames) {
    emit(true,  cl.x1, face.x1, face.y1, face.y2);
    emit(true,  cl.x2, face.x2, face.y1, face.y2);
    emit(false, cl.y1, face.y1, face.x1, face.x2);
    emit(false, cl.y2, face.y2, face.x1, face.x2);
  }
  return out;
}

const EPS = 1e-6;

/**
 * 開口の縁を、階段側の破れ先破線と突き合わせてトリムする。
 *
 * 階段のとりつき部では階段側の破線が縁を担うため、その区間は開口線から落とす（二重線にしない）。
 * 切る位置は**直交する破れ先破線との交点**で、破れ先セルの境界CL（レーン間の通り芯など）ではない
 * ——実際に描かれている線どうしが直角に出会ってL字になるのが正。CLで止めると描かれている線より
 * 手前で途切れる（過去の不良）。破れ先破線は先に開口の縁でクリップされているため、縁に**端点で
 * 接する**形になる：交差判定は端点の接触も交点として拾うこと（EPS 込みの閉区間で判定する）。
 * @param {{x1,y1,x2,y2}[]} edges slabOpeningEdges の結果
 * @param {{x1,y1,x2,y2}[]} stairSegs 階段側の破れ先破線（開口でクリップ済み・軸平行）
 * @param {{x1,y1,x2,y2}[]} beyondBounds 破れ先セルのワールド矩形。無ければトリムしない（安全側）
 */
export function trimOpeningEdgesAgainstStair(edges, stairSegs, beyondBounds) {
  if (!edges?.length) return [];
  if (!stairSegs?.length || !beyondBounds?.length) return edges;
  const isVert = (s) => Math.abs(s.x1 - s.x2) < Math.abs(s.y1 - s.y2);
  const inBeyond = (x, y) => beyondBounds.some(b => b.x1 <= x && x <= b.x2 && b.y1 <= y && y <= b.y2);
  const out = [];
  for (const e of edges) {
    const vertical = isVert(e);
    // 辺: 位置 value、区間 [lo,hi]（vertical なら value=x・区間=y、水平なら value=y・区間=x）
    const value = vertical ? e.x1 : e.y1;
    const lo = vertical ? Math.min(e.y1, e.y2) : Math.min(e.x1, e.x2);
    const hi = vertical ? Math.max(e.y1, e.y2) : Math.max(e.x1, e.x2);
    const cuts = [];
    for (const s of stairSegs) {
      if (isVert(s) === vertical) continue;                          // 平行線では切らない
      const at  = vertical ? (s.y1 + s.y2) / 2 : (s.x1 + s.x2) / 2;  // 辺に沿う座標
      const sLo = vertical ? Math.min(s.x1, s.x2) : Math.min(s.y1, s.y2);
      const sHi = vertical ? Math.max(s.x1, s.x2) : Math.max(s.y1, s.y2);
      if (value < sLo - EPS || value > sHi + EPS) continue;          // 端点接触も交点として拾う
      if (at <= lo + EPS || at >= hi - EPS) continue;                // 区間の途中でなければ切らない
      cuts.push(at);
    }
    const stops = [lo, ...cuts.sort((a, b) => a - b), hi];
    for (let i = 0; i < stops.length - 1; i++) {
      const a = stops[i], b = stops[i + 1];
      if (b - a <= EPS) continue;
      const mid = (a + b) / 2;
      // 中点が破れ先セル＝階段側が縁を担う区間 → 開口線としては描かない
      if (inBeyond(vertical ? value : mid, vertical ? mid : value)) continue;
      out.push(vertical
        ? { x1: value, y1: a, x2: value, y2: b }
        : { x1: a, y1: value, x2: b, y2: value });
    }
  }
  return out;
}
