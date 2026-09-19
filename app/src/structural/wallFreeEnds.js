// 在来木造の壁の自由端（wallRunFreeEnds由来）が「腰壁・垂れ壁の指定がある辺」の端かどうかを判定する
// 共有述語。もとは woodAutoFill.js の非公開関数だったが、腰壁・垂れ壁の端部材（wallEndMember.js）が
// 同じ述語を必要とする（構造柱の点源＝この述語で false の自由端／端部材の点源＝true の自由端、で
// 全自由端を排他的に分ける不変条件のため）ため、二系統を作らず1箇所へ切り出した
// （.claude/team-lessons「add new → migrate callers → delete old」）。
//
// woodFraming.js（core.js非依存の純モジュール。woodColumnOffset.js等が依存する）へは置かない——
// finish/kneeDropWall.js 経由で core.js への依存が生じ、woodFraming.js の依存先を頼る他の純モジュール
// （woodColumnOffset.js）まで巻き込むため。ここは wallBeamAxes.js と同格（core.js依存を許すが
// store.js/snap.js/.jsxは静的に引かない）の層に置く。
import { wallRunFreeEnds, WALL_JUNCTION_TOL_MM } from './woodFraming.js';
import { wallBackingCenterCoord } from './wallBeamAxes.js';
import { kneeDropRecordForWallSpan } from '../finish/kneeDropWall.js';

/**
 * 自由端 fe が乗る下地オーナー壁と、その壁のスパンに掛かる腰壁・垂れ壁レコードを解決する。
 * 自由端fe自身は座標だけの点（graph非依存の純関数の出力）なので、その座標に一致する下地オーナー壁を
 * 実際にgraph.wallsから探し直し、そのスパンに腰壁・垂れ壁レコードがあるか
 * （kneeDropRecordForWallSpan。finish/kneeDropWall.js「1本の壁」に対応するレコードの唯一の解決先）を
 * 見る。該当壁が無ければnull（自由端ではあるが判定対象の壁が見つからない＝腰壁指定なしと同じ扱い。
 * 例外を投げない）。
 * @param {object} graph
 * @param {{isVertical:boolean, coord:number, along:number}} fe - wallRunFreeEnds の1要素
 * @returns {{wall:object, rec:object}|null} rec は kneeDropRecordForWallSpan の戻り値の rec（生レコード）
 */
export function kneeDropWallAtFreeEnd(graph, fe) {
  for (const w of graph.walls) {
    if (w.isVertical !== fe.isVertical || w.backingRange == null) continue;
    if (Math.abs(wallBackingCenterCoord(w) - fe.coord) > WALL_JUNCTION_TOL_MM) continue;
    const wLo = Math.min(w.coord1, w.coord2), wHi = Math.max(w.coord1, w.coord2);
    if (Math.abs(wLo - fe.along) > WALL_JUNCTION_TOL_MM && Math.abs(wHi - fe.along) > WALL_JUNCTION_TOL_MM) continue;
    const hit = kneeDropRecordForWallSpan(graph, w.axisCL, wLo, wHi);
    if (hit) return { wall: w, rec: hit.rec };
  }
  return null;
}

/**
 * 自由端feが「腰壁・垂れ壁の指定がある辺」の端か（F-1・2026-09-19裁定「腰壁・垂れ壁の指定がある辺の
 * 自由端は対象外——別ステップで端部材として扱う」）。
 * @param {object} graph
 * @param {{isVertical:boolean, coord:number, along:number}} fe
 * @returns {boolean}
 */
export function isKneeDropFreeEnd(graph, fe) {
  return kneeDropWallAtFreeEnd(graph, fe) != null;
}

/**
 * 自階の下地オーナー壁runの自由端（腰壁・垂れ壁の辺を除く）。柱（F-1・woodAutoFill.js
 * autoFillWoodColumns）・通し梁/土台のrun延長（F-2・wallLineThroughRunsのfreeEnds引数）が共有する
 * 単一の点源。腰壁・垂れ壁の辺の自由端（isKneeDropFreeEndがtrue）は端部材の点源
 * （structural/wallEndMember.js kneeDropEndMembers）に譲る——両者は同じ wallRunFreeEnds(segments) を
 * 排他的に分けるため、合わせて全自由端になる（不変条件。wallEndMember.test.js で固定）。
 * **この不変条件は在来木造の呼び出し文脈でのみ成立する**（QA指摘2026-09-19）: 本関数自体は
 * 主構造を見ずに腰壁・垂れ壁指定の自由端を除くため、非在来グラフへ直接呼べば
 * kneeDropEndMembers（非在来はrules.framing無しで空Map）との間に漏れが生じる——実害は無い
 * （実際の呼び出し元 structural/woodAutoFill.js・renderer/wallDrawPlan.js はどちらも在来木造の
 * ときだけ本関数・kneeDropEndMembersを呼ぶため）。
 * @param {object} graph
 * @param {Array<{isVertical:boolean, coord:number, lo:number, hi:number}>} segments
 * @returns {Array<{isVertical:boolean, coord:number, along:number, x:number, y:number}>}
 */
export function selfWallFreeEnds(graph, segments) {
  return wallRunFreeEnds(segments).filter(fe => !isKneeDropFreeEnd(graph, fe));
}
