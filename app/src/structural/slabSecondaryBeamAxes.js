// ================================================================
// S造スラブを支える子梁（小梁）の梁芯の割付け（ユーザー指示2026-10-26「スパン間を2500mm以下等間隔に
// 割り付ける」）。大梁（と開口辺の小梁）で4辺囲まれたベイ（framingCells.js beamGridCells）の短辺が
// 最大ピッチを超えるとき、長辺方向にフランジ間（あき）が等しくなるよう割り付けて梁芯CL（beamAxisOrigin:SLAB_BEAM）を生成する。子梁そのものは
// 既存の小梁生成（structuralAutoFill.js autoFillSecondaryBeams）が梁芯から作る。
// 座標は「フランジ間（あき）が等しい」位置（ユーザー指示2026-10-28。framingCells.js clearGapDivisionCoords。
// 梁幅は断面カタログから引き、材寸が変わるたびの再計算で追従する）。分割数 n は従来どおり。
// 在来木造の床梁（woodAutoFill.js autoFillWoodFloorBeams）は従来の等分（framingCells.js divideBayEqually）のまま。
//
// 再計算のたびに現況のベイへ割り直す（reconcileSlabSecondaryBeamAxes）。由来 SLAB_BEAM は「未編集の自動梁芯」の
// 印——子梁の固定・削除などの手が入った梁芯は USER へ替え、そのベイの枠を除外集合へ記録して以後は動かさない。
//
// react/konva/store/.jsx を静的に引かない（node:test から単体 import 可能）。
// 個別の削除・移動の記録は slabBeamSlotKeyFor（centerLineOps.js が呼ぶ）。移動の障害物は
// core/centerLineKindPolicy.js isSameDirectionObstacle（梁芯どうしは extent が重なるときだけ・通り芯は SLAB_BEAM を止めない）。
// ================================================================
import { CenterLineType, Discipline } from '../core.js';
import { BeamRole, CL_OVERLAP_TOL_MM, SlabBayFillSkip, SlabSecondaryBeamPlacement, SLAB_BEAM_SLOT_KEY_PREFIX, SLAB_BEAM_WIDTH_FALLBACK_SECTION_ID } from '../core/constants.js';
import { BeamAxisOrigin } from '../core/centerLine.js';
import { beamAxisCenterLines } from '../core/centerLineKindPolicy.js';
import { findHostBeam, exclusionKeyReferencesCL, PIN_ROLES } from '../core/structuralEntities.js';
import { bayGeometry, beamGridCells, divideBayEqually, clearGapDivisionCoords } from './framingCells.js';
import { findSectionEntry } from './sectionCatalog.js';
import { isProtectedWallBeamAxis, wallBeamAxisExcludeKey } from './wallBeamAxes.js';
import { rulesFor, effectiveStructure } from './structureRules.js';
import { isGroupDrivenMember } from './memberGroups.js';

// スラブ小梁の枠キー（PlanGraph.excludedSlabBeamSlots の要素）。ベイを4辺のCL id で同定し（座標ではない——
// 座標キーの excludedWallBeamAxes とは別の集合）、そのベイの n 等分のうち i 番目（1始まり。内部の n-1 本）の
// 枠を表す。`slab:<x1辺>:<x2辺>:<y1辺>:<y2辺>:<'X'|'Y'>:<n>:<i>`。x1/x2＝ベイの左右（x小・x大）の辺のCL id、
// y1/y2＝上下（y小・y大）。dir は割り付けた梁芯の向き（CenterLineType の VERTICAL='X'／HORIZONTAL='Y'）。
// CL id は素の uuid（`:` を含まない）なので、exclusionKeyReferencesCL（`:` 区切り照合）がそのまま使える。
// この集合を読む処理は reconcileSlabSecondaryBeamAxes（割り直し）、書く処理は同関数の正規化（S2b）と
// 削除・移動の記録（S2c）。

/**
 * @param {{x1Id:string, x2Id:string, y1Id:string, y2Id:string, dir:string, n:number, i:number}} slot
 * @returns {string}
 */
export function slabBeamSlotKey({ x1Id, x2Id, y1Id, y2Id, dir, n, i }) {
  return [SLAB_BEAM_SLOT_KEY_PREFIX, x1Id, x2Id, y1Id, y2Id, dir, n, i].join(':');
}

/**
 * slabBeamSlotKey の逆。壊れたキー（項数違い・空の id・別名前空間・dir が X/Y 以外・n/i が整数でない・
 * n<2・i が 1..n-1 の外）は null。最後に slabBeamSlotKey で組み直して元と一致することを確かめる
 * （余分な項・欠けた項・'01' のような非正規表記を弾く）。
 * @param {string} key
 * @returns {{x1Id:string, x2Id:string, y1Id:string, y2Id:string, dir:string, n:number, i:number}|null}
 */
export function parseSlabBeamSlotKey(key) {
  if (typeof key !== 'string') return null;
  const [prefix, x1Id, x2Id, y1Id, y2Id, dir, nStr, iStr] = key.split(':');
  if (prefix !== SLAB_BEAM_SLOT_KEY_PREFIX) return null;
  if (![x1Id, x2Id, y1Id, y2Id].every(id => id)) return null;
  if (dir !== CenterLineType.VERTICAL && dir !== CenterLineType.HORIZONTAL) return null;
  const n = Number(nStr), i = Number(iStr);
  if (!Number.isInteger(n) || !Number.isInteger(i) || n < 2 || i < 1 || i > n - 1) return null;
  const slot = { x1Id, x2Id, y1Id, y2Id, dir, n, i };
  return slabBeamSlotKey(slot) === key ? slot : null;
}

/**
 * 境界線 lines（大梁・開口辺の小梁）で囲まれた各ベイの割付けを純粋に計画する（graph を受けない）。
 * 開口との重なり・短辺の判定だけを行い、端の受け梁（NO_HOST）・既存梁芯（OCCUPIED）の判定は graph が要るため
 * reconcileSlabSecondaryBeamAxes 側。開口判定を短辺判定より先に行う（開口自身のベイは OPENING と報告する）。
 * coords は分割数 n を決めるための等分の暫定値。実際の座標は reconcile が梁幅を見て bayTargetCoords で決める。
 * @param {Array<{isVertical:boolean, coord:number, lo:number, hi:number}>} lines
 * @param {Array<{x1:number, x2:number, y1:number, y2:number}>} openingRects 床開口の矩形
 * @param {number} maxPitchMm
 * @returns {Array<{cell:object, isVertical:boolean, coords:number[], shortLo:number, shortHi:number}|{cell:object, skip:string}>}
 */
export function planSlabSecondaryBeamAxes(lines, openingRects, maxPitchMm) {
  return beamGridCells(lines).map((cell) => {
    // セル内部と面積で重なる開口（辺で接するだけは重ならない）。
    const overlapsOpening = openingRects.some(r =>
      Math.min(cell.x2, r.x2) - Math.max(cell.x1, r.x1) > CL_OVERLAP_TOL_MM &&
      Math.min(cell.y2, r.y2) - Math.max(cell.y1, r.y1) > CL_OVERLAP_TOL_MM);
    if (overlapsOpening) return { cell, skip: SlabBayFillSkip.OPENING };
    const division = divideBayEqually(cell, maxPitchMm);
    if (!division) return { cell, skip: SlabBayFillSkip.SHORT_SPAN };
    const { isVertical, coords, shortLo, shortHi } = division;
    return { cell, isVertical, coords, shortLo, shortHi };
  });
}

// ベイ内部にある、境界を作っていない梁芯（全由来）。長辺方向は両端 tol を除いた開区間、
// 梁芯の走る方向は extent（null は無限）との重なり > tol。梁芯の向きは問わない（直交する梁芯も子梁と交差する）。
function beamAxesInBay(graph, cell, boundaryAxisIds) {
  return beamAxisCenterLines(graph).filter((cl) => {
    if (boundaryAxisIds.has(cl.id)) return false;
    const isVertical = cl.centerLineType === CenterLineType.VERTICAL;
    if (!isVertical && cl.centerLineType !== CenterLineType.HORIZONTAL) return false;
    const [across1, across2, along1, along2] = isVertical
      ? [cell.x1, cell.x2, cell.y1, cell.y2] : [cell.y1, cell.y2, cell.x1, cell.x2];
    const v = cl.effectiveValue;
    if (!(v > across1 + CL_OVERLAP_TOL_MM && v < across2 - CL_OVERLAP_TOL_MM)) return false;
    const lo = cl.extentLo ?? -Infinity, hi = cl.extentHi ?? Infinity;
    return Math.min(hi, along2) - Math.max(lo, along1) > CL_OVERLAP_TOL_MM;
  });
}

// ベイの1辺（isVertical・coord・[lo,hi]）を作る境界線の軸CL id。複数あれば通り芯を優先し、同種の中では
// id の辞書順で最小（再計算のたびに同じ id になる）。覆う線が無ければ null。
function edgeAxisId(lines, gridIds, isVertical, coord, lo, hi) {
  const ids = [...new Set(lines
    .filter(l => l.isVertical === isVertical && Math.abs(l.coord - coord) <= CL_OVERLAP_TOL_MM &&
      Math.min(l.hi, hi) - Math.max(l.lo, lo) > CL_OVERLAP_TOL_MM)
    .map(l => l.id))].sort();
  return ids.find(id => gridIds.has(id)) ?? ids[0] ?? null;
}

// 手が入った梁芯か（SLAB_BEAM の印が嘘になっている）: 固定・算出済みの子梁・スリーブ・偏芯・参照など保護対象
// （isProtectedWallBeamAxis）、または除外集合（削除した子梁・柱・基礎の記録）が id を参照している。
// 除外キーが参照する梁芯を撤去すると別 id の梁芯で復活する（team-lessons 2026-10-12）ため、撤去対象から外す根拠にもなる。
function isEditedSlabAxis(graph, project, cl, defaultBeamSection) {
  if (isProtectedWallBeamAxis(graph, cl)) return true;
  if (graph.beams.some(b => b.axisCL.id === cl.id && isEditedChildBeam(graph, project, b, defaultBeamSection))) return true;
  return [graph.excludedBeamSlots, graph.excludedColumnSlots, graph.excludedFootingSlots]
    .some(set => [...set].some(key => exclusionKeyReferencesCL(key, cl.id)));
}

// 子梁が自動生成の既定と違うフィールドを持つか（＝利用者が編集した）。固定・算出済み（dimensionStatus）は
// 寸法の手動書換えでだけ遷移し、分類変更（断面・接合）や番号の分割・統合は遷移させない
// （MemberListTab.jsx の注記）ため、それらを直接見る。既定は StructuralBeam のコンストラクタと autoFillSecondaryBeams が決める:
//   sectionDefId=主構造ルールの既定の梁断面・jointType=role の PIN_ROLES で決まる既定（小梁は PIN）・jointCondition=剛/剛・
//   levelOffset/startLevelOffset/endLevelOffset=0・beamWidth/beamDepth=null（S造の小梁は自動算定の対象外）・numberGroupId=null（明示グループ）。
// 見ないもの: eccentricity は autoFillBeamEccentricity が faceGap から毎回算出する派生値（編集の根拠は faceGap の方）、
// memberNo は採番が毎回振る値（手動タグは台帳＝numberGroupId 側）、materialType は convertMembersToEffectiveMaterial が揃える。
// 台帳の加入（grp.join）経由で自動に付いた numberGroupId と、それで conform される材寸（beamMap の署名フィールド＝
// sectionDefId・beamWidth・beamDepth）は編集とみなさない（毎回の再計算の conformToLedger が自動の部材にも書くため。
// その部材だけの個別編集は、加入を持たない孤立グループ＝個別採番か、署名フィールド以外の値）。
function isEditedChildBeam(graph, project, beam, defaultBeamSection) {
  const defaultJoint = PIN_ROLES.has(beam.role) ? 'PIN' : 'RIGID';
  const groupDriven = isGroupDrivenMember(project.memberGroupLedger, beam, 'beamMap',
    rulesFor(effectiveStructure(graph, project)), graph.plane.id);
  return beam.dimensionStatus !== 'auto' ||
    (!groupDriven && (beam.numberGroupId != null || beam.sectionDefId !== defaultBeamSection ||
      beam.beamWidth != null || beam.beamDepth != null)) ||
    beam.jointType !== defaultJoint ||
    beam.jointCondition?.start !== 'RIGID' || beam.jointCondition?.end !== 'RIGID' ||
    beam.faceGap !== 0 || beam.levelOffset !== 0 || beam.startLevelOffset !== 0 || beam.endLevelOffset !== 0;
}

// 梁芯 cl が属するベイ。所属は値ではなく、向きと端の通り芯（extent の参照先 id）で決める——ベイが縮んで梁芯が
// 長辺方向の範囲の外に出ても、同じ梁芯のまま張り直して id を保つため（undo/redo・通り芯の往復で id が変わらない）。
// 参照が無い（静的 extent の）梁芯は端の座標で照合する。同じ端の通り芯を共有するベイが長辺方向に複数あるときは、
// 長辺方向の範囲に最も近い（範囲内なら 0）ベイ。どのベイにも合わなければ null（孤児）。
function ownerBay(bays, probe) {
  const near = (b) => Math.max(b.geom.longLo - probe.coord, probe.coord - b.geom.longHi, 0);
  const endsMatch = (b) => {
    if (b.loGrid && b.hiGrid && probe.extentLoRef && probe.extentHiRef) {
      return probe.extentLoRef.clId === b.loGrid.id && probe.extentHiRef.clId === b.hiGrid.id;
    }
    return probe.extentLo != null && probe.extentHi != null &&
      Math.abs(probe.extentLo - b.geom.shortLo) <= CL_OVERLAP_TOL_MM && Math.abs(probe.extentHi - b.geom.shortHi) <= CL_OVERLAP_TOL_MM;
  };
  let best = null;
  for (const b of bays) {
    if (b.dir !== probe.centerLineType || !endsMatch(b)) continue;
    if (!best || near(b) < near(best)) best = b;
  }
  return best;
}

// このベイの記録済みの枠（除外集合のうち4辺 id と向きが一致するもの）。
function recordedSlots(graph, bay) {
  if (!bay.ids) return [];
  const slots = [];
  for (const key of graph.excludedSlabBeamSlots) {
    const s = parseSlabBeamSlotKey(key);
    if (s && s.dir === bay.dir && s.x1Id === bay.ids.x1Id && s.x2Id === bay.ids.x2Id &&
        s.y1Id === bay.ids.y1Id && s.y2Id === bay.ids.y2Id) slots.push(s);
  }
  return slots;
}

// ベイの分割数。記録があれば記録の n に固定する（ユーザー裁定U1: 削除・移動したことのあるベイは寸法が変わっても
// n 固定で位置だけ追従。ピッチが最大を超えうるのは受容）。無ければ既定（最大ピッチ以下になる最小の等分数）。
// 複数の n が記録されていれば最小（決定的）。
function bayDivisionCount(graph, bay) {
  const slots = recordedSlots(graph, bay);
  return slots.length > 0 ? Math.min(...slots.map(s => s.n)) : bay.plan.coords.length + 1;
}

/**
 * S造のスラブ小梁の梁芯を、ベイごとに等ピッチで生成・割り直しする（structureRules.js slabSecondaryBeams が null の
 * 主構造・基礎伏図・屋根専用平面では呼び出し側が呼ばない／ここで空を返す）。1回の再計算の中で収束する。
 *  - 境界: role primary・landing の大梁、および由来 OPENING の梁芯に乗る小梁（開口辺）。座標は梁芯の
 *    effectiveValue（外周の大梁は偏芯しうる）。USER・SLAB_BEAM 由来の梁芯に乗る小梁は境界にしない
 *    （自分の子梁が次のパスで区画を割らないため）。
 *  - 正規化: 由来 SLAB_BEAM なのに手が入った梁芯（isEditedSlabAxis）は由来を USER へ替え、属するベイの枠
 *    （slabBeamSlotKey。分割数 n・最寄りの i）を excludedSlabBeamSlots へ記録する。以後その梁芯は動かさず、
 *    その枠には作らない。属するベイが無い（孤児）ものは由来だけ替える。
 *  - 所属（ownerBay）: SLAB_BEAM の梁芯がベイに属する＝向きが割付け方向と一致・extent が短辺の両端の通り芯と一致。
 *    同じ端の通り芯を共有するベイが複数あれば値が長辺範囲に最も近いベイ（範囲の外でも属し、張り直して id を保つ）。
 *  - 撤去: どのベイにも属さない孤児、属するベイが割付け対象外（OPENING＝後から吹抜け／SHORT_SPAN／NO_HOST）に
 *    なったもの、目標より余った梁芯。正規化の後なので撤去されるのは未編集のものだけ（子梁・スリーブは teardown で道連れ）。
 *  - 端: 短辺の両端に通り芯があり、各座標でその通り芯上の大梁（primary）が子梁を受けること。無ければ NO_HOST
 *    （端が踊り場受け梁・開口小梁のベイは作らない）。
 *  - 管理中のベイ（属する SLAB_BEAM がある、または枠の記録がある）: 目標の座標（フランジ間が等しい位置の内部
 *    n-1 本＝framingCells.js clearGapDivisionCoords。記録した枠・通り芯と
 *    一致する座標・excludedWallBeamAxes の座標・他の梁芯と一致する座標を除く）と未編集の SLAB_BEAM を値の昇順で
 *    1対1に対応づけ、**同じ id のまま**値を張り直す（子梁の id・番号グループ・除外キーが生き残る）。余りは撤去、
 *    不足は新規作成。手で足した USER 梁芯は分割数を固定せず割り直しも止めない。
 *  - 未管理のベイ: ベイ内に境界でない梁芯が既にあれば丸ごと作らない（OCCUPIED。冪等・手動の梁芯の尊重）。
 *    無ければ全部作る。座標は丸めない。
 * 梁芯の extent は端の通り芯への参照（autoFillSecondaryBeams が host を引く範囲になる）。refId は持たせない。
 * ユーザー裁定U2: 寸法の変化で短辺と長辺が入れ替わると向きが変わり記録（向きを含む）が効かず、全部割り直される
 * （削除したものが戻りうる）。既知の限界として受容。
 * @param {object} graph
 * @param {object} project
 * @param {Array<{x1:number, x2:number, y1:number, y2:number}>} [openingRects] 床開口のセル矩形の集合
 *   （openingBeamAxes.js openingCellRects。矩形フィルタの前の情報＝L字などの非矩形の開口も含む）。省略は開口なし
 * @returns {{created: object[], revalued: object[], removed: object[], normalized: object[],
 *   skipped: Array<{cell:object, reason:string}>}} created=新規の梁芯・revalued=同 id のまま値を張り直した梁芯・
 *   removed=撤去した梁芯・normalized=由来を USER へ替えた梁芯
 */
export function reconcileSlabSecondaryBeamAxes(graph, project, openingRects = undefined) {
  const result = { created: [], revalued: [], removed: [], normalized: [], skipped: [] };
  const built = buildBays(graph, project, openingRects);
  if (!built) return result;
  const { bays, boundaryAxisIds } = built;
  const defaultBeamSection = rulesFor(effectiveStructure(graph, project)).defaultSections.beam;
  const activeBays = bays.filter(b => !b.skip);

  // 正規化（不変条件「由来 SLAB_BEAM ⇔ 未編集の自動梁芯」を保つ）。
  const slabAxes = beamAxisCenterLines(graph).filter(cl => cl.beamAxisOrigin === BeamAxisOrigin.SLAB_BEAM);
  for (const cl of slabAxes) {
    if (!isEditedSlabAxis(graph, project, cl, defaultBeamSection)) continue;
    cl.beamAxisOrigin = BeamAxisOrigin.USER;
    result.normalized.push(cl);
    const bay = ownerBay(bays, axisProbe(cl));
    if (!bay || bay.skip || !bay.ids) continue; // 属するベイが無い・割付け対象外: 記録する枠が無い
    graph.excludedSlabBeamSlots.add(slotKeyIn(graph, bay, cl.effectiveValue));
  }

  // 所属。正規化の後に残った SLAB_BEAM は未編集。属さないものは孤児。
  const staleAxes = [];
  for (const cl of slabAxes.filter(c => c.beamAxisOrigin === BeamAxisOrigin.SLAB_BEAM)) {
    const bay = ownerBay(bays, axisProbe(cl));
    if (bay) bay.owned.push(cl); else staleAxes.push(cl);
  }
  const ownedAll = new Set(bays.flatMap(b => b.owned));

  // 端の受け梁（NO_HOST）。分割数を記録で固定した座標で判定する（S1 は既定の分割数）。
  for (const bay of activeBays) {
    bay.n = bayDivisionCount(graph, bay);
    bay.coords = bayTargetCoords(bay, bay.n);
    const hosted = g => !!g && bay.coords.every(c => findHostBeam(graph.beams, g.id, !bay.geom.isVertical, c));
    if (!hosted(bay.loGrid) || !hosted(bay.hiGrid)) bay.skip = SlabBayFillSkip.NO_HOST;
  }

  // 撤去: 孤児と、割付け対象外になったベイの梁芯。
  const removeAxis = (cl) => { graph.removeCenterLine(cl.id); result.removed.push(cl); };
  staleAxes.forEach(removeAxis);
  for (const bay of bays) {
    if (!bay.skip) continue;
    result.skipped.push({ cell: bay.cell, reason: bay.skip });
    bay.owned.forEach(removeAxis);
  }

  for (const bay of bays.filter(b => !b.skip)) {
    const slots = recordedSlots(graph, bay);
    // 他の梁芯。どのベイかに属する SLAB_BEAM は数えない——別のベイの梁芯がこのベイの中に物理的に残っていても
    // （通り芯の移動で張り直す前）、そのベイの処理で動くので、ここで OCCUPIED にしたり目標を塞いだりすると
    // 1回の再計算で収束しない。
    const others = beamAxesInBay(graph, bay.cell, boundaryAxisIds).filter(cl => !ownedAll.has(cl));
    if (bay.owned.length === 0 && slots.length === 0 && others.length > 0) {
      result.skipped.push({ cell: bay.cell, reason: SlabBayFillSkip.OCCUPIED });
      continue;
    }
    const recordedIndexes = new Set(slots.filter(s => s.n === bay.n).map(s => s.i));
    const sameDirGrids = bay.geom.isVertical ? graph.gridXs : graph.gridYs;
    const targets = bay.coords
      .map((coord, k) => ({ coord, i: k + 1 }))
      .filter(({ coord, i }) =>
        !recordedIndexes.has(i) &&
        !sameDirGrids.some(g => Math.abs(g.effectiveValue - coord) <= CL_OVERLAP_TOL_MM) && // 通り芯が梁芯を兼ねる
        !graph.excludedWallBeamAxes.has(wallBeamAxisExcludeKey(bay.geom.isVertical, coord)) && // 手動削除の尊重
        !others.some(cl => cl.centerLineType === bay.dir && Math.abs(cl.effectiveValue - coord) <= CL_OVERLAP_TOL_MM)); // 手で足した梁芯
    const owned = [...bay.owned].sort((a, b) => a.value - b.value);
    targets.forEach(({ coord }, k) => {
      const cl = owned[k];
      if (!cl) {
        result.created.push(graph.addCenterLine(bay.dir, coord, {
          labeled: false,
          discipline: Discipline.FUSE,
          extentLoRef: { clId: bay.loGrid.id, offset: 0 },
          extentHiRef: { clId: bay.hiGrid.id, offset: 0 },
          extentLo: null,
          extentHi: null,
          beamAxisOrigin: BeamAxisOrigin.SLAB_BEAM,
        }));
      } else if (Math.abs(cl.value - coord) > CL_OVERLAP_TOL_MM) {
        cl.value = coord; // 絶対座標の梁芯（refId なし）。id を保つので子梁・番号グループ・除外キーが生き残る
        result.revalued.push(cl);
      }
    });
    owned.slice(targets.length).forEach(removeAxis);
  }
  return result;
}

/**
 * 現況のベイ（割付け対象外も含む）を作る。構造が S造の等ピッチ割付け対象でなければ null。
 * reconcileSlabSecondaryBeamAxes と slabBeamSlotKeyFor が共有する唯一のベイ計算。
 * 境界: role primary・landing の大梁、および由来 OPENING の梁芯に乗る小梁（開口辺）。座標は梁芯の effectiveValue。
 * 4辺の軸CL id が決まらないベイ（理論上は無い）は NO_HOST 扱い。
 */
function buildBays(graph, project, openingRects = undefined) {
  const spec = rulesFor(effectiveStructure(graph, project)).slabSecondaryBeams;
  if (!spec || spec.kind !== SlabSecondaryBeamPlacement.EQUAL_PITCH) return null;

  const boundaryBeams = graph.beams.filter(b =>
    b.role === BeamRole.PRIMARY || b.role === BeamRole.LANDING ||
    (b.role === BeamRole.SECONDARY && b.axisCL.beamAxisOrigin === BeamAxisOrigin.OPENING));
  const lines = boundaryBeams.map((b) => {
    const a = b.clStart.effectiveValue, c = b.clEnd.effectiveValue;
    return { isVertical: b.isVertical, coord: b.axisCL.effectiveValue, lo: Math.min(a, c), hi: Math.max(a, c), id: b.axisCL.id };
  });
  const boundaryAxisIds = new Set(boundaryBeams.map(b => b.axisCL.id));
  const gridIds = new Set([...graph.gridXs, ...graph.gridYs].map(g => g.id));

  const bays = planSlabSecondaryBeamAxes(lines, openingRects ?? [], spec.maxPitchMm).map((plan) => {
    const { cell } = plan;
    const geom = bayGeometry(cell);
    const ids = {
      x1Id: edgeAxisId(lines, gridIds, true, cell.x1, cell.y1, cell.y2),
      x2Id: edgeAxisId(lines, gridIds, true, cell.x2, cell.y1, cell.y2),
      y1Id: edgeAxisId(lines, gridIds, false, cell.y1, cell.x1, cell.x2),
      y2Id: edgeAxisId(lines, gridIds, false, cell.y2, cell.x1, cell.x2),
    };
    const complete = Object.values(ids).every(id => id != null);
    // 短辺の両端の通り芯（子梁が架かる先。梁芯の extent が参照する）。
    const crossGrids = geom.isVertical ? graph.gridYs : graph.gridXs;
    const endGrid = v => crossGrids.find(g => Math.abs(g.effectiveValue - v) <= CL_OVERLAP_TOL_MM);
    const dir = geom.isVertical ? CenterLineType.VERTICAL : CenterLineType.HORIZONTAL;
    return {
      cell, geom, plan, ids: complete ? ids : null,
      loGrid: endGrid(geom.shortLo), hiGrid: endGrid(geom.shortHi),
      dir,
      skip: plan.skip ?? (complete ? null : SlabBayFillSkip.NO_HOST),
      owned: [],
      // 面・子梁の幅の計算に要る入力。bayLayout が初めて必要になったときに1ベイ1回だけ計算する（遅延）。
      layoutInput: { graph, project, boundaryBeams, boundaryAxisIds },
      layout: null,
    };
  });
  return { bays, boundaryAxisIds };
}

// 梁の幅（mm）。断面がカタログで引けない（sectionDefId が null・未知キー）ときは
// SLAB_BEAM_WIDTH_FALLBACK_SECTION_ID の幅。末尾の 0 はフォールバック断面すら無いときの保険。
// 描画・偏芯の StructuralBeam.sectionWidth（フォールバック 300）とは別系統。フォールバック 150 はユーザー裁定。
function beamFlangeWidth(beam) {
  return findSectionEntry(beam?.sectionDefId)?.width
    ?? findSectionEntry(SLAB_BEAM_WIDTH_FALLBACK_SECTION_ID)?.width ?? 0;
}

// 梁 b の範囲 [min(clStart,clEnd), max(...)] がベイの短辺 [shortLo, shortHi] と CL_OVERLAP_TOL_MM を超えて重なるか。
function overlapsShortSide(b, geom) {
  const a = b.clStart.effectiveValue, c = b.clEnd.effectiveValue;
  return Math.min(Math.max(a, c), geom.shortHi) - Math.max(Math.min(a, c), geom.shortLo) > CL_OVERLAP_TOL_MM;
}

// ベイの割付けに使う「面」と子梁の幅。bayTargetCoords が初めて必要としたときに1ベイ1回だけ計算して bay.layout に保持する
// （描画の computed や枠キーの計算で無駄に走らせない）。
//  - faceLo/faceHi＝長辺の両端の内側の面。長辺の端（geom.longLo/longHi。通り芯の位置）に軸CLが乗る子梁と平行な
//    境界梁のうち、短辺と重なるものの**実材芯**（axisValue＝通り芯＋柱芯オフセット＋偏芯。外周の大梁は材芯が通り芯の
//    上に無い）から幅/2 だけ内側。柱で分かれた複数ピースは最も内へ出ている面（lo 側は最大・hi 側は最小）。
//    1本も無い（理論上無い）ときは通り芯 ± フォールバック幅/2。
//  - child＝ベイの子梁（SECONDARY）の幅。ベイ内の同向きの梁芯に乗り、範囲が短辺と重なるものの最大。ベイを横切る
//    手動梁芯の隣のベイの区間の小梁は数えない。子梁がまだ無い（初回生成）ときは主構造の既定の梁断面の幅。
//    ベイ内で子梁の幅が混在すれば最大（まれ。リード裁定）。
// 子梁の梁芯は材芯に置く（子梁は柱芯オフセット・偏芯が 0＝axisValue が CL の値と一致）。
function bayLayout(bay) {
  if (bay.layout) return bay.layout;
  const { graph, project, boundaryBeams, boundaryAxisIds } = bay.layoutInput;
  const { geom, cell, dir } = bay;
  const fallbackHalf = beamFlangeWidth(null) / 2;
  const parallelAt = (longCoord) => boundaryBeams.filter(b => b.isVertical === geom.isVertical &&
    Math.abs(b.axisCL.effectiveValue - longCoord) <= CL_OVERLAP_TOL_MM && overlapsShortSide(b, geom));
  const lo = parallelAt(geom.longLo), hi = parallelAt(geom.longHi);
  const faceLo = lo.length > 0 ? Math.max(...lo.map(b => b.axisValue + beamFlangeWidth(b) / 2)) : geom.longLo + fallbackHalf;
  const faceHi = hi.length > 0 ? Math.min(...hi.map(b => b.axisValue - beamFlangeWidth(b) / 2)) : geom.longHi - fallbackHalf;
  const childAxisIds = new Set(beamAxesInBay(graph, cell, boundaryAxisIds)
    .filter(cl => cl.centerLineType === dir).map(cl => cl.id));
  const childWidths = graph.beams
    .filter(b => b.role === BeamRole.SECONDARY && childAxisIds.has(b.axisCL.id) && overlapsShortSide(b, geom))
    .map(beamFlangeWidth);
  const defaultSection = rulesFor(effectiveStructure(graph, project)).defaultSections.beam;
  const child = childWidths.length > 0
    ? Math.max(...childWidths) : beamFlangeWidth({ sectionDefId: defaultSection });
  // 面が逆転する（梁幅が長辺を超える。理論上無い）ときは通り芯どうしの等分へ退化させる（clearGapDivisionCoords は降順を throw）。
  bay.layout = faceHi >= faceLo ? { faceLo, faceHi, child } : { faceLo: geom.longLo, faceHi: geom.longHi, child };
  return bay.layout;
}

// ベイの内部 n-1 本の目標座標（フランジ間が等しい位置の梁芯座標。端の幅は面に織り込み済みなので 0 を渡す）。
function bayTargetCoords(bay, n) {
  const { faceLo, faceHi, child } = bayLayout(bay);
  return clearGapDivisionCoords(faceLo, faceHi, 0, 0, new Array(n - 1).fill(child));
}

// 枠キー: ベイ bay の目標座標（bayTargetCoords）のうち、位置 coord に最も近い i 番目。
function slotKeyIn(graph, bay, coord) {
  const n = bayDivisionCount(graph, bay);
  const coords = bayTargetCoords(bay, n);
  let nearest = 0;
  coords.forEach((c, k) => { if (Math.abs(c - coord) < Math.abs(coords[nearest] - coord)) nearest = k; });
  return slabBeamSlotKey({ ...bay.ids, dir: bay.dir, n, i: nearest + 1 });
}

/**
 * 梁芯（の指定位置）が今の幾何で属するベイの枠キー。属さない・割付け対象外のベイ・S造でない・
 * 由来が SLAB_BEAM でない（FLOOR_BEAM など）なら null。削除・移動の確定（transform/centerLineOps.js）が、
 * 座標キー（excludedWallBeamAxes）の代わりに枠単位で記録するために使う。ベイの計算・所属判定は
 * 割り直し（reconcileSlabSecondaryBeamAxes）と同じ関数。
 * 座標・extent は明示引数で渡す（pendingDelta を含む effectiveValue を暗黙に読まない）。
 * 開口との重なりは見ない（OPENING のベイは割り直しが梁芯を撤去するので、記録が余計に残るだけで無害）。
 * @param {object} graph
 * @param {object} project
 * @param {{beamAxisOrigin:string|null, centerLineType:string, coord:number,
 *   extentLoRef?:object|null, extentHiRef?:object|null, extentLo?:number|null, extentHi?:number|null}} probe
 * @returns {string|null}
 */
export function slabBeamSlotKeyFor(graph, project, probe) {
  if (probe.beamAxisOrigin !== BeamAxisOrigin.SLAB_BEAM) return null;
  const built = buildBays(graph, project);
  if (!built) return null;
  const bay = ownerBay(built.bays, probe);
  if (!bay || bay.skip || !bay.ids) return null;
  return slotKeyIn(graph, bay, probe.coord);
}

/**
 * 手動の梁芯（由来 USER）に近すぎる自動の梁芯（由来 SLAB_BEAM）の id 集合（規則C 案c・S3-3。ユーザー裁定 Q4・R1）。
 * 手動の梁芯を中心線へ吸着して足すと、自動の梁芯とほぼ同じ位置に2本並びうる（Q4: ずれれば両方残る）。
 * 画面で子梁を注意色にするための判定。「近い」＝同じベイ（ownerBay）・同じ向き・梁芯の範囲（extent）が重なり、
 * 距離がそのベイの割付けのピッチ（長辺/分割数）の半分未満。ベイの計算・所属判定は割り直し
 * （reconcileSlabSecondaryBeamAxes）と同じ関数。S造の等ピッチ割付け対象でない構造・SLAB_BEAM や USER が
 * 無い階は空。割付け対象外のベイ（開口・短辺が短い）の梁芯は数えない（割り直しが撤去するため）。
 * 座標は effectiveValue（ドラッグ中の pendingDelta を含む）を読む。
 * @param {object} graph
 * @param {object} project
 * @returns {Set<string>} 近すぎる SLAB_BEAM 梁芯の CL id
 */
export function nearUserSlabAxisIds(graph, project) {
  const result = new Set();
  const axes = beamAxisCenterLines(graph);
  const slabAxes = axes.filter(cl => cl.beamAxisOrigin === BeamAxisOrigin.SLAB_BEAM);
  const userAxes = axes.filter(cl => cl.beamAxisOrigin === BeamAxisOrigin.USER);
  if (slabAxes.length === 0 || userAxes.length === 0) return result; // ベイの計算を避ける早期return
  const built = buildBays(graph, project);
  if (!built) return result;
  for (const slab of slabAxes) {
    const bay = ownerBay(built.bays, axisProbe(slab));
    if (!bay || bay.skip) continue;
    const halfPitch = (bay.geom.longHi - bay.geom.longLo) / bayDivisionCount(graph, bay) / 2;
    // beamAxesInBay が「ベイ内部で、梁芯の走る方向の extent がベイと重なる」ものだけを返す（SLAB_BEAM の extent は
    // ベイの短辺そのもの）。向きは SLAB と同じものだけ。
    const near = beamAxesInBay(graph, bay.cell, built.boundaryAxisIds).some(user =>
      user.beamAxisOrigin === BeamAxisOrigin.USER && user.centerLineType === slab.centerLineType &&
      Math.abs(user.effectiveValue - slab.effectiveValue) < halfPitch);
    if (near) result.add(slab.id);
  }
  return result;
}

// 梁芯 cl の所属判定用の引数（暗黙の getter 読みを 1 か所に集める）。
function axisProbe(cl) {
  return {
    centerLineType: cl.centerLineType, coord: cl.effectiveValue,
    extentLoRef: cl.extentLoRef, extentHiRef: cl.extentHiRef, extentLo: cl.extentLo, extentHi: cl.extentHi,
  };
}
