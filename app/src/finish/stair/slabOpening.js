/**
 * 上階スラブの開口（＝上階に床が無い領域）と、その境界線の解決（純モジュール）。
 *
 * 「破れ線から先＝当該平面の切断高より上に続く階段」を点線で描くとき、どこまで見えるかは
 * 上階の床が開いている範囲で決まる。問題仕様の
 *   「上階床面の吹抜け形状 − 当該階天井高さの壁形状 − 上階の階段とりつき部」
 * のうち第1項と第3項は「上階に床が無い領域」という1つの概念に還元できる
 * （とりつき部＝上階でスラブが残る側なので、最初から開口に含まれない）。第2項の壁は
 * 階段側面線の `resolveStairSideLines` が当該階の壁スパンを差し引くことで効かせる。
 *
 * store.js / snap.js / .jsx に依存しない（node:test から単体 import 可）。
 */
import { RoomFeature, isShaftFeature, isGridCenterLine } from '@core';
import { cellBoundsList, refreshCells, roomBounds, getCellsInRect, gridIndexOf, outlineSegments, cellBoundsFromKey, isActiveAcrossRange } from '../gridCells.js';
import { faceRect } from '../wallFaces.js';
import { cellsBeyondBreak } from './stairGeometry.js';

// 境界CL一致判定の許容差(mm)。resolveStairSideLines の WALL_AXIS_CL_EPS と同一規約
// （壁は境界CLに帰属するため通常ほぼ0。丸め・端数対策の余裕）。
const WALL_AXIS_CL_EPS = 0.5;

// 開口を成すセル集合を列挙する。`source` は floorOpeningEdges（層A・実装指示書ステップ3）が使う
// 細分（梁芯生成側の区別。開口の由来そのもの）。
// - 吹抜け（VOID）Room … 占有セル全体が開口。source='void'
// - 昇降路（isShaftFeature。昇降機）Room … 占有セル全体が開口。source='shaft'（床なし＝上階スラブ開口）
// - 階段吹抜け（STAIR_VOID）Room … 占有セル全体が開口。source='stairVoid'
// - 上階の階段 … 破れ線より先のセルが開口（破れ手前＝階段とりつき部はスラブが残る）。source='stairBeyond'
//
// stairFilter（既定=常にtrue＝挙動不変）: upperGraph.stairsを破れ先セット列挙前に絞る。
// 追加理由（実装指示書「スラブ開口と補強・S造梁芯選定」ステップ4 QAレビュー・2026-09-28）:
// floorOpeningEdges（層A。自階の床の開口を求める用途）で自階の階段をそのまま渡すと、設置階
// 自身の破れ先（「切断高より上に続く上り部分」=stair-model.md:38前半）まで「自階スラブの開口」と
// 誤認する——設置階の床に穴は無い。破れ先が「自階スラブの開口越しに見下ろす下階階段」
// （同行後半）になるのは、下階に同じ階段（到達元。上階自動設置＝syncUpperFloorsのコピー）が
// あるときだけ。呼び出し側（openingBeamAxes.js openingBeamSourcesFor）がこの条件で絞る。
// slabOpeningRectsは第3引数を渡さない＝挙動不変（upperGraph視点＝上階を覗く既存用途は
// この誤認の対象外——upperGraph自身が「自階」ではなく常に「直上階」であり、呼び出し側の設計が異なる）。
function openingCellSets(upperGraph, riserOf, stairFilter = () => true) {
  const sets = [];
  for (const room of upperGraph.rooms) {
    if (room.feature !== RoomFeature.VOID && room.feature !== RoomFeature.STAIR_VOID
      && !isShaftFeature(room.feature)) continue;
    const cells = refreshCells(room.cells, upperGraph);
    if (cells.size > 0) {
      const source = room.feature === RoomFeature.STAIR_VOID ? 'stairVoid'
        : isShaftFeature(room.feature) ? 'shaft' : 'void';
      sets.push({ cells, source, feature: room.feature });
    }
  }
  for (const stair of upperGraph.stairs) {
    if (!stairFilter(stair)) continue;
    const beyond = cellsBeyondBreak(stair, upperGraph, riserOf(stair));
    if (beyond.size > 0) sets.push({ cells: beyond, source: 'stairBeyond' });
  }
  return sets;
}

/**
 * 上階スラブの開口をワールド矩形の配列で返す。破れ先の破線を切るクリップ範囲に使う。
 * 矩形の開口は**上階の壁面矩形**（`faceRect`）を返す
 * ——CL位置の粗い矩形を返すと、線が開口より外へ半壁厚ぶん突き抜ける（過去の不良）。
 * 非矩形の開口だけセル矩形群へフォールバックする。
 * 世界座標は全階共通のため、返り値はそのまま下階の描画クリップに使える。
 * @param {object|null} upperGraph 直上の採用フロアの（peek 済み）グラフ。null なら null を返す
 * @param {{riserOf?: (stair:object)=>number|null}} [opts] 上階階段の蹴上（破れ位置の決定に使う）
 * @returns {{x1:number,y1:number,x2:number,y2:number}[]|null}
 *   null＝上階が無い／未解決（呼び出し側はクリップしない）。空配列＝開口を導出できなかった。
 */
export function slabOpeningRects(upperGraph, { riserOf = () => null } = {}) {
  if (!upperGraph) return null;
  return openingParts(upperGraph, riserOf)
    .flatMap(p => (p.face ? [p.face] : cellBoundsList(p.cells, upperGraph)));
}

// 開口1つぶんの {cells, face}。非矩形（1つの矩形で表せない）は face を null にし、
// 呼び出し側がセル矩形へフォールバックする（voidGeometry.js と同じ「矩形のみ」方針）。
function openingParts(upperGraph, riserOf) {
  return openingCellSets(upperGraph, riserOf).map(({ cells }) => {
    const cl = roomBounds(cells, upperGraph);
    if (!Number.isFinite(cl.x1) || !(cl.x2 > cl.x1 && cl.y2 > cl.y1)) return { cells, face: null };
    const inBounds = getCellsInRect(cl.x1, cl.y1, cl.x2, cl.y2, upperGraph);
    if (!inBounds.every(c => cells.has(c.key))) return { cells, face: null };
    return { cells, face: faceRect(cells, upperGraph) ?? cl };
  });
}

const EPS = 1e-6;

// CL値の一致判定の許容差(mm)。WALL_AXIS_CL_EPSと同一規約（軸位置はCL.valueをそのまま読むため
// 通常ほぼ0。丸め・端数対策の余裕）。
const AXIS_MATCH_EPS_MM = WALL_AXIS_CL_EPS;

// gridIndexOf(graph) の分割CL索引（verticals/horizontals）から value（許容差内）に一致する
// 候補すべてを返す（gridCells.js worldToCell の境界CL解決は厳密一致のみのため、こちらは
// floorOpeningEdges専用に許容差付きの候補集めを別途用意する）。
function candidatesNear(list, value, tolMm) {
  return list.filter(cl => Math.abs(cl.value - value) < tolMm);
}

// ピースpieceLo〜pieceHiに対するclの実効重なり長（extent null＝全長扱い＝piece全体を覆うとみなす）。
function overlapLength(cl, pieceLo, pieceHi) {
  const lo = cl.extentLo ?? -Infinity, hi = cl.extentHi ?? Infinity;
  return Math.min(hi, pieceHi) - Math.max(lo, pieceLo);
}

// 区間単位でCL候補を決める優先順位（QA再裁定2026-09-28 P4/P5/P6・F9）:
// (1) value差最小 → (2) 通り芯優先 → (3) 区間との実効重なり長が長い → (4) id昇順。
// axisCL（resolveAxisPieces）・clStart/clEnd（resolveCandidateForRange）の両方で共有する——
// QA裁定2026-09-28 F9「clStart/clEndもaxisCLと同じ優先順位で決める」。
// 同じセル辺を共有する2本の短いCL（P4）でも、重なり長が同点ならid昇順で決定的に1本が勝ち、
// 辺が消えない。
function comparePiecePreference(value, rangeLo, rangeHi) {
  return (a, b) =>
    (Math.abs(a.value - value) - Math.abs(b.value - value))
    || (Number(isGridCenterLine(b)) - Number(isGridCenterLine(a)))
    || (overlapLength(b, rangeLo, rangeHi) - overlapLength(a, rangeLo, rangeHi))
    || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/**
 * 分割CL候補群から、valueに一致し区間[rangeLo,rangeHi]で有効なCLを1つ選ぶ
 * （axisCL・clStart/clEnd共通。優先順位はcomparePiecePreference）。
 * 有効な候補が無ければ null（安全側で捨てる。フォールバックしない——gridCells.js
 * findBoundaryCLの「非アクティブへのフォールバック」規約はfloorOpeningEdgesには適用しない）。
 * @param {Array} list gridIndex.verticals/horizontals
 * @param {number} value
 * @param {number} rangeLo
 * @param {number} rangeHi
 * @param {number} tolMm value一致の許容差(mm)
 * @returns {object|null}
 */
function resolveCandidateForRange(list, value, rangeLo, rangeHi, tolMm) {
  const candidates = candidatesNear(list, value, tolMm);
  // 有効区間フィルタ（QA裁定2026-09-28 F12）: comparePiecePreferenceは①value差を③重なり長より
  // 先に見るため、これが無いと「valueがちょうど一致するが区間[rangeLo,rangeHi]では非アクティブな
  // CL」が「valueが僅かにずれるが区間内で本当にアクティブなCL」より先に勝ってしまう。
  // 前者は現実に起こりうる——gridCells.js findBoundaryCLのフォールバック（L字結合セルの内部
  // 分割位置で、その区間では非アクティブなCLをセル境界の識別子として使う規約）により、セルの
  // 境界（cellBoundsFromKeyのx1/x2/y1/y2）がそのような非アクティブCLのvalueになっている場合が
  // あるため。このフィルタは「重なり長>0の候補が無ければ捨てる」という不変条件違反の安全網
  // ではなく、value一致だけでは区別できない上記の取り違えを防ぐ現役の防御である。
  const active = candidates.filter(cl => isActiveAcrossRange(cl, rangeLo, rangeHi));
  if (active.length === 0) return null;
  return [...active].sort(comparePiecePreference(value, rangeLo, rangeHi))[0];
}

/**
 * 辺（isVertical・座標value・直交区間[lo,hi]）を、**CLのextentではなくresolveEdgeSideが返す
 * touching（辺の内側に接する開口セル）の区間**でピースに分割し、各ピースの代表CL
 * （axisCL候補）を選ぶ（QA再裁定2026-09-28。P4/P5/P6の3件で発覚した不良の修正）。結合は
 * 呼び出し側（mergeAdjacentPieces）が担う——outlineSegmentsは同一直線上で隣接するが重ならない
 * 区間を1本に結合しない仕様のため（既存仕様。gridCells.test.js参照）、セルが分割されている
 * 構成では複数の辺（segs）に分かれて渡ってくる。1回の呼び出し内だけで結合しても、別のsegs
 * 呼び出しに分かれたピース同士は結合できない。
 *
 * 旧実装（CLのextentで線分そのものを分割する方式）には3つの不良があった:
 * - P4: 1つのセル辺を2本の短いCL（有効区間が過不足なく接する）が分担する構成で、
 *   分割点ちょうどに直交CLが無いと clStart/clEnd が解決できず両区間とも丸ごと消える。
 * - P5: 全長CL＋短いCLが同じ位置にある構成で、中央のみ短いCLがid順で勝つと結合されず、
 *   UUID次第で辺の本数・形が変わる非決定的な結果になる。
 * - P6: セルを実際に区切っている短いCL1本だけがある構成で、CLのextentがセルの区間より
 *   わずかに短いと、その差分（残余区間）に有効なCLが無く辺が丸ごと消える（旧実装以前より後退）。
 *
 * セル辺はセル生成時に isActiveAcrossRange（重なり判定）でCLに帰属しているため、ピースを
 * セルの区間そのものにすれば同じ判定で必ず1本以上ヒットする（セルはお互いに重ならないため
 * ピースも重ならない）。CLのextentは「そのピースの代表として最もふさわしいCLはどれか」を
 * 選ぶ優先順位（comparePiecePreference）にのみ使う——ピースの長さ自体を切り詰めない。
 * P4型（2本の短いCLが1つのセル辺を共有）はどちらか1本が実効重なり長→id昇順で決定的に勝つ。
 * @param {Array} axisList gridIndex.verticals/horizontals（辺と同じ向きの分割CL索引）
 * @param {number} value 辺の座標
 * @param {boolean} isVertical
 * @param {{touching: Array<{b:object, sources:string[]}>}} side resolveEdgeSideの返り値
 * @param {number} lo 辺の直交区間の下端
 * @param {number} hi 辺の直交区間の上端
 * @param {number} tolMm value一致の許容差(mm)
 * @returns {Array<{axis:object, lo:number, hi:number, sources:string[]}>} 未結合のピース列
 */
function resolveAxisPieces(axisList, value, isVertical, side, lo, hi, tolMm) {
  const rawPieces = [];
  for (const r of side.touching) {
    const [oLo, oHi] = isVertical ? [r.b.y1, r.b.y2] : [r.b.x1, r.b.x2];
    const pieceLo = Math.max(lo, oLo), pieceHi = Math.min(hi, oHi);
    if (pieceHi - pieceLo > EPS) rawPieces.push({ pieceLo, pieceHi, sources: r.sources, componentId: r.componentId });
  }
  rawPieces.sort((a, b) => a.pieceLo - b.pieceLo);

  const resolved = [];
  for (const p of rawPieces) {
    const axis = resolveCandidateForRange(axisList, value, p.pieceLo, p.pieceHi, tolMm);
    if (!axis) continue; // 区間内で有効な候補が無ければ安全側で捨てる（resolveCandidateForRange参照）
    resolved.push({ axis, lo: p.pieceLo, hi: p.pieceHi, sources: [...p.sources], componentId: p.componentId });
  }
  return resolved;
}

// 同じ(isVertical,coord,outwardSign)グループ内で、lo昇順に隣接し代表CL(axis)・componentIdが
// 同じピースを1本の辺へ結合する（sourcesは和集合）。resolveAxisPiecesはoutlineSegments1本ぶんの
// 範囲でしか結合できないため、複数のoutlineSegmentsにまたがる結合（QA再裁定2026-09-28 P5）は
// ここで行う。componentId一致も要求する（Minor-3是正）——異なる開口（連結成分）のピースが
// たまたま同一直線上で隣接していても別の辺のまま保つ（角だけで接する開口を巻き込まないaxis一致
// だけでは、稀に別成分のピースが座標的に隣接するケースを誤結合しうる安全策）。piecesは呼び出し前に
// lo昇順でソート済みであること。
// 【到達しない防御】同じ直線上・同じ外向き側（outwardSign）で端が接する（last.hiとp.loが一致する）
// 2ピースは、それぞれの由来セルが必ずその接点で直交辺を正の長さ共有する——lo/hiは開口セル自身の
// 区間（resolveAxisPieces）なので、端が一致する2区間の間にはギャップが無く、境界の直交方向
// （resolveEdgeSideのoLo/oHi）も同じ辺を通じて連続しているため、cellsShareBoundaryの判定を必ず
// 満たし同じcomponentIdになる。よってlast.componentId!==p.componentIdでこの分岐に入らない
// （else側へ落ちて辺が分かれる）経路は理論上到達しないが、上記の安全側ガードとして残す。
function mergeAdjacentPieces(pieces) {
  const merged = [];
  for (const p of pieces) {
    const last = merged[merged.length - 1];
    if (last && last.axis === p.axis && last.componentId === p.componentId && Math.abs(last.hi - p.lo) < EPS) {
      last.hi = p.hi;
      for (const s of p.sources) if (!last.sources.includes(s)) last.sources.push(s);
    } else {
      merged.push({ ...p, sources: [...p.sources] });
    }
  }
  return merged;
}

// 2つのセル矩形が正の長さを持つ境界を共有していれば true（4近傍。角だけで接する場合はfalse。
// Minor-3是正・2026-09-28QAレビュー: 端点共有によるconnected component判定は「角だけで接する
// 2開口」を誤って同じ成分にまとめる——セル自体の4近傍で連結成分を決め直す）。
function cellsShareBoundary(a, b) {
  const xEdge = (Math.abs(a.x2 - b.x1) < EPS || Math.abs(a.x1 - b.x2) < EPS)
    && (Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1) > EPS);
  const yEdge = (Math.abs(a.y2 - b.y1) < EPS || Math.abs(a.y1 - b.y2) < EPS)
    && (Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1) > EPS);
  return xEdge || yEdge;
}

// cellRecords（各要素に.key/.bを持つ）へ、4近傍で連結したセル同士が同じ値を持つ`componentId`
// フィールドを書き込む（Union-Find。O(n^2)だが開口セル数は通常小さい）。componentIdは連結成分に
// 属するセルキーの辞書順最小値——呼び出しをまたいで安定させるため配列indexではなくキーを使う。
function assignComponentIds(cellRecords) {
  const n = cellRecords.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; };
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (cellsShareBoundary(cellRecords[i].b, cellRecords[j].b)) union(i, j);
    }
  }
  const rootKeys = new Map();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    const cur = rootKeys.get(root);
    if (cur == null || cellRecords[i].key < cur) rootKeys.set(root, cellRecords[i].key);
  }
  for (let i = 0; i < n; i++) cellRecords[i].componentId = rootKeys.get(find(i));
}

/**
 * 辺の端点(endpointCoord)にあるclStart/clEnd候補の直交区間を、cellRecords全体から探す
 * （QA再裁定2026-09-28 F9）。端点は結合・輪郭のクリップで生じるため、軸ピース自身の接セル
 * （resolveAxisPiecesのtouching）とは限らない——例: L字の切り欠きでは、notch水平辺の端点
 * (x=1000)はtopKey（軸ピースの接セル。x:[0,2000]）の角ではなく、隣のblKey
 * （x:[0,1000],y:[1000,2000]）の角（x2=1000,y1=1000）にあたる。
 * cellRecords全体から「辺のvalueと同じ方向でその値に接し、かつendpointCoordで走行方向の
 * 境界を持つ」セルを探し、そのセルの**候補CL自身が延びる方向**（valueと同じ方向）の区間を返す
 * ——該当が複数あれば外接（和）を返す（isActiveAcrossRangeは重なり判定のため、広い方が安全側）。
 * 該当セルが無ければ null（安全側で捨てる）。
 * @param {Array<{b:object}>} cellRecords
 * @param {boolean} isVertical 元の辺の向き
 * @param {number} value 元の辺の座標
 * @param {number} endpointCoord 辺の端点（走行方向の座標）
 * @returns {[number,number]|null}
 */
function cornerCrossRange(cellRecords, isVertical, value, endpointCoord) {
  let lo = null, hi = null;
  for (const r of cellRecords) {
    const [vLo, vHi] = isVertical ? [r.b.x1, r.b.x2] : [r.b.y1, r.b.y2]; // valueと同じ方向
    const [eLo, eHi] = isVertical ? [r.b.y1, r.b.y2] : [r.b.x1, r.b.x2]; // 走行(端点)方向
    const touchesValue = Math.abs(vLo - value) < EPS || Math.abs(vHi - value) < EPS;
    const touchesEndpoint = Math.abs(eLo - endpointCoord) < EPS || Math.abs(eHi - endpointCoord) < EPS;
    if (!touchesValue || !touchesEndpoint) continue;
    lo = lo == null ? vLo : Math.min(lo, vLo);
    hi = hi == null ? vHi : Math.max(hi, vHi);
  }
  return lo == null ? null : [lo, hi];
}

// 辺（isVertical・座標value・直交区間[lo,hi]）に対して、和集合のセルのうちどちら側
// （lo側=b.x1/b.y1、hi側=b.x2/b.y2）が接しているかを求め、外側法線符号と接しているセル
// レコードを返す。1点サンプリングではなく辺区間全体と重なる接セルで判定する（team-lessons
// 「セル辺の帰属を1点サンプリングで判定して見逃した」参照）。
// 両側に接するセルがある／どちらにも無い場合はnull（outlineSegmentsが共有辺を消しているため
// 本来起きないはずの不変条件違反。安全側でその辺を捨てる）。
function resolveEdgeSide(isVertical, value, lo, hi, cellRecords) {
  const loSide = [], hiSide = [];
  for (const r of cellRecords) {
    const [near, far] = isVertical ? [r.b.x1, r.b.x2] : [r.b.y1, r.b.y2];
    const [oLo, oHi]  = isVertical ? [r.b.y1, r.b.y2] : [r.b.x1, r.b.x2];
    if (!(oLo < hi - EPS && oHi > lo + EPS)) continue; // 辺区間と直交方向で重ならなければ無関係
    if (Math.abs(near - value) < EPS) loSide.push(r);
    if (Math.abs(far  - value) < EPS) hiSide.push(r);
  }
  const hasLo = loSide.length > 0, hasHi = hiSide.length > 0;
  if (hasLo === hasHi) return null; // 両側 or どちらも無し → 不変条件違反として捨てる
  return hasLo ? { outwardSign: -1, touching: loSide } : { outwardSign: 1, touching: hiSide };
}

/**
 * 自階の床開口（吹抜け・昇降路・階段吹抜け・階段の破れ先）を「セル境界CL上の辺」として列挙する
 * （層A・実装指示書ステップ3。純関数）。梁芯生成（ステップ4）が受け梁の位置を求める入力になる。
 *
 * `slabOpeningRects`（upperGraphを渡す＝上階の開口をワールド矩形で返す）とは
 * 異なり、**自階のgraph**を渡す——「自階の床の開口」を求める点に注意。開口セルの情報源は
 * `openingCellSets`（本ファイル内・唯一の情報源）で、複数の開口セット（吹抜け・昇降路・階段吹抜け・
 * 階段の破れ先）は和集合にしてから輪郭（`outlineSegments`）を取る——隣接する開口どうしの共有辺を
 * 消すことで、開口の内部（＝もう1つの開口）に梁芯を立てないため。
 *
 * 各辺の境界CL（axisCL・clStart・clEnd）は `gridIndexOf(graph)` の分割CL索引（`isFinishCellDivider`
 * を満たすCLのみ）から解決し、見つからなければその区間を安全側で落とす（例外にしない）。
 * axisCL は `resolveAxisPieces` が **辺に接する開口セル自身の区間**（CLのextentではない）を
 * ピースにして選ぶ——1本のセル辺を複数のCLが分担する場合でも、セル辺そのものが単位なので
 * 必ずどこかのCLが選ばれる（QA再裁定2026-09-28。CLのextentで線分を分割する旧方式は、分割点に
 * 有効なCLが無い残余区間が生じて辺が丸ごと消える不良があった）。候補が複数のときの優先順位は
 * `comparePiecePreference`（value差最小→通り芯優先→ピースとの実効重なり長→id昇順。通り芯上の
 * 辺は大梁の領分なので、通り芯があれば `onGrid:true` が安全側。QA裁定2026-09-28 F2）。
 * `landingEdgeCLs`（stairLanding.js）と同じフィールド名規約（axisCL/clStart/clEndはCL id）。
 *
 * @param {object|null} graph 自階（対象の平面）のグラフ
 * @param {{riserOf?: (stair:object)=>number|null, stairFilter?: (stair:object)=>boolean}} [opts]
 *   riserOf=自階の階段の蹴上（破れ位置の決定に使う）。stairFilter=自階の階段（graph.stairs）を
 *   破れ先セット列挙前に絞る述語（既定=常にtrue＝挙動不変。openingCellSetsのコメント参照。
 *   呼び出し側=openingBeamAxes.js openingBeamSourcesForが「下階に到達元の階段があるか」で絞る）。
 * @returns {Array<{isVertical:boolean, axisCL:string, clStart:string, clEnd:string, coord:number,
 *   lo:number, hi:number, outwardSign:1|-1, onGrid:boolean, source:string, sources:string[],
 *   componentId:string}>}
 *   並びは isVertical→coord→lo 昇順（決定的）。componentId＝開口セルの4近傍連結成分（Minor-3。
 *   角だけで接する開口は別のcomponentIdになる。openingBeamAxes.js groupByConnectivityが使う）。
 */
export function floorOpeningEdges(graph, { riserOf = () => null, stairFilter = () => true } = {}) {
  if (!graph) return [];
  const sets = openingCellSets(graph, riserOf, stairFilter);
  if (sets.length === 0) return [];

  // セルキー→sources（初出順）。複数セットに同じキーが現れても bounds は Map で自然に重複しない。
  const sourcesByKey = new Map();
  for (const { cells, source } of sets) {
    for (const key of cells) {
      if (!sourcesByKey.has(key)) sourcesByKey.set(key, []);
      const arr = sourcesByKey.get(key);
      if (!arr.includes(source)) arr.push(source);
    }
  }

  const cellRecords = [];
  for (const [key, sources] of sourcesByKey) {
    const b = cellBoundsFromKey(key, graph); // 削除済みCLを指すキーはnull→安全側で除外
    if (b) cellRecords.push({ key, b, sources });
  }
  if (cellRecords.length === 0) return [];
  // 4近傍の連結成分（Minor-3是正）。openingBeamAxes.js groupByConnectivityが端点共有ではなく
  // これで開口をグルーピングする——角だけで接する2開口を誤って同じ成分にしないため。
  assignComponentIds(cellRecords);

  const segs = outlineSegments(cellRecords.map(r => r.b));
  const gridIndex = gridIndexOf(graph);

  // 全outlineSegmentsぶんの未結合ピースを(isVertical,coord,outwardSign)でグルーピングしてから
  // 結合する（QA再裁定2026-09-28 P5——outlineSegments自体が同一直線上の隣接区間を1本に
  // まとめない仕様のため、セルが分割されている構成では複数segsに分かれて渡ってくる）。
  const groups = new Map();
  for (const { isVertical, value, lo, hi } of segs) {
    const side = resolveEdgeSide(isVertical, value, lo, hi, cellRecords);
    if (!side) continue;
    const axisList = isVertical ? gridIndex.verticals : gridIndex.horizontals;
    const groupKey = `${isVertical}:${value}:${side.outwardSign}`;
    if (!groups.has(groupKey)) groups.set(groupKey, { isVertical, value, outwardSign: side.outwardSign, pieces: [] });
    groups.get(groupKey).pieces.push(...resolveAxisPieces(axisList, value, isVertical, side, lo, hi, AXIS_MATCH_EPS_MM));
  }

  const out = [];
  for (const { isVertical, value, outwardSign, pieces } of groups.values()) {
    pieces.sort((a, b) => a.lo - b.lo);
    const orthoList = isVertical ? gridIndex.horizontals : gridIndex.verticals;
    for (const { axis, lo: a, hi: b, sources, componentId } of mergeAdjacentPieces(pieces)) {
      const startCross = cornerCrossRange(cellRecords, isVertical, value, a);
      const endCross = cornerCrossRange(cellRecords, isVertical, value, b);
      const start = startCross && resolveCandidateForRange(orthoList, a, startCross[0], startCross[1], AXIS_MATCH_EPS_MM);
      const end = endCross && resolveCandidateForRange(orthoList, b, endCross[0], endCross[1], AXIS_MATCH_EPS_MM);
      if (!start || !end) continue; // 端点に角を持つセルが無い、または有効な直交CLが無ければ安全側で捨てる
      if (sources.length === 0) continue; // 安全側（到達しないはず）

      out.push({
        isVertical, axisCL: axis.id, clStart: start.id, clEnd: end.id,
        coord: value, lo: a, hi: b, outwardSign, onGrid: isGridCenterLine(axis),
        source: sources[0], sources, componentId,
      });
    }
  }
  out.sort((a, b) => (Number(a.isVertical) - Number(b.isVertical)) || (a.coord - b.coord) || (a.lo - b.lo));
  return out;
}
