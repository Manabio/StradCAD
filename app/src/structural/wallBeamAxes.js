// 壁（仕上げモードの下地オーナー壁）から梁芯CL（discipline:'fuse'）を自動生成する。
// 生成された梁芯CLは既存の autoFillSecondaryBeams がそのまま拾う（梁芯の出自を見ない実装のため、
// 小梁の生成・端部トリム・除外集合・採番はすべて既存経路）。設計意図は .claude/structural-model.md 参照。
import { CenterLineType, Discipline } from '../core.js';
import { CL_OVERLAP_TOL_MM } from '../core/constants.js';
import { structuralAnchorAt, beamAxisAt } from '../core/centerLineKindPolicy.js';
import { backingClassOf } from '../finish/materials/backingClass.js';
import { roomBounds } from '../finish/gridCells.js';
import { peekVia } from './structuralPeek.js';
import { rulesFor, backingRulesFor, isTraditionalWoodStructure, effectiveStructure } from './structureRules.js';

// 通り芯の座標一致判定の許容誤差(mm)。secondaryBeamSpansFor の SPAN_EPS と同じ考え方。
const BRACKET_EPS_MM = 0.5;

// 在来木造か（2×4は含まない）。実体は structureRules.js（主構造ごとのルールセット）。
// 既存の import 経路（wallBeamAxes.test.js 等）を保つため再exportする。
export { isTraditionalWoodStructure };

/** plane の「1つ下の実体階」を返す（project.planes、elevation昇順・採用フロアのみ）。
 *  最下階・屋根専用平面（project.planesに含まれない）・該当なしは null。 */
function belowPlaneOf(plane, project) {
  const planes = project.planes;
  const idx = planes.findIndex(p => p.id === plane.id);
  if (idx <= 0) return null;
  return planes[idx - 1];
}

/** plane の「1つ上の実体階」を返す（project.planes、elevation昇順・採用フロアのみ）。
 *  最上階・屋根専用平面（project.planesに含まれない）・該当なしは null。
 *  在来木造の上階柱直下の柱（ステップ3b）が使う——belowPlaneOfと対称の私的ヘルパ。 */
function abovePlaneOf(plane, project) {
  const planes = project.planes;
  const idx = planes.findIndex(p => p.id === plane.id);
  if (idx < 0 || idx + 1 >= planes.length) return null;
  return planes[idx + 1];
}

/**
 * plane の「1つ下の実体階」のgraphをpeekする（belowPlaneOf＋floorSwapManager.peek）。無ければnull。
 * collectWallBeamSources（selfAndBelow時の自前peek）と structuralRecompute.js（木造梁成の下階柱取得。
 * ステップ3d）が同じpeekを共有する——別々にpeekすると1回の再計算で下階を2回読みに行くため。
 * @param {object} graph
 * @param {object} project
 * @param {ReturnType<typeof import('./structuralResolveContext.js').createStructuralResolveContext>} [ctx] -
 *   解決コンテキスト（省略時はfloorSwapManager.peek直呼び・従来どおり。生成元は
 *   structuralOrchestration.js の境界処理——本関数は受け取って使うだけ）。
 * @returns {Promise<object|null>}
 */
export async function peekBelowGraph(graph, project, ctx = undefined) {
  const belowPlane = belowPlaneOf(graph.plane, project);
  if (!belowPlane) return null;
  return await peekVia(ctx, belowPlane, project.structGraph);
}

/**
 * plane の「1つ上の実体階」のgraphをpeekする（abovePlaneOf＋floorSwapManager.peek）。無ければnull。
 * 在来木造の上階柱直下の柱（ステップ3b。woodAutoFill.js autoFillWoodColumns）が候補列挙に使う——
 * 上階graphからは columns の x/y/role しか読まない（.claude/figure.md 規律。他階実体の座標だけを
 * 自階へ還元して使う）。structuralRecompute.js が主構造ルール（columnPlacement:'wallIntersections'。
 * 在来木造のみ）のときだけ呼ぶ（非在来はpeekしない）。
 * @param {object} graph
 * @param {object} project
 * @param {ReturnType<typeof import('./structuralResolveContext.js').createStructuralResolveContext>} [ctx] - peekBelowGraphと同じ（省略可）。
 * @returns {Promise<object|null>}
 */
export async function peekAboveGraph(graph, project, ctx = undefined) {
  const abovePlane = abovePlaneOf(graph.plane, project);
  if (!abovePlane) return null;
  return await peekVia(ctx, abovePlane, project.structGraph);
}

/**
 * 屋根専用平面（isRoofPlane）の「1つ下の実体階」＝roofForPlaneId が指す最上階のgraphをpeekする。
 * belowPlaneOf（project.planes基準）は屋根専用平面がproject.planesに含まれないため常にnullを返す
 * （小屋伏図にも梁・柱ルールを適用する計画のステップ4。ユーザー定義「在来木造の構造モードで言う
 * 『最上階』とは、最上階にある『小屋伏図』を差す」の起点＝屋根の「自階」を最上階に置き換える経路）。
 * graphが屋根専用平面でなければ（isRoofPlane!==true）null——通常階は peekBelowGraph を使うこと。
 * roofForPlaneId が指す実体階が採用フロア一覧（project.planes）に見つからない場合もnull（防御）。
 * @param {object} roofGraph
 * @param {object} project
 * @param {ReturnType<typeof import('./structuralResolveContext.js').createStructuralResolveContext>} [ctx] - peekBelowGraphと同じ（省略可）。
 * @returns {Promise<object|null>}
 */
export async function peekRoofBelowGraph(roofGraph, project, ctx = undefined) {
  if (!roofGraph.plane?.isRoofPlane) return null;
  const topPlane = project.planes.find(p => p.id === roofGraph.plane.roofForPlaneId);
  if (!topPlane) return null;
  return await peekVia(ctx, topPlane, project.structGraph);
}

/**
 * graph が「屋根専用平面の直下の実体階」（project.roofPlane.roofForPlaneId === graph.plane.id）のときだけ、
 * その屋根専用平面のgraphをpeekする（peekRoofBelowGraphと対称）。屋根が無い・graphが最上階でない場合はnull。
 * 呼び出し側がルールでゲートする（非在来はこの関数自体を呼ばない設計。structuralRecompute.js参照）——
 * 解決子の中ではゲートしない（アーキ裁定・ステップ4）。
 * @param {object} graph
 * @param {object} project
 * @param {ReturnType<typeof import('./structuralResolveContext.js').createStructuralResolveContext>} [ctx] - peekBelowGraphと同じ（省略可）。
 * @returns {Promise<object|null>}
 */
export async function peekRoofGraphAbove(graph, project, ctx = undefined) {
  const roofPlane = project.roofPlane;
  if (!roofPlane || roofPlane.roofForPlaneId !== graph.plane.id) return null;
  return await peekVia(ctx, roofPlane, project.structGraph);
}

/** wall が下地オーナー壁か（backingRange!=null。backingDepth===0の仕上げのみの薄壁は対象外）。 */
function isBackingOwnerWall(wall) {
  return wall.backingRange != null;
}

/** 下地オーナー壁の下地帯中心の座標(mm)＝梁芯位置（wall.axisValueは仕上げ面の位置のため使わない）。
 *  柱寸法が基準より細い階の外壁下地帯シフト（wall.bandOffset。core/wall.js参照）を差し引いて
 *  相殺する——wallBeamSourcesFromGraph・wallBackingCenters・建具の袖柱の法線方向アンカー解決
 *  （woodAutoFill.js autoFillWoodColumns）が同じ位置の定義を共有する単一の情報源。
 *  wall.backingRange===null（下地オーナーでない）の呼び出しは想定しない（呼び出し側が
 *  isBackingOwnerWallで絞り込み済みのこと）。 */
export function wallBackingCenterCoord(wall) {
  const center = (wall.backingRange.lo + wall.backingRange.hi) / 2;
  return center - (wall.bandOffset ?? 0);
}

/** per-floor 設定から wall の下地材コードを引く（Edge個別上書きは対象外。設計書 §2.1 の割り切り）。 */
function wallBackingCode(sourceGraph, wall) {
  return wall.isExteriorWall ? sourceGraph.exteriorWallBacking : sourceGraph.interiorWallBacking;
}

/**
 * wallBeamSourcesFromGraph の結果を「graph インスタンス×requireBeamAxisBacking」でmemoする
 * キャッシュを作る（ステップC・構造再計算の高速化）。同じ graph の壁区間はこのキャッシュの生存期間中
 * 不変（構造再計算は壁を生成・変更しない。structuralRecompute.js冒頭のコメント参照）——にもかかわらず、
 * collectWallBeamSources・wallRunSegments・selfWallSegments経由で同じ graph が1回の再計算中に何度も
 * 全走査されていた（wallGate.js等と違い、この壁区間の解決だけが唯一横断的にキャッシュされていなかった）。
 *
 * **モジュール変数・graphへの恒久WeakMapにしない**——壁は仕上げモード脱出等、この再計算の外側で
 * 変わりうる（graphに紐づく長寿命キャッシュは古い壁区間を返す事故になる）。呼び出し側
 * （structuralRecompute.js・structuralOrchestration.js）が明示的な寿命でこのキャッシュを生成し、
 * 消費側の関数チェーンへ明示的に引数で渡す——省略時（undefined）は一切memoせず、呼び出しのたびに
 * 毎回全走査する（既存の挙動と完全に同じ）。寿命は2通り: (a) options.wallSourceCacheを省略した
 * recomputeStructuralForGraph単体呼び出しでは「1回のその呼び出しの間」（従来どおり）。
 * (b) 解決コンテキスト（structuralResolveContext.js）があるときは「1回の反映処理の間」、同じ
 * graph インスタンスに対して複数回のrecomputeStructuralForGraph呼び出しをまたいで使い回す
 * （ステップB-6）——保持が世代不一致で捨てられて読み直されると別インスタンスになるので、
 * cache（graphインスタンスをキーにしている）も自然に外れる。
 *
 * @returns {{get(graph:object, flag:boolean):Array|undefined, set(graph:object, flag:boolean, value:Array):void}}
 */
export function createWallSourceCache() {
  const byGraph = new Map(); // graph -> Map<requireBeamAxisBacking, 生成済み配列>
  return {
    get(graph, flag) {
      return byGraph.get(graph)?.get(flag);
    },
    set(graph, flag, value) {
      let byFlag = byGraph.get(graph);
      if (!byFlag) { byFlag = new Map(); byGraph.set(graph, byFlag); }
      byFlag.set(flag, value);
    },
  };
}

/** sourceGraph の下地オーナー壁から wallSources 断片（プレーン配列）を抽出する。
 *  requireBeamAxisBacking=true なら、per-floor 下地材コードの下地材分類が「梁芯の生成源」
 *  （structureRules.js BACKING_RULES.beamAxisSource＝RC壁下地）の壁だけに絞る（条件(a)）。
 *  false なら下地材の種別は問わない（条件(b)(c)）。
 *  返り値は CL 参照を持たないプレーン配列 [{isVertical, coord, lo, hi, designLo, designHi, halfDepth}]
 *  （世界座標mm）——他階実体を主題階へ持ち込まない（.claude/figure.md 規律）ため、下階peek分もここで
 *  座標へ還元する。halfDepth＝下地帯の半幅（coord±halfDepthが下地帯）。在来木造の上階柱直下の柱
 *  （ステップ3b）が「壁の下地帯の内側」判定に使う（他の消費先はこのフィールドを見ない＝加算のみで
 *  挙動不変）。designLo/designHi＝設計上の端（壁のclStart/clEnd.effectiveValueをMath.min/maxで
 *  揃えたもの。物理lo/hiの昇降とは独立——取り合いの控え・自由端の柱包み分のprotrusionを含まない）。
 *  woodFraming.js wallRunFreeEnds が
 *  自由端の点にこちらを使う（F-1×F-3是正）。
 *  cache（createWallSourceCache）指定時は「sourceGraph×requireBeamAxisBacking」でmemoする——
 *  cache指定時は、ヒット時も新規計算時も、返り値は必ず要素を複製した新しい配列（呼び出し側が
 *  lo/hi等を書き換えてもmemo本体は汚れない。他の消費側の書き換え有無はwallBeamAxes.jsのJSDoc・
 *  呼び出し元の調査済み——現状は読み取りのみ）。省略時は従来どおり毎回全走査し、走査結果を
 *  そのまま返す（どこにも保持しないため複製は不要）。 */
function wallBeamSourcesFromGraph(sourceGraph, requireBeamAxisBacking, cache = undefined) {
  const cached = cache?.get(sourceGraph, requireBeamAxisBacking);
  if (cached) return cached.map(s => ({ ...s }));
  const out = [];
  for (const wall of sourceGraph.walls) {
    if (!isBackingOwnerWall(wall)) continue;
    if (requireBeamAxisBacking && !backingRulesFor(backingClassOf(wallBackingCode(sourceGraph, wall))).beamAxisSource) continue;
    // 梁芯位置＝下地帯の中心（wall.axisValueは仕上げ面の位置のため使わない。設計書§2.3(2)）。
    // 柱寸法が基準より細い階の外壁下地帯シフト（structural/structureRules.js
    // woodBaseColumnWidthMm 参照。finish/wallGeneration.js generateExteriorWalls/
    // generateRoomWallsFromOutline）は、外壁の外面を通り芯±60に固定するための「見た目の」帯
    // 移動であり、梁芯CL・壁交点柱のアンカー（通り芯位置基準）まで動かしてはいけない——
    // wall.bandOffset（帯シフト量だけを保持する専用フィールド。core/wall.js Wall.bandOffset
    // 参照）を差し引いて相殺する（wallBackingCenterCoord）。isExteriorWallでは判定しない——外周辺に
    // 接する「室生成壁」（generateRoomWallsFromOutlineがbandShiftを適用した非外壁）も同じ扱いに
    // する必要がある（QA F1: isExteriorWall限定だと外周辺由来の室生成壁が非covered区間で下地オーナー
    // になったときに通り芯脇へ梁芯・柱が湧く）。bandOffsetを持たない壁（2a壁のCL偏芯等、本来の偏芯）は
    // bandOffset===nullのため0になり、backingOffsetがcoordへそのまま反映される従来どおりの挙動。
    // 設計上の端座標（F-1×F-3是正・2026-09-19裁定）: 壁は「CL＋オフセット」系アンカーで、
    // 区間の端はCL（clStart/clEnd）で定義される——coord1/coord2の物理値はCLのeffectiveValueに
    // startOffset/endOffset（取り合いの控え・自由端の柱包み分のprotrusion等）を足したもの
    // （core/wall.js）。designLo/designHiはこのoffsetを差し引いた「設計上の端」——**物理lo/hiの
    // 昇降とは独立にMath.min/maxで決める**（QA是正: 極端に短い壁でoffsetがCL間距離に対し
    // 相対的に大きいと、coord1<=coord2の向きとdesignStart<=designEndの向きが食い違って反転
    // しうるため、物理側の向きへ引きずられない）。
    const designStart = wall.clStart.effectiveValue, designEnd = wall.clEnd.effectiveValue;
    out.push({
      isVertical: wall.isVertical,
      coord: wallBackingCenterCoord(wall),
      lo: Math.min(wall.coord1, wall.coord2),
      hi: Math.max(wall.coord1, wall.coord2),
      designLo: Math.min(designStart, designEnd),
      designHi: Math.max(designStart, designEnd),
      halfDepth: (wall.backingRange.hi - wall.backingRange.lo) / 2,
      // ステップ2（柱の壁内偏心。別タスク）が「壁の下地帯の内側」を判定する際に使う——ここでは
      // 加算のみで既存の消費先（梁芯生成・小梁生成）の挙動は変えない。
      bandOffset: wall.bandOffset ?? 0,
    });
  }
  if (!cache) return out;
  cache.set(sourceGraph, requireBeamAxisBacking, out);
  return out.map(s => ({ ...s }));
}

/** 自階の下地オーナー壁の区間（プレーン配列 [{isVertical, coord, lo, hi, halfDepth, bandOffset}]。
 *  下地材の種別は問わず、下階は含まない）。在来木造の壁交点柱・上階柱直下の柱（woodAutoFill.js）が
 *  候補列挙に使う。
 *  @param {object} graph
 *  @param {ReturnType<typeof createWallSourceCache>} [cache] - 省略時は毎回全走査（従来どおり）。 */
export function selfWallSegments(graph, cache = undefined) {
  return wallBeamSourcesFromGraph(graph, false, cache);
}

// ================================================================
// 壁由来梁芯の追従（壁再生成をFinishModeStateから独立させる計画のステップ2）。
//
// 下地帯の中心が壁再生成で動いたとき（下地材コード変更で壁厚が変わる等）、旧座標に残る
// 壁由来の梁芯CL（discipline:fuse）を撤去せず追従させる——CL id が変わらないため、
// それにアンカーされた壁交点柱・除外集合が生きたまま新しい位置に移る。
// 対応先の壁が無くなった孤児梁芯は撤去しない（2026-09-15裁定。現状に撤去規律が無く、
// 自動/手動の出自フラグも無いため）。
// **例外（ユーザー承認済み・2026-09-25）**: 一般の孤児梁芯撤去規律は作らないが、
// transform/centerLineOps.js の明示的な中心線削除に限り、その削除自体で壁ソースが消えた
// （＝出自を「同じ操作の中で確認できた」）梁芯だけを同じundoエントリで道連れにする
// （orphanedWallBeamAxes参照）。壁再生成（追従。上記）や他の操作からは呼ばれない——
// 「壁を消したのが誰か」を確実に握れる呼び出し元だけの特例。
// ================================================================

/**
 * graph の下地オーナー壁から、下地帯中心の位置を CL 単位で控える（wallBeamSourcesFromGraph と
 * 同じ走査に axisCLId・side を足したもの）。壁再生成の直前・直後にそれぞれ呼び、
 * mapBackingCenterMoves で旧↔新を突き合わせる。
 * @param {object} graph
 * @returns {Array<{axisCLId:string, isVertical:boolean, side:number, coord:number, lo:number, hi:number}>}
 */
export function wallBackingCenters(graph) {
  const out = [];
  for (const wall of graph.walls) {
    if (!isBackingOwnerWall(wall)) continue;
    // wallBeamSourcesFromGraph と同じ理由（柱寸法シフトの見た目の帯移動を追従対象に持ち込まない。
    // 上記コメント参照）でwall.bandOffsetを差し引く（isExteriorWallでは判定しない。QA F1。
    // wallBackingCenterCoordに集約——単一の情報源）。
    out.push({
      axisCLId: wall.axisCL.id,
      isVertical: wall.isVertical,
      // side は wall.faceDirOr(0)（core/wall.js）を使う——Math.sign(axisOffset) だけだと
      // CL偏芯の仕上げ面合わせ（axisOffset===0だがfinishSideが明示されている）で0に潰れ、
      // 本来+/-で区別すべき2枚の壁が同じsideに丸められてしまう（QA S3）。偏芯なし（対称壁。
      // finishSide・axisOffsetともnull/0）は引き続き0。
      side: wall.faceDirOr(0),
      coord: wallBackingCenterCoord(wall),
      lo: Math.min(wall.coord1, wall.coord2),
      hi: Math.max(wall.coord1, wall.coord2),
    });
  }
  return out;
}

/**
 * wallBackingCenters の旧・新スナップショットから、下地帯中心が動いた箇所を対応づける。
 * 壁は再生成のたびに id が総入れ替えになるため、壁idでは対応づけられない——
 * (axisCLId, isVertical, side) が一致し、かつスパン [lo,hi] の重なり長
 * `min(a.hi,b.hi) - max(a.lo,b.lo)` が最大（かつ正）のものを旧↔新1:1で対応づける
 * （座標許容差で寄せる方式は採らない：偶然近い別の壁と誤対応する事故を避ける。QA S2:
 * 配列の走査順に依存する早期一致だと部屋境界で2本に割れた同軸同sideの壁を取り違える。
 * 重なり長0（端点が接するだけ）は「重なり」とみなさない——隣接する無関係の壁を拾わないため）。
 * 旧にあって新に対応が無い壁（下地オーナーでなくなった・部屋ごと消えた等）は無視する
 * （孤児梁芯を撤去しない裁定と対称——ここで無視されたエントリは追従の対象にならないだけで、
 * 既存の梁芯には一切触れない）。1件の旧エントリが複数の新エントリと重なりうる場合（分割）でも、
 * 最も重なりが大きい1件だけを対応づける（moveは旧エントリ1件につき最大1件）。
 * 重なり長が同点の候補が複数あるときは、`lo` が b.lo に最も近いものを採る決定的タイブレーク
 * （QA T2。同点のままだと after の走査順に対応づけが依存してしまう）。
 * @param {ReturnType<typeof wallBackingCenters>} before
 * @param {ReturnType<typeof wallBackingCenters>} after
 * @returns {Array<{axisCLId:string, isVertical:boolean, from:number, to:number}>}
 */
export function mapBackingCenterMoves(before, after) {
  const usedAfter = new Set();
  const moves = [];
  for (const b of before) {
    let bestIdx = -1, bestOverlap = 0, bestLoDist = Infinity;
    for (let i = 0; i < after.length; i++) {
      if (usedAfter.has(i)) continue;
      const a = after[i];
      if (a.axisCLId !== b.axisCLId || a.isVertical !== b.isVertical || a.side !== b.side) continue;
      const overlap = Math.min(a.hi, b.hi) - Math.max(a.lo, b.lo);
      if (overlap <= 0) continue;
      const loDist = Math.abs(a.lo - b.lo);
      if (overlap > bestOverlap || (overlap === bestOverlap && loDist < bestLoDist)) {
        bestOverlap = overlap; bestIdx = i; bestLoDist = loDist;
      }
    }
    if (bestIdx === -1) continue; // 対応する新側が無い（孤児）— 追従の対象にしない
    usedAfter.add(bestIdx);
    const a = after[bestIdx];
    if (a.coord !== b.coord) moves.push({ axisCLId: b.axisCLId, isVertical: b.isVertical, from: b.coord, to: a.coord });
  }
  return moves;
}

/**
 * coord に一致（CL_OVERLAP_TOL_MM以内）する壁由来の梁芯（discipline:fuse。centerLineKind(cl)==='beam'）
 * を返す。通り芯（labeled）は対象にしない——findBeamAnchorCL（壁交点柱のアンカー解決・重複ガード）は
 * 通り芯にも一致するが、ここで通り芯まで対象にすると追従処理が通り芯を動かす事故になるため、
 * 意図的に findBeamAnchorCL を使わず別の述語にする。
 * @param {object} graph
 * @param {boolean} isVertical
 * @param {number} coord
 * @returns {import('../core.js').CenterLine | null}
 */
/** graph.excludedWallBeamAxes のキー形式（座標ベース `${'X'|'Y'}:${Math.round(coord)}`）。
 *  autoFillWallBeamAxes（除外判定）と wallBeamAxisFollow.js（追従時の張り替え）が共有する
 *  単一の書式——片方だけ変えるとキーがすれ違い、消したはずの梁芯が復活する事故になる。 */
export function wallBeamAxisExcludeKey(isVertical, coord) {
  return `${isVertical ? 'X' : 'Y'}:${Math.round(coord)}`;
}

export function findWallBeamAxisCL(graph, isVertical, coord) {
  const centerLineType = isVertical ? CenterLineType.VERTICAL : CenterLineType.HORIZONTAL;
  return beamAxisAt(graph, { centerLineType, coord });
}

/**
 * 明示的な中心線削除に限る例外（上記コメント参照）: sourcesBefore にはあった壁ソースが
 * sourcesAfter で無くなった（同方向・座標差がCL_OVERLAP_TOL_MM以上で「対応する後継が無い」）
 * 座標について、その位置の壁由来梁芯CL（discipline:fuse）を求め、次のいずれにも該当しない
 * ものだけを「撤去してよい」候補として返す（重複を除く）。
 *   - `cl.refId` が非null（絶対座標の自動生成梁芯はrefIdを持たない——手動追加の可能性がある線は
 *     道連れにしない。autoFillWallBeamAxesの生成規約と対）
 *   - この梁芯を参照する柱・梁・基礎（verticalCL/horizontalCL・axisCL/clStart/clEndが一致）の
 *     いずれかが`dimensionStatus !== 'auto'`（手動固定・算出済み）——ロックされた部材を道連れに
 *     削除しない
 *   - この梁芯に乗るユーザー作成データ: 耐力壁（`graph.structuralWalls`。構造モードで手動配置され
 *     自動生成の出自を持たないため`dimensionStatus`を見ず存在だけで保護）・梁ホストのスリーブ
 *     （`graph.sleeves`。`hostType==='beam'`かつ`hostAxisCL`/`hostClStart`/`hostClEnd`が一致——
 *     梁自体が`dimensionStatus:'auto'`でも、ユーザーが個別配置したスリーブが乗っていれば保護）・
 *     `graph.columnAxisOffsets`／`graph.clEccentricities`のキー（柱芯オフセット・CL偏芯の個別設定。
 *     どちらもCL単位のMapで、CL削除時に無条件でdeleteされる——設定があるのに道連れにすると
 *     ユーザー設定を黙って失う）
 *   - `graph.isReferencedByOtherCL`（他CLの`extentLoRef`/`extentHiRef`/`refId`がこの梁芯を指す）
 * 呼び出し側（transform/centerLineOps.js）が削除の前後で本関数へ渡す sourcesBefore/sourcesAfter は
 * 同じ`wallBeamSourcesFor`の戻り値（プレーン配列）であること——CL参照を含まないため、この関数自身が
 * `findWallBeamAxisCL`で改めてCLへ解決する。
 * @param {object} graph
 * @param {Array<{isVertical:boolean, coord:number}>} sourcesBefore
 * @param {Array<{isVertical:boolean, coord:number}>} sourcesAfter
 * @returns {import('../core.js').CenterLine[]} 撤去してよい梁芯CLの配列（重複なし）
 */
export function orphanedWallBeamAxes(graph, sourcesBefore, sourcesAfter) {
  const stillPresent = (src) => sourcesAfter.some(a =>
    a.isVertical === src.isVertical && Math.abs(a.coord - src.coord) < CL_OVERLAP_TOL_MM);
  const missing = sourcesBefore.filter(src => !stillPresent(src));

  const result = [];
  const seen = new Set();
  for (const src of missing) {
    const cl = findWallBeamAxisCL(graph, src.isVertical, src.coord);
    if (!cl || seen.has(cl.id)) continue;
    seen.add(cl.id);
    if (cl.refId != null) continue;
    const hasProtectedUserData =
      graph.columns.some(c => (c.verticalCL.id === cl.id || c.horizontalCL.id === cl.id) && c.dimensionStatus !== 'auto') ||
      graph.beams.some(b => (b.axisCL.id === cl.id || b.clStart.id === cl.id || b.clEnd.id === cl.id) && b.dimensionStatus !== 'auto') ||
      graph.footings.some(f => (f.verticalCL.id === cl.id || f.horizontalCL.id === cl.id) && f.dimensionStatus !== 'auto') ||
      graph.structuralWalls.some(w => w.axisCL.id === cl.id || w.clStart.id === cl.id || w.clEnd.id === cl.id) ||
      graph.sleeves.some(s => s.hostType === 'beam' &&
        (s.hostAxisCL?.id === cl.id || s.hostClStart?.id === cl.id || s.hostClEnd?.id === cl.id)) ||
      graph.columnAxisOffsets.has(cl.id) ||
      graph.clEccentricities.has(cl.id);
    if (hasProtectedUserData) continue;
    if (graph.isReferencedByOtherCL(cl.id)) continue;
    result.push(cl);
  }
  return result;
}

/** coord に一致（CL_OVERLAP_TOL_MM以内）する通り芯または梁芯（柱アンカー第1候補。
 *  core/centerLineKindPolicy.js structuralAnchorAt(tier:'primary')）を返す。意匠中心線・補助線は
 *  対象にしない。梁芯の重複ガード（autoFillWallBeamAxes）と壁交点柱のアンカー解決（woodAutoFill.js）が
 *  共有する単一の述語——片方だけ条件を変えると柱が湧く／消えるため。無ければ null。 */
export function findBeamAnchorCL(graph, centerLineType, coord) {
  return structuralAnchorAt(graph, { centerLineType, coord, tier: 'primary' });
}

/** 同一方向・近接座標（CL_OVERLAP_TOL_MM以内）のソースを1本にまとめ、extentは和集合（min/max）にする。
 *  同一生成バッチ内で複数の壁が同じ位置に梁芯を要求するケース（対向壁等）の重複生成を防ぐ。 */
function mergeWallBeamSources(sources) {
  const merged = [];
  for (const src of sources) {
    const existing = merged.find(m =>
      m.isVertical === src.isVertical && Math.abs(m.coord - src.coord) < CL_OVERLAP_TOL_MM);
    if (existing) {
      existing.lo = Math.min(existing.lo, src.lo);
      existing.hi = Math.max(existing.hi, src.hi);
    } else {
      merged.push({ ...src });
    }
  }
  return merged;
}

/**
 * graph（自階）から、壁由来の梁芯生成対象（プレーン配列）を収集する（同期部分。collectWallBeamSources
 * から下階peekを除いたもの——belowGraphは呼び出し側が解決済みで渡すこと。undefinedはpeekしていない
 * 意味にはならず「下階なし」として扱われる点がcollectWallBeamSourcesの`belowGraph`引数と異なる
 * （こちらは同期関数のためpeekできない。呼び出し側が事前にpeekBelowGraph等で解決するか、
 * 明示的にnullを渡すこと）。
 * 生成条件（設計書 §2.2、主構造は自階の実効値）:
 *   (a) RC造（'RC造(ラーメン)'|'RC造(壁式)'）        → 自階の下地オーナー壁のうち下地材がRC下地のもの
 *   (b) 木造（在来）                                  → 自階の下地オーナー壁（下地材の種別は問わない）
 *   (c) 木造（在来）                                  → 1つ下の実体階の下地オーナー壁（同上）
 * RC造は自階のみ（上下階で壁が連続し自立するため下階壁の頭に梁は不要という設計判断）。
 * transform/centerLineOps.js の中心線削除（明示的な削除に限る壁由来梁芯の道連れ判定。2026-09-25）が
 * 削除前後の壁ソースを比較するために同期で呼べる版として抽出した（挙動不変）。
 * @param {object} graph
 * @param {object} project
 * @param {object|null} belowGraph - 1つ下の実体階のgraph（無ければnull）。
 * @param {ReturnType<typeof createWallSourceCache>} [cache] - 省略時は毎回全走査（従来どおり）。
 * @returns {Array<{isVertical:boolean, coord:number, lo:number, hi:number}>}
 */
export function wallBeamSourcesFor(graph, project, belowGraph, cache = undefined) {
  const structure = effectiveStructure(graph, project);
  // 生成源の選択は主構造ルール（structureRules.js wallBeamAxes: 'rcBacking' | 'selfAndBelow' | null）。
  const mode = rulesFor(structure).wallBeamAxes;
  let sources = [];
  if (mode === 'rcBacking') {
    sources = wallBeamSourcesFromGraph(graph, true, cache);
  } else if (mode === 'selfAndBelow') {
    sources = wallRunSegments(graph, belowGraph, structure, cache);
  }
  return mergeWallBeamSources(sources);
}

/**
 * graph（自階）から、壁由来の梁芯生成対象（プレーン配列）を収集する（async・下階peekを含む）。
 * 同期部分は wallBeamSourcesFor に委譲する（二重実装しない）——本関数は「belowGraph省略時に
 * 自前でpeekする」窓口の役目だけを持つ。
 * 呼び出し側（structuralRecompute.js）が wallGate と同じパターンで await し、結果を
 * autoFillStructuralGrid（同期）へプレーン配列として渡す。
 * @param {object} graph
 * @param {object} project
 * @param {object|null} [belowGraph] - 1つ下の実体階のgraph（省略時=undefinedのときだけ自前でpeekする。
 *   nullを明示すれば「下階なし」として扱い、peekしない——呼び出し側（structuralRecompute.js）が
 *   木造梁成（ステップ3d）と同じpeek結果を使い回し、1回の再計算で下階を二重にpeekしないための引数）。
 * @param {ReturnType<typeof createWallSourceCache>} [cache] - 省略時は毎回全走査（従来どおり）。
 * @param {object} [ctx] - 解決コンテキスト（自前peekするときだけ使う。peekBelowGraphと同じ・省略可）。
 */
export async function collectWallBeamSources(graph, project, belowGraph = undefined, cache = undefined, ctx = undefined) {
  const mode = rulesFor(effectiveStructure(graph, project)).wallBeamAxes;
  const resolvedBelow = mode === 'selfAndBelow' && belowGraph === undefined
    ? await peekBelowGraph(graph, project, ctx)
    : belowGraph;
  return wallBeamSourcesFor(graph, project, resolvedBelow, cache);
}

/**
 * graph（自階）＋belowGraph（1つ下の実体階。無ければnull）から、壁由来の梁芯生成・在来木造の
 * 壁線上の通し梁（ステップ3c-2、woodAutoFill.js autoFillWoodWallBeams）が候補列挙に使う壁区間を、
 * **マージせず**返す（同期・純粋）。rulesFor(structure).wallBeamAxes==='selfAndBelow'（在来木造のみ）
 * でなければ空配列——RC造の壁由来梁芯生成（rcBacking）・鉄骨系（対象外）はここには現れない。
 * collectWallBeamSources のselfAndBelow分岐はこの結果を mergeWallBeamSources に通すだけにして、
 * 「自階＋下階をマージする」処理を二重実装しない。
 * @param {object} graph
 * @param {object|null} belowGraph
 * @param {string} structure
 * @param {ReturnType<typeof createWallSourceCache>} [cache] - 省略時は毎回全走査（従来どおり）。
 * @returns {Array<{isVertical:boolean, coord:number, lo:number, hi:number}>}
 */
export function wallRunSegments(graph, belowGraph, structure, cache = undefined) {
  if (rulesFor(structure).wallBeamAxes !== 'selfAndBelow') return [];
  const self = wallBeamSourcesFromGraph(graph, false, cache);
  const below = belowGraph ? wallBeamSourcesFromGraph(belowGraph, false, cache) : [];
  // Major 6・2026-09-18裁定: 1つ下の実体階の階段の「床開口の外周4辺すべて」も、壁線と同じ扱いの
  // 区間として合流させる（stairOpeningRuns参照）。
  const openings = stairOpeningRuns(belowGraph);
  return self.concat(below, openings);
}

/**
 * 1つ下の実体階の階段（belowGraph.stairs）の全周矩形（roomBounds）の**4辺すべて**を、壁区間と
 * 同じ扱いのプレーン区間として返す（Major 6・2026-09-18裁定。旧`stairArrivalRuns`＝「壁が一切かから
 * ない1辺だけをN→S→W→E優先で選ぶ」は撤回した——QA指摘: 到達辺（上がり口）だけでなく、床開口の
 * 周囲全体に縁梁が必要という構造的要求のほうが実態に合う。壁のある辺は`wallRunSegments`側の
 * `mergeWallIntervals`で壁区間と自然に合体し、壁の無い辺（上がり口）は単独の区間として通し梁の
 * runになる。壁被覆の判定（旧WALL_JUNCTION_TOL_MM許容）はここでは行わない——4辺とも無条件で候補に
 * 加える。
 * 【ガード（ASSUMED）】地階へ下る階段（自階の床に開口を作らない階段）を除外する判定は行っていない
 * ——`belowGraph`は常に`graph`の直下の実体階であり（`belowPlaneOf`）、`Stair`は「設置階＝下階の
 * グラフに帰属し上階へ投影される」（`core/stair.js`）ため、`belowGraph.stairs`の各エントリは
 * 定義上すべて`graph`（1つ上）へ到達する——という前提に基づき除外していないが、この前提を破る
 * 階段種別・状態（例: 上階に到達しない意匠的な階段）がモデル上存在しないことまでは確認できていない
 * （`Stair`クラスに到達先を明示するフィールドが無いため）。
 * @param {object|null} belowGraph - 1つ下の実体階のgraph（階段のcells解決・roomBounds算出に使う）
 * @returns {Array<{isVertical:boolean, coord:number, lo:number, hi:number}>}
 */
export function stairOpeningRuns(belowGraph) {
  if (!belowGraph) return [];
  const out = [];
  for (const stair of belowGraph.stairs) {
    const b = roomBounds(stair.cells, belowGraph);
    if (![b.x1, b.y1, b.x2, b.y2].every(Number.isFinite) || !(b.x2 > b.x1 && b.y2 > b.y1)) continue;
    out.push(
      { isVertical: false, coord: b.y1, lo: b.x1, hi: b.x2 }, // 北（y最小）
      { isVertical: false, coord: b.y2, lo: b.x1, hi: b.x2 }, // 南（y最大）
      { isVertical: true,  coord: b.x1, lo: b.y1, hi: b.y2 }, // 西（x最小）
      { isVertical: true,  coord: b.x2, lo: b.y1, hi: b.y2 }, // 東（x最大）
    );
  }
  return out;
}

/**
 * graph（1つ上の実体階など。無ければnull）の柱生成の点源となる梁（role:'primary'（大梁・頭つなぎ・
 * 受梁の別を問わない）または role:'floor'（床梁）。ステップ3h-2）を、下階の柱生成（woodAutoFill.js
 * autoFillWoodColumns の aboveBeamSegments）が「壁とみなして」扱うための区間（プレーン配列）へ写す。
 * 座標基準は**axisCL.effectiveValue**（emitted・lockedSegmentsと同じ基準。b.axisValueは偏心・柱芯
 * オフセットを加えた実位置のため、これらと混在させるとoverlaps等の同軸判定がずれる。m6）・lo/hiは
 * clStart/clEnd.effectiveValueのmin/max——3bのaboveColumns（他階graphからは柱のx/y/roleしか読まない
 * 規律）を「梁の軸・範囲まで」広げたもの（.claude/structural-model.md参照）。
 * **旧実装は頭つなぎ・受梁（beamType限定）＋床梁だけに絞っていたが、beamType列挙から漏れる壁線由来の
 * 大梁（例：階段の床開口4辺由来の縁梁）が下階に柱を持たない不具合の原因だったため、role:'primary'全体
 * （beamTypeを問わない）へ一般化した**（.claude/structural-model.md「点源の一般化」節参照）。
 * rules.baseMaterialと一致しない材種の梁は含めない（呼び出し側が対象graphの実効主構造ルールを渡す）。
 * 返り値の`role`は3i（次段。支持長1820超のみを対象にする予定）が primary/floor を区別するために持つ
 * だけで、本関数自身の消費（beamWallCrossPoints）はroleを見ない。
 * structuralRecompute.js・structuralOrchestration.js の両方が共有する（追加peekは無い——3b用に
 * peek済みのaboveGraphから読むだけ）。
 * @param {object|null} graph
 * @param {{baseMaterial:string}} rules
 * @returns {Array<{isVertical:boolean, coord:number, lo:number, hi:number, role:string}>}
 */
export function columnSeedBeamSegments(graph, rules) {
  if (!graph) return [];
  return graph.beams
    .filter(b => b.materialType === rules.baseMaterial && (b.role === 'primary' || b.role === 'floor'))
    .map(b => ({
      isVertical: b.isVertical,
      coord: b.axisCL.effectiveValue,
      lo: Math.min(b.clStart.effectiveValue, b.clEnd.effectiveValue),
      hi: Math.max(b.clStart.effectiveValue, b.clEnd.effectiveValue),
      role: b.role,
    }));
}

/** gridCLs（value昇順）から、[lo,hi] を含む最小の直交通り芯ペアを返す（見つからない側はnull）。
 *  extentを通り芯より内側で切ると autoFillSecondaryBeams の host 抽出（cl.extentLo/Hi で通り芯を
 *  絞り込む）に届かず小梁が0本になるため、壁の区間を含むように外側へスナップする（設計書§2.3(4)）。
 *  woodAutoFill.js autoFillWoodFloorBeams（ステップ3e-2 D1）が、床梁の軸に再利用した既存の非ラベル
 *  梁芯CLのextentを「再ブラケット」する際にも同じ関数を共有する（二重実装しない）。 */
export function bracketExtent(gridCLs, lo, hi) {
  let loCL = null, hiCL = null;
  for (const cl of gridCLs) {
    if (cl.value <= lo + BRACKET_EPS_MM) loCL = cl;
    if (hiCL == null && cl.value >= hi - BRACKET_EPS_MM) hiCL = cl;
  }
  return { loCL, hiCL };
}

/**
 * wallSources（collectWallBeamSourcesの結果）から梁芯CLを生成する（同期・純生成）。
 * autoFillStructuralGrid の autoFillSecondaryBeams 直前で呼ぶ。
 *   - 除外集合（graph.excludedWallBeamAxes、キー `${'X'|'Y'}:${Math.round(coord)}`）にあれば生成しない
 *     （手動削除・移動元の尊重。記録/解除は transform/centerLineOps.js 側）。
  *   - 重複ガード: 同方向の通り芯（labeled）・既存の梁芯（fuse）とだけ CL_OVERLAP_TOL_MM 以内なら
 *     スキップする（意匠中心線・補助線は対象外——壁は意匠中心線＝部屋境界に沿って生成されるのが
 *     常態のため、これらも障害物にすると壁由来の梁芯が主用途で何も生成されなくなる。実機検証で発覚。
 *     意匠中心線は構造モードで非表示のため同位置共存に視覚上の衝突もない）。
 *   - refId は持たせない（絶対座標）。壁のaxisCLは意匠中心線であることが多く、構造モードでは
 *     非表示になるため参照先が見えない線になってしまう（設計書§2.3(3)）。
 *   - extent は壁の区間を含む最小の直交通り芯ペアへスナップする（bracketExtent）。
 * @returns {CenterLine[]} 新規作成した梁芯CLの配列
 */
export function autoFillWallBeamAxes(graph, wallSources) {
  const created = [];
  for (const src of wallSources) {
    const excludeKey = wallBeamAxisExcludeKey(src.isVertical, src.coord);
    if (graph.excludedWallBeamAxes.has(excludeKey)) continue;

    const centerLineType = src.isVertical ? CenterLineType.VERTICAL : CenterLineType.HORIZONTAL;
    // 重複ガードの対象は通り芯（labeled）と既存の梁芯（fuse）のみ——意匠中心線・補助線は対象外。
    // 壁は意匠中心線に沿って生成されるのが常態（部屋境界＝中心線）のため、これらも障害物にすると
    // 壁由来の梁芯が主用途で何も生成されなくなる（実機検証で発覚。意匠中心線は構造モードで非表示化
    // 済みのため、その位置に梁芯が立つのは「中心線の代わりに梁芯が見える」という設計どおりの状態）。
    // beamAxisMoveRange の障害物集合（通り芯・他の梁芯のみ）と同じ規約に揃える。判定は
    // findBeamAnchorCL（壁交点柱のアンカー解決と同一の述語＝二重管理しない）。
    if (findBeamAnchorCL(graph, centerLineType, src.coord)) continue;

    const gridCLs = src.isVertical ? graph.gridYs : graph.gridXs; // 直交通り芯（value昇順）
    const { loCL, hiCL } = bracketExtent(gridCLs, src.lo, src.hi);

    created.push(graph.addCenterLine(centerLineType, src.coord, {
      labeled: false,
      discipline: Discipline.FUSE,
      extentLoRef: loCL ? { clId: loCL.id, offset: 0 } : null,
      extentHiRef: hiCL ? { clId: hiCL.id, offset: 0 } : null,
      extentLo: loCL ? null : src.lo,
      extentHi: hiCL ? null : src.hi,
    }));
  }
  return created;
}
