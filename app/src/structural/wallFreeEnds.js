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
import { wallBackingCenterCoord, selfWallSegments } from './wallBeamAxes.js';
import { rulesFor, effectiveStructure } from './structureRules.js';
import { kneeDropRecordForWallSpan } from '../finish/kneeDropWall.js';
import {
  stairPartitionLines, matchStairPartitionLine, partitionDesignRange, PARTITION_BACKING_MM,
} from '../finish/stair/stairPartition.js';

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

const LINE_END_TOL_MM = 0.5;

/**
 * 折返し階段の隔て壁（下地オーナー壁）の両端＝構造柱（90角）の点源（隔て壁 S3'。ユーザー裁定2026-10-07
 * 「回転部の柱は通り芯交点に配置」）。端は踊り場側（レーン間中心線×踊り場前縁CL）・上り口側（レーン間
 * 中心線×上り口辺CL）の2つ。隔て壁は構造の壁ソースから除外してある（wallBeamAxes.js。梁芯CL・通し梁・
 * 階柱寸の柱を湧かさないため）ので、通常の点源（wallRunFreeEnds(selfWallSegments)）には現れない——
 * ここがその端の唯一の点源。柱の生成（woodAutoFill.js）・柱包み（stairPartitionWalls.js）・描画
 * （renderer/wallDrawPlan.js の freeEndPoints）が共有する。
 *
 * 端は壁の設計上の端（clStart/clEnd.effectiveValue。柱包みのはね出しを含まない）で、かつ線（stairPartitionLines）の
 * lo/hi に一致する端だけ（2a の差し引きで切れた端は線の端ではないので除く）。柱包みの前後で同じ結果を返す（冪等）。
 * free＝この端が他の壁と交わらない自由端か。自階の壁（selfWallSegments）に隔て壁自身を加えて
 * wallRunFreeEnds に掛け、その端が結果に出れば true（T字・取り合い＝false。柱は立つが柱包みはしない）。
 * 在来木造（rules.framing）以外は空。
 * @param {object} graph
 * @param {object} [project]
 * @param {ReturnType<import('./wallBeamAxes.js').createWallSourceCache>} [wallSourceCache] - selfWallSegments のmemo（省略可）
 * @param {Array} [selfSegments] - 呼び出し側が計算済みの selfWallSegments（あれば再計算しない）。絞り込み前のものを渡すこと
 * @returns {Array<{isVertical:boolean, coord:number, along:number, x:number, y:number, free:boolean}>}
 */
export function stairPartitionEnds(graph, project, wallSourceCache = undefined, selfSegments = undefined) {
  if (!rulesFor(effectiveStructure(graph, project)).framing) return [];
  const lines = stairPartitionLines(graph);
  if (lines.length === 0) return [];
  const cands = [];
  for (const w of graph.walls) {
    if (w.backingDepth !== PARTITION_BACKING_MM) continue;
    const line = matchStairPartitionLine(w, lines);
    if (!line) continue;
    const { lo, hi } = partitionDesignRange(w);
    if (hi - lo <= 0) continue;
    cands.push({ isVertical: w.isVertical, coord: wallBackingCenterCoord(w), lo, hi, line });
  }
  if (cands.length === 0) return [];
  const partSegs = cands.map(c => ({ isVertical: c.isVertical, coord: c.coord, lo: c.lo, hi: c.hi, designLo: c.lo, designHi: c.hi }));
  const freeEnds = wallRunFreeEnds([...(selfSegments ?? selfWallSegments(graph, wallSourceCache)), ...partSegs]);
  const out = [];
  const seen = new Set();
  for (const c of cands) {
    for (const along of [c.lo, c.hi]) {
      // 線の端との一致は 0.5mm（識別と同じ許容）。WALL_JUNCTION_TOL_MM(150) だと 2a の差し引きの端が線端の近くに来たとき誤って端扱いになる
      if (Math.abs(along - c.line.lo) > LINE_END_TOL_MM && Math.abs(along - c.line.hi) > LINE_END_TOL_MM) continue;
      const x = c.isVertical ? c.coord : along;
      const y = c.isVertical ? along : c.coord;
      const key = `${c.isVertical}:${Math.round(x)}:${Math.round(y)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const free = freeEnds.some(fe => fe.isVertical === c.isVertical
        && Math.abs(fe.coord - c.coord) < WALL_JUNCTION_TOL_MM && Math.abs(fe.along - along) < WALL_JUNCTION_TOL_MM);
      out.push({ isVertical: c.isVertical, coord: c.coord, along, x, y, free });
    }
  }
  return out;
}
