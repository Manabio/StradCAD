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
import { collectWallBeamSources, autoFillWallBeamAxes, peekBelowGraph, wallRunSegments, columnSeedBeamSegments, createWallSourceCache } from './wallBeamAxes.js';
import { structureHasMemberKind, MEMBER_KIND } from './structuralClassification.js';
import { buildStructuralWallGate, createFootprintCache } from './wallGate.js';
import { collectFloorGroups, assignNumbers, applyNumbers } from './memberNumbering.js';
import { conformToLedger } from './memberGroups.js';
import { recomputeStructuralForGraph } from './structuralRecompute.js';
import { syncRoofPlane } from './roofPlane.js';
import { structuralPlaneBelow } from './drawingDesignation.js';
import { figureBindingManager } from '../figure/FigureBindingManager.js';
import { floorSwapManager } from '../storage/FloorSwapManager.js';
import { peekVia, saveVia } from './structuralPeek.js';
import { createStructuralResolveContext } from './structuralResolveContext.js';
import { getFigure } from '../figure/figureRegistry.js';
import { STRUCTURAL_FIGURE_ID } from './structuralFigure.js';

// 反映パス（reflectStructuralToOtherFloors・reflectStructuralAfterFinishExit）を「収束するまで
// 繰り返す」ときの上限回数（リード裁定・2026-09-19。小屋伏図にも梁・柱ルールを適用する計画）。
// 到達しても例外にはせず、最後の状態のまま打ち切って console.warn で1回だけ知らせる
// （storage/db.js・storage/sessionLock.js と同じ「フォールバックしつつ警告する」流儀）。
export const MAX_REFLECT_PASSES = 8;

/**
 * 反映パス本体（runPass）を、いずれかの階（屋根を含む）がchangedを返し、かつ反映対象に在来木造
 * （beamPlacement:'wallRuns'）の階が1つでも含まれる限り、同じ順序で繰り返す（リード裁定・
 * 2026-09-19。reflectStructuralToOtherFloors・reflectStructuralAfterFinishExit が共有する）。
 * 上限 MAX_REFLECT_PASSES に到達しても例外にはせず、最後の状態のまま打ち切って console.warn で
 * 1回だけ知らせる（storage/db.js・storage/sessionLock.js と同じ「フォールバックしつつ警告する」流儀）。
 * export しているのは runPass にスタブを渡して上限打ち切りを直接テストするため（本体側は常に
 * 実際の反映パスのクロージャを渡す）。
 * @param {() => Promise<{anyChanged: boolean, sawWallRuns: boolean}>} runPass - 1回分の反映パス
 *   本体。呼び出し側がその中で結果（beamColumnWidthMm等）を蓄積し、changed・isWallRunsの集計だけを
 *   戻り値で返すこと。
 * @param {string} label - console.warn に出す関数名（呼び出し元を識別するため）。
 */
export async function repeatReflectPassUntilConverged(runPass, label) {
  for (let pass = 1; pass <= MAX_REFLECT_PASSES; pass++) {
    const { anyChanged, sawWallRuns } = await runPass();
    if (!sawWallRuns || !anyChanged) return;
    if (pass === MAX_REFLECT_PASSES) {
      console.warn(`[${label}] ${MAX_REFLECT_PASSES}回反映しても収束しませんでした（最後の状態のまま打ち切ります）`);
    }
  }
}

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
// 建具の袖柱（column.woodJambRef非null）もAXISが開口位置から都度導出される値のため、この関数を
// 変更せずにそのまま扱える——袖側（side:-1|1）ごとにAXIS座標そのものが異なるため、「同一CLペアの
// 両袖」問題（袖柱がCLペアだけを見るcolumnSlotKeyでは区別できない）はAXIS導出の側で解消済み
// （core/structuralEntities.js columnAnchorKey・_woodJambAxis参照）。ここへcolumnAnchorKeyを
// 足すことも検討したが、本関数は下階柱の位置比較専用に軽量な {axisX,axisY,role} だけのプレーン
// オブジェクトで呼ばれるテストが多数あり（structuralOrchestration.test.js）、verticalCL/
// horizontalCLを要求するcolumnAnchorKeyを噛ませると実在しないプロパティの参照で例外になる。
// 決定：この関数は現状のAXIS+role方式のまま据え置く（columnAnchorKeyは足さない）。AXISが柱ごとに
// 一意であることは重なり判定（woodAutoFill.js rectsOverlap。3a/3b/3h-2(CL解決分)→3h-2(オフセット分)→
// 袖柱の評価順で、既存柱・候補柱と重なる新規候補は生成しない）がAXIS基準で保証しており、
// columnAnchorKeyが持つ追加の判別能力（jamb:/off:の由来区別）は本関数の用途（下階柱集合が
// 増減・移動したかの検知）には効かない——由来が変わっても同じAXISに柱が1本立つだけなら
// シグネチャは変わらなくてよく、変わるべきなのはAXIS集合そのものが変化したときだけのため。
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
// pushUndo=false は構造モード突入の外側収束ループ用（runStructuralModeSetup が複数回呼ぶ間は個別に
// 積まず、ループ収束後に1回だけ最初のbefore・最後のafterでundoを積むため）。戻り値の changed・
// belowGraph・belowBelowGraph は、その1回化されたundoエントリを呼び出し側が組み立てるために返す
// （resyncTouchedMemberGroupsが必要とする引数と同じ）。
// ctx（解決コンテキスト。構造再計算高速化ステップB）は省略可能——受け取って内部のpeek地点
// （buildStructuralWallGate・resolveLowestGraph・peekBelowGraph・recomputeStructuralForGraph）へ
// 下へ渡すだけで、自分では生成しない（生成は境界処理側のwithResolveContextが担う）。
// belowFootprintCache・belowWallSourceCacheはこの下階編集経路専用のローカルキャッシュのまま
// 据え置く（ctx由来にはしない）。
export async function recomputeStructuralComposition(composition, subjectGraph, project, { mutate, onToast, pushUndo = true, ctx = undefined } = {}) {
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

  // 呼び出し側（runStructuralModeSetupの外側収束ループ）が「在来木造の階が無ければ必ず1回で
  // 終わる」を保証するためのゲート——reflectStructuralToOtherFloorsのsawWallRunsと同じ規約
  // （自階または下階のどちらかが実質wallRunsなら在来木造とみなす）。自階が屋根専用平面のときは
  // beamPlacementではなくroofBeamPlacementで判定する（structureRules.js ステップ2）——現行の
  // ルール定義では在来木造だけが両方とも'wallRuns'のため実害は無いが、選択子の対応を正しく保つ。
  const subjectIsRoof = subjectGraph.plane.isRoofPlane === true;
  const subjectRules = rulesFor(effectiveStructure(subjectGraph, project));
  let isWallRuns = (subjectIsRoof ? subjectRules.roofBeamPlacement : subjectRules.beamPlacement) === 'wallRuns';

  // 自階：自動補完・柱芯・材変換・材寸算定・採番の収集（structuralRecompute.js。undo 非依存の純計算）。
  // 番号の確定（assignNumbers/applyNumbers）はまだ行わない——下階分の収集も済んでから1回だけ行う。
  // 自階の梁幅・梁成算定の材幅（beamColumnWidthMm）は内部で自前peekする下階graphを参照する
  // （↑のflushEditablePeekにより最新値が読める）。
  let { changed } = await recomputeStructuralForGraph(subjectGraph, project, belowMainStructure, undefined, { ctx });

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
    // ステップA: belowGateのspanInBuilding/intersectionInBuildingはこの後（autoFillColumnsForStructure等）
    // 何度も呼ばれる——その場でローカルに1個だけキャッシュを作り、この1回のbuildStructuralWallGate呼び出しの
    // 間だけフットプリント索引を確定する（belowWallSourceCacheと同じ「その場で作って近接する呼び出しで
    // 共有する程度に留める」リード裁定のスコープ内）。
    const belowFootprintCache = createFootprintCache();
    const belowGate = await buildStructuralWallGate(belowGraph.plane, project, subjectGraph, belowFootprintCache, ctx);
    const belowLowestGraph = await resolveLowestGraph(project, belowGraph, ctx);
    const belowStructure = belowGraph.structureOverride ?? project.structuralInfo.mainStructure;
    isWallRuns = isWallRuns || rulesFor(belowStructure).beamPlacement === 'wallRuns';
    // 壁由来の梁芯生成（selfAndBelow＝在来木造のみ）と、在来木造の壁線上の通し梁（3c）が候補列挙に
    // 使う壁区間の両方で使い回す（追加peek 0回——非在来はrulesFor条件が効かずpeekしない。従来
    // collectWallBeamSourcesが内部で自前peekしていたのと同じ条件をここへ括り出した。wallBeamAxes
    // ==='selfAndBelow' は rules.framing truthy と同じ集合＝在来木造のみのため、beamColumnWidthMm
    // が要求する下々階もこの1回のpeekを共有してよい）。
    belowBelowGraph = rulesFor(belowStructure).wallBeamAxes === 'selfAndBelow'
      ? await peekBelowGraph(belowGraph, project, ctx) : null;
    // 壁由来の梁芯CL（マージ済み・下階込み）。在来木造の壁交点柱はこのCLをアンカーにするため、柱より先に生成する
    //（structuralRecompute.js の主経路と同じ順序。自階だけの未マージ source で作ると extent の短いCLが永続化される）。
    // ステップC: この2呼び出し（collectWallBeamSources→内部でwallRunSegments・直後の明示的wallRunSegments）は
    // 同じbelowGraph・belowBelowGraphの壁区間を2度全走査していたため、ここでローカルに1個だけ
    // キャッシュを作って共有する（寿命はこの下階編集経路1回分。recomputeStructuralForGraph側の
    // wallSourceCacheとは別物——ここで生成する下階柱（autoFillColumnsForStructure(belowGraph,...)）内部の
    // selfWallSegments(belowGraph)までは届けない。「その場でローカルに1個作って2つの呼び出しで共有する
    // 程度に留める」というリード裁定のスコープ内）。
    const belowWallSourceCache = createWallSourceCache();
    const belowWallSources = await collectWallBeamSources(belowGraph, project, belowBelowGraph, belowWallSourceCache, ctx);
    // 在来木造の壁線上の通し梁（3c）・上階柱直下の柱（3b）が候補列挙に使う壁区間（マージ不要）。
    // structuralRecompute.js の主経路（wallRunSegments）と同じ組み立て。
    const belowWallSegments = wallRunSegments(belowGraph, belowBelowGraph, belowStructure, belowWallSourceCache);
    // belowGraphから見た「1つ上の実体階」＝subjectGraph自身（メモリ上・peek不要）。ここを忘れると
    // 直前のreflectが作った下階の3b柱が、この再計算で候補から漏れて撤去されてしまう。
    const aboveColumnsForBelow = subjectGraph.columns;
    // belowGraphから見た「1つ上の実体階」の柱生成の点源（ステップ3h-2）。aboveColumnsForBelowと同じ
    // 「subjectGraph自身＝メモリ上・peek不要」（subjectGraphの3h-2生成分は直前のrecomputeStructuralForGraph
    // で確定済みのため、この時点で読める）。
    const aboveBeamSegmentsForBelow = columnSeedBeamSegments(subjectGraph, rulesFor(effectiveStructure(subjectGraph, project)));
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
        // belowGraphから見た「1つ下の実体階」＝belowBelowGraph（3iのbelow優先候補。上のbelowWallSegments
        // と同じpeek結果を使い回す——追加peek0回。belowBelowGraphが未解決（非在来等）ならnull=[]）。
        autoFillColumnsForStructure(belowGraph, project, belowGate, aboveColumnsForBelow, belowWallSegments, aboveBeamSegmentsForBelow, belowBelowGraph?.columns ?? []);
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
    // 1回の再実行で収束する（ループはしない）根拠——**この自階・下階の組についてのみ**（建物全体
    // （全実体階）の収束はsweep4かかる場合がある。.claude/structural-model.md「3h-2」節参照。
    // ここでの「1回」は本関数が対象にするsubjectGraph・belowGraphの1組の話で、他の階への波及は
    // reflectStructuralToOtherFloors（1階につき1パスのみ）・複数回のモード境界通過に委ねる別の話）。
    // 根拠（3h-2後に更新: 3h-2は下階柱を増やしうるが、
    // その柱は既存の候補区間の**内部**にしか立たない——候補区間の両端（run・分割区間の外形）は
    // emitted（フェーズA確定済み壁線通し梁）∪locked（手動固定梁）の最近傍直交梁で決まり、下階柱の
    // 増減はcolumnSplitPointsの内部分割点を増減させるだけで外形自体は変えない。そのため自階の
    // 再計算をもう一度回しても、そこで新たに変わる下階柱集合が3回目の再実行を要求することはない
    // （区間外形が同じ＝次の候補列挙も同じ場所で止まる）。
    // ⚠例外（QA第2巡・2026-09-18／QA裁定2026-09-18で前提が単純化）: 交点を作る壁の候補区間が
    // 自階フットプリント外・excludedBeamSlotsでemittedに入らない場合、その壁は頭つなぎ自身の支持
    // 候補にもならないため、頭つなぎ自身がその3h-2柱の位置で内部分割されうる（woodAutoFill.test.js
    // 「頭つなぎを横切る下階壁の区間がexcludedBeamSlotsなら…」参照）。この場合もspanKeyの両端
    // （emitted∪lockedの最近傍支持）は下階柱の増減に依存せず不変のままなので、収束の性質自体は
    // 変わらない——1回の再実行で確定する。
    // なお旧実装（下階柱の両端支持でwallGateを丸ごと免除する。指摘A・2026-09-18）はQA裁定2026-09-18で
    // 撤回し、フェーズA・Bとも自階フットプリント単独（buildSelfFootprintGate。自階の部屋構成だけで
    // 決まり、下階柱の状態を一切参照しない）でゲートするようになった——これにより「3h-2が下階柱を
    // 追加するとwallGateの判定（＝emittedの内容）が変わる」というフィードバック経路自体が無くなり、
    // 上記の収束根拠はさらに単純になった（自階フットプリント外・excludedBeamSlotsという静的な理由で
    // emittedに入らない壁が残るだけで、これらは下階柱の増減と無関係）。
    // belowGraphを直接渡して再peekしない（下階編集はまだIDBへ未反映のため。
    // structuralRecompute.js precomputedBelowGraphのJSDoc参照）。flushEditablePeekは主構造変更経路
    // （mutateがbelowGraph自身の編集可能peekを書き換えた場合）の保留保存を確定する「読む前に書く」
    // 規律を保つためのもので、突入時（編集可能peek未開始）はno-op。
    // **屋根専用平面（subjectGraph.plane.isRoofPlane）は非在来だけ再実行しない**（QA3-1・2026-09-17。
    // 【裁定改定・2026-09-19、在来木造は解除】）：
    // composition の belowGraph（figure層の columnMap 供給階。drawingDesignation.js
    // structuralPlaneBelow は屋根なら「最上階」を返す）と、recomputeStructuralForGraph が
    // 自前peekする belowGraph（wallBeamAxes.js belowPlaneOf。屋根専用平面は project.planes に
    // 含まれないため常に null＝「屋根に1つ下の実体階は無い」）は別概念で、屋根では一致しなかった。
    // 一致しないまま precomputedBelowGraph（最上階の非null graph）を渡すと、1回目（belowGraph=null
    // ＝屋根自身の柱寸へフォールバック）と2回目（belowGraph=最上階＝最上階の柱寸を参照）とで
    // beamColumnWidthMm が食い違い、屋根伏図の軒桁材幅が最上階の柱寸へ静かに置き換わっていた
    // （実測: 最上階=105・屋根自身=120のとき、1回目120→2回目105 ×該当本数）。
    // 【改定理由】小屋伏図にも梁・柱ルールを適用する計画（.claude/structural-model.md）で「屋根の
    // 1つ下＝最上階」と定義した在来木造（structuralRecompute.js が isRoof のとき peekBelowGraph の
    // 代わりに peekRoofBelowGraph を使う。ステップ4）では、1回目（peekRoofBelowGraph経由）・2回目
    // （precomputedBelowGraph、ここも最上階）の belowGraph が常に一致し、旧QA3-1裁定が防いでいた
    // 「食い違い」自体が起こらない——旧裁定の前提（「屋根に1つ下の実体階は無い」）が失効したため、
    // 在来木造（rules.framing を持つ主構造）だけ抑止を解除する。既存の確定規律「梁幅＝その梁を支える
    // 1つ下の実体階の柱寸」（ステップ4 C-2・2026-09-16）に照らせば、小屋伏図の梁（軒桁・頭つなぎ）を
    // 支えるのは最上階の柱であり、最上階の柱寸が正しい値——屋根 graph 自身の柱寸（既定120）は屋根に
    // 柱が無い以上、意味を持たない値である。非在来（S造等・roofBeamPlacement:'gridEaves'）は
    // 旧裁定のまま抑止を維持する（belowPlaneOfがproject.planesに屋根を含まないため今後も食い違いが
    // 起こり得るため）。
    const roofReexecBlocked = subjectGraph.plane.isRoofPlane && !rulesFor(effectiveStructure(subjectGraph, project)).framing;
    if (!roofReexecBlocked && columnSetSignature(belowGraph.columns) !== belowColumnsBefore) {
      await floorSwapManager.flushEditablePeek();
      const { changed: secondChanged } = await recomputeStructuralForGraph(subjectGraph, project, belowMainStructure, belowGraph, { ctx });
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
  if (pushUndo && (mutate || changed)) {
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
  return { changed, belowGraph, belowBelowGraph, isWallRuns };
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

// ---- 解決コンテキストの3値規約（省略=owned生成／明示=借り物／null=使わない）を共有するヘルパ ----
// runStructuralModeSetupが最初に持っていたowned/borrowedの判定（B-4）を、反映3経路
// （reflectStructuralToOtherFloors・reflectStructuralAfterFinishExit・reflectStructuralAfterFloorAdd）
// も同じ形で必要とするため、共通処理をここへ括り出す（B-5・2026-09-21）。
// ctxArg===undefined（省略）のときだけこの関数がコンテキストを生成し（owned）、bodyの実行後（成功・
// 例外いずれも）try/finallyでdispose()する。ctxArg===null（明示）またはコンテキストのインスタンスが
// 渡された場合はowned=falseとなり、生成せずにそのままbodyへ渡す——nullの場合はpeekVia/saveViaが
// nullish（null・undefined問わず）なら従来経路へフォールバックするため、bodyがctxArgをそのまま使って
// よい。渡された既存のコンテキストは借り物としてdisposeしない（所有者は呼び出し側のまま）。
async function withResolveContext(ctxArg, body) {
  const owned = ctxArg === undefined;
  const ctx = owned ? createStructuralResolveContext() : ctxArg;
  try {
    return await body(ctx);
  } finally {
    if (owned) ctx.dispose();
  }
}

// ---- 構造モード突入時のセットアップ（屋根平面同期・バインディング生成・再計算）----
// handleModeChange('structure') と、構造モード中のフロア切替（switchFloorKeepingMode）の両方から呼ぶ。
// 【外側収束ループ・リード裁定2026-09-19（B-1）】突入直後の反映（reflectStructuralToOtherFloors）は
// アクティブ階を除いた他階だけを収束させる一方、直後のアクティブ階composition再計算
// （recomputeStructuralComposition）がアクティブ階自身（および図面合成でその柱を貰う下階）を
// 新たに変化させることがある（例: 屋根アクティブ時、最上階の柱集合が屋根の頭つなぎ生成後に
// 初めて確定し、最上階以下がその新しい柱を前提にまだ反映されていない）。この食い違いを1回の
// モード突入で解消するため、「(他階の反映を収束まで)→(アクティブ階のcomposition再計算＋保存)→
// アクティブ階が変化したら先頭へ戻る」の外側ループにする（上限はMAX_REFLECT_PASSESと共通）。
// 非在来は必ず1回で終わる——recomputeStructuralComposition が返す isWallRuns（自階または下階の
// beamPlacementが'wallRuns'＝在来木造）が立たない限りループを継続しない
// （reflectStructuralToOtherFloorsのsawWallRunsと同じ規約。下階の柱集合が変わればsubjectGraphの
// changedがtrueになり続ける経路は在来木造専用ではないため、changedだけに頼ると非在来でも
// 稀にループしうる——実測で確認済み。isWallRunsとの両方をゲートにする）。
// undo は突入全体で1エントリ（アクティブ階の突入前スナップショットを最初に1回だけ取り、ループ収束後の
// 最終状態との対で1回だけ積む。ループ内の個々のパスはrecomputeStructuralCompositionへ
// pushUndo:falseで渡し、個別には積まない）。他階（反映パス）は従来どおりundo対象外のまま。
// ctx（解決コンテキスト。構造再計算高速化ステップB-4）: withResolveContext（上記ヘルパ）が3値規約を
// 実装する——省略（undefined）した場合は本関数が自分で1個生成し（owned）、突入処理全体（他階への
// 反映→図面合成バインディング構築→自階・下階の再計算、を収束するまで繰り返す外側ループ全体）で
// 使い回してから必ずdispose()する（try/finally。「突入1回＝コンテキスト1個」）。呼び出し側から
// 明示的にctxを渡した場合はdisposeしない（所有者は呼び出し側のまま——反映3経路（
// reflectStructuralToOtherFloors・reflectStructuralAfterFinishExit・reflectStructuralAfterFloorAdd）も
// 同じ規約で自分のコンテキストを生成し、本関数へは自分のctxを渡す。B-5・2026-09-21）。
// **ctx: null を明示した場合はコンテキストを生成せず「使わない」**（wallSourceCache/footprintCacheの
// 「null明示＝従来経路」と同じ規約。floorSwapManager.peek/saveFloor直呼びのまま・A/B等価テストの
// 対照に使う）。省略（undefined）とnullを区別する——省略時だけ生成する。
// figureBindingManager.activate/commitにはctxを渡さない（規律6。図面合成の下階バインディングの
// 編集可能peekは、保持コピーとは別の生存期間・書込みチャネルを持つ）。
// @returns {Promise<object>} composition（呼び出し側が setStructComposition する）
export async function runStructuralModeSetup(targetGraph, project, { onToast, ctx: ctxArg = undefined } = {}) {
  // withResolveContext（上記ヘルパ）がownedなコンテキストだけを破棄する（規律2）。呼び出し側から
  // 渡されたctxは所有者のまま（破棄しない）——例外時（途中のpeek/recompute失敗）もそのtry/finallyで
  // 必ず破棄される。
  return withResolveContext(ctxArg, async (ctx) => {
    const effectiveMainStructure = targetGraph.structureOverride ?? project.structuralInfo.mainStructure;
    if (effectiveMainStructure === UNSPECIFIED_STRUCTURE) {
      onToast?.(ERR_STRUCT_MAIN_UNSPECIFIED);
    }

    // 最上階の直上に屋根専用平面（小屋伏／R階伏）を同期する（undo対象外。建物形状が変わった時点でやり直し前提のインフラ）。
    runInAction(() => syncRoofPlane(project));

    // 突入全体を通した1エントリ用のbefore（ループの何回目で変化しても、この最初のスナップショットへ戻す）。
    const entryBefore = serializeGraph(targetGraph);
    let composition = null;
    let anyChanged = false;
    let lastResult = null;

    for (let pass = 1; pass <= MAX_REFLECT_PASSES; pass++) {
      // 他階（アクティブ階以外の全実体階＋屋根）へも構造部材を反映・永続化する（undo対象外インフラ）。
      // 自階だけの再計算では「訪れた伏図の階」にしか部材が入らず、他の伏図・他モードの図面が空のままになる。
      // バインディング構築より先に行うことで、下階レイヤの peek は反映済みデータを読む
      // （表示用 autofill は差分ゼロとなり、編集可能 peek のベースラインとも一致する）。
      await reflectStructuralToOtherFloors(project, ctx);

      // 図面合成（構造伏図＝自階床下材＋1つ下の階の柱）のバインディングを毎パス組み直す——直前の
      // reflectStructuralToOtherFloorsが下階を保存し直した可能性があるため、frozen peek（activate内部で
      // 1回だけ読む）を最新化する（commitは編集可能peekを開始する副作用を持つため、ループ収束後に
      // 1回だけ呼ぶ。activate自身のdeactivateは編集可能peek未開始なら無害）。activateにはctxを渡さない
      // （規律6。上記JSDoc参照）。
      composition = await figureBindingManager.activate(getFigure(STRUCTURAL_FIGURE_ID), targetGraph.plane, targetGraph, project);

      // 自階＋下階の再計算（突入時・主構造変更時で共有する純計算コア）。undoはここでは積まない
      // （ループ収束後に1回だけ積む。上記コメント参照）。
      lastResult = await recomputeStructuralComposition(composition, targetGraph, project, { onToast, pushUndo: false, ctx });
      anyChanged = anyChanged || lastResult.changed;
      if (!lastResult.changed || !lastResult.isWallRuns) break;
      if (pass === MAX_REFLECT_PASSES) {
        console.warn(`[runStructuralModeSetup] ${MAX_REFLECT_PASSES}回反映しても収束しませんでした（最後の状態のまま打ち切ります）`);
        break;
      }
      // 次の反映パスが自階の最新状態をpeekできるよう保存する（reflectStructuralToOtherFloorsは
      // 他階をfloorSwapManager.peekでIDBから読むため、自階の変化はここで保存しないと伝わらない）。
      // 保存元はtargetGraph自身（生きたアクティブgraph）——ctxの保持インスタンスではないため、
      // saveAndNoteの契約どおり、ctxがこの階を保持していれば捨てられる（規律5「アクティブ階が保存
      // されたらその階の保持は捨てる」。もっともアクティブ階はctx.graphForを介さないため通常は
      // 保持自体が無い——ここでの捨てはあくまで契約上の安全側の帰結）。
      await saveVia(ctx, targetGraph.plane.id, serializeGraph(targetGraph), targetGraph);
    }

    if (anyChanged) {
      const entryAfter = serializeGraph(targetGraph);
      const { belowGraph, belowBelowGraph } = lastResult;
      undoManager.push(
        () => {
          restoreGraph(targetGraph, entryBefore);
          resyncTouchedMemberGroups(targetGraph, belowGraph, belowBelowGraph, project);
        },
        () => {
          restoreGraph(targetGraph, entryAfter);
          resyncTouchedMemberGroups(targetGraph, belowGraph, belowBelowGraph, project);
        },
      );
    }

    // 下階の柱は、その伏図の構造リストから編集する（描画対象＝編集対象を一致させる）。
    // 表示用 autofill 完了後に commit して secondaryEdit バインディング（下階）を編集可能 peek 化する。
    // 基礎伏図（下階なし）は secondaryEdit バインディングが無く編集チャネルは張られない。
    figureBindingManager.commit(composition);

    // composition の state 反映は commit 後に呼出側で行う（commit は同期・render は挟まらないため従来と同値）。
    return composition;
  });
}

// ---- 構造モードへの外部問合せ（階追加・仕上げ退出時に、構造モードに入らず構造部材を更新する）----
// mainStructure は屋根平面（軒桁）でのみ意味を持つが、ここでの対象は常に実体階なので自階の実効値でよい。

// アクティブな graph を再計算し、変化があれば undo に積む（通常の auto-save に乗る）。
// pushUndo=false は階追加フロー用（withFloorAddUndo が全階分を1エントリで巻き戻すため個別には積まない）。
// ctx（解決コンテキスト）は省略可能——受け取って下へ渡すだけで、この関数自身は生成しない。
export async function recomputeActiveStructural(project, pushUndo = true, ctx = undefined) {
  const g = project.activeGraph;
  const mainStructure = g.structureOverride ?? project.structuralInfo.mainStructure;
  // before/after は undo に積むときだけ要る（pushUndo=false の経路では誰も読まないので取らない）。
  const { changed, before, after } = await recomputeStructuralForGraph(g, project, mainStructure, undefined, { captureSnapshots: pushUndo, ctx });
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
// （非永続の派生値。collect時点の値）を読み終えたら手放す——コンテキスト経路（ctx指定・対象階を
// 保持している場合）では、apply側（applyMemberNumbersToFloor）の再peekが同じgraphインスタンスを
// collect→applyで使い回す（structuralResolveContext.jsの規律どおり、1回の境界処理の間は複数階分を
// 同時に保持してよい）。ctx省略・ctx:null（対照用の従来経路）では対象階を保持しないため、apply側は
// 毎回fresh peekし直す——いずれの経路でも読む値は同じになる（下記beamColumnWidthMm書き戻しの
// 規律参照）。
// 戻り値に changed・isWallRuns（在来木造＝beamPlacement:'wallRuns'）を加えたのは、反映パスを
// 「収束するまで繰り返す」判定（下記 MAX_REFLECT_PASSES 節。小屋伏図にも梁・柱ルールを適用する
// 計画のリード裁定）に使うため——呼び出し側は temp（既存どおりbeamColumnWidthMm読み取り用）と
// 合わせて分割代入で受け取る。
// ctx（解決コンテキスト）は省略可能——受け取ってpeekVia・recomputeStructuralForGraph・saveViaへ下へ
// 渡すだけで、この関数自身は生成しない。
async function recomputeInactiveStructural(plane, project, ctx = undefined) {
  const temp = await peekVia(ctx, plane, project.structGraph);
  const mainStructure = temp.structureOverride ?? project.structuralInfo.mainStructure;
  const isWallRuns = rulesFor(effectiveStructure(temp, project)).beamPlacement === 'wallRuns';
  const { changed } = await recomputeStructuralForGraph(temp, project, mainStructure, undefined, { ctx });
  if (changed) await saveVia(ctx, plane.id, serializeGraph(temp), temp);
  return { temp, changed, isWallRuns };
}

// 採番パス2: 直前に収集済みの project.memberNumberIndex を使って番号を適用し、変化があれば保存する。
// graph は peekVia で取得する——コンテキスト経路（ctx指定・対象階を保持）ならcollect側と同一
// インスタンスを使い回し、ctx省略・ctx:null（対照用の従来経路）は fresh peek し直す（collect時に
// 使ったtempインスタンスをここまで生かし続けない）。いずれの経路でも beamColumnWidthMmValue には
// collect フェーズで求めた同じ階の派生値（下階の柱寸。数値または未解決null）を渡し、apply対象へ
// 無条件で書き戻してから applyNumbers を呼ぶ——同じインスタンスを使い回すコンテキスト経路では
// before状態の値が残っているため、fresh peekし直す従来経路と同じ値を読ませるにはこの書き戻しが
// 両経路で欠かせない（standardBeamSectionFor（groupKey算定）がこれを読むため、書き戻さないと
// collect時点の標準材と食い違ってタグが引けなくなる。QA指摘4）。
async function applyMemberNumbersToFloor(plane, tags, project, beamColumnWidthMmValue, ctx = undefined) {
  const temp = await peekVia(ctx, plane, project.structGraph);
  let changed = false;
  runInAction(() => {
    temp.setBeamColumnWidthMm(beamColumnWidthMmValue);
    ({ changed } = applyNumbers(temp, project, tags));
  });
  if (changed) await saveVia(ctx, plane.id, serializeGraph(temp), temp);
}

// アクティブ階以外の全実体階の構造部材を peek+再計算+保存で反映する（undo 対象外の決定的インフラ）。
// 構造モードの境界（突入・脱出）と階追加フローが共有する「他階への構造反映」の単一実装——
// これが無いと、構造モードで生成・編集した部材が「訪れた伏図の階」にしか入らず、
// 他モード・他階へ移動したときに他の伏図・平面図へ構造部材が現れない。
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
// 素直には適用できないため、最低ラインとして「収集だけ」を常に行う（非在来はpeekしたグラフを保存
// せず番号も書き戻さない。実際の番号確定はユーザーが屋根伏図を直接訪れたときの通常経路に委ねる）。
// 【R-3・2026-09-19是正】旧コメントは「屋根専用平面の梁（role:'eaves'）はWOOD_DEPTH_BEAM_ROLESに
// 含まれず個別採番の対象外」と書いていたが、ステップ5（小屋伏図にも梁・柱ルールを適用する計画）で
// 在来木造の屋根の梁がrole:'primary'へ切り替わったため失効している——在来木造は屋根の梁も
// standardBeamSectionFor由来のgroupKey判定（個別採番か否か）の対象になり、実体階と同じく
// memberNoの書き戻し・保存が必要（下記applyMemberNumbersToRoof参照。書き戻さないと屋根の梁が
// memberNo=nullのまま保存される一方、記号ごとの階集合判定が実体階側の既存タグまで振り直す）。
// 屋根専用平面（isRoofPlane）の反映（小屋伏図にも梁・柱ルールを適用する計画のステップ7）。
// 在来木造（roofBeamPlacement:'wallRuns'）は recomputeInactiveStructural の屋根版として
// peek→recompute→保存する——ユーザー定義「最上階から順＝起点は小屋伏図」を反映パスでも実現する
// （呼び出し側 reflectStructuralToOtherFloors が降順ループの直前に呼ぶ）。mainStructure は屋根自身の
// 実効主構造ではなく「1つ下の実体階（＝最上階）」の実効主構造（drawingDesignation.js
// structuralPlaneBelow）——autoFillRoofBeams・convertMembersToEffectiveMaterial が屋根専用に解決する
// 値と同じ規約（recomputeInactiveStructural の「自階の値をそのまま渡す」規約とは異なる。屋根には
// 自階の実効値という概念が意味を持たないため）。最上階が現在アクティブなら（同じreflect呼び出し内で
// 活きているメモリ上のgraphを）そのまま使う——「アクティブ階は自階のpeekを介さない」既存の規律
// （buildStructuralWallGateのgraphFor等）と同じ。recomputeStructuralForGraph が内部で
// conformToLedger・collectFloorGroups を行うため、旧・collectRoofPlaneGroups 相当の収集は不要
// （二重にしない）。
// 非在来（roofBeamPlacement:'gridEaves'）は従来どおり「収集だけ」（自階再計算・保存はしない）——
// 屋根専用平面には自階再計算（mainStructureの解決に図面合成が要る）を素直には適用できないため、
// 最低ラインとして採番の収集だけ行う（旧・collectRoofPlaneGroupsの実装をそのまま残す）。
// アクティブなら何もしない（既に activeGraph 側の collect/recompute で処理済み）。
// 戻り値 changed・isWallRuns は recomputeInactiveStructural と同じ規約（反映パスを収束するまで
// 繰り返す判定に使う）。非在来（収集だけの分岐）は geometry を変えないため常に changed:false・
// isWallRuns:false。
// 戻り値のbeamColumnWidthMmは、在来木造（実際に再計算した）ときだけ temp.beamColumnWidthMm
// （structuralRecompute.js が書いた「1つ下の実体階=最上階」の柱寸派生値）を持ち帰る——R-3
// （2026-09-19是正）の採番適用フェーズ（applyMemberNumbersToRoof）が、standardBeamSectionFor の
// groupKey算定に使うfresh peek後のtempへ書き戻すため（他の実体階のbeamColumnWidthByPlaneIdと同じ規約）。
// ctx（解決コンテキスト）は省略可能——受け取ってpeekVia・recomputeStructuralForGraph・saveViaへ下へ
// 渡すだけで、この関数自身は生成しない。
async function reflectRoofPlane(project, ctx = undefined) {
  const roofPlane = project.roofPlane;
  if (!roofPlane || roofPlane.id === project.activePlaneId) return { changed: false, isWallRuns: false, beamColumnWidthMm: null }; // アクティブなら既に収集済み
  const temp = await peekVia(ctx, roofPlane, project.structGraph);
  const roofRules = rulesFor(effectiveStructure(temp, project));
  if (!roofRules.framing) {
    // 在来木造columnMapのjoin照合を階スコープの加入署名で解決させるためrules・graph.plane.idを渡す
    // （QA裁定2026-09-17）。
    runInAction(() => {
      conformToLedger(temp, project, roofRules, temp.plane.id);
      collectFloorGroups(temp, project);
    });
    return { changed: false, isWallRuns: false, beamColumnWidthMm: null };
  }
  const topPlane = structuralPlaneBelow(roofPlane, project);
  const topGraph = topPlane
    ? (topPlane.id === project.activePlaneId ? project.activeGraph : await peekVia(ctx, topPlane, project.structGraph))
    : null;
  const mainStructure = topGraph ? (topGraph.structureOverride ?? project.structuralInfo.mainStructure) : project.structuralInfo.mainStructure;
  const { changed } = await recomputeStructuralForGraph(temp, project, mainStructure, undefined, { ctx });
  if (changed) await saveVia(ctx, roofPlane.id, serializeGraph(temp), temp);
  return { changed, isWallRuns: roofRules.beamPlacement === 'wallRuns', beamColumnWidthMm: temp.beamColumnWidthMm };
}

// 屋根専用平面（isRoofPlane）への採番適用（R-3・2026-09-19是正）。在来木造（roofBeamPlacement:
// 'wallRuns'）は屋根の梁もrole:'primary'として個別採番の判定対象（standardBeamSectionFor由来の
// groupKey）に載るため、実体階と同じくmemberNoを書き戻して保存しないと、屋根の梁だけmemberNo=null
// のまま保存される一方、記号ごとの階集合が変わって実体階側の既存タグまで振り直る不整合が起きる
// （旧コメント「屋根の梁は個別採番の対象外」はrole:'eaves'時代の記述で、ステップ5の壁線方式導入後は
// 失効している）。非在来（roofBeamPlacement:'gridEaves'）は従来どおり収集のみ
// （reflectRoofPlaneのJSDoc参照。実際の番号確定はユーザーが屋根伏図を直接訪れたときの通常経路に
// 委ねる既存の割り切りを維持）。アクティブなら何もしない（既にactiveGraph側のapplyNumbersで処理済み）。
// 【QA第2巡Minor-1是正】isWallRuns（呼び出し側がreflectRoofPlaneの戻り値から既に判定済み）で
// 事前にゲートし、非在来では floorSwapManager.peek 自体を呼ばない——以前はここで無条件にpeekして
// からroofRulesを再判定しており、非在来のとき（採番適用のたび）余分なpeekが1回発生していた
// （13.stq実測: reflect 5→6・entry 7→8）。
async function applyMemberNumbersToRoof(tags, project, beamColumnWidthMmValue, isWallRuns, ctx = undefined) {
  const roofPlane = project.roofPlane;
  if (!roofPlane || roofPlane.id === project.activePlaneId) return;
  if (!isWallRuns) return; // 非在来は収集のみ（既存の割り切り）
  const temp = await peekVia(ctx, roofPlane, project.structGraph);
  let changed = false;
  // beamColumnWidthMmValueは無条件で書く（applyMemberNumbersToFloorと同じ規律）——
  // null判定で書き分けると、コンテキスト経路（保持インスタンスを使い回す構成）で「前回の数値」が
  // 残ったまま読まれうる（保持インスタンスはfreshなIDB復元と違い、before状態がクリアされない）。
  // 前提: isWallRuns===trueに絞った時点でbeamColumnWidthMmValueは常に数値（在来木造の
  // beamColumnWidthMm()は柱寸未設定でも既定値へフォールバックする。structureRules.js）。もしnullが
  // 届くようになると、無条件setは収集時に使った値を消して自階フォールバックへ落とす＝収集と適用で
  // 標準材が食い違う——その場合は呼び出し側（reflectRoofPlane）で数値を保証すること。
  runInAction(() => {
    temp.setBeamColumnWidthMm(beamColumnWidthMmValue);
    ({ changed } = applyNumbers(temp, project, tags));
  });
  if (changed) await saveVia(ctx, roofPlane.id, serializeGraph(temp), temp);
}

// ctx（解決コンテキスト。構造再計算高速化ステップB）: withResolveContext（runStructuralModeSetupと
// 同じ3値規約）——省略（undefined）時は本関数が自分で1個生成し（owned）、この反映処理全体（屋根＋
// 非アクティブ全実体階のpeek→recompute→保存、収束するまでの繰り返しを含む）で使い回してから必ず
// dispose()する。呼び出し側（runStructuralModeSetup・reflectStructuralAfterFloorAdd等）から明示的に
// ctxを渡した場合は借り物として扱い、disposeしない（所有者は呼び出し側のまま。B-5・2026-09-21）。
// ctx: null を明示した場合はコンテキストを生成せず「使わない」（従来どおりfloorSwapManager.peek直呼び。
// A/B等価テストの対照に使う）。
export async function reflectStructuralToOtherFloors(project, ctxArg = undefined) {
  return withResolveContext(ctxArg, async (ctx) => {
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
        const belowForActive = await peekBelowGraph(project.activeGraph, project, ctx);
        runInAction(() => project.activeGraph.setBeamColumnWidthMm(beamColumnWidthMm(project.activeGraph, belowForActive, project)));
      }
      runInAction(() => collectFloorGroups(project.activeGraph, project));
    }
    // 収集フェーズで求めた beamColumnWidthMm（下階基準の派生値。数値のみ）はbeamColumnWidthByPlaneIdへ
    // 控えておく。コンテキスト経路では同じgraphインスタンスをcollect→applyで使い回す（1回の境界処理の
    // 間は複数階分のpeek結果を同時に保持してよい・2026-09-21裁定）。peek済みインスタンスを次のplaneへ
    // 進む前に手放す規律は対照用の従来経路（ctx: null）だけのもの。適用フェーズは applyMemberNumbersToFloor
    // が peekVia（コンテキスト経路なら同一インスタンス、従来経路ならfresh peek）で取得し、控えておいた
    // 数値を無条件で書き戻してから applyNumbersを呼ぶ——同一インスタンス・fresh peekいずれの経路でも
    // 同じ値を保証するための規律（applyMemberNumbersToFloorのJSDoc参照）。
    // 降順（最上階→最下階）で再計算する（ユーザー裁定2026-09-19「柱の追加は最上階から順に、最下階まで
    // 可能な限り同位置に」）。project.planes は elevation 昇順（core/project.js）——各階は
    // peek→recompute→保存を1階ずつ完結するため、降順なら階N−1の処理時に peekAboveGraph がこのループで
    // 保存済みの階Nを読み、「上階の梁→下階の柱→さらに下階の柱」が1パスで最下階まで通る（3i・支持長1820
    // ルールの柱生成が上階の梁の点源に依存するため）。逆向きの依存（下階柱→自階の梁分割・成）は1パス
    // 遅れるが、伏図訪問時のrecomputeStructuralCompositionで吸収される（既存の結果整合性と同じ規律）。
    // 採番の適用ループ（下記）は建物全体で1回・順序非依存のため変更しない。
    // 降順ループの先頭に屋根を置く（B-4節の続き。ユーザー定義「最上階から順＝起点は小屋伏図」・
    // 小屋伏図にも梁・柱ルールを適用する計画のステップ7）：小屋伏図→最上階→…→最下階の順で
    // peek→recompute→保存する。在来木造は屋根も実際に再計算・保存する（reflectRoofPlane内部で
    // 非在来との分岐を持つ——非在来は従来どおり収集だけ）。
    // **反映パスは収束するまで同じ順序で繰り返す**（リード裁定・2026-09-19）：1回の反映パスだけでは
    // 全階が完全収束しない（3bの1回遅れ・3h-2の3階またぎ等。.claude/structural-model.md参照）ため、
    // 突入直後のユーザーが未収束の伏図（梁・柱が無く見える）を見てしまう再発源になっていた。
    // 反映対象（屋根＋非アクティブ全実体階）にrole=在来木造（beamPlacement:'wallRuns'）の階が
    // 1つでも含まれるときだけ、いずれかの階がchangedを返す限り繰り返す（上限MAX_REFLECT_PASSES）。
    // 非在来だけの建物はsawWallRunsが立たないため必ず1パスで終わる（従来と同じコスト・結果）。
    const beamColumnWidthByPlaneId = new Map();
    let roofBeamColumnWidthMm = null;
    let roofIsWallRuns = false;
    await repeatReflectPassUntilConverged(async () => {
      let anyChanged = false, sawWallRuns = false;
      const { changed: roofChanged, isWallRuns: roofWallRuns, beamColumnWidthMm: roofWidth } = await reflectRoofPlane(project, ctx);
      anyChanged = anyChanged || roofChanged;
      sawWallRuns = sawWallRuns || roofWallRuns;
      roofBeamColumnWidthMm = roofWidth;
      roofIsWallRuns = roofWallRuns;
      beamColumnWidthByPlaneId.clear();
      for (const plane of [...project.planes].reverse()) {
        if (plane.id === activeId) continue;
        const { temp, changed, isWallRuns } = await recomputeInactiveStructural(plane, project, ctx);
        beamColumnWidthByPlaneId.set(plane.id, temp.beamColumnWidthMm);
        anyChanged = anyChanged || changed;
        sawWallRuns = sawWallRuns || isWallRuns;
      }
      return { anyChanged, sawWallRuns };
    }, 'reflectStructuralToOtherFloors');
    const tags = assignNumbers(project);
    if (project.activeGraph) runInAction(() => applyNumbers(project.activeGraph, project, tags));
    for (const plane of project.planes) {
      if (plane.id === activeId) continue;
      await applyMemberNumbersToFloor(plane, tags, project, beamColumnWidthByPlaneId.get(plane.id), ctx);
    }
    // R-3（2026-09-19是正）: 屋根専用平面（在来木造のみ）にも採番を適用する——採番の適用ループが
    // project.planesのみを対象にしていたため、屋根の梁（role:'primary'化済み）がmemberNo=nullのまま
    // 保存され、実体階側の記号ごとの階集合判定（needsPrefix）まで狂わせていた（上記コメント参照）。
    await applyMemberNumbersToRoof(tags, project, roofBeamColumnWidthMm, roofIsWallRuns, ctx);
  });
}

// 要件1：階追加後。追加で N（負担階数）・基礎指定が変わるため、全実体階の構造部材を更新する。
// アクティブ（追加直後の表示階）はメモリ上で、その他の実体階は peek+保存で反映する。
// undo は個別に積まない（呼び出し元の withFloorAddUndo が階追加フロー全体を1エントリで記録する）。
// これにより別階・別モードへ移動したとき、更新後の柱・梁・材寸がそのまま描画される。
// ctx（解決コンテキスト）: withResolveContext（runStructuralModeSetupと同じ3値規約）——省略時は
// 本関数が自分で1個生成し、recomputeActiveStructural・reflectStructuralToOtherFloorsの両方へ同じ
// コンテキストを渡してから必ずdispose()する（1回の階追加反映＝コンテキスト1個。reflectStructuralToOtherFloors
// へは既に生成済みのctxを明示的に渡すため、内側で二重に生成することはない。B-5・2026-09-21）。
// 明示的に渡された場合は借り物（disposeしない）。null明示はコンテキストを使わない従来経路。
export async function reflectStructuralAfterFloorAdd(project, ctxArg = undefined) {
  return withResolveContext(ctxArg, async (ctx) => {
    await recomputeActiveStructural(project, false, ctx);
    await reflectStructuralToOtherFloors(project, ctx);
  });
}

// 要件2：仕上げモード退出後。フットプリント（外壁線・吹抜け）変更は鉛直連続性ゲートにより
// 自階と「自階より上の全実体階」のゲートに効く（wallGate.js：基準階＋直下の全階のAND）。
// そのため自階（アクティブ）＋上の全階を再計算する。下階は影響を受けない。
// 退出先が構造モードのときは runStructuralModeSetup が自階を再計算するため、自階・番号確定は
// そちら（reflectStructuralToOtherFloors）に委ねる。退出先が構造モードでない場合はここで
// 採番も確定する（次に構造モードへ入るまで番号が未確定のままにならないよう、直近の収集結果で確定する）。
// 【不変条件・QA裁定2026-09-19】ここは昇順（elevation順）のまま——reflectStructuralToOtherFloors
// （降順。B-4節参照）とは処理順が異なるが、両者とも同じ結果に収束する（Major-1のrun合成
// mergePrimaryBeamRuns.js適用後、moku1/moku2/moku3/2026模試の4文書で昇順・降順スイープの全構造部材
// ダンプが一致することをprobeで確認済み——.claude/structural-model.md「3iの収束は処理順に依存しない」
// 節参照）。このため本関数だけ降順へ揃える必要は無い。
// ctx（解決コンテキスト）: withResolveContext（runStructuralModeSetupと同じ3値規約）——省略時は
// 本関数が自分で1個生成し、内部のrecomputeActiveStructural・recomputeInactiveStructural・
// reflectRoofPlane・applyMemberNumbersToFloor・applyMemberNumbersToRoofすべてへ同じコンテキストを
// 渡してから必ずdispose()する（1回の仕上げ脱出反映＝コンテキスト1個。B-5・2026-09-21）。明示的に
// 渡された場合は借り物（disposeしない）。null明示はコンテキストを使わない従来経路。
export async function reflectStructuralAfterFinishExit(currentPlaneId, goingToStructure, project, ctxArg = undefined) {
  return withResolveContext(ctxArg, async (ctx) => {
    if (!goingToStructure) await recomputeActiveStructural(project, undefined, ctx);
    const planes = project.planes; // elevation 昇順
    const idx = planes.findIndex(p => p.id === currentPlaneId);
    const touchedByPlaneId = new Map(); // planeId → beamColumnWidthMm（数値のみ控える。階の保持は解決コンテキストの役目——reflectStructuralToOtherFloors の同種のコメント参照）
    let roofBeamColumnWidthMm = null;
    let roofIsWallRuns = false;
    if (idx !== -1) {
      // reflectStructuralToOtherFloorsと同じ「収束するまで繰り返す」規律（リード裁定・2026-09-19）を
      // 昇順（自階より上＋末尾の屋根）にも適用する——理由・上限は同じ（repeatReflectPassUntilConverged
      // のJSDoc参照。両関数で単一実装を共有する）。
      await repeatReflectPassUntilConverged(async () => {
        let anyChanged = false, sawWallRuns = false;
        for (let i = idx + 1; i < planes.length; i++) {
          const { temp, changed, isWallRuns } = await recomputeInactiveStructural(planes[i], project, ctx);
          touchedByPlaneId.set(planes[i].id, temp.beamColumnWidthMm);
          anyChanged = anyChanged || changed;
          sawWallRuns = sawWallRuns || isWallRuns;
        }
        // 昇順ループの末尾に屋根を置く（小屋伏図にも梁・柱ルールを適用する計画のステップ7）：
        // フットプリント変更は「自階＋自階より上の全実体階」に効くため、その最後（＝最上階のさらに上）
        // にある屋根も触れる対象に含める——在来木造は屋根も実際に再計算・保存する（reflectRoofPlane
        // 内部で非在来との分岐を持つ。reflectStructuralToOtherFloorsと同じ単一実装を共有する）。
        // goingToStructureの真偽に関わらず呼ぶ——real floors側のループと同じ規律（geometry-levelの
        // recompute+保存はgoingToStructureを問わず行い、採番の確定だけを下のガードで分ける）。
        // goingToStructure===trueの場合は直後にrunStructuralModeSetup→reflectStructuralToOtherFloors
        // が屋根を含め再度反映するため二重に触れるが、real floors側も同じ「二重に触れる」既存の
        // 割り切りを持つ（冪等のため実害なし）。
        const { changed: roofChanged, isWallRuns: roofWallRuns, beamColumnWidthMm: roofWidth } = await reflectRoofPlane(project, ctx);
        anyChanged = anyChanged || roofChanged;
        sawWallRuns = sawWallRuns || roofWallRuns;
        roofBeamColumnWidthMm = roofWidth;
        roofIsWallRuns = roofWallRuns;
        return { anyChanged, sawWallRuns };
      }, 'reflectStructuralAfterFinishExit');
    }
    const touched = [...touchedByPlaneId].map(([planeId, beamColumnWidthMm]) => ({ plane: planes.find(p => p.id === planeId), beamColumnWidthMm }));
    if (!goingToStructure) {
      const tags = assignNumbers(project);
      if (project.activeGraph) runInAction(() => applyNumbers(project.activeGraph, project, tags));
      for (const { plane, beamColumnWidthMm: v } of touched) await applyMemberNumbersToFloor(plane, tags, project, v, ctx);
      // R-3（2026-09-19是正。reflectStructuralToOtherFloorsと同じ理由・同じヘルパ）: 屋根専用平面
      // （在来木造のみ）にも採番を適用する——このループは「自階より上」の一部として屋根も
      // recompute+保存の対象にしているのに、採番の適用だけ屋根を素通ししていた同型の不整合。
      await applyMemberNumbersToRoof(tags, project, roofBeamColumnWidthMm, roofIsWallRuns, ctx);
    }
  });
}
