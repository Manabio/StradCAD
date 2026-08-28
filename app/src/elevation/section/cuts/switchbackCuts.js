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
import { makeFrame, cellsBeyondBreak } from '../../../finish/stair/stairGeometry.js';
import { stairUnderRoomsOf } from '../../../finish/stair/stairUnderRooms.js';
import { letterOf, letterForDirSign, DIR_SIGN, perpFaceAt } from '../../elevationFaces.js';
import { kneeDropRecordFor } from '../../elevationFaceList.js';
import { localXOf as localXOfFace } from '../../elevationFigure.js';
import { resolveSwitchbackParams } from '../../elevationStairSection.js';
import { stairContribution } from '../sectionStair.js';
import { graphList } from '../../../graphReadScope.js';

const MID_WALL_TOL_MM = 300; // 壁厚程度の許容差（往路・復路間の壁の実在判定。既存実装と同値）

/**
 * 階段下（破れ線先セル）に部屋が指定されているか。判定は仕上げモード側と同じ単一情報源
 * （`cellsBeyondBreak` × `stairUnderRoomsOf`）に委譲する——展開図が独自判定を持つと
 * 階段下壁の生成（`stairUnderWalls.js`）と食い違うため。
 *
 * **判定不能なら true（＝現行表現を保つ）へ倒す**——graph未整備・破れ線先セルを導出できない
 * （`cellsBeyondBreak`が空。U字構造として認識できない構成等）場合は「階段下が開いている」と
 * 積極的に言えないため、ユーザー実機確認済みの表現（踊り場が基準床）をそのまま使う。
 * 逆に倒すと、判定できないだけの階段まで描画が変わってしまう。
 * @param {import('@core').Stair} stair
 * @param {object} graph
 * @returns {boolean}
 */
function hasRoomUnderStair(stair, graph) {
  if (!stair || !graph?.rooms) return true;
  const beyond = cellsBeyondBreak(stair, graph, stair.riser ?? null);
  if (beyond.size === 0) return true;
  return stairUnderRoomsOf(stair, graph, beyond).length > 0;
}

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
  for (const w of graphList(wallGraph, 'walls') ?? []) {
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

/**
 * face（composeRoomFacesの実面）の「ローカルx=0がどちら側の世界座標に対応するか」を、
 * 部屋の見た目上の向き（letterOf由来のコンパス基準dirSign）ではなく、呼び出し側が指定する
 * desiredDirSign（階段の歩行方向・幅方向基準）へ強制的に再正規化する（QA実機フィードバック
 * 修正: seq1の梯子左右逆・seq2/seq4の左右逆の根本原因）。
 *
 * 背景: classifyFaces（≒composeRoomFacesの実面）が持つdirSign/originWorld/hasWallAtLocal0等は
 * 部屋自体のA/B/C/D向き（letterOf・DIR_SIGN。世界座標の絶対的な向き）から決まり、階段の
 * 「上り口→踊り場」「往路→復路」という歩行方向とは無関係——たまたま一致する部屋の向きも
 * あれば、逆になる部屋の向きもある。cut.dirSign（レイキャスト用にW(t,s)から独立に導出。
 * ファイル冒頭コメント参照）だけを歩行方向基準に直しても、floorSegments/ceilingProfile
 * （elevationStairSequence.js側。face.run・face.dirSign由来のoriginWorld・
 * hasWallAtLocal0/Runを暗黙の前提にした「区間0=上り口側」のハードコード順）は
 * face自身のdirSignのままズレて残るため、content（cut.dirSign経由）とfloorSegments
 * （face.dirSign経由）が食い違う——face自体をここで再正規化し、両方が同じ歩行方向基準に
 * 揃うようにする。lo/hi/run/axisCL/faceValue/inward/isVertical/hasRealWall/kindは
 * 同じ物理壁を指す不変な性質のためそのまま維持し、「ローカルxの向き」に関する対の属性
 * （hasWallAtLocal0/Run・edgeAtLocal0/Run・startCLId/endCLId・partitionCutAtLocal0/Run）だけ
 * 入れ替える。face.dirSignが既にdesiredDirSignと一致するなら何もしない（他の部屋向きでは
 * 現行どおりの経路のまま＝無変更で緑必須のゴールデン・非階段テストに影響しない）。
 *
 * **letter（展開記号）はdirSignに従って引き直す**（ユーザー実機指摘2026-08。旧実装は
 * 「同じ物理壁を指す不変な性質」としてletterを据え置いており、`DIR_SIGN[letter]===dirSign`
 * という面の不変条件が破れていた）——記号A/B/C/Dは視線の向き＝図の左→右がどちらの世界方向かで
 * 決まるため、ローカルxの向きを歩行方向へ倒した時点で記号も入れ替わる（B⇄D・A⇄C）。
 * 実機の症状は「左手に登り口・右が踊り場＝9時方向を見ている図なのに記号がB（3時）」。
 * labelは呼び出し側（elevationStairSequence.js）が歩行順で採番し直すため、ここでは
 * letterと同値へ落とす（採番前の暫定値。据え置くと旧letterの連番が残って食い違う）。
 * @param {object|null} face
 * @param {1|-1} desiredDirSign
 * @returns {object|null}
 */
export function reorientFace(face, desiredDirSign) {
  if (!face || face.dirSign === desiredDirSign) return face;
  const letter = letterForDirSign(face.isVertical, desiredDirSign);
  return {
    ...face,
    letter, label: letter, id: letter,
    dirSign: desiredDirSign,
    originWorld: desiredDirSign > 0 ? face.lo : face.hi,
    hasWallAtLocal0:   face.hasWallAtLocalRun,
    hasWallAtLocalRun: face.hasWallAtLocal0,
    edgeAtLocal0:      face.edgeAtLocalRun,
    edgeAtLocalRun:    face.edgeAtLocal0,
    startCLId: face.endCLId,
    endCLId:   face.startCLId,
    partitionCutAtLocal0:   face.partitionCutAtLocalRun,
    partitionCutAtLocalRun: face.partitionCutAtLocal0,
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
    // labelは歩行順の採番（elevationStairSequence.js）で上書きされる暫定値。合成面にも
    // 展開記号は要る（実機ではこれも1枚の展開図として並ぶ）ため未設定のままにしない。
    letter, label: letter, id: letter,
    dirSign, isVertical: wall.isVertical, axisCL: wall.axisCL, inward,
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
 * @param {{floorHeight:number, chUpperAbsMm:number, chLowerMm:number, upperGraph?:object}} opts
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
  // ユーザー実機指摘2026-08「階段・踊り場下の描画方法は、下に部屋がある・なしで異なる。
  // 現時点の描画は下に部屋がある場合」: 階段下に部屋が**無い**なら、踊り場の下は同じ空間として
  // 設置階FL(=0)まで開いている——この帯の「床」も§5.6の基準床(baseFloorZ)も1FLになる。
  // 部屋が有る場合は従来どおり踊り場が基準床（その下は別室＝向こう側なので細破線へ降格）。
  // 判定は階段下部屋の唯一の情報源（stairUnderRoomsOf × cellsBeyondBreak）をそのまま使う
  // ——展開図が独自の判定を持つと、壁生成（stairUnderWalls.js）との食い違いが生まれるため。
  const hasRoomUnder = hasRoomUnderStair(stair, graph);
  const underFloorZ = hasRoomUnder ? landingAbs : 0;

  const b = roomBounds(stair.cells, graph);
  const f = makeFrame(stair, b);
  const rawFaces = classifyFaces(faces, f);
  if (!rawFaces.wEntry || !rawFaces.wLanding || !rawFaces.wOut1 || !rawFaces.wOut2) return null;

  // WP-E5b: cut.line/viewSign/dirSignをW(t,s)座標系から独立に再導出する（switchbackCuts.js冒頭の
  // 「設計からの逸脱」コメントのとおり、face自体（wEntry等・実壁への隅スナップ済み）は
  // classifyFaces由来のまま流用するが、断面エンジンが実際にレイキャストする切断線・視線方向・
  // 図のx昇順対応（dirSign）はここで新規に導出する）。
  // acrossCoordAt: 幅方向(s)の世界座標（tには依存しないためt=0固定で良い）。
  const acrossCoordAt = s => { const p = f.pt(0, s); return f.vertical ? p.x : p.y; };
  // travelCoordAt: 走行方向(t)の世界座標（幅方向にも依存しないためs=0.5固定で良い）。
  const travelCoordAt = t => { const p = f.pt(t, 0.5); return f.vertical ? p.y : p.x; };

  const tRun = params.len1 / (params.len1 + params.landingLen);

  // QA実機フィードバック修正: dirSignは部屋のコンパス向き（wEntry.dirSign等・letterOf基準）
  // ではなく、階段自身の歩行方向（幅方向=往路(s=0)→復路(s=1)、走行方向=上り口(t=0)→踊り場(t=tRun)）
  // が「ローカルx昇順」になるよう独立に導出する（reorientFace参照。ファイル冒頭の役割コメントも
  // 参照）。widthDirSign: seq1/seq3（幅方向の全幅線）用——s=0側(往路)がlocalX=0(左)になる向き。
  // seq2DirSign: seq2/2.5（走行方向の全長線）用——t=0側(上り口)がlocalX=0(左)になる向き。
  const widthDirSign = Math.sign(acrossCoordAt(1) - acrossCoordAt(0)) || 1;
  const seq2DirSign = Math.sign(travelCoordAt(tRun) - travelCoordAt(0)) || 1;
  const seq4DirSign = -seq2DirSign; // seq4はseq2の鏡像（踊り場が左・上り口が右）

  const wEntry   = reorientFace(rawFaces.wEntry, widthDirSign);
  const wLanding = reorientFace(rawFaces.wLanding, widthDirSign);
  const wOut1    = reorientFace(rawFaces.wOut1, seq2DirSign);
  const wOut2    = reorientFace(rawFaces.wOut2, seq4DirSign);

  const wallGraph = opts.upperGraph ?? graph;
  const wall = findMidWall(wallGraph, wEntry, wLanding, landingLen, f);
  const kneeDrop = wall ? kneeDropRecordFor(wall, wallGraph) : null;

  const ceilTopAbs = opts.chUpperAbsMm;
  const ceilLowAbs = opts.chLowerMm;

  const travelSign = Math.sign(wLanding.faceValue - wEntry.faceValue) || 1;
  const landingStartWorld = wLanding.faceValue - travelSign * landingLen;
  const entryWorld = wEntry.faceValue;

  const contribution = stairContribution(stair, graph, floorHeight);

  const layers = [{ graph, floorZMm: 0, role: 'self' }];
  if (opts.upperGraph) layers.push({ graph: opts.upperGraph, floorZMm: floorHeight, role: 'above' });

  const zRangeUpper = { loZ: 0, hiZ: ceilTopAbs };

  const tRunTravel = travelCoordAt(tRun);

  // ---- seq1/seq3: 踊り場前縁 W(tRun,0→1)（幅方向の全幅線。リード裁定で両方ともこの1本の
  // 切断線を共有する——設計書§6.1表のseq3の元位置W(1)からの意図保存の逸脱。理由:
  // wLandingを「距離のある見えがかり候補」として自然に検出させ、seq3の床基準(landingAbs)を
  // 保ったまま「踊り場の奥行き分だけ離れた壁」を一般規則で出すため）。
  const seq13Line = { isVertical: wEntry.isVertical, axisValue: tRunTravel, lo: wEntry.lo, hi: wEntry.hi };
  const seq1ViewSign = Math.sign(travelCoordAt(0) - tRunTravel) || 1; // 上り口向き(-t方向)
  const seq3ViewSign = Math.sign(travelCoordAt(1) - tRunTravel) || 1; // 踊り場奥向き(+t方向)

  // ---- seq2/2.5/4/4.5: 往路レーン中央 W(0,0.25→1,0.25)（走行方向の全長線。ユーザー実機
  // フィードバック2026-08-23で「レーン境界（100mmあき内）で切って往路側壁を見る」から
  // 「往路レーンの中を切って復路側／往路外側を見る」へ修正。切断線が往路Flightの中を通るため、
  // isLengthwiseCutが従来どおり成立し（flight.acrossLo/acrossHi内）、第3層はFlightを縦断する
  // 断面として扱う——cutAlongの対象はレーン境界の壁ではなく、往路レーンの中央そのものに
  // 実壁は無いため、cutAlong判定は発火しない（第1層は単にFlightを切る切断線を渡すだけ）。
  // seq5のみ復路レーン中央 W(0,0.75→1,0.75)を使う（ユーザー指示「seq5は現行の向きを踏襲」＝
  // 値としては従来のmidAcross基準の向きと同じtowardS1になる。詳細はtowardS1/towardS0参照）。
  const outboundLaneAcross = acrossCoordAt(0.25);
  const inboundLaneAcross = acrossCoordAt(0.75);
  const outboundLaneLine = { isVertical: wOut1.isVertical, axisValue: outboundLaneAcross, lo: wOut1.lo, hi: wOut1.hi };
  const inboundLaneLine = { isVertical: wOut1.isVertical, axisValue: inboundLaneAcross, lo: wOut1.lo, hi: wOut1.hi };
  // sectionProbe.jsのisSightlineShape契約: (shape.axisCL.effectiveValue - line.axisValue) * viewSign > 0
  // が見えがかり候補——「s=1側が見える」viewSignは、line位置に関わらずwidthDirSignと同符号になる
  // （0.25→1・0.5→1・0.75→1のいずれも同じ向き。s<1の基準点なら常に成り立つ幾何）。
  // towardS0はその逆符号（s=0側=往路外側の壁が見える向き）。
  const towardS1 = widthDirSign;   // 復路側(s=1向き)を見る（seq2/2.5・seq5）
  const towardS0 = -widthDirSign;  // 往路外側(s=0向き)を見る（seq4/4.5）

  // 階段第3層（stairContribution）は各cutで該当するレーンのみを渡す——outboundLaneLineは
  // seq2/2.5/4/4.5が共有するため（同じ切断線をtowardS1/towardS0の逆向きから見る）、
  // どちらのレーンを描くかは切断線の幾何だけでは自明でも、視線前方に来る「他レーン」の判定
  // （見えがかりのささら等）は別途必要——切断定義表（本ファイル）が「どちらの歩行順シーケンスか」を
  // 知っている唯一の場所であるため、ここでレーンを明示的に選ぶ（WP-E5bリスク3の対応。
  // 2026-08-23実機修正でも維持）。
  const outboundFlight = contribution?.flights?.[0] ?? null;
  const inboundFlight = contribution?.flights?.[1] ?? null;
  const outboundOnly = outboundFlight ? { flights: [outboundFlight], landings: [], structure: contribution.structure, unit: contribution.unit } : null;
  const outboundWithLanding = outboundFlight
    ? { flights: [outboundFlight], landings: contribution.landings, structure: contribution.structure, unit: contribution.unit } : null;
  const inboundOnly = inboundFlight ? { flights: [inboundFlight], landings: [], structure: contribution.structure, unit: contribution.unit } : null;
  // seq3（踊り場の壁。W_landing）用: 踊り場だけを渡す。旧実装は§6.1表の「階段寄与: なし」を
  // そのままstairCut:nullにしていたが、ユーザー実機指摘2026-08「6」A「踊り場断面線、その左右壁
  // との取り合いに（折返し階段外回りの）ささら断面、上下にささらの見えがかり（横線2本）」——
  // 「階段（段）の重ね描きなし」であって、踊り場そのものの断面・桁枠は必要だった。
  // flightsは空のまま＝段の梯子・ジグザグは出ない（表の意図は維持する）。
  const landingOnly = (contribution.landings ?? []).length > 0
    ? { flights: [], landings: contribution.landings, structure: contribution.structure, unit: contribution.unit }
    : null;
  // 復路+踊り場。seq5（D2＝復路レーンから外側の壁を見る面）が使う——ユーザー実機指摘2026-08
  // 「踊場断面は図の右側、階段断面は左側に現れる」。
  const inboundWithLanding = inboundFlight
    ? { flights: [inboundFlight], landings: contribution.landings, structure: contribution.structure, unit: contribution.unit }
    : null;
  // （旧コメント）QA修正でseq4がoutboundWithLandingを使うようになったため
  // 未使用——seq2.5/4.5/5はoutboundOnly/inboundOnlyのみ使う（踊り場は各々のフルフェイス側
  // （seq2/seq4）だけが持てば十分なため）。
  // WP-2026-08-23実機フィードバック「往路と復路の間に壁が無ければ復路直進部のささらが見える」
  // 対応: seq2のみ、視線前方（towardS1）にある復路(inbound)をsecondaryFlightsとして渡す
  // （sectionStair.jsのstairPrimitivesForCutが壁の有無をcolumns経由で判定し、無ければ
  // 近い側のささらだけを見えがかりで描く）。seq2.5は壁が実在するときだけ生成される
  // （if(wall)ブロック）ため、secondaryFlightsを渡しても壁自体がisBlockedByWallで検出され
  // 常に非表示になる——付与しても実害は無いが、意味が無いため付与しない（seq2のみに限定）。
  const outboundWithLandingSeq2 = outboundWithLanding && inboundFlight
    ? { ...outboundWithLanding, secondaryFlights: [inboundFlight] } : outboundWithLanding;

  const cuts = [
    {
      seqNo: '1', face: wEntry, line: seq13Line, viewSign: seq1ViewSign, dirSign: wEntry.dirSign,
      layers, zRange: zRangeUpper, baseFloorZ: underFloorZ, chDimSplitAbsYs: [floorHeight],
      stairCut: contribution, // 往路・復路とも正面梯子として重なるため両方渡す（§6.1「往路=正面梯子(下)／復路=正面梯子(上)」）
    },
    {
      seqNo: '2', face: wOut1, line: outboundLaneLine, viewSign: towardS1, dirSign: seq2DirSign,
      layers, zRange: zRangeUpper, baseFloorZ: 0, stairCut: outboundWithLandingSeq2,
    },
  ];
  if (wall) {
    // QA修正: buildMidWallFaceが内部で導くdirSign（letterOf(wall.isVertical,inward)由来の
    // コンパス基準）も部屋の向きに依存するため、reorientFaceでseq2DirSignへ再正規化する
    // （wEntry/wOut1等と同じ理由。ファイル冒頭のreorientFaceコメント参照）。
    const midOutFace = reorientFace(buildMidWallFace(wall, wOut2.inward, entryWorld, landingStartWorld, faces), seq2DirSign);
    cuts.push({
      seqNo: '2.5', face: midOutFace, line: outboundLaneLine, viewSign: towardS1, dirSign: seq2DirSign,
      layers, zRange: zRangeUpper, baseFloorZ: 0, stairCut: outboundOnly,
    });
  }
  cuts.push({
    seqNo: '3', face: wLanding, line: seq13Line, viewSign: seq3ViewSign, dirSign: wLanding.dirSign,
    // §6.1表「階段寄与: なし」＝段の重ね描きなし。踊り場の断面・桁枠は描く（landingOnly参照）。
    layers, zRange: zRangeUpper, baseFloorZ: underFloorZ, stairCut: landingOnly,
  });
  cuts.push({
    // QA実機フィードバック修正: seq4のstairCutは復路(inbound)ではなく往路(outbound)——
    // seq4はwOut2を「反対側(復路レーン)から見た往路の鏡像」として見せる面であり
    // （dirSignがseq2の逆＝踊り場が左・上り口が右になる)、復路をここに描くと踊り場側が
    // 低く上り口側が高くなり「左から右へ下る」という実機の見え方と矛盾する
    // （往路の断面をwOut1側からwOut2側へ鏡映しただけ、と捉えると整合する）。
    seqNo: '4', face: wOut2, line: outboundLaneLine, viewSign: towardS0, dirSign: seq4DirSign,
    layers, zRange: zRangeUpper, baseFloorZ: underFloorZ, stairCut: outboundWithLanding,
  });
  if (wall) {
    const midRetFace = reorientFace(buildMidWallFace(wall, wOut1.inward, landingStartWorld, entryWorld, faces), seq4DirSign);
    cuts.push({
      seqNo: '4.5', face: midRetFace, line: outboundLaneLine, viewSign: towardS0, dirSign: seq4DirSign,
      layers, zRange: zRangeUpper, baseFloorZ: underFloorZ, stairCut: inboundOnly,
    });
  }
  {
    // ==== ユーザー実機指摘2026-08「6」D2（面の取り違え）====
    // seq5は「復路レーンの中を切って9時方向＝復路が接している外側の壁（wOut2）を見る」面。
    // 旧実装は`clipFaceToWorldRange(wOut2, landingStartWorld, entryWorld)`で**レーン区間だけに
    // 切り詰めた**面を使っていた（実機で run=2442.5・両端とも壁なし）ため、踊り場ぶんが figure に
    // 入らず「Y2が3500の右」「踊場断面は図の右側・階段断面は左側」という構図にならなかった。
    // 面は**wOut2の全長**（踊り場ぶんを含む）を使い、向きはseq2側（踊り場が右・上り口が左）に
    // 揃える——ユーザー指定「踊場断面は図の右側、階段断面は左側に現れる」。
    // stairCutも復路だけ（inboundOnly）では踊り場の断面が出ないため、踊り場を含めて渡す。
    const retFace5 = reorientFace(wOut2, seq2DirSign);
    cuts.push({
      seqNo: '5', face: retFace5, line: inboundLaneLine, viewSign: towardS1, dirSign: seq2DirSign,
      layers, zRange: zRangeUpper, baseFloorZ: underFloorZ, stairCut: inboundWithLanding,
    });
  }

  return {
    cuts, wEntry, wLanding, wOut1, wOut2, wall, kneeDrop, params, landingAbs, underFloorZ, hasRoomUnder, isSteel, contribution,
    ceilTopAbs, ceilLowAbs, entryWorld, landingStartWorld,
  };
}
