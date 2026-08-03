// 壁（仕上げモードの下地オーナー壁）から梁芯CL（discipline:'fuse'）を自動生成する。
// 生成された梁芯CLは既存の autoFillSecondaryBeams がそのまま拾う（梁芯の出自を見ない実装のため、
// 小梁の生成・端部トリム・除外集合・採番はすべて既存経路）。設計意図は .claude/structural-model.md 参照。
import { CenterLineType, Discipline, centerLineKind } from '../core.js';
import { CL_OVERLAP_TOL_MM } from '../core/constants.js';
import { isRcWallBacking } from '../finish/materials/backingClass.js';
import { floorSwapManager } from '../storage/FloorSwapManager.js';

// その階の実効主構造（階の上書き優先・なければ建物全体値）。structuralAutoFill.js の
// effectiveStructure と同一ロジック——ここで再importすると structuralAutoFill.js →
// wallBeamAxes.js（autoFillWallBeamAxes）→ structuralAutoFill.js の循環importになるため、
// 既にこのプロジェクトで複数箇所に重複している1行のロジック（drawingDesignation.js 等）と
// 同じ扱いで独立に持つ。
function effectiveStructure(graph, project) {
  return graph.structureOverride ?? project.structuralInfo.mainStructure;
}

// 通り芯の座標一致判定の許容誤差(mm)。secondaryBeamSpansFor の SPAN_EPS と同じ考え方。
const BRACKET_EPS_MM = 0.5;

// 在来木造か（2×4は含まない）。壁下地からの梁芯・小梁自動生成 条件(b)(c) 専用の判定
// （枠組壁工法は壁自体が構造体で、壁下に梁を入れる考え方が異なるため対象外——設計書 Open Q2）。
// 表記は ui/StructuralInfoDialog.jsx の MAIN_STRUCTURE_OPTIONS が正（'木造（在来）'は全角括弧）。
// ベタ書きはここ1箇所のみに閉じ込める（他ファイルはこの関数を呼ぶ）。
const TRADITIONAL_WOOD_STRUCTURE = '木造（在来）';
export function isTraditionalWoodStructure(structure) {
  return structure === TRADITIONAL_WOOD_STRUCTURE;
}

/** plane の「1つ下の実体階」を返す（project.planes、elevation昇順・採用フロアのみ）。
 *  最下階・屋根専用平面（project.planesに含まれない）・該当なしは null。 */
function belowPlaneOf(plane, project) {
  const planes = project.planes;
  const idx = planes.findIndex(p => p.id === plane.id);
  if (idx <= 0) return null;
  return planes[idx - 1];
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
 *  requireRcBacking=true なら、per-floor 下地材コードが isRcWallBacking() の壁だけに絞る（条件(a)）。
 *  false なら下地材の種別は問わない（条件(b)(c)）。
 *  返り値は CL 参照を持たないプレーン配列 [{isVertical, coord, lo, hi}]（世界座標mm）——
 *  他階実体を主題階へ持ち込まない（.claude/figure.md 規律）ため、下階peek分もここで座標へ還元する。 */
function wallBeamSourcesFromGraph(sourceGraph, requireRcBacking) {
  const out = [];
  for (const wall of sourceGraph.walls) {
    if (!isBackingOwnerWall(wall)) continue;
    if (requireRcBacking && !isRcWallBacking(wallBackingCode(sourceGraph, wall))) continue;
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
 */
export async function collectWallBeamSources(graph, project) {
  const structure = effectiveStructure(graph, project);
  let sources = [];
  if (structure.startsWith('RC造')) {
    sources = wallBeamSourcesFromGraph(graph, true);
  } else if (isTraditionalWoodStructure(structure)) {
    sources = wallBeamSourcesFromGraph(graph, false);
    const belowPlane = belowPlaneOf(graph.plane, project);
    if (belowPlane) {
      const belowGraph = await floorSwapManager.peek(belowPlane, project.structGraph);
      sources = sources.concat(wallBeamSourcesFromGraph(belowGraph, false));
    }
  }
  return mergeWallBeamSources(sources);
}

/** gridCLs（value昇順）から、[lo,hi] を含む最小の直交通り芯ペアを返す（見つからない側はnull）。
 *  extentを通り芯より内側で切ると autoFillSecondaryBeams の host 抽出（cl.extentLo/Hi で通り芯を
 *  絞り込む）に届かず小梁が0本になるため、壁の区間を含むように外側へスナップする（設計書§2.3(4)）。 */
function bracketExtent(gridCLs, lo, hi) {
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
 *     （手動削除・移動元の尊重。記録/解除は App.jsx 側）。
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
    const axisKey = src.isVertical ? 'X' : 'Y';
    const excludeKey = `${axisKey}:${Math.round(src.coord)}`;
    if (graph.excludedWallBeamAxes.has(excludeKey)) continue;

    const centerLineType = src.isVertical ? CenterLineType.VERTICAL : CenterLineType.HORIZONTAL;
    // 重複ガードの対象は通り芯（labeled）と既存の梁芯（fuse）のみ——意匠中心線・補助線は対象外。
    // 壁は意匠中心線に沿って生成されるのが常態（部屋境界＝中心線）のため、これらも障害物にすると
    // 壁由来の梁芯が主用途で何も生成されなくなる（実機検証で発覚。意匠中心線は構造モードで非表示化
    // 済みのため、その位置に梁芯が立つのは「中心線の代わりに梁芯が見える」という設計どおりの状態）。
    // beamAxisMoveRange の障害物集合（通り芯・他の梁芯のみ）と同じ規約に揃える。
    const hasNearby = graph.centerLines.some(cl =>
      cl.centerLineType === centerLineType &&
      (cl.labeled || centerLineKind(cl) === 'beam') &&
      Math.abs(cl.effectiveValue - src.coord) < CL_OVERLAP_TOL_MM);
    if (hasNearby) continue;

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
