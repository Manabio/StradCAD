// 在来木造の U 字階段（隔て壁あり）の足元を横切る「孤児の梁芯」の撤去（ユーザー指示 2026-10-12
// 「孤児の梁芯を消す規則を足して。原因『階段を横切る梁を削除しました。』を通知して。」）。
// 経緯: 旧実装（9ee8a64）が下階の階段の破れ先に作った小梁の梁芯CL（踊り場前縁の線・隔て壁の線。
// discipline:'fuse'）は、小梁が生成されなくなった後も「CLは残す」規律で保存済み文書に孤児として残り、
// 隔て壁端の柱・規則2の柱・壁線梁の端・隔て梁の軸のアンカーになり続ける。ここはその型だけを撤去する唯一の例外。
// 判定は幾何と事実だけ——由来（beamAxisOrigin）は読まない（由来は表示用の不変条件）。
// 設計意図は .claude/structural-model.md「階段を横切る孤児の梁芯の撤去」参照。
import { CenterLineType } from '../core.js';
import { CL_OVERLAP_TOL_MM } from '../core/constants.js';
import { exclusionKeyReferencesCL } from '../core/structuralEntities.js';
import { beamAxisCenterLines } from '../core/centerLineKindPolicy.js';
import { effectiveStructure, rulesFor } from './structureRules.js';
import { unprotectedAmong } from './wallBeamAxes.js';
import { stairHasPartition, stairLandingFrontLine, stairPartitionGeometry } from '../finish/stair/stairPartition.js';
import { roomBounds } from '../finish/gridCells.js';

/** 通知の文言（件数・階名は付けない。structuralOrchestration.js が onToast へ渡す）。 */
export const STAIR_CROSSING_REMOVED_MESSAGE = '階段を横切る梁を削除しました。';

/**
 * 撤去の対象になりうる「下階の階段が自階に作る足元」を列挙する。自階の階段の footprint は対象にしない
 * （自階の床梁の梁芯が候補になり、ユーザーが消した床梁を巻き込むため）。
 * 各要素は外接矩形 rect と、その階段の踊り場前縁の線・隔て壁の線（梁芯としての向き isVertical と座標 coord）。
 * 線は下階の階段を下階の graph で解いて写す。在来木造（rules.framing）以外・屋根専用平面・下階無しは空。
 * @returns {Array<{rect:{x1:number,y1:number,x2:number,y2:number}, lines:Array<{isVertical:boolean, coord:number}>}>}
 */
function belowStairTargets(graph, project, belowGraph) {
  if (!belowGraph || graph.plane.isRoofPlane) return [];
  if (!rulesFor(effectiveStructure(graph, project)).framing) return [];
  const belowStructure = effectiveStructure(belowGraph, project);
  const out = [];
  for (const stair of belowGraph.stairs) {
    if (!stairHasPartition(stair, belowGraph, belowStructure)) continue;
    const rect = roomBounds(stair.cells, belowGraph);
    if (![rect.x1, rect.y1, rect.x2, rect.y2].every(Number.isFinite)) continue;
    const lines = [];
    // 踊り場前縁は走行軸に直交する線＝梁芯の向きは走行軸と逆（stairLandingFrontLine.isVertical は走行軸が縦か）。
    const front = stairLandingFrontLine(stair, belowGraph);
    if (front) lines.push({ isVertical: !front.isVertical, coord: front.along });
    // 隔て壁の線は走行軸に平行＝梁芯の向きは走行軸と同じ。
    const part = stairPartitionGeometry(stair, belowGraph);
    if (part) lines.push({ isVertical: part.isVertical, coord: part.axisValue });
    out.push({ rect, lines });
  }
  return out;
}

/** 梁芯 cl の位置・区間が矩形 r の内部を通るか（軸座標は縁を含む。区間は重なりが正）。 */
function crossesRect(cl, r) {
  const vertical = cl.centerLineType === CenterLineType.VERTICAL;
  const c = cl.effectiveValue;
  const [aLo, aHi, sLo, sHi] = vertical ? [r.x1, r.x2, r.y1, r.y2] : [r.y1, r.y2, r.x1, r.x2];
  if (c < aLo - CL_OVERLAP_TOL_MM || c > aHi + CL_OVERLAP_TOL_MM) return false;
  const lo = cl.extentLo ?? -Infinity, hi = cl.extentHi ?? Infinity;
  return Math.min(hi, sHi) - Math.max(lo, sLo) > CL_OVERLAP_TOL_MM;
}

/**
 * 階段を横切る孤児の梁芯CLを撤去する（graph.removeCenterLine。依存の柱・梁は teardown で道連れ。次の
 * sweep で残った柱・梁が中心線へ再アンカーされる）。撤去する梁芯は次の全てを満たすもの:
 *   (a) 梁芯CL（beamAxisCenterLines＝discipline:'fuse'。通り芯・中心線・補助線は対象外）
 *   (b) 軸上に梁（graph.beams の axisCL）が 1 本も無い
 *   (c) 下階の隔て壁あり階段が自階に作る足元（破れ先／STAIR_VOID）の内部を通り、かつ座標がその階段の
 *       踊り場前縁の線または隔て壁の線に一致する（旧実装の小梁が作った型だけ。足元の内部を通る他の梁芯、
 *       自階の階段の足元は対象外＝自階の床梁の梁芯を巻き込まない）
 *   (d) isProtectedWallBeamAxis が偽（手動固定・参照・偏芯・耐力壁・スリーブがあれば守る。候補どうしの
 *       extent 参照は保護理由にしない＝unprotectedAmong）
 *   (e) 現況の生成源（wallSources・openingSources）の座標・向きに一致しない（防御。壁・開口が今も根拠を持つ
 *       梁芯を消すと、同じ再計算の生成段が作り直して「生成→撤去」が往復しうるため。実データ・本番経路では
 *       (b) の梁ありで先に弾かれ、(e) だけが効く構成は作れていない＝REASONED）
 *   (f) 除外集合（excludedColumnSlots／excludedBeamSlots／excludedFootingSlots）のキーがこの梁芯の id を
 *       参照していない——ユーザーが消した床梁・柱の記録はキーに梁芯 id を含み、梁芯を撤去すると（teardown が
 *       キーを掃除し、再生成の梁芯は別 id になるため）除外が失効して床梁が復活する。
 * 除外集合（excludedWallBeamAxes）には記録しない（可逆）。
 * @param {object} graph
 * @param {object} project
 * @param {object|null} belowGraph 1つ下の実体階（無ければ null）
 * @param {Array<{isVertical:boolean, coord:number}>} [generatedSources] 現況の壁由来・開口由来の梁芯生成源
 * @returns {import('../core.js').CenterLine[]} 撤去した梁芯CL
 */
export function removeStairCrossingOrphanBeamAxes(graph, project, belowGraph, generatedSources = []) {
  const targets = belowStairTargets(graph, project, belowGraph);
  if (targets.length === 0) return [];
  const beamAxisIds = new Set(graph.beams.map(b => b.axisCL.id));
  const excludedKeys = [...graph.excludedBeamSlots, ...graph.excludedColumnSlots, ...graph.excludedFootingSlots];
  const candidates = beamAxisCenterLines(graph).filter(cl => {
    if (cl.centerLineType !== CenterLineType.VERTICAL && cl.centerLineType !== CenterLineType.HORIZONTAL) return false;
    if (beamAxisIds.has(cl.id)) return false;
    const isVertical = cl.centerLineType === CenterLineType.VERTICAL;
    const coord = cl.effectiveValue;
    if (generatedSources.some(s => s.isVertical === isVertical && Math.abs(s.coord - coord) < CL_OVERLAP_TOL_MM)) return false;
    if (excludedKeys.some(k => exclusionKeyReferencesCL(k, cl.id))) return false;
    return targets.some(t =>
      t.lines.some(l => l.isVertical === isVertical && Math.abs(l.coord - coord) < CL_OVERLAP_TOL_MM)
      && crossesRect(cl, t.rect));
  });
  const toRemove = unprotectedAmong(graph, candidates);
  for (const cl of toRemove) graph.removeCenterLine(cl.id);
  return toRemove;
}
