/**
 * 壁の鮮度キー（fresh­ness key） — 壁の入力（下地材コード・主構造・部屋の壁材/壁仕上げ）から
 * 決定的な文字列を作る純関数。graph.wallFreshnessKey へ保存し、キー不一致で壁を再生成する
 * 方式（壁の再生成をFinishModeStateから独立させる計画）のステップ1で導入する。
 * ステップ1では鍵の計算・保存のみを行い、比較・再生成起動は行わない（挙動ゼロ変化）。
 *
 * 依存は structural/structureRules.js だけにする（材マスタ・wallGeneration を import しない）。
 * 鍵の比較は壁境界を跨がず毎回走らせたいが、再生成そのものは不一致時だけに限定したい
 * ——両者を別モジュールに分けておくための制約。
 */
import { effectiveStructure, woodColumnSectionId } from '../structural/structureRules.js';

/**
 * 鍵の書式バージョン。材マスタ（壁材/壁仕上げ/下地材の実体）や壁生成規則
 * （wallGeneration.js / edgeComposition.js の導出式）を変えたら、鍵の入力が同じでも
 * 出力壁が変わりうるため、ここを上げて既存キーを一律不一致にする。
 * v2: 柱寸法が基準（120）より細い階の外壁下地帯シフト導入（wallGeneration.js
 * generateExteriorWalls/generateRoomWallsFromOutline の bandShift。鍵の入力は変えていないが
 * 生成式が変わったため既存キーを一律不一致にする）。
 */
export const WALL_KEY_VERSION = 'v2';

/**
 * graph（1階分）の壁再生成に必要な入力から鍵文字列を作る。
 *
 * 鍵に含めるもの:
 *   - 外壁下地・内壁下地の材コード（graph.exteriorWallBacking / interiorWallBacking）
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
 *   - 数値(mm) は含めない。材コードだけで組み立てるため丸め規約が不要になる。
 *   - CL偏芯（clEccentricities）は含めない。編集口が仕上げモード内にしかなく、
 *     仕上げモードを抜けるときは必ず脱出境界（runFinishExitBoundary）を通るため。
 *
 * @param {object} graph - PlanGraph（1階分）
 * @param {object|null} [project] - effectiveStructure の建物全体値解決に使う（省略可）
 * @returns {string}
 */
export function wallFreshnessKey(graph, project = null) {
  const ext = graph?.exteriorWallBacking ?? '';
  const int = graph?.interiorWallBacking ?? '';
  const structure = effectiveStructure(graph, project) ?? '';
  const columnSection = woodColumnSectionId(graph, project) ?? '';

  const roomParts = (graph?.rooms ?? []).map(room => {
    const info = room.getFinishInfo?.() ?? {};
    return `${room.id}:${room.kind ?? ''}/${room.feature ?? ''}:${info.wallMaterial ?? ''}/${info.wallFinish ?? ''}`;
  });

  return `${WALL_KEY_VERSION}|ext=${ext}|int=${int}|str=${structure}|col=${columnSection}|rooms=${roomParts.join(';')}`;
}
