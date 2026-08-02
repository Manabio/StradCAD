import { findSectionEntry } from './sectionCatalog.js';

// ================================================================
// 柱・柱脚の概算サイズ算定（負担床面積ベース）
//
// 本物の構造計算（応力検算）は次フェーズのため、ここでは「概算荷重から手早く
// サイズの目安を出す」簡易ルールのみを扱う。core.js には依存しない
// （structuralAutoFill.js と同じ立ち位置。循環import回避）。sectionCatalog.js は
// core.js に依存しない静的データのため、ここからの参照は循環import対象外。
//
//   N             = この柱が実際に属する階を1階とみなした時、最上階（屋根専用平面を除く）
//                   までの階数（例: 2階建ての1階柱ならN=2）。柱は自階graphに属するため
//                   storiesSupportedAbove には柱自身の階（graph.plane）を渡す
//                   （柱脚を算定する基礎伏図でも自階＝graph.planeでよい）。
//   柱が支える総床面積(m2) = Σ（隣接する各グリッドセル面積[m2] × N ÷ そのセルを支える柱の総数）
//                   （通常は四隅とも柱があり総数=4。ユーザーが隅の柱を削除等した場合は
//                   残りの柱数で割り、その分の負担を残った柱に再配分する）
//   柱幅D(mm)     = 30 * sqrt(柱が支える総床面積(m2))、50mmピッチ切り上げ
//   柱脚 x, y(mm) = ceil(3.2 * D / 100) * 100
//   柱脚 d(mm)    = ceil(2.3 * D / 100) * 100
// ================================================================

const COLUMN_WIDTH_COEFFICIENT = 30; // D(mm) = この係数 × √(柱が支える総床面積(m2))
const MM2_PER_M2 = 1_000_000;

const COLUMN_BASE_PLAN_RATIO  = 3.2; // 柱脚の平面サイズ(x,y) = 柱幅Dのこの倍数
const COLUMN_BASE_DEPTH_RATIO = 2.3; // 柱脚の埋込み深さ(d)   = 柱幅Dのこの倍数

/** value をpitch単位の格子に切り上げる（例: roundUpToPitch(327, 100) === 400）。 */
export function roundUpToPitch(value, pitch) {
  return Math.ceil(value / pitch) * pitch;
}

/** plane が支える階数（自分を含め上に何階あるか）。屋根専用平面は常に1。
 *  project.planes（elevation昇順、屋根平面除く）上のrankから求める
 *  （memberNumbering.js の collectFloorGroups と同じrank探索パターン）。
 *  最下階（rank 0、基礎伏図）は全階数を返す＝基礎が建物全体を支える。 */
export function storiesSupportedAbove(plane, project) {
  if (plane.isRoofPlane) return 1;
  const planes = project.planes;
  const rank = planes.findIndex(p => p.id === plane.id);
  if (rank < 0) return 1;
  return planes.length - rank;
}

/** verticalCL × horizontalCL の交点に隣接する最大4セルの { area, supportCount } 配列を返す
 *  （端・隅は1〜2セルのみ。graph.gridXs/gridYs内での添字探索は
 *  structuralAutoFill.js の computeGridIntersections と同じ考え方）。
 *  supportCount: そのセルの四隅のうち実際に柱が存在する数（通常4。隅の柱が無ければそれ未満）。 */
export function adjacentCellAreas(graph, verticalCL, horizontalCL) {
  const xs = graph.gridXs, ys = graph.gridYs;
  const xi = xs.findIndex(cl => cl.id === verticalCL.id);
  const yi = ys.findIndex(cl => cl.id === horizontalCL.id);
  if (xi < 0 || yi < 0) return [];
  const columnSlots = new Set(graph.columns.map(c => `${c.verticalCL.id}:${c.horizontalCL.id}`));
  const hasColumn = (vCL, hCL) => columnSlots.has(`${vCL.id}:${hCL.id}`);
  const cells = [];
  for (const dx of [-1, 0]) {
    const x1 = xs[xi + dx], x2 = xs[xi + dx + 1];
    if (!x1 || !x2) continue;
    const width = Math.abs(x2.effectiveValue - x1.effectiveValue);
    for (const dy of [-1, 0]) {
      const y1 = ys[yi + dy], y2 = ys[yi + dy + 1];
      if (!y1 || !y2) continue;
      const height = Math.abs(y2.effectiveValue - y1.effectiveValue);
      const supportCount = [[x1, y1], [x2, y1], [x1, y2], [x2, y2]]
        .filter(([vCL, hCL]) => hasColumn(vCL, hCL)).length;
      cells.push({ area: width * height, supportCount });
    }
  }
  return cells;
}

/** 柱（または柱脚）の位置が支える概算負担床面積から、柱幅D(mm、50mmピッチ切り上げ)を算定する。
 *  structuralPlane: 柱が実際に属する階（柱は自階graphに属するため通常は graph.plane）。
 *  グリッド（verticalCL/horizontalCL）自体は通り芯が階共通のため、常に描画階のgraphから読む。 */
export function computeTributaryColumnWidth(graph, project, verticalCL, horizontalCL, structuralPlane) {
  const cells = adjacentCellAreas(graph, verticalCL, horizontalCL);
  const stories = storiesSupportedAbove(structuralPlane, project);
  const totalAreaM2 = cells.reduce((sum, { area, supportCount }) => (
    supportCount > 0 ? sum + (area * stories) / supportCount : sum
  ), 0) / MM2_PER_M2;
  return roundUpToPitch(COLUMN_WIDTH_COEFFICIENT * Math.sqrt(totalAreaM2), 50);
}

/** 柱幅D(mm)から柱脚の平面サイズ(widthX, widthY)・埋込み深さ(pedestalDepth)を算定する（100mmピッチ切り上げ）。 */
export function computeColumnBaseSize(columnWidthD) {
  return {
    widthX:        roundUpToPitch(columnWidthD * COLUMN_BASE_PLAN_RATIO, 100),
    widthY:        roundUpToPitch(columnWidthD * COLUMN_BASE_PLAN_RATIO, 100),
    pedestalDepth: roundUpToPitch(columnWidthD * COLUMN_BASE_DEPTH_RATIO, 100),
  };
}

// ================================================================
// 基礎梁の概算断面算定（梁幅b・梁成D、ともに50mmピッチ切り上げ）
//
//   D(mm) = 建物の中で最も長い柱間L(mm) / 7 (RC造) または / 8 (それ以外)
//   L      = 通り芯グリッド（X・Y）の隣接CL間距離の最大値
//   b(mm)  = 建物の中で最も太い柱の大きさ + 100
//   柱の大きさ = 柱の断面寸法そのもの（sectionDefIdのカタログ実寸。例: 200×200の柱なら200）
//            基礎伏図には柱本体が無いため、他の全フロアの柱を走査する（杭=role:'foundation'は対象外）。
// ================================================================

const FOUNDATION_BEAM_WIDTH_MARGIN = 100; // b = 最も太い柱の大きさ + この値(mm)

// 木造（在来）の基礎梁標準寸法・下限（問題.md）。標準は150×600（=350+250）。
// 幅の最小135／成の最小450（梁間≤3640mmのとき）。auto算定は標準値、下限はユーザー編集時のバリデーション用。
export const WOOD_FOUNDATION_BEAM = Object.freeze({ width: 150, depth: 600, minWidth: 135, minDepth: 450, minDepthSpanLimit: 3640 });

/** 主構造が木造系か（基礎梁の標準寸法ルール分岐用）。 */
function isWoodStructure(mainStructure) {
  return mainStructure === '木造（在来）' || mainStructure === '木造（2"×4"）';
}

/** graph.gridXs/gridYs（X・Y方向）の隣接CL間距離の最大値(mm)を返す＝「建物の中で最も長い柱間」L。 */
export function longestGridSpan(graph) {
  const maxAdjacentSpan = (axisCLs) => {
    let max = 0;
    for (let i = 0; i < axisCLs.length - 1; i++) {
      max = Math.max(max, Math.abs(axisCLs[i + 1].effectiveValue - axisCLs[i].effectiveValue));
    }
    return max;
  };
  return Math.max(maxAdjacentSpan(graph.gridXs), maxAdjacentSpan(graph.gridYs));
}

/** 建物全フロアの柱（杭=role:'foundation'を除く）の断面寸法(sectionDefIdのカタログ実寸)の最大値(mm)を返す
 *  ＝「建物の中で最も太い柱の大きさ」。矩形等で幅・高さが異なる場合は大きい方を採る
 *  （MemberTagLayer.jsx の柱タグマージン算定と同じ考え方）。基礎伏図には柱本体が無いため対象外（project.planes走査で自然に除外される）。 */
export function maxColumnSectionSize(project) {
  let max = 0;
  for (const plane of project.planes) {
    const graph = project.graphMap.get(plane.id);
    if (!graph) continue;
    for (const column of graph.columns) {
      if (column.role === 'foundation') continue; // 杭は「柱」ではないため対象外
      const sec = findSectionEntry(column.sectionDefId);
      if (!sec) continue;
      max = Math.max(max, sec.width, sec.height);
    }
  }
  return max;
}

/** 基礎梁の断面（梁幅b・梁成D、mm、50mmピッチ切り上げ）を算定する。
 *  mainStructure: 実効主構造の文字列表記。'RC造'始まり（ラーメン/壁式）のみD=L/7、それ以外（S造/SRC造/木造/未定）はD=L/8
 *  （ユーザー指定はS造/RC造のみのため、それ以外はS造に準じた値で代用する簡易ルール）。 */
export function computeFoundationBeamSize(graph, project, mainStructure) {
  // 木造系は土台幅基準の標準寸法150×600固定（問題.md）。柱幅・スパン由来のRC/S算定式とは別系統。
  if (isWoodStructure(mainStructure)) {
    return { width: WOOD_FOUNDATION_BEAM.width, depth: WOOD_FOUNDATION_BEAM.depth };
  }
  const depthDivisor = mainStructure?.startsWith('RC造') ? 7 : 8;
  const span = longestGridSpan(graph);
  const columnSize = maxColumnSectionSize(project);
  return {
    width: roundUpToPitch(columnSize + FOUNDATION_BEAM_WIDTH_MARGIN, 50),
    depth: roundUpToPitch(span / depthDivisor, 50),
  };
}

// ================================================================
// 屋上伏図の梁（軒桁を含む横架材の簡易表現）の概算断面算定
//
//   D(mm) = 建物の中で最も長い柱スパン(longestGridSpan) / 24 (50mmピッチ切り上げ)
//   B(mm) = D / 2
//
// 垂木・母屋等を区別した本格的な小屋組み構造計算は次フェーズ（structural-model.md参照）。
// ================================================================

const ROOF_BEAM_DEPTH_DIVISOR = 24; // D = 最も長い柱スパン / この値

/** 屋上伏図の梁（軒桁を含む。X・Y方向問わず全横架材に同一値を適用）の断面を算定する。 */
export function computeRoofBeamSize(graph) {
  const depth = roundUpToPitch(longestGridSpan(graph) / ROOF_BEAM_DEPTH_DIVISOR, 50);
  return { width: depth / 2, depth };
}
