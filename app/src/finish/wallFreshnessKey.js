/**
 * 壁の鮮度キー（fresh­ness key） — 壁の入力（下地材コード・主構造・部屋の壁材/壁仕上げ）から
 * 決定的な文字列を作る純関数。graph.wallFreshnessKey へ保存し、キー不一致で壁を再生成する
 * 方式（壁の再生成をFinishModeStateから独立させる計画）の鍵。比較・再生成は wallRefresh.js の
 * refreshWallsForGraph / refreshWallsAllFloors が担い、本モジュールは鍵の計算だけを行う。
 *
 * 依存は structural/structureRules.js・core/centerLine.js・core/centerLineKindPolicy.js・
 * finish/stair/stairDimensions.js だけにする（材マスタ・wallGeneration を import しない）。
 * 鍵の比較は壁境界を跨がず毎回走らせたいが、再生成そのものは不一致時だけに限定したい
 * ——両者を別モジュールに分けておくための制約。
 */
import { effectiveStructure, woodColumnSectionId } from '../structural/structureRules.js';
import { centerLineKind } from '../core/centerLine.js';
import { finishCellDividers, isFinishCellDivider } from '../core/centerLineKindPolicy.js';
import { floorHeightAbove } from './stair/stairDimensions.js';

/**
 * 鍵の書式バージョン。材マスタ（壁材/壁仕上げ/下地材の実体）や壁生成規則
 * （wallGeneration.js / edgeComposition.js の導出式）を変えたら、鍵の入力が同じでも
 * 出力壁が変わりうるため、ここを上げて既存キーを一律不一致にする。
 * v2: 柱寸法が基準（120）より細い階の外壁下地帯シフト導入（wallGeneration.js
 * generateExteriorWalls/generateRoomWallsFromOutline の bandShift。鍵の入力は変えていないが
 * 生成式が変わったため既存キーを一律不一致にする）。
 * v3: 壁の自由端の柱包み導入（F-3・2026-09-19裁定。在来木造だけ`wallFreeEnd:'columnWrap'`。
 * wallGeneration.js の cornerMap 構築源を広げ、自由端をCL端から柱包み分はね出す）。鍵の入力
 * （実効主構造）は変えていないが生成式が変わったため既存キーを一律不一致にする。
 * v4 = 昇降路壁材（shaftWallMaterial）を鍵に追加 2026-09-28。
 * v5 = 在来木造の折返し階段の隔て壁を生成（finish/stair/stairPartitionWalls.js）。鍵の入力は
 * 変えていないが生成する壁が増えたため既存キーを一律不一致にする。
 * v6 = 隔て壁の自由端の柱包み（stairPartitionWalls.js wrapStairPartitionFreeEnds。両端の柱が90角の構造柱に
 * なり、自由端の側の壁を端CL±57.5へはね出す）。鍵の入力は変えていないが生成式が変わったため一律不一致にする。
 * v7 = 回り階段（WINDING）にも隔て壁を生成・鉄骨の階段には生成しない（stairPartition.js 2026-10-09）。鍵の入力は
 * 変えていないが生成する壁が変わったため一律不一致にする。
 * v8 = 幾何の入力を鍵に追加（fh=上階との階高・geo=セル分割線の宣言値・cells=部屋のセル・stairs=階段の配置）。
 * 平面の編集（通り芯の移動・端）・部屋のセル・階段の配置・上階との階高は壁の派生物（隔て壁・階段下部屋2a・
 * 柱巻き）の入力なのに鍵に無く、古くなった壁を検出できなかった。展開・天伏の突入境界で鍵を比較して
 * 再生成するための準備。
 */
export const WALL_KEY_VERSION = 'v8';

/**
 * 階段の鍵に入れる項目（core/stair.js Stair のコンストラクタの全項目から id・cells を除いたもの）。
 * cells は別枠（ソートして連結）。Stair に項目を足したらここへも足す（番人テストが検出する）。
 */
export const STAIR_KEY_FIELDS = [
  'type', 'structure', 'totalSteps', 'tread', 'riser', 'nosing', 'width', 'upDirection', 'flip',
  'sections', 'roomId', 'entrySide', 'arrivalSide', 'entryTurnSteps', 'arrivalTurnSteps',
];

/** 幾何の区画を 0.001mm に丸める（null/undefined は空）。 */
function q(v) {
  return v == null ? '' : Math.round(v * 1000);
}

/** cyrb53（53 ビット・36 進文字列）。区画ごとの入力をハッシュにして鍵文字列を短く保つ。 */
function digest(str) {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/**
 * 端の宣言値だけ（静的な端、または参照 CL の id とオフセット）。壁に結びついた端の解決値
 * （extentLo/Hi ゲッター・_extentLoWall）は読まない——壁再生成で変わり鍵が収束しなくなるため。
 */
function declaredExtent(staticValue, ref, refCL) {
  if (ref == null) return q(staticValue);
  const base = `@${ref.clId}@${q(ref.offset ?? 0)}`;
  // 参照先が分割線でない（補助線）ときは、その値が端の位置を決めるのに geo に入らないため足す。
  // 分割線なら geo に値が入っているので足さない。補助線の値は再生成・梁芯追従・構造再計算で書き換わらない。
  if (refCL != null && !isFinishCellDivider(refCL)) return `${base}=${q(refCL.value)}`;
  return base;
}

function byId(a, b) {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function geoPart(graph) {
  const lines = (graph ? finishCellDividers(graph) : []).sort(byId);
  return digest(lines.map(cl =>
    `${cl.id}:${cl.centerLineType}:${centerLineKind(cl)}:${cl.labeled ? 1 : 0}:${cl.trim ? 1 : 0}:${q(cl.value)}`
    + `:${declaredExtent(cl._extentLo, cl.extentLoRef, cl._extentLoCL)}:${declaredExtent(cl._extentHi, cl.extentHiRef, cl._extentHiCL)}`).join(';'));
}

function cellsPart(graph) {
  return digest((graph?.rooms ?? []).map(room =>
    `${room.id}:${[...(room.cells ?? [])].sort()}:${[...(room.referenceRoomIds ?? [])].sort()}`).join(';'));
}

function stairsPart(graph) {
  const stairs = [...(graph?.stairs ?? [])].sort(byId);
  return digest(stairs.map(s =>
    `${s.id}:${STAIR_KEY_FIELDS.map(f => JSON.stringify(s[f] ?? null)).join(',')}:${[...(s.cells ?? [])].sort()}`).join(';'));
}

/**
 * graph（1階分）の壁再生成に必要な入力から鍵文字列を作る。
 *
 * 鍵に含めるもの:
 *   - 外壁下地・内壁下地の材コード（graph.exteriorWallBacking / interiorWallBacking）
 *   - 昇降路壁材コード（graph.shaftWallMaterial。isShaftFeature の部屋の面材解決に使う）
 *   - 実効主構造（effectiveStructure。階の上書き優先）
 *   - 在来木造の柱断面（structureRules.js の woodColumnSectionId。graph.woodColumnWidthMm
 *     ＝「各階柱寸法」欄の値。未設定はルール既定 framing.columnSection の幅にフォールバック）。
 *   - 各部屋の kind・feature・壁材・壁仕上げ（roomOrder順、room.kind / room.feature /
 *     room.getFinishInfo() から。QA F9: 屋外化（kind=EXTERIOR）・UNDEFINED化は
 *     wallMaterial/wallFinish を変えずに壁生成結果（壁を持つか自体）を変えるため、鍵に含める）
 *
 * 部屋の扱い（重要）: isInteriorWallTarget 等の除外条件では部屋を落とさない——**全部屋を
 * 列挙する**。真の除外要否は wallGeneration.js 側の生成ロジックが持ち、ここは入力の一つとして
 * kind/feature をそのまま鍵に写すだけにする（除外判定をここで先取りして二重管理しない）。
 *
 * 鍵に含めない規約:
 *   - 材コードの区画は数値(mm)を含めない。幾何の区画（geo/cells/stairs/fh）だけ 0.001mm に丸めて
 *     ハッシュにする（区画ごとに別ハッシュ。どの入力が食い違ったか鍵文字列から読める）。
 *   - CL偏芯（clEccentricities）は含めない。編集口が仕上げモード内にしかなく、
 *     仕上げモードを抜けるときは必ず脱出境界（runFinishExitBoundary）を通るため。
 *   - 建具・天井区画（ceilingZones）・天井芯・直下階の階段も含めない（既知の限界）。
 *
 * 幾何の区画（v8）:
 *   - fh: 上階との階高（floorHeightAbove。2a の蹴上が読む。最上階は空）
 *   - geo: セル分割線（isFinishCellDivider＝通り芯・中心線。id 順）の種別・値（確定値 value。pendingDelta は含めない）・
 *     端の宣言値。梁芯・天井芯・補助線は対象外＝梁芯追従や構造再計算で鍵が動かず、再生成と収束する。
 *   - cells: 部屋のセル集合と参照先部屋（roomOrder 順）
 *   - stairs: 階段の配置項目（STAIR_KEY_FIELDS）とセル（id 順）
 *
 * @param {object} graph - PlanGraph（1階分）
 * @param {object|null} [project] - effectiveStructure の建物全体値解決に使う（省略可）
 * @returns {string}
 */
export function wallFreshnessKey(graph, project = null) {
  const ext = graph?.exteriorWallBacking ?? '';
  const int = graph?.interiorWallBacking ?? '';
  const shaft = graph?.shaftWallMaterial ?? '';
  const structure = effectiveStructure(graph, project) ?? '';
  const columnSection = woodColumnSectionId(graph, project) ?? '';

  const roomParts = (graph?.rooms ?? []).map(room => {
    const info = room.getFinishInfo?.() ?? {};
    return `${room.id}:${room.kind ?? ''}/${room.feature ?? ''}:${info.wallMaterial ?? ''}/${info.wallFinish ?? ''}`;
  });

  const fh = floorHeightAbove(project, graph?.plane) ?? '';

  return `${WALL_KEY_VERSION}|ext=${ext}|int=${int}|shaft=${shaft}|str=${structure}|col=${columnSection}|rooms=${roomParts.join(';')}`
    + `|fh=${fh}|geo=${geoPart(graph)}|cells=${cellsPart(graph)}|stairs=${stairsPart(graph)}`;
}
