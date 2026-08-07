// 構造モードのオーケストレーション（突入時セットアップ・他階への反映・主構造変更時の一括再計算）。
// App.jsx から状態を持たない純粋な形へ抽出したもの（挙動は元コードのまま）。
// React state（setStructComposition/setShowStructuralInfoDialog/setToast）は一切触らない——
// composition は戻り値で返し、toast は onToast コールバックで通知する。呼び出し側（App.jsx）が
// 戻り値を state へ反映する（.claude/mode-system.md「モード境界はレジストリに登録する」節）。
import { runInAction } from 'mobx';
import { undoManager } from '../undoManager.js';
import { serializeGraph, restoreGraph } from '../graphSnapshot.js';
import { ERR_STRUCT_MAIN_UNSPECIFIED } from '../error.js';
import { autoFillColumns, autoFillColumnAxisOffsets, autoFillColumnSizes, resolveLowestGraph, convertMembersToEffectiveMaterial, deleteClassificationOverflow } from './structuralAutoFill.js';
import { structureHasMemberKind, MEMBER_KIND } from './structuralClassification.js';
import { buildStructuralWallGate } from './wallGate.js';
import { collectFloorGroups, assignNumbers, applyNumbers } from './memberNumbering.js';
import { conformToLedger } from './memberGroups.js';
import { recomputeStructuralForGraph } from './structuralRecompute.js';
import { syncRoofPlane } from './roofPlane.js';
import { figureBindingManager } from '../figure/FigureBindingManager.js';
import { floorSwapManager } from '../storage/FloorSwapManager.js';
import { saveFloor } from '../storage/db.js';
import { getFigure } from '../figure/figureRegistry.js';
import { STRUCTURAL_FIGURE_ID } from './structuralFigure.js';

// applyNumbers の renumbered（既存タグが別タグへ変わった遷移一覧）から、モード境界の再採番トーストを
// 1回だけ出す（初回採番=null→タグ は applyNumbers 側で除外済みのためここでは判定不要）。
// 代表1件＋残りは「他N件」で簡潔に（設計意図: design-member-numbering-ui.md 5節）。
function reportRenumberToast(renumbered, onToast) {
  if (!renumbered.length) return;
  const [first] = renumbered;
  const extra = renumbered.length - 1;
  onToast?.(`材寸の変更にともない部材番号を振り直しました（${first.from} → ${first.to}${extra > 0 ? ` 他${extra}件` : ''}）`);
}

// ---- 構造再計算コア（突入時・主構造変更時で共有）----
// 既に activate 済みの composition を受け取り、構造伏図に映る全グラフ（自階＋1つ下の階）を再計算する。
// mutate（主構造の変更操作）を渡すと、自階スナップショットの before 取得後・after 取得前に runInAction で
// 実行し、主構造変更と部材の生成・材変換・採番をまとめて1つの undo エントリにする（override は graph
// snapshot に含まれるため undo で戻る。建物全体既定値 mainStructure は project 側のため従来どおり対象外）。
// 主構造変更時（mutate あり）は下階グラフ（伏図に映る柱の供給元）も同じ undo エントリで戻す。
// 突入時（mutate なし）は自階 recompute の差分があるときだけ undo を積む（下階は表示用 peek＝undo 非対象。従来挙動を保持）。
export async function recomputeStructuralComposition(composition, subjectGraph, project, { mutate, onToast } = {}) {
  const before = serializeGraph(subjectGraph);
  if (mutate) runInAction(mutate);

  // 自階床下材＝subjectGraph、1つ下の階の柱＝belowGraph。基礎伏図（1つ下が無い）は belowGraph=null。
  const belowGraph = composition.graphForCategory('columnMap');
  const belowMainStructure = belowGraph
    ? belowGraph.structureOverride ?? project.structuralInfo.mainStructure
    : subjectGraph.structureOverride ?? project.structuralInfo.mainStructure;

  // 自階：自動補完・柱芯・材変換・材寸算定・採番の収集（structuralRecompute.js。undo 非依存の純計算）。
  // 番号の確定（assignNumbers/applyNumbers）はまだ行わない——下階分の収集も済んでから1回だけ行う。
  const { changed } = await recomputeStructuralForGraph(subjectGraph, project, belowMainStructure);

  // 1つ下の階（構造伏図に映る柱の供給元）も実効主構造へ揃える。突入時は reflectStructuralToOtherFloors が
  // 事前に下階を反映・永続化済みのため、ここは peek 済みバインディングへの差分適用（通常は差分ゼロ）。
  // 主構造変更時は既に commit 済みで編集可能 peek のため恒久化される——これにより
  // 「主構造を変えても下階の柱が旧材のまま取り残される」不具合を解消する。convertMembersToEffectiveMaterial は
  // 既存の旧材を変換、autoFillColumns は未生成分を新材で生成する（差分のみ）。
  // 主構造変更時のみ下階の before/after を取り、自階と同じ undo エントリで一括復元する。
  let belowBefore = null, belowAfter = null;
  if (belowGraph) {
    const belowGate = await buildStructuralWallGate(belowGraph.plane, project, subjectGraph);
    const belowLowestGraph = await resolveLowestGraph(project, belowGraph);
    // belowMainStructure 引数は軒桁(eaves)専用。通常階の下階に eaves は無いため自階の実効値で十分。
    const belowBelowMainStructure = belowGraph.structureOverride ?? project.structuralInfo.mainStructure;
    if (mutate) belowBefore = serializeGraph(belowGraph);
    const belowStructure = belowGraph.structureOverride ?? project.structuralInfo.mainStructure;
    runInAction(() => {
      convertMembersToEffectiveMaterial(belowGraph, project, belowBelowMainStructure);
      // 主構造変更で柱が「×」化した場合は、下階の柱を生成せず既存の自動柱を削除する（問題.md「×は削除/○は生成」）。
      if (structureHasMemberKind(MEMBER_KIND.COLUMN, belowStructure)) autoFillColumns(belowGraph, project, belowGate);
      deleteClassificationOverflow(belowGraph, project);
      autoFillColumnAxisOffsets(belowGraph, project, belowLowestGraph);
      autoFillColumnSizes(belowGraph, project, belowGraph.plane);
      conformToLedger(belowGraph, project);
      collectFloorGroups(belowGraph, project);
    });
  }

  // 自階＋下階の収集が揃った時点の project.memberNumberIndex（直前の reflectStructuralToOtherFloors が
  // 積んだ他階分を含む）で1回だけ採番し、両方へ適用する（memberNumbering.js の2パス方式）。
  // ここが「ユーザーが今見ている画面の番号が確定する」地点のため、材寸変更にともなう振り直しの
  // トーストもここで報告する（初回採番=null→タグ は applyNumbers 側で除外済み）。
  const tags = assignNumbers(project);
  const renumbered = [];
  runInAction(() => {
    renumbered.push(...applyNumbers(subjectGraph, project, tags).renumbered);
    if (belowGraph) renumbered.push(...applyNumbers(belowGraph, project, tags).renumbered);
  });
  reportRenumberToast(renumbered, onToast);
  if (belowGraph && mutate) belowAfter = serializeGraph(belowGraph);

  const after = serializeGraph(subjectGraph);
  if (mutate || changed) {
    undoManager.push(
      () => {
        restoreGraph(subjectGraph, before);
        if (belowBefore) restoreGraph(belowGraph, belowBefore);
      },
      () => {
        restoreGraph(subjectGraph, after);
        if (belowAfter) restoreGraph(belowGraph, belowAfter);
      },
    );
  }
}

// ---- 構造モード突入時のセットアップ（屋根平面同期・バインディング生成・再計算）----
// handleModeChange('structure') と、構造モード中のフロア切替（switchFloorKeepingMode）の両方から呼ぶ。
// @returns {Promise<object>} composition（呼び出し側が setStructComposition する）
export async function runStructuralModeSetup(targetGraph, project, { onToast } = {}) {
  const effectiveMainStructure = targetGraph.structureOverride ?? project.structuralInfo.mainStructure;
  if (effectiveMainStructure === '未定') {
    onToast?.(ERR_STRUCT_MAIN_UNSPECIFIED);
  }

  // 最上階の直上に屋根専用平面（小屋伏／R階伏）を同期する（undo対象外。建物形状が変わった時点でやり直し前提のインフラ）。
  runInAction(() => syncRoofPlane(project));

  // 突入時点でアクティブ階以外の全実体階へも構造部材を反映・永続化する（undo対象外インフラ）。
  // 自階だけの再計算では「訪れた伏図の階」にしか部材が入らず、他の伏図・他モードの図面が空のままになる。
  // バインディング構築より先に行うことで、下階レイヤの peek は反映済みデータを読む
  // （表示用 autofill は差分ゼロとなり、編集可能 peek のベースラインとも一致する）。
  await reflectStructuralToOtherFloors(project);

  // 図面合成（構造伏図＝自階床下材＋1つ下の階の柱）のバインディングを組み立てる。
  // 非アクティブな下階は FigureBindingManager 内部で floorSwapManager.peek() により読み取り専用に覗く
  // （graph.structureOverride はメモリ上信頼できないため。詳細は data-model.md / structural-model.md）。
  const composition = await figureBindingManager.activate(getFigure(STRUCTURAL_FIGURE_ID), targetGraph.plane, targetGraph, project);

  // 自階＋下階の再計算（突入時・主構造変更時で共有する純計算コア）。
  await recomputeStructuralComposition(composition, targetGraph, project, { onToast });

  // 下階の柱は、その伏図の構造リストから編集する（描画対象＝編集対象を一致させる）。
  // 表示用 autofill 完了後に commit して secondaryEdit バインディング（下階）を編集可能 peek 化する。
  // 基礎伏図（下階なし）は secondaryEdit バインディングが無く編集チャネルは張られない。
  figureBindingManager.commit(composition);

  // composition の state 反映は commit 後に呼出側で行う（commit は同期・render は挟まらないため従来と同値）。
  return composition;
}

// ---- 構造モードへの外部問合せ（階追加・仕上げ退出時に、構造モードに入らず構造部材を更新する）----
// mainStructure は屋根平面（軒桁）でのみ意味を持つが、ここでの対象は常に実体階なので自階の実効値でよい。

// アクティブな graph を再計算し、変化があれば undo に積む（通常の auto-save に乗る）。
// pushUndo=false は階追加フロー用（withFloorAddUndo が全階分を1エントリで巻き戻すため個別には積まない）。
async function recomputeActiveStructural(project, pushUndo = true) {
  const g = project.activeGraph;
  const mainStructure = g.structureOverride ?? project.structuralInfo.mainStructure;
  const { changed, before, after } = await recomputeStructuralForGraph(g, project, mainStructure);
  if (changed && pushUndo) {
    undoManager.push(
      () => restoreGraph(g, before),
      () => restoreGraph(g, after),
    );
  }
}

// 非アクティブな実体階を peek して再計算し、変化があれば IDB に直接保存する。
// syncRoofPlane と同格の「建物形状が変わった時点でやり直すインフラ」として undo 対象外で割り切る
// （跨ぎフロア undo は単一アクティブ graph モデルでは扱えないため。削除の取消はベースライン保持で担保する）。
// 採番は収集（conformToLedger + collectFloorGroups。structuralRecompute.js）のみ行い、番号の確定は
// 呼び出し側（reflectStructuralToOtherFloors 等）が全階の収集後に1回だけ行う。
async function recomputeInactiveStructural(plane, project) {
  const temp = await floorSwapManager.peek(plane, project.structGraph);
  const mainStructure = temp.structureOverride ?? project.structuralInfo.mainStructure;
  const { changed } = await recomputeStructuralForGraph(temp, project, mainStructure);
  if (changed) await saveFloor(plane.id, serializeGraph(temp));
}

// 採番パス2: 直前に収集済みの project.memberNumberIndex を使って plane 1つへ番号を適用し、
// 変化があれば保存する（非アクティブ階を peek→適用→保存。全階を同時にメモリ展開しない）。
async function applyMemberNumbersToFloor(plane, tags, project) {
  const temp = await floorSwapManager.peek(plane, project.structGraph);
  let changed = false;
  runInAction(() => { ({ changed } = applyNumbers(temp, project, tags)); });
  if (changed) await saveFloor(plane.id, serializeGraph(temp));
}

// アクティブ階以外の全実体階の構造部材を peek+再計算+保存で反映する（undo 対象外の決定的インフラ）。
// 構造モードの境界（突入・脱出）と階追加フローが共有する「他階への構造反映」の単一実装——
// これが無いと、構造モードで生成・編集した部材が「訪れた伏図の階」にしか入らず、
// 他モード・他階へ移動したときに他の伏図・平面図へ構造部材が現れない（問題.md）。
//
// 材寸グループ採番は建物全体の情報が必要なため2パスで行う（memberNumbering.js）:
//   パス1（収集）: 自階（メモリ上の現状）＋他の全実体階（peek→recompute→保存）を
//                  project.memberNumberIndex へ積む。
//   パス2（採番・適用）: assignNumbers を建物全体で1回だけ実行し、自階＋他の全実体階へ適用する
//                  （変化があった階のみ保存）。
// 屋根専用平面（isRoofPlane）は project.planes に含まれない（採番の「実体階」ループの対象外）ため、
// 上の収集ループでは漏れる。屋根専用平面だけの記号（RF/PR/EG等）が収集から欠けると、記号ごとの
// 階プレフィックス要否判定（needsPrefix。屋根グループの有無で階集合の同一性が変わる）が
// 「屋根平面を直接訪れたかどうか」で揺れ、既存タグが行き来する誤った再採番トーストの原因になる。
// 屋根専用平面には自階再計算（recomputeStructuralForGraph。mainStructureの解決に図面合成が要る）を
// 素直には適用できないため、最低ラインとして「収集だけ」を常に行う（peekしたグラフは保存しない・
// 番号も書き戻さない。実際の番号確定はユーザーが屋根伏図を直接訪れたときの通常経路に委ねる）。
async function collectRoofPlaneGroups(project) {
  const roofPlane = project.roofPlane;
  if (!roofPlane || roofPlane.id === project.activePlaneId) return; // アクティブなら既に収集済み
  const temp = await floorSwapManager.peek(roofPlane, project.structGraph);
  runInAction(() => {
    conformToLedger(temp, project);
    collectFloorGroups(temp, project);
  });
}

export async function reflectStructuralToOtherFloors(project) {
  const activeId = project.activePlaneId;
  runInAction(() => project.clearMemberNumberIndex());
  if (project.activeGraph) runInAction(() => collectFloorGroups(project.activeGraph, project));
  for (const plane of project.planes) {
    if (plane.id === activeId) continue;
    await recomputeInactiveStructural(plane, project);
  }
  await collectRoofPlaneGroups(project);
  const tags = assignNumbers(project);
  if (project.activeGraph) runInAction(() => applyNumbers(project.activeGraph, project, tags));
  for (const plane of project.planes) {
    if (plane.id === activeId) continue;
    await applyMemberNumbersToFloor(plane, tags, project);
  }
}

// 要件1：階追加後。追加で N（負担階数）・基礎指定が変わるため、全実体階の構造部材を更新する。
// アクティブ（追加直後の表示階）はメモリ上で、その他の実体階は peek+保存で反映する。
// undo は個別に積まない（呼び出し元の withFloorAddUndo が階追加フロー全体を1エントリで記録する）。
// これにより別階・別モードへ移動したとき、更新後の柱・梁・材寸がそのまま描画される。
export async function reflectStructuralAfterFloorAdd(project) {
  await recomputeActiveStructural(project, false);
  await reflectStructuralToOtherFloors(project);
}

// 要件2：仕上げモード退出後。フットプリント（外壁線・吹抜け）変更は鉛直連続性ゲートにより
// 自階と「自階より上の全実体階」のゲートに効く（wallGate.js：基準階＋直下の全階のAND）。
// そのため自階（アクティブ）＋上の全階を再計算する。下階は影響を受けない。
// 退出先が構造モードのときは runStructuralModeSetup が自階を再計算するため、自階・番号確定は
// そちら（reflectStructuralToOtherFloors）に委ねる。退出先が構造モードでない場合はここで
// 採番も確定する（次に構造モードへ入るまで番号が未確定のままにならないよう、直近の収集結果で確定する）。
export async function reflectStructuralAfterFinishExit(currentPlaneId, goingToStructure, project) {
  if (!goingToStructure) await recomputeActiveStructural(project);
  const planes = project.planes; // elevation 昇順
  const idx = planes.findIndex(p => p.id === currentPlaneId);
  const touchedPlanes = [];
  if (idx !== -1) {
    for (let i = idx + 1; i < planes.length; i++) {
      await recomputeInactiveStructural(planes[i], project);
      touchedPlanes.push(planes[i]);
    }
  }
  if (!goingToStructure) {
    const tags = assignNumbers(project);
    if (project.activeGraph) runInAction(() => applyNumbers(project.activeGraph, project, tags));
    for (const plane of touchedPlanes) await applyMemberNumbersToFloor(plane, tags, project);
  }
}
