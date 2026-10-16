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
 * outFace5）自体は、既存 elevationStairSequence.js の classifyFaces/findMidWall
 * （実壁面へ隅スナップ済みのcomposeRoomFaces結果に基づく、実機で検証済みのロジック）から
 * 移設してそのまま再利用する形にした（sectionFace.js のfaceFromCutへの一般化は見送り）。
 * cut.line/viewSign/dirSignだけをW(t,s)から独立に再導出し、facesはcuts配列の`face`
 * フィールド（floorSegments/ceilingProfile算出用。エンジンのcontent生成には使わない）を
 * 供給する役割に限定する——二重管理だが、コンテンツ生成（レイキャスト）とfloorSegments算出
 * （壁面ベース）を疎結合に保てる利点がある（WP-E5bリスク3として報告済み）。
 * @module
 */
import { StructuralMaterialType, CenterLineType } from '@core';
import { roomBounds } from '../../../finish/gridCells.js';
import { makeFrame, cellsBeyondBreak } from '../../../finish/stair/stairGeometry.js';
import { stairUnderRoomsOf } from '../../../finish/stair/stairUnderRooms.js';
import { U_TURN_TYPES } from '../../../finish/stair/stairPorts.js';
import { letterOf, letterForDirSign, DIR_SIGN, perpFaceAt } from '../../elevationFaces.js';
import { kneeDropRecordFor } from '../../elevationFaceList.js';
import { localXOf as localXOfFace } from '../../elevationFigure.js';
import { resolveUTurnSectionParams } from '../../elevationStairSection.js';
import { stairContribution } from '../sectionStair.js';
import { graphList } from '../../../graphReadScope.js';
import { isCeilingOnlyKind } from '../../../core/centerLineKindPolicy.js';
import { makeProbeContext } from '../sectionProbe.js';
import { isWallHiddenForBand } from '../sectionHits.js';
import { GAP_EPS_MM } from '../../elevationStyle.js';

const MID_WALL_TOL_MM = 300; // 壁厚程度の許容差（往路・復路間の壁の実在判定。既存実装と同値）
// 走行軸に平行な面のうち、幅方向 s がこの範囲にあるものは往路・復路の間の面（外壁側ではない）。
const MID_LANE_S_LO = 0.25;
const MID_LANE_S_HI = 0.75;

/**
 * seq3（踊り場の壁を見る面）の切断線を、踊り場前縁から踊り場側（+t）へ入れる量（mm）。
 * 前提: 木造・薄壁（柱包み57.5・柱半幅45）に対する余裕。RCの厚壁(200以上)や150角超の柱では
 * 回り込みがこの量を超え、再び切断面にかかりうる。
 * 端で接する壁（階段下の壁・往復レーン境界の壁の端）と柱包み（壁の物理範囲が±57.5mm
 * 回り込む）が踊り場前縁の切断面にかかって断面（帯）になるのを避ける——踊り場は平場で、
 * そこには隔て板は無い（ユーザー裁定2026-10-08）。柱包みの回り込み(57.5)・柱の半幅(45)より
 * 大きく、踊り場の奥行きに対して小さい値。踊り場がこれ以下の奥行きなら入れない（前縁のまま）。
 */
export const LANDING_CUT_INSET_MM = 100;

/**
 * 階段下（破れ線先セル）の部屋情報。判定は仕上げモード側と同じ単一情報源
 * （`cellsBeyondBreak` × `stairUnderRoomsOf`）に委譲する——展開図が独自判定を持つと
 * 階段下壁の生成（`stairUnderWalls.js`）と食い違うため。
 *
 * - `hasRoomUnder` … **判定不能なら true（＝現行表現を保つ）**へ倒す——graph未整備・破れ線先
 *   セルを導出できない（`cellsBeyondBreak`が空。U字構造として認識できない構成等）場合は
 *   「階段下が開いている」と積極的に言えないため、ユーザー実機確認済みの表現（踊り場が基準床）を
 *   そのまま使う。逆に倒すと、判定できないだけの階段まで描画が変わってしまう。
 * - `underRooms` … 階段下に指定された部屋そのもの（Room[]。0件もありうる）。
 *   展開図一般化Phase 6: 階段下部屋の壁（2a壁）を階段の展開図から隠す判定（旧: 壁id列挙の
 *   `hiddenWallIds`）は、空気ボリュームの連結成分（`section/sectionHits.js`の`isHiddenWall`。
 *   `cut.underRooms`＝この配列）で表す規則へ一般化した——**この配列で「特定のどの部屋が
 *   階段下か」をスコープする**ことが必須（QA実測: 単に「階段室の成分と異なる壁は全部隠す」
 *   まで一般化すると、階段室と無関係な別室（例: 「9」）が偶然隣り合うだけの階段自身の外壁まで
 *   誤って隠れる——13.stq「6」D面の実壁が広範囲に消えた反例）。2a壁のid・footprintの内外
 *   （旧`FOOTPRINT_EDGE_TOL_MM`）はこの関数が知る必要が無くなった。
 * @param {import('@core').Stair} stair
 * @param {object} graph
 * @returns {{hasRoomUnder:boolean, underRooms:import('@core').Room[]}}
 */
function stairUnderRoomInfo(stair, graph) {
  if (!stair || !graph?.rooms) return { hasRoomUnder: true, underRooms: [] };
  const beyond = cellsBeyondBreak(stair, graph, stair.riser ?? null);
  if (beyond.size === 0) return { hasRoomUnder: true, underRooms: [] };
  const underRooms = stairUnderRoomsOf(stair, graph, beyond);
  return { hasRoomUnder: underRooms.length > 0, underRooms };
}

/**
 * 階段帯の面リスト構築（`composeRoomFaces`）向けの壁フィルタ（展開図一般化§5.12 D2-1是正）。
 *
 * 断面エンジンの候補収集（`probeColumnHits`。`isHiddenWall`経由）は「階段室自身の空気ボリュームと
 * 階段下部屋を隔てる2a壁」を実体はあるが描かない壁として扱うが、**面リスト構築
 * （`elevationFaces.js`の`buildRoomFaces`／`realWallAtCorner`）は同じ壁を`innerWallFaceAt`で
 * 素通しに拾ってしまう**——所有者（どの部屋の壁か）も可視性も見ないため、階段室自身が
 * 壁を持たない辺でも、隣接する階段下部屋の2a壁が同じCL軸上にあるだけで「隅に実壁がある」
 * 「この面自身に壁がある」と誤判定する（13.stq「6」面D2の実測。§5.12参照）。
 *
 * 判断の単一情報源は`isHiddenWall`と同じ`isWallHiddenForBand`——`stairUnderRoomInfo`
 * （このファイルの唯一の情報源。壁生成側`stairUnderWalls.js`と揃える）で`underRooms`を求め、
 * 階段自身の階（`role:'self'`）1層だけのprobeCtxを組んでその場で判定する。
 *
 * `underRooms`が0件（階段下に部屋指定が無い・判定不能）／`stair.roomId`が無い／該当Roomが
 * graphに無い場合はnull（＝フィルタなし。呼び出し側は`opts.wallFilter`に渡さないのと同義）。
 * @param {import('@core').Stair} stair
 * @param {object} graph - 設置階のgraph
 * @returns {((wall:import('@core').Wall)=>boolean)|null}
 */
export function stairBandWallFilter(stair, graph) {
  const { underRooms } = stairUnderRoomInfo(stair, graph);
  if (underRooms.length === 0) return null;
  const stairRoom = stair?.roomId ? graph.roomMap?.get(stair.roomId) ?? null : null;
  if (!stairRoom) return null;
  const layer = { graph, floorZMm: 0, role: 'self' };
  const probeCtx = makeProbeContext([layer]);
  const bandInfo = { airRoom: stairRoom, underRooms: new Set(underRooms) };
  return wall => !isWallHiddenForBand(wall, layer, bandInfo, probeCtx);
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
  const midFaces = new Set();
  for (const face of faces) {
    if (face.kind === 'step') continue;
    const pt = facePoint(face);
    if (face.isVertical !== f.vertical) {
      const t = f.tOf(pt);
      (Math.abs(t) <= Math.abs(t - 1) ? buckets.entry : buckets.landing).push(face);
    } else {
      const s = f.sOf(pt);
      (Math.abs(s) <= Math.abs(s - 1) ? buckets.out1 : buckets.out2).push(face);
      if (face.hasRealWall !== false && s > MID_LANE_S_LO && s < MID_LANE_S_HI) midFaces.add(face);
    }
  }
  // 往路・復路の間（s≈0.5）にある**実壁の面**（隔て板の面・レーン境界の壁）は外壁側の面ではない。
  // 同点で out1 へ入るため、同じ側に外壁側の面があるなら除く（mergeFaces が list[0] 基準なので、
  // 面の並び次第で faceValue が隔て板の面になりうる）。その側に外壁側の面が無い（部屋がレーン境界
  // までしか無い）ときは、境界の面がその側の面を務めるので残す。実壁でない面（hasRealWall:false。
  // 階段下部屋の2a壁などの除外壁）は従来どおり（レーン境界の面を担う既存の挙動を変えない）。
  for (const key of ['out1', 'out2']) {
    const outer = buckets[key].filter(face => !midFaces.has(face));
    if (outer.length > 0) buckets[key] = outer;
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

/**
 * 隔て板（往復レーンの境界の壁）の材の範囲（世界の幅方向座標）。同じ軸 CL 上で走りが重なる壁（オーナー壁＋薄壁）の
 * materialRange の合併。wall が無ければ null。
 * @param {import('@core').Wall|null} wall
 * @param {object} wallGraph wall を見つけた graph
 * @returns {{lo:number, hi:number}|null}
 */
export function partitionStripOf(wall, wallGraph) {
  const mr = wall?.materialRange;
  if (!mr || !Number.isFinite(mr.lo) || !Number.isFinite(mr.hi)) return null;
  let lo = Math.min(mr.lo, mr.hi), hi = Math.max(mr.lo, mr.hi);
  const runOf = w => [Math.min(w.coord1, w.coord2), Math.max(w.coord1, w.coord2)];
  const [r0, r1] = runOf(wall);
  for (const w of graphList(wallGraph, 'walls') ?? []) {
    if (w === wall || w.axisCL !== wall.axisCL || w.isVertical !== wall.isVertical) continue;
    const [s0, s1] = runOf(w);
    if (!(Math.min(r1, s1) - Math.max(r0, s0) > GAP_EPS_MM)) continue;
    const r = w.materialRange;
    if (!r || !Number.isFinite(r.lo) || !Number.isFinite(r.hi)) continue;
    lo = Math.min(lo, r.lo, r.hi); hi = Math.max(hi, r.lo, r.hi);
  }
  return { lo, hi };
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
 * 仮想断面の視線の向きから図の左右（ローカル x 昇順の世界方向 dirSign）を決める面の方位規則
 * （ユーザー裁定 2026-10-15「仮想断面から見て通り芯の配置は一意に決まる」）。展開記号の採番
 * （elevationStairSequence.js の letterOf(isVertical, −viewSign)）と同じ規則で、全 cut に適用する。
 * @param {boolean} isVertical 切断線が縦（x=一定）か
 * @param {1|-1} viewSign 視線が向く世界方向の符号
 * @returns {1|-1}
 */
export function viewDirSign(isVertical, viewSign) {
  return DIR_SIGN[letterOf(isVertical, -viewSign)];
}

/**
 * face（composeRoomFacesの実面）の「ローカルx=0がどちら側の世界座標に対応するか」を、
 * 部屋の見た目上の向き（部屋の内側から見た letterOf 由来の dirSign）ではなく、呼び出し側が指定する
 * desiredDirSign（**その切断の視線の向き**から `viewDirSign` で決めた値。裁定 2026-10-15）へ
 * 再正規化する。切断線は面の壁芯ではなく室内側の仮想断面で、面と逆向きに見る切断（seq4 が wOut1 を
 * 復路側から見る等）では部屋の内側からの向きと左右が逆になるため、face をその切断の向きへ倒す。
 *
 * 背景: cut.dirSign（レイキャスト用にW(t,s)から独立に導出。ファイル冒頭コメント参照）だけを直しても、
 * floorSegments/ceilingProfile（elevationStairSequence.js側。face.run・face.dirSign由来のoriginWorld・
 * hasWallAtLocal0/Runを前提にした区間順）はface自身のdirSignのままズレて残るため、content
 * （cut.dirSign経由）とfloorSegments（face.dirSign経由）が食い違う——face自体をここで再正規化し、
 * 両方が同じ向きに揃うようにする。lo/hi/run/axisCL/faceValue/inward/isVertical/hasRealWall/kindは
 * 同じ物理壁を指す不変な性質のためそのまま維持し、「ローカルxの向き」に関する対の属性
 * （hasWallAtLocal0/Run・edgeAtLocal0/Run・startCLId/endCLId・partitionCutAtLocal0/Run）だけ
 * 入れ替える。face.dirSignが既にdesiredDirSignと一致するなら何もしない。
 *
 * **letter（展開記号）はdirSignに従って引き直す**（ユーザー実機指摘2026-08。旧実装は
 * 「同じ物理壁を指す不変な性質」としてletterを据え置いており、`DIR_SIGN[letter]===dirSign`
 * という面の不変条件が破れていた）——記号A/B/C/Dは視線の向き＝図の左→右がどちらの世界方向かで
 * 決まるため、ローカルxの向きを倒した時点で記号も入れ替わる（B⇄D・A⇄C）。
 * labelは呼び出し側（elevationStairSequence.js）が歩行順で採番し直すため、ここでは
 * letterと同値へ落とす（採番前の暫定値。据え置くと旧letterの連番が残って食い違う）。
 * 旧実装（2026-08〜2026-10-14）は desiredDirSign を歩行方向（往路が左・上り口が左）で決めており、
 * 回転方向によって鏡像になっていた（ファイル本文の dirSign 導出のコメント参照）。
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

export function buildMidWallFace(wall, inward, loWorld, hiWorld, faces, hasRealWall = true) {
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
    faceValue: wall.axisCL.effectiveValue, hasRealWall,
    lo, hi, run: hi - lo, originWorld: dirSign > 0 ? lo : hi,
    startCLId, endCLId, hasWallAtLocal0: hasRealWall, hasWallAtLocalRun: hasRealWall,
    kind: 'stairMid',
  };
}

/**
 * U字系（SWITCHBACK/WINDING）階段の切断定義表（§6.1）を組み立てる。WINDING は回転部を段付きの
 * 踊り場（stairContribution の turnCells を切断線で切ったもの）として同じ表に通す（seq3 の前縁+LANDING_CUT_INSET_MM も共通）。
 * U字系以外・stair.cellsが空・floorHeight未確定・面分類が解決できない・階段寄与が求まらない場合は
 * null（elevationStairSequence.jsのフォールバック契約と同じ）。
 *
 * 設計からの逸脱: §4の宣言シグネチャは`switchbackCuts(stair, graph, opts)`（faces無し）だが、
 * 本実装は`faces`（composeRoomFacesの結果）を第2引数として要求する（ファイル冒頭コメント参照）。
 * @param {import('@core').Stair} stair
 * @param {object[]} faces - composeRoomFaces(stairRoom, graph) の結果
 * @param {object} graph - 設置階のgraph
 * @param {{floorHeight:number, chUpperAbsMm:number, chLowerMm:number, upperGraph?:object,
 *   layers:object[]}} opts
 *   layers … 呼び出し側（elevationStair.jsのbuildStairBand）が`buildBandLayers`で1度組んだ層。
 *   **必須**（QA指摘F5: 本番はbuildStairBandが必ず渡すため、opts.upperGraphから作り直す
 *   「第2の入口」は本番に到達しない死コードだった）。配列でなければ既存の失敗系規約
 *   （対象外条件はnullを返す）にならい、他の未確定条件と同じくnullを返す。
 * @returns {{cuts:object[], wEntry:object, wLanding:object, wOut1:object, wOut2:object,
 *   wall:import('@core').Wall|null, kneeDrop:object|null, params:object, landingAbs:number,
 *   isSteel:boolean, contribution:object|null}|null}
 *   cuts の各要素は SectionCut 型 + {face, seqLabel} を持つ（faceは§3.5 faceFromCutと同型の
 *   代わりに、classifyFaces由来の実面をそのまま使う——理由は上記コメント参照）。
 */
export function switchbackCuts(stair, faces, graph, opts = {}) {
  if (!stair || !U_TURN_TYPES.has(stair.type)) return null;
  if (!stair.cells || stair.cells.size === 0) return null;
  const floorHeight = opts.floorHeight;
  if (floorHeight == null) return null;

  const params = resolveUTurnSectionParams(stair, graph, floorHeight);
  if (!params) return null;
  const { n1, riser, entryTurnSteps } = params;
  const landingAbs = (n1 + entryTurnSteps) * riser; // 取りつき回転部の蹴上を含む（sectionStair.js stairContribution の landingZ と同じ）
  const isSteel = stair.structure === StructuralMaterialType.STEEL;
  // ユーザー実機指摘2026-08「階段・踊り場下の描画方法は、下に部屋がある・なしで異なる。
  // 現時点の描画は下に部屋がある場合」: 階段下に部屋が**無い**なら、踊り場の下は同じ空間として
  // 設置階FL(=0)まで開いている——この帯の「床」も§5.6の基準床(baseFloorZ)も1FLになる。
  // 部屋が有る場合は従来どおり踊り場が基準床（その下は別室＝向こう側なので細破線へ降格）。
  // 判定は階段下部屋の唯一の情報源（stairUnderRoomsOf × cellsBeyondBreak）をそのまま使う
  // ——展開図が独自の判定を持つと、壁生成（stairUnderWalls.js）との食い違いが生まれるため。
  const { hasRoomUnder, underRooms } = stairUnderRoomInfo(stair, graph);
  const underFloorZ = hasRoomUnder ? landingAbs : 0;
  // 展開図一般化Phase 6: 階段帯自身の空気ボリューム＝階段室（`stair.roomId`）。
  // `section/sectionHits.js`の`isHiddenWall`が、壁の両側の連結成分をこのRoomの成分と比べる
  // ——ただし対象は`underRooms`（階段下に指定された部屋）に面する壁だけにスコープする
  // （`stairUnderRoomInfo`のコメント参照）。
  const stairRoom = stair.roomId ? graph.roomMap?.get(stair.roomId) ?? null : null;
  const underRoomSet = underRooms.length > 0 ? new Set(underRooms) : null;

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

  // 階段の3D寄与。走行方向の位置（往路の終端 frontA・復路側の前縁 front・踊り場の奥 back）は平面の解決値
  // （stairContribution が uTurnPlanLayout から取る）で、切断線の位置と歩行方向もここから導く。
  const contribution = stairContribution(stair, graph, floorHeight);
  if (!contribution) return null; // 平面の枠が求まらない（以降は contribution を前提にする）
  const { frontA: frameFrontA, front: frameFront, back: frameBack } = contribution.frame;

  // ==== 図の左右（dirSign）は**仮想断面の視線の向き**だけで決める（ユーザー裁定 2026-10-15）====
  // 歩行順に面を並べるのは正しいが、各面の通り芯の並びは視線の向きから一意に決まる（面の方位規則
  // `viewDirSign`＝DIR_SIGN[letterOf(isVertical, −viewSign)]。展開記号の採番と同じ）。上り口・踊り場が
  // 図の左右どちらに来るかは階段の回転方向（時計回り/反時計回り＝up/down×flip）次第で、
  // 「往路が左」「上り口が左」（2026-08 の reorientFace 導入 4303222）は「6」（up+flip=true）で方位規則と
  // たまたま一致していた決め打ちだった——逆の回転（moku3-1・opening-test・stair-ports-test4/5）では
  // seq1/2/4/5 が鏡像、seq3 は全文書で鏡像（2026-10-14 moku4-3 1階 C）になっていた。
  // 歩行順に依存する下流（床区間の並び・CH 寸法の鎖の踊り場側）は `landingEnd`（この表が面ごとに
  // 宣言する踊り場側の端）から決める。
  // widthDirSign は seq2/4/5 の視線（towardS1/towardS0）にだけ使う。
  const widthDirSign = Math.sign(acrossCoordAt(1) - acrossCoordAt(0)) || 1;
  // seq1 の視線は上り口向き(−t)。切断位置は往路側の前縁 frontA（下の seq1Line 参照）。
  const seq1ViewSign = Math.sign(travelCoordAt(0) - frameFrontA) || 1;
  // seq3（踊り場の壁）の視線は踊り場奥向き(+t方向)＝seq1 の**逆**。前縁を奥に揃えた浅い踊り場
  // (front==back)でも往路の走行の向きにする（上り口側を向かない）。
  const seq3ViewSign = Math.sign(frameBack - frameFront) || contribution.flights[0].travelSign;
  // seq2/5 は往路レーン・復路レーンの中から復路側(s=1)を見る、seq4 は往路外側(s=0)を見る。
  const towardS1 = widthDirSign;   // 復路側(s=1向き)を見る（seq2・seq5）
  const towardS0 = -widthDirSign;  // 往路外側(s=0向き)を見る（seq4）
  const seq1DirSign = viewDirSign(rawFaces.wEntry.isVertical, seq1ViewSign);
  const seq3DirSign = viewDirSign(rawFaces.wLanding.isVertical, seq3ViewSign);
  const seq2DirSign = viewDirSign(rawFaces.wOut1.isVertical, towardS1);
  const seq4DirSign = viewDirSign(rawFaces.wOut1.isVertical, towardS0); // seq4はseq2の鏡像（逆向きを見る）

  const wEntry   = reorientFace(rawFaces.wEntry, seq1DirSign);
  const wLanding = reorientFace(rawFaces.wLanding, seq3DirSign);
  const wOut1    = reorientFace(rawFaces.wOut1, seq2DirSign);
  const wOut2    = reorientFace(rawFaces.wOut2, seq4DirSign);
  // 走行方向の面で踊り場がローカル x のどちらの端に来るか（'left'＝x=0 側／'right'＝run 側）。
  // 踊り場の壁 wLanding と上り口の壁 wEntry の世界座標の前後を、その面の dirSign で図の左右へ写す。
  const landingEndOn = face => ((wLanding.faceValue - wEntry.faceValue) * face.dirSign > 0 ? 'right' : 'left');

  const wallGraph = opts.upperGraph ?? graph;
  // 踊り場の奥行きは平面の解決値（frame の front〜back）から取る。CL 区間長（params.landingLen）は使わない。
  const landingDepthMm = Math.abs(frameBack - frameFront);
  const wall = findMidWall(wallGraph, wEntry, wLanding, landingDepthMm, f);
  // 往復レーンの境界（実機の「中心1」）。実壁があればその壁のCL、無ければ同位置の中心線を軸にする
  // ——seq2はこの面を見る（下の`face`の割り当てコメント参照）ため、壁の有無に関わらず面が要る。
  const midAcross = acrossCoordAt(0.5);
  const midCLType = wOut1.isVertical ? CenterLineType.VERTICAL : CenterLineType.HORIZONTAL;
  const midCL = wall?.axisCL ?? (graphList(graph, 'centerLines') ?? []).find(cl =>
    cl.centerLineType === midCLType && !isCeilingOnlyKind(cl) && Math.abs(cl.effectiveValue - midAcross) <= MID_WALL_TOL_MM) ?? null;
  const kneeDrop = wall ? kneeDropRecordFor(wall, wallGraph) : null;

  const ceilTopAbs = opts.chUpperAbsMm;
  const ceilLowAbs = opts.chLowerMm;

  const travelSign = Math.sign(wLanding.faceValue - wEntry.faceValue) || 1;
  const landingStartWorld = wLanding.faceValue - travelSign * landingDepthMm;
  const entryWorld = wEntry.faceValue;

  if (!Array.isArray(opts.layers)) return null; // QA指摘F5: opts.layersは必須（本番は必ず渡す）
  const layers = opts.layers;

  const zRangeUpper = { loZ: 0, hiZ: ceilTopAbs };

  // ==== 不変条件: cut.line.lo/hi は **その cut の face の lo/hi と一致させる** ====
  // ローカルxの原点はcut側が`cutOriginWorld(cut)=dirSign>0?line.lo:line.hi`（sectionTypes.js）、
  // face側が`originWorld=dirSign>0?lo:hi`（elevationFigure.jsのlocalXOf）で別々に決まる。
  // 枠がずれるとcontent全体が面に対して平行移動し、壁の仕上げ面より内側にささら断面が入る
  // （実機「6」D2: seq5のlineがwOut1枠(run 3442.5)・faceがwOut2(run 3340)で102.5ずれ、
  // 踊り場桁枠のささら断面が面の右端＝Y2壁の仕上げ面を突き抜けて壁の中に描かれていた）。
  // 切断線の**位置**(axisValue)はW(t,s)から導く値のままでよい——揃えるのは枠(lo/hi)だけ。

  // ---- seq1/seq3: 幅方向の全幅線。seq1は往路側の前縁 frontA（平面の往路の終端。隔て壁の柱の面。
  // 柱が無ければ復路側の前縁 front と同じ）、seq3は復路側の前縁 front から
  // LANDING_CUT_INSET_MMだけ踊り場側（2026-10-08。旧: 両者が前縁を共有。設計書§6.1表のseq3の
  // 元位置W(1)からの意図保存の逸脱で、wLandingを「距離のある見えがかり候補」として自然に検出
  // させるため）。枠(lo/hi)は各々のfaceに合わせる（上の不変条件）。
  // seq1 が frontA ちょうどにあるのは意図: 往路 flight の端（crossesFlight は境界を含む）に立ち、
  // 復路側は復路の初段付近を切る（踊り場ではなく復路の直進部。見え方が変わる前提）。
  const seq1Line = { isVertical: wEntry.isVertical, axisValue: frameFrontA, lo: wEntry.lo, hi: wEntry.hi };
  // 視線（seq1ViewSign＝上り口向き −t・seq3ViewSign＝踊り場奥向き +t）は上（dirSign の導出）で決めている。
  // seq3だけ踊り場側へ入れる（LANDING_CUT_INSET_MM。踊り場の奥行きが足りなければ前縁のまま）。
  // 向きは踊り場奥向き(+t)＝seq3ViewSignと同じ（視線の前方へ進める）。
  const seq3Inset = Math.abs(frameBack - frameFront) > LANDING_CUT_INSET_MM ? LANDING_CUT_INSET_MM : 0;
  const seq3Line = {
    isVertical: wLanding.isVertical, axisValue: frameFront + seq3ViewSign * seq3Inset,
    lo: wLanding.lo, hi: wLanding.hi,
  };

  // ---- seq2/4: 往路レーン中央 W(0,0.25→1,0.25)（走行方向の全長線。ユーザー実機
  // フィードバック2026-08-23で「レーン境界（100mmあき内）で切って往路側壁を見る」から
  // 「往路レーンの中を切って復路側／往路外側を見る」へ修正。切断線が往路Flightの中を通るため、
  // isLengthwiseCutが従来どおり成立し（flight.acrossLo/acrossHi内）、第3層はFlightを縦断する
  // 断面として扱う——cutAlongの対象はレーン境界の壁ではなく、往路レーンの中央そのものに
  // 実壁は無いため、cutAlong判定は発火しない（第1層は単にFlightを切る切断線を渡すだけ）。
  // seq5のみ復路レーン中央 W(0,0.75→1,0.75)を使う（ユーザー指示「seq5は現行の向きを踏襲」＝
  // 値としては従来のmidAcross基準の向きと同じtowardS1になる。詳細はtowardS1/towardS0参照）。
  const outboundLaneAcross = acrossCoordAt(0.25);
  const inboundLaneAcross = acrossCoordAt(0.75);
  // 枠(lo/hi)は各々のfaceに合わせる（上の不変条件）——outboundLaneLineはseq2/4がwOut1枠の面
  // （midOutFaceは`...wOut1`で枠を引き継ぐ）を見るのでwOut1、inboundLaneLineはseq5がwOut2の
  // 面を見るのでwOut2。
  const outboundLaneLine = { isVertical: wOut1.isVertical, axisValue: outboundLaneAcross, lo: wOut1.lo, hi: wOut1.hi };
  const inboundLaneLine = { isVertical: wOut2.isVertical, axisValue: inboundLaneAcross, lo: wOut2.lo, hi: wOut2.hi };
  // sectionProbe.jsのisSightlineShape契約: (shape.axisCL.effectiveValue - line.axisValue) * viewSign > 0
  // が見えがかり候補——「s=1側が見える」viewSignは、line位置に関わらずwidthDirSignと同符号になる
  // （0.25→1・0.5→1・0.75→1のいずれも同じ向き。s<1の基準点なら常に成り立つ幾何）。
  // towardS0はその逆符号（s=0側=往路外側の壁が見える向き）。
  // towardS1/towardS0 は上（dirSign の導出）で決めている。

  // 階段第3層（stairContribution）は各cutで該当するレーンのみを渡す——outboundLaneLineは
  // seq2/4が共有するため（同じ切断線をtowardS1/towardS0の逆向きから見る）、
  // どちらのレーンを描くかは切断線の幾何だけでは自明でも、視線前方に来る「他レーン」の判定
  // （見えがかりのささら等）は別途必要——切断定義表（本ファイル）が「どちらの歩行順シーケンスか」を
  // 知っている唯一の場所であるため、ここでレーンを明示的に選ぶ（WP-E5bリスク3の対応。
  // 2026-08-23実機修正でも維持）。
  const outboundFlight = contribution?.flights?.[0] ?? null;
  const inboundFlight = contribution?.flights?.[1] ?? null;
  // cut ごとの寄与は contribution の展開で作る（isVertical・frame・turnCells を落とさない）。
  const outboundWithLanding = outboundFlight
    ? { ...contribution, flights: [outboundFlight] } : null;
  // seq3（踊り場の壁。W_landing）用: 踊り場だけを渡す。旧実装は§6.1表の「階段寄与: なし」を
  // そのままstairCut:nullにしていたが、ユーザー実機指摘2026-08「6」A「踊り場断面線、その左右壁
  // との取り合いに（折返し階段外回りの）ささら断面、上下にささらの見えがかり（横線2本）」——
  // 「階段（段）の重ね描きなし」であって、踊り場そのものの断面・桁枠は必要だった。
  // flightsは空のまま＝段の梯子・ジグザグは出ない（表の意図は維持する）。
  const landingOnly = ((contribution.landings ?? []).length > 0 || (contribution.turnCells ?? []).length > 0)
    ? { ...contribution, flights: [] }
    : null;
  // 復路+踊り場。seq5（D2＝復路レーンから外側の壁を見る面）が使う——ユーザー実機指摘2026-08
  // 「踊場断面は図の右側、階段断面は左側に現れる」。
  const inboundWithLanding = inboundFlight
    ? { ...contribution, flights: [inboundFlight] }
    : null;
  // 旧seq2.5/4.5（往路・復路を分けて描く面）は、seq2/4と切断線・視線・向き・層・z範囲が同一で
  // 違いが無いため2026-10-07に廃止した（ユーザー指示「差異がなければ、一本で」）。
  // WP-2026-08-23実機フィードバック「往路と復路の間に壁が無ければ復路直進部のささらが見える」
  // 対応: seq2のみ、視線前方（towardS1）にある復路(inbound)をsecondaryFlightsとして渡す
  // （sectionStair.jsのstairPrimitivesForCutが壁の有無をcolumns経由で判定し、無ければ
  // 近い側のささらだけを見えがかりで描く）。壁が実在すれば壁自体がisBlockedByWallで検出され
  // 常に非表示になる。seq4（towardS0）には復路が視線の背後なので付与しない（seq2のみに限定）。
  const outboundWithLandingSeq2 = outboundWithLanding && inboundFlight
    ? { ...outboundWithLanding, secondaryFlights: [inboundFlight] } : outboundWithLanding;

  // QA修正: buildMidWallFaceが内部で導くdirSign（letterOf由来のコンパス基準）も部屋の向きに
  // 依存するため、reorientFaceでseq2DirSignへ再正規化する（wEntry/wOut1等と同じ理由）。
  // seq2が見る面（往復レーンの境界＝中心1）。**描画枠はwOut1のまま**（lo/hi/run/originWorld/
  // dirSign/端の状態）にして、面の**同定**（どの平面をどちら側から見ているか＝axisCL・faceValue・
  // inward・letter）だけを中心1のものへ差し替える——contentもfloorSegments/ceilingProfileも
  // 走行方向の全長（上り口〜踊り場奥）を前提に組まれており、範囲を変えると座標がずれるため。
  // これで「図の向き（西向き＝D）」と「面の幾何」が一致し、面由来の寸法・向こう側判定が
  // 正しい側を向く。
  const midOutFace = midCL ? {
    ...wOut1,
    axisCL: midCL, faceValue: midCL.effectiveValue, inward: wOut2.inward,
    letter: letterOf(wOut1.isVertical, wOut2.inward),
    hasRealWall: !!wall, kind: 'stairMid',
  } : null;

  // 隔て板が上階の隔て板へ続く（自階にも上階にも往復間の実壁がある＝木造の U 字階段で最上階でない）とき、seq1（幅方向に
  // 隔て板を横切る切断）では隔て板を床から天井断面線までの 1 本の断面にする（sectionEngine.js buildColumns が
  // 自階の壁の帯と上階の壁の帯を合併する。ユーザー指示 2026-10-15「moku4-3 1階 階段 A: 隔て板の断面線は床断面から天井断面線まで」。
  // 裁定「木造階段の最上階は除く＝従来どおり天板〔隔て板の天端〕の見え掛かり」: 上階に隔て板が無ければ付けない）。
  const ownMidWall = findMidWall(graph, wEntry, wLanding, landingDepthMm, f);
  const continuousPartition = wall && ownMidWall && wallGraph !== graph ? partitionStripOf(wall, wallGraph) : null;
  const cuts = [
    {
      seqNo: '1', face: wEntry, line: seq1Line, viewSign: seq1ViewSign, dirSign: wEntry.dirSign,
      openGapMarks: false, // 踊り場前縁・回転部にアキは標記しない（ユーザー指示2026-10-07）
      layers, zRange: zRangeUpper, baseFloorZ: underFloorZ, chDimSplitAbsYs: [floorHeight],
      stairCut: contribution, // 往路・復路とも正面梯子として重なるため両方渡す（§6.1「往路=正面梯子(下)／復路=正面梯子(上)」）
      ...(continuousPartition ? { continuousWallAcross: continuousPartition } : {}),
    },
    {
      // ==== ユーザー明示指示2026-08その11（面と切断の食い違い）====
      // 「A,B,C,Dの抽出と、順番決めロジックがごっちゃになっている」「展開の向きは絶対。後から順番」
      // 「D1を東向きと解釈するロジックに間違いがある」。
      // **cutのfaceは「その切断が見ている面」でなければならない**——seq2は往路レーンの中を切って
      // towardS1（＝往復レーンの境界＝中心1の側）を見る面なので、面も中心1のものになる。
      // 旧実装はここに`wOut1`（＝視線の**背後**にある往路外側の壁）を結び付けていたため、
      // 図の向き（西向き=D）と面の幾何（東向きの壁）が食い違い、面由来の寸法・向こう側判定が
      // 反対側を向いていた（実機「6」D1が、向こうに壁の無いはずの面で1500+2000に割れた）。
      // 中心1のCLが引けない構成では従来どおりwOut1へフォールバックする。
      seqNo: '2', face: midOutFace ?? wOut1, line: outboundLaneLine, viewSign: towardS1, dirSign: seq2DirSign,
      landingEnd: landingEndOn(wOut1),
      // レーン境界に**自階の実壁**（隔て板）があればアキを標記しない——隔て板の上・端の先は同じ階段室の
      // 空気で、面の抜けではない（ユーザー裁定2026-10-14「バツは不要」）。隔て板は階段室の自階の壁なので
      // `wall`（upperGraph 優先の探索）ではなく自階の graph で探す。上階側だけにある往復間の壁（2F の腰壁等）の
      // 上のアキは従来どおり標記する（「6」C の裁定2026-09を保つ）。自階に実壁が無い（鉄骨等）ときも従来どおり。
      ...(midOutFace && findMidWall(graph, wEntry, wLanding, landingDepthMm, f) ? { openGapMarks: false } : {}),
      layers, zRange: zRangeUpper, baseFloorZ: 0, stairCut: outboundWithLandingSeq2,
    },
  ];
  cuts.push({
    seqNo: '3', face: wLanding, line: seq3Line, viewSign: seq3ViewSign, dirSign: wLanding.dirSign,
    openGapMarks: false, // 同上（踊り場の壁を見る面にもアキは標記しない）
    // §6.1表「階段寄与: なし」＝段の重ね描きなし。踊り場の断面・桁枠は描く（landingOnly参照）。
    // 平場の踊り場: 踊り場レベルより上だけを描く（下は描かない。下限・基準床とも踊り場。ユーザー裁定2026-10-08）。
    layers, zRange: { loZ: landingAbs, hiZ: ceilTopAbs }, baseFloorZ: landingAbs, stairCut: landingOnly,
  });
  // QA実機フィードバック修正: seq4のstairCutは復路(inbound)ではなく往路(outbound)——
  // seq4はwOut2を「反対側(復路レーン)から見た往路の鏡像」として見せる面であり
  // （dirSignがseq2の逆＝踊り場側の端が seq2 と逆になる。landingEnd）、復路をここに描くと踊り場側が
  // 低く上り口側が高くなり実機の見え方（往路の断面をwOut1側からwOut2側へ鏡映しただけ）と矛盾する。
  // 面はseq2と同じ規則で「見ている側」——seq4はtowardS0（往路外側）を見るのでwOut1になる
  // （旧実装はwOut2＝視線の背後の壁だった。上のseq2のコメント参照）。
  const face4 = reorientFace(wOut1, seq4DirSign);
  cuts.push({
    seqNo: '4', face: face4, line: outboundLaneLine, viewSign: towardS0, dirSign: seq4DirSign,
    landingEnd: landingEndOn(face4),
    layers, zRange: zRangeUpper, baseFloorZ: underFloorZ, stairCut: outboundWithLanding,
  });
  {
    // ==== ユーザー実機指摘2026-08「6」D2（面の取り違え）====
    // seq5は「復路レーンの中を切って9時方向＝復路が接している外側の壁（wOut2）を見る」面。
    // 旧実装は`clipFaceToWorldRange(wOut2, landingStartWorld, entryWorld)`で**レーン区間だけに
    // 切り詰めた**面を使っていた（実機で run=2442.5・両端とも壁なし）ため、踊り場ぶんが figure に
    // 入らず「Y2が3500の右」「踊場断面は図の右側・階段断面は左側」という構図にならなかった。
    // 面は**wOut2の全長**（踊り場ぶんを含む）を使い、向きはseq2と同じ視線（towardS1）で決める
    // ——「6」の回転ではユーザー指定「踊場断面は図の右側、階段断面は左側に現れる」になる
    // （踊り場側の端は回転方向次第。landingEnd）。
    // stairCutも復路だけでは踊り場の断面が出ないため、踊り場を含めて渡す。
    const retFace5 = reorientFace(wOut2, seq2DirSign);
    cuts.push({
      seqNo: '5', face: retFace5, line: inboundLaneLine, viewSign: towardS1, dirSign: seq2DirSign,
      landingEnd: landingEndOn(retFace5),
      layers, zRange: zRangeUpper, baseFloorZ: underFloorZ, stairCut: inboundWithLanding,
    });
  }

  // 全cutが同じ階段室の空気ボリューム・同じ階段下部屋の集合を主語にする（isHiddenWall参照）。
  // cutごとに書き分ける理由が無いためここで一括して載せる——「どのcutが何を見るか」の唯一の
  // 情報源はこの切断定義表。
  if (stairRoom && underRoomSet) for (const c of cuts) { c.airRoom = stairRoom; c.underRooms = underRoomSet; }

  return {
    cuts, wEntry, wLanding, wOut1, wOut2, wall, kneeDrop, params, landingAbs, underFloorZ, hasRoomUnder, isSteel, contribution,
    ceilTopAbs, ceilLowAbs, entryWorld, landingStartWorld,
  };
}
