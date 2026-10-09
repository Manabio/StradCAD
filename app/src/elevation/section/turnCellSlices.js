/**
 * 2.5D断面エンジン: 回り階段（WINDING）の回転部を、平面の段の多角形（stairTreadFootprints の扇形セル）を
 * 切断線で切った Landing（段付きの踊り場の1枚）として返す純モジュール
 * （ユーザー裁定2026-10-09「展開図の階段位置を平面に揃える」S2b。旧: 回転部を奥行き方向に等分した短冊で近似していた）。
 *
 * 切断線ごとに、多角形と直線の交わりを偶奇規則（半開区間）で区間にする:
 *   - 走行方向に縦に切る線（レーン線。cutLine.isVertical === 階段の走行軸の向き）… 線上の走行方向の区間
 *     → {runLo, runHi, acrossLo=acrossHi=線の位置}
 *   - 走行方向を横切る線（seq1/seq3）… 線上の幅方向の区間 → {runLo=runHi=線の位置, acrossLo, acrossHi}
 * 隣り合う扇形セルは放射線を共有するので、レーン線との交点は一致し、段の蹴上は landingStepRisers が
 * 縁を共有する2枚として拾う。
 * 線が多角形の辺にちょうど重なるとき（seq1 の frontA が 5|6 の放射線に乗る等）は回転部の奥（+t）側のセルを採る
 * （fwd＝+t の世界座標の符号。半開区間の下端側を含む）。
 *
 * 純モジュール（node:test から単体 import 可能。store.js/snap.js/.jsx を静的に引かない）。
 * @module
 */
import { GAP_EPS_MM } from '../elevationStyle.js';

// 切断線が多角形の辺（頂点）に乗っているとみなす幅(mm)。sectionStair.js の STAIR_RUN_TOL_MM と同値（循環 import を避けて別定義）。
const EDGE_SNAP_MM = 0.5;

/**
 * @typedef {{poly:number[], z:number, number:number}} TurnCell 平面の段の多角形（[x0,y0,x1,y1,…]）・天端高さ・段数字
 * @typedef {{runLo:number, runHi:number, acrossLo:number, acrossHi:number, z:number,
 *   isVertical:boolean, turnStep:number, frame:{edges:never[]}}} TurnCellSlice
 */

/**
 * 回転部の多角形を切断線で切った Landing の列。入力が不正・非有限・交わりなしなら [] （例外を投げない）。
 * @param {TurnCell[]} turnCells
 * @param {{isVertical:boolean, axisValue:number}} cutLine
 * @param {boolean} isVertical 階段の走行軸の向き（true＝走行方向が y）
 * @param {1|-1} [fwd] 回転部の奥（+t）の走行軸上の世界座標の符号。省略は +1
 * @returns {TurnCellSlice[]}
 */
export function sliceTurnCells(turnCells, cutLine, isVertical, fwd = 1) {
  if (!Array.isArray(turnCells) || !cutLine || !Number.isFinite(cutLine.axisValue)) return [];
  if (typeof cutLine.isVertical !== 'boolean' || typeof isVertical !== 'boolean') return [];
  const sgn = fwd < 0 ? -1 : 1;
  const lengthwise = cutLine.isVertical === isVertical;
  const v = cutLine.axisValue;
  const out = [];
  // 線の位置 v の座標軸（lengthwise＝幅方向 a・横切る＝走行軸 r）と、線上の座標（もう一方）
  const key = lengthwise ? 'a' : 'r', other = lengthwise ? 'r' : 'a';
  // 半開区間の向き: 走行軸の座標は fwd 倍して、奥（+t）側を下端に含む。幅方向は向きを持たない（+1）
  const ks = lengthwise ? 1 : sgn;
  // 多角形の座標を（走行軸 r・幅方向 a）へ。縦走行は r=y・a=x、横走行は r=x・a=y
  const prepared = [];
  for (const cell of turnCells) {
    const poly = cell?.poly;
    if (!Array.isArray(poly) || poly.length < 6 || poly.length % 2 !== 0 || !poly.every(Number.isFinite) || !Number.isFinite(cell.z)) continue;
    const pts = [];
    for (let i = 0; i < poly.length; i += 2) pts.push(isVertical ? { r: poly[i + 1], a: poly[i] } : { r: poly[i], a: poly[i + 1] });
    prepared.push({ cell, pts });
  }
  // 線が多角形の頂点（辺の端）から EDGE_SNAP_MM 以内なら、その座標ちょうどに乗っているものとして扱う
  // （frontA のような境界の ±1e-3 の揺れで、含む/含まないが反転しない。STAIR_RUN_TOL_MM と同じ考え方）。
  // 寄せ先は**全セルの全頂点から1回だけ**（最も近いもの）決め、全セルで共有する。セルごとに決めると、
  // 一部のセルにしかない頂点（外壁面上の頂点など）の近くで隣り合うセルが別の座標で切られ、縁の共有が崩れる。
  let P = ks * v;
  let best = Infinity;
  for (const { pts } of prepared) {
    for (const pt of pts) {
      const d = Math.abs(ks * pt[key] - ks * v);
      if (d <= EDGE_SNAP_MM && d < best) { best = d; P = ks * pt[key]; }
    }
  }
  for (const { cell, pts } of prepared) {
    const xs = [];
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i], q = pts[(i + 1) % pts.length];
      const pk = ks * p[key], qk = ks * q[key];
      if (!((pk <= P && P < qk) || (qk <= P && P < pk))) continue;
      xs.push(p[other] + (q[other] - p[other]) * (P - pk) / (qk - pk));
    }
    xs.sort((m, n) => m - n);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const lo = xs[i], hi = xs[i + 1];
      if (!(hi - lo > GAP_EPS_MM)) continue;
      out.push(lengthwise
        ? { runLo: lo, runHi: hi, acrossLo: v, acrossHi: v, z: cell.z, isVertical, turnStep: cell.number, frame: { edges: [] } }
        : { runLo: v, runHi: v, acrossLo: lo, acrossHi: hi, z: cell.z, isVertical, turnStep: cell.number, frame: { edges: [] } });
    }
  }
  return out;
}
