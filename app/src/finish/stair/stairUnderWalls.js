/**
 * 階段下部屋（破れ線先セルに部屋指定された領域）の壁生成。
 *
 * 対象部屋の外周エッジのうち、委譲されなかったエッジ（isDelegatedEdge が false のもの）にのみ、
 * 下地を室内側へ全寄せした偏芯壁を生成し、外側セルが部屋（階段ペアRoom含む）に属する場合は
 * その部屋の仕上げのみの薄壁を併せて生成する（.claude/stair-model.md・タスク仕様のルール1・2）。
 * 破れ線・U字系の踊り場ストリップ境界（＝破れ線の「正面」）も同じルール1・2の経路に乗る
 * （外側は階段ペアRoomのため薄壁は階段仕上げ厚になる）。U字系のレーン間中心線には専用の
 * 偏芯壁＋階段側仕上げ薄壁を生成する（ルール6。委譲判定の対象外）。
 *
 * 委譲（同一CL上に壁は1つだけ）: エッジが階段footprint境界上（内側セルがstair.cellsに属する）
 * にあり、かつ向こう側がユーザー指定の通常部屋（吹抜けVOID含む）の場合のみ、2a専用の偏芯壁は
 * 生成せず claim もせず、ステップ2（隣室壁・階段ペアRoom壁＋resolveBackingOwnership）に委譲する
 * （isDelegatedEdge）。footprint境界上に限るのは、委譲した区間には階段ペアRoom（cells=stair.cells
 * のみ）が自動的に対をなす壁を生成することが前提のため——2a部屋はfootprint外セルへも指定
 * できるが、footprint外の区間には対をなすペアRoomの壁が存在せず、委譲すると隣室壁1本だけが
 * 残り2a側面が下地むき出しになる。破れ線正面・踊り場境界（相手＝階段ペアRoom）・STAIR_VOID・
 * UNDEFINED・相手も2a・上り口/下り口開口辺・footprint外の区間は委譲せず、これまでどおり
 * この部屋が壁を持つ。
 *
 * 既存壁が有意に重なるエッジ（マージ済みセグメント）には壁を一切生成しない（ルール3。
 * 部分カバーでもセグメント全体を非生成にする——スパンの一部だけ差し引く方式は廃止した）。
 * 同一エッジ由来の偏芯主壁・外側仕上げ薄壁はペアで扱い、主壁がスキップされた区間に重なる
 * 薄壁も連動してスキップする。既存壁の検出は壁の実位置（materialRange）ベースで、
 * 別のCLにアンカーされた壁も拾う（詳細は下記 EXISTING_WALL_POSITION_TOLERANCE）。
 *
 * 部屋の外周エッジ抽出・コーナー取り合い・端点ルールは wallGeneration.js の
 * generateRoomWallsFromOutline と同じ関数を再利用する（symmetric な既定壁生成と
 * 二重実装しない）。
 *
 * 生成後の2a壁は、隣接部屋壁・外壁との突き当たり処理（T字・出隅/入隅）を
 * trimStairUnderJunctions で別途行う（App.jsx 仕上げ脱出ステップ3.5）。
 */

import { StairType, RoomFeature } from '@core';
import { roomBounds, worldToCell, refreshCells } from '../gridCells.js';
import { buildCellToRoom } from '../edgeClassify.js';
import { makeFrame } from './stairGeometry.js';
import { detectUTurn } from './stairClassify.js';
import {
  DEFAULT_WALL_BASE, DEFAULT_WALL_FINISH,
  computeExternalEdgeParams, findOutsideRoom, mergeSegments, clipToAxisExtent, onStairOpening,
} from '../wallGeneration.js';

// struct CL は graph._structGraph.shapeMap に格納されるため両方を検索する（wallGeneration.js と同型）
function getShape(graph, id) {
  return graph.shapeMap.get(id) ?? graph._structGraph?.shapeMap.get(id) ?? null;
}

// 中心線からのサンプリング許容差(mm)。findOutsideRoom（wallGeneration.js）と同水準。
const SAMPLE_EPS = 10; // mm
// U字系の t/s 判定の許容差（比率 0-1 のスケール）
const T_EPS = 1e-3;

// レーン間中心線から階段下部屋側へ逃げる固定量(mm)。主構造非依存（ルール6・固定値）。
const LANE_CLEARANCE = 50;

// 2a壁の突き当たり判定の許容差(mm)。core.js trimIntersectingWalls の tolerance と同水準。
const JUNCTION_TOLERANCE = 150; // mm
// 出隅/入隅の象限判定サンプル点のコーナーからのオフセット(mm)。SAMPLE_EPS と同水準。
const QUADRANT_EPS = 10; // mm
// 突き当たり調整時の最小残存長(mm)。core.js trimIntersectingWalls の MIN_LEN と同水準。
const MIN_LEN = 1; // mm

// ----------------------------------------------------------------
// U字系（SWITCHBACK/WINDING）のレーン間中心線・踊り場ストリップ境界判定
// ----------------------------------------------------------------

// beyondBreakUTurnLike（stairGeometry.js）と同じ手順で tRun（走行軸上の踊り場・回り部境界）を
// 実測から導出する。導出不能なら null（レーン判定を行わず通常エッジ扱いにする＝安全側）。
function buildUTurnContext(stair, graph) {
  const vertical = stair.upDirection === 'up' || stair.upDirection === 'down';
  const b = roomBounds(stair.cells, graph);
  if (![b.x1, b.y1, b.x2, b.y2].every(Number.isFinite)) return null;
  const ut = detectUTurn(stair.cells, graph, vertical, b);
  if (!ut) return null;
  const f = makeFrame(stair, b);
  if (!(ut.laneLen > 0) || ut.laneLen >= f.runLength) return null;
  return { f, tRun: ut.laneLen / f.runLength };
}

// エッジ p（computeExternalEdgeParams の1件。axisOffset は符号のみ ±1）の外側（室外方向）の
// サンプル点を、findOutsideRoom と同じ規約で求める。
function outsideSamplePoint(p, graph) {
  const axisCL  = getShape(graph, p.axisCLId);
  const startCL = getShape(graph, p.startCLId);
  const endCL   = getShape(graph, p.endCLId);
  if (!axisCL || !startCL || !endCL) return null;
  const sign = Math.sign(p.axisOffset) || 1;
  const mid  = (startCL.value + endCL.value) / 2;
  const outside = axisCL.value - sign * SAMPLE_EPS;
  return p.isVertical ? { x: outside, y: mid } : { x: mid, y: outside };
}

// エッジ p の内側（room自身の側。outsideSamplePoint と対になる符号）のサンプル点を求める。
// isDelegatedEdge の footprint境界判定に使う——p の外側ではなく内側のセルが階段footprintに
// 属するかを見る（2a部屋の「この辺」がfootprint境界上にあるかどうか）。
function insideSamplePoint(p, graph) {
  const axisCL  = getShape(graph, p.axisCLId);
  const startCL = getShape(graph, p.startCLId);
  const endCL   = getShape(graph, p.endCLId);
  if (!axisCL || !startCL || !endCL) return null;
  const sign = Math.sign(p.axisOffset) || 1;
  const mid  = (startCL.value + endCL.value) / 2;
  const inside = axisCL.value + sign * SAMPLE_EPS;
  return p.isVertical ? { x: inside, y: mid } : { x: mid, y: inside };
}

// エッジ p の内側サンプル点が、階段footprint（footprintCellKeys = refreshCells(stair.cells,
// graph)）のセルに属するかを判定する（isDelegatedEdge の追加条件）。2a部屋は破れ線先セルと
// footprint外セルをまたいで指定できるため、footprint外にある区間まで委譲すると、覆いかぶさる
// 階段ペアRoom（footprintのみをcellsに持つ）が存在せず隣室壁1本だけが残り、2a側の面が
// 下地むき出しになる（QA指摘）。footprintCellKeys が無い（stair不明）場合は安全側でfalse
// （委譲しない＝従来どおり2a側が壁を持つ）。
function isOnFootprintBoundary(p, graph, footprintCellKeys) {
  if (!footprintCellKeys) return false;
  const pt = insideSamplePoint(p, graph);
  if (!pt) return false;
  const cell = worldToCell(pt.x, pt.y, graph);
  return cell ? footprintCellKeys.has(cell.key) : false;
}

// エッジ p を 'lane'（往路・復路レーン間中心線＝ルール6）/ 'landing'（踊り場・回り部ストリップ
// 境界＝破れ線の「正面」。ルール1・2の通常経路に乗るが lane とは axisOffset の大きさが異なる
// ため区別だけ残す）/ 'normal'（通常の外周＝ルール1・2）に分類する。
// 外側サンプル点が階段footprint（t,s ∈ [0,1]）の外に出れば 'normal'（階段以外に隣接する通常境界）。
function classifyUTurnEdge(ctx, p, graph) {
  if (!ctx) return 'normal';
  const pt = outsideSamplePoint(p, graph);
  if (!pt) return 'normal';
  const t = ctx.f.tOf(pt), s = ctx.f.sOf(pt);
  if (t < -T_EPS || t > 1 + T_EPS || s < -T_EPS || s > 1 + T_EPS) return 'normal';
  return t >= ctx.tRun - T_EPS ? 'landing' : 'lane';
}

// ----------------------------------------------------------------
// 委譲判定（同一CL上に壁1つだけ — 2a偏芯壁を生成・claimせずステップ2へ委譲する）
// ----------------------------------------------------------------

// エッジ p の外側（findOutsideRoom で解決済みの outsideRoom）が、2a専用の偏芯壁を
// 生成せず claim もせず、ステップ2（隣室壁・階段ペアRoom壁＋resolveBackingOwnership）に
// 委譲すべきかどうかを判定する。委譲すると、そのエッジの下地・仕上げはすべて相手側
// （通常部屋・吹抜けVOID）の壁生成が担う——同一CL上に2本の下地が並ぶ二重生成を防ぐ。
// 呼び出し側は findOutsideRoom を1回だけ呼んで結果をここへ渡す（エッジごとに2回呼ばない）。
//
// 委譲しない（false）のは以下のいずれか——現状維持（2a側が壁を持つ）:
//   - outsideRoom が無い（外側未指定。建物外周相当）
//   - outsideRoom.feature が STAIR / STAIR_VOID（破れ線正面・踊り場境界の相手＝階段側）
//   - outsideRoom.feature が UNDEFINED（ステップ2の対象外の部屋）
//   - outsideRoom が別の2a部屋（相手も2a）
//   - 上り口・下り口の開口辺（onStairOpening）——隣室側も壁を作らないため2a側もゼロにしない
//   - エッジが階段footprint境界上に無い（onFootprint===false。QA修正: 2a部屋はfootprint外
//     セルへも指定できるため、footprint外の区間は覆いかぶさる階段ペアRoomが無く、委譲すると
//     隣室壁1本だけが残り2a側面が下地むき出しになる）
// それ以外（footprint境界上・相手がユーザー指定の通常部屋・吹抜けVOID）は委譲する（true）。
function isDelegatedEdge(outsideRoom, p, graph, under2aRoomIds, stairOpenings, onFootprint) {
  if (outsideRoom == null) return false;
  if (outsideRoom.feature === RoomFeature.STAIR || outsideRoom.feature === RoomFeature.STAIR_VOID) return false;
  if (outsideRoom.feature === RoomFeature.UNDEFINED) return false;
  if (under2aRoomIds.has(outsideRoom.id)) return false;
  if (onStairOpening(p, graph, stairOpenings)) return false;
  if (!onFootprint) return false;
  return true;
}

// room の外周エッジのうち、委譲されなかった（＝この部屋が壁を持つ）エッジを列挙する唯一の経路。
// generateStairUnderWalls（壁生成）と stairUnderClaimedEdges（claim専用の軽量経路）の双方が
// これを呼ぶことで、レーン分類（classifyUTurnEdge）・委譲判定（isDelegatedEdge）の述語を
// 一本化する（QA指摘: 両者が別々に判定すると、stair を受け取らない経路でレーン分類が
// 行われず述語がずれる——U字系のレーン間エッジが誤って委譲扱いになりかねない）。
// opts.cellToRoom を渡すと buildCellToRoom(graph) の再計算を省略する（QA指摘: claim経路・
// 生成経路の双方から呼ばれる2a部屋1件につき2回走っていた。未指定時は従来どおり内部で作る）。
// @returns {{ p:object, kind:'lane'|'landing'|'normal', outsideRoom:import('@core').Room|null }[]}
function stairUnderOwnParams(graph, stair, room, opts = {}) {
  const { stairOpenings = [], under2aRoomIds = new Set(), cellToRoom: cellToRoomOpt } = opts;
  const unitParams = computeExternalEdgeParams(room, 1, graph);
  if (unitParams.length === 0) return [];

  const uCtx = stair && (stair.type === StairType.SWITCHBACK || stair.type === StairType.WINDING)
    ? buildUTurnContext(stair, graph) : null;
  const cellToRoom = cellToRoomOpt ?? buildCellToRoom(graph);
  // 委譲の追加条件（isOnFootprintBoundary）に使う階段footprintセル集合。stair が無ければ
  // 判定不能として footprintCellKeys=null（isOnFootprintBoundary が安全側でfalseを返す）。
  const footprintCellKeys = stair ? refreshCells(stair.cells, graph) : null;

  const result = [];
  for (const p of unitParams) {
    const kind = classifyUTurnEdge(uCtx, p, graph);
    if (kind === 'lane') {
      // ルール6: レーン間中心線は委譲判定の対象外——これまでどおり常にこの部屋が壁を持つ。
      result.push({ p, kind, outsideRoom: null });
      continue;
    }
    const outsideRoom = findOutsideRoom(p, graph, cellToRoom);
    const onFootprint = isOnFootprintBoundary(p, graph, footprintCellKeys);
    if (isDelegatedEdge(outsideRoom, p, graph, under2aRoomIds, stairOpenings, onFootprint)) continue; // 委譲: 生成もclaimもしない
    result.push({ p, kind, outsideRoom });
  }
  return result;
}

// ----------------------------------------------------------------
// 既存壁優先（ルール3）
// ----------------------------------------------------------------

// 既存壁の実位置（materialRange の中心）が境界CLからこの許容差(mm)以内なら「同じ壁位置に
// 実在する」とみなす。別のCLにアンカーされた手動壁・偏芯量つきの壁も拾えるよう、
// axisCL の参照一致ではなく物理位置で判定する。
// 許容差は既定の壁厚オーダー（base+finish=90+12.5=102.5mm）をやや上回る 110mm を上限にする:
// 実務上のグリッド間隔（部屋を成立させる最小スパンでも数百mm、モジュール910mm等が通例）より
// 十分小さく、平行する隣の別境界CLの壁を誤って拾うことはない
// （110mm はグリッド間隔の最小実用値の半分にも遠く満たない）。
const EXISTING_WALL_POSITION_TOLERANCE = 110; // mm

// マージ済みセグメントに対する既存壁の重なりを「有意」とみなす下限(mm)。浮動小数の丸め・
// 端点の接触（重なりゼロ近傍）を「有意な重なり」と誤判定しないための小さな余裕。
const SKIP_OVERLAP_EPS = 5; // mm

// 生成開始時点の壁一覧から、(isVertical, 物理位置) が境界CLの近くにある壁のカバー区間を
// 引けるクロージャを作る。生成中に自分で追加した壁を誤って「既存壁」とみなさないよう、
// 呼び出し前に1度だけスナップショットする。外壁（isExteriorWall）はステップ3で毎回
// 全削除・再生成されるため「既存壁優先」の対象から除外する（除外しないと、残存中の旧外壁に
// 階段下偏芯壁が誤って抑止され得る）。
function makeExistingCovers(graph) {
  const snapshot = graph.walls.filter(w => !w.isExteriorWall).map(w => {
    const range = w.materialRange;
    return {
      isVertical: w.isVertical,
      position: (range.lo + range.hi) / 2, // 実材の中心＝壁の物理位置
      lo: Math.min(w.coord1, w.coord2), hi: Math.max(w.coord1, w.coord2),
    };
  });
  return (isVertical, boundaryValue) => snapshot
    .filter(w => w.isVertical === isVertical && Math.abs(w.position - boundaryValue) < EXISTING_WALL_POSITION_TOLERANCE)
    .map(w => [w.lo, w.hi]);
}

// [segLo,segHi] と covers（[lo,hi]の配列）との重なり長の合計(mm)。
function coverageOverlapLength(segLo, segHi, covers) {
  let total = 0;
  for (const [cLo, cHi] of covers) {
    const overlap = Math.min(segHi, cHi) - Math.max(segLo, cLo);
    if (overlap > 0) total += overlap;
  }
  return total;
}

// ----------------------------------------------------------------
// 壁生成本体（generateRoomWallsFromOutline のコーナーマップ方式を汎用化）
// ----------------------------------------------------------------

/**
 * rawParams（各要素は axisOffset 等が最終確定値。wallFinish/backingOffset/backingDepth を持つ）から、
 * コーナー取り合い・端点ルール（clipToAxisExtent）適用済みの「壁候補セグメント」を計算する
 * （generateRoomWallsFromOutline と同じ方式。壁の生成自体はまだ行わない——ルール3の
 * スキップ判定・main/thin のペアリングをこの後で行うため分離している）。
 */
function computeWallSegments(graph, rawParams) {
  if (rawParams.length === 0) return [];

  // コーナーマップ構築: 相手辺も最終確定 axisOffset で登録する
  const cornerMap = new Map();
  const ensureCorner = (hId, vId) => {
    const key = `${hId}:${vId}`;
    if (!cornerMap.has(key)) cornerMap.set(key, { hOffset: null, vOffset: null });
    return cornerMap.get(key);
  };
  for (const p of rawParams) {
    if (!p.isVertical) {
      ensureCorner(p.axisCLId, p.startCLId).hOffset = p.axisOffset;
      ensureCorner(p.axisCLId, p.endCLId).hOffset   = p.axisOffset;
    } else {
      ensureCorner(p.startCLId, p.axisCLId).vOffset = p.axisOffset;
      ensureCorner(p.endCLId,   p.axisCLId).vOffset = p.axisOffset;
    }
  }

  // (axisCLId, axisOffset) でグループ化してマージ（同一カテゴリのエッジのみ結合される——
  // ルール1とルール6は axisOffset の大きさが異なるため誤って混ざらない）
  const groups = new Map();
  for (const p of rawParams) {
    const key = `${p.axisCLId}:${p.axisOffset}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  }

  const result = [];
  for (const [, segs] of groups) {
    const { axisCLId, axisOffset, isVertical, wallFinish, backingOffset, backingDepth } = segs[0];
    const axisCL = getShape(graph, axisCLId);
    if (!axisCL) continue;
    const protrusion = Math.abs(axisOffset);

    for (const seg of mergeSegments(segs, graph)) {
      const startCL = getShape(graph, seg.startCLId);
      const endCL   = getShape(graph, seg.endCLId);
      if (!startCL || !endCL) continue;

      let startOffset, endOffset;
      if (!isVertical) {
        startOffset = cornerMap.get(`${axisCLId}:${seg.startCLId}`)?.vOffset ?? 0;
        endOffset   = cornerMap.get(`${axisCLId}:${seg.endCLId}`)?.vOffset   ?? 0;
      } else {
        startOffset = cornerMap.get(`${seg.startCLId}:${axisCLId}`)?.hOffset ?? 0;
        endOffset   = cornerMap.get(`${seg.endCLId}:${axisCLId}`)?.hOffset   ?? 0;
      }

      const clipped = clipToAxisExtent(axisCL, startCL, startOffset, endCL, endOffset, protrusion);
      if (!clipped) continue;

      const segLo = Math.min(startCL.value + clipped.startOffset, endCL.value + clipped.endOffset);
      const segHi = Math.max(startCL.value + clipped.startOffset, endCL.value + clipped.endOffset);

      result.push({
        axisCLId, axisOffset, isVertical, wallFinish, backingOffset, backingDepth,
        axisCL, startCL, endCL, clipped, segLo, segHi, skip: false,
      });
    }
  }
  return result;
}

/**
 * computeWallSegments が返したセグメントから、skip===false のものだけ Wall を生成する
 * （ルール3で有意にスキップされたセグメントはここで一切生成されない——部分カバーでも
 * セグメント全体が非生成になる。真の端点以外の切断境界を扱わないため、旧実装にあった
 * 「区間の一部だけ座標アンカーで生成する」処理は不要になった）。
 */
function buildWallsFromSegments(graph, segments) {
  const walls = [];
  for (const s of segments) {
    if (s.skip) continue;
    const w = graph.addWall(s.axisCL, s.axisOffset, s.isVertical, s.startCL, s.clipped.startOffset, s.endCL, s.clipped.endOffset, {
      isRoomWall: true, wallFinish: s.wallFinish, backingOffset: s.backingOffset, backingDepth: s.backingDepth,
    });
    walls.push(w);
  }
  return walls;
}

/**
 * ルール3（既存壁優先）のスキップ判定をセグメント単位で行う。mainSegments は必ず自身の
 * existingCovers 判定でスキップを決める。thinSegments は自身の判定に加え、同一エッジ由来
 * （同じ axisCLId・isVertical・スパンが重なる）の main セグメントがスキップ済みなら追従する
 * （要件: 「main がスキップなら thin もスキップ」というペア関係。逆方向——thin 単独のスキップが
 * main に波及する経路は設けない。thin は main とは異なる物理位置＝別レイヤーの薄壁であり、
 * 独立にスキップされうる一方向の依存として扱う）。
 */
function applyExistingWallSkip(existingCovers, mainSegments, thinSegments) {
  for (const s of mainSegments) {
    const covers = existingCovers(s.isVertical, s.axisCL.value);
    s.skip = coverageOverlapLength(s.segLo, s.segHi, covers) > SKIP_OVERLAP_EPS;
  }
  for (const s of thinSegments) {
    const covers = existingCovers(s.isVertical, s.axisCL.value);
    const ownSkip = coverageOverlapLength(s.segLo, s.segHi, covers) > SKIP_OVERLAP_EPS;
    const pairedSkip = mainSegments.some(m =>
      m.skip && m.axisCLId === s.axisCLId && m.isVertical === s.isVertical &&
      Math.min(m.segHi, s.segHi) - Math.max(m.segLo, s.segLo) > SKIP_OVERLAP_EPS);
    s.skip = ownSkip || pairedSkip;
  }
}

// 未分類（除外含む）の全エッジを {isVertical,value,lo,hi} で列挙する（stairPortEdges と同形状）。
// 生成有無を問わずこの部屋の外周全体を「claim」し、他部屋・外壁ループの重複生成を防ぐ。
function computeClaimedEdges(graph, unitParams) {
  const groups = new Map();
  for (const p of unitParams) {
    const key = `${p.axisCLId}:${p.axisOffset}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  }
  const edges = [];
  for (const [, segs] of groups) {
    const { axisCLId, isVertical } = segs[0];
    const axisCL = getShape(graph, axisCLId);
    if (!axisCL) continue;
    for (const seg of mergeSegments(segs, graph)) {
      const startCL = getShape(graph, seg.startCLId);
      const endCL   = getShape(graph, seg.endCLId);
      if (!startCL || !endCL) continue;
      edges.push({
        isVertical, value: axisCL.value,
        lo: Math.min(startCL.value, endCL.value), hi: Math.max(startCL.value, endCL.value),
      });
    }
  }
  return edges;
}

// ----------------------------------------------------------------
// 公開API
// ----------------------------------------------------------------

/**
 * room の外周エッジ（破れ線・踊り場境界等の除外分も含む）を {isVertical,value,lo,hi} で列挙する
 * （壁の生成有無に関わらない claim 専用の軽量経路）。generateStairUnderWalls 内の claim 計算と
 * 同じロジック（computeClaimedEdges）を共有する。部屋が既に generatedWallIds を持つ再脱出時
 * （壁は再生成しない）でも claim だけは毎回行う必要があるため、壁生成から独立して呼べるように
 * 分離している（App.jsx ステップ2a）。
 *
 * 委譲エッジ（isDelegatedEdge。相手がユーザー指定の通常部屋・吹抜けVOID）は claim しない
 * ——ステップ2の隣室壁生成に委譲するため、ここで claim すると隣室壁が抑止され壁ゼロになる。
 * generateStairUnderWalls と同じ stairUnderOwnParams を共有するため、レーン分類・
 * footprint境界判定も含め判定は完全に一致する。stair は位置引数で必須にしている——
 * opts の任意プロパティにすると渡し忘れが静かに失敗し（レーン分類・footprint判定が
 * 行われず生成側と判定がずれる）、QAで指摘された経緯があるため。
 *
 * @param {object} graph
 * @param {import('@core').Stair} stair
 * @param {import('@core').Room} room
 * @param {{stairOpenings?: {isVertical:boolean,value:number,lo:number,hi:number}[],
 *   under2aRoomIds?: Set<string>, cellToRoom?: Map<string, import('@core').Room>}} [opts]
 * @returns {{isVertical:boolean,value:number,lo:number,hi:number}[]}
 */
export function stairUnderClaimedEdges(graph, stair, room, opts = {}) {
  const own = stairUnderOwnParams(graph, stair, room, opts);
  return computeClaimedEdges(graph, own.map(o => o.p));
}

/**
 * 階段下部屋 room の外周壁（偏芯壁＋外側仕上げ薄壁）を生成する。
 *
 * @param {object} graph
 * @param {import('@core').Stair} stair
 * @param {import('@core').Room} room - 階段下部屋（stairUnderRooms の結果1件分）
 * @param {{wallBase?:number, wallFinish?:number}} dims - room 自身の壁寸法（下地・室内側仕上げ厚）
 * @param {{dimsOf?: (room:import('@core').Room) => {wallBase?:number, wallFinish?:number},
 *   stairOpenings?: {isVertical:boolean,value:number,lo:number,hi:number}[],
 *   under2aRoomIds?: Set<string>, cellToRoom?: Map<string, import('@core').Room>}} opts
 *   splitCLIds は現在未使用（旧ルール4aの名残。呼び出し側の互換性のため受理はするが無視する。
 *   破れ線・踊り場境界は下記のとおり 'normal' と同じルール1・2の経路に乗るため不要になった）。
 *   stairOpenings・under2aRoomIds は isDelegatedEdge（同一CL上に壁1つだけ）の判定に使う。
 *   cellToRoom は省略可（buildCellToRoom(graph) を毎回作らず呼び出し側で1度だけ作って
 *   stairUnderClaimedEdges と共有する場合に渡す。QA指摘）。
 * @returns {{ walls: import('@core').Wall[], claimedEdges: {isVertical:boolean,value:number,lo:number,hi:number}[] }}
 */
export function generateStairUnderWalls(graph, stair, room, dims, opts = {}) {
  const { dimsOf = () => ({}), stairOpenings = [], under2aRoomIds = new Set(), cellToRoom } = opts;
  const base   = dims?.wallBase   ?? DEFAULT_WALL_BASE;
  const finish = dims?.wallFinish ?? DEFAULT_WALL_FINISH;

  // stairUnderClaimedEdges と共有する唯一の判定経路（QA指摘: 述語の一本化）。
  const own = stairUnderOwnParams(graph, stair, room, { stairOpenings, under2aRoomIds, cellToRoom });
  if (own.length === 0) return { walls: [], claimedEdges: [] };

  const stairPairRoom = stair.roomId ? (graph.roomMap.get(stair.roomId) ?? null) : null;
  const stFinish = stairPairRoom ? (dimsOf(stairPairRoom).wallFinish ?? DEFAULT_WALL_FINISH) : DEFAULT_WALL_FINISH;

  const existingCovers = makeExistingCovers(graph);

  const mainParams = [];
  const thinParams = [];
  // 委譲されなかった（＝この部屋が壁を持つ）エッジのみ。claimedEdges はここから作る
  // （委譲エッジは claim しない——claim すると隣室壁が抑止され壁ゼロになる）。
  const ownParams = own.map(o => o.p);

  for (const { p, kind, outsideRoom } of own) {
    // 破れ線の分割CL上のエッジ・U字系の踊り場ストリップ境界（＝破れ線の「正面」）も、
    // 他の外周と同じ 'normal' 経路（ルール1・2）に乗せる。外側セルは階段ペアRoomの footprint
    // に属するため、outsideRoom がそれを解決しルール2の薄壁（階段仕上げ厚）が付く
    // （旧ルール4a/4bの「無壁」exclusionを廃止）。
    const sign = Math.sign(p.axisOffset) || 1;

    if (kind === 'lane') {
      // ルール6: レーン間中心線 — 偏芯壁（下地＋部屋側仕上げ、backingOffsetを50+f_stぶんずらす）
      mainParams.push({
        ...p,
        axisOffset:    sign * (LANE_CLEARANCE + stFinish + base + finish),
        wallFinish:    finish,
        backingOffset: sign * (LANE_CLEARANCE + stFinish + base / 2),
        backingDepth:  base,
      });
      // 階段側仕上げ薄壁: 帯 [CL+sign*50, CL+sign*(50+f_st)]
      thinParams.push({
        ...p,
        axisOffset:    sign * (LANE_CLEARANCE + stFinish),
        wallFinish:    stFinish,
        backingOffset: 0,
        backingDepth:  0,
      });
      continue;
    }

    // ルール1: 通常の外周（下地を室内側へ全寄せした偏芯壁）
    mainParams.push({
      ...p,
      axisOffset:    sign * (base + finish),
      wallFinish:    finish,
      backingOffset: sign * (base / 2),
      backingDepth:  base,
    });

    // ルール2: 外側セルが部屋（階段ペアRoom含む）に属する場合、その部屋の仕上げのみの薄壁
    if (!outsideRoom) continue;
    const outerFinish = dimsOf(outsideRoom).wallFinish ?? DEFAULT_WALL_FINISH;
    thinParams.push({
      ...p,
      axisOffset:    -sign * outerFinish,
      wallFinish:    outerFinish,
      backingOffset: 0,
      backingDepth:  0,
    });
  }

  // ルール3: エッジ（マージ済みセグメント）単位で既存壁の有意な重なりをスキップする
  // （部分カバーでもセグメント全体を非生成にする）。main→thin のペア関係も
  // applyExistingWallSkip 内で適用する。
  const mainSegments = computeWallSegments(graph, mainParams);
  const thinSegments = computeWallSegments(graph, thinParams);
  applyExistingWallSkip(existingCovers, mainSegments, thinSegments);

  const walls = [
    ...buildWallsFromSegments(graph, mainSegments),
    ...buildWallsFromSegments(graph, thinSegments),
  ];
  const claimedEdges = computeClaimedEdges(graph, ownParams);

  return { walls, claimedEdges };
}

// ----------------------------------------------------------------
// 2a壁の突き当たり処理（T字・出隅/入隅）
// ----------------------------------------------------------------

// wall の長さ方向の範囲（coord1/coord2 を昇順に）
function wallLenRange(w) {
  return [Math.min(w.coord1, w.coord2), Math.max(w.coord1, w.coord2)];
}

// 点 (x,y) を中心とした4象限（対角 ±QUADRANT_EPS）のうち、room のセルに属する数を返す
// （0〜4）。出隅/入隅の判定に使う: 1象限のみ室内＝出隅（部屋が凸の先端）、
// 3象限が室内＝入隅（部屋側に折れ込む notch）。0/2/4 は直線状の境界等で通常は生じないが、
// 判定不能な安全側フォールバックとして「入隅」（近位face）扱いにする（呼び出し側で処理）。
function roomQuadrantCount(x, y, roomCellKeys, graph) {
  let n = 0;
  for (const dx of [-1, 1]) {
    for (const dy of [-1, 1]) {
      const cell = worldToCell(x + dx * QUADRANT_EPS, y + dy * QUADRANT_EPS, graph);
      if (cell && roomCellKeys.has(cell.key)) n++;
    }
  }
  return n;
}

// wall の「junctionAlong（wallの長さ方向座標）に最も近い端点」を target（厚み方向の絶対座標）へ
// スナップする。もう一方の端点との間が MIN_LEN 未満になる場合は変更しない。
// @returns {boolean} 実際に変更したか
function snapNearestEnd(wall, junctionAlong, target) {
  const c1 = wall.coord1, c2 = wall.coord2;
  const nearStart = Math.abs(c1 - junctionAlong) <= Math.abs(c2 - junctionAlong);
  if (nearStart) {
    const cand = target - wall.clStart.value;
    const otherCoord = wall.clEnd.value + wall.endOffset;
    if (Math.abs((wall.clStart.value + cand) - otherCoord) < MIN_LEN) return false;
    if (wall.startOffset === cand) return false;
    wall.startOffset = cand;
  } else {
    const cand = target - wall.clEnd.value;
    const otherCoord = wall.clStart.value + wall.startOffset;
    if (Math.abs((wall.clEnd.value + cand) - otherCoord) < MIN_LEN) return false;
    if (wall.endOffset === cand) return false;
    wall.endOffset = cand;
  }
  return true;
}

// wall の「junctionAlong に最も近い端点」を、other の materialRange（厚み方向の実材範囲）の
// near/far face へスナップする。near/far は wall の反対側（アンカー）端点が other の
// materialRange のどちら寄りかで決める（アンカー側に近い方が near）。
function snapToMaterialFace(wall, junctionAlong, otherRange, faceMode) {
  const c1 = wall.coord1, c2 = wall.coord2;
  const nearStart = Math.abs(c1 - junctionAlong) <= Math.abs(c2 - junctionAlong);
  const anchor = nearStart ? c2 : c1;
  const distLo = Math.abs(anchor - otherRange.lo), distHi = Math.abs(anchor - otherRange.hi);
  const nearFace = distLo <= distHi ? otherRange.lo : otherRange.hi;
  const farFace  = distLo <= distHi ? otherRange.hi : otherRange.lo;
  const target = faceMode === 'far' ? farFace : nearFace;
  return snapNearestEnd(wall, junctionAlong, target);
}

/**
 * 2a壁（階段下壁）と、それ以外の既存壁（隣接部屋壁・外壁。2a壁同士は対象外）との
 * 突き当たり処理を行う。
 *
 * - T字（junction が相手壁自身の端から tolerance を超えて離れている＝相手壁の中間）:
 *   2a壁側の端点だけを、相手壁の materialRange の近位face（手前face）で止める。
 *   相手壁の端点は一切動かさない（要件1）。
 * - コーナー（junction が相手壁自身の端から tolerance 以内）:
 *   room（2a壁の所属する階段下部屋）のセルが junction の4象限のうち何象限を占めるかで
 *   出隅/入隅を判定する（1象限＝出隅、3象限＝入隅、それ以外は入隅にフォールバック）。
 *   出隅なら双方の壁を相手の materialRange の遠位face（材で角を閉じる）まで延ばし、
 *   入隅なら近位faceで止める。相手壁の端点も同じ規則でスナップする（要件3）。
 *
 * 生成時のコーナーマップで既に正しく取り合っている2a壁同士（同室内・別階段下部屋問わず）は
 * 対象から除外する（entries に含まれる壁同士は候補から外れる）。
 *
 * @param {object} graph
 * @param {{wall:import('@core').Wall, room:import('@core').Room}[]} entries - 対象2a壁と、
 *   出隅/入隅判定に使う所属Room（stairUnderRooms の room）
 * @param {number} [tolerance=JUNCTION_TOLERANCE]
 * @returns {{wall:import('@core').Wall, startOffset:number, endOffset:number}[]}
 *   変更した壁の変更前スナップショット（wall ごとに初回遭遇時点＝真の変更前の値。2a壁自身・
 *   相手壁の双方を含みうる。未変更の壁は含まれない場合がある——呼び出し側で before/after差分
 *   を取る想定）
 */
export function trimStairUnderJunctions(graph, entries, tolerance = JUNCTION_TOLERANCE) {
  const entryIds = new Set(entries.map(e => e.wall.id));
  const touchedIds = new Set();
  const snapshots = [];
  const captureBefore = (w) => {
    if (touchedIds.has(w.id)) return;
    touchedIds.add(w.id);
    snapshots.push({ wall: w, startOffset: w.startOffset, endOffset: w.endOffset });
  };

  for (const { wall: w, room } of entries) {
    const roomCellKeys = refreshCells(room.cells, graph);
    const candidates = graph.walls.filter(o => o !== w && o.isVertical !== w.isVertical && !entryIds.has(o.id));

    for (const other of candidates) {
      const [v, h] = w.isVertical ? [w, other] : [other, w];
      const vx = v.axisValue;
      const [vy1, vy2] = wallLenRange(v);
      const hy = h.axisValue;
      const [hx1, hx2] = wallLenRange(h);

      // 近接チェック（core.js trimIntersectingWalls と同じ face 座標ベース）
      if (vx < hx1 - tolerance || vx > hx2 + tolerance) continue;
      if (hy < vy1 - tolerance || hy > vy2 + tolerance) continue;

      const junctionAlongW     = other.axisValue; // w の長さ方向座標系での junction 位置
      const junctionAlongOther = w.axisValue;      // other の長さ方向座標系での junction 位置
      const [otherLo, otherHi] = wallLenRange(other);
      const isCorner = Math.abs(junctionAlongOther - otherLo) <= tolerance ||
                        Math.abs(junctionAlongOther - otherHi) <= tolerance;

      let faceMode = 'near'; // T字は常に近位face（要件1）
      if (isCorner) {
        // junction のコーナー座標は face でなく axisCL 位置（構造グリッド線の交点）を使う
        const jx = w.isVertical ? w.axisCL.effectiveValue : other.axisCL.effectiveValue;
        const jy = w.isVertical ? other.axisCL.effectiveValue : w.axisCL.effectiveValue;
        const n = roomQuadrantCount(jx, jy, roomCellKeys, graph);
        faceMode = n === 1 ? 'far' : 'near'; // 1象限=出隅（遠位）、3象限=入隅（近位）、他はフォールバックで入隅
      }

      captureBefore(w);
      snapToMaterialFace(w, junctionAlongW, other.materialRange, faceMode);

      if (isCorner) {
        captureBefore(other);
        snapToMaterialFace(other, junctionAlongOther, w.materialRange, faceMode);
      }
    }
  }

  return snapshots;
}
