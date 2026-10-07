// 在来木造の腰壁・垂れ壁の自由端に立つ「柱状の壁下地材」（端部材）を導出する純モジュール。
// 設計意図・裁定は .claude/structural-model.md「壁の自由端には柱を立て…」節、
// .claude/plan-wall-region.md「壁の自由端の柱包み」節を参照。
//
// **構造柱は立てない**（リード裁定2026-09-19）: 腰壁の端部材は天井に届かず梁を支えられず、垂れ壁の
// 端部材は床に届かない。構造柱の集合（columnMap）に混ぜると3b（上階柱直下へ通す）・3d（支持点／
// 荷重点）・3h（受梁）・3iの入力に紛れ、存在しない支持を仮定してしまう。ユーザー文面も「柱状の
// **壁下地材**」——ここでは保存せず（新エンティティ・新FBSフィールドを持たない）、壁の描画のたびに
// 導出するだけの値として扱う。
//
// 端部材の点源は2つ（allEndMembers が合流する）:
//   (1) 腰壁・垂れ壁の自由端（kneeDropEndMembers）
//   (2) 折返し階段の隔て壁の両端（stairPartitionEndMembers。90角・壁の区間の内側。構造柱ではない）
//
// core.js/.jsx/store.js/snap.js を静的に引かない。node:test から単体 import 可能に保つ
// （.claude structural-model.md「抽出純モジュールはnode:testから単体import可能に保つ」規律）。
import { rulesFor, effectiveStructure, woodColumnWidthMm } from './structureRules.js';
import { selfWallSegments } from './wallBeamAxes.js';
import { wallRunFreeEnds } from './woodFraming.js';
import { kneeDropWallAtFreeEnd } from './wallFreeEnds.js';
import {
  stairPartitionLines, isStairPartitionWall, PARTITION_BACKING_MM,
} from '../finish/stair/stairPartition.js';

/**
 * 在来木造の腰壁・垂れ壁の自由端に立つ端部材を、壁idごとに列挙する。
 *
 * 自由端の判定は全高壁の自由端柱（structural/woodAutoFill.js autoFillWoodColumns の F-1）と
 * **同一の述語**を共有する（wallRunFreeEnds＋selfWallSegments）——構造柱の点源
 * （wallFreeEnds.js selfWallFreeEnds＝腰壁・垂れ壁の辺を除いた自由端）と本関数の点源
 * （腰壁・垂れ壁の辺**だけ**の自由端）は同じ wallRunFreeEnds(segments) の結果を排他的に分けるため、
 * 合わせて全自由端になる（不変条件。wallEndMember.test.js で固定）。
 *
 * widthMm は**階の柱寸**（woodColumnWidthMm。個別柱寸は見ない）——柱と同寸の壁下地材として扱う
 * （リード裁定。下地割付との取り合いは呼び出し側 renderer/wallDrawPlan.js が
 * columnIntervals へこの区間を合流させて行う。本関数はその区間の元になる along/widthMm を返すだけ）。
 *
 * 非在来（rules.framingを持たない主構造）・壁が1本も無い階は空Map。
 * @param {object} graph
 * @param {object} [project]
 * @returns {Map<string, Array<{along:number, widthMm:number, mode:'knee'|'drop', heightMm:number}>>}
 *   壁id → 端部材（along＝壁の長さ方向の中心＝自由端の設計上の端＝CL位置、widthMm＝階の柱寸）
 */
export function kneeDropEndMembers(graph, project) {
  const result = new Map();
  const rules = rulesFor(effectiveStructure(graph, project));
  // 非在来は端部材という概念を持たない。呼び出し側 renderer/wallDrawPlan.js も
  // studLayout==='betweenColumns'（在来木造のみ）でこの関数自体を呼ばないため、このゲートは
  // 実質二重（QA指摘2026-09-19。どちらか一方だけの変異では検出できない——両方を守ること）。
  if (!rules.framing) return result;
  const segments = selfWallSegments(graph);
  if (segments.length === 0) return result; // 壁が無い階は評価しない（woodAutoFill.jsと同じ割り切り）
  const widthMm = woodColumnWidthMm(graph, project);
  if (!Number.isFinite(widthMm)) return result;

  for (const fe of wallRunFreeEnds(segments)) {
    const hit = kneeDropWallAtFreeEnd(graph, fe);
    if (!hit) continue; // 腰壁・垂れ壁の指定が無い自由端＝構造柱側（wallFreeEnds.js selfWallFreeEnds）
    const { wall, rec } = hit;
    const mode = rec.knee ? 'knee' : rec.drop ? 'drop' : null;
    if (!mode) continue; // 安全弁（レコードは通常knee/dropいずれかを持つ）
    const heightMm = mode === 'knee' ? rec.knee.topHeight : rec.drop.bottomHeight;
    const arr = result.get(wall.id) ?? [];
    arr.push({ along: fe.along, widthMm, mode, heightMm });
    result.set(wall.id, arr);
  }
  return result;
}

/**
 * 折返し階段の隔て壁（下地オーナー壁）の両端に立つ90角の端部材を、壁idごとに列挙する。
 *
 * 構造柱ではない（腰壁の端部材と同じ壁下地材。保存せず描画のたびに導出する）。隔て壁は
 * 構造の壁ソースから除外されている（wallBeamAxes.js）ため自由端でなく、柱も立たない——この端部材が
 * 隔て端部の「90角の材」（問題.md）を担う。S5 で階段が上階へ続く層は構造柱へ置き換わる。
 *
 * 幅は階の柱寸ではなく PARTITION_BACKING_MM（90）固定（仕様が90角・下地帯も90）。下地帯
 * [CL−45, CL+45] を埋める。
 * 位置は壁の区間の**内側**（along = lo+45 / hi−45＝下地帯の端90mmを占める）。隔て壁は端CLでちょうど
 * 終わり、柱包みの延長（F-3）も受けない（自由端でないため）ので、端CL中心に置くと踊り場側・取りつき側へ
 * 45mmはみ出す。
 * 区間が180mm未満（2本が重なる）なら出さない。下地の無い薄壁（backingDepth 0）は対象外。
 * 非在来（rules.framing なし）は空Map。
 * @param {object} graph
 * @param {object} [project]
 * @returns {Map<string, Array<{along:number, widthMm:number, mode:'partition', heightMm:null}>>}
 */
export function stairPartitionEndMembers(graph, project) {
  const result = new Map();
  const rules = rulesFor(effectiveStructure(graph, project));
  if (!rules.framing) return result;
  const lines = stairPartitionLines(graph);
  if (lines.length === 0) return result;
  for (const wall of graph.walls) {
    if (wall.backingDepth !== PARTITION_BACKING_MM) continue;
    if (!isStairPartitionWall(wall, lines)) continue;
    const lo = Math.min(wall.coord1, wall.coord2), hi = Math.max(wall.coord1, wall.coord2);
    if (hi - lo < PARTITION_BACKING_MM * 2) continue;
    const half = PARTITION_BACKING_MM / 2;
    result.set(wall.id, [
      { along: lo + half, widthMm: PARTITION_BACKING_MM, mode: 'partition', heightMm: null },
      { along: hi - half, widthMm: PARTITION_BACKING_MM, mode: 'partition', heightMm: null },
    ]);
  }
  return result;
}

/**
 * 全端部材（腰壁・垂れ壁の自由端 ∪ 隔て壁の両端）。呼び出し側（renderer/wallDrawPlan.js）が
 * 1回の呼びで済むよう合流する（壁idは両者で排他: 隔て壁は構造の壁ソース外で腰壁対象外）。
 * @returns {Map<string, Array<{along:number, widthMm:number, mode:string, heightMm:number|null}>>}
 */
export function allEndMembers(graph, project) {
  const result = kneeDropEndMembers(graph, project);
  for (const [id, arr] of stairPartitionEndMembers(graph, project)) result.set(id, [...(result.get(id) ?? []), ...arr]);
  return result;
}
