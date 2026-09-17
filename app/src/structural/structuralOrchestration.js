// 構造モードのオーケストレーション（突入時セットアップ・他階への反映・主構造変更時の一括再計算）。
// App.jsx から状態を持たない純粋な形へ抽出したもの（挙動は元コードのまま）。
// React state（setStructComposition/setShowStructuralInfoDialog/setToast）は一切触らない——
// composition は戻り値で返し、toast は onToast コールバックで通知する。呼び出し側（App.jsx）が
// 戻り値を state へ反映する（.claude/mode-system.md「モード境界はレジストリに登録する」節）。
import { runInAction } from 'mobx';
import { undoManager } from '../undoManager.js';
import { serializeGraph, restoreGraph } from '../graphSnapshot.js';
import { ERR_STRUCT_MAIN_UNSPECIFIED } from '../error.js';
import { autoFillColumnsForStructure, autoFillColumnAxisOffsets, autoFillColumnSizes, resolveLowestGraph, convertMembersToEffectiveMaterial, deleteClassificationOverflow, UNSPECIFIED_STRUCTURE } from './structuralAutoFill.js';
import { conformWoodSections } from './woodAutoFill.js';
import { rulesFor, effectiveStructure, beamColumnWidthMm } from './structureRules.js';
import { collectWallBeamSources, autoFillWallBeamAxes, peekBelowGraph, wallRunSegments } from './wallBeamAxes.js';
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

// 下階（belowGraph）の柱集合の変更検知用シグネチャ（位置・役割のみ。順序に依存しない）。
// 下階編集経路（主構造変更時・突入時の反映を含む）の直後、上階柱直下の柱（ステップ3b）が
// 新たに立った/消えたかを見る——自階の梁分割（columnSplitPoints）・成算定（autoFillWoodBeamDepths）
// は下階柱位置を参照するため、下階柱集合が変わったのに自階を再計算し直さないと、古い下階柱を
// 前提にした分割・成のまま確定してしまう（ユーザー裁定2026-09-16「分割後に正しい距離を持つことが
// 最適解」。.claude/structural-model.md 参照）。sectionDefId 等の材寸変更（位置は変わらない）は
// 対象外——柱が増減・移動したときだけ別シグネチャになればよい。座標は浮動小数の誤差を避けるため
// 0.1mm単位に丸める。
// AXIS（axisX/axisY。偏心を含まない）で座標を取る——個別柱の偏心（woodColumnOffset.js）だけが
// 変わっても3b候補（上階柱直下の柱）の位置は変わらないため、無関係な再計算トリガーにしない
// （.claude/structural-model.md「AXISで一致・ACTUALで止める」）。
export function columnSetSignature(columns) {
  return columns
    .map(c => `${Math.round(c.axisX * 10) / 10}:${Math.round(c.axisY * 10) / 10}:${c.role}`)
    .sort()
    .join('|');
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
  // 自階床下材＝subjectGraph、1つ下の階の柱＝belowGraph。基礎伏図（1つ下が無い）は belowGraph=null。
  // mutate 実行前に解決する——mutate が下階（belowGraph）自身を書き換える操作（各階柱寸法の変更等。
  // 実機裁定ステップ4 C-2 QA2）に対応するため、belowGraph の before スナップショットも mutate 前に
  // 取っておく必要がある（後方の belowBefore 参照）。
  const belowGraph = composition.graphForCategory('columnMap');
  const belowBeforeRaw = (mutate && belowGraph) ? serializeGraph(belowGraph) : null;
  if (mutate) runInAction(mutate);
  // mutate が下階の編集可能peek（belowGraph）を書き換えた場合、この直後の subjectGraph 自身の再計算
  // （recomputeStructuralForGraph）が内部で行う下階への「別インスタンスの」fresh peek
  // （floorSwapManager.peek は毎回IDBから読む・undo-redo.md）が、下階のデバウンス保存（最大400ms）
  // 未反映のまま古い値を読んでしまう（実機観測: 各階柱寸法を変えた直後、同一伏図内の梁幅が
  // 旧値のまま食い違って見える）。保留中のデバウンス保存を確定してから読ませる
  // （flushEditablePeek。stopEditablePeekと同じ「読む前に書く」規律）。
  if (mutate && belowGraph) await floorSwapManager.flushEditablePeek();

  const belowMainStructure = belowGraph
    ? belowGraph.structureOverride ?? project.structuralInfo.mainStructure
    : subjectGraph.structureOverride ?? project.structuralInfo.mainStructure;

  // 自階：自動補完・柱芯・材変換・材寸算定・採番の収集（structuralRecompute.js。undo 非依存の純計算）。
  // 番号の確定（assignNumbers/applyNumbers）はまだ行わない——下階分の収集も済んでから1回だけ行う。
  // 自階の梁幅・梁成算定の材幅（beamColumnWidthMm）は内部で自前peekする下階graphを参照する
  // （↑のflushEditablePeekにより最新値が読める）。
  let { changed } = await recomputeStructuralForGraph(subjectGraph, project, belowMainStructure);

  // 1つ下の階（構造伏図に映る柱の供給元）も実効主構造へ揃える。突入時は reflectStructuralToOtherFloors が
  // 事前に下階を反映・永続化済みのため、ここは peek 済みバインディングへの差分適用（通常は差分ゼロ）。
  // 主構造変更時は既に commit 済みで編集可能 peek のため恒久化される——これにより
  // 「主構造を変えても下階の柱が旧材のまま取り残される」不具合を解消する。convertMembersToEffectiveMaterial は
  // 既存の旧材を変換、autoFillColumns は未生成分を新材で生成する（差分のみ）。
  // 主構造変更時のみ下階の before/after を取り、自階と同じ undo エントリで一括復元する。
  let belowBefore = belowBeforeRaw, belowAfter = null;
  // belowGraphから見た「1つ下の実体階」（belowGraph自身の梁が参照するbeamColumnWidthMmにも使う。
  // if(belowGraph)ブロックの外＝applyNumbers呼び出し側からも参照するため外側スコープに置く）。
  let belowBelowGraph = null;
  if (belowGraph) {
    // 突入時の順序（自階の再計算→下階の柱追加）により、直後の3b柱追加が自階の梁分割・成算定に
    // 間に合わない不整合があるため、下階柱集合の変更検知用に処理前のシグネチャを控えておく
    // （columnSetSignature参照）。
    const belowColumnsBefore = columnSetSignature(belowGraph.columns);
    const belowGate = await buildStructuralWallGate(belowGraph.plane, project, subjectGraph);
    const belowLowestGraph = await resolveLowestGraph(project, belowGraph);
    const belowStructure = belowGraph.structureOverride ?? project.structuralInfo.mainStructure;
    // 壁由来の梁芯生成（selfAndBelow＝在来木造のみ）と、在来木造の壁線上の通し梁（3c）が候補列挙に
    // 使う壁区間の両方で使い回す（追加peek 0回——非在来はrulesFor条件が効かずpeekしない。従来
    // collectWallBeamSourcesが内部で自前peekしていたのと同じ条件をここへ括り出した。wallBeamAxes
    // ==='selfAndBelow' は rules.framing truthy と同じ集合＝在来木造のみのため、beamColumnWidthMm
    // が要求する下々階もこの1回のpeekを共有してよい）。
    belowBelowGraph = rulesFor(belowStructure).wallBeamAxes === 'selfAndBelow'
      ? await peekBelowGraph(belowGraph, project) : null;
    // 壁由来の梁芯CL（マージ済み・下階込み）。在来木造の壁交点柱はこのCLをアンカーにするため、柱より先に生成する
    //（structuralRecompute.js の主経路と同じ順序。自階だけの未マージ source で作ると extent の短いCLが永続化される）。
    const belowWallSources = await collectWallBeamSources(belowGraph, project, belowBelowGraph);
    // 在来木造の壁線上の通し梁（3c）・上階柱直下の柱（3b）が候補列挙に使う壁区間（マージ不要）。
    // structuralRecompute.js の主経路（wallRunSegments）と同じ組み立て。
    const belowWallSegments = wallRunSegments(belowGraph, belowBelowGraph, belowStructure);
    // belowGraphから見た「1つ上の実体階」＝subjectGraph自身（メモリ上・peek不要）。ここを忘れると
    // 直前のreflectが作った下階の3b柱が、この再計算で候補から漏れて撤去されてしまう。
    const aboveColumnsForBelow = subjectGraph.columns;
    // belowMainStructure 引数は軒桁(eaves)専用。通常階の下階に eaves は無いため自階の実効値で十分。
    const belowBelowMainStructure = belowGraph.structureOverride ?? project.structuralInfo.mainStructure;
    runInAction(() => {
      convertMembersToEffectiveMaterial(belowGraph, project, belowBelowMainStructure);
      // belowGraph自身の梁が参照する「belowGraphを支える下々階」の柱寸の派生値を書く——
      // structuralRecompute.js と同じ唯一の書き込み規律（structureRules.js beamColumnWidthMmの
      // JSDoc参照。実機裁定ステップ4 C-2 QA2・QA4）。
      belowGraph.setBeamColumnWidthMm(beamColumnWidthMm(belowGraph, belowBelowGraph, project));
      // 在来木造: 既存断面を主構造ルールへそろえる（structuralRecompute.js と同じ）。
      conformWoodSections(belowGraph, project);
      autoFillWallBeamAxes(belowGraph, belowWallSources);
      // 主構造変更で柱が「×」化した場合は、下階の柱を生成せず既存の自動柱を削除する（「×は削除/○は生成」）。
      // 柱の配置源（通り芯交点／壁交点）は主構造ルールで振り分ける（autoFillColumnsForStructure）。
      if (structureHasMemberKind(MEMBER_KIND.COLUMN, belowStructure)) {
        autoFillColumnsForStructure(belowGraph, project, belowGate, aboveColumnsForBelow, belowWallSegments);
      }
      deleteClassificationOverflow(belowGraph, project);
      autoFillColumnAxisOffsets(belowGraph, project, belowLowestGraph);
      if (rulesFor(belowStructure).columnSizing !== 'fixed') autoFillColumnSizes(belowGraph, project, belowGraph.plane);
      // 在来木造columnMapのjoin照合を階スコープの加入署名で解決させるためrules・graph.plane.idを渡す
      // （QA裁定2026-09-17）。
      conformToLedger(belowGraph, project, rulesFor(belowStructure), belowGraph.plane.id);
      collectFloorGroups(belowGraph, project);
    });

    // 下階の柱集合が変わった（3b柱追加・削除等）ときだけ、自階をもう一度再計算し直す——
    // この関数の先頭で行った自階再計算（recomputeStructuralForGraph）は「3b柱追加前」の下階柱で
    // 梁分割・成算定を確定していたため、ここで確定し直さないと分割位置・成が古い下階柱のままになる
    // （ユーザー裁定2026-09-16）。
    // 下階の柱は自階に依存しない（3bは通り芯・壁・上階柱だけで決まる）ため、1回の再実行で収束する
    // ——ループはしない。belowGraphを直接渡して再peekしない（下階編集はまだIDBへ未反映のため。
    // structuralRecompute.js precomputedBelowGraphのJSDoc参照）。flushEditablePeekは主構造変更経路
    // （mutateがbelowGraph自身の編集可能peekを書き換えた場合）の保留保存を確定する「読む前に書く」
    // 規律を保つためのもので、突入時（編集可能peek未開始）はno-op。
    // **屋根専用平面（subjectGraph.plane.isRoofPlane）は再実行しない**（QA3-1・2026-09-17）：
    // composition の belowGraph（figure層の columnMap 供給階。drawingDesignation.js
    // structuralPlaneBelow は屋根なら「最上階」を返す）と、recomputeStructuralForGraph が
    // 自前peekする belowGraph（wallBeamAxes.js belowPlaneOf。屋根専用平面は project.planes に
    // 含まれないため常に null＝「屋根に1つ下の実体階は無い」）は別概念で、屋根では一致しない。
    // 一致しないまま precomputedBelowGraph（最上階の非null graph）を渡すと、1回目（belowGraph=null
    // ＝屋根自身の柱寸へフォールバック）と2回目（belowGraph=最上階＝最上階の柱寸を参照）とで
    // beamColumnWidthMm が食い違い、屋根伏図の軒桁材幅が最上階の柱寸へ静かに置き換わる
    // （実測: 最上階=105・屋根自身=120のとき、1回目120→2回目105 ×該当本数）。
    if (!subjectGraph.plane.isRoofPlane && columnSetSignature(belowGraph.columns) !== belowColumnsBefore) {
      await floorSwapManager.flushEditablePeek();
      const { changed: secondChanged } = await recomputeStructuralForGraph(subjectGraph, project, belowMainStructure, belowGraph);
      changed = changed || secondChanged;
    }
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
        resyncTouchedMemberGroups(subjectGraph, belowGraph, belowBelowGraph, project);
      },
      () => {
        restoreGraph(subjectGraph, after);
        if (belowAfter) restoreGraph(belowGraph, belowAfter);
        resyncTouchedMemberGroups(subjectGraph, belowGraph, belowBelowGraph, project);
      },
    );
  }
}

// undo/redo は restoreGraph でグラフの実体（entity.memberNo 含む）だけを戻すが、建物全体の採番索引
// （project.memberNumberIndex。非永続キャッシュ）は作り直さない——直前に collectFloorGroups が
// 積んだ「変更後」の floorRanks/counts が残ったままになり、構造リストのバッジ表示
// （例「1~3F・計106本」）が復元後の実体と食い違う（実機観測: 各階柱寸法の変更後にundoしても
// 柱グループのバッジが変更前に戻らない・材寸変更で消えた梁グループのバッジが復活しない）。
// collectFloorGroups は対象planeの寄与だけを「洗い替え」する純粋な操作（他階のエントリには触れない
// ——memberNumbering.js collectFloorGroups の設計）ため、今回のundo/redoで実体が変わった2階
// （subjectGraph・belowGraph）だけを再収集すれば索引全体が正しく揃う。建物全体の反映パス
// （reflectStructuralToOtherFloors）はここでは使わない——他階へのIDB peek/recompute/saveを伴い、
// 触れていない階まで巻き込む重い操作のため（このundo/redoが変更したのはsubjectGraph・belowGraphの
// 2階だけ）。
// restoreGraph は graph.clear() を内部で呼ぶため、beamColumnWidthMm（非永続の派生フィールド）も
// nullへ戻る——collectFloorGroups（standardBeamSectionFor経由でこの派生値を読む）を呼ぶ前に、
// structuralRecompute.js と同じ規律で beamColumnWidthMm を書き直す（QA指摘4: 派生値方式を
// undo/redoでも一貫させる。この関数もbeamColumnWidthMm(graph, belowGraph, project)を呼べる
// 「下階編集経路」に含まれる）。
function resyncTouchedMemberGroups(subjectGraph, belowGraph, belowBelowGraph, project) {
  runInAction(() => {
    subjectGraph.setBeamColumnWidthMm(beamColumnWidthMm(subjectGraph, belowGraph, project));
    collectFloorGroups(subjectGraph, project);
    if (belowGraph) {
      belowGraph.setBeamColumnWidthMm(beamColumnWidthMm(belowGraph, belowBelowGraph, project));
      collectFloorGroups(belowGraph, project);
    }
  });
}

// ---- 構造モード突入時のセットアップ（屋根平面同期・バインディング生成・再計算）----
// handleModeChange('structure') と、構造モード中のフロア切替（switchFloorKeepingMode）の両方から呼ぶ。
// @returns {Promise<object>} composition（呼び出し側が setStructComposition する）
export async function runStructuralModeSetup(targetGraph, project, { onToast } = {}) {
  const effectiveMainStructure = targetGraph.structureOverride ?? project.structuralInfo.mainStructure;
  if (effectiveMainStructure === UNSPECIFIED_STRUCTURE) {
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
export async function recomputeActiveStructural(project, pushUndo = true) {
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
// 戻り値の peek 済み graph（temp）はこの関数の呼び出し元だけが直後に使い、beamColumnWidthMm
// （非永続の派生値。collect時点の値）を読み終えたら手放す——建物全体の非アクティブ階を同時に
// メモリ上へ展開し続けるのは避け、常に「今処理している1階分」だけを生かす（QA指摘: apply側は
// 別途fresh peekし直すため、collect側のtempを跨いで保持する必要が無い）。
async function recomputeInactiveStructural(plane, project) {
  const temp = await floorSwapManager.peek(plane, project.structGraph);
  const mainStructure = temp.structureOverride ?? project.structuralInfo.mainStructure;
  const { changed } = await recomputeStructuralForGraph(temp, project, mainStructure);
  if (changed) await saveFloor(plane.id, serializeGraph(temp));
  return temp;
}

// 採番パス2: 直前に収集済みの project.memberNumberIndex を使って番号を適用し、変化があれば保存する。
// graph は都度 fresh peek し直す（collect時に使ったtempインスタンスをここまで生かし続けない——
// 同時に生きる非アクティブ階のgraphを常に1階分に戻すため。beamColumnWidthMmValueには collect
// フェーズで求めた同じ階の派生値（下階の柱寸。数値または未解決null）を渡し、apply対象へ書き戻して
// からapplyNumbersを呼ぶ——standardBeamSectionFor（groupKey算定）がこれを読むため、fresh peekした
// graphへ書き戻さないとcollect時点の標準材と食い違ってタグが引けなくなる（QA指摘4）。
async function applyMemberNumbersToFloor(plane, tags, project, beamColumnWidthMmValue) {
  const temp = await floorSwapManager.peek(plane, project.structGraph);
  let changed = false;
  runInAction(() => {
    temp.setBeamColumnWidthMm(beamColumnWidthMmValue);
    ({ changed } = applyNumbers(temp, project, tags));
  });
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
// 屋根専用平面の梁（role:'eaves'/'roof'）は WOOD_DEPTH_BEAM_ROLES に含まれず個別採番の対象外
// （standardBeamSectionFor由来のgroupKeyがそもそも効かない）ため、beamColumnWidthMm（派生値）が
// ここでは未再計算（null）のまま自階フォールバックになっても実害が無い——temp の使い捨て・
// apply非対応（下記コメント）と合わせ、派生値方式でも変更不要のまま自然に揃う。
async function collectRoofPlaneGroups(project) {
  const roofPlane = project.roofPlane;
  if (!roofPlane || roofPlane.id === project.activePlaneId) return; // アクティブなら既に収集済み
  const temp = await floorSwapManager.peek(roofPlane, project.structGraph);
  runInAction(() => {
    // 在来木造columnMapのjoin照合を階スコープの加入署名で解決させるためrules・graph.plane.idを渡す
    // （QA裁定2026-09-17）。
    conformToLedger(temp, project, rulesFor(effectiveStructure(temp, project)), temp.plane.id);
    collectFloorGroups(temp, project);
  });
}

export async function reflectStructuralToOtherFloors(project) {
  const activeId = project.activePlaneId;
  // 注意: 他階の再計算は隣接階を floorSwapManager.peek（毎回IDBから読む）で参照する。アクティブ階の
  // auto-save は dirty 印だけ（保存は deactivate/saveNow）なので、モード内の自階編集（各階柱寸法等）を
  // 他階へ読ませたい呼び出し元（構造モードの脱出境界。App.jsx runStructuralExitBoundary）は、この関数を
  // 呼ぶ前にアクティブ階を saveFloor しておくこと（QA指摘2026-09-16）。ここで保存しないのは、
  // IDB の無い単体テスト（wallRefresh.test.js 等）がこの関数を直接呼ぶため。
  runInAction(() => project.clearMemberNumberIndex());
  if (project.activeGraph) {
    // アクティブ階はここでは recomputeStructuralForGraph（structuralRecompute.js）を経由しない
    // 「収集だけ」の軽量経路のため、beamColumnWidthMm（下階基準の派生値）が誰にも書かれない窓が
    // できる——文書読込み直後・構造モードのままの階切替直後（runStructuralModeSetupがこのreflectを
    // recomputeStructuralCompositionより前に呼ぶ）は未再計算=nullのまま自階フォールバックで
    // collect/applyが走り、直後の自階再計算で正しい値へ戻るまでの一瞬だけ標準材の判定が自階基準へ
    // ずれる（実機観測: moku1・1階=105・アクティブ2階で、突入直後の反映パスで105×120×9本が
    // 2G18〜2G26へ分裂→直後の自階再計算で2G18へ戻る。振り直しトースト8件が毎回発生し、
    // オートセーブのタイミング次第で分裂した一時タグが保存されうる）。在来木造のときだけ下階を
    // 1回peekして書いてから収集する（非在来はpeek 0回のまま）。
    const activeRules = rulesFor(effectiveStructure(project.activeGraph, project));
    if (activeRules.framing) {
      const belowForActive = await peekBelowGraph(project.activeGraph, project);
      runInAction(() => project.activeGraph.setBeamColumnWidthMm(beamColumnWidthMm(project.activeGraph, belowForActive, project)));
    }
    runInAction(() => collectFloorGroups(project.activeGraph, project));
  }
  // 収集フェーズで求めた beamColumnWidthMm（下階基準の派生値。数値のみ）だけを保持し、peek済み
  // graphインスタンス自体は次のplaneへ進む前に手放す——建物全体の非アクティブ階を同時にメモリ上へ
  // 展開し続けない（同時に生きる非アクティブ階のgraphは常に1階分に戻す）。適用フェーズは
  // applyMemberNumbersToFloor が都度fresh peekし直し、保存しておいた数値を書き戻してから
  // applyNumbersを呼ぶ。
  const beamColumnWidthByPlaneId = new Map();
  for (const plane of project.planes) {
    if (plane.id === activeId) continue;
    const temp = await recomputeInactiveStructural(plane, project);
    beamColumnWidthByPlaneId.set(plane.id, temp.beamColumnWidthMm);
  }
  await collectRoofPlaneGroups(project);
  const tags = assignNumbers(project);
  if (project.activeGraph) runInAction(() => applyNumbers(project.activeGraph, project, tags));
  for (const plane of project.planes) {
    if (plane.id === activeId) continue;
    await applyMemberNumbersToFloor(plane, tags, project, beamColumnWidthByPlaneId.get(plane.id));
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
  const touched = []; // { plane, beamColumnWidthMm }（数値のみ保持。graphインスタンスは手放す——上記コメント参照）
  if (idx !== -1) {
    for (let i = idx + 1; i < planes.length; i++) {
      const temp = await recomputeInactiveStructural(planes[i], project);
      touched.push({ plane: planes[i], beamColumnWidthMm: temp.beamColumnWidthMm });
    }
  }
  if (!goingToStructure) {
    const tags = assignNumbers(project);
    if (project.activeGraph) runInAction(() => applyNumbers(project.activeGraph, project, tags));
    for (const { plane, beamColumnWidthMm: v } of touched) await applyMemberNumbersToFloor(plane, tags, project, v);
  }
}
