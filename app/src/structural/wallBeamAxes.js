// 壁（仕上げモードの下地オーナー壁）から梁芯CL（discipline:'fuse'）を自動生成する。
// 生成された梁芯CLは既存の autoFillSecondaryBeams がそのまま拾う（梁芯の出自を見ない実装のため、
// 小梁の生成・端部トリム・除外集合・採番はすべて既存経路）。設計意図は .claude/structural-model.md 参照。
import { CenterLineType, Discipline, centerLineKind } from '../core.js';
import { CL_OVERLAP_TOL_MM } from '../core/constants.js';
import { backingClassOf } from '../finish/materials/backingClass.js';
import { floorSwapManager } from '../storage/FloorSwapManager.js';
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

/**
 * plane の「1つ下の実体階」のgraphをpeekする（belowPlaneOf＋floorSwapManager.peek）。無ければnull。
 * collectWallBeamSources（selfAndBelow時の自前peek）と structuralRecompute.js（木造梁成の下階柱取得。
 * ステップ3d）が同じpeekを共有する——別々にpeekすると1回の再計算で下階を2回読みに行くため。
 * @param {object} graph
 * @param {object} project
 * @returns {Promise<object|null>}
 */
export async function peekBelowGraph(graph, project) {
  const belowPlane = belowPlaneOf(graph.plane, project);
  if (!belowPlane) return null;
  return await floorSwapManager.peek(belowPlane, project.structGraph);
}

/** wall が下地オーナー壁か（backingRange!=null。backingDepth===0の仕上げのみの薄壁は対象外）。 */
function isBackingOwnerWall(wall) {
  return wall.backingRange != null;
}

/** per-floor 設定から wall の下地材コードを引く（Edge個別上書きは対象外。設計書 §2.1 の割り切り）。 */
function wallBackingCode(sourceGraph, wall) {
  return wall.isExteriorWall ? sourceGraph.exteriorWallBacking : sourceGraph.interiorWallBacking;
}

/** sourceGraph の下地オーナー壁から wallSources 断片（プレーン配列）を抽出する。
 *  requireBeamAxisBacking=true なら、per-floor 下地材コードの下地材分類が「梁芯の生成源」
 *  （structureRules.js BACKING_RULES.beamAxisSource＝RC壁下地）の壁だけに絞る（条件(a)）。
 *  false なら下地材の種別は問わない（条件(b)(c)）。
 *  返り値は CL 参照を持たないプレーン配列 [{isVertical, coord, lo, hi}]（世界座標mm）——
 *  他階実体を主題階へ持ち込まない（.claude/figure.md 規律）ため、下階peek分もここで座標へ還元する。 */
function wallBeamSourcesFromGraph(sourceGraph, requireBeamAxisBacking) {
  const out = [];
  for (const wall of sourceGraph.walls) {
    if (!isBackingOwnerWall(wall)) continue;
    if (requireBeamAxisBacking && !backingRulesFor(backingClassOf(wallBackingCode(sourceGraph, wall))).beamAxisSource) continue;
    // 梁芯位置＝下地帯の中心（wall.axisValueは仕上げ面の位置のため使わない。設計書§2.3(2)）。
    const coord = (wall.backingRange.lo + wall.backingRange.hi) / 2;
    out.push({
      isVertical: wall.isVertical,
      coord,
      lo: Math.min(wall.coord1, wall.coord2),
      hi: Math.max(wall.coord1, wall.coord2),
    });
  }
  return out;
}

/** 自階の下地オーナー壁の区間（プレーン配列 [{isVertical, coord, lo, hi}]。下地材の種別は問わず、下階は含まない）。
 *  在来木造の壁交点柱（woodAutoFill.js）が候補列挙に使う。 */
export function selfWallSegments(graph) {
  return wallBeamSourcesFromGraph(graph, false);
}

// ================================================================
// 壁由来梁芯の追従（壁再生成をFinishModeStateから独立させる計画のステップ2）。
//
// 下地帯の中心が壁再生成で動いたとき（下地材コード変更で壁厚が変わる等）、旧座標に残る
// 壁由来の梁芯CL（discipline:fuse）を撤去せず追従させる——CL id が変わらないため、
// それにアンカーされた壁交点柱・除外集合が生きたまま新しい位置に移る。
// 対応先の壁が無くなった孤児梁芯は撤去しない（2026-09-15裁定。現状に撤去規律が無く、
// 自動/手動の出自フラグも無いため）。
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
    out.push({
      axisCLId: wall.axisCL.id,
      isVertical: wall.isVertical,
      // side は wall.faceDirOr(0)（core/wall.js）を使う——Math.sign(axisOffset) だけだと
      // CL偏芯の仕上げ面合わせ（axisOffset===0だがfinishSideが明示されている）で0に潰れ、
      // 本来+/-で区別すべき2枚の壁が同じsideに丸められてしまう（QA S3）。偏芯なし（対称壁。
      // finishSide・axisOffsetともnull/0）は引き続き0。
      side: wall.faceDirOr(0),
      coord: (wall.backingRange.lo + wall.backingRange.hi) / 2,
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
  return graph.centerLines.find(cl =>
    cl.centerLineType === centerLineType &&
    centerLineKind(cl) === 'beam' &&
    Math.abs(cl.effectiveValue - coord) < CL_OVERLAP_TOL_MM) ?? null;
}

/** coord に一致（CL_OVERLAP_TOL_MM以内）する通り芯（labeled）または梁芯（fuse。centerLineKind==='beam'）を返す。
 *  意匠中心線・補助線は対象にしない。梁芯の重複ガード（autoFillWallBeamAxes）と壁交点柱のアンカー解決
 *  （woodAutoFill.js）が共有する単一の述語——片方だけ条件を変えると柱が湧く／消えるため。無ければ null。 */
export function findBeamAnchorCL(graph, centerLineType, coord) {
  return graph.centerLines.find(cl =>
    cl.centerLineType === centerLineType &&
    (cl.labeled || centerLineKind(cl) === 'beam') &&
    Math.abs(cl.effectiveValue - coord) < CL_OVERLAP_TOL_MM) ?? null;
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
 * graph（自階）から、壁由来の梁芯生成対象（プレーン配列）を収集する（async・下階peekを含む）。
 * 生成条件（設計書 §2.2、主構造は自階の実効値）:
 *   (a) RC造（'RC造(ラーメン)'|'RC造(壁式)'）        → 自階の下地オーナー壁のうち下地材がRC下地のもの
 *   (b) 木造（在来）                                  → 自階の下地オーナー壁（下地材の種別は問わない）
 *   (c) 木造（在来）                                  → 1つ下の実体階の下地オーナー壁（同上）
 * RC造は自階のみ（上下階で壁が連続し自立するため下階壁の頭に梁は不要という設計判断）。
 * 呼び出し側（structuralRecompute.js）が wallGate と同じパターンで await し、結果を
 * autoFillStructuralGrid（同期）へプレーン配列として渡す。
 * @param {object} graph
 * @param {object} project
 * @param {object|null} [belowGraph] - 1つ下の実体階のgraph（省略時=undefinedのときだけ自前でpeekする。
 *   nullを明示すれば「下階なし」として扱い、peekしない——呼び出し側（structuralRecompute.js）が
 *   木造梁成（ステップ3d）と同じpeek結果を使い回し、1回の再計算で下階を二重にpeekしないための引数）。
 */
export async function collectWallBeamSources(graph, project, belowGraph = undefined) {
  const structure = effectiveStructure(graph, project);
  // 生成源の選択は主構造ルール（structureRules.js wallBeamAxes: 'rcBacking' | 'selfAndBelow' | null）。
  const mode = rulesFor(structure).wallBeamAxes;
  let sources = [];
  if (mode === 'rcBacking') {
    sources = wallBeamSourcesFromGraph(graph, true);
  } else if (mode === 'selfAndBelow') {
    const below = belowGraph === undefined ? await peekBelowGraph(graph, project) : belowGraph;
    sources = wallRunSegments(graph, below, structure);
  }
  return mergeWallBeamSources(sources);
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
 * @returns {Array<{isVertical:boolean, coord:number, lo:number, hi:number}>}
 */
export function wallRunSegments(graph, belowGraph, structure) {
  if (rulesFor(structure).wallBeamAxes !== 'selfAndBelow') return [];
  const self = wallBeamSourcesFromGraph(graph, false);
  const below = belowGraph ? wallBeamSourcesFromGraph(belowGraph, false) : [];
  return self.concat(below);
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
