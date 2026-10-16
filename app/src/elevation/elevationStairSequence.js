/**
 * 展開図: 階段の歩行順面シーケンス（WP-S2→WP-E5→WP-E5b→WP-E6でエンジン化・タイプ拡張）。
 * 設計意図は .claude/elevation-model.md・.claude/stair-model.md 参照。純モジュール
 * （store.js/snap.js/*.jsx/react-konva/appViewport.jsを静的importしない）。
 *
 * WP-E5/E5b: SWITCHBACK専用の切断定義表・エンジン化については `section/cuts/switchbackCuts.js`
 * のヘッダコメント参照（面の分類・往復間の壁の検出・断面パラメータ解決の委譲先）。
 * WP-E6: タイプ別ディスパッチを追加した——SWITCHBACK→`switchbackCuts`（従来どおり手組みの
 * entries組み立て＋contentForCut）、STRAIGHT/STRAIGHT_LANDING→`straightCuts`（§6.2。
 * face/floorSegments/ceilingProfileの算出もエンジン汎用の`buildSectionFigure`にそのまま
 * 委ねる——直進階段は往路・復路の二重管理が無い単純な1本道のため）、
 * WINDING/L_TURN/FLARED/OPEN_WELL（扇形レーン。`fanCuts.js`）→常にnull。
 * いずれもnullを返す場合は呼び出し側（elevationStair.jsのbuildStairBand）が従来の
 * composeRoomFaces+rotateFacesToStart のフォールバック経路を使う（フォールバック契約自体は
 * WP-E6でも不変。対象タイプが増えただけ）。
 *
 * 返り値の型は一切変えない（{seqNo,face,floorSegments,ceilingProfile?,chDimSplitAbsYs?,
 * content,skipBaseboard,skipWallLabel,floorSpanX?}[]）。
 *
 * SWITCHBACKのシーケンス（歩行順。各cutの切断線・視線方向・第3層データはswitchbackCuts.js
 * §6.1参照）:
 *   1   踊り場前縁（見返り・全幅）: 往路・復路の踏面梯子線を重ねる（踊り場より下の往路は破線）。
 *   2   W_out1（実際の壁面。上り口端〜踊り場前縁まで）: 往路の断面プロファイル＋踊り場区間の
 *       床・天井断面線＋往復間の壁（実在すれば）の断面。
 *   3   W_landing（全幅）: 踊り場の壁。階段の重ね描きなし。
 *   4   W_out2（seq2の鏡像構成）: 復路の断面プロファイル＋往復間の壁の断面。
 *   （旧2.5/4.5＝レーン境界の面は、2/4と切断が同一のため2026-10-07に廃止）
 *   5   W_out2の残り区間: 復路の断面を反対側から見た図（「6」の回転では踊り場が右端。踊り場側の端は
 *       回転方向次第＝切断定義表の landingEnd。裁定 2026-10-15）。
 *
 * STRAIGHT/STRAIGHT_LANDINGのシーケンス（§6.2。straightCuts.js参照）:
 *   1 上り口端（全幅） / 2 W_out1（s=0側の断面プロファイル） /
 *   3 到達端（全幅。STRAIGHT_LANDINGは踊り場壁が実在する場合のみ挿入。無ければ3は到達端のまま）/
 *   （STRAIGHT_LANDINGのみ）4 W_out2（s=1側） / 5 到達端（全幅）。
 */
import { StairType } from '@core';
import { switchbackCuts, partitionStripOf } from './section/cuts/switchbackCuts.js';
import { straightCuts } from './section/cuts/straightCuts.js';
import { UNSUPPORTED_FAN_LANE_TYPES, fanLaneCuts } from './section/cuts/fanCuts.js';
import { makeProbeContext } from './section/sectionProbe.js';
import { buildSectionFigure } from './section/sectionEngine.js';
import { buildCutContent, upperFloorCutWallEndsOf } from './section/sectionContent.js';
import { cutDrawRange, localXOf, worldOf } from './section/sectionTypes.js';
import { layerDirectlyAboveSelf, isRealRoom } from './section/sectionLayerStack.js';
import {
  splitGapMarksByStair, dashHorizontalsBehindStair,
  joinToStairProfile, emitLine,
} from './section/sectionEmit.js';
import {
  stairPrimitivesForCut, stairFaceOccluderRects, stairCutFloorProfile, crossingLandingFloorProfile, HIDDEN_STEP_MARK,
  flightStartOuterBound, mergeOuterBounds, clipWallEndVerticalsByStairMass, crossingFlightBodySections,
} from './section/sectionStair.js';
import { stairSoffitSolids } from '../ceiling/stairSoffit.js';
import { riserOf } from '../finish/stair/stairDimensions.js';
import { structuralContribution, structuralPrimitivesForCut } from './section/sectionStructure.js';
import { stairSectionIsClosed } from './elevationStairSection.js';
import { worldToCell, roomBounds } from '../finish/gridCells.js';
import { labelFaces, letterOf, upperFloorEndsOf, wallLessEndAt, wallContinuationBeyondFaceEnd } from './elevationFaces.js';
import {
  collectRunBreaks, clipContentAboveDrawnProfile, clipHiddenSegmentBelowProfile, clipHiddenSegmentAboveProfile,
  floorProfileFromSegments, mergeFloorProfiles, drawnFloorProfileZMax, drawnFloorProfileZAt,
} from './elevationFloorProfile.js';
import { stairSoffitChAlong } from './space/stairSoffitCeiling.js';
import { PARTITION_THICKNESS_MM } from '../finish/stair/stairPartition.js';
import { stairUnderReturnSoffit } from './section/sectionProbe.js';
import {
  GAP_EPS_MM as GAP_EPS, PROBE_EPS_MM, DEFAULT_WALL_LESS_END_EXTEND_MM, ElevationLineRole, weightForRole,
} from './elevationStyle.js';
import { graphList } from '../graphReadScope.js';
import { parseBaseboardHeightMm } from './elevationFigure.js';

// ---- 復路下の仕上げ空間（木造の復路下の壁。.claude/data-model.md「復路下の壁」）----

/**
 * 復路レーンを縦断する切断 cut で、復路の下の仕上げ空間（復路下の壁〜到達辺。木造 U 字系で復路下の壁が立つ階段だけ）の
 * 断面ローカル x の範囲と、その天井＝復路の裏面（自階の階段。壁の天端 addUnderReturnTops と同じ供給源 stairUnderReturnSoffit）の節列を返す。
 * 復路下の壁が無い（鉄骨・下階に続き階段がある・隔て壁なし）・切断線が壁と交差しない・裏面が組めないときは null。
 * @param {import('@core').Stair} stair
 * @param {object} graph
 * @param {object} cut seq5 の切断（line・dirSign・landingEnd）
 * @param {number} floorHeight 階高（蹴上の推定）
 * @param {number} floorZMm 階段室の床の絶対 z（層スタックの floorZFor）
 * @returns {{loX:number, hiX:number, wallLoX:number, wallHiX:number, onLo:boolean, soffit:Array<{x:number, z:number, gapBefore:boolean}>}|null}
 */
export function underReturnSpaceOf(stair, graph, cut, floorHeight, floorZMm, ceilAbsMm = null) {
  if (!cut?.line) return null;
  const found = stairUnderReturnSoffit(stair, graph, { floorHeight, floorZMm });
  if (!found || found.line.isVertical === cut.line.isVertical) return null;
  const { walls, solid } = found;
  // 壁の幅方向の区間に切断線の深さが入る（壁は切断線と直交する）
  const depth = cut.line.axisValue;
  const spanLo = Math.min(...walls.map(w => Math.min(w.coord1, w.coord2)));
  const spanHi = Math.max(...walls.map(w => Math.max(w.coord1, w.coord2)));
  if (depth < spanLo - GAP_EPS || depth > spanHi + GAP_EPS) return null;
  const ranges = walls.map(w => w.materialRange);
  const xa = localXOf(cut, Math.min(...ranges.map(r => r.lo)));
  const xb = localXOf(cut, Math.max(...ranges.map(r => r.hi)));
  const wallLoX = Math.min(xa, xb), wallHiX = Math.max(xa, xb);
  // 仕上げ空間は壁の踊り場と反対側（到達辺まで）。踊り場側は cut.landingEnd（面の向きから決まる）。
  // 範囲は壁の仕上げ空間側の面まで（壁の断面線は階段下スペース側の面だけ。壁の厚みの中・踊り場側の面・天端は、壁の向こうの
  // 段の裏の断面線の下＝描かない側。ユーザー指示 2026-10-15）。
  const xMin = Math.min(localXOf(cut, cut.line.lo), localXOf(cut, cut.line.hi));
  const xMax = Math.max(localXOf(cut, cut.line.lo), localXOf(cut, cut.line.hi));
  const onLo = cut.landingEnd !== 'left';
  const loX = onLo ? xMin : wallHiX, hiX = onLo ? wallLoX : xMax;
  const wallFaceX = onLo ? wallLoX : wallHiX;
  if (hiX - loX <= GAP_EPS) return null;
  const wa = worldOf(cut, loX), wb = worldOf(cut, hiX);
  const nodes = stairSoffitChAlong({ solid, floorStepMm: 0 }, {
    isVertical: cut.line.isVertical, depthCoord: depth, lo: Math.min(wa, wb), hi: Math.max(wa, wb),
  });
  if (!nodes || nodes.length < 2) return null;
  const soffit = nodes.map(n => ({ x: localXOf(cut, n.run), z: n.ch, gapBefore: n.gapBefore === true }));
  // 到達辺側の端の高さは Y4＋壁厚/2（裏面の始まり＝最上段の段板の前縁）と FL＋CH の交点（ユーザー指示 2026-10-15
  // 「天井線の Y4 側は、Y4＋壁厚/2 と FL＋CH の交点から」）——天井仕上げの断面線はそこから壁へ下る 1 本の線。
  // CH が裏面の実高より高い（天井仕上げが段板の中に入る）ときは裏面の実高のまま（仕上げは構造より上に置けない）。
  if (Number.isFinite(ceilAbsMm)) {
    const edge = soffit.reduce((a, n) => (onLo ? (n.x < a.x ? n : a) : (n.x > a.x ? n : a)), soffit[0]);
    edge.z = Math.min(ceilAbsMm, edge.z);
  }
  // 壁の天端（sectionProbe.js stairUnderReturnSoffit＝壁の天端 addUnderReturnTops と同じ値）。断面エンジンが引く壁の面の
  // 縦線はここまでなので、天井仕上げの断面線の端まで縦線を延ばす（underReturnCeilingPrimitives）
  return { loX, hiX, wallLoX, wallHiX, wallFaceX, wallTopZ: found.wallTopZ, onLo, soffit };
}

/**
 * 断面線 profile の [lo, hi] を床の高さ z に置き換える（復路下の仕上げ空間は床まで描く）。範囲の外は不変で、
 * 境目で高さが違えば垂直の段になる。
 */
export function floorProfileWithFloorOn(profile, lo, hi, z) {
  if (!profile?.length) return profile;
  const out = [];
  const push = (x, zz) => {
    const last = out[out.length - 1];
    if (last && Math.abs(last[0] - x) <= GAP_EPS && Math.abs(last[1] - zz) <= GAP_EPS) return;
    out.push([x, zz]);
  };
  for (const [x, zz] of profile) if (x < lo - GAP_EPS) push(x, zz);
  if (out.length > 0) push(lo, drawnFloorProfileZAt(profile, lo - 1e-3));
  push(lo, z); push(hi, z);
  const after = profile.filter(([x]) => x > hi + GAP_EPS);
  if (after.length > 0) push(hi, drawnFloorProfileZAt(profile, hi + 1e-3));
  for (const [x, zz] of after) push(x, zz);
  return out;
}

/**
 * 復路下の仕上げ空間の中で、復路の本体（下面＝裏面 `space.soffit`、上面＝段板の上面＝床へ下げる前の断面線 `space.bodyTop`）の
 * **中**にある content（壁の断面・見えがかり・アキ・建具の姿）を落とす。裏面と段板の間は断面の中で、仕上げ空間からも階段室からも
 * 見えない（stair-ports-test5: 空間の奥の開放辺のアキ・遠側の天井線が段板の中を通っていた）。本体より上（復路の上の空間）は残す。
 * 範囲は裏面の節列が覆う x だけ（到達辺の外・壁の先は触らない）。clipContentAboveDrawnProfile を 2 回使う: 裏面より下は z を反転
 * して（輪郭より下を残す規約を上下逆に）、本体より上はそのまま（範囲の外は +∞ で落とし、範囲は境界の縦線を二重に残さないよう僅かに
 * 内側へ縮める）。bodyTop が無ければ裏面より上を全部落とす。
 * @param {object[]} prims
 * @param {{soffit:Array<{x:number, z:number}>, bodyTop?:Array<[number, number]>|null}|null} space
 */
export function clipContentInsideStairBody(prims, space) {
  if (!space?.soffit?.length || prims.length === 0) return prims;
  const BIG = 1e9;
  const nodes = [...space.soffit].sort((a, b) => a.x - b.x);
  const x0 = nodes[0].x, x1 = nodes[nodes.length - 1].x;
  if (x1 - x0 <= GAP_EPS) return prims;
  const flip = p => {
    if (p.type === 'line') return { ...p, y1: -p.y1 || 0, y2: -p.y2 || 0 };
    if (p.type === 'polyline') return { ...p, points: p.points.map(([x, y]) => [x, -y || 0]) };
    if (p.type === 'rect') return { ...p, y: -(p.y + (p.h ?? 0)) || 0 };
    if (p.type === 'text') return { ...p, y: -p.y || 0 };
    return p;
  };
  // 2 回のクリップの結果が排他になるよう、対象を分ける: line/polyline/text は交点で割れるので両方に通す。rect（建具の姿）は
  // 範囲の内外で x 方向に割り、範囲の中の片は裏面より下だけ残す（上面より上の建具は復路の上には無い）。それ以外の型・
  // 範囲に掛からない図形は 1 回だけ素通し。範囲の端ちょうどの縦線は「段の低い側」の規則で切らない（既知の限界）。
  const xsOf = p => (p.type === 'polyline' ? p.points.map(q => q[0]) : p.type === 'rect' ? [p.x, p.x + (p.w ?? 0)] : [p.x1 ?? p.x, p.x2 ?? p.x]);
  const inRange = p => { const xs = xsOf(p).filter(Number.isFinite); return xs.length > 0 && Math.max(...xs) >= x0 - GAP_EPS && Math.min(...xs) <= x1 + GAP_EPS; };
  const soffitProfile = nodes.map(n => [n.x, n.z]);
  const soffitMinOn = (a, b) => Math.min(drawnFloorProfileZAt(soffitProfile, a), drawnFloorProfileZAt(soffitProfile, b),
    ...nodes.filter(n => n.x > a + GAP_EPS && n.x < b - GAP_EPS).map(n => n.z));
  const passThrough = [], candidates = [];
  for (const p of prims) {
    if (!['line', 'polyline', 'rect', 'text'].includes(p.type) || !inRange(p)) { passThrough.push(p); continue; }
    if (p.type !== 'rect') { candidates.push(p); continue; }
    const xa = p.x, xb = p.x + (p.w ?? 0);
    const pieces = [[xa, Math.min(xb, x0)], [Math.max(xa, x0), Math.min(xb, x1)], [Math.max(xa, x1), xb]];
    pieces.forEach(([a, b], i) => {
      if (b - a <= GAP_EPS) return;
      if (i !== 1) { passThrough.push({ ...p, x: a, w: b - a }); return; }
      // 範囲の中の片: 上端を裏面（片の x 範囲の最低）まで詰める。裏面より上だけなら落とす
      const zTop = -p.y, zBot = -(p.y + (p.h ?? 0)), zCap = Math.min(zTop, soffitMinOn(a, b));
      if (zCap - zBot > GAP_EPS) passThrough.push({ ...p, x: a, w: b - a, y: -zCap || 0, h: zCap - zBot });
    });
  }
  // 裏面より下（範囲の外は全部残す）
  const belowProfile = [[-BIG, -BIG], [x0, -BIG], ...nodes.map(n => [n.x, -n.z]), [x1, -BIG], [BIG, -BIG]];
  const below = clipContentAboveDrawnProfile(candidates.map(flip), belowProfile).map(flip);
  if (!space.bodyTop?.length) return [...passThrough, ...below];
  // 本体より上（範囲の内側だけ。境界は GAP_EPS×3 内側へ）
  const inner0 = x0 + 3 * GAP_EPS, inner1 = x1 - 3 * GAP_EPS;
  if (inner1 - inner0 <= GAP_EPS) return [...passThrough, ...below];
  const top = space.bodyTop.filter(([x]) => x > inner0 && x < inner1);
  const aboveProfile = [[-BIG, BIG], [inner0, BIG], [inner0, drawnFloorProfileZAt(space.bodyTop, inner0)], ...top,
    [inner1, drawnFloorProfileZAt(space.bodyTop, inner1)], [inner1, BIG], [BIG, BIG]];
  const above = clipContentAboveDrawnProfile(candidates, aboveProfile);
  return [...passThrough, ...below, ...above];
}

/**
 * 復路下の仕上げ空間の天井（復路の裏面）の断面＝天井仕上げの断面線（他の天井断面線と同じ太さ）。足元の途切れでは分ける。
 * 到達辺側の端は Y4＋壁厚/2 と FL＋CH の交点（underReturnSpaceOf が節の高さを置き換え済み）。壁側の端では、壁の仕上げ空間側の
 * 面の縦線を、断面エンジンが引く天端（壁の厚みの最も低い点の裏面）から天井仕上げの断面線の端まで太線で延ばす
 * （壁の断面線は階段下スペース側の面だけ。ユーザー指示 2026-10-15）。
 */
function underReturnCeilingPrimitives(space) {
  const weight = weightForRole(ElevationLineRole.SILHOUETTE);
  const out = [];
  let run = [];
  const flush = () => { if (run.length > 1) out.push({ type: 'polyline', points: run, weight }); run = []; };
  for (const n of space.soffit) {
    if (n.gapBefore) flush();
    run.push([n.x, -n.z || 0]);
  }
  flush();
  // 壁側の端＝仕上げ空間が lo 側なら断面ローカル x の最大の節、hi 側なら最小の節（節列は世界の走り座標の昇順なので、
  // dirSign<0 の面では配列の先頭・末尾と逆になる）
  const wallEnd = space.soffit.reduce((a, n) => (space.onLo ? (n.x > a.x ? n : a) : (n.x < a.x ? n : a)), space.soffit[0]);
  if (wallEnd && Number.isFinite(space.wallTopZ) && wallEnd.z - space.wallTopZ > GAP_EPS) {
    out.push({ type: 'line', x1: wallEnd.x, y1: -space.wallTopZ || 0, x2: wallEnd.x, y2: -wallEnd.z || 0,
      weight: weightForRole(ElevationLineRole.CUT) });
  }
  return out;
}

// 到達辺の外側の部屋を引く点を、到達辺から面の外へ離す量（セル境界ちょうどの不安定さを避ける）。
const UNDER_RETURN_BEYOND_PROBE_MM = 100;

/**
 * 復路下の仕上げ空間の巾木（ユーザー指示 2026-10-15「階段下スペースは『ホール』なので巾木が見える」）。
 * 巾木の高さの出どころは到達辺の壁の有無で決まる（RoomFinish.baseboardHeight を図側と同じ parseBaseboardHeightMm で解釈）:
 * 到達辺側の面の端に壁が**無い**（空間がホールへ開いている）ときは**到達辺の外側の部屋**＝ホールの一部として見えるのでその巾木、
 * 壁が**ある**ときは外側の部屋は壁の向こうなので使わず、階段室自身（stairRoom）の巾木。
 * 範囲は「壁のある範囲だけ・面の端で止める」規則どおり、到達辺（面の端）から復路下の壁の仕上げ空間側の面（wallFaceX）まで
 * （壁のはね出しへは伸ばさない。復路下の壁自身は断面なので巾木を引かない）。到達辺の外に部屋が無い・巾木が解釈できない・
 * 裏面より高いときは引かない。
 * @param {{loX:number, hiX:number, wallFaceX:number, onLo:boolean, soffit:Array<{x:number, z:number}>}} space
 * @param {object} cut seq5 の切断（line）
 * @param {object} probeCtx makeProbeContext の結果（cellAt）
 * @param {{graph:object, role:string}|null} selfLayer
 * @param {number} floorZ 仕上げ空間の床の z（階段室の床）
 * @param {object|null} stairRoom 階段室（到達辺に壁があるときの巾木の出どころ）
 * @param {object} graph 階段室の階（面の壁が到達辺の外へ続く長さを引く）
 * @param {number} endExtendMm 壁のない端部の延長量（巾木のはね出しの上限）
 * @returns {object[]}
 */
function underReturnBaseboardPrimitives(space, cut, probeCtx, selfLayer, floorZ, stairRoom, graph, endExtendMm) {
  if (!selfLayer || typeof probeCtx?.cellAt !== 'function') return [];
  let arrivalX = space.onLo ? space.loX : space.hiX;
  const hasWallAtArrival = (space.onLo ? cut.face?.hasWallAtLocal0 : cut.face?.hasWallAtLocalRun) !== false;
  let room = stairRoom;
  if (!hasWallAtArrival) {
    // 巾木は壁面に沿う部材: 面の壁が到達辺の外へ続く範囲（壁のない端部の延長量まで）は、その小口まで伸ばす（2026-10-15）
    const beyond = cut.face ? wallContinuationBeyondFaceEnd(cut.face, graph, space.onLo ? '0' : 'Run', endExtendMm) : 0;
    arrivalX += (space.onLo ? -1 : 1) * beyond;
    const run = worldOf(cut, (space.onLo ? space.loX : space.hiX) + (space.onLo ? -1 : 1) * UNDER_RETURN_BEYOND_PROBE_MM);
    const [wx, wy] = cut.line.isVertical ? [cut.line.axisValue, run] : [run, cut.line.axisValue];
    room = probeCtx.cellAt(selfLayer, wx, wy)?.room ?? null;
  }
  const h = parseBaseboardHeightMm(room?.finish?.baseboardHeight);
  if (h == null) return [];
  const z = floorZ + h;
  if (z >= Math.min(...space.soffit.map(n => n.z)) - GAP_EPS) return [];
  return [{ type: 'line', x1: arrivalX, y1: -z || 0, x2: space.wallFaceX, y2: -z || 0, weight: weightForRole(ElevationLineRole.DETAIL) }];
}

function flatFloorSegments(run, floorDeltaMm, chMm) {
  return [{ loX: 0, hiX: run, floorDeltaMm, chMm }];
}

// ==== ユーザー実機フィードバック2026-08-23第3弾 項目A ====
// 階段室の上が吹抜け（上階に床が無い）区間では1F天井線・2F床線を描いてはならない
// （天井断面は上階天井まで一気に抜ける）——旧実装はseq2/4のfloorSegments/ceilingProfileを
// 「レーン区間=chMm:ceilLowAbs固定（1F天井）／踊り場区間=ceilTopAbs固定（上階天井）」という
// レーン境界基準の**幾何的な決め打ち**で構築しており、上階に実際にRoom（床）があるか
// 一切確認していなかった——これが原因箇所（本ファイルの旧stairFaceSequence内、
// seq2/4のfloorSegments/ceilingProfile直書き。elevationStair.js側のCH解決やsectionProbe.jsの
// slab/open判定そのものは無関係——sectionProbe.js側は`content`生成にしか使われず、
// floorSegments/ceilingProfile側は完全に別経路の決め打ちだった）。
//
// 修正: face（wOut1/wOut2）に沿って、実際にopts.upperGraph（above層）にRoomがあるかを
// probeCtx.cellToRoomFor（sectionProbe.jsのmakeProbeContextが既に持つメモ化索引。他の壁検出と
// 同じ単一情報源）で1点プローブし、区間ごとに「上階に床がある(hasRoom)＝1F天井高さ(ceilLowAbs)」
// 「無い(吹抜け)＝上階天井(ceilTopAbs)まで抜ける」を判定してfloorSegments/ceilingProfileへ
// 反映する。aboveLayer（role!=='self'の層）が無い場合（opts.upperGraphが未指定。最上階等）は
// 実データが無く判定できないため、既存のレーン境界基準フォールバック（laneSegsFor）を維持する
// （挙動不変。既存の「upperGraph未指定」テストへの影響を避けるASSUMED判断）。
//
// face（wOut1等。composeRoomFacesの実面）のローカルx→world座標（elevationFigure.jsの
// localXOfの逆写像。face.dirSign/originWorldは同じ規約）。
function worldOfFace(face, localX) {
  return face.originWorld + localX * face.dirSign;
}

// face（走行軸に沿った実壁面）に沿って、aboveLayer.graphに実Room（床）があるかどうかの区間を
// ローカルx（0..face.run。隙間なく・昇順）で返す。aboveLayer未指定はnull（判定不能。呼び出し側は
// 既存のフォールバックへ委ねる）。
function aboveRoomSegmentsOnFace(face, aboveLayer, probeCtx) {
  if (!aboveLayer) return null;
  const cellToRoom = probeCtx.cellToRoomFor(aboveLayer);
  const w0 = worldOfFace(face, 0), w1 = worldOfFace(face, face.run);
  const lo = Math.min(w0, w1), hi = Math.max(w0, w1);
  const breaks = collectRunBreaks(aboveLayer.graph, face.isVertical, lo, hi);
  const segs = [];
  for (let i = 0; i + 1 < breaks.length; i++) {
    const bLo = breaks[i], bHi = breaks[i + 1];
    if (bHi - bLo < GAP_EPS) continue;
    const mid = (bLo + bHi) / 2;
    // 壁自身の位置ちょうどのプローブは境界セルで所有Roomが不安定なため、室内側
    // （face.inward）へPROBE_EPS_MMだけ逃がす（sectionProbe.jsのprobeOwnerRoomと同じ手法）。
    const faceCoord = face.faceValue + (face.inward ?? 1) * PROBE_EPS_MM;
    const px = face.isVertical ? faceCoord : mid;
    const py = face.isVertical ? mid : faceCoord;
    const cell = worldToCell(px, py, aboveLayer.graph);
    const ownerRoom = cell ? cellToRoom.get(cell.key) : null;
    // isRealRoom（sectionLayerStack.js）と同じ判定基準（VOID/STAIR_VOID/昇降機は実床が無い）を
    // 一本化して使う——判定の重複を避ける。
    const hasRoom = isRealRoom(ownerRoom);
    const locA = (bLo - face.originWorld) * face.dirSign;
    const locB = (bHi - face.originWorld) * face.dirSign;
    segs.push({ loX: Math.min(locA, locB), hiX: Math.max(locA, locB), hasRoom });
  }
  segs.sort((a, b) => a.loX - b.loX);
  return segs;
}

// x（ローカル。0..face.run）がaboveSegsのどの区間に属するか（hasRoom）を返す。範囲外はfalse
// （安全側＝吹抜け扱い）。
function hasAboveRoomAtX(aboveSegs, x) {
  const seg = aboveSegs.find(s => x >= s.loX - GAP_EPS && x <= s.hiX + GAP_EPS);
  return seg ? seg.hasRoom : false;
}

// [{loX,hiX,ceilAbs}]（昇順・隙間なし）から、区分線形の天井プロファイル（[[localX,ceilAbsMm],...]。
// elevationFigure.jsのceilAbsAtXが解釈する規約どおり、値が変わる境界は同じxを2点書いて
// 垂直に落とす＝水平段差のステップ関数にする）を組み立てる（項目A共通処理。
// buildLaneFloorAndCeilingのフォールバック経路・above層実測経路の両方から使う）。
function stepCeilingProfile(segs) {
  const points = [];
  for (const { loX, hiX, ceilAbs } of segs) {
    if (points.length === 0) points.push([loX, ceilAbs]);
    else {
      const [, prevAbs] = points[points.length - 1];
      if (Math.abs(prevAbs - ceilAbs) > GAP_EPS) points.push([loX, prevAbs], [loX, ceilAbs]);
    }
    points.push([hiX, ceilAbs]);
  }
  return points;
}

// ---- 階段の裏面（E5。space/stairSoffitCeiling.js）を切断の天井にする ----

/** 裏面の節列（世界の走り座標・昇順）→ 断面ローカルxの区間列（昇順）。足元の途切れ（gapBefore）・垂直の段（同じ run の 2 節）の間は区間にしない。 */
function soffitSpansLocal(nodes, cut) {
  const spans = [];
  for (let i = 1; i < nodes.length; i++) {
    const p = nodes[i - 1], q = nodes[i];
    if (q.gapBefore || q.run - p.run <= GAP_EPS) continue;
    const xa = localXOf(cut, p.run), xb = localXOf(cut, q.run);
    spans.push(xa <= xb ? { loX: xa, hiX: xb, z0: p.ch, z1: q.ch } : { loX: xb, hiX: xa, z0: q.ch, z1: p.ch });
  }
  return spans.sort((a, b) => a.loX - b.loX);
}

/**
 * 裏面の区間列の隙間（足元の外・途切れ）を、その面の既存の天井 base（[[x, ceilAbs], ...] の区分線形）で埋めて
 * [xMin, xMax] を隙間なく覆う区間列にする。base が空なら baseFallbackZ の水平。
 */
function fillSpansWithBase(spans, xMin, xMax, base, baseFallbackZ) {
  const baseAt = x => (base?.length ? drawnFloorProfileZAt(base, x) : baseFallbackZ);
  const baseXs = (base ?? []).map(p => p[0]);
  const out = [];
  const pushFill = (a, b) => {
    const xs = [a, ...[...new Set(baseXs)].filter(x => x > a + GAP_EPS && x < b - GAP_EPS).sort((p, q) => p - q), b];
    for (let i = 0; i + 1 < xs.length; i++) {
      const lo = xs[i], hi = xs[i + 1];
      const d = Math.min(1e-3, (hi - lo) / 4);
      out.push({ loX: lo, hiX: hi, z0: baseAt(lo + d), z1: baseAt(hi - d) });
    }
  };
  let x = xMin;
  for (const s of spans) {
    if (s.loX > x + GAP_EPS) pushFill(x, s.loX);
    out.push(s);
    x = Math.max(x, s.hiX);
  }
  if (xMax > x + GAP_EPS) pushFill(x, xMax);
  return out;
}

/**
 * 裏面の区間列（fillSpansWithBase の結果。昇順・隙間なし）を x で 2 つに割る（x が区間の内部にあるときだけ）。
 * @param {Array<{loX:number,hiX:number,z0:number,z1:number}>} series
 * @param {number} x
 */
function splitSeriesAt(series, x) {
  const out = [];
  for (const s of series) {
    if (x > s.loX + GAP_EPS && x < s.hiX - GAP_EPS) {
      const zm = s.z0 + (s.z1 - s.z0) * (x - s.loX) / (s.hiX - s.loX);
      out.push({ ...s, hiX: x, z1: zm }, { ...s, loX: x, z0: zm });
    } else out.push(s);
  }
  return out;
}

/** 区間列の x での値（区分線形。区間の外は null）。 */
function seriesZAt(series, x) {
  const s = series.find(q => x >= q.loX - GAP_EPS && x <= q.hiX + GAP_EPS);
  if (!s) return null;
  if (s.hiX - s.loX <= GAP_EPS) return s.z0;
  return s.z0 + (s.z1 - s.z0) * (x - s.loX) / (s.hiX - s.loX);
}

/**
 * 隔て板（往復レーンの境界の壁）の帯 [lo, hi]（断面ローカル x）をはさんで裏面の高さが違うとき、**低い側の天井を帯の向こう側の
 * 面まで水平に延ばし、立下りを高い側の面に置く**（ユーザー指示 2026-10-15「moku4-3 1階 階段 C: 往路の天井 X2+910 の右側に
 * ある立下り断面は X2+910 の左側が正解。上階隔て板を包むように仕上げ材は貼られるので、原則、断面は中心から部屋側に寄る」。
 * 面 A では帯が裏面の途切れ＝base（上階天井 5400）で埋まっていた帯も同じ規則で低い側の天井になる）。
 * 帯の両側の値が同じ・片側が無い・帯が区間列の外なら不変。返り値は新しい配列（引数は書き換えない）。
 * @param {Array<{loX:number,hiX:number,z0:number,z1:number}>} series 昇順・隙間なしの区間列
 * @param {number} lo 帯の低い側の x
 * @param {number} hi 帯の高い側の x
 */
export function extendLowerCeilingAcrossStrip(series, lo, hi) {
  if (!series?.length || !(hi - lo > GAP_EPS)) return series;
  const xMin = series[0].loX, xMax = series[series.length - 1].hiX;
  if (lo <= xMin + GAP_EPS || hi >= xMax - GAP_EPS) return series;
  const split = splitSeriesAt(splitSeriesAt(series, lo), hi);
  // 帯の両側の値は、帯の面で割った区間の端の値そのもの（補間で丸めない。向こう面で隣の区間と同じ z から立下る）
  const left = split.find(s => Math.abs(s.hiX - lo) <= GAP_EPS), right = split.find(s => Math.abs(s.loX - hi) <= GAP_EPS);
  const zL = left ? left.z1 : seriesZAt(series, lo), zR = right ? right.z0 : seriesZAt(series, hi);
  if (zL == null || zR == null || Math.abs(zL - zR) <= GAP_EPS) return series;
  const z = Math.min(zL, zR);
  const out = [];
  let inserted = false;
  for (const s of split) {
    if (s.loX >= lo - GAP_EPS && s.hiX <= hi + GAP_EPS) {
      if (!inserted) { out.push({ loX: lo, hiX: hi, z0: z, z1: z }); inserted = true; }
      continue;
    }
    out.push(s);
  }
  return out;
}

// 壁のない端（上り口）で裏面が隣の天井より高いときに、斜めの天井断面を終える点の端からの入り（隔て板の壁厚/2＝57.5。
// 復路下の仕上げ空間の天井線の到達辺側「Y4＋壁厚/2」〔underReturnSpaceOf〕と同じ量）。
export const SOFFIT_OPEN_END_INSET_MM = PARTITION_THICKNESS_MM / 2;

/**
 * 壁のない端（上り口）で、裏面の端の高さがその端の既存の天井（隣の部屋へ続く天井。base）より高いとき、斜めの天井断面の終点を
 * **端から inset 入った位置・base の高さ**に置き、そこから端までは base の高さの水平にする（ユーザー指示 2026-10-15
 * 「moku4-3 1階 階段 B1, D: 階段から斜めに下りてくる天井断面の終わりは、（Y4 通りの壁厚分だけ階段側, FL+2400）の点」。
 * 裁定: 壁厚分＝壁厚/2＝57.5〔復路下の仕上げ空間の天井線と同じ〕）。裏面の端が base 以下・端に壁がある・inset が区間列に
 * 収まらないときは不変。返り値は新しい配列。
 * @param {Array<{loX:number,hiX:number,z0:number,z1:number}>} series 昇順・隙間なし
 * @param {'left'|'right'} end
 * @param {number} baseZ その端の既存の天井の高さ
 * @param {number} inset 端からの入り
 */
export function endSoffitAtOpenEndCeiling(series, end, baseZ, inset) {
  if (!series?.length || !Number.isFinite(baseZ) || !(inset > GAP_EPS)) return series;
  const xMin = series[0].loX, xMax = series[series.length - 1].hiX;
  const edgeZ = end === 'left' ? series[0].z0 : series[series.length - 1].z1;
  if (!(edgeZ - baseZ > GAP_EPS)) return series;
  const xCut = end === 'left' ? xMin + inset : xMax - inset;
  if (xCut <= xMin + GAP_EPS || xCut >= xMax - GAP_EPS) return series;
  const split = splitSeriesAt(series, xCut);
  if (end === 'left') {
    const rest = split.filter(s => s.loX >= xCut - GAP_EPS);
    if (!rest.length) return series;
    return [{ loX: xMin, hiX: xCut, z0: baseZ, z1: baseZ }, { ...rest[0], z0: baseZ }, ...rest.slice(1)];
  }
  const rest = split.filter(s => s.hiX <= xCut + GAP_EPS);
  if (!rest.length) return series;
  return [...rest.slice(0, -1), { ...rest[rest.length - 1], z1: baseZ }, { loX: xCut, hiX: xMax, z0: baseZ, z1: baseZ }];
}

/**
 * 切断 cut に階段の裏面（soffit）を天井として載せる。切断線の深さ（cut.line.axisValue）で切った裏面を、
 * **同じ区間列**から 体裁の ceilingProfile（返り値）とエンジンの cut.ceilClip（打ち切り専用。性格判定は ceilProfile のまま）に写す。
 * 足元の外・途切れは base（その面の既存の天井）でつなぐ（境目で値が違えば垂直の段）。cut.zRange.hiZ は裏面の最高点まで広げる
 * （頭打ちしない。裏面は上階天井 chUpperAbsMm を超えうる＝E5-0 の実測）。cut は呼び出し側が switchbackCuts から得た新しい
 * オブジェクトで、ここで直接書き換える（zRange は共有オブジェクトを書き換えず差し替える）。
 * 裏面が無い・切断線が足元の外ならば null（cut は不変）。
 * @param {{partitionStrip?:{lo:number,hi:number}|null, openEnds?:{left?:boolean, right?:boolean}}} [opts]
 *   partitionStrip … 切断線を横切る隔て板（往復レーンの境界の壁）の材の範囲（世界の幅方向座標）。あれば帯をはさんで低い側の
 *   天井を向こう面まで延ばす（extendLowerCeilingAcrossStrip）。切断線と平行な壁は渡さない（呼び出し側が向きで判定する）。
 *   openEnds … 壁のない端（上り口）。その端で裏面が base より高ければ斜めの天井断面を端から SOFFIT_OPEN_END_INSET_MM 入った
 *   base の高さの点で終える（endSoffitAtOpenEndCeiling）。base が無い切断（seq1/3/5）には効かない。
 * @returns {{ceilingProfile:Array<[number,number]>, ends:{left:number|null, right:number|null}}|null}
 */
export function applyStairSoffitToCut(soffit, cut, base, baseFallbackZ, opts = {}) {
  if (!soffit || !cut?.line) return null;
  const { line } = cut;
  const nodes = stairSoffitChAlong(soffit, { isVertical: line.isVertical, depthCoord: line.axisValue, lo: line.lo, hi: line.hi });
  if (!nodes) return null;
  const spans = soffitSpansLocal(nodes, cut);
  if (spans.length === 0) return null;
  const xa = localXOf(cut, line.lo), xb = localXOf(cut, line.hi);
  const xMin = Math.min(xa, xb), xMax = Math.max(xa, xb);
  let series = fillSpansWithBase(spans, xMin, xMax, base, baseFallbackZ).filter(s => s.hiX - s.loX > GAP_EPS);
  const strip = opts.partitionStrip ?? null;
  if (strip && Number.isFinite(strip.lo) && Number.isFinite(strip.hi)) {
    const sa = localXOf(cut, strip.lo), sb = localXOf(cut, strip.hi);
    series = extendLowerCeilingAcrossStrip(series, Math.min(sa, sb), Math.max(sa, sb));
  }
  if (base?.length && opts.openEnds) {
    const d = 1e-3;
    if (opts.openEnds.left) series = endSoffitAtOpenEndCeiling(series, 'left', drawnFloorProfileZAt(base, xMin + d), SOFFIT_OPEN_END_INSET_MM);
    if (opts.openEnds.right) series = endSoffitAtOpenEndCeiling(series, 'right', drawnFloorProfileZAt(base, xMax - d), SOFFIT_OPEN_END_INSET_MM);
  }
  cut.ceilClip = series.map(s => ({ loX: s.loX, hiX: s.hiX, ceilZ: s.z0, ceilZHi: s.z1 }));
  const soffitTop = Math.max(...spans.flatMap(s => [s.z0, s.z1]));
  if (cut.zRange && soffitTop > cut.zRange.hiZ) cut.zRange = { ...cut.zRange, hiZ: soffitTop };
  const ceilingProfile = [];
  const push = (x, z) => {
    const last = ceilingProfile[ceilingProfile.length - 1];
    if (last && Math.abs(last[0] - x) <= GAP_EPS && Math.abs(last[1] - z) <= GAP_EPS) return;
    ceilingProfile.push([x, z]);
  };
  for (const s of series) { push(s.loX, s.z0); push(s.hiX, s.z1); }
  const first = spans[0], last = spans[spans.length - 1];
  return {
    ceilingProfile,
    // 端の値は最終の区間列から（壁のない端で base の高さに置き換えた値を反映。端が裏面で覆われていなければ従来どおり null）
    ends: {
      left: first.loX <= xMin + 1e-3 ? series[0].z0 : null,
      right: last.hiX >= xMax - 1e-3 ? series[series.length - 1].z1 : null,
    },
  };
}

/**
 * レーン側の面（seq2=wOut1／seq4=wOut2）のfloorSegments・ceilingProfileを組み立てる
 * （項目A対応）。floorDeltaSegsはfloorDeltaMm（既存の階段自身の床段差＝レーン=0・
 * 踊り場=landingAbs）の並び（[{loX,hiX,floorDeltaMm,flatLineSpanX?}]。昇順・隙間なし。
 * seq2は[レーン,踊り場]の順・seq4は鏡像で[踊り場,レーン]の順になる——どちらの順でも
 * 正しく組み立てられるようfloorDeltaMm===0かどうかだけで判定する）、aboveLayerがあれば
 * 実Room有無で1F天井高さ(ceilLowAbs)／上階天井(ceilTopAbs)を区間ごとに割り当てる。
 * aboveLayer無し時は現行の決め打ち（floorSegmentsはfloorDeltaSegsの区分
 * そのまま。レーン区間=ceilLowAbs・踊り場区間=ceilTopAbs／ceilingProfileは呼び出し側が渡す
 * fallbackCeilingProfileをそのまま使う）のまま（挙動不変のフォールバック——旧seq2/seq4の
 * ceilingProfileは「レーンから踊り場へ向けて勾配で立ち上がる」非対称な式で、floorDeltaSegsの
 * 区分境界だけからは一般化して再現できないため、呼び出し側の既存リテラルをそのまま温存する）。
 * @param {object} face
 * @param {Array<{loX:number, hiX:number, floorDeltaMm:number,
 *   flatLineSpanX?:{lo?:number,hi?:number}}>} floorDeltaSegs
 * @param {{graph:object, floorZMm:number, role:string}|null} aboveLayer
 * @param {ReturnType<typeof makeProbeContext>} probeCtx
 * @param {number} ceilLowAbs
 * @param {number} ceilTopAbs
 * @param {Array<[number,number]>} fallbackCeilingProfile - aboveLayer無し時に使う既存の
 *   ceilingProfileリテラル（挙動不変のため）。
 * @returns {{floorSegments:object[], ceilingProfile:Array<[number,number]>}}
 */
function buildLaneFloorAndCeiling(
  face, floorDeltaSegs, aboveLayer, probeCtx, ceilLowAbs, ceilTopAbs, fallbackCeilingProfile,
) {
  const run = face.run;
  // **最上階キャップ（upperCeilCapped）による「全区間ceilLowAbsで水平」の短絡は廃止した**（ユーザー実機指摘2026-08
  // 「2FL天井断面線は、3500左CLの外へ延長して終わる」）——実機データ（floorHeight=3000・
  // chLower=2400・chUpperAbs=5400・upperCeilCapped=true）で、この短絡が天井プロファイルを
  // フラット2400にし、階段室の上まで1F天井が貫通していた。一方でcontent（レイキャスト）は
  // 同じ面に2F天井(5400)を描いており、**図形とcontentが食い違っていた**。
  // upperCeilCappedは「上階が最上階かつCHが明示指定でない（既定値へフォールバック）」という
  // 弱い条件で立つ推測（設計メモにもASSUMEDと明記）であり、実機の指摘と矛盾する。
  // chUpperAbsMm自体は他の描画で既に使われているため、天井もそれに揃える方が一貫する。
  const aboveSegs = aboveRoomSegmentsOnFace(face, aboveLayer, probeCtx);
  // フォールバック（呼び出し側の勾配天井リテラル）が働く条件は**aboveLayerが無く判定できない
  // ときだけ**。
  // 旧実装は「上階の実Room有無がface全体で一様なら実測を捨ててフォールバックへ戻す」という
  // 短絡も持っていた（コード上も「挙動不変のASSUMED判断」と明記）が、ユーザー実機指摘2026-08
  // 「6」D／B1（「2FL天井断面線は3500左CLの外へ延長して終わる」「B1はDの反転が正解」）で
  // 誤りと判明したため削除した——実機の階段室は往路面の全長にわたって上階に床が無い
  // （全面吹抜け。列ダンプでseq2の全列がwall/cutのみでslab無し）ため一様と判定され、
  // 「測れているのに測定結果を捨てる」動作になっていた。結果、天井が
  // PL[-285,2400 → 0,2400 → 2442.5,5400 → 3442.5,5400]という斜めの勾配になり、
  // 上階天井(5400)の断面線が壁のない端まで届かなかった。
  // 一様でも実測どおり（hasRoom無し＝全区間ceilTopAbsで水平／有り＝全区間ceilLowAbsで水平）に
  // 割り当てるのが正しい。フォールバックの勾配は「判定不能時の作図上の便法」として残す。
  if (!aboveSegs || aboveSegs.length === 0) {
    const floorSegments = floorDeltaSegs.map(s => ({
      ...s, chMm: (s.floorDeltaMm === 0 ? ceilLowAbs : ceilTopAbs) - s.floorDeltaMm,
    }));
    return { floorSegments, ceilingProfile: fallbackCeilingProfile };
  }

  // floorDeltaSegsとaboveSegsの境界を統合し、各ミニ区間へfloorDeltaMm・hasRoomの両方を反映する。
  const breakXs = [...new Set([
    0, run,
    ...floorDeltaSegs.flatMap(s => [s.loX, s.hiX]),
    ...aboveSegs.flatMap(s => [s.loX, s.hiX]),
  ])].sort((a, b) => a - b);

  const floorSegments = [];
  const profileSegs = [];
  for (let i = 0; i + 1 < breakXs.length; i++) {
    const loX = breakXs[i], hiX = breakXs[i + 1];
    if (hiX - loX < GAP_EPS) continue;
    const mid = (loX + hiX) / 2;
    const ownerSeg = floorDeltaSegs.find(s => mid >= s.loX - GAP_EPS && mid <= s.hiX + GAP_EPS);
    const floorDeltaMm = ownerSeg?.floorDeltaMm ?? 0;
    const hasRoom = hasAboveRoomAtX(aboveSegs, mid);
    const ceilAbs = hasRoom ? ceilLowAbs : ceilTopAbs;
    const flatLineSpanX = floorDeltaMm === 0 ? ownerSeg?.flatLineSpanX : undefined;
    floorSegments.push({
      loX, hiX, floorDeltaMm, chMm: ceilAbs - floorDeltaMm, ...(flatLineSpanX ? { flatLineSpanX } : {}),
    });
    profileSegs.push({ loX, hiX, ceilAbs });
  }
  return { floorSegments, ceilingProfile: stepCeilingProfile(profileSegs) };
}

// cut(SectionCut) → content（WP-E5b: §4「内部フロー」のcontent生成部分のみをここで組み立てる。
// face/floorSegments/ceilingProfileはswitchbackCuts供給の現行方式のまま——本関数はcontentだけを
// 返す。cutがnull（例: seq3。§6.1表「階段寄与: なし」）はstairPrimitivesForCutにnullを渡す
// （contribution=null契約で空配列を返す）。
// QA実機フィードバック修正: 階段の断面ジグザグ(stairPrimitivesForCutが返すpolyline)が占める
// x範囲では、その向こうに見える壁の輪郭線（emitColumnsが一般規則で描く見えがかり壁の
// z=0=設置階FL位置の縁）は、実際には階段自体（段板・ささら）に隠れて見えないはず
// （「設置階FLは階段断面に出会ったらそこが終点」の一般化）。一般規則のレイキャスト
// （probeColumn/emitColumns）は階段自体の占有形状を知らず、壁の見えがかりだけで塞ぎ判定する
// ため、この重なりだけは切断定義の出力側で後処理として取り除く。
// 実機フィードバック第3弾F: 往復間の壁が2F腰壁（kneeDrop.knee指定）の場合、seq1では一般規則
// （'cut'kind＝両端の縦線2本のみ）の両端縦線を除く。
// **アキのバツ（旧第3弾D「ささらの外側〜壁の空き」・第3弾Fの「腰壁の上＋横のL字アキ」の合成）は
// 廃止**（ユーザー指示2026-10-07「踊場、回転部に『アキ』は不要」。踊り場前縁の切断seq1/seq3は
// `cut.openGapMarks=false`でアキを標記しない。旧裁定2026-08〜09を撤回）。
export function kneeWallCapContent(content, cut, kneeDrop, floorHeight) {
  if (!kneeDrop?.knee) return content;
  const topZ = floorHeight + kneeDrop.knee.topHeight;

  // 往復間の壁の'cut'kind両端縦線（z=floorHeight〜topZちょうどの縦線2本）を検出して除去する。
  const wallEdges = content.filter(p =>
    p.type === 'line' && p.x1 === p.x2 &&
    Math.abs(Math.min(p.y1, p.y2) - (-topZ)) < GAP_EPS && Math.abs(Math.max(p.y1, p.y2) - (-floorHeight)) < GAP_EPS);
  if (wallEdges.length === 0) return content; // 該当する壁縁が無ければ何もしない（防御的）

  // 天端のCUT水平線はここでは描かない: `emitColumns`の`cutWallTopEdges`が「見えている天井より
  // 下で終わる切断壁」の天端を壁ごとに1本描くようになったため（ユーザー実機指摘2026-08「6」D）。
  // ここでも描くと同じ線が2本になる（seq1の既存テスト「上端水平線が1本」で検出される）。
  // 本関数に残る役割は「'cut'両端縦線の除去」だけ（腰壁の上＋横のL字アキの一点鎖線Xの合成は、
  // 踊り場前縁の切断にアキを標記しない裁定〔2026-10-07〕で廃止した）。
  return content.filter(p => !wallEdges.includes(p));
}

/**
 * 各区間の床線を、**輪郭がその区間の床高さと一致する最大の連続範囲**へ切り詰める
 * （`flatLineSpanX`。elevationFigure.jsが解釈する既存フック。既定=未指定=区間いっぱい）——
 * 階段下に部屋があるとき、レーンの床は階段そのもので、1FLの水平線は上り口の外側
 * （壁のない端部のはり出し）にだけ残る。踊り場の床線も同様に、階段断面と取り合う点
 * （ジグザグの最下点＝踊り場側の段鼻）が終点になる。
 * **段鼻の出の手計算ではなく輪郭から導出する**——断面線とレーンの床線が同じ1つの情報源
 * （profile）から出るので、両者が食い違いようがない。
 * profile未指定（階段下に部屋が無く、断面線も繋がらない＝鉄骨など）は何もしない＝従来どおり区間いっぱい。
 * 可視範囲が空の区間は`{lo:hiX, hi:loX}`（反転＝空。elevationFigure側でnull＝非描画になる）。
 * @param {object[]} segs - floorSegments
 * @param {Array<[number,number]>|null} profile - 断面線（下側の輪郭）
 * @returns {object[]}
 */
export function withFlatLineSpans(segs, profile) {
  if (!profile?.length) return segs;
  const breakXs = profile.map(([x]) => x);
  const zAt = x => drawnFloorProfileZAt(profile, x);
  return segs.map((s, si) => {
    const z = s.floorDeltaMm ?? 0;
    const inner = [...new Set(breakXs.filter(x => x > s.loX + GAP_EPS && x < s.hiX - GAP_EPS))]
      .sort((a, b) => a - b);
    const xs = [s.loX, ...inner, s.hiX];
    let best = null, run = null;
    for (let i = 0; i + 1 < xs.length; i++) {
      const xl = xs[i], xr = xs[i + 1];
      if (xr - xl <= GAP_EPS) continue;
      // 区間の内側で判定する（両端は垂直な段差でどちら側の値が返るか曖昧なため）。
      const q = (xr - xl) / 4;
      if (drawnFloorProfileZMax(profile, xl + q, xr - q) > z + GAP_EPS) { run = null; continue; }
      run = run ? { lo: run.lo, hi: xr } : { lo: xl, hi: xr };
      if (!best || run.hi - run.lo > best.hi - best.lo) best = run;
    }
    if (!best) {
      // 区間の中に床高さの平らな部分が無くても、階段の足元（初段の立ち上がり）が**面の端より外**にあり、
      // そこまで輪郭が床高さで続くなら、床線は面の端から足元まで残す（はね出し。ユーザー指示 2026-10-15
      // 「設置階初段断面が描画される面：設置階FL断面はね出し」）——木造の 1 段目は隔て板の柱の前縁（通り芯
      // −57.5）にあり面の端の外から立ち上がるため、旧実装は区間の内側だけを見て床線を丸ごと落としていた。
      // 端の面（最初の区間の始端・最後の区間の終端）だけが対象。端に壁があれば図側の描画範囲（drawnX0/Run）
      // が面の端で止まるので線は出ない。
      const foot = (end) => {
        const outside = end === 'lo'
          ? breakXs.filter(x => x <= s.loX + GAP_EPS).sort((a, b) => b - a)
          : breakXs.filter(x => x >= s.hiX - GAP_EPS).sort((a, b) => a - b);
        // 端から外へ向かって最初に「外側が床高さ・内側が床より上」になる折れ点＝足元（木造の初段は
        // 段板の厚みで斜めに立ち上がるので、面の端の折れ点では外側もまだ床より上のことがある）
        for (const x of outside) {
          const inside = end === 'lo' ? x + 1 : x - 1, outer = end === 'lo' ? x - 1 : x + 1;
          if (zAt(outer) <= z + GAP_EPS && zAt(inside) > z + GAP_EPS) return x;
        }
        return null;
      };
      if (si === 0) { const x = foot('lo'); if (x != null) return { ...s, flatLineSpanX: { hi: x } }; }
      if (si === segs.length - 1) { const x = foot('hi'); if (x != null) return { ...s, flatLineSpanX: { lo: x } }; }
      return { ...s, flatLineSpanX: { lo: s.hiX, hi: s.loX } };
    }
    const span = {};
    if (best.lo > s.loX + GAP_EPS) span.lo = best.lo;
    if (best.hi < s.hiX - GAP_EPS) span.hi = best.hi;
    return Object.keys(span).length > 0 ? { ...s, flatLineSpanX: span } : s;
  });
}

/**
 * 上階FL断面線のはね出し（ユーザー指示 2026-10-15「設置階上階最終段断面が描画される面：設置階上階FL断面
 * はね出し」）: 断面線（floorProfile）が上階FLの高さで面の端の側へ終わる＝最終段の天端がその端にある面で、
 * その端に壁が無ければ（`wallLessEndAt`。図側の床線・天井線のはね出しと同じ関門）、上階FL（z=floorHeight）の
 * 断面線を最終段の天端の外側の点から面の端の外（壁のない端部の延長 extendMm）まで引く。端に壁があれば
 * 上階の床はその壁で終わるので足さない（従来どおり。上階の平面が壁の外へ続くはり出しは図側の
 * `upperFloorEdgeSpans` の規則のまま）。
 * @returns {object[]} 追加する線（CUT）
 */
export function upperFloorEndLines(entry, floorHeight, extendMm) {
  // 復路下の仕上げ空間で床へ下げた断面線（floorProfile）には最終段の天端が無いので、下げる前の断面線（stairFloorProfile）で見る
  const prof = entry.stairFloorProfile ?? entry.floorProfile, face = entry.face;
  if (!prof?.length || !Number.isFinite(floorHeight) || !face) return [];
  const atTop = ([, z]) => Math.abs(z - floorHeight) <= GAP_EPS;
  const out = [];
  for (const end of ['lo', 'hi']) {
    if (!wallLessEndAt(face, end === 'lo' ? '0' : 'Run')) continue;
    // その端から見て最初の折れ点列: 端側は床（上階FL未満）で、最初に上階FLへ上がる点が最終段の天端の外側の点。
    const pts = end === 'lo' ? prof : [...prof].reverse();
    const firstTop = pts.findIndex(atTop);
    if (firstTop < 0) continue; // 上階FLに達しない
    // 端と天端の間は帯の床（平ら。階段の断面が終わった先）でなければならない——そこに段（上りも下りも）や
    // 上階FLより高い部分があれば、天端はこの端にあるのではない（反対側の端に向かう階段の途中）。
    const between = pts.slice(0, firstTop);
    if (between.some(([, z]) => Math.abs(z - between[0][1]) > GAP_EPS)) continue;
    // firstTop===0 は最終段の天端が断面線の定義域の端（面の端）にある構成。そこから外へ引く。
    const xTop = pts[firstTop][0];
    const xOuter = end === 'lo' ? -extendMm : face.run + extendMm;
    if ((end === 'lo' ? xTop - xOuter : xOuter - xTop) <= GAP_EPS) continue;
    out.push({ type: 'line', x1: xOuter, y1: -floorHeight, x2: xTop, y2: -floorHeight, weight: weightForRole(ElevationLineRole.CUT) });
  }
  return out;
}

/**
 * QA是正2026-09（§5.12 D2-1是正・項目2）: wallFilterで除外された実壁がある端
 * （`face.hiddenWallAtLocal0/Run`）では、content側の水平線を面の真の境界（ローカル0/run。
 * `localXOf`はcutとface共通の座標系のため、この境界は常に`0`と`face.run`）で切る。
 *
 * 探査窓（`section/sectionContent.js`の`withProbeExtension`）は**ここでは触らない**——
 * 探査自体は壁のない端部と同じだけ広げたままにする（締めると、その壁を手掛かりにする
 * `recessLo`等の既存描画が列ごと消える）。ここは**描画だけ**を絞る——hidden端は実壁が
 * そこにあり実際には続いていないため、探査の延長区間に「面の外へ続く」内容
 * （`farFloorZ/farCeilZ`の見えがかり水平線＝実機「6」D2のmedium 2FL中線）を描くと、
 * 面の真の境界に既に出ている太線の断面（2F床の小口）と重なって冗長になる。
 * 縦線（x1===x2）は対象外（hidden端自体の縦線は別の規則で決まる。面図側が描く）。
 * @param {object[]} prims
 * @param {object|null} face - cut.face
 * @returns {object[]}
 */
export function clipContentAtHiddenEnds(prims, face) {
  if (!face?.hiddenWallAtLocal0 && !face?.hiddenWallAtLocalRun) return prims;
  const lo = face.hiddenWallAtLocal0   ? 0        : -Infinity;
  const hi = face.hiddenWallAtLocalRun ? face.run : Infinity;
  const out = [];
  for (const p of prims) {
    if (p.type !== 'line' || p.x1 === p.x2) { out.push(p); continue; }
    const xLo = Math.min(p.x1, p.x2), xHi = Math.max(p.x1, p.x2);
    const clippedLo = Math.max(xLo, lo), clippedHi = Math.min(xHi, hi);
    if (clippedHi - clippedLo <= GAP_EPS) continue; // 区間が丸ごと外 or 退化＝落とす
    if (clippedLo <= xLo + GAP_EPS && clippedHi >= xHi - GAP_EPS) { out.push(p); continue; } // クリップ不要
    const growing = p.x1 <= p.x2;
    out.push({ ...p, x1: growing ? clippedLo : clippedHi, x2: growing ? clippedHi : clippedLo });
  }
  return out;
}

/** 回転部の切断面の向こうの踏面・蹴上のうち、断面の前の空間で見える区間（細線実線）の印 */
export const VISIBLE_STEP_MARK = 'visibleStep';

// 回転部の切断面の向こうの踏面・蹴上（HIDDEN_STEP_MARK。hiddenTurnStepPrimitives）を、描かれた断面線で上下に分ける
// （ユーザー裁定 2026-10-15「moku4-3 1階 階段 C」）:
//   - 断面線より**下**＝断面の後ろに隠れた区間 … 細線破線（「X2+910より右の破線（断面見返り側＝断面線の後ろ）は不要」の是正。
//     X2 側の下る段の踏面・壁に取り合う蹴上の縦線は断面の床 2000 の後ろ）。
//   - 断面線より**上**＝断面の前の空間で見える区間 … 細線実線（「X2+910より右にある階段断面線から壁までの見え掛かりを細線描画して」。
//     X1 側の上る段の踏面の線が断面の段から壁まで）。段の上の縦線（断面の蹴上）・面の端の壁の縦線と重なる区間はどちらにも残らない。
function clipHiddenStepLines(prims, profile, cut) {
  const endXs = [localXOf(cut, cut.line.lo), localXOf(cut, cut.line.hi)];
  const place = (p, segs, extra) => segs.map(([a, b]) => ({ ...p, ...extra, x1: a[0], y1: -a[1] || 0, x2: b[0], y2: -b[1] || 0 }));
  return prims.flatMap(p => {
    if (p.__o !== HIDDEN_STEP_MARK || p.type !== 'line') return [p];
    const hidden = place(p, clipHiddenSegmentBelowProfile(profile, p.x1, -p.y1, p.x2, -p.y2), {});
    const isVertical = Math.abs(p.x1 - p.x2) <= GAP_EPS;
    if (isVertical && endXs.some(x => Math.abs(x - p.x1) <= GAP_EPS)) return hidden; // 面の端の壁の縦線（太線）が立つ
    const solid = { ...p };
    delete solid.dash;
    const visible = place(solid, clipHiddenSegmentAboveProfile(profile, p.x1, -p.y1, p.x2, -p.y2), { __o: VISIBLE_STEP_MARK });
    return [...hidden, ...visible];
  });
}

function clipWallFloorEdgeUnderZigzag(wallContent, stairContent) {
  const zigzagXRanges = stairContent
    .filter(p => p.type === 'polyline')
    .map(p => ({
      lo: Math.min(...p.points.map(pt => pt[0])),
      hi: Math.max(...p.points.map(pt => pt[0])),
    }));
  if (zigzagXRanges.length === 0) return wallContent;
  return wallContent.filter(p => {
    if (p.type !== 'line' || p.y1 !== p.y2 || p.y1 !== 0) return true; // 設置階FL(z=0)の水平線のみ対象
    const xLo = Math.min(p.x1, p.x2), xHi = Math.max(p.x1, p.x2);
    return !zigzagXRanges.some(r => xLo < r.hi - GAP_EPS && xHi > r.lo + GAP_EPS);
  });
}

/**
 * 壁のない端部（face.hasWallAtLocal0/Runがfalse）の外側へ、レイキャストの探査範囲を
 * endExtendMmぶん広げたcutのクローンを返す（ユーザー裁定2026-08 A案）。
 * 面の端で切れている壁・床スラブ・天井は「そこで終わる」のではなく面の外へ続いており、
 * その取り合い（腰壁の外側面・隣室の1F天井断面・2FL床断面）を作図するには外側の実データが要る
 * ——旧案の「出来上がった水平線プリミティブを後から引き伸ばす」では、外側面の位置（＝壁厚）が
 * そもそも探査されていないため腰壁のZ字プロファイルを作れなかった（列ダンプで確認）。
 * cut.line.lo/hi自体は変えない＝x=0の起点（cutOriginWorld）が動かないため既存座標はずれない。
 * ローカルx=0側／run側のどちらがworldのlo側かはdirSignで決まる。
 *
 * 返り値はcontentだけでなく**上階のはり出し**（`upperOverhang`・`upperFloorZ`）も返す
 * ——図側（elevationFigure.jsの天井断面線・上階FL断面線）とcontent側（壁エッジ）は同じ1つの
 * 探査窓（`buildCutContent`が返す`cut.layerRunWindows`）から出す必要があるため、ここで写す。
 * @returns {{content:object[], upperOverhang:{lo:number,hi:number}|undefined,
 *   upperFloorZ:number|undefined, upperFloorCutEnds:{lo:number|null,hi:number|null}|undefined,
 *   upperFloorEnds:{lo:boolean,hi:boolean}|undefined}}
 */
/**
 * 壁の断面の縁（cutEdgeLo/Hi）のうち、階段本体の断面（crossingFlightBodySections。本体に接する x＝本体の範囲の端）の
 * z 区間に入る部分を落とす（断面の中は描かない）。他のプリミティブは不変。
 * @param {object[]} prims
 * @param {Array<{xLo:number, xHi:number, zLo:number, zHi:number}>} bodies
 */
export function clipWallEdgesInsideStairBodies(prims, bodies) {
  if (!bodies?.length) return prims;
  const out = [];
  for (const p of prims) {
    const isEdge = p.type === 'line' && (p.__o === 'cutEdgeLo' || p.__o === 'cutEdgeHi') && Math.abs(p.x1 - p.x2) <= GAP_EPS;
    const hit = isEdge ? bodies.filter(b => Math.abs(b.xLo - p.x1) <= GAP_EPS || Math.abs(b.xHi - p.x1) <= GAP_EPS) : [];
    if (hit.length === 0) { out.push(p); continue; }
    let ranges = [{ z0: Math.min(-p.y1, -p.y2), z1: Math.max(-p.y1, -p.y2) }];
    for (const b of hit) {
      ranges = ranges.flatMap(r => {
        if (b.zHi <= r.z0 + GAP_EPS || b.zLo >= r.z1 - GAP_EPS) return [r];
        const parts = [];
        if (b.zLo - r.z0 > GAP_EPS) parts.push({ z0: r.z0, z1: b.zLo });
        if (r.z1 - b.zHi > GAP_EPS) parts.push({ z0: b.zHi, z1: r.z1 });
        return parts;
      });
    }
    for (const r of ranges) out.push({ ...p, y1: -r.z0 || 0, y2: -r.z1 || 0 });
  }
  return out;
}

function contentForCut(rawCut, probeCtx, endExtendMm = 0, bandRoomBounds = null, zRef = null,
  drawFloorProfile = null, underReturnSpace = null) {
  if (!rawCut) {
    return { content: [], upperOverhang: undefined, upperFloorZ: undefined,
      upperFloorCutEnds: undefined, upperFloorEnds: undefined };
  }
  // **断面線の外は描画しない**（ユーザー明示指示2026-09）。その面の断面線（下側の輪郭。
  // 帯の床＋縦断する階段寄与の折れ線）は**壁の断面・見えがかり・建具の姿**のクリップにだけ使う
  // （下記`clipContentAboveDrawnProfile`）。展開図一般化Phase 6b-2 C-2（設計
  // `.claude/elevation-redesign.md`§5.11）: アキのセルの下限はband自身（sectionHits.jsの
  // visibleBandsOf）が答えを持つようになったため、`cut`へ`drawFloorProfile`を載せて
  // emitOpenGapMarks（sectionEmit.js）へ渡す経路は廃止した——`cut`は常に`rawCut`のまま
  // （旧実装の`{...rawCut, drawFloorProfile}`のクローンは不要になった）。
  // 断面線の無い面（鉄骨で階段下に部屋が無い面・seq1/seq3）では呼び出し側がnullを渡す（＝下限なし＝
  // 設置階FLまで描く）。木造は部屋が無くても断面線が繋がるので渡される（2026-10-08裁定）。
  const cut = rawCut;
  // 拡張済みcut（探査延長＋帯の部屋の包絡矩形つき）はレイキャストだけでなく構造材の判定でも使う
  // ——「室内を空中で横断する梁の見えがかり」がbandRoomBoundsを見るため（sectionStructure.js）。
  // 共通経路（section/sectionContent.js）: 探査延長・端の凹み側面線の抑制・壁断面／見えがかり・
  // アキのバツまでは吹抜けの多層帯とまったく同じ処理を通る。ここから下が階段固有の後段加工。
  const { cut: pcut, columns, wallPrims, gapMarks: rawGapMarks } =
    buildCutContent(cut, probeCtx, {
      endExtendMm, bandRoomBounds, upperPlaneOverhang: true, gapFloorProfile: drawFloorProfile,
    });
  // 展開図一般化Phase 6b-2「一体設計」(.claude/elevation-redesign.md§5.12):
  // 階段自身の幾何（踏面CUT・ささら・桁枠）の描画範囲は`cutDrawRange`を、上階の平面が面端より
  // 外へ続く量（`upperOverhang`）だけ広げたもの——2FLへ到達する終端を、上階の床のはり出しと
  // 同じ終点まで許す。末尾の返り値（upperOverhang等）と同じ計算を先に1回だけ行い、
  // `stairPrimitivesForCut`の`opts.outerBound`へそのまま渡す（二重計算しない）。
  // QA是正（2026-09-12その6）: `opts.outerBound`は増分ではなく**面ローカルxの絶対値**（はり出しの
  // 外端そのもの）で渡す——`upperOverhang`（`wallLessEndAt`補正済みの基準からの増分）をそのまま
  // `cutDrawRange`へ加算すると、壁のない端部かつ上階のはり出しがある構成で基準がズレ二重計上/
  // 過小計上になりうるため、`stairOverhangOuter`（`localXOf`から直接出す絶対値。cutDrawRange
  // 自身と同じ基準）を別途用意する。
  const overhang = upperOverhangOf(pcut, columns);
  // （seq1/seq3はアキを標記しない＝2026-10-07撤回。以下はseq2/4/5等アキが出る面の話）
  // アキのバツは、手前に階段が描かれる区間だけ破線へ落とす（ユーザー実機指摘2026-08「6」C
  // 「但し、階段に隠れる部分は破線」）。隠れる範囲はプリミティブからの逆算ではなくflight自身の
  // 見付け矩形（stairFaceOccluderRects）から求める。
  // 階段の見付けシルエット（手前に実体がある範囲）。アキのバツ・見えがかり水平線の
  // どちらの破線判定にも同じ集合を使う。
  // 展開図一般化Phase 6b-2 段A: 遮蔽チャネルの正式化。`stairOccluderRects`（面固有の実装）から
  // `stairFaceHits`（ヒット列。Phase 6b-1）由来の`stairFaceOccluderRects`へ置き換える——
  // 出力は突き合わせテスト済みで完全不変（sectionStair.jsのstairFaceOccluderRectsヘッダ参照）。
  const occluders = stairFaceOccluderRects(cut.stairCut ?? null, cut);
  const gapMarks = splitGapMarksByStair(rawGapMarks, occluders);
  // 見えがかりの水平線のうち階段の背後に入る区間は破線（同指摘「その先は袋階段に隠れて
  // 見えなくなるが、アキ・バツのために破線で右側壁断面線まで」）。
  // 展開図一般化Phase 6b-2 C-2: gapMarksは**ここに含めない**——壁プリミティブ（wallContent）
  // だけが下の`clipContentAboveDrawnProfile`（輪郭より下を落とす処理）の対象になる。
  // アキ（gapMarks）は輪郭ではなくband自身の下端を使う（最終contentへは下で別途合流させる）。
  // ただし**階段帯に限り**、断面線（drawFloorProfile）があるときはアキのセルの下限もその輪郭へ
  // 持ち上げる（2026-10-08裁定。C-2の「二重にクランプしない」を階段帯だけ撤回——上の
  // `buildCutContent`へ`gapFloorProfile`で渡し、sectionEmit.jsのemitOpenGapMarksが適用する）。
  // 壁の端の縦線は、端面に突き当たる階段の実体（回転部のセル）の天端より下では引かない（clipWallEndVerticalsByStairMass）。
  // 切断線が内部を横切る flight の本体（裏面〜段板）に接する壁の断面の縁は、その区間を空ける（断面の中は描かない。
  // ユーザー指示 2026-10-15「moku4-3 1階 階段 A: 隔て板の右側断面線は 1FL から往路下ホールの天井まで、往路床断面から天井断面まで」）。
  const bodies = cut.bodySoffitSolid ? crossingFlightBodySections(cut.stairCut ?? null, cut, columns, cut.bodySoffitSolid) : [];
  const wallContent = clipWallEdgesInsideStairBodies(
    dashHorizontalsBehindStair(clipWallEndVerticalsByStairMass(wallPrims, cut, columns), occluders), bodies);
  // 下ささらの見えがかりのうち「断面内部（実体で囲まれた矩形の厳密内部）」に入る区間は
  // `stairPrimitivesForCut`が自身の出口（x終端クリップの前）で`columns`だけから一般判定する
  // （展開図一般化Phase 6b-2 設計(d)。ユーザー裁定2026-09-13）。旧`opts.slabBand`
  // （下階天井〜上階床の固定z帯を`zRef`から外部指定してカットする特例）はP3で削除済み
  // ——一般ルールが同じ問い（下ささらが床構造の中を通る区間）を`columns`の実体だけで答える。
  // 1 段目の段鼻が面端の外に出るとき（入口柱の面 Q1 まで上り口辺が下がる）は、flight の始端まで広げる
  // （上階はり出しの外端とは min/max で合成）。壁のある端の外（壁の中）へは出さない＝届く限界は壁のない端部の
  // 体裁延長込みの探査範囲 cutDrawRange(pcut)。範囲内なら undefined＝従来と同一。
  const stairOpts = {
    outerBound: mergeOuterBounds(overhang.stairOverhangOuter, flightStartOuterBound(cut.stairCut ?? null, cut, cutDrawRange(pcut))),
  };
  // 回転部の切断面の向こうの踏面・蹴上（hiddenTurnStepPrimitives の HIDDEN_STEP_MARK）は、断面線より下＝断面の後ろは細線破線、
  // 上＝断面の前の空間は細線実線で描く（ユーザー裁定 2026-10-15「moku4-3 1階 階段 C」）。
  // 切断線が内部を横切る flight の本体（裏面〜段板。`cut.bodySoffitSolid`＝自階の階段の裏面の立体があるときだけ）: 裏面の
  // 切断を CUT の水平線で描く（本体に接する壁の断面の縁は上の clipWallEdgesInsideStairBodies でその区間を空けた）。
  const stairContent = [
    ...clipHiddenStepLines(stairPrimitivesForCut(cut.stairCut ?? null, cut, columns, stairOpts), drawFloorProfile, cut),
    ...bodies.map(b => emitLine(pcut, b.xLo, b.zLo, b.xHi, b.zLo, ElevationLineRole.CUT, { neverDowngrade: true })),
  ];
  // WP-C: 構造梁（踊り場受け梁等）の加算寄与。stairContentと独立の別レイヤのため、
  // clipWallFloorEdgeUnderZigzag（階段ジグザグの向こうの壁縁除去）の対象には含めない。
  // 空中を横断する梁は、その位置の天井より上にあれば天井裏なので描かない（ユーザー指示 2026-10-15「2FL にある横架材見え掛かりは、
  // 天井仕上げ面より上（=天井裏）につき描画不要」）。天井の供給源は**階段室の裏面**（自階の層の stairSoffit を cellAt で評価）だけ
  // ——裏面の無い階段帯（鉄骨・上階が吹抜け）の天井は上階天井までの空で、部屋の CH は帯の天井ではない（2026-08「6」A
  // 「材が空中に横断しているので中線で鋼材の天地に線を描画」はそのまま）。階段室の外の点は null＝見える側。
  const selfLayer = (cut.layers ?? []).find(l => l?.role === 'self') ?? null;
  const soffitRoomId = selfLayer?.stairSoffit?.roomId ?? null;
  const ceilZAtWorld = soffitRoomId ? (x, y) => {
    const c = probeCtx.cellAt(selfLayer, x, y);
    return c?.room?.id === soffitRoomId && Number.isFinite(c.ceilZ) ? c.ceilZ : null;
  } : null;
  const structuralContent = structuralPrimitivesForCut(structuralContribution(cut.layers), pcut, columns, drawFloorProfile, { ceilZAtWorld });
  // 階段の断面プロファイルとの取り合い（ユーザー実機指摘2026-08「6」D2。sectionEmit.js参照）。
  const joined = zRef
    ? joinToStairProfile(wallContent, stairContent, pcut,
      { ...zRef, drawLo: cutDrawRange(pcut).lo, drawHi: cutDrawRange(pcut).hi })
    : wallContent;
  // クリップの対象は**壁の断面・見えがかり・建具の姿**だけ——階段自身の断面（踊り場桁枠・
  // ささら断面は踊り場から桁成ぶん下がる）と階段の見えがかり（正面視の破線梯子・1FL足元線・
  // ささらの端面）、構造梁（踊り場受け梁も梁成ぶん下がる）は断面線そのもの／階段の一部で、
  // ユーザー裁定2026-09で「描く」側（clipContentAboveDrawnProfileのヘッダ参照）。
  // アキ（gapMarks）はPhase 6b-2 C-2でこのクリップの対象から外れた——下端はband自身が決める。
  const wallOut = clipContentAtHiddenEnds(clipContentAboveDrawnProfile(
    clipWallFloorEdgeUnderZigzag(joined, stairContent), drawFloorProfile), cut.face);
  // 復路下の仕上げ空間（seq5）: 壁の断面・見えがかり・アキは天井＝復路の裏面より上を落とす（段板の中）。階段自身・構造梁は触らない。
  const roofed = clipContentInsideStairBody([...wallOut, ...gapMarks], underReturnSpace);
  return {
    content: [...roofed, ...stairContent, ...structuralContent],
    ...overhang,
  };
}

/**
 * 探査窓（`pcut.layerRunWindows`）→ 図側へ渡す「上階のはり出し」（面ローカルx・上階FLの絶対z）。
 * 断面ローカルxと面ローカルxは同値（`sectionCutPlane.js`の`faceCutLine`の不変条件）。
 * はり出す層が複数あればはり出し量の大きい方を採る——線を引く高さ（上階FL）は1つしか渡せない
 * ため。階段帯のlayersは自階＋直上階の2層なので、実際に選ばれるのは常に直上階
 * （`section/cuts/switchbackCuts.js`）。
 * はり出し外端に立つ切断壁（上階の腰壁）の向こう側の面（`upperFloorCutEnds`）も**同じ探査の
 * 結果**（`columns`）から写す——図側で壁を引き直さないため（`sectionContent.js`の
 * `upperFloorCutWallEndsOf`）。
 *
 * 上階FL断面線を許す端（`upperFloorEnds`）も**ここで同じはり出しに載せる**——探査窓は上階の
 * **壁**の伸びしか見ないので、上階が吹抜けのまま境界に腰壁だけが立つ端では床の無い位置に
 * 2FL線が出る。gateは上部吹抜けを持つ部屋帯と**同じ1つの関数**（`elevationFaces.js`の
 * `upperFloorEndsOf`）で、下階graphは自階の層・上階graphははり出しを決めた層から取る
 * （どちらもこの`pcut.layers`が唯一の情報源。図側で引き直さない）。落とすのは床の断面線だけで、
 * はり出し自体（天井断面線・壁エッジ）は残す——上階の壁は実在するため。
 * stairOverhangOuter（QA是正2026-09-12その6）… `upperOverhang`と同じ勝ち窓（best）から、
 * `stairDrawRange`（section/sectionStair.js）へそのまま渡せる**面ローカルx絶対値**を計算した
 * もの。`upperOverhang`自体は`wallLessEndAt`補正済みの`baseLo/baseHi`からの**増分**であり、
 * その基準は`cutDrawRange`自身の基準（常に`probeExtendLoMm/HiMm`込み）と食い違うことがある
 * （壁のない端部かつ上階のはり出しがある構成）ため、`stairDrawRange`には増分ではなく
 * `localXOf`で直接出した絶対値を渡し、`Math.min/max`で比較する（基準の取り方に依存しない）。
 * @param {import('./section/sectionTypes.js').SectionCut} pcut
 * @param {import('./section/sectionTypes.js').SectionColumn[]} [columns]
 * @returns {{upperOverhang:{lo:number,hi:number}|undefined, upperFloorZ:number|undefined,
 *   upperFloorCutEnds:{lo:number|null,hi:number|null}|undefined,
 *   upperFloorEnds:{lo:boolean,hi:boolean}|undefined,
 *   stairOverhangOuter:{lo:number,hi:number}|undefined}}
 */
export function upperOverhangOf(pcut, columns) {
  const windows = pcut.layerRunWindows;
  if (!windows) {
    return { upperOverhang: undefined, upperFloorZ: undefined, upperFloorCutEnds: undefined,
      upperFloorEnds: undefined, stairOverhangOuter: undefined };
  }
  const line = pcut.line;
  let best = null;
  // 比較の基準は**自階の窓**（＝壁のない端部の体裁のはり出しを含む従来の探査範囲）——
  // その延長ぶんは図側が既にdrawnX0/drawnXRunで描いており、ここで二重に足さない。
  // QA是正2026-09（§5.12 D2-1是正・項目1/4）: 単一情報源`wallLessEndAt`（elevationFaces.js）
  // で選ぶ——**真に壁のない端部**だけ従来どおり`probeExtendLoMm/HiMm`込みの基準、wallFilterで
  // 除外された実壁がある端（hasWallAtLocal0/Run=falseだがwallLessEndAt=false）は面自身の
  // 真の境界（line.lo/hi）に戻す——`section/sectionContent.js`の`layerRunWindowsOf`と
  // **同じ基準**でなければ、そちらが正しく測った窓（`windows`の値）をここで再び「壁のない
  // 端部込みの基準」と比べてしまい、実壁のoverhangが常に0（該当なし）に潰れる（実測: 実データ
  // 「6」D2でupperFloorZ自体が出ずelevationFigure.jsのcapもupperFloorEdgeSpansも一切発火
  // しなかった根本原因）。`pcut.face`が無い（単体テストの手組みcut等）呼び出しは従来どおり
  // 両端とも拡張込みの基準＝出力完全不変。
  const worldLoIsWallLess = pcut.face
    ? (pcut.dirSign > 0 ? wallLessEndAt(pcut.face, '0') : wallLessEndAt(pcut.face, 'Run')) : true;
  const worldHiIsWallLess = pcut.face
    ? (pcut.dirSign > 0 ? wallLessEndAt(pcut.face, 'Run') : wallLessEndAt(pcut.face, '0')) : true;
  const baseLo = worldLoIsWallLess ? line.lo - (line.probeExtendLoMm ?? 0) : line.lo;
  const baseHi = worldHiIsWallLess ? line.hi + (line.probeExtendHiMm ?? 0) : line.hi;
  for (const [layer, w] of windows) {
    if (layer?.role === 'self') continue;
    // world側のはみ出し → 面ローカルの端（dirSign>0ならworldのlo側がローカルx=0側）。
    const worldLo = Math.max(0, baseLo - w.lo), worldHi = Math.max(0, w.hi - baseHi);
    const local = pcut.dirSign > 0 ? { lo: worldLo, hi: worldHi } : { lo: worldHi, hi: worldLo };
    if (local.lo + local.hi <= 0) continue;
    if (!best || local.lo + local.hi > best.local.lo + best.local.hi) best = { local, layer, w };
  }
  if (!best) {
    return { upperOverhang: undefined, upperFloorZ: undefined, upperFloorCutEnds: undefined,
      upperFloorEnds: undefined, stairOverhangOuter: undefined };
  }
  // 面端のCLを引く下階graphは自階の層（面はそのgraphのcomposeRoomFacesで作られている）。
  // 面・自階graphのどちらかが欠ける切断（単体テストの手組みcut等）は**gateを渡さない**＝
  // 図側の既定（両端とも許す）＝従来と完全同一へ倒す。
  const selfLayer = (pcut.layers ?? []).find(l => l?.role === 'self');
  const floorEnds = pcut.face && selfLayer?.graph && best.layer?.graph
    ? upperFloorEndsOf(pcut.face, selfLayer.graph, best.layer.graph) : undefined;
  // stairOverhangOuter: best.w（勝ち窓。worldLo/worldHi）を`localXOf`で直接面ローカルxへ変換する
  // （`cutDrawRange`自身と同じ変換＝基準が1つ）。dirSignでlo/hi側が入れ替わるのは`local`と同じ規約。
  const outerA = localXOf(pcut, best.w.lo), outerB = localXOf(pcut, best.w.hi);
  const stairOverhangOuter = pcut.dirSign > 0
    ? { lo: outerA, hi: outerB } : { lo: outerB, hi: outerA };
  return { upperOverhang: best.local, upperFloorZ: best.layer.floorZMm,
    upperFloorCutEnds: upperFloorCutWallEndsOf(columns, best.layer.floorZMm),
    upperFloorEnds: floorEnds, stairOverhangOuter };
}

/**
 * STRAIGHT/STRAIGHT_LANDING（§6.2・WP-E6）の歩行順面シーケンス。straightCutsが返す各cutを
 * そのままbuildSectionFigure（sectionEngine.js。face/floorSegments/ceilingProfileの算出も
 * エンジン汎用の経路に委ねる。straightCuts.jsヘッダコメント参照）へ渡すだけ——SWITCHBACKの
 * ような手組みのfloorSegments/ceilingProfile算出（往路・復路二重管理の特殊事情）が無いため。
 * straightCutsがnullを返す条件（対象外タイプ・cells空・floorHeight未確定・面分類不能）は
 * そのままstairFaceSequenceのnull契約へ延長する。
 * @returns {ReturnType<typeof stairFaceSequence>}
 */
function buildStraightFaceSequence(stair, faces, graph, opts) {
  const table = straightCuts(stair, faces, graph, opts);
  if (!table) return null;
  const probeCtx = makeProbeContext(table.cuts[0].layers);
  return table.cuts.map(cut =>
    buildSectionFigure(cut, probeCtx, { wallFaces: faces, ceilZ: cut.zRange?.hiZ }));
}

/**
 * 階段の歩行順面シーケンスを組み立てる（WP-E6: タイプ別ディスパッチ。ファイル冒頭コメント参照）。
 * @param {import('@core').Stair} stair
 * @param {object[]} faces - composeRoomFaces(stairRoom, graph) の結果
 * @param {object} graph - 設置階のgraph
 * @param {{floorHeight:number, chUpperAbsMm:number, chLowerMm:number}} opts
 *   chUpperAbsMm … 上階天井の絶対高さ（floorHeight+CH_upper。呼び出し側で計算済みの値をそのまま使う）。
 *   chLowerMm … 設置階の天井高さ（CH。絶対高さそのもの＝設置階FL=0基準）。
 * @returns {Array<{seqNo:string, face:object, floorSegments:object[], ceilingProfile?:Array<[number,number]>,
 *   floorProfile?:Array<[number,number]>|null,
 *   content:object[], skipBaseboard:true, skipWallLabel:true, floorSpanX?:object}>|null}
 *   floorProfile … その面の**断面線（下側の輪郭）**（elevationFloorProfile.jsのFloorProfile）。階段下に
 *   部屋が無く、かつ縦断する階段の断面線が繋がらない（鉄骨等）か、縦断する階段寄与が無い面（seq1/seq3）
 *   はnull（＝下限なし）。elevationStair.jsのfaceOverride経由でbuildFaceFigureへ
 *   渡り、面端の縦線の下端に使う（contentのクリップ・floorSegments[].flatLineSpanXと同じ輪郭）。
 */
export function stairFaceSequence(stair, faces, graph, opts = {}) {
  if (stair && (stair.type === StairType.STRAIGHT || stair.type === StairType.STRAIGHT_LANDING)) {
    return buildStraightFaceSequence(stair, faces, graph, opts);
  }
  if (stair && UNSUPPORTED_FAN_LANE_TYPES.includes(stair.type)) {
    return fanLaneCuts(stair); // 常にnull（L_TURN/FLARED/OPEN_WELL＝扇形レーン未対応。fanCuts.js参照。WINDINGは下のswitchbackCutsへ）
  }

  const cutTable = switchbackCuts(stair, faces, graph, opts);
  if (!cutTable) return null; // フォールバック契約: switchbackCutsのnull条件をそのまま延長する

  // wOut1/wOut2は**取り出さない**——面の選択はcuts表が唯一の情報源で、ここで独自に選び直すと
  // 「その切断が見ている面」との食い違いが再発する（ユーザー明示指示2026-08その11。seq2/seq4参照）。
  const {
    cuts, wEntry, wLanding, underFloorZ, hasRoomUnder,
    ceilTopAbs, ceilLowAbs, kneeDrop,
  } = cutTable;
  const { landingLen } = cutTable.params;
  const floorHeight = opts.floorHeight;
  const cutOf = seqNo => cuts.find(c => c.seqNo === seqNo);
  // 壁のない端部の延長量（content側。図形側elevationFigure.jsのdrawnX0/drawnXRunと同じ値を使い、
  // 同じ端で線の長さを揃える）。倍率決定の1パス目は未指定＝既定の仮値（elevationStyle.js）。
  const endExtendMm = opts.wallLessEndExtendModelMm ?? DEFAULT_WALL_LESS_END_EXTEND_MM;
  // 帯自身の部屋（階段室）。見えがかり壁の探索範囲をこの部屋の広がりに限る
  // （sectionProbe.jsのwithinViewRoom。ユーザー実機指摘2026-08「6」C・裁定A案）。
  const bandRoom = (graphList(graph, 'rooms') ?? []).find(r => r.id === stair.roomId) ?? null;
  // 包絡矩形は世界座標の箱なので**自階graphで一度だけ**求め、全レイヤーで使う。
  const bandRoomBounds = bandRoom ? roomBounds(bandRoom.cells, graph) : null;
  // 往復間の壁の芯を一点鎖線で示す（ユーザー実機指摘2026-08「6」C「1500の一点鎖線が出ていない」）。
  // この壁は切断線から見て**面の裏側**へ伸びるため、elevationFigure.jsの直交壁検出
  // （室内側へ突出する袖壁が対象）に掛からず、一点鎖線の源が1つも無かった。
  // 面に直交し、かつ芯が面の範囲内にある面にだけ載せる（面と平行なB/D側には出ない）。
  // **断面線（下側の輪郭）**（ユーザー明示指示2026-09「展開図では、断面線の外は描画しない」
  // 「階段下に部屋がある場合、断面下は描画しない」「階段下に部屋がない場合、…階段下の設置階の
  // 床断面または（連続する階段なら）階段の一部まで描画」）。当初は「階段下部屋の有無ひとつ」で
  // 分岐し、部屋が無ければnull（＝下限なし＝設置階FLまで描く）としたが、木造については
  // 2026-10-08に下記の2条件へ改めた（鉄骨は従来どおり）。断面線があるときは「帯の床（floorSegmentsのステップ関数）」と
  // 「この切断が**縦断する**階段寄与」のmaxで、2FL断面→階段断面→踊り場断面→壁断面と続く
  // 閉じた輪郭になる（実機「6」D2のご指摘）。この輪郭1つが、contentのクリップ・アキの下限・
  // 区間の床線の範囲（withFlatLineSpans）すべての単一情報源。
  // **分岐は2条件の論理和**（ユーザー裁定2026-10-08「階段断面、踊り場、壁、設置階上階天井で展開断面が
  // 完結しており、その外側（階段下等）は描画しない」「『階段下部屋の有無』は鉄骨階段の判定として正しい。
  // 主要構造が木造の階段は、断面線が繋がっているか/いないか。蹴込板がなく踏面だけの階段は下を描く」）:
  // (a) 階段下部屋がある、または (b) この切断が縦断する階段寄与があり、その断面線が繋がっている
  // （`stairSectionIsClosed`＝現状は木造・RC）。縦断する階段寄与の無い面（seq1/seq3）は従来どおりnull。
  // (c) 横断の切断が回転部のスライスを段状に切る面（回り階段の seq3）は、段状の天端が断面線。スライスは実体の床なので
  //     材質によらず閉じる（ユーザー指摘 2026-10-15「moku4-3 1階 階段 C: 閉じた断面図形の外に太線の延長はない」）。
  const floorProfileFor = (cut, segs) => {
    const stairPart = cut ? stairCutFloorProfile(cut.stairCut ?? null, cut, null) : null;
    const stepped = cut ? crossingLandingFloorProfile(cut.stairCut ?? null, cut) : null;
    const closed = hasRoomUnder || (stairPart && stairSectionIsClosed(stair)) || !!stepped;
    if (!closed) return null;
    let profile = floorProfileFromSegments(segs);
    if (stairPart) profile = mergeFloorProfiles(profile, stairPart);
    if (stepped) profile = mergeFloorProfiles(profile, stepped);
    return profile;
  };
  const midWall = cutTable.wall ?? null;
  const midWallCLXs = face => {
    if (!midWall || !face || midWall.isVertical === face.isVertical) return undefined;
    const x = (midWall.axisCL.effectiveValue - face.originWorld) * face.dirSign;
    return (x > GAP_EPS && x < face.run - GAP_EPS) ? [x] : undefined;
  };

  // WP-E5b: content生成はエンジン経由（makeProbeContext→cutごとにcontentForCut）。
  // 全cutが同一のlayers参照を共有する（switchbackCuts.js参照）ため、probeCtxは1回だけ作る。
  const probeCtx = makeProbeContext(cuts[0].layers);
  // 項目A: 自階の直上の層があれば実Room有無で1F天井高さ/上階天井を判定する
  // （buildLaneFloorAndCeiling）。無ければフォールバック（挙動不変）。
  // Phase 7b-2: 旧`layers.find(l => l.role !== 'self')`は配列先頭の非自階層を無条件に拾うため
  // below層しか無い帯やN層（3層以上）で「自階の直上」ではない層を誤って選びうる——
  // 一般規則（floorZMmがself超で最小）で選ぶ`layerDirectlyAboveSelf`へ置換（layers.length===2の
  // 現行データでは常に同じ結果。3層以上でのみ違いが出る＝実データ未経由。§5.12「Phase 7設計」）。
  const aboveLayer = layerDirectlyAboveSelf(cuts[0].layers);
  // 1つの切断 → その面のentryのcontent系フィールド（content＋上階のはり出し）。
  // はり出し（upperOverhang/upperFloorZ）はcontentと同じ探査窓から出るため、同じ呼び出しで受ける。
  const contentFields = (cut, zRef = null, drawFloorProfile = null, underReturnSpace = null) =>
    contentForCut(cut, probeCtx, endExtendMm, bandRoomBounds, zRef, drawFloorProfile, underReturnSpace);

  const entries = [];

  // 階段の裏面（E5）。各 seq の切断の天井にする（体裁の ceilingProfile とエンジンの cut.ceilClip を同じ区間列から）。
  // 足元の外はその面の既存の天井（seq2/4 は上で決めた N の CH／上階天井の階段状、seq1/3/5 は上階天井 ceilTopAbs）でつなぐ。
  // 面の端（左右）の裏面の高さは CH 寸法の鎖が使う（soffitEnds）。裏面が無い切断は applySoffit が null で何も変えない。
  const soffit = opts.stairSoffit ?? null;
  const soffitEnds = {};
  // 隔て板（往復レーンの境界の壁。上階の graph で見つけた wall＝「上階隔て板」）の材の範囲（同じ軸 CL の重なる壁＝オーナー壁＋
  // 薄壁の合併）。幅方向を横切る切断（seq1/seq3）にだけ渡し、帯をはさんで低い側の天井を向こう面まで延ばす
  // （applyStairSoffitToCut → extendLowerCeilingAcrossStrip）。
  const partitionStrip = partitionStripOf(midWall, opts.upperGraph ?? graph);
  const applySoffit = (seqNo, base) => {
    const cut = cutOf(seqNo);
    const strip = partitionStrip && midWall && cut?.line && cut.line.isVertical !== midWall.isVertical ? partitionStrip : null;
    // 壁のない端（face.hasWallAtLocal0/Run が false）: 上り口の先の部屋の天井（base）が裏面より低ければそこで終える。
    const openEnds = cut?.face ? { left: cut.face.hasWallAtLocal0 === false, right: cut.face.hasWallAtLocalRun === false } : null;
    const applied = applyStairSoffitToCut(soffit, cut, base, ceilTopAbs, { partitionStrip: strip, openEnds });
    if (applied) soffitEnds[seqNo] = applied.ends;
    return applied;
  };

  // ---- 1: 踊り場前縁（見返り・全幅） ----
  // 隔て板が上階へ続く切断（continuousWallAcross。木造 U 字階段の最上階以外）では、切断線が内部を横切る flight の本体
  // （裏面〜段板）の断面を描くため、自階の階段の裏面の立体（ceiling/stairSoffit.js の式が唯一の供給源）を切断に添える。
  {
    const cut1 = cutOf('1');
    if (cut1?.continuousWallAcross) {
      const selfLayer1 = (cut1.layers ?? []).find(l => l?.role === 'self') ?? null;
      const riser = riserOf(stair, floorHeight);
      const floorZ1 = selfLayer1 ? probeCtx.floorZOf(bandRoom, selfLayer1) : 0;
      const solid = Number.isFinite(riser) ? (stairSoffitSolids({ stair, graph, riser, floorZMm: floorZ1 })[0] ?? null) : null;
      if (solid) cut1.bodySoffitSolid = solid;
    }
  }
  const rawSegments1 = flatFloorSegments(wEntry.run, underFloorZ, ceilTopAbs - underFloorZ);
  const floorProfile1 = floorProfileFor(cutOf('1'), rawSegments1);
  const floorSegments1 = withFlatLineSpans(rawSegments1, floorProfile1);
  const soffit1 = applySoffit('1', null);
  const fields1 = contentFields(cutOf('1'), { ceilLowAbs, floorHeight }, floorProfile1);
  entries.push({
    seqNo: '1', face: wEntry,
    floorSegments: floorSegments1,
    floorProfile: floorProfile1,
    ...(soffit1 ? { ceilingProfile: soffit1.ceilingProfile } : {}),
    chDimSplitAbsYs: [floorHeight],
    upperOverhang: fields1.upperOverhang, upperFloorZ: fields1.upperFloorZ,
    upperFloorCutEnds: fields1.upperFloorCutEnds,
    // 上階の床が実在する端だけ2FL線を許すgate（上部吹抜けを持つ部屋帯と共通。upperOverhangOf）。
    upperFloorEnds: fields1.upperFloorEnds,
    // 実機フィードバック第3弾F: 往復間の壁が2F腰壁（kneeDrop.knee）なら両端縦線を除く
    // （kneeWallCapContent参照）。アキのバツは踊り場前縁（seq1/seq3）には出さない
    // （ユーザー指示2026-10-07。旧「第3弾D」のささら外側のアキXも撤回）。
    content: kneeWallCapContent(fields1.content, cutOf('1'), kneeDrop, floorHeight),
    skipBaseboard: true, skipWallLabel: true,
  });

  // ---- 2: 往路レーンから見る面（往復レーンの境界＝中心1） ----
  // ユーザー明示指示2026-08その11「A,B,C,Dの抽出と、順番決めロジックがごっちゃになっている」
  // 「展開の向きは絶対。後から順番」: **面は切断定義表（switchbackCuts.js）が持つ「その切断が
  // 見ている面」をそのまま使う**——ここで`wOut1`（＝視線の背後の壁）を独自に選び直していたため、
  // 図の向きと面の幾何が食い違い、面由来の寸法・向こう側判定が反対側を向いていた
  // （実機「6」D1が、向こうに壁の無いはずの面で1500+2000に割れた）。
  const outFace2 = cutOf('2').face;
  // 走行方向の面（seq2/4）の床区間と、上階の実Roomが判定できないときの天井のフォールバック。
  // 踊り場側の端（'left'/'right'）は切断定義表の `landingEnd`（面の向き＝視線から決まる。ユーザー裁定
  // 2026-10-15「上り口の左右は回転方向次第」）で、「seq2は踊り場が右・seq4は左」の決め打ちはしない。
  // レーン区間(floorDeltaMm:0)の床線(z=0)は「階段設置階FLは階段断面に出会ったらそこが終点」
  // （ユーザー明示指示）——段鼻の断面ジグザグ(stairCutのcontent)がその先の輪郭を表すため、
  // 床の水平線をそのまま引くとジグザグの下を素通りして踊り場側の隅まで貫通する。
  // 旧実装は`hideFlatLine`で区間を丸ごと非描画にしており、階段の**手前**（下りた先＝壁の
  // ない端部のはり出し）まで消していた——ユーザー実機指摘2026-09「「6」D1: 1階Y2から3500、
  // 下りた階段の先（左側）に1FL断面はり出しが正解」。
  // 切り詰めはここでは決めない: 断面線（floorProfileFor）から`withFlatLineSpans`が導出する
  // （旧・段鼻の出の手計算はこの区間だけの別経路になっていたため廃止した）。
  // フォールバックの天井は常に「上り口側=1F天井 → 奥の吹抜け=上階天井」の形（最上階キャップの
  // 分岐は廃止。buildLaneFloorAndCeiling参照）。
  const laneSegsFor = (face, landingEnd) => {
    const laneLen = Math.max(0, face.run - landingLen);
    if (laneLen <= 0) {
      return {
        floorDeltaSegs: [{ loX: 0, hiX: face.run, floorDeltaMm: underFloorZ }],
        fallbackCeilingProfile: [[0, ceilTopAbs], [face.run, ceilTopAbs]],
      };
    }
    const landingX = face.run - laneLen; // 踊り場が右なら踊り場区間の始まり、左ならレーン区間の始まり
    return landingEnd === 'left'
      ? {
          floorDeltaSegs: [
            { loX: 0, hiX: landingX, floorDeltaMm: underFloorZ },
            { loX: landingX, hiX: face.run, floorDeltaMm: 0 },
          ],
          fallbackCeilingProfile: [[0, ceilTopAbs], [landingX, ceilTopAbs], [face.run, ceilLowAbs]],
        }
      : {
          floorDeltaSegs: [
            { loX: 0, hiX: laneLen, floorDeltaMm: 0 },
            { loX: laneLen, hiX: face.run, floorDeltaMm: underFloorZ },
          ],
          fallbackCeilingProfile: [[0, ceilLowAbs], [laneLen, ceilTopAbs], [face.run, ceilTopAbs]],
        };
  };
  {
    const { floorDeltaSegs: floorDeltaSegs2, fallbackCeilingProfile: fallbackCeilingProfile2 } =
      laneSegsFor(outFace2, cutOf('2').landingEnd);
    // 項目A: floorSegments/ceilingProfileはbuildLaneFloorAndCeiling（above層の実Room有無）で
    // 決める——レーン境界だけの決め打ちだった旧実装を置き換える。fallbackCeilingProfile2
    // はaboveLayer未指定時に使う旧来のリテラル。
    const { floorSegments: rawSegments2, ceilingProfile: ceilingProfile2 } = buildLaneFloorAndCeiling(
      outFace2, floorDeltaSegs2, aboveLayer, probeCtx, ceilLowAbs, ceilTopAbs, fallbackCeilingProfile2);
    const floorProfile2 = floorProfileFor(cutOf('2'), rawSegments2);
    const soffit2 = applySoffit('2', ceilingProfile2);
    entries.push({
      seqNo: '2', face: outFace2, landingEnd: cutOf('2').landingEnd,
      floorSegments: withFlatLineSpans(rawSegments2, floorProfile2),
      floorProfile: floorProfile2,
      ceilingProfile: soffit2 ? soffit2.ceilingProfile : ceilingProfile2,
      ...contentFields(cutOf('2'), { ceilLowAbs, floorHeight }, floorProfile2),
      skipBaseboard: true, skipWallLabel: true,
    });
  }

  // ---- 3: W_landing（全幅。階段の重ね描きなし） ----
  // 平場の踊り場: 床は常に踊り場レベル（階段下に部屋が無くても下は描かない。2026-10-08裁定）。
  const rawSegments3 = flatFloorSegments(wLanding.run, cutTable.landingAbs, ceilTopAbs - cutTable.landingAbs);
  const floorProfile3 = floorProfileFor(cutOf('3'), rawSegments3);
  const soffit3 = applySoffit('3', null);
  entries.push({
    seqNo: '3', face: wLanding,
    floorSegments: withFlatLineSpans(rawSegments3, floorProfile3),
    floorProfile: floorProfile3,
    ...(soffit3 ? { ceilingProfile: soffit3.ceilingProfile } : {}),
    ...contentFields(cutOf('3'), { ceilLowAbs, floorHeight }, floorProfile3),
    skipBaseboard: true, skipWallLabel: true,
  });

  // ---- 4: 往路外側の壁を復路側から見る面（seq2の鏡像構成） ----
  // seq2と同じく、面は切断定義表が持つ「その切断が見ている面」を使う（上のコメント参照）。
  const outFace4 = cutOf('4').face;
  {
    // seq2と同じ規則（seq4はseq2の鏡像構成で踊り場側の端が逆になる。端は landingEnd から）。
    const { floorDeltaSegs: floorDeltaSegs4, fallbackCeilingProfile: fallbackCeilingProfile4 } =
      laneSegsFor(outFace4, cutOf('4').landingEnd);
    // 項目A: seq2と同じくbuildLaneFloorAndCeilingで決める（fallbackCeilingProfile4は
    // aboveLayer未指定時に使う旧来のリテラル）。
    const { floorSegments: rawSegments4, ceilingProfile: ceilingProfile4 } = buildLaneFloorAndCeiling(
      outFace4, floorDeltaSegs4, aboveLayer, probeCtx, ceilLowAbs, ceilTopAbs, fallbackCeilingProfile4);
    const floorProfile4 = floorProfileFor(cutOf('4'), rawSegments4);
    const soffit4 = applySoffit('4', ceilingProfile4);
    entries.push({
      seqNo: '4', face: outFace4, landingEnd: cutOf('4').landingEnd,
      floorSegments: withFlatLineSpans(rawSegments4, floorProfile4),
      floorProfile: floorProfile4,
      ceilingProfile: soffit4 ? soffit4.ceilingProfile : ceilingProfile4,
      ...contentFields(cutOf('4'), { ceilLowAbs, floorHeight }, floorProfile4),
      skipBaseboard: true, skipWallLabel: true,
    });
  }

  // ---- 5: 復路断面を反対側から見た図（踊り場側の端は landingEnd。「6」では右端） ----
  {
    const outFace5 = cutOf('5').face;
    // 復路下の仕上げ空間（木造。復路下の壁〜到達辺）: 断面線は復路の段板の裏ではなく床まで下げ（床断面線・復路下の壁の
    // 断面がその空間に描かれる）、天井＝復路の裏面を天井仕上げの断面線として足し、裏面より上の content は落とす。
    // 床は階段室の床（層スタックの floorZFor。壁の天端 addUnderReturnTops と同じ基準）——階段下に部屋があって帯の床が
    // 踊り場（underFloorZ）でも、この空間は到達辺の部屋へ開く床面なので床区間を分ける。
    const selfLayer5 = (cutOf('5').layers ?? []).find(l => l?.role === 'self') ?? null;
    const selfFloorZ5 = selfLayer5 ? probeCtx.floorZOf(bandRoom, selfLayer5) : 0;
    const underReturn5 = underReturnSpaceOf(stair, graph, cutOf('5'), floorHeight, selfFloorZ5, ceilLowAbs);
    const rawSegments5 = underReturn5 && Math.abs(underFloorZ - selfFloorZ5) > GAP_EPS
      ? [[0, underReturn5.loX, underFloorZ], [underReturn5.loX, underReturn5.hiX, selfFloorZ5], [underReturn5.hiX, outFace5.run, underFloorZ]]
        .filter(([a, b]) => b - a > GAP_EPS)
        .map(([loX, hiX, z]) => ({ loX, hiX, floorDeltaMm: z, chMm: ceilTopAbs - z }))
      : flatFloorSegments(outFace5.run, underFloorZ, ceilTopAbs - underFloorZ);
    const stairProfile5 = floorProfileFor(cutOf('5'), rawSegments5);
    const floorProfile5 = underReturn5
      ? floorProfileWithFloorOn(stairProfile5, underReturn5.loX, underReturn5.hiX, selfFloorZ5)
      : stairProfile5;
    const soffit5 = applySoffit('5', null);
    // 復路の本体（裏面〜段板の上面＝床へ下げる前の断面線）の中の content を落とすための上面
    const fields5 = contentFields(cutOf('5'), { ceilLowAbs, floorHeight }, floorProfile5,
      underReturn5 ? { ...underReturn5, bodyTop: stairProfile5 } : null);
    entries.push({
      seqNo: '5', face: outFace5, landingEnd: cutOf('5').landingEnd,
      floorSegments: withFlatLineSpans(rawSegments5, floorProfile5),
      floorProfile: floorProfile5,
      // 最終段の天端（上階FL）の位置は、復路下の仕上げ空間で床へ下げる前の断面線が持つ（上階FL断面線のはね出し用）
      ...(underReturn5 ? { stairFloorProfile: stairProfile5 } : {}),
      ...(soffit5 ? { ceilingProfile: soffit5.ceilingProfile } : {}),
      ...fields5,
      content: [...fields5.content, ...(underReturn5
        ? [...underReturnCeilingPrimitives(underReturn5), ...underReturnBaseboardPrimitives(underReturn5, cutOf('5'), probeCtx, selfLayer5, selfFloorZ5, bandRoom, graph, endExtendMm)]
        : [])],
      skipBaseboard: true, skipWallLabel: true,
    });
  }

  // 上階FL断面線のはね出し（最終段の天端がある壁のない端。ユーザー指示 2026-10-15）。
  for (const e of entries) e.content.push(...upperFloorEndLines(e, floorHeight, endExtendMm));

  // 展開記号（ユーザー実機指摘2026-08「階段は、のぼり方で作図順が決まるので、展開記号は
  // ケースバイケース」「「6」B2：Dが正解。先のDは往路階段で切断して…このDは、復路階段で切断して、
  // 「5」D1と同面の壁を見ている」）:
  // **記号は切断の「視線の向き」だけで決まる**——`cut.viewSign`は視線が向く世界方向
  // （`isSightlineShape`の契約: 見えがかり候補は line から+viewSign側にある）なので、
  // 面の規約（`letterOf(isVertical, inward)`。inwardは視線と逆向き）へは`-viewSign`を渡す。
  // 旧実装は`reorientFace`が歩行方向で倒したdirSignから引いていたため、実機で seq2 と seq5 は同じ
  // towardS1（＝同じ向きを見る）なのに別記号になっていた（ユーザー指摘: どちらもD）。seq4だけが
  // towardS0＝逆向きで B になる。2026-10-15 以降は dirSign も同じ視線の規則（`viewDirSign`）で決まる
  // ので記号と dirSign は常に `DIR_SIGN[letter]===dirSign` を満たすが、採番の入口は視線のまま。
  // labelは歩行順に採番し直す（`labelFaces`。部屋のコンパス順の連番を持ち込まない）。
  const relabeled = labelFaces(entries.map(e => {
    const cut = cutOf(e.seqNo);
    if (!cut?.line) return e.face;
    return { ...e.face, letter: letterOf(cut.line.isVertical, -cut.viewSign) };
  }));
  const chDimChains = stairChDimChains(entries, {
    landingAbs: cutTable.landingAbs, hasRoomUnder, chLowerMm: ceilLowAbs, floorHeight, chUpperAbsMm: ceilTopAbs,
    soffitEnds,
  });
  return entries.map((e, i) => ({
    ...e, face: relabeled[i],
    // 往復間の壁の芯（一点鎖線＋寸法の鎖の分割点。ユーザー指示 2026-10-15「隔て板の中心を描くなら、
    // 寸法線を 910 づつに分ける」）。elevationStair.jsのfaceOverride経由でbuildFaceFigureのextraCenterLineXsへ渡る。
    extraCenterLineXs: midWallCLXs(relabeled[i]),
    chDimChains: chDimChains[i],
  }));
}

// 面の左右の端で「踊り場スラブが切れる」のはどちら側か。
//   - 幅方向に横断する面（seq1=上り口・seq3=踊り場の壁）は面の全長で踊り場を横切る＝両端とも踊り場側。
//   - 走行方向の面（seq2/4/5）は片側だけ。どちらの端かは階段の回転方向で変わる（ユーザー裁定 2026-10-15）ので、
//     entry.landingEnd（切断定義表が面の向きから決める）を使う。この表は landingEnd を持たない呼び出し
//     （「6」の構成＝seq2/5 は踊り場が右・seq4 は左）の既定。
// 走行方向の面のもう一方の端（上り口側）は、壁の向こうの通常の部屋の断面（1F天井・2FL）が現れる。
const LANDING_END_BY_SEQ = { '1': 'both', '2': 'right', '3': 'both', '4': 'left', '5': 'right' };

/**
 * 階段帯の高さ寸法（CH寸法）の鎖を面ごと・左右の端ごとに決める（ユーザー明示指示2026-08その12）。
 *
 * 規則:
 *   - 寸法は「床断面・踊り場断面・天井断面のいずれかから、いずれかまで」を1本とする。
 *   - 端ごとに断面のプロファイルが決まる。踊り場スラブが切れる端は
 *     `[1FL→踊り場][踊り場→上階天井]`（階段下に部屋があるときは踊り場より下は別室なので
 *     `[踊り場→上階天井]`の1本）、切れない端は壁の向こうの通常断面
 *     `[1FL→1F天井][2FL→2F天井]`。
 *   - **帯の左から端を順に見て、前の端とプロファイルが変わったときだけ記入する**
 *     （「前の展開断面と高さが変わる場合、新たな断面間寸法を記入」）。先頭の端は必ず記入する。
 * 実機「6」: C左=踊り場側(記入)→C右=同じ(なし)→D1左=通常(記入)→D1右=踊り場側(記入)→
 * A左/A右/B左=同じ(なし)→B右=通常(記入)→D2左=同じ(なし)→D2右=踊り場側(記入)。
 * @param {Array<{seqNo:string}>} entries
 * @param {{landingAbs:number, hasRoomUnder:boolean, chLowerMm:number, floorHeight:number, chUpperAbsMm:number,
 *   soffitEnds?:Object<string,{left:number|null,right:number|null}>}} h  soffitEnds … seqNo → 面の左右の端の階段の裏面の高さ（E5。無ければ従来）
 * @returns {Array<{left:Array<[number,number]>|null, right:Array<[number,number]>|null}>}
 */
export function stairChDimChains(entries, h) {
  // 踊り場側の端の断面。階段下に部屋があるときは踊り場より下は別室のため帯の床が踊り場になり、
  // 上の断面は2FL・2F天井（ユーザー明示指示「2FL 寸法線はここで分ける」＝既存の受け入れ済み挙動）。
  // 部屋が無ければ1FLから踊り場・踊り場から2F天井（今回の指示）。
  // 上端は上階天井。ただし階段の裏面（E5。h.soffitEnds[seqNo].left/right＝その端の裏面の高さ）が天井になる端
  // （踊り場側の端は階段の足元の中）は、その端の裏面の実測値（四捨五入）にする（裁定 Q3）。通常の断面の端
  // （壁の向こうの部屋）は裏面と無関係なので変えない。
  const landingWith = upperAbs => (h.hasRoomUnder
    ? [[h.landingAbs, h.floorHeight], [h.floorHeight, upperAbs]]
    : [[0, h.landingAbs], [h.landingAbs, upperAbs]]);
  const soffitUpper = (seqNo, end) => {
    const v = h.soffitEnds?.[seqNo]?.[end];
    return Number.isFinite(v) ? Math.round(v) : h.chUpperAbsMm;
  };
  const normal = [[0, h.chLowerMm], [h.floorHeight, h.chUpperAbsMm]];
  const valid = chain => chain.filter(([lo, hi]) => hi - lo > GAP_EPS);
  const key = chain => JSON.stringify(chain);

  const out = [];
  let prevKey = null;
  for (const e of entries) {
    const side = e.landingEnd ?? LANDING_END_BY_SEQ[e.seqNo] ?? 'both';
    const leftChain  = valid(side === 'left'  || side === 'both' ? landingWith(soffitUpper(e.seqNo, 'left')) : normal);
    const rightChain = valid(side === 'right' || side === 'both' ? landingWith(soffitUpper(e.seqNo, 'right')) : normal);
    const left  = key(leftChain)  !== prevKey ? leftChain  : null;
    prevKey = key(leftChain);
    const right = key(rightChain) !== prevKey ? rightChain : null;
    prevKey = key(rightChain);
    out.push({ left, right });
  }
  return out;
}
