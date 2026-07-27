/**
 * CL偏芯（内壁指定のあるCLの偏芯仕様）の導出・適用（仕上げモードで動的ロード）。
 *
 * PlanGraph.clEccentricities（clId → レコード）は「何を指定したか」だけを保持し、
 * Wall 側（axisOffset/wallFinish/backingOffset/backingDepth/finishSide）へは
 * 導出結果だけを書き込む。applyCLEccentricity はモード境界・操作確定時に呼ばれ、
 * 前回の適用結果に依存せず spec と現材から毎回フル再計算する（冪等）。
 *
 * 符号規約: 正 = 値が増える方向（垂直CL＝右、水平CL＝下）。Wall.axisOffset と同規約。
 */

import { RoomFeature } from '@core';
import { worldToCell, refreshCells } from './gridCells.js';
import { buildCellToRoom, edgeGeometry, interiorWallSpans } from './edgeClassify.js';
import { materialThickness, interiorWallDims, roomWallDims } from './edgeComposition.js';
import { DEFAULT_WALL_BASE, DEFAULT_WALL_FINISH } from './wallGeneration.js';
import { findOpeningsOnWall, findHostWall } from '../openings/openingGeometry.js';

// 壁スパンと内壁エッジスパンの重なりを「有意」とみなす下限(mm)。stairUnderWalls.js の
// SKIP_OVERLAP_EPS と同水準（浮動小数の丸め・端点接触を誤って有意重なりと判定しない）。
const SPAN_OVERLAP_EPS = 5; // mm

// 壁の軸CL±この距離(mm)をサンプリングして室の帰属側を判定する。edgeClassify.js の
// ADJACENT_SAMPLE_EPS と同水準。
const SIDE_SAMPLE_EPS = 10; // mm

// ----------------------------------------------------------------
// 内部ヘルパー
// ----------------------------------------------------------------

// [lo,hi] 同士の重なり長(mm)。重ならなければ 0 以下。
function overlapLength(lo1, hi1, lo2, hi2) {
  return Math.min(hi1, hi2) - Math.max(lo1, lo2);
}

/**
 * 壁 w の帰属側（±1）を、軸CL±SIDE_SAMPLE_EPS を worldToCell して room のセルに
 * 属する側で決める（axisOffset の符号からは決めない——冪等性のため必須。
 * 解除・再適用を繰り返しても常に室の実位置から再判定できる）。
 * @returns {1|-1|null} 判定不能なら null
 */
function roomSideOf(w, roomCells, graph) {
  const axisV = w.axisCL.value;
  const mid   = (w.coord1 + w.coord2) / 2;
  const cellPos = w.isVertical ? worldToCell(axisV + SIDE_SAMPLE_EPS, mid, graph) : worldToCell(mid, axisV + SIDE_SAMPLE_EPS, graph);
  const cellNeg = w.isVertical ? worldToCell(axisV - SIDE_SAMPLE_EPS, mid, graph) : worldToCell(mid, axisV - SIDE_SAMPLE_EPS, graph);
  if (cellPos && roomCells.has(cellPos.key)) return 1;
  if (cellNeg && roomCells.has(cellNeg.key)) return -1;
  return null;
}

/**
 * CL上に複数部屋が並ぶ場合の代表室（仕上げ面合わせの基準）。
 * 側 side に接する INTERIOR_WALL エッジのスパン長合計が最大の Room（同値は room.id 昇順）。
 * @returns {import('@core').Room | null}
 */
function representativeRoom(graph, clId, side, cellToRoom) {
  const totals = new Map(); // Room → 合計長(mm)
  for (const edge of graph.edges) {
    if (edge.masterType !== 'INTERIOR_WALL' || edge.axisCLId !== clId) continue;
    const geo = edgeGeometry(edge, graph, cellToRoom);
    if (!geo) continue;
    const room = side > 0 ? geo.roomPos : geo.roomNeg;
    if (!room) continue;
    totals.set(room, (totals.get(room) ?? 0) + (geo.hi - geo.lo));
  }
  let best = null, bestLen = -Infinity;
  for (const [room, len] of totals) {
    if (len > bestLen || (len === bestLen && (!best || room.id < best.id))) { best = room; bestLen = len; }
  }
  return best;
}

/**
 * graph.stairs の全セル（階段の平面footprint全体。破れ線先の階段下エリアも含む）を集める。
 * 階段下部屋（2a。stairUnderRooms が返す通常Room）を偏芯対象から除外する判定に使う——
 * 2a壁は generateStairUnderWalls 固有の偏芯ルール（LANE_CLEARANCE式）で生成・
 * trimStairUnderJunctions でトリムされる別管理の壁のため、ここで汎用偏芯式を適用すると、
 * 2a側の生成・トリム（App.jsx ステップ2a/3.5）と偏芯適用（ステップ2b）が毎脱出で
 * 互いの結果を上書きし合う（無限に収束しない・面位置が脱出ごとにブレる）。
 * 階段ペアRoom（feature=STAIR）・階段吹抜け（STAIR_VOID）はセルが階段そのもの（stair.cells）と
 * 一致するが、これらは通常Roomと同じ経路（generateRoomWallsFromOutline）で壁を持つため
 * 除外しない——feature で区別する（stairUnderRooms は STAIR/STAIR_VOID/UNDEFINED を除外して
 * 選定するため、階段セルに重なる「feature がどちらでもない」Room＝2a部屋だけがこの除外の対象）。
 */
function collectStairCells(graph) {
  const stairCells = new Set();
  for (const stair of graph.stairs) {
    for (const key of refreshCells(stair.cells, graph)) stairCells.add(key);
  }
  return stairCells;
}

// ----------------------------------------------------------------
// 公開 API
// ----------------------------------------------------------------

/**
 * CL偏芯の解決結果（プレビュー用・副作用なし。EccentricityDialog がラジオ選択肢・説明図に使う）。
 * @param {object|null} [specOverride] 指定時は graph.clEccentricities の値の代わりにこれを使う
 *   （EccentricityDialog が確定前の編集中ドラフトをライブプレビューするため。null＝解除状態を仮定）。
 *   省略（undefined）時は従来どおり graph に保存済みの spec を使う。
 * @returns {{ spec: object|undefined, e:number, b:number,
 *   sides:{pos:number, neg:number, posRoom:import('@core').Room|null, negRoom:import('@core').Room|null} }}
 *   e = 下地帯中心の axisCL.value からの符号付きオフセット(mm)。spec未指定なら0。
 *   b = 下地帯の深さ(mm)。sides.pos/neg = 各側の代表室の仕上げ厚（面材+室側仕上げ, mm）。
 *   sides.posRoom/negRoom = 各側の代表室（null＝その側に内壁指定エッジの接する部屋が無い＝
 *   「仕上げ面合わせ」選択肢を出せない）。
 */
export function resolveEccentricity(graph, clId, materialMap, specOverride) {
  const spec = specOverride !== undefined ? specOverride : graph.clEccentricities.get(clId);
  const backingCode = spec?.backing || graph.interiorWallBacking;
  const b = materialThickness(materialMap?.get(backingCode));
  const cellToRoom = buildCellToRoom(graph);
  const finishOf = (rm) => interiorWallDims(graph, rm, materialMap, spec?.backing)?.wallFinish ?? DEFAULT_WALL_FINISH;

  const posRoom = representativeRoom(graph, clId, 1, cellToRoom);
  const negRoom = representativeRoom(graph, clId, -1, cellToRoom);
  const fPos = posRoom ? finishOf(posRoom) : DEFAULT_WALL_FINISH;
  const fNeg = negRoom ? finishOf(negRoom) : DEFAULT_WALL_FINISH;

  let e = 0;
  if (spec) {
    e = spec.mode === 'face' ? -spec.side * (b / 2 + (spec.side > 0 ? fPos : fNeg)) : spec.value;
  }
  return { spec, e, b, sides: { pos: fPos, neg: fNeg, posRoom, negRoom } };
}

/**
 * CL偏芯を対象壁へフル再計算して焼き込む（毎回 spec＋現材から再計算する冪等な適用）。
 * spec が undefined（解除）の場合は roomWallDims の対称既定式へ戻し、
 * backingOffset/backingDepth/finishSide を null（現行式）に戻す。
 *
 * 対象: clId を軸CLに持つ、非外壁の room 生成壁（UNDEFINED の部屋は除く。階段ペアRoom・
 * 階段吹抜けも、新モデルでは通常のRoomと同じ経路で壁を持つため対象に含める。ただし
 * 階段下部屋（2a。階段セルに重なるが feature が STAIR/STAIR_VOID ではない通常Room）は
 * 別管理の壁のため対象外——collectStairCells 参照）。
 * 内壁指定（INTERIOR_WALL エッジ）のスパンと有意に重ならない壁は対象外。
 *
 * @param {object} graph
 * @param {string} clId
 * @param {{materialMap: Map}} opts
 * @returns {{wall: import('@core').Wall, axisOffset:number, wallFinish:number|null, backingOffset:number|null,
 *   backingDepth:number|null, finishSide:number|null, startOffset:number, endOffset:number}[]}
 *   変更した壁の変更前スナップショット（呼び出し側の undo 用、壁ごとに重複なし）。壁自体・
 *   コーナー追従で端点オフセットが変わった隣接壁の双方を含みうる。
 */
export function applyCLEccentricity(graph, clId, { materialMap } = {}) {
  const spec = graph.clEccentricities.get(clId);

  // 材データ未ロードは「適用（spec あり）」のときだけ止める（既定値へ黙って潰さない。モード境界の
  // たびに毎回フル再計算する冪等処理のため、ここで妥協した既定値を書くと不可逆に壁が破壊される）。
  // 「解除（spec なし）」は materialMap 不要（roomWallDims が null なら既定値にフォールバックする
  // 経路が既にある）——ここで止めると、材が読めない状況で偏芯レコードだけ消えた壁が解除できず
  // 孤児化する（QA finding 4）。
  if (spec && !materialMap) return [];

  const spans = interiorWallSpans(graph, clId);
  // spans が空でも「解除」は続行する——内壁指定（INTERIOR_WALLエッジ）が消えた後に
  // レコードだけ削除すると、既に偏芯済みの壁がその痕跡（finishSide/backingOffset）を
  // 持ったまま孤児化し、ユーザーが解除できなくなる（QA finding 3）。「適用」はスパンが
  // 無ければ対象が無いので従来どおり打ち切る。
  if (spec && spans.length === 0) return [];

  const stairCells = collectStairCells(graph);
  const cellToRoom = buildCellToRoom(graph);

  // 対象壁の抽出（所属Room付き）。適用時はINTERIOR_WALLスパンとの重なりで判定するが、
  // 解除時はスパンが既に消えている前提のため、代わりに偏芯の痕跡（finishSide/backingOffset
  // が非null）を持つ壁で判定する——痕跡を持つ壁だけが「戻すべき対象」。
  // feature除外は UNDEFINED のみ（階段ペアRoom・階段吹抜けも新モデルでは通常のRoomと
  // 同じ経路で壁を持つため対象に含める）。ただし階段下部屋（2a。階段セルに重なるが
  // feature が STAIR/STAIR_VOID ではない通常Room）は対象外——2a壁は別管理
  // （collectStairCells のコメント参照）。ペアRoom・吹抜け自身のセルも階段セルと重なるが、
  // feature で区別してそちらは除外しない。
  const targets = [];
  for (const room of graph.rooms) {
    if (room.feature === RoomFeature.UNDEFINED) continue;
    const roomCells = refreshCells(room.cells, graph);
    if (room.feature !== RoomFeature.STAIR && room.feature !== RoomFeature.STAIR_VOID) {
      let overlapsStair = false;
      for (const key of roomCells) { if (stairCells.has(key)) { overlapsStair = true; break; } }
      if (overlapsStair) continue;
    }

    for (const wid of room.generatedWallIds) {
      const w = graph.shapeMap.get(wid);
      if (!w || w.isExteriorWall || w.axisCL.id !== clId) continue;
      const wLo = Math.min(w.coord1, w.coord2), wHi = Math.max(w.coord1, w.coord2);
      const overlapsSpan = spec
        ? spans.some(s => overlapLength(wLo, wHi, s.lo, s.hi) > SPAN_OVERLAP_EPS)
        : (w.finishSide != null || w.backingOffset != null);
      if (!overlapsSpan) continue;
      const side = roomSideOf(w, roomCells, graph);
      if (side == null) continue;
      targets.push({ w, room, side });
    }
  }
  if (targets.length === 0) return [];

  const backingCode = spec?.backing || graph.interiorWallBacking;
  const b = materialThickness(materialMap?.get(backingCode));
  // 下地材コードが materialMap に解決できない（未知コード・データ不整合）場合、materialThickness は
  // 0 を返す。既定値へ黙って化けさせず、適用（spec あり）のときだけここで止める。解除は b を
  // 使わない（roomWallDims の既定式のみで戻す）ため、materialMap 欠如・未解決でも進めてよい
  // （QA finding 4）。
  if (spec && b === 0) return [];
  const finishOf = (rm) => interiorWallDims(graph, rm, materialMap, spec?.backing)?.wallFinish ?? DEFAULT_WALL_FINISH;

  let e = 0;
  if (spec) {
    if (spec.mode === 'face') {
      const repRoom = representativeRoom(graph, clId, spec.side, cellToRoom);
      e = -spec.side * (b / 2 + (repRoom ? finishOf(repRoom) : DEFAULT_WALL_FINISH));
    } else {
      e = spec.value;
    }
  }

  // 同じ CL・同じ側同士のスパン重なりで所有権を判定する（下地の2重描画防止。7.2参照）。
  // + 側の壁が常にオーナー、- 側の壁は重なる + 側壁が存在しない場合のみオーナーになる。
  // 判定はまず本呼び出しの targets 内（roomSideOf 由来の side フィールドが使え、処理順に
  // 依存しない）で行い、それで確定しなければ targets 外（階段下壁2a等、targets 抽出条件
  // ——非階段部屋・非UNDEFINED等——から漏れる別経路生成の壁）にも範囲を広げる。targets 外は
  // side フィールドを持たないため、backingRange の中心の実位置（axisCL.value より + か -か）
  // で + 側を判定し、backingRange（実際に下地帯を持つ壁のみ）に限定して重なりを見る。
  // axisOffset の符号は使わない——CL偏芯下では e（下地帯中心のCL全体オフセット）次第で
  // + 側の壁でも axisOffset が負になりうり、符号を側の代理に使えない（QA finding 6）。
  // ここを見落とすと、targets に含まれない + 側の壁と - 側対象壁の双方が「自分がオーナー」と
  // 誤判定し、下地（間柱）を二重描画しうる（QA finding 10）。
  function isOwner(t) {
    if (t.side > 0) return true;
    const tLo = Math.min(t.w.coord1, t.w.coord2), tHi = Math.max(t.w.coord1, t.w.coord2);
    const overlapsT = (lo, hi) => overlapLength(tLo, tHi, lo, hi) > SPAN_OVERLAP_EPS;

    const ownedWithinTargets = targets.some(o => o !== t && o.side > 0 &&
      overlapsT(Math.min(o.w.coord1, o.w.coord2), Math.max(o.w.coord1, o.w.coord2)));
    if (ownedWithinTargets) return false;

    const targetWallIds = new Set(targets.map(o => o.w.id));
    const ownedOutsideTargets = graph.walls.some(w => {
      if (w.id === t.w.id || targetWallIds.has(w.id) || w.axisCL.id !== clId) return false;
      const wb = w.backingRange;
      if (!wb) return false;
      // 対称壁（backingDepth===null）は下地帯中心が軸CL上（center===axisV）に来て両側の
      // 共有下地を表すため、等号（center===axisV）も + 側オーナーとして数える——SPAN_OVERLAP_EPS
      // 分だけ許容して厳密不等号による取りこぼしを避ける（QA再指摘: Finding 10 主要ケース再発）。
      return (wb.lo + wb.hi) / 2 > t.w.axisCL.value - SPAN_OVERLAP_EPS &&
        overlapsT(Math.min(w.coord1, w.coord2), Math.max(w.coord1, w.coord2));
    });
    return !ownedOutsideTargets;
  }

  const changed = [];
  const touchedIds = new Set();
  // 直接の対象壁（axisOffset等）・コーナー追従壁（startOffset/endOffset）の両方が乗る
  // 汎用スナップショット。初回遭遇時点＝真の変更前値のみを1件記録する
  // （trimStairUnderJunctions と同じ流儀。同一壁への複数回の書換えを重複記録しない）。
  const captureBefore = (w) => {
    if (touchedIds.has(w.id)) return;
    touchedIds.add(w.id);
    changed.push({
      wall: w, axisOffset: w.axisOffset, wallFinish: w.wallFinish,
      backingOffset: w.backingOffset, backingDepth: w.backingDepth, finishSide: w.finishSide,
      startOffset: w.startOffset, endOffset: w.endOffset,
    });
  };

  // 各対象壁が実際にホストする開口を、いずれの壁も変異させる前にまとめて確定しておく。
  // findOpeningsOnWall は幾何重なりのみで wallSide 非依存に判定するため、ループ内で1壁ずつ
  // 変異させながら都度呼ぶと、3壁以上が同じ span 上に並ぶ場合に「まだ変異していない壁」と
  // 「既に変異済みの壁」が混在し、findHostWall の判定が処理順に依存してしまう（QA finding 5）。
  // findHostWall は wallSide 厳密一致。
  const hostedByWall = new Map(targets.map(t => [
    t.w.id,
    new Set(findOpeningsOnWall(t.w, graph).filter(o => findHostWall(o, graph) === t.w).map(o => o.id)),
  ]));

  for (const t of targets) {
    const w = t.w;
    const oldSign = Math.sign(w.axisOffset);
    captureBefore(w);
    const hostedOpeningIds = hostedByWall.get(w.id);

    if (!spec) {
      // 解除: roomWallDims の対称既定式へ戻す（＝generateRoomWallsFromOutline と同一の既定式に
      // 戻す）。backingOffset/backingDepth/finishSide は null（下地なし=0 とは別の意味。Wall の
      // ドキュメント参照）に戻す。
      // 下地出典の非対称は意図した挙動: 適用時（!!spec）は内壁下地 interiorWallBacking を
      // 参照するが、解除時は室生成壁の既定式である roomWallDims（外壁下地 exteriorWallBacking
      // 由来）へ戻す——これは「偏芯指定が無い内壁は他の room 生成壁と同じ既定式に従う」という
      // roomWallDims の既存契約（generateRoomWallsFromOutline が使う式）にそのまま合わせるため。
      const dims = roomWallDims(graph, t.room, materialMap) ?? { wallBase: DEFAULT_WALL_BASE, wallFinish: DEFAULT_WALL_FINISH };
      w.axisOffset    = t.side * (dims.wallBase / 2 + dims.wallFinish);
      w.wallFinish    = dims.wallFinish;
      w.backingOffset = null;
      w.backingDepth  = null;
      w.finishSide    = null;
    } else {
      const f = finishOf(t.room);
      const owner = isOwner(t);
      w.axisOffset    = e + t.side * (b / 2 + f);
      w.wallFinish    = f;
      w.finishSide    = t.side;
      w.backingOffset = owner ? e : 0;
      w.backingDepth  = owner ? b : 0;
    }

    // 開口の側面追従（符号が非0→逆符号に反転した壁がホストする開口のみ wallSide を新符号へ更新。
    // 対象は上で確定した hostedOpeningIds に限る——反対側の壁の開口を巻き込まない）。
    const newSign = Math.sign(w.axisOffset);
    if (oldSign !== 0 && newSign !== 0 && oldSign !== newSign) {
      for (const o of findOpeningsOnWall(w, graph)) {
        if (hostedOpeningIds.has(o.id) && o.wallSide === oldSign) o.wallSide = newSign;
      }
    }
  }

  // コーナー追従: 同一Roomの直交壁の端点オフセット＝相手辺の axisOffset というコーナーマップ規約
  // （wallGeneration.js のコーナーマップ方式と同じ規約。generateRoomWallsFromOutline 参照）。
  // 既知制約: 同一Roomが同一軸CL上に2辺（2本の対象壁）を持つ退化構成（例: コの字・凹型など
  // 通常の矩形分割では起きないセル配置）では、この for ループが両辺を順に処理するため、
  // 両辺と直交する同一コーナー壁の startOffset/endOffset は後から処理された辺の axisOffset で
  // 上書きされる（last-wins）。対象壁自体（axisOffset等）は各壁ごとに正しく設定されるため
  // 影響は端点コーナーのみ。stairUnderRooms 由来の階段下部屋（trimStairUnderJunctions が
  // 別途トリムする）と異なり、この経路には同様の後段補正が無い。
  for (const t of targets) {
    const w = t.w;
    for (const wid of t.room.generatedWallIds) {
      if (wid === w.id) continue;
      const p = graph.shapeMap.get(wid);
      if (!p) continue;
      if (p.clStart.id === w.axisCL.id && p.startOffset !== w.axisOffset) {
        captureBefore(p);
        p.startOffset = w.axisOffset;
      }
      if (p.clEnd.id === w.axisCL.id && p.endOffset !== w.axisOffset) {
        captureBefore(p);
        p.endOffset = w.axisOffset;
      }
    }
  }

  return changed;
}
