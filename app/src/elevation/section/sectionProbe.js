/**
 * 2.5D断面エンジン: makeProbeContext / collectCutBreaks / probeColumn（WP-E1）。
 * 設計意図はarchitect承認済みの実装指示書§5参照（.claude/elevation-model.md「階をまたぐ2層帯」節
 * が現行仕様）。WP-E5bでelevationStairSequence.jsから（switchbackCuts.js経由・直接の両方で）
 * 呼ばれるようになった。
 *
 * §5.7「既存部品の転用」どおり、レイキャスト自体は新規実装だが、断点抽出・セル所有者探索は
 * 既存の純関数（collectRunBreaks・buildCellToRoom・worldToCell・kneeDropRecordsOnAxis・
 * roomCeilingHeight）をそのまま再利用する。
 */
import { OpeningCategory } from '@core';
import { buildCellToRoom } from '../../finish/edgeClassify.js';
import { worldToCell } from '../../finish/gridCells.js';
import { roomCeilingHeight } from '../../finish/roomMetrics.js';
import { kneeDropRecordsOnAxis } from '../../finish/kneeDropWall.js';
import { effectiveHeight } from '../../openings/openingNumbering.js';
import { collectRunBreaks } from '../elevationFloorProfile.js';
import { GAP_EPS_MM as GAP_EPS, PROBE_EPS_MM } from '../elevationStyle.js';
import { graphList } from '../../graphReadScope.js';
import {
  isRealRoom, orderLayerStack, baseLayerOf, layerOwningZ,
  compareLayerPriority, resolveSightlineTopZ,
} from './sectionLayerStack.js';

// kneeDropRecordsOnAxis（区間重なり判定）への点クエリ用の微小幅(mm)。GAP_EPSより大きく
// PROBE_EPS_MMより小さい値にして、区間境界ちょうどのレコードも安定して拾えるようにする。
const POINT_QUERY_EPS_MM = 0.5;

// 「切断線が壁の中心線と同一直線上（coincident）」とみなす許容差(mm)。壁厚/2に対する
// 上乗せ分（WP-E5リード裁定・coincident壁＝cutAlongカテゴリ）。CL再スナップ等による
// サブミリ〜数mm程度の誤差を吸収する目的の小さな値（PROBE_EPS_MMと同水準）。
const COINCIDENT_TOL_MM = PROBE_EPS_MM;

// 層に関する判断（優先順位・所有層・上位層・実Room判定）は sectionLayerStack.js の一般規則へ
// 集約した——role名（'self'/'above'/'below'）と配列順に依存した旧実装が、多層の展開図で
// 壊れる構造的な原因だったため（同モジュール冒頭参照）。

// z区間が隣接し同一の実体（同じwall/room・同じ距離）を表すband同士を1本へ統合する
// （実機フィードバック第3弾A2）。probeColumnのzBreaksは複数の目的（cut/cutAlong/wall候補の
// 端点・baseFloorZ・各層のfloorZ/ceilZ）から集めるため、同一の壁・同一の距離(distMm)が続く
// 区間でも「他レイヤーの床天井位置」だけを理由に内部で区切られることがある——A2（見えがかり壁の
// z上限をabove層の実Room有無で拡張。resolveWallCapZ参照）で新たに発生するケース: 自層の壁が
// above層の天井まで伸びると、途中にabove層自身のfloorZ/ceilZがzBreaksとして挟まりz区間が
// 分割されるが、この境界は壁自体の見た目には何の変化もない。emitColumnsは各bandの上端/下端の
// 縁線を無条件に描くため、統合しないままだと実在しない水平の継ぎ目線（誤ったキャップ線と同じ
// 症状）が残ってしまう。mergeColumns（sectionEngine.js。x方向の隣接列併合）と同じ考え方を
// z方向へ適用する。
function sameZBand(a, b) {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case 'wall':
      return a.wall === b.wall && a.distMm === b.distMm && a.layerRole === b.layerRole
        && (a.openingPassThrough ?? false) === (b.openingPassThrough ?? false);
    case 'cut':
    case 'cutAlong':
      return a.wall === b.wall && a.layerRole === b.layerRole;
    case 'slab':
      return a.ownerRoom === b.ownerRoom && a.floorZ === b.floorZ && a.ceilZ === b.ceilZ;
    case 'open':
      return true;
    default:
      return false;
  }
}

// baseFloorZの境界だけは併合しない（emitColumns/emitLineの§5.6最終フィルタは「band全体が
// baseFloorZ以下か」で降格を決めるため、baseFloorZをまたいで併合すると「下側だけ破線」が
// 再現できなくなる——sectionProbe.jsが意図的にbaseFloorZをzBreaksへ割り込ませている理由
// そのもの。この境界だけは実体が同じでも独立したbandのまま残す）。
function mergeAdjacentZBands(bands, baseFloorZ) {
  const merged = [];
  for (const band of bands) {
    const last = merged[merged.length - 1];
    const atBaseFloorZ = baseFloorZ != null && Math.abs(band.z0 - baseFloorZ) < GAP_EPS;
    if (last && !atBaseFloorZ && Math.abs(last.z1 - band.z0) < GAP_EPS && sameZBand(last, band)) {
      last.z1 = band.z1;
    } else {
      merged.push({ ...band });
    }
  }
  return merged;
}

function clamp(z, lo, hi) { return Math.max(lo, Math.min(hi, z)); }

/**
 * wall が cut.line を「横切る」壁（切断壁。§5.2 step1の1）か。
 * wall.isVertical !== line.isVertical（直交）かつ wall.axisCL.effectiveValue が
 * line の run 範囲 [lo,hi] 内かつ wall のスパン(coord1/coord2)が line.axisValue を含む。
 * @param {import('@core').Wall} wall
 * @param {import('./sectionTypes.js').CutLine} line
 * @returns {boolean}
 */
function isCutWall(wall, line) {
  if (wall.isVertical === line.isVertical) return false;
  const av = wall.axisCL.effectiveValue;
  if (!(av >= line.lo - GAP_EPS && av <= line.hi + GAP_EPS)) return false;
  const c1 = Math.min(wall.coord1, wall.coord2), c2 = Math.max(wall.coord1, wall.coord2);
  // buttToleranceMm: 切断線が「面自身の壁の中」を通る用法（部屋の展開）向けの許容差。
  // 直交壁は面の壁に**突き当たって**その室内側の面で終わるため、CL上に立てた切断線までは
  // 届かない——素の判定では実在する直交壁（腰壁・垂れ壁を含む）の断面が丸ごと落ちる。
  // 面の壁の半厚を渡すと、その厚みの中で終わる壁を「切断線を横切る」とみなす。
  // 階段帯は未指定＝0のため従来と完全同値（ユーザー明示指示2026-08「処理共有のこと」）。
  const tol = (line.buttToleranceMm ?? 0) + GAP_EPS;
  return line.axisValue >= c1 - tol && line.axisValue <= c2 + tol;
}

/**
 * wall/opening が cut.line と平行で視線方向(viewSign)にある「見えがかり候補」（§5.2 step1の2）か。
 * axisCL・isVerticalさえ持てばWall/Opening共通で使える（S4の開口判定にも流用）。
 * @param {{isVertical:boolean, axisCL:object}} shape
 * @param {import('./sectionTypes.js').CutLine} line
 * @param {1|-1} viewSign
 * @returns {boolean}
 */
function isSightlineShape(shape, line, viewSign) {
  if (shape.isVertical !== line.isVertical) return false;
  const diff = (shape.axisCL.effectiveValue - line.axisValue) * viewSign;
  return diff > GAP_EPS;
}

/**
 * wall が cut.line と「同一直線上（coincident）」＝縦断された壁（cutAlong。WP-E5リード裁定・
 * 設計書§6.1「seq2/4では切断線がその中を通る→全幅の断面（＝視線を遮る）」）か。
 * wall.isVertical === line.isVertical（cut.lineと同じ向き＝見えがかり候補と同じ判定対象）かつ
 * |wall.axisCL.effectiveValue - line.axisValue| <= 壁厚/2 + 許容差（壁の中心線をまたいで
 * 切断線が通っている＝壁を縦に割く形で切っている、とみなせる範囲）。
 * isSightlineShape と判定対象が重なりうる（diffが小さい正の値の壁は両方に該当）ため、
 * 呼び出し側は本関数を isSightlineShape より先に判定すること（cutAlongが優先）。
 * @param {import('@core').Wall} wall
 * @param {import('./sectionTypes.js').CutLine} line
 * @returns {boolean}
 */
function isCutAlongWall(wall, line) {
  if (wall.isVertical !== line.isVertical) return false;
  // 部屋の外周壁（generateRoomWallsFromOutline生成。isRoomWall=true）は除外する——cut.lineが
  // 「その面自身の壁」の位置に一致する通常のface的な用法（近側=室内側にしか空間が無い）では、
  // その自壁をcutAlong（縦断された壁＝視線を遮る実体）として扱うと、既存のisSightlineShape
  // （diff>GAP_EPS。coincidentなら常にfalse＝自壁は候補にしない）の意図的な除外が壊れる。
  // cutAlongは「往復間の壁」のような自立した内部間仕切りを対象とする（WP-E5リード裁定）ため、
  // isRoomWall=trueの壁はここで除外する。
  if (wall.isRoomWall) return false;
  const mr = wall.materialRange;
  const halfThickMm = Math.abs(mr.hi - mr.lo) / 2;
  return Math.abs(wall.axisCL.effectiveValue - line.axisValue) <= halfThickMm + COINCIDENT_TOL_MM;
}

/**
 * layer.graph上で、cutの run方向 worldMid・厚み方向オフセット sign*PROBE_EPS_MM の位置の
 * 所有Roomを1点プローブする（elevationFloorProfile.jsのpushGap/familyCeilingSegmentsと同じ
 * 「isVertical面ならpx=axisValue+offset・py=runCoord、そうでなければ逆」規約）。
 * @returns {import('@core').Room|null}
 */
function probeOwnerRoom(cut, worldMid, layer, probeCtx, sign) {
  return ownerRoomAtOffset(cut, worldMid, layer, probeCtx, sign * PROBE_EPS_MM);
}

// 切断線から視線方向へoffsetMm進んだ位置の所有Room（probeOwnerRoomの一般形）。
function ownerRoomAtOffset(cut, worldMid, layer, probeCtx, offsetMm) {
  const { line } = cut;
  const px = line.isVertical ? line.axisValue + offsetMm : worldMid;
  const py = line.isVertical ? worldMid : line.axisValue + offsetMm;
  const cell = worldToCell(px, py, layer.graph);
  if (!cell) return null;
  const map = probeCtx.cellToRoomFor(layer);
  return map.get(cell.key) ?? null;
}

/**
 * 見えがかり壁の候補が「この切断が見ている部屋の中」に収まっているか
 * （ユーザー実機指摘2026-08「6」C・裁定A案）。
 * 視線方向の所有Room（info.room）を出た**先**にある壁は、この帯の作図対象ではなく
 * 見えがかり壁として描かない——描かれないz区間は`open`帯になり、`emitOpenGapMarks`が
 * アキ（一点鎖線のバツ）を描く。実機症状: 6/Cの1F部分(z0..2400)が6m先の別室の壁(d6000)を
 * 拾って見えがかり壁になっており、「3500の面を表す…四角にアキ・バツ」が出ていなかった。
 * 判定は**帯そのもののRoom（`cut.bandRoom`＝階段帯なら階段室）の包絡矩形**（`roomBounds`）の
 * 中に壁の手前側の面が収まっているか。ユーザーの言う「3500の面」＝その部屋自身の広がりの端。
 * *試して却下した案2つ*:
 * ① 壁の手前の1点プローブで**所有Roomが同一か**——階段帯では「階段」室から「階段下」室のような
 *    隣接Roomを見通すのが正常なので、部屋を跨いだ時点で全て消え、確認済みテスト（seq2の面端の
 *    壁の縁）が落ちた。
 * ② **視線方向の所有Room**（`info.room`）の包絡矩形——列ごとに所有Roomが「階段」「階段下」と
 *    入れ替わり、狭い方の矩形で切ってしまうため、面の分類（往復間の壁の検出）まで巻き添えで
 *    変わった（展開記号の回帰テストが落ちた）。帯のRoomは列によらず一定でなければならない。
 * 壁は部屋境界のCL上に載るため、許容は壁厚ぶん（`materialRange`の幅）とする。
 * cut.bandRoom・materialRange・包絡矩形が取れないときは従来どおり制限しない。
 */
function withinViewRoom(cut, worldMid, info, probeCtx, wall) {
  const mr = wall.materialRange;
  if (!mr) return true;
  // 包絡矩形は**世界座標の箱**なので層に依らず1つ。`cut.bandRoomBounds`として呼び出し側が
  // 自階graphで一度だけ求めて渡す——旧実装は層ごとのgraphで引き直しており、上階レイヤーでは
  // 自階Roomのセルキーが解決できずbounds不定→制限なしになっていた（実機「6」Cで上階の
  // 6m先の壁(d6000)がz3800..5400に残り、アキにならなかった）。
  const b = cut.bandRoomBounds;
  if (!b || !Number.isFinite(b.x1) || !Number.isFinite(b.x2)) return true;
  const nearFace = cut.viewSign > 0 ? Math.min(mr.lo, mr.hi) : Math.max(mr.lo, mr.hi);
  const tol = Math.abs(mr.hi - mr.lo) + GAP_EPS;
  // cut.lineがisVertical（縦の切断線）なら視線＝X方向、そうでなければY方向。
  const [lo, hi] = cut.line.isVertical ? [b.x1, b.x2] : [b.y1, b.y2];
  return nearFace >= lo - tol && nearFace <= hi + tol;
}

/**
 * 腰壁・垂れ壁指定を反映したwallのz存在範囲（§5.2 step2）。
 * 指定なし=[floorZ,ceilZ]（全高）。腰壁指定時=[floorZ,floorZ+topHeight]、垂れ壁指定時=
 * [ceilZ-bottomHeight,ceilZ]（設計書§5.2の記述どおり、両方同時指定は腰壁を優先するif/elseで
 * 読む——両方同時のケースはこのエンジンの対象外・既知の単純化として報告する）。
 * @param {object} graph
 * @param {import('@core').Wall} wall
 * @param {number} pointCoord - kneeDropRecordsOnAxisへの点クエリ位置（wall自身の長さ方向座標）
 * @param {number} floorZ
 * @param {number} ceilZ
 * @returns {{z0:number, z1:number}}
 */
function kneeDropZRangeAt(graph, wall, pointCoord, floorZ, ceilZ) {
  const records = kneeDropRecordsOnAxis(
    graph, wall.axisCL, pointCoord - POINT_QUERY_EPS_MM, pointCoord + POINT_QUERY_EPS_MM,
  );
  for (const { rec } of records) {
    if (rec.knee) return { z0: floorZ, z1: floorZ + rec.knee.topHeight };
    if (rec.drop) return { z0: ceilZ - rec.drop.bottomHeight, z1: ceilZ };
  }
  return { z0: floorZ, z1: ceilZ };
}

/**
 * その壁のz範囲が、その層の床天井いっぱいではない＝**天端または下端が露出している**
 * （腰壁・垂れ壁の類）か。
 *
 * 「展開図では断面の中は描画しない」の**唯一の例外**を決める（ユーザー明示指示2026-08・案A）:
 * 天井の向こうにある切断壁でも、天端が見える壁（腰壁）・下端が見える壁（垂れ壁）は描く
 * ——その露出した縁は吹抜け側の空間に面していて実際に見えるため。上下いっぱいに立つ壁は
 * 隣室との仕切りであり天井の向こうに隠れるので描かない（実機「5」A面左3200・C1面右400）。
 * `sectionEngine.js`の`clipBandsToCeil`が本フラグを見る。
 * @param {number} z0
 * @param {number} z1
 * @param {{floorZ:number, ceilZ:number}} info - その壁が属する層の床天井
 * @returns {boolean}
 */
function isKneeDropRange(z0, z1, info) {
  return z0 > info.floorZ + GAP_EPS || z1 < info.ceilZ - GAP_EPS;
}

/**
 * 視線方向に所有Roomが見つからない層のceilZフォールバック（QA指摘・WP-E7bで修正）。
 * 実機で最も普通の構成（2F床=踊り場のみ・レーン上は吹抜け）では、往復間の壁(midWall)が
 * 属する'above'層の視線方向プローブがレーン上（吹抜け＝所有Room無し）で失敗しceilZ==nullに
 * なり、旧実装（呼び出し側の`if (info.ceilZ==null) continue`）は候補収集そのものを層ごと
 * 丸ごと捨てていた——「視線方向に所有Roomが無い＝部屋の外」ではあっても、isCutWall/
 * isCutAlongWallで検出される壁自体はそこに実在するため、候補収集を諦めてはいけない
 * （壁の2縁・腰壁高さ反映が消える実機不具合の原因だった）。room有りなら従来どおりCH。
 * 無ければ(a)layer.graph.defaultCeilingHeight、(b)それも無ければcut.zRange.hiZ、
 * (c)それも無ければfloorZそのもの、の順でフォールバックする（kneeDropレコードがあれば
 * kneeDropZRangeAtがこのceilZより優先されるため、ここは「腰壁・垂れ壁指定が無いときの
 * 全高上限」としてのみ効く）。
 * @param {{graph:object, floorZMm:number}} layer
 * @param {number} floorZ
 * @param {import('./sectionTypes.js').SectionCut} cut
 * @returns {number}
 */
function fallbackCeilZ(layer, floorZ, cut) {
  const defaultCH = layer.graph?.defaultCeilingHeight;
  if (defaultCH != null) return floorZ + defaultCH;
  return cut.zRange?.hiZ ?? floorZ;
}

/**
 * 壁の実位置（axisCL.effectiveValue × worldMid）を室内側へ`PROBE_EPS_MM`だけ逃がした点で、
 * 指定層の所有Roomを1点プローブする（`resolveSightlineTopZ`へ渡す`roomAtLayer`の実体）。
 * 壁のちょうど中心線上は境界セルで所有Roomが不安定なため、probeOwnerRoomと同じ手法で逃がす
 * ——壁は line から見て+viewSign側にあるので、-viewSign側が壁の手前＝室内側になる。
 * @param {import('@core').Wall} wall
 * @param {number} worldMid
 * @param {1|-1} viewSign
 * @param {ReturnType<typeof makeProbeContext>} probeCtx
 * @returns {(upper:{layer:{graph:object}})=>object|null}
 */
function roomAtWallPosition(wall, worldMid, viewSign, probeCtx) {
  const offset = -viewSign * PROBE_EPS_MM;
  const px = wall.isVertical ? wall.axisCL.effectiveValue + offset : worldMid;
  const py = wall.isVertical ? worldMid : wall.axisCL.effectiveValue + offset;
  return upper => {
    const cell = worldToCell(px, py, upper.layer.graph);
    return cell ? (probeCtx.cellToRoomFor(upper.layer).get(cell.key) ?? null) : null;
  };
}

/**
 * openingの絶対z範囲（§5.4「openingPassThrough」）。sill/heightの規約はopeningElevationFigure.js
 * ・openingNumbering.jsと同じ単一情報源を使う（フィッティング=sill0・窓=sillHeight??0、
 * heightはeffectiveHeightでカタログ既定へフォールバック——展開図の建具姿図と同じ解釈）。
 * @param {import('@core').Opening} o
 * @param {number} floorZ - このopeningが属する壁のfloorZ（絶対z基準）
 * @returns {{z0:number, z1:number}}
 */
function openingAbsZRange(o, floorZ) {
  const sill = o.category === OpeningCategory.WINDOW ? (o.sillHeight ?? 0) : 0;
  const height = effectiveHeight(o);
  return { z0: floorZ + sill, z1: floorZ + sill + height };
}

/**
 * wall（見えがかり壁面。kind:'wall'候補）に重なる開口の絶対z範囲を、候補自身のz存在範囲
 * [z0,z1]（腰壁・垂れ壁反映済み）へクランプして返す（§5.4・WP-E7 D1）。
 * openingsOnFace（elevationFaces.js）と同じ絞り込み（isVertical一致・axisCL.id一致）に加え、
 * worldMidがopeningのx範囲(coord1..coord2)内にあることを要求する（この列に実際に写る開口のみ）。
 * @param {import('@core').Wall} wall
 * @param {object} graph
 * @param {number} worldMid
 * @param {number} floorZ
 * @param {number} z0 - wall候補のz存在範囲下端
 * @param {number} z1 - wall候補のz存在範囲上端
 * @returns {Array<{z0:number, z1:number}>}
 */
function openingPassThroughRangesFor(wall, graph, worldMid, floorZ, z0, z1) {
  const ranges = [];
  for (const o of graphList(graph, 'openings') ?? []) {
    if (o.isVertical !== wall.isVertical || o.axisCL.id !== wall.axisCL.id) continue;
    const c1 = Math.min(o.coord1, o.coord2), c2 = Math.max(o.coord1, o.coord2);
    if (worldMid < c1 - GAP_EPS || worldMid > c2 + GAP_EPS) continue;
    const abs = openingAbsZRange(o, floorZ);
    const lo = clamp(abs.z0, z0, z1), hi = clamp(abs.z1, z0, z1);
    if (hi - lo > GAP_EPS) ranges.push({ z0: lo, z1: hi });
  }
  return ranges;
}

/**
 * layers（各{graph,floorZMm,role}）から、レイキャストに必要な索引（層別cellToRoom・
 * 天井高さ・floorZ算出）をまとめたプローブコンテキストを作る（§4 sectionProbe.js冒頭）。
 * 層ごとにbuildCellToRoomを1回だけ作りメモ化する（worldToCellの毎回filter+sortコスト対策。
 * §11リスク2で織り込み済み）——cellToRoomFor はlayerオブジェクト単位でキャッシュしつつ、
 * 実体（buildCellToRoomの結果）はgraph単位で共有する（同じgraphを指す複数layer——self/above/
 * below等——が同じ実体を再利用できるように）。
 * @param {Array<{graph:object, floorZMm:number, role:string}>} layers
 * @returns {{cellToRoomByLayer:Map, cellToRoomFor:(layer:object)=>Map,
 *   chOf:(room:object|null, graph:object)=>number|null,
 *   floorZOf:(room:object|null, layer:object)=>number}}
 */
export function makeProbeContext(layers) {
  const cellToRoomByLayer = new Map(); // layer -> Map<cellKey, Room>（呼び出し側から参照可能に公開）
  const cellToRoomByGraph = new Map(); // graph -> Map<cellKey, Room>（実体はgraph単位で共有）
  const chCacheByGraph = new Map();    // graph -> Map<room.id, mm>

  function cellToRoomFor(layer) {
    const cached = cellToRoomByLayer.get(layer);
    if (cached) return cached;
    let byGraph = cellToRoomByGraph.get(layer.graph);
    if (!byGraph) {
      byGraph = buildCellToRoom(layer.graph);
      cellToRoomByGraph.set(layer.graph, byGraph);
    }
    cellToRoomByLayer.set(layer, byGraph);
    return byGraph;
  }
  for (const layer of layers ?? []) cellToRoomFor(layer);



  function chOf(room, graph) {
    if (!room) return null;
    let cache = chCacheByGraph.get(graph);
    if (!cache) { cache = new Map(); chCacheByGraph.set(graph, cache); }
    if (!cache.has(room.id)) cache.set(room.id, roomCeilingHeight(graph, room).mm);
    return cache.get(room.id);
  }

  function floorZOf(room, layer) {
    if (!room) return layer.floorZMm; // 部屋外（所有Room不明）はlayer自身の基準面へフォールバック
    const graph = layer.graph;
    return layer.floorZMm + graph.effectiveFloorLevel(room) - graph.floorDatum;
  }

  return { cellToRoomByLayer, cellToRoomFor, chOf, floorZOf };
}

/**
 * cut.line のx区間分割点（run方向のworld座標。昇順）を4源から集める（§5.1）。
 * S1: 各層のcollectRunBreaksの和集合（1F/2FのCL粒度差対策。層ごとに回して和集合を取る——
 *     1点だけの代表値で済ませると .claude/elevation-model.md「粗いセル境界での1点プローブ誤分類」
 *     と同根の取りこぼしが起きる）。
 * S2: 切断線を横切る壁（isCutWall）のmaterialRange両端。
 * S3: 視線方向の壁（isSightlineShape）の端点(coord1/coord2)。
 * S4: 視線方向の開口（isSightlineShape。Wallと同じisVertical/axisCLインターフェースで判定できる）
 *     の端点——アキの連結性判定（openingPassThrough。WP-E7スコープ）が列境界を必要とするため、
 *     このWPでも列境界自体は用意しておく（実際のopeningPassThrough付与はWP-E7で行う）。
 * GAP_EPS未満の重複・line.lo/hiちょうどの値は素通し（Setで自然に併合される）。
 * @param {import('./sectionTypes.js').SectionCut} cut
 * @param {ReturnType<typeof makeProbeContext>} [probeCtx] - 未指定でも計算可能
 *   （層別cellToRoomのウォームアップにのみ使う。§5.1自体はgraph.centerLines/walls/openingsの
 *   直接走査で完結するため必須ではない）。
 * @returns {number[]} 昇順・重複除去済み
 */
export function collectCutBreaks(cut, probeCtx) {
  const line = cut.line;
  const layers = cut.layers ?? [];
  // 探査範囲は切断線そのもの[lo,hi]だけでなく、**壁のない端部の外側**（probeExtendLo/HiMm。
  // ユーザー実機指摘2026-08「6」D／裁定A案）も含む——面の端で切れている壁・床スラブ・天井は
  // 「そこで終わる」のではなく面の外へ続いており、その取り合い（腰壁の外側面・隣室の1F天井・
  // 2FL床）を作図するには、外側にも実データの列が要るため。x=0の起点（cutOriginWorld）は
  // line.lo/hiのままで動かさないので、既存のローカルx座標は一切ずれない。
  const probeLo = line.lo - (line.probeExtendLoMm ?? 0);
  const probeHi = line.hi + (line.probeExtendHiMm ?? 0);
  const values = new Set([probeLo, probeHi]);
  const addIfInside = v => { if (v > probeLo + GAP_EPS && v < probeHi - GAP_EPS) values.add(v); };
  // 面の端そのものは常に列境界にする（延長した場合、面の内と外を1列に融合させない）。
  addIfInside(line.lo); addIfInside(line.hi);

  for (const layer of layers) {
    probeCtx?.cellToRoomFor?.(layer); // ウォームアップ（後続のprobeColumn呼び出しのキャッシュ寄与）
    for (const v of collectRunBreaks(layer.graph, line.isVertical, probeLo, probeHi)) values.add(v);
    for (const w of graphList(layer.graph, 'walls') ?? []) {
      if (isCutWall(w, line)) {
        const mr = w.materialRange;
        addIfInside(mr.lo); addIfInside(mr.hi);
      } else if (isCutAlongWall(w, line)) {
        const c1 = Math.min(w.coord1, w.coord2), c2 = Math.max(w.coord1, w.coord2);
        addIfInside(c1); addIfInside(c2);
      } else if (isSightlineShape(w, line, cut.viewSign)) {
        const c1 = Math.min(w.coord1, w.coord2), c2 = Math.max(w.coord1, w.coord2);
        addIfInside(c1); addIfInside(c2);
      }
    }
    for (const o of graphList(layer.graph, 'openings') ?? []) {
      if (!isSightlineShape(o, line, cut.viewSign)) continue;
      addIfInside(o.coord1); addIfInside(o.coord2);
    }
  }
  return [...values].sort((a, b) => a - b);
}

/**
 * 1本の列（worldMid）における層スタック（層ごとの「視線方向の自室」と、その層でのfloorZ/ceilZ）。
 *
 * 層ごとに視線方向へ1点プローブする（§5.2「層の床天井」・step5）——階段のような複数layer構成では
 * 層ごとに異なるgraphを同じ位置で引く必要があるため。壁面自身の位置＝cut.line.axisValueぴったりの
 * probeでも、+viewSign*PROBE_EPS_MMだけ視線方向へ逃がせば単純な矩形室では正しく自室を拾える。
 * orderLayerStackでfloorZMm昇順へ整列して返す——以降の層の判断（所有層・上位層・優先順位）は
 * 全て並びの上で答えるため、呼び出し側がcut.layersをどの順で渡しても結果は変わらない。
 * @param {import('./sectionTypes.js').SectionCut} cut
 * @param {number} worldMid
 * @param {ReturnType<typeof makeProbeContext>} probeCtx
 * @returns {Array<{layer:object, room:object|null, floorZ:number, ceilZ:number}>}
 */
function buildLayerStack(cut, worldMid, probeCtx) {
  return orderLayerStack((cut.layers ?? []).map(layer => {
    const room = probeOwnerRoom(cut, worldMid, layer, probeCtx, cut.viewSign);
    const floorZ = probeCtx.floorZOf(room, layer);
    // QA修正: room=nullでも壁候補は諦めない（fallbackCeilZ参照）。ceilZが実質nullになるのは
    // layer.graph自体が無い等の防御的ケースのみ。
    const ceilZ = room ? floorZ + probeCtx.chOf(room, layer.graph) : fallbackCeilZ(layer, floorZ, cut);
    return { layer, room, floorZ, ceilZ };
  }));
}

// LayerInfo（層ごとの床天井）→ 非描画のslab ZBand。床構造・天井懐・上階床のどれであっても
// 「その高さを所有する層の床天井」を持たせる、という一点だけが分類の情報源。
function slabBandOf(info, z0, z1) {
  return { kind: 'slab', z0, z1, ownerRoom: info.room, floorZ: info.floorZ, ceilZ: info.ceilZ };
}

/**
 * 1本のx列（world run座標 worldMid。collectCutBreaksが返す隣接ペアの中点を渡す想定）の
 * z区間分割・オクルージョン解決（§5.2）。層0件・切断線が部屋外・壁ゼロのいずれでも例外を
 * 投げず、候補が1つも無ければ zRange 全域を1本の open ZBand として返す。
 * @param {import('./sectionTypes.js').SectionCut} cut
 * @param {number} worldMid
 * @param {ReturnType<typeof makeProbeContext>} probeCtx
 * @returns {import('./sectionTypes.js').ZBand[]}
 */
export function probeColumn(cut, worldMid, probeCtx) {
  const line = cut.line;
  const zLo = cut.zRange?.loZ ?? 0;
  const zHi = cut.zRange?.hiZ ?? 0;

  // 層ごとの「視線方向の自室」（viewSign方向へ1点プローブして見つかる、その層でのfloorZ/ceilZの
  // 基準Room）を求める（§5.2「層の床天井」・step5）。ASSUMED: cut.anchorRoomがある通常面相当の
  // 利用では本来anchorRoomを直接使うべきだが、階段のような複数layer構成では層ごとに異なる
  // graphを同じ位置でプローブする必要があるため、layerごとに視線方向へ1点プローブする
  // （視線方向=自分が向かっている方向にある空間＝その候補壁の高さの基準になる部屋、という
  // 解釈。壁面自身の位置＝cut.line.axisValueぴったりのprobeでも、+viewSign*PROBE_EPS_MMだけ
  // 視線方向へ逃がせば単純な矩形室では正しく自室を拾える）。
  // orderLayerStackでfloorZMm昇順へ整列してから使う——以降の層の判断（所有層・上位層・優先順位）は
  // 全て並びの上で答えるため、呼び出し側がcut.layersをどの順で渡しても結果は変わらない。
  const layerStack = buildLayerStack(cut, worldMid, probeCtx);

  // 候補壁の収集（層ごと。§5.2 step1）。
  const candidates = [];
  for (const info of layerStack) {
    const { layer } = info;
    if (info.ceilZ == null) continue; // 防御的ガード（fallbackCeilZにより通常到達しない）
    for (const w of graphList(layer.graph, 'walls') ?? []) {
      if (isCutWall(w, line)) {
        const mr = w.materialRange;
        if (worldMid < mr.lo - GAP_EPS || worldMid > mr.hi + GAP_EPS) continue;
        const { z0, z1 } = kneeDropZRangeAt(layer.graph, w, line.axisValue, info.floorZ, info.ceilZ);
        candidates.push({ kind: 'cut', wall: w, layer, distMm: 0, z0, z1,
          isKneeDrop: isKneeDropRange(z0, z1, info) });
      } else if (isCutAlongWall(w, line)) {
        // cutAlong（縦断された壁。§6.1「切断線がその中を通る→全幅の断面」）: x範囲=壁スパン
        // [coord1,coord2]∩切断線範囲、z範囲=kneeDropRecordsOnAxisによる実存在範囲
        // （pointCoord=worldMid。壁自身の長さ方向＝cutのrun方向と一致するためwallと同じ規約）。
        const c1 = Math.min(w.coord1, w.coord2), c2 = Math.max(w.coord1, w.coord2);
        if (worldMid < c1 - GAP_EPS || worldMid > c2 + GAP_EPS) continue;
        const { z0, z1 } = kneeDropZRangeAt(layer.graph, w, worldMid, info.floorZ, info.ceilZ);
        candidates.push({ kind: 'cutAlong', wall: w, layer, distMm: 0, z0, z1,
          isKneeDrop: isKneeDropRange(z0, z1, info) });
      } else if (isSightlineShape(w, line, cut.viewSign)) {
        const c1 = Math.min(w.coord1, w.coord2), c2 = Math.max(w.coord1, w.coord2);
        if (worldMid < c1 - GAP_EPS || worldMid > c2 + GAP_EPS) continue;
        const distMm = Math.abs(w.axisCL.effectiveValue - line.axisValue);
        if (!withinViewRoom(cut, worldMid, info, probeCtx, w)) continue; // 部屋の外の壁は描かない
        // A2の一般化: 上限（info.ceilZ）を「上が吹抜けなら上階の天井まで延ばす」規則で解決し直す
        // （sectionLayerStack.jsのresolveSightlineTopZ）。旧実装はself層の壁だけを対象に
        // 上階1段しか見ていなかったが、規則自体は層の役割にも段数にも依存しない。
        const capZ = resolveSightlineTopZ(
          layerStack, info, roomAtWallPosition(w, worldMid, cut.viewSign, probeCtx), zHi,
        );
        const { z0, z1 } = kneeDropZRangeAt(layer.graph, w, worldMid, info.floorZ, capZ);
        // 腰壁・垂れ壁指定で高さが制限された壁か（アキのバツのクリップ対象。sectionEmit.jsの
        // obstructionRects。ユーザー実機指摘2026-08「6」C「バツが腰壁と交差する場合はクリップ」）。
        const isKneeDrop = isKneeDropRange(z0, z1, { floorZ: info.floorZ, ceilZ: capZ });
        // WP-E7 D1: この壁（見えがかり壁面）に重なる開口のz範囲を候補へ添える
        // （openingPassThroughRangesForはz0/z1へクランプ済み）。band選択後、選ばれたz区間が
        // そのいずれかに含まれれば ZBand.openingPassThrough:true を付与する（下記参照）。
        const openRanges = openingPassThroughRangesFor(w, layer.graph, worldMid, info.floorZ, z0, z1);
        candidates.push({ kind: 'wall', wall: w, layer, distMm, z0, z1, openRanges, isKneeDrop });
      }
    }
  }

  // zBreaks = 全候補のz端点 ∪ 層の床天井 ∪ zRange端 ∪ cut.baseFloorZ（§5.2 step3。WP-E5b追加:
  // baseFloorZはemitLineの§5.6最終フィルタ（両端がbaseFloorZ未満なら向こう側=DETAIL破線へ
  // 降格）の境界そのものであり、ここをz区間の境界にしておかないと1本の線分がbaseFloorZを
  // またいでしまい、降格判定が「両端とも」を要求するせいで下側だけ降格されない
  // ——例: 壁の断面縦線が0〜chLowerMmの1本のまま出ると、seq1の「踊り場より下の壁断面=破線」
  // が成立しない。baseFloorZをz区間の境界に割ることで、下側の区間だけが正しく降格される）。
  const zSet = new Set([zLo, zHi]);
  if (cut.baseFloorZ != null) zSet.add(clamp(cut.baseFloorZ, zLo, zHi));
  for (const c of candidates) {
    zSet.add(clamp(c.z0, zLo, zHi)); zSet.add(clamp(c.z1, zLo, zHi));
    // WP-E7 D1: 開口のz端点もz区間の境界にする（開口の有無で'wall'帯を分割し、開口の
    // 部分だけにopeningPassThroughを付与できるようにするため）。
    for (const r of c.openRanges ?? []) { zSet.add(clamp(r.z0, zLo, zHi)); zSet.add(clamp(r.z1, zLo, zHi)); }
  }
  for (const info of layerStack) {
    if (info.floorZ != null) zSet.add(clamp(info.floorZ, zLo, zHi));
    if (info.ceilZ  != null) zSet.add(clamp(info.ceilZ,  zLo, zHi));
  }
  const zBreaks = [...zSet].sort((a, b) => a - b);

  // 各z区間で1つ選ぶ（オクルージョン優先順位。§5.2 step4）。
  const bands = [];
  for (let i = 0; i + 1 < zBreaks.length; i++) {
    const z0 = zBreaks[i], z1 = zBreaks[i + 1];
    if (z1 - z0 < GAP_EPS) continue;
    const zm = (z0 + z1) / 2;
    const covering = candidates.filter(c => zm > c.z0 - GAP_EPS && zm < c.z1 + GAP_EPS);

    // cut・cutAlongは同格の最前面（§6.1裁定）。同一z区間に両方あれば直交して横切るcutを
    // 優先する（cutAlongより明確に「その場を塞ぐ」実体のため）。
    const frontMatch = covering
      .filter(c => c.kind === 'cut' || c.kind === 'cutAlong')
      .sort((a, b) =>
        (a.kind === b.kind ? 0 : a.kind === 'cut' ? -1 : 1) ||
        compareLayerPriority(a, b))[0];
    if (frontMatch) {
      const mr = frontMatch.wall.materialRange;
      bands.push({
        kind: frontMatch.kind, z0, z1, wall: frontMatch.wall, layerRole: frontMatch.layer.role,
        thicknessMm: Math.abs(mr.hi - mr.lo), isKneeDrop: frontMatch.isKneeDrop === true,
      });
      continue;
    }

    const wallMatch = covering
      .filter(c => c.kind === 'wall')
      .sort((a, b) => a.distMm - b.distMm || compareLayerPriority(a, b))[0];
    if (wallMatch) {
      const band = { kind: 'wall', z0, z1, wall: wallMatch.wall, layerRole: wallMatch.layer.role, distMm: wallMatch.distMm, isKneeDrop: wallMatch.isKneeDrop === true };
      // WP-E7 D1: このz区間(zm)が選ばれたwallMatchの開口z範囲のいずれかに含まれれば
      // openingPassThroughを付与する（描画は貫通させない=kindは'wall'のまま。§5.4）。
      if ((wallMatch.openRanges ?? []).some(r => zm > r.z0 - GAP_EPS && zm < r.z1 + GAP_EPS)) {
        band.openingPassThrough = true;
      }
      bands.push(band);
      continue;
    }

    // 壁が1枚も無いz区間の分類（§5.2 step4(5)）。**帯自身の階に所有Roomがある列でのみ**
    // 床スラブ・天井懐を主張する（室外の列は従来どおり全てopen＝アキX判定の対象。ユーザーの
    // 「壁の無い辺は面にしない」規則と同根の保守的な境界であり、意図して残している）。
    const baseInfo = baseLayerOf(layerStack);
    if (baseInfo?.room && z1 <= baseInfo.floorZ + GAP_EPS) {
      bands.push(slabBandOf(baseInfo, z0, z1)); // 帯のFLより下＝自階の床構造
      continue;
    }
    if (baseInfo?.room && z0 >= baseInfo.ceilZ - GAP_EPS) {
      // 帯の天井より上は「その高さを所有する層」で決める（layerOwningZ＝floorZMmがzm以下で
      // 最も高い層）。旧実装は`role!=='self' && floorZMm<=zm`の**配列順で最初の一致**を
      // 拾っており、層が3つ以上あるとzmを含まない階の層を掴みえた。
      //   - 所有層が帯自身の階のまま = 天井と上階の床の間の懐 → slab（非描画）
      //   - 所有層に実Roomがある = 上階の実床構造 → slab（境界がSILHOUETTEの2FL水平線になる）
      //   - 所有層が吹抜け（VOID/STAIR_VOID）または所有Room無し → open（アキX判定の対象）
      //     ……実機フィードバック第3弾G。実Roomの判定基準はresolveSightlineTopZと共有する。
      const owner = layerOwningZ(layerStack, zm);
      if (!owner || owner === baseInfo) {
        bands.push(slabBandOf(baseInfo, z0, z1));
      } else {
        bands.push(isRealRoom(owner.room) ? slabBandOf(owner, z0, z1) : { kind: 'open', z0, z1 });
      }
      continue;
    }

    bands.push({ kind: 'open', z0, z1 });
  }

  if (bands.length === 0) bands.push({ kind: 'open', z0: zLo, z1: zHi });
  return mergeAdjacentZBands(bands, cut.baseFloorZ);
}
