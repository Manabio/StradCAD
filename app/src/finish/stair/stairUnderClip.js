/**
 * 2a壁（階段下部屋の偏芯壁）の描画クリップ計算。
 *
 * 「2a部屋の壁は、壁データとしては生成しつつ、破れ線（斜めZ字ポリライン）より階段踏面側
 * （＝破れ手前側。cellsBeyondBreak の外＝実際に踏面が描かれる側）の部分を描画しない」
 * （.claude/stair-model.md・タスク仕様）を、壁ID→クリップ多角形（サブパス配列）の Map として
 * 算出する。描画への反映は ShapesLayer.jsx が担う（この関数はジオメトリ計算のみ・純関数）。
 *
 * 破れ線より外側の可視判定（矢印・踏面線・段数字。StairLayer.jsx）とは独立したゲート
 * （第4の独立ゲート）——既存の limitMm/中点判定/アンカー判定には合流させない。
 *
 * StairLayer.jsx とは installEntries（install ビューの階段エントリ）だけを共有し二重計算を
 * 避ける。buildStairGeometry 自体は StairLayer 側のフル描画ジオメトリ（踏面・矢印等を含む）
 * とは別に、ここでは breakLine 抽出のためだけに個別に呼び出す（同じ入力で2回計算される。
 * 完全な共有をしていない点は既知——将来 useMemo 化する際の対象）。
 */

import { StairType } from '@core';
import { buildStairGeometry, cellsBeyondBreak } from './stairGeometry.js';
import { cellBoundsList } from '../gridCells.js';
import { stairUnderRoomsOf } from './stairUnderRooms.js';

// keep領域（破れ線先セルの実矩形）の拡張量(mm)。2a壁の下地厚(90)+仕上げ厚(12.5)と、外側の
// 隣室仕上げ薄壁厚(12.5)を合わせた実材幅（102.5+12.5）を確実に飲み込む余裕。
const KEEP_MARGIN = 150; // mm
// outerRect・footprintHole の拡張量(mm)。壁の端点・材位置の丸め誤差を十分に飲み込む余裕
// （既存の EXISTING_WALL_POSITION_TOLERANCE 等と同水準の桁）。
const RECT_MARGIN = 150; // mm

// 破れ線の弦（斜め半平面）でkeep領域を絞り込む型。L_TURN/FLARED/OPEN_WELLは弦の無限延長が
// 別アーム側の破れ線先セルを誤って切ってしまうため対象外（矩形のまま＝セル粒度でクリップ）。
const HALF_PLANE_TYPES = new Set([
  StairType.STRAIGHT, StairType.STRAIGHT_LANDING, StairType.SWITCHBACK, StairType.WINDING,
]);

function unionRect(a, b) {
  return { x1: Math.min(a.x1, b.x1), y1: Math.min(a.y1, b.y1), x2: Math.max(a.x2, b.x2), y2: Math.max(a.y2, b.y2) };
}

function expandRect(r, margin) {
  return { x1: r.x1 - margin, y1: r.y1 - margin, x2: r.x2 + margin, y2: r.y2 + margin };
}

function rectPolygon(r) {
  return [{ x: r.x1, y: r.y1 }, { x: r.x2, y: r.y1 }, { x: r.x2, y: r.y2 }, { x: r.x1, y: r.y2 }];
}

// シューレース公式による符号付き面積（頂点順が正方向かどうかの判定に使う）。
function signedArea(pts) {
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length];
    s += p.x * q.y - q.x * p.y;
  }
  return s / 2;
}

// pts の向きを、signedArea の符号が wantPositive と一致するように揃える（一致しなければ逆順）。
// nonzero 巻き数規則で「outerRect・keepPoly は同じ向き（加算）、footprintHole は逆向き（減算）」
// という代数を頂点順に依らず成立させるために使う。
function orient(pts, wantPositive) {
  const isPositive = signedArea(pts) > 0;
  return isPositive === wantPositive ? pts : [...pts].reverse();
}

// 壁の実材範囲（materialRange）× 長さ方向範囲（coord1/coord2）のワールド矩形。
function wallWorldRect(w) {
  const lo = Math.min(w.coord1, w.coord2), hi = Math.max(w.coord1, w.coord2);
  const { lo: mLo, hi: mHi } = w.materialRange;
  return w.isVertical
    ? { x1: mLo, y1: lo, x2: mHi, y2: hi }
    : { x1: lo, y1: mLo, x2: hi, y2: mHi };
}

// breakLine（buildStairGeometry の結果。連結したセグメント配列）を頂点列（連結点列）へ変換する。
// セグメントは [E1→A, A→B, B→D, D→C, C→E2] の順に必ず連結している（stairGeometry.js の
// breakSymbol/breakSymbolAwayFromLanding 参照）ため、始点＋各セグメント終点を辿るだけでよい。
function breakLineToPoints(segs) {
  if (!segs || segs.length === 0) return [];
  const pts = [{ x: segs[0].x1, y: segs[0].y1 }];
  for (const s of segs) pts.push({ x: s.x2, y: s.y2 });
  return pts;
}

// poly（world座標の頂点列。凸・非凸いずれも可）を、直線 a+t*d を境に
// cross(p)=d.x*(p.y-a.y)-d.y*(p.x-a.x) の符号が beyondSign と同じ（0含む）側だけへ
// 単一エッジでクリップする（Sutherland-Hodgman の半平面クリップ1回分）。
// 結果が3点未満（完全にクリップされて消える・退化）なら空配列を返す。
function clipHalfPlane(poly, a, d, beyondSign) {
  const cross = (p) => d.x * (p.y - a.y) - d.y * (p.x - a.x);
  const n = poly.length;
  const out = [];
  for (let i = 0; i < n; i++) {
    const cur = poly[i], prev = poly[(i - 1 + n) % n];
    const curIn = cross(cur) * beyondSign >= 0;
    const prevIn = cross(prev) * beyondSign >= 0;
    if (curIn) {
      if (!prevIn) out.push(intersectAtCross(prev, cur, cross));
      out.push(cur);
    } else if (prevIn) {
      out.push(intersectAtCross(prev, cur, cross));
    }
  }
  return out.length >= 3 ? out : [];
}
function intersectAtCross(p1, p2, cross) {
  const c1 = cross(p1), c2 = cross(p2);
  const t = c1 / (c1 - c2);
  return { x: p1.x + (p2.x - p1.x) * t, y: p1.y + (p2.y - p1.y) * t };
}

/**
 * 2a壁（階段下部屋の偏芯壁）の壁ID→クリップ用サブパス配列 の Map を返す。クリップ対象が
 * 1件も無ければ null（呼び出し側が毎レンダー新規の空Mapを observer の props へ渡し続けて
 * 無駄な再描画差分を生まないよう、参照的に安定した「クリップなし」を返す）。
 *
 * サブパスは [{x,y}...] の頂点列（ワールドmm）で、nonzero 巻き数規則の合成で
 * 「outerRect −（footprint内かつ keep領域の外）」を表す（詳細はモジュール先頭コメント）。
 * keep領域 = 破れ線先セルの実矩形群（KEEP_MARGIN拡張）。STRAIGHT/STRAIGHT_LANDING/
 * SWITCHBACK/WINDING は各矩形をさらに破れ線弦の beyond側半平面でクリップし、斜めの
 * 破れ線の見た目に一致させる（半平面が求まらない退化ケースは矩形のまま）。L_TURN/FLARED/
 * OPEN_WELL は弦の無限延長が別アームの破れ線先セルを誤って切るため半平面クリップを行わない
 * （セル粒度のまま。.claude/stair-model.md の既知の限界参照）。
 *
 * @param {object} graph
 * @param {Array<{stair, bounds:{x1,y1,x2,y2}, riser:number|null, spans, graph}>} installEntries
 *   App.jsx が算出する install ビューの階段エントリ（StairLayer と共有。二重計算しない）。
 * @param {{laneGapMm?:number, breakOverhangMm?:number, detail?:boolean,
 *   lowerStairCellBounds?:{x1,y1,x2,y2}[]}} opts
 *   lowerStairCellBounds … 直下階の階段の見下げ表示（upperEntries）の実セル占有矩形。中間階
 *   （下階階段の見下げ位置と重なる）は2a不成立としてクリップしない（FinishModeState.stairUnderRooms
 *   の中間階ガードと同じ判定をここでも行う）。
 * @returns {Map<string, {x:number,y:number}[][]> | null}
 */
export function stairUnderWallClips(graph, installEntries, opts = {}) {
  const { laneGapMm = 0, breakOverhangMm = 0, detail = false, lowerStairCellBounds = [] } = opts;
  const clips = new Map();

  for (const entry of installEntries) {
    const { stair, bounds, riser, spans } = entry;
    if (!bounds || ![bounds.x1, bounds.y1, bounds.x2, bounds.y2].every(Number.isFinite)) continue;
    if (bounds.x2 <= bounds.x1 || bounds.y2 <= bounds.y1) continue;

    const beyond = cellsBeyondBreak(stair, graph, riser);
    if (beyond.size === 0) continue;

    const beyondBoundsList = cellBoundsList(beyond, graph);
    if (beyondBoundsList.length === 0) continue;

    // 中間階ガード: 破れ線先セルの中心が下階階段の見下げ矩形内にあれば2a不成立
    // （下階階段の吹抜けであって階段下エリアではない）→ クリップしない。
    const hasLowerStair = beyondBoundsList.some(bb => {
      const cx = (bb.x1 + bb.x2) / 2, cy = (bb.y1 + bb.y2) / 2;
      return lowerStairCellBounds.some(lb => lb.x1 <= cx && cx <= lb.x2 && lb.y1 <= cy && cy <= lb.y2);
    });
    if (hasLowerStair) continue;

    const rooms = stairUnderRoomsOf(stair, graph, beyond);
    if (rooms.length === 0) continue;

    // keep領域（beyondセルの実矩形をKEEP_MARGIN拡張）。半平面クリップ対象の型のみ、
    // 破れ線弦の beyond側でさらに絞り込む（求まらなければ矩形のまま＝安全側フォールバック）。
    let halfPlane = null;
    if (HALF_PLANE_TYPES.has(stair.type)) {
      const geom = buildStairGeometry(stair, bounds, {
        view: 'install', detail, riser, spans, laneGapMm, breakOverhangMm, graph,
      });
      const pts = breakLineToPoints(geom.breakLine);
      if (pts.length >= 2) {
        const a = pts[0], z = pts[pts.length - 1];
        const dxRaw = z.x - a.x, dyRaw = z.y - a.y;
        const dLen = Math.hypot(dxRaw, dyRaw);
        if (dLen > 0) {
          const d = { x: dxRaw / dLen, y: dyRaw / dLen };
          const sideOf = (p) => Math.sign(d.x * (p.y - a.y) - d.y * (p.x - a.x));
          let cx = 0, cy = 0;
          for (const bb of beyondBoundsList) { cx += (bb.x1 + bb.x2) / 2; cy += (bb.y1 + bb.y2) / 2; }
          cx /= beyondBoundsList.length; cy /= beyondBoundsList.length;
          const beyondSign = sideOf({ x: cx, y: cy });
          if (beyondSign !== 0) halfPlane = { a, d, beyondSign };
        }
      }
    }

    const keepPolys = [];
    for (const bb of beyondBoundsList) {
      const expanded = rectPolygon(expandRect(bb, KEEP_MARGIN));
      const clipped = halfPlane ? clipHalfPlane(expanded, halfPlane.a, halfPlane.d, halfPlane.beyondSign) : expanded;
      if (clipped.length >= 3) keepPolys.push(orient(clipped, true));
    }
    if (keepPolys.length === 0) continue; // 全滅（退化）→ 安全側でクリップしない

    for (const room of rooms) {
      const wallIds = [...room.generatedWallIds];
      if (wallIds.length === 0) continue;
      const walls = wallIds.map(id => graph.shapeMap.get(id)).filter(Boolean);
      if (walls.length === 0) continue;

      let wallsBBox = null;
      for (const w of walls) {
        const r = wallWorldRect(w);
        wallsBBox = wallsBBox ? unionRect(wallsBBox, r) : r;
      }

      const unionBase = unionRect(bounds, wallsBBox);
      const outerRect     = expandRect(unionBase, RECT_MARGIN);
      const footprintHole = expandRect(bounds, RECT_MARGIN);

      const subpaths = [
        orient(rectPolygon(outerRect), true),
        orient(rectPolygon(footprintHole), false),
        ...keepPolys,
      ];

      for (const w of walls) clips.set(w.id, subpaths);
    }
  }

  return clips.size > 0 ? clips : null;
}
