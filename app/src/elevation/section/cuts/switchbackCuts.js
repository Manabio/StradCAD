/**
 * 2.5D断面エンジン: 折返し階段（SWITCHBACK）の切断定義表（WP-E5・設計書§6.1）。
 * WP-E5bで elevationStairSequence.js から実際に呼ばれるようになった（makeProbeContext→
 * collectCutBreaks→probeColumn→emitColumns/emitOpenGapMarks/stairPrimitivesForCutの
 * content生成経路の起点）。各cutのline/viewSign/dirSignはW(t,s)座標系から独立に導出する
 * （§6.1の式。makeFrame(stair,b)のpt/tOf/sOfをacrossCoordAt/travelCoordAtで包んで使う）。
 *
 * 設計からの逸脱（WP-E5時点の判断を維持。報告に詳細記載）: §4のシグネチャ
 * `switchbackCuts(stair, graph, opts)`（faces引数なし）に対し、本ファイルは`faces`
 * （composeRoomFaces結果）を第2引数として要求する——往路・復路間の壁（2F=upperGraphの
 * レーン境界CL壁）の実壁検出・face記述子（wEntry/wLanding/wOut1/wOut2/midOutFace/
 * midRetFace/outFace5）自体は、既存 elevationStairSequence.js の classifyFaces/findMidWall
 * （実壁面へ隅スナップ済みのcomposeRoomFaces結果に基づく、実機で検証済みのロジック）から
 * 移設してそのまま再利用する形にした（sectionFace.js のfaceFromCutへの一般化は見送り）。
 * cut.line/viewSign/dirSignだけをW(t,s)から独立に再導出し、facesはcuts配列の`face`
 * フィールド（floorSegments/ceilingProfile算出用。エンジンのcontent生成には使わない）を
 * 供給する役割に限定する——二重管理だが、コンテンツ生成（レイキャスト）とfloorSegments算出
 * （壁面ベース）を疎結合に保てる利点がある（WP-E5bリスク3として報告済み）。
 * @module
 */
import { StairType, StructuralMaterialType } from '@core';
import { roomBounds } from '../../../finish/gridCells.js';
import { makeFrame } from '../../../finish/stair/stairGeometry.js';
import { letterOf, DIR_SIGN, perpFaceAt } from '../../elevationFaces.js';
import { kneeDropRecordFor } from '../../elevationFaceList.js';
import { localXOf as localXOfFace } from '../../elevationFigure.js';
import { resolveSwitchbackParams } from '../../elevationStairSection.js';
import { stairContribution } from '../sectionStair.js';

const MID_WALL_TOL_MM = 300; // 壁厚程度の許容差（往路・復路間の壁の実在判定。既存実装と同値）

// ---- elevationStairSequence.js から移設（挙動不変。§9でstairFaceSequence側からは削除する）----

function facePoint(face) {
  const mid = (face.lo + face.hi) / 2;
  return face.isVertical ? { x: face.faceValue, y: mid } : { x: mid, y: face.faceValue };
}

function mergeFaces(list) {
  if (list.length === 0) return null;
  if (list.length === 1) return list[0];
  const lo = Math.min(...list.map(f => f.lo));
  const hi = Math.max(...list.map(f => f.hi));
  const base = list[0];
  return { ...base, lo, hi, run: hi - lo, originWorld: base.dirSign > 0 ? lo : hi };
}

/**
 * faces（composeRoomFacesの結果）を、makeFrameのtOf/sOfで物理的な役割へ分類する
 * （elevationStairSequence.jsから移設。挙動不変）。
 * @returns {{wEntry:object|null, wLanding:object|null, wOut1:object|null, wOut2:object|null}}
 */
export function classifyFaces(faces, f) {
  const buckets = { entry: [], landing: [], out1: [], out2: [] };
  for (const face of faces) {
    if (face.kind === 'step') continue;
    const pt = facePoint(face);
    if (face.isVertical !== f.vertical) {
      const t = f.tOf(pt);
      (Math.abs(t) <= Math.abs(t - 1) ? buckets.entry : buckets.landing).push(face);
    } else {
      const s = f.sOf(pt);
      (Math.abs(s) <= Math.abs(s - 1) ? buckets.out1 : buckets.out2).push(face);
    }
  }
  return {
    wEntry: mergeFaces(buckets.entry), wLanding: mergeFaces(buckets.landing),
    wOut1: mergeFaces(buckets.out1), wOut2: mergeFaces(buckets.out2),
  };
}

/**
 * 往路・復路の間の壁（実在すれば）を返す（elevationStairSequence.jsから移設。挙動不変）。
 * @returns {import('@core').Wall|null}
 */
export function findMidWall(wallGraph, wEntry, wLanding, landingLen, f) {
  if (!wEntry || !wLanding || !wallGraph) return null;
  const midCoord = (wEntry.lo + wEntry.hi) / 2;
  const travelSign = Math.sign(wLanding.faceValue - wEntry.faceValue) || 1;
  const landingStartWorld = wLanding.faceValue - travelSign * landingLen;
  const lo = Math.min(wEntry.faceValue, landingStartWorld);
  const hi = Math.max(wEntry.faceValue, landingStartWorld);
  for (const w of wallGraph.walls ?? []) {
    if (w.isVertical !== f.vertical) continue;
    if (Math.abs(w.axisCL.effectiveValue - midCoord) > MID_WALL_TOL_MM) continue;
    const wLo = Math.min(w.coord1, w.coord2), wHi = Math.max(w.coord1, w.coord2);
    if (wHi <= lo || wLo >= hi) continue;
    return w;
  }
  return null;
}

export function wallThicknessMm(wall) {
  const r = wall.materialRange;
  return Math.abs(r.hi - r.lo) || 100;
}

export function clipFaceToWorldRange(face, worldA, worldB) {
  const lo = Math.min(worldA, worldB), hi = Math.max(worldA, worldB);
  return {
    ...face, lo, hi, run: hi - lo, originWorld: face.dirSign > 0 ? lo : hi,
    hasWallAtLocal0: false, hasWallAtLocalRun: false,
    edgeAtLocal0: false, edgeAtLocalRun: false,
  };
}

export function laneRangesOnEntry(wEntry, wOut1, midCoord) {
  const midLocal = localXOfFace(wEntry, midCoord);
  const out1Local = localXOfFace(wEntry, wOut1.faceValue);
  return out1Local < midLocal
    ? { outbound: [0, midLocal], returnRange: [midLocal, wEntry.run] }
    : { outbound: [midLocal, wEntry.run], returnRange: [0, midLocal] };
}

export function buildMidWallFace(wall, inward, loWorld, hiWorld, faces) {
  const letter = letterOf(wall.isVertical, inward);
  const dirSign = DIR_SIGN[letter];
  const loFace = perpFaceAt(faces, wall.isVertical, wall.axisCL.effectiveValue, loWorld);
  const hiFace = perpFaceAt(faces, wall.isVertical, wall.axisCL.effectiveValue, hiWorld);
  const rawLo = loFace ? loFace.faceValue : loWorld;
  const rawHi = hiFace ? hiFace.faceValue : hiWorld;
  const swapped = rawLo > rawHi;
  const lo = swapped ? rawHi : rawLo;
  const hi = swapped ? rawLo : rawHi;
  const startCLId = (swapped ? hiFace : loFace)?.axisCL.id ?? null;
  const endCLId   = (swapped ? loFace : hiFace)?.axisCL.id ?? null;
  return {
    letter, dirSign, isVertical: wall.isVertical, axisCL: wall.axisCL, inward,
    faceValue: wall.axisCL.effectiveValue, hasRealWall: true,
    lo, hi, run: hi - lo, originWorld: dirSign > 0 ? lo : hi,
    startCLId, endCLId, hasWallAtLocal0: true, hasWallAtLocalRun: true,
    kind: 'stairMid',
  };
}

/**
 * SWITCHBACK階段の切断定義表（§6.1）を組み立てる。SWITCHBACK以外・stair.cellsが空・
 * floorHeight未確定・面分類が解決できない場合はnull（elevationStairSequence.jsの
 * フォールバック契約と同じ）。
 *
 * 設計からの逸脱: §4の宣言シグネチャは`switchbackCuts(stair, graph, opts)`（faces無し）だが、
 * 本実装は`faces`（composeRoomFacesの結果）を第2引数として要求する（ファイル冒頭コメント参照）。
 * @param {import('@core').Stair} stair
 * @param {object[]} faces - composeRoomFaces(stairRoom, graph) の結果
 * @param {object} graph - 設置階のgraph
 * @param {{floorHeight:number, chUpperAbsMm:number, chLowerMm:number, upperGraph?:object,
 *   upperCeilCapped?:boolean}} opts
 * @returns {{cuts:object[], wEntry:object, wLanding:object, wOut1:object, wOut2:object,
 *   wall:import('@core').Wall|null, kneeDrop:object|null, params:object, landingAbs:number,
 *   isSteel:boolean, contribution:object|null}|null}
 *   cuts の各要素は SectionCut 型 + {face, seqLabel} を持つ（faceは§3.5 faceFromCutと同型の
 *   代わりに、classifyFaces由来の実面をそのまま使う——理由は上記コメント参照）。
 */
export function switchbackCuts(stair, faces, graph, opts = {}) {
  if (!stair || stair.type !== StairType.SWITCHBACK) return null;
  if (!stair.cells || stair.cells.size === 0) return null;
  const floorHeight = opts.floorHeight;
  if (floorHeight == null) return null;

  const params = resolveSwitchbackParams(stair, graph, floorHeight);
  if (!params) return null;
  const { n1, riser, landingLen } = params;
  const landingAbs = n1 * riser;
  const isSteel = stair.structure === StructuralMaterialType.STEEL;

  const b = roomBounds(stair.cells, graph);
  const f = makeFrame(stair, b);
  const { wEntry, wLanding, wOut1, wOut2 } = classifyFaces(faces, f);
  if (!wEntry || !wLanding || !wOut1 || !wOut2) return null;

  const wallGraph = opts.upperGraph ?? graph;
  const wall = findMidWall(wallGraph, wEntry, wLanding, landingLen, f);
  const kneeDrop = wall ? kneeDropRecordFor(wall, wallGraph) : null;

  const ceilTopAbs = opts.chUpperAbsMm;
  const ceilLowAbs = opts.chLowerMm;
  const upperCeilCapped = opts.upperCeilCapped === true;

  const travelSign = Math.sign(wLanding.faceValue - wEntry.faceValue) || 1;
  const landingStartWorld = wLanding.faceValue - travelSign * landingLen;
  const entryWorld = wEntry.faceValue;

  const contribution = stairContribution(stair, graph, floorHeight);

  const layers = [{ graph, floorZMm: 0, role: 'self' }];
  if (opts.upperGraph) layers.push({ graph: opts.upperGraph, floorZMm: floorHeight, role: 'above' });

  const zRangeUpper = { loZ: 0, hiZ: ceilTopAbs };

  // WP-E5b: cut.line/viewSign/dirSignをW(t,s)座標系から独立に再導出する（switchbackCuts.js冒頭の
  // 「設計からの逸脱」コメントのとおり、face自体（wEntry等・実壁への隅スナップ済み）は
  // classifyFaces由来のまま流用するが、断面エンジンが実際にレイキャストする切断線・視線方向・
  // 図のx昇順対応（dirSign）はここで新規に導出する——リード裁定＋前builderが検証した式（タスク
  // 発注時の引き継ぎメモ参照。本セッションでf.pt(0,s)を実際にfixture計算し
  // wOut2.dirSign===-wOut1.dirSignを確認済み＝VERIFIED）。
  // acrossCoordAt: 幅方向(s)の世界座標（tには依存しないためt=0固定で良い）。
  const acrossCoordAt = s => { const p = f.pt(0, s); return f.vertical ? p.x : p.y; };
  // travelCoordAt: 走行方向(t)の世界座標（幅方向にも依存しないためs=0.5固定で良い）。
  const travelCoordAt = t => { const p = f.pt(t, 0.5); return f.vertical ? p.y : p.x; };

  const tRun = params.len1 / (params.len1 + params.landingLen);
  const midAcross = acrossCoordAt(0.5);
  const tRunTravel = travelCoordAt(tRun);

  // ---- seq1/seq3: 踊り場前縁 W(tRun,0→1)（幅方向の全幅線。リード裁定で両方ともこの1本の
  // 切断線を共有する——設計書§6.1表のseq3の元位置W(1)からの意図保存の逸脱。理由:
  // wLandingを「距離のある見えがかり候補」として自然に検出させ、seq3の床基準(landingAbs)を
  // 保ったまま「踊り場の奥行き分だけ離れた壁」を一般規則で出すため）。
  const seq13Line = { isVertical: wEntry.isVertical, axisValue: tRunTravel, lo: wEntry.lo, hi: wEntry.hi };
  const seq1ViewSign = Math.sign(travelCoordAt(0) - tRunTravel) || 1; // 上り口向き(-t方向)
  const seq3ViewSign = Math.sign(travelCoordAt(1) - tRunTravel) || 1; // 踊り場奥向き(+t方向)

  // ---- seq2/2.5/4/4.5/5: レーン境界 W(0,sMid→1,sMid)（走行方向の全長線）。
  const seq24Line = { isVertical: wOut1.isVertical, axisValue: midAcross, lo: wOut1.lo, hi: wOut1.hi };
  const seq2ViewSign = -(Math.sign(acrossCoordAt(0) - midAcross) || 1);   // 往路側(s=0向き)
  const seq25ViewSign = Math.sign(acrossCoordAt(1) - midAcross) || 1; // 復路側(s=1向き)
  const seq2DirSign = wOut1.dirSign;
  const seq4DirSign = -seq2DirSign; // wOut2.dirSignと一致（VERIFIED: 本セッションでfixture計算済み）

  // 階段第3層（stairContribution）は各cutで該当するレーンのみを渡す——同一のcut.line
  // （レーン境界）は往路・復路どちらのレーンの境界にもなるため、tRun地点の幾何だけでは
  // どちらのレーンを描くか一般規則から一意に決められない（往路・復路とも幅方向の境界が
  // midAcrossに一致するため）。切断定義表（本ファイル）が「どちらの歩行順シーケンスか」を
  // 知っている唯一の場所であるため、ここでレーンを明示的に選ぶ（WP-E5bリスク3の対応）。
  const outboundFlight = contribution?.flights?.[0] ?? null;
  const inboundFlight = contribution?.flights?.[1] ?? null;
  const outboundOnly = outboundFlight ? { flights: [outboundFlight], landings: [], structure: contribution.structure } : null;
  const outboundWithLanding = outboundFlight
    ? { flights: [outboundFlight], landings: contribution.landings, structure: contribution.structure } : null;
  const inboundOnly = inboundFlight ? { flights: [inboundFlight], landings: [], structure: contribution.structure } : null;
  const inboundWithLanding = inboundFlight
    ? { flights: [inboundFlight], landings: contribution.landings, structure: contribution.structure } : null;

  const cuts = [
    {
      seqNo: '1', face: wEntry, line: seq13Line, viewSign: seq1ViewSign, dirSign: wEntry.dirSign,
      layers, zRange: zRangeUpper, baseFloorZ: landingAbs, chDimSplitAbsYs: [floorHeight],
      stairCut: contribution, // 往路・復路とも正面梯子として重なるため両方渡す（§6.1「往路=正面梯子(下)／復路=正面梯子(上)」）
    },
    {
      seqNo: '2', face: wOut1, line: seq24Line, viewSign: seq2ViewSign, dirSign: seq2DirSign,
      layers, zRange: zRangeUpper, baseFloorZ: 0, stairCut: outboundWithLanding,
    },
  ];
  if (wall) {
    const midOutFace = buildMidWallFace(wall, wOut2.inward, entryWorld, landingStartWorld, faces);
    cuts.push({
      seqNo: '2.5', face: midOutFace, line: seq24Line, viewSign: seq25ViewSign, dirSign: seq2DirSign,
      layers, zRange: zRangeUpper, baseFloorZ: 0, stairCut: outboundOnly,
    });
  }
  cuts.push({
    seqNo: '3', face: wLanding, line: seq13Line, viewSign: seq3ViewSign, dirSign: wLanding.dirSign,
    layers, zRange: zRangeUpper, baseFloorZ: landingAbs, stairCut: null, // §6.1表「階段寄与: なし」
  });
  cuts.push({
    seqNo: '4', face: wOut2, line: seq24Line, viewSign: seq25ViewSign, dirSign: seq4DirSign,
    layers, zRange: zRangeUpper, baseFloorZ: landingAbs, stairCut: inboundWithLanding,
  });
  if (wall) {
    const midRetFace = buildMidWallFace(wall, wOut1.inward, landingStartWorld, entryWorld, faces);
    cuts.push({
      seqNo: '4.5', face: midRetFace, line: seq24Line, viewSign: seq2ViewSign, dirSign: seq4DirSign,
      layers, zRange: zRangeUpper, baseFloorZ: landingAbs, stairCut: inboundOnly,
    });
  }
  {
    const outFace5 = clipFaceToWorldRange(wOut2, landingStartWorld, entryWorld);
    cuts.push({
      seqNo: '5', face: outFace5, line: seq24Line, viewSign: seq25ViewSign, dirSign: seq2DirSign,
      layers, zRange: zRangeUpper, baseFloorZ: landingAbs, stairCut: inboundOnly,
    });
  }

  return {
    cuts, wEntry, wLanding, wOut1, wOut2, wall, kneeDrop, params, landingAbs, isSteel, contribution,
    ceilTopAbs, ceilLowAbs, upperCeilCapped, entryWorld, landingStartWorld,
  };
}
