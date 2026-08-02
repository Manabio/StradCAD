import { runInAction } from 'mobx';
import { serializeGraph } from '../graphSnapshot.js';
import { buildStructuralWallGate, buildExteriorSide } from './wallGate.js';
import {
  autoFillStructuralGrid,
  autoFillColumnAxisOffsets,
  autoFillBeamEccentricity,
  resolveLowestGraph,
  convertMembersToEffectiveMaterial,
  autoFillColumnSizes,
  autoFillColumnBaseSizes,
  autoFillFoundationBeamSizes,
  autoFillRoofBeamSizes,
  autoFillMatFoundation,
  deleteClassificationOverflow,
} from './structuralAutoFill.js';
import { collectFloorGroups } from './memberNumbering.js';
import { conformToLedger } from './memberGroups.js';

/**
 * 構造モードの再計算パイプライン（「構造モードへの外部問合せ」の実体）。
 *
 * 構造体トポロジー（構造グリッド）から未定義の柱・梁・基礎を検出して自動補完し、柱芯・材変換・
 * 材寸算定・採番までを単一の graph に適用する純粋な再計算。図面合成（FigureComposition）・UI 配線・
 * roofPlane 同期・undo 登録には一切触れない——これらは呼び出し側（runStructuralModeSetup 等）の責務。
 *
 * 構造モード突入だけでなく、平面モードの階追加・仕上げモード退出といった遷移点から同じ計算を
 * ヘッドレスに呼べるよう切り出してある。突入経路と外部問合せ経路で計算が完全一致することを保証する。
 *
 * @param {PlanGraph} targetGraph  再計算対象のグラフ（変異する）。
 * @param {Project}   project
 * @param {string}    mainStructure  生成・材変換に用いる主構造（構造伏図では1つ下の階の実効主構造）。
 * @returns {Promise<{changed: boolean, before: Uint8Array, after: Uint8Array}>}
 *   before/after は undo 用スナップショット。changed=false のとき after===before（再シリアライズしない）。
 */
export async function recomputeStructuralForGraph(targetGraph, project, mainStructure) {
  // 建物フットプリント（部屋領域＝外壁線位置）の鉛直連続性で部材の有無を取捨するゲートを構築する
  // ＝自階かつ直下の全階で建物が連続する位置だけ部材を残す（直下に支えの無い梁・柱は省く）。
  // 非アクティブ下階は peek で覗く。自階に部屋が無い／屋根平面では null＝従来の全グリッド生成。wallGate.js 参照。
  const before = serializeGraph(targetGraph);
  const wallGate = await buildStructuralWallGate(targetGraph.plane, project, targetGraph);

  // 構造体トポロジーから未定義の柱・梁・基礎（基礎伏図のみ）を検出し、自動補完する。
  // ユーザーが明示削除した箇所は除外集合（excludedColumnSlots 等）により復活しない。
  const { newColumns, newFootings, newBeams } = runInAction(() => autoFillStructuralGrid(targetGraph, project, mainStructure, wallGate));
  // べた基礎（木造）のマットスラブを基礎伏図に生成・撤去する（基礎種別で取捨。問題.md）。基礎伏図以外では no-op。
  const matFoundation = runInAction(() => autoFillMatFoundation(targetGraph, project));
  // 外周モデル（side ビュー）を1回構築し、柱芯オフセットと梁偏芯の両方に渡す——柱・梁で外側方向（内外定義）を一致させる。
  // 自動補完の後に作るので、矩形フォールバック（仕上げ未定義時）は生成済み部材CLの外接矩形を見る。主題階基準で sync。
  const exterior = buildExteriorSide(targetGraph);
  // 柱芯（ColumnAxis）を自動生成・整合する（ラーメン系以外は0にリセット。差分のみ補完）。
  // 外面合わせの基準となる最下階graphを解決してから適用する（非アクティブ階は peek）。
  const lowestGraph = await resolveLowestGraph(project, targetGraph);
  runInAction(() => autoFillColumnAxisOffsets(targetGraph, project, lowestGraph, exterior));
  // 梁の偏芯量（柱芯⇄材芯）を faceGap から再算出し、柱外面と梁縁の一致（柱寸法・梁寸法変更に追従）を保つ。
  const updatedBeamEcc = runInAction(() => autoFillBeamEccentricity(targetGraph, project));
  // 別フロアにいる間に主要構造が変更された等で取りこぼした柱・梁を、実効主構造に合わせて変換する。
  const { convertedColumns, convertedBeams, convertedFootings } = runInAction(() => convertMembersToEffectiveMaterial(targetGraph, project, mainStructure));
  // 構造変更で「×」化した部材の自動生成分を削除する（問題.md「×は削除」。生成側は autoFillStructuralGrid の構造ゲート）。
  const removedByClass = runInAction(() => deleteClassificationOverflow(targetGraph, project));
  // 柱の負担床面積から柱幅・柱脚サイズを再算定する（dimensionStatus==='auto'の部材のみ。ロック済みは保持）。
  // 柱は自階graphに属するため、支える階数(N)も自階（targetGraph.plane）基準で算定する。
  const updatedColumnSizes = runInAction(() => autoFillColumnSizes(targetGraph, project, targetGraph.plane));
  const updatedFootingSizes = runInAction(() => autoFillColumnBaseSizes(targetGraph, project));
  // 基礎梁(role:'foundation')の梁幅b・梁成Dを、建物全体の最長スパン・最大柱幅から再算定する。
  const updatedBeamSizes = runInAction(() => autoFillFoundationBeamSizes(targetGraph, project));
  // 軒桁を含む横架材(role:'eaves')の梁幅b・梁成Dを、屋上伏図自身の最長スパンから再算定する。
  const updatedRoofBeamSizes = runInAction(() => autoFillRoofBeamSizes(targetGraph));
  // 採番の収集フェーズ: 台帳（分割・統合の明示操作）へ conform し、材寸グループを
  // project.memberNumberIndex（建物全体、非永続キャッシュ）へ積む。番号の確定（assignNumbers/applyNumbers）
  // は建物全体の情報が必要なため、呼び出し側（App.jsx の反映パス）が2パス目として行う。
  runInAction(() => {
    conformToLedger(targetGraph, project);
    collectFloorGroups(targetGraph, project);
  });

  const changed = newColumns.length > 0 || newFootings.length > 0 || newBeams.length > 0
    || matFoundation.created.length > 0 || matFoundation.removed.length > 0
    || convertedColumns.length > 0 || convertedBeams.length > 0 || convertedFootings.length > 0
    || removedByClass.length > 0
    || updatedColumnSizes.length > 0 || updatedFootingSizes.length > 0 || updatedBeamSizes.length > 0
    || updatedRoofBeamSizes.length > 0 || updatedBeamEcc.length > 0;
  const after = changed ? serializeGraph(targetGraph) : before;
  return { changed, before, after };
}
