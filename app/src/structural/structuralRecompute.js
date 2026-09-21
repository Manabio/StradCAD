import { runInAction } from 'mobx';
import { serializeGraph } from '../graphSnapshot.js';
import { buildStructuralWallGate, buildExteriorSide, buildSelfFootprintGate, createFootprintCache } from './wallGate.js';
import { collectWallBeamSources, peekBelowGraph, peekAboveGraph, wallRunSegments, columnSeedBeamSegments, peekRoofBelowGraph, peekRoofGraphAbove, createWallSourceCache } from './wallBeamAxes.js';
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
import { conformWoodSections, conformWoodColumnEccentricity, autoFillWoodBeamDepths } from './woodAutoFill.js';
import { rulesFor, effectiveStructure, beamColumnWidthMm } from './structureRules.js';
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
 * @param {object|undefined} [precomputedBelowGraph] - 呼び出し側が既に手元に持つ「1つ下の実体階」の
 *   graph（省略時=undefinedのときだけ自前でpeekする。現状の唯一の呼び出し元は非nullのgraphしか
 *   渡さない——null明示の経路は呼び出し元・テストとも無いため契約に含めない）。
 *   structuralOrchestration.js recomputeStructuralComposition の下階編集経路（3b柱追加等）の直後、
 *   自階を再計算し直す2回目の呼び出しが使う——ここで自前peekすると、その下階編集がまだIDBへ
 *   反映されていない（編集可能peekの保存は最大400msデバウンス、またはpeekしたてで未commit）ため
 *   古い柱で梁分割・成算定を確定してしまう（ユーザー裁定2026-09-16「分割後に正しい距離を持つことが
 *   最適解」）。呼び出し側が手元の最新graphをそのまま渡すことで、再peekによる読み取り待ちを避ける。
 * @param {object} [options] - オプション。
 * @param {boolean} [options.captureSnapshots=false] - trueのときだけ before/after（undo用シリアライズ）
 *   を取る。既定はfalse（before/after=null・serializeGraphを呼ばない）——実際にundoへ積むのは
 *   structuralOrchestration.js recomputeActiveStructural だけで、他の呼び出し元はchangedしか読まない
 *   ため、そこ以外では無駄なシリアライズになっていた（ステップD）。
 * @param {ReturnType<typeof createWallSourceCache>} [options.wallSourceCache] - 壁区間
 *   （wallBeamAxes.js wallBeamSourcesFromGraph）を「1回のこの呼び出しの間」memoするキャッシュ
 *   （ステップC）。省略時は本関数が自前で1個作り、内部の全消費点（collectWallBeamSources・
 *   wallRunSegments・autoFillStructuralGrid経由のselfWallSegments・conformWoodColumnEccentricity）へ
 *   配る——構造再計算は壁を生成・変更しない（このJSDoc冒頭のとおり）ため、1回の呼び出しの間は
 *   同じgraphの壁区間は不変で、何度も全走査し直す必要が無い。壁区間は最初の消費点の時点で
 *   固定され、その後に残るawait（上階peek・resolveLowestGraph）を跨いでも読み直さない——壁の
 *   書き手（仕上げ脱出・wallRefresh）はこの再計算の外側にしか居ない。外から渡せるようにしておくのは、
 *   後続ステップB（1回の境界処理の解決コンテキストへの格上げ）のための下ごしらえ——現時点で
 *   外から渡す呼び出し元は無い（常に省略時のデフォルト生成のまま）。
 * @param {ReturnType<typeof createFootprintCache>} [options.footprintCache] - フットプリント索引
 *   （wallGate.js footprintProbe＝分割格子＋部屋セルの索引）を「1回のこの呼び出しの間」memoする
 *   キャッシュ（ステップA）。省略時は本関数が自前で1個作り、内部の全消費点（buildStructuralWallGate・
 *   buildSelfFootprintGate・buildExteriorSide・autoFillColumnAxisOffsets内のbuildExteriorSide(lowestGraph)）
 *   へ配る——構造再計算は部屋・分割線を変更しないため、1回の呼び出しの間は同じgraphのフットプリント
 *   索引は不変。wallSourceCacheと同じ理由で外からは渡さない（今回は下ごしらえのみ）。
 *   wallSourceCache・footprintCacheとも、nullを明示するとmemoせず従来どおり毎回組み直す
 *   （cacheあり／なしの解が一致することを確かめるテストの対照経路）。
 * @param {ReturnType<typeof import('./structuralResolveContext.js').createStructuralResolveContext>} [options.ctx] -
 *   解決コンテキスト（構造再計算高速化ステップB）。省略時（既定undefined）は内部の全peek地点
 *   （buildStructuralWallGate・peekBelowGraph・peekAboveGraph・peekRoofBelowGraph・
 *   peekRoofGraphAbove・resolveLowestGraph）がfloorSwapManager.peek直呼びのまま（従来どおり・
 *   挙動不変）。生成元は structuralOrchestration.js runStructuralModeSetup（突入1回＝コンテキスト
 *   1個）——本関数は受け取って下へ渡すだけで、自分では生成しない。
 * @returns {Promise<{changed: boolean, before: Uint8Array|null, after: Uint8Array|null}>}
 *   before/after はcaptureSnapshots:true時のみ非null（undo用スナップショット）。changed=false かつ
 *   captureSnapshots:trueのとき after===before（再シリアライズしない）。
 */
export async function recomputeStructuralForGraph(targetGraph, project, mainStructure, precomputedBelowGraph = undefined, options = {}) {
  const { captureSnapshots = false, wallSourceCache = createWallSourceCache(), footprintCache = createFootprintCache(), ctx = undefined } = options;
  // 建物フットプリント（部屋領域＝外壁線位置）の鉛直連続性で部材の有無を取捨するゲートを構築する
  // ＝自階かつ直下の全階で建物が連続する位置だけ部材を残す（直下に支えの無い梁・柱は省く）。
  // 非アクティブ下階は peek で覗く。自階に部屋が無い／屋根平面では null＝従来の全グリッド生成。wallGate.js 参照。
  const before = captureSnapshots ? serializeGraph(targetGraph) : null;
  // 主構造ルール（自階の実効値）。壁由来梁芯の下階peek要否・在来木造の柱寸算定スキップ・
  // 木造梁成の自動更新（autoFillWoodBeamDepths、ステップ3d）が共有する（旧: 下方で重複していた
  // rulesFor 呼び出しをここへ集約）。
  const structure = effectiveStructure(targetGraph, project);
  const ownRules = rulesFor(structure);
  // 屋根専用平面（小屋伏図／R階伏図）か。ユーザー定義「在来木造の構造モードで言う『最上階』とは、
  // 最上階にある『小屋伏図』を差す」（2026-09-19）——屋根の「自階」は実体を持たないため、以下の
  // belowGraph・selfGate（小屋伏図にも梁・柱ルールを適用する計画）はどちらも「1つ下の実体階」を
  // 「最上階」に置き換えて解決する。
  const isRoof = targetGraph.plane.isRoofPlane;
  const wallGate = await buildStructuralWallGate(targetGraph.plane, project, targetGraph, footprintCache, ctx);
  // 壁由来の梁芯生成対象・木造梁成の下階柱（支持点）が使う1つ下の実体階のpeek。
  // どちらの用途も不要なら（RC造は自階のみ／非木造は梁成の算定自体が対象外）peekしない。
  // 屋根専用平面は project.planes に含まれず belowPlaneOf（peekBelowGraph内部）が引けないため、
  // 屋根専用のpeekRoofBelowGraph（roofForPlaneIdが指す最上階）へ切り替える（ステップ4）——
  // 非在来（ownRules.framing・wallBeamAxesがいずれも偽）はこの分岐自体に入らずpeek 0回のまま。
  const belowGraph = (ownRules.wallBeamAxes === 'selfAndBelow' || ownRules.framing)
    ? (precomputedBelowGraph !== undefined ? precomputedBelowGraph
        : isRoof ? await peekRoofBelowGraph(targetGraph, project, ctx) : await peekBelowGraph(targetGraph, project, ctx))
    : null;
  // 「梁を支える1つ下の実体階の柱寸」の派生値をgraph自身へ書く——この再計算が**唯一の書き込み元**
  // （structural/structureRules.js beamColumnWidthMmのJSDoc参照）。採番パイプライン
  // （collectFloorGroups/applyNumbers/renumberMembers）・UI（MemberListTab.jsx）・梁芯CL操作
  // （transform/centerLineOps.js）はbelowGraphを持ち回らずこの派生値（resolvedBeamColumnWidthMm）
  // だけを読む（QA指摘: 標準材の解決が採番パイプラインとUI同期経路で二系統に分かれ、タグが往復する
  // バグの修正。ステップ4 C-2 QA4）。非永続フィールドのため保存はしない。
  runInAction(() => targetGraph.setBeamColumnWidthMm(beamColumnWidthMm(targetGraph, belowGraph, project)));
  // 壁由来の梁芯生成対象（下階peekを含む非同期収集。wallGateと同じパターンで先に await する）。
  const wallSources = await collectWallBeamSources(targetGraph, project, belowGraph, wallSourceCache, ctx);
  // 在来木造（beamPlacement:'wallRuns'）の壁線上の通し梁が候補列挙に使う壁区間（マージ不要のプレーン配列。
  // belowGraphはwallSourcesと同じpeek結果を使い回す＝1回の再計算で下階を二重にpeekしない）。
  // wallSourceCache共有により、直前のcollectWallBeamSources（selfAndBelowの内部でも同じ壁区間を
  // 導出済み）と合わせて自階・下階とも壁の全走査は1回で済む（ステップC）。
  const wallSegments = wallRunSegments(targetGraph, belowGraph, structure, wallSourceCache);
  // 在来木造の上階柱直下の柱（ステップ3b）が候補列挙に使う1つ上の実体階の柱。columnPlacementが
  // wallIntersections（在来木造）のときだけpeekする（非在来はpeek 0回。二重管理ではなく同じ主構造
  // ルール軸をここでも読む——ownRulesはstructuralRecompute.js冒頭で集約済み）。
  // 最上階（peekAboveGraphが対象外＝project.planesに次の実体階が無い）は、直上の屋根専用平面を
  // 「1つ上の実体階」の代わりに見る（peekRoofGraphAbove。小屋伏図にも梁・柱ルールを適用する計画の
  // ステップ6）——屋根の壁線方式の軒桁（ステップ5・role:'primary'）が3h-2/3iの点源になり、ユーザー
  // 定義「最上階から順＝起点は小屋伏図」を反映する。peekAboveGraphが非nullを返す通常階（＝最上階
  // ではない）はpeekRoofGraphAbove側の早期return（graph.plane.id!==roofForPlaneId）で追加peekなし。
  const aboveGraph = ownRules.columnPlacement === 'wallIntersections'
    ? (await peekAboveGraph(targetGraph, project, ctx)) ?? (await peekRoofGraphAbove(targetGraph, project, ctx))
    : null;
  const aboveColumns = aboveGraph?.columns ?? [];
  // 在来木造の下階柱（ステップ3h-2）が候補列挙に使う、1つ上の実体階の柱生成の点源（role:'primary'
  // または'floor'の梁の軸・範囲。columnSeedBeamSegments）。追加peek 0回——3b用に既にpeek済みの
  // aboveGraphから読むだけ。「上階graphからは柱のx/y/roleしか読まない」規律を梁の軸・範囲まで広げる。
  // columnSeedBeamSegmentsはaboveGraph=nullで[]を返す。
  // ルールはaboveGraph自身の実効主構造から引く（ownRules=targetGraphのルールを流用しない——混構造
  // 建物ではaboveGraphの主構造がtargetGraphと異なりうるため。structuralOrchestration.jsの下階編集経路
  // （columnSeedBeamSegments(subjectGraph, rulesFor(effectiveStructure(subjectGraph, project)))）と対称）。
  const aboveBeamSegments = columnSeedBeamSegments(aboveGraph, aboveGraph ? rulesFor(effectiveStructure(aboveGraph, project)) : ownRules);
  // 自階フットプリント単独ゲート（wallGate.js buildSelfFootprintGate。壁線上の通し梁・土台が使う。
  // 小屋伏図にも梁・柱ルールを適用する計画のステップ3）。屋根専用平面は自階に部屋を持たないため
  // graph 自身を渡すと常にnull（ゲートなし）になってしまう——「自階」＝1つ下の実体階（＝最上階。
  // ステップ4のpeekRoofBelowGraphで解決済み）のフットプリントを使う。belowGraph が解決不能
  // （roofForPlaneId の実体階が見つからない等の防御的フォールバック。非在来では常にnull）の間は
  // targetGraph 自身へフォールバックする（buildSelfFootprintGate(null)のクラッシュ回避）。
  // 実体階（isRoof===false）は常に targetGraph自身＝autoFillWoodWallBeams/autoFillWoodSillBeamsが
  // 省略時に自前計算する値と同じ＝従来どおり不変。
  const selfGate = buildSelfFootprintGate(isRoof ? (belowGraph ?? targetGraph) : targetGraph, footprintCache);
  // 自由端（F-2・selfWallFreeEnds）の判定基準（R-2・2026-09-19是正）。selfGateと同じ理由——屋根専用
  // 平面は自階に壁が無いため、判定は「1つ下の実体階（＝最上階）」で行う。belowGraphはselfGateと
  // 同じ値を使い回す（追加peekは無い）。実体階は常にtargetGraph自身（従来と同値）。
  const freeEndGraph = isRoof ? (belowGraph ?? targetGraph) : targetGraph;

  // 構造体トポロジーから未定義の柱・梁・基礎（基礎伏図のみ）を検出し、自動補完する。
  // ユーザーが明示削除した箇所は除外集合（excludedColumnSlots 等）により復活しない。
  const { newColumns, removedColumns, newFootings, newBeams, removedBeams } = runInAction(() => autoFillStructuralGrid(targetGraph, project, mainStructure, wallGate, wallSources, wallSegments, aboveColumns, belowGraph?.columns ?? [], aboveBeamSegments, selfGate, freeEndGraph, wallSourceCache));
  // べた基礎（木造）のマットスラブを基礎伏図に生成・撤去する（基礎種別で取捨）。基礎伏図以外では no-op。
  const matFoundation = runInAction(() => autoFillMatFoundation(targetGraph, project));
  // 外周モデル（side ビュー）を1回構築し、柱芯オフセットと梁偏芯の両方に渡す——柱・梁で外側方向（内外定義）を一致させる。
  // 自動補完の後に作るので、矩形フォールバック（仕上げ未定義時）は生成済み部材CLの外接矩形を見る。主題階基準で sync。
  const exterior = buildExteriorSide(targetGraph, footprintCache);
  // 柱芯（ColumnAxis）を自動生成・整合する（ラーメン系以外は0にリセット。差分のみ補完）。
  // 外面合わせの基準となる最下階graphを解決してから適用する（非アクティブ階は peek）。
  const lowestGraph = await resolveLowestGraph(project, targetGraph, ctx);
  runInAction(() => autoFillColumnAxisOffsets(targetGraph, project, lowestGraph, exterior, footprintCache));
  // 梁の偏芯量（柱芯⇄材芯）を faceGap から再算出し、柱外面と梁縁の一致（柱寸法・梁寸法変更に追従）を保つ。
  const updatedBeamEcc = runInAction(() => autoFillBeamEccentricity(targetGraph, project));
  // 別フロアにいる間に主要構造が変更された等で取りこぼした柱・梁を、実効主構造に合わせて変換する。
  const { convertedColumns, convertedBeams, convertedFootings } = runInAction(() => convertMembersToEffectiveMaterial(targetGraph, project, mainStructure));
  // 在来木造: 既存の柱・梁の断面を主構造ルール（柱120角・梁は「梁を支える1つ下の実体階の柱寸」幅）へ
  // そろえる（手動固定も含む。ユーザー裁定2026-09-14／梁幅の下階参照は実機裁定ステップ4 C-2 QA2）。
  const conformedSections = runInAction(() => conformWoodSections(targetGraph, project));
  // 在来木造: 個別柱（柱寸≠階の柱寸）が壁の中で偏心する量（eccentricity）をconformする（B-1・
  // ユーザー裁定2026-09-17）。外周モデル（exterior）は上で構築済みのものを使い回す
  // （柱芯オフセット・梁偏芯と同じ外周モデルに揃える。二系統にしない）。
  const updatedColumnEcc = runInAction(() => conformWoodColumnEccentricity(targetGraph, project, exterior, wallSourceCache));
  // 在来木造: 大梁・小梁の成を支持区間ごとの梁成表引きで自動更新する（ステップ3d。dimensionStatus==='auto'のみ。
  // 断面キー選定の材幅も同じ下階参照——上で書いたgraph.beamColumnWidthMmを内部で読む）。
  const updatedBeamDepths = runInAction(() => autoFillWoodBeamDepths(targetGraph, project, belowGraph?.columns ?? []));
  // 壁下地材（共通仕様の per-floor 設定。壁厚の情報源）はここでは触らない——壁は仕上げ脱出時の導出物で、
  // 構造再計算は壁を再生成できないため、ここで下地材だけ変えると「共通仕様は120×30なのに壁は90のまま」
  // のズレを作る（実機 2026-09-14）。在来の柱同寸×30への自動選択は壁生成の直前＝仕上げ突入
  // （finish/finishBoundary.js runFinishEntryBoundary → conformWoodBacking）だけで行う。
  // 構造変更で「×」化した部材の自動生成分を削除する（「×は削除」。生成側は autoFillStructuralGrid の構造ゲート）。
  const removedByClass = runInAction(() => deleteClassificationOverflow(targetGraph, project));
  // 柱の負担床面積から柱幅・柱脚サイズを再算定する（dimensionStatus==='auto'の部材のみ。ロック済みは保持）。
  // 柱は自階graphに属するため、支える階数(N)も自階（targetGraph.plane）基準で算定する。
  // 在来木造（columnSizing:'fixed'）は柱寸法を欄で決めるため負担面積からの概算を行わない（ownRulesは冒頭で集約済み）。
  const updatedColumnSizes = ownRules.columnSizing === 'fixed' ? [] : runInAction(() => autoFillColumnSizes(targetGraph, project, targetGraph.plane));
  const updatedFootingSizes = runInAction(() => autoFillColumnBaseSizes(targetGraph, project));
  // 基礎梁(role:'foundation')の梁幅b・梁成Dを、建物全体の最長スパン・最大柱幅から再算定する。
  const updatedBeamSizes = runInAction(() => autoFillFoundationBeamSizes(targetGraph, project));
  // 軒桁を含む横架材(role:'eaves')の梁幅b・梁成Dを、屋上伏図自身の最長スパンから再算定する。
  const updatedRoofBeamSizes = runInAction(() => autoFillRoofBeamSizes(targetGraph));
  // 採番の収集フェーズ: 台帳（分割・統合の明示操作）へ conform し、材寸グループを
  // project.memberNumberIndex（建物全体、非永続キャッシュ）へ積む。番号の確定（assignNumbers/applyNumbers）
  // は建物全体の情報が必要なため、呼び出し側（structuralOrchestration.js の反映パス）が2パス目として行う。
  runInAction(() => {
    // ownRulesは冒頭で集約済み（在来木造columnMapのjoin照合を階スコープの加入署名で解決させるため
    // rules・graph.plane.idを渡す。QA裁定2026-09-17）。
    conformToLedger(targetGraph, project, ownRules, targetGraph.plane.id);
    collectFloorGroups(targetGraph, project);
  });

  const changed = newColumns.length > 0 || removedColumns.length > 0 || newFootings.length > 0 || newBeams.length > 0
    || removedBeams.length > 0
    || matFoundation.created.length > 0 || matFoundation.removed.length > 0
    || convertedColumns.length > 0 || convertedBeams.length > 0 || convertedFootings.length > 0 || conformedSections.length > 0
    || removedByClass.length > 0
    || updatedColumnSizes.length > 0 || updatedFootingSizes.length > 0 || updatedBeamSizes.length > 0
    || updatedRoofBeamSizes.length > 0 || updatedBeamEcc.length > 0 || updatedBeamDepths.length > 0
    || updatedColumnEcc.length > 0;
  const after = captureSnapshots ? (changed ? serializeGraph(targetGraph) : before) : null;
  return { changed, before, after };
}
