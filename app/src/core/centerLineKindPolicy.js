/**
 * CL（通り芯・中心線・補助線・梁芯）種別間の関係を導出する純粋ポリシーモジュール。
 *
 * 「CL種別ごとにどのappModeで可視か」「同座標に2種別が共存できるか」「直交端部の候補になれるか」
 * 「同方向の移動障害物になれるか」「通り芯⇔中心線の入替えを拒否するか」「結合しうるか」——これらは
 * 元々、呼び出し元ごとに種別条件をインラインで手書きしていた（重複実装が食い違って起きる不具合の
 * 温床）。本モジュールはそれらが本来従うべき単一の表（原始事実）と、そこからの導出関数
 * （種別レベルAPI）・graph.centerLines を種別条件で絞り込む走査API（orthoAnchorCandidates(ForNew)・
 * sameDirectionObstacles・sameCoordCounterparts・mergeCandidates・candidatesVisibleIn等）を集約する。
 *
 * 移行の経緯（ステップ1〜8、2026-09-18〜2026-09-20）: 特性テスト（centerLineKindPolicy.test.js）で
 * 既存呼び出し元の現行動作と導出結果の一致を固定する段階を経て、centerLineOps.js・
 * centerLineExtend.js・followerGraph.js・beamAxisMove.js・snap.js・snapGeometry.js・
 * centerLineConvert.js・centerLineFloorSync.js・CenterLinesLayer.jsx・App.jsx・openingMove.js・
 * centerLineMerge.js・floorCLMap.js・interaction/gutterHitTest.js の主要な相手選択・可視性判定を
 * 順次、種別レベルAPI／走査API経由へ移行した（各移行時に生じた「旧データ限定の既知の乖離」の解消は
 * centerLineKindPolicy.test.js内の「旧データ限定・種別ベースへ統一」と付記したテストにピン留めしてある。
 * interaction/gutterHitTest.js findGutterCL の乖離ピン留めは同ファイルのテスト
 * interaction/gutterHitTest.test.js 側に置く——同ファイルはinteraction/配下の慣例に合わせ、
 * 対象関数と同じディレクトリにテストを置くため）。
 *
 * ステップ7（ガード有効化、2026-09-20）で移行の入口を機械的に閉じた: core/centerLineKindPolicy.guard.test.js
 * が app/src 配下の製品コードを走査し、(G1) graph.centerLines の種別条件なし直接走査・(G2) 生の
 * labeled を種別の代用に読む・(G3) centerLineKind(x)==='<リテラル>' のインライン比較、の3種を
 * allowlist の件数を超えて増やせないようにする——「未移行地点の一覧」は同ガードテストの
 * G1_ALLOWLIST/G2_ALLOWLIST/G3_ALLOWLIST を唯一の供給源とする（本コメントには重複して書かない。
 * 各エントリの理由・対象関数はそちらを参照）。（snapGeometry.jsの3地点＝findNearestCenterLine・
 * findNearbyCenterLines・nonLabeledClExtentは2026-09-20に種別ベース（spansEntireAxis／
 * gridCenterLinesOnAxis）へ移行済み——ガードのG2からは外れた。距離計算を伴う最近傍探索自体の
 * graph.centerLines直接走査（G1）は性能上の理由でnot-partner-selection区分のまま残る。
 * finish/gridCells.js・finish/edgeClassify.js・finish/wallGeneration.js・finish/stair/
 * stairUnderSplit.js・transform/followerGraph.js のCL種別分類はステップ6（2026-09-20）で
 * isFinishCellDivider／isUnderStairSplitKind／axisLineKindOf／isGridCenterLine／spansEntireAxis
 * 経由へ移行済み——gridCells.jsのsnapshotCLコピー1件（G2）とstairUnderSplit.jsの幾何署名走査1件
 * （G1）のみnot-partner-selection区分で残る）。
 * structural/wallBeamAxes.js（findBeamAnchorCL・findWallBeamAxisCL）・structural/woodAutoFill.js
 * （findCenterAnchorCL・nearestAnchorCL・支持長超過候補）・structural/structuralAutoFill.js
 * （beamAxisCenterLines）の柱アンカー解決の一群はステップ7（柱アンカー解決の移行、2026-09-20）で
 * STRUCTURAL_ANCHOR_KINDS／BEAM_AXIS_KINDS／SUPPORT_SPAN_COLUMN_KINDS（原始事実12）経由の
 * structuralAnchorAt／structuralAnchorCandidates／beamAxisAt／beamAxisCenterLines／
 * supportSpanColumnCandidates へ移行済み——ガードのallowlistから外れ、`unmigrated` 区分は0件に
 * なった。resolveCLById（structuralAutoFill.js。id文字列からの実CL解決）だけはid解決であり相手選択
 * ではないため not-partner-selection のまま残る。
 * interaction/usePointerInteraction.js の中心⇔通り芯入替え
 * メニュー可否（canToGrid/canToCenter/isLastGridOnAxis）は interaction/clMenuGating.js（isConvertSubject
 * 経由）へ移行済み——centerLineConvert.jsの昇格・降格ガードと同じ主体判定を共有する。梁芯移動スナップの
 * 呼び分けはclMenuGating.jsを経由せず、usePointerInteraction.jsがusesBeamAxisMoveSnapを直接利用する。
 *
 * import ゼロに近い規約（extractedModuleImportInvariant）: ./centerLine.js（centerLineKind・
 * isGridCenterLine）と ./constants.js（CenterLineType）のみに依存する。store.js/snap.js/.jsx/
 * core.js バレル/error.js は静的 import しない——node:test から本ファイルを単体 import 可能に保つため。
 */
import { centerLineKind, isGridCenterLine } from './centerLine.js';
import { CenterLineType, CL_OVERLAP_TOL_MM } from './constants.js';

export const CL_KINDS = Object.freeze(['struct', 'center', 'aux', 'beam']);

// ui/ModeBar.jsx の MODES（mode値）∪ ['opening']。建具モードはモードバーにボタンを持たないが、
// App.jsx の appMode としては存在する（ModeBar.jsx冒頭コメント参照。平面モードでの建具追加・
// 他モードでの建具ターゲットクリックの2経路から遷移する）。
export const APP_MODES = Object.freeze(['floorplan', 'finish', 'opening', 'structure', 'site', 'elevation']);

function assertKnownKind(kind) {
  if (!CL_KINDS.includes(kind)) throw new Error(`未知のCL種別: ${kind}`);
}
function assertKnownMode(appMode) {
  if (!APP_MODES.includes(appMode)) throw new Error(`未知のappMode: ${appMode}`);
}

// ---- 原始事実1: 可視モード表 ----
// renderer/CenterLinesLayer.jsx L61-68（梁芯は appMode==='structure' でのみ描画、意匠CL＝中心線・
// 補助線は構造モードでは非表示）＋ renderer/SceneLayers.jsx（CenterLinesLayer は GutterLayer 経由で
// しか呼ばれない。site は `appMode !== 'site'` で GutterLayer 自体を描かない／elevation は専用画面
// （早期return）で GutterLayer を含む共有レイヤ群を一切通らない）の統合。
// floorplan の可視集合を変えると連動する箇所（ステップ6、2026-09-20）: openings/openingMove.js
// openingSnapCandidates 内の candidatesVisibleIn(graph, {appMode:'floorplan', centerLineType})
// （建具の吸着候補。ステップ7、2026-09-20で走査API化）、および moveSnapTargetKinds（struct/center/aux
// の移動スナップ吸着先。floorplan で可視な種別の和で決まる。下記コメント参照）が自動的に広がる/
// 狭まる——floorplan は他の可視モード表と違い、複数の独立した導出先を持つため変更時は影響範囲を
// この2箇所も含めて確認すること。
export const VISIBLE_KINDS_BY_MODE = Object.freeze({
  floorplan: Object.freeze(['struct', 'center', 'aux']),
  finish:    Object.freeze(['struct', 'center', 'aux']),
  opening:   Object.freeze(['struct', 'center', 'aux']),
  structure: Object.freeze(['struct', 'beam']),
  site:      Object.freeze([]),
  elevation: Object.freeze([]),
});

// ---- 原始事実2: ヒット除外表 ----
// snap.js resolvePointerTargets の clKindFilter（structureモードは梁芯のみ・それ以外は梁芯以外）を
// 「可視種別からの除外」として表現したもの。site/elevation はこの表に現れない＝除外なしだが、可視
// モード表では両モードとも空集合——hitTestKinds() は「可視モード表 ∩ (全種別 − ヒット除外表)」を
// 計算するため、site/elevationはこの表の値に関わらず可視モード表（空集合）に揃う。
// 【可視表どおり（根拠: 到達可能性を確認済み）】snap.js resolvePointerTargets は
// interaction/usePointerInteraction.js updateSnap からのみ呼ばれる（唯一の呼び出し元）——
// pointerDown/pointerMoveはappMode==='site'|'elevation'で専用処理の後に早期returnし、updateSnap・
// longPress.begin に到達しない。site は handleWheel（appModeで分岐しない）経由でのみ updateSnap に
// 到達するが、その結果（nearCL/nearCLEndpoint/snapPoint等）を参照するカーソル・メニュー
// （App.jsx cursor算出・interaction/menuItems.js detectContext）はいずれも site 専用の別分岐
// （mode?.siteDrawState依存のcursor・longPress不発火）に倒れて未使用。elevation は resolvePointerTargets
// へ到達する経路自体が無い（pointerDown/Move/Wheelいずれもappmode==='elevation'で専用処理のみ）。
// よって可視モード表（VISIBLE_KINDS_BY_MODE.site/elevation=[]）に揃えてもユーザーに見える挙動は
// 変わらない（2026-09-20 ステップ6で確認・snap.js側もこの表に統一済み）。
export const HIT_EXCLUDED_KINDS_BY_MODE = Object.freeze({
  structure: Object.freeze(['struct']),
});

// ---- 原始事実3: 同位置共存行列 ----
// transform/centerLineOps.js L491-591 addCenterLineFromDialog の重複判定を種別×種別の行列へ一般化。
// COEXISTENCE[newKind][existingKind]:
//   'forbidden' — 追加を拒否する
//   'extent'    — 同種別のextentが重ならなければ許可する（重なれば拒否／隣接すれば結合連鎖へ）
//   'allowed'   — 無条件で許可する
//   'promote'   — 既存を削除し、新規（通り芯）へ昇格する
export const COEXISTENCE = Object.freeze({
  struct: Object.freeze({ struct: 'forbidden', center: 'promote',  aux: 'allowed',   beam: 'forbidden' }),
  center: Object.freeze({ struct: 'forbidden', center: 'extent',   aux: 'allowed',   beam: 'allowed'   }),
  aux:    Object.freeze({ struct: 'allowed',   center: 'allowed',  aux: 'extent',    beam: 'allowed'   }),
  beam:   Object.freeze({ struct: 'forbidden', center: 'forbidden', aux: 'forbidden', beam: 'extent'   }),
});

// ---- 原始事実4: 直交端部アンカーの特例 ----
// transform/centerLineOps.js 追加extent・transform/centerLineExtend.js 延長短縮: 梁芯の端部候補は
// 通り芯のみに限定する（autoFillSecondaryBeamsが見るgraph.gridXs/Ysは通り芯のみのため、中心線・
// 補助線を候補に含めると直交グリッドに存在しない区画へextentが確定し小梁0本事故になる）。可視性
// （kindsVisibleWith）からは導けない唯一の上書き。両呼び出し元とも orthoAnchorCandidates 経由に
// 移行済み（2026-09-19）——種別ベースで判定するため、旧データ（`{labeled:true, discipline:'arch'}`
// のような labeled と種別が食い違う異常値）による乖離は解消済み。
export const ORTHO_ANCHOR_OVERRIDE = Object.freeze({
  beam: Object.freeze(['struct']),
});

// ---- 原始事実5: 小表 ----
// 壁をextentアンカーにしうる種別（centerLineOps.js aux分岐の perpWalls）。
export const WALL_ANCHOR_KINDS = Object.freeze(['aux']);
// extent境界の解決方式（'none'=通り芯は常にガター~ガター全幅／'ref'=直交CL参照／
// 'overhang'=はね出し量を引いた静的値）。
// aux の 'overhang' は既存の別補助線が同じ直交CLをextentLoRef/HiRefで既に参照している場合
// （anyAuxRefsCL、centerLineOps.js L443-451/469-475）に限り 'ref'（直交CL参照・リアクティブ追従）へ
// 切り替わる——「その位置に初めて補助線を足す」ときだけ静的なはね出し値になる。
// 直交CL・壁のどちらも無い位置では、はね出しではなくポインタ座標をキリ良く丸めた静的値
// （centerLineOps.js L452-456/476-480 の roundToNiceCoord。フリーエンドポイント）になる。
export const EXTENT_ANCHOR_STYLE = Object.freeze({
  struct: 'none', center: 'ref', aux: 'overhang', beam: 'ref',
});
// 端点ルール（isEndpointAt）の対象種別（中心線・梁芯。補助線はフリー端点を持つため対象外）。
export const ENDPOINT_RULE_KINDS = Object.freeze(['center', 'beam']);
// 常に全軸（ガター~ガター）に及ぶ種別（＝端部候補・障害物判定で「extentを持たない」として扱う種別）。
// VERIFIED（renderer/CenterLinesLayer.jsx clExtent L23-31）: 通り芯の `trim:true` はガター～ガター
// ではなく直交labeled CLの端でカットするが、これは描画（画面上の線分の長さ）だけの話——
// coversAlongAxis 等ドメイン側の判定は cl.trim を一切参照せず、通り芯は trim の値に関わらず
// 常に全域扱いのまま（coversAlongAxis が種別 struct で短絡するため extentLo/Hi の値に依らない）。
export const FULL_SPAN_KINDS = Object.freeze(['struct']);
// 入替え方向（'promote'=中心線→通り芯／'demote'=通り芯→中心線）が拒否する既存種別
// （transform/centerLineConvert.js checkPromoteToGridGuards の dupStruct/dupBeam、
//   checkDemoteToCenterGuards の dupCenter）。dupCenter は種別ベース（centerLineKind(c)）で判定して
// おり、`!c.labeled` のような生フィールド代用ではない——`{labeled:true, discipline:'arch'}` のような
// 旧データも種別（center/aux）どおりに拒否する（centerLineConvert.test.js「旧データ限定・種別ベースへ
// 統一」参照。以前ここに記載していた「既知の乖離」は移行前の実装を指す古い記述だったため訂正した）。
export const CONVERT_BLOCKING_KINDS = Object.freeze({
  promote: Object.freeze(['struct', 'beam']),
  demote:  Object.freeze(['center', 'aux']),
});

// ---- 原始事実6: 他階の入替え相手種別（優先順つき） ----
// transform/centerLineFloorSync.js findFloorsWithCounterpartCL: 通り芯は全階共有（project.structGraph）
// のため、同一座標の他階CLはCONVERT_BLOCKING_KINDS（同階内の入替えガード。方向ごとに別集合）とは
// 別の関係になる——通り芯自身（同じ全階共有オブジェクト）は他階の「別の相手」たりえない一方、
// 中心線・補助線・梁芯はいずれも階ローカルの実体のため、他階に同座標のものがあれば入替え後に座標が
// 重複する衝突相手になる（昇格・降格どちらの方向でも同じ集合）。
// 並び順は優先順（1つの階に複数種別が同座標にあるとき、報告に使う1種別を選ぶ規約）も兼ねる——
// transform/centerLineOps.js addCenterLineFromDialog の重複判定が同座標の相手を選ぶ優先順
// （通り芯＞中心線＞補助線＞梁芯。CL_KINDSの並びそのもの）から通り芯を除いたものと同じ
// （中心線・補助線 ＞ 梁芯）。
export const CROSS_FLOOR_COUNTERPART_KINDS = Object.freeze(['center', 'aux', 'beam']);

// ---- 原始事実7: 建具がまたげない境界種別 ----
// openings/openingMove.js isBlockingKind（ステップ6、2026-09-20移行）: 建具の可動範囲を区切る境界
// （壁を横切ってもまたげないCL）になるのは通り芯・中心線のみ——どちらも壁の実際の区画（間仕切り・
// 通り芯）を表すのに対し、補助線は作図補助のための参照線（壁の区画ではない）、梁芯は構造専用の軸
// （間仕切りではない）でどちらも実体の間仕切りを持たないためまたげる（ユーザー裁定 2026-09-14。
// openingMove.js冒頭コメント参照）。可視性由来の集合（kindsVisibleIn等）からは導出できない独立の
// 事実——可視性は「appModeで描かれるか」、こちらは「建具移動の物理境界になるか」で判定軸が異なる
// （事実、VISIBLE_KINDS_BY_MODEのどのモードの可視集合ともstruct+centerの2つだけの組合せは一致しない）。
export const OPENING_BOUNDARY_KINDS = Object.freeze(['struct', 'center']);

// ---- 原始事実8: 入替えの主体種別（CONVERT_BLOCKING_KINDSの対になる表） ----
// transform/centerLineConvert.js checkPromoteToGridGuards／checkDemoteToCenterGuardsの「渡されたclが
// 変換元として妥当か」（CONVERT_BLOCKING_KINDSは「変換先に既にある相手を拒否するか」で別の関係）。
// promoteの主体は中心線（centerLineKind==='center'）、demoteの主体は通り芯（isGridCenterLine。
// centerLineKind==='struct'だけでなくlabeledも要求——旧データ{labeled:false, discipline:STRUCT}を
// 主体から除外するのはisConvertSubjectの責務）。
export const CONVERT_SUBJECT_KINDS = Object.freeze({ promote: 'center', demote: 'struct' });

// ---- 原始事実9: 梁芯専用の移動スナップ許可表（HIT_EXCLUDED_KINDS_BY_MODEと同じ形の小表） ----
// interaction/usePointerInteraction.js のCL移動中pointermoveが、梁芯専用スナップ
// （findBeamAxisMoveSnap）と通常スナップ（findCLMoveSnap）のどちらを呼ぶかを appMode×kind で決める。
// 現行は構造モードで梁芯を動かすときのみ梁芯専用スナップを使う——hitTestKinds('structure')=['beam']の
// ため、構造モードでCL移動できるのは実質梁芯のみ（他種別はヒットしない）。
export const BEAM_AXIS_MOVE_SNAP_KINDS_BY_MODE = Object.freeze({ structure: Object.freeze(['beam']) });

// ---- 原始事実10: 仕上げモードのセル分割線になる種別（通り芯側を除く） ----
// finish/gridCells.js isDividerCL: 部屋領域のセル分割線として扱われるのは「通り芯
// （isGridCenterLine。labeled必須）」または「中心線（center。labeledの値は問わない）」の
// 2通りのみ——補助線(aux)・梁芯(beam)は分割線にならない。
//
// 【旧データ限定・種別ベースへ統一】中心線側は種別（centerLineKind）のみで判定し、labeled は
// 見ない。`{labeled:true, discipline:ARCH, lineType:'center'}`（通り芯でも補助線でもないのに
// labeled:true な旧データ）は、HEAD（`!labeled && lineType!=='dashed' && discipline===ARCH`の
// 生フィールド判定）では分割線に不参加だったが、種別ベースでは参加する
// （finish/gridCells.test.js「【旧データ限定・種別ベースへ統一】」参照）。
export const FINISH_CELL_DIVIDER_KINDS = Object.freeze(['center']);

// ---- 原始事実11: 階段下分割CLとして認める種別 ----
// finish/stair/stairUnderSplit.js ensureUnderStairSplit が生成し、isSplitCLFor が幾何署名
// （外形内部を横切り、extentが外形の直交範囲と一致する）と組み合わせて同定する「階段下の
// 分割線」は中心線（center）のみ——通り芯・補助線・梁芯はこの用途の分割線として認めない
// （「階段下の分割線は中心線」という、原始事実10（セル分割線。通り芯もOR対象）とは別の事実
// のため、FINISH_CELL_DIVIDER_KINDSは流用しない）。
export const UNDER_STAIR_SPLIT_KINDS = Object.freeze(['center']);

// ---- 原始事実12: 柱アンカー解決の対象種別（小表3つ） ----
// structural/wallBeamAxes.js findBeamAnchorCL・structural/woodAutoFill.js resolveWoodColumnAnchorCL
// （findBeamAnchorCL ?? findCenterAnchorCL）が共有する2段のアンカー解決——在来木造の壁交点柱・上階柱
// 直下の柱・建具の袖柱・支持長超過の追加柱がCL座標へ解決する相手。第1候補＝通り芯・梁芯、第2候補＝壁の
// ある意匠中心線（ユーザー指示2026-09-14「壁のある『中心』との交点にも柱は立つ」。通り芯・梁芯が無い
// 位置——梁芯の除外集合で梁芯CLが作られない壁など——でも、壁が乗っている中心線があれば柱を立てる）。
export const STRUCTURAL_ANCHOR_KINDS = Object.freeze({
  primary:   Object.freeze(['struct', 'beam']),
  secondary: Object.freeze(['center']),
});
// STRUCTURAL_ANCHOR_KINDS.primary の通り芯側は labeled を要求しない（centerLineKind==='struct'のみで
// 判定する）——梁芯の重複ガード（wallBeamAxes.js autoFillWallBeamAxes）が「beamAxisMoveRangeの障害物
// 集合と同じ規約に揃える」ため（sameDirectionObstacleKinds経由の集合は種別のみで判定する）。梁芯の
// 重複ガード（autoFillWallBeamAxes・wallBeamAxisFollow.js followWallBeamAxes）と柱アンカー第1候補は
// 同じ集合を共有する——片方だけ変えると柱が湧く／消える。VISIBLE_KINDS_BY_MODE.structure（['struct',
// 'beam']）と primary の集合は結果として一致するが、そちらから導出してはいない（可視モード表を変えても
// アンカーは動かしてはいけない別の事実のため）。
// 'any'（primary∪secondary。CL_KINDSの並び順）はモジュールレベルで1度だけ生成しfreezeする。
const STRUCTURAL_ANCHOR_KINDS_ANY = Object.freeze(CL_KINDS.filter(k =>
  STRUCTURAL_ANCHOR_KINDS.primary.includes(k) || STRUCTURAL_ANCHOR_KINDS.secondary.includes(k)));

// wallBeamAxisFollow.js followWallBeamAxes の追従元探索（findWallBeamAxisCL。通り芯を動かさないため
// STRUCTURAL_ANCHOR_KINDS.primaryは使わない）と、structuralAutoFill.js の梁芯CL全件列挙
// （beamAxisCenterLines）が共有する。
export const BEAM_AXIS_KINDS = Object.freeze(['beam']);

// woodAutoFill.js 支持長超過時の追加柱の走行方向候補（ユーザー指示2026-09-19「梁の支持長が1820を超える
// 場合、1820以内の下階に壁あり直交する通り芯、中心があればそこ、なければ…910グリッドに柱を追加」の
// 語順どおり通り芯＞中心線の優先度——並び＝優先度。woodAutoFill.js 3iのコメント参照）。梁芯を候補から
// 除くのは、梁芯は壁から自動で生成・撤去される線であり柱の位置の基準にしないため（通り芯・中心線は
// ユーザーが引いた線。2026-09-20確認）。
// structural/woodFraming.js の支持長超過候補の優先順（SUPPORT_SPAN_PRIORITY_ORDER。CL以外の候補源
// belowを本表の後に足したもの）はこの並びから導出される——構造側にこの並びを重複して書かない。
export const SUPPORT_SPAN_COLUMN_KINDS = Object.freeze(['struct', 'center']);

// ================================================================
// 種別レベルAPI
// ================================================================

/** appMode で描画・操作対象になる種別（原始事実そのもの）。 */
export function kindsVisibleIn(appMode) {
  assertKnownMode(appMode);
  return VISIBLE_KINDS_BY_MODE[appMode];
}

/** appMode でポインタヒット対象になる種別（可視種別からヒット除外分を引く）。 */
export function hitTestKinds(appMode) {
  const visible = kindsVisibleIn(appMode);
  const excluded = HIT_EXCLUDED_KINDS_BY_MODE[appMode] ?? [];
  return visible.filter(k => !excluded.includes(k));
}

/**
 * kind が可視になるいずれかの appMode について、そのモードの可視種別全体を合算した集合
 * （CL_KINDS の順に整列）。kindsVisibleWith(k) = ⋃{VISIBLE_KINDS_BY_MODE[m] : k が m で可視}。
 */
export function kindsVisibleWith(kind) {
  assertKnownKind(kind);
  const set = new Set();
  for (const mode of APP_MODES) {
    const visible = VISIBLE_KINDS_BY_MODE[mode];
    if (visible.includes(kind)) visible.forEach(k => set.add(k));
  }
  return CL_KINDS.filter(k => set.has(k));
}

/** kind の直交端部アンカー候補種別。特例（ORTHO_ANCHOR_OVERRIDE）があればそれ、無ければ kindsVisibleWith(kind)。 */
export function orthoAnchorKinds(kind) {
  assertKnownKind(kind);
  return ORTHO_ANCHOR_OVERRIDE[kind] ?? kindsVisibleWith(kind);
}

/**
 * kind の同方向（同centerLineType）移動障害物候補種別。
 * structural/beamAxisMove.js（beamAxisMoveRange）・snap.js（findBeamAxisMoveSnap）の梁芯移動障害物
 * 判定は本関数（sameDirectionObstacles経由）へ移行済み（種別ベースへ統一。旧「既知の乖離」＝生の
 * `other.labeled` で通り芯扱いを判定していた分は解消。ステップ4、2026-09-19）。
 */
export function sameDirectionObstacleKinds(kind) {
  return kindsVisibleWith(kind);
}

/**
 * kind の移動スナップ吸着先種別（障害物候補とは別の関係）。findCLMoveSnap（moving=struct/center/aux）は
 * 障害物集合（sameDirectionObstacleKinds）と異なり、moving=structでもbeamへは吸着しない——吸着先は
 * 「主体がヒット可能ないずれかのappModeで可視な種別の和」= ⋃{VISIBLE_KINDS_BY_MODE[m] : kind ∈ hitTestKinds(m)}。
 * struct/center/aux はいずれも hitTestKinds経由でfloorplan/finish/openingにしか現れないため、この3種は
 * 同じ結果（['struct','center','aux']）になる——現行 findCLMoveSnap（moving種別を問わずbeamを無条件除外）
 * と一致することを centerLineKindPolicy.test.js で固定している。beam自身は findCLMoveSnap を通らない
 * （呼び出し元 interaction/usePointerInteraction.js の updatePointer が
 * `appMode === 'structure' && centerLineKind(cl) === 'beam'` の場合のみ findBeamAxisMoveSnap を、
 * それ以外（appMode!=='structure'、または appMode==='structure'でもcl種別がbeam以外——後者は現行
 * hitTestKinds('structure')=['beam']のため実際には発生しない組み合わせ）は findCLMoveSnap を呼ぶ）。
 * 導出は VISIBLE_KINDS_BY_MODE に連動する——site/elevation のヒットを有効化するには可視表
 * （VISIBLE_KINDS_BY_MODE.site/elevation、現状どちらも空配列）を非空にする必要があり、その時点で
 * hitTestKinds(site/elevation)も非空になり、moveSnapTargetKindsの吸着先も自動的に広がる（吸着先だけを
 * 個別に拡張することはできない設計）。
 */
export function moveSnapTargetKinds(kind) {
  assertKnownKind(kind);
  const set = new Set();
  for (const mode of APP_MODES) {
    if (hitTestKinds(mode).includes(kind)) {
      VISIBLE_KINDS_BY_MODE[mode].forEach(k => set.add(k));
    }
  }
  return CL_KINDS.filter(k => set.has(k));
}

/** newKind を existingKind と同座標へ追加しようとしたときの帰結（COEXISTENCE行列）。 */
export function coexistenceAt(newKind, existingKind) {
  assertKnownKind(newKind);
  assertKnownKind(existingKind);
  return COEXISTENCE[newKind][existingKind];
}

/** 変換方向（'promote'=中心線→通り芯／'demote'=通り芯→中心線）が拒否する既存種別。 */
export function convertBlockingKinds(direction) {
  if (!Object.prototype.hasOwnProperty.call(CONVERT_BLOCKING_KINDS, direction)) {
    throw new Error(`未知の変換方向: ${direction}`);
  }
  return CONVERT_BLOCKING_KINDS[direction];
}

/** 変換方向（'promote'/'demote'）の変換元として妥当な種別（CONVERT_SUBJECT_KINDS）。 */
export function convertSubjectKind(direction) {
  if (!Object.prototype.hasOwnProperty.call(CONVERT_SUBJECT_KINDS, direction)) {
    throw new Error(`未知の変換方向: ${direction}`);
  }
  return CONVERT_SUBJECT_KINDS[direction];
}

/** kind と結合しうる種別（現行は同種別のみ）。 */
export function mergeableKinds(kind) {
  assertKnownKind(kind);
  return [kind];
}

/**
 * 柱アンカー解決の候補種別（STRUCTURAL_ANCHOR_KINDS参照）。tier='primary'|'secondary'|'any'。
 * 未知のtierはthrow——呼び出し元の引数ミスをその場で気付けるようにする。
 * @param {'primary'|'secondary'|'any'} tier
 * @returns {ReadonlyArray<string>}
 */
export function structuralAnchorKinds(tier) {
  if (tier === 'primary') return STRUCTURAL_ANCHOR_KINDS.primary;
  if (tier === 'secondary') return STRUCTURAL_ANCHOR_KINDS.secondary;
  if (tier === 'any') return STRUCTURAL_ANCHOR_KINDS_ANY;
  throw new Error(`未知のtier: ${tier}`);
}

/** kind が壁を extent アンカーにしうるか。 */
export function allowsWallAnchor(kind) {
  assertKnownKind(kind);
  return WALL_ANCHOR_KINDS.includes(kind);
}

/** kind が建具の可動範囲の境界（またげない）になるか。 */
export function isOpeningBoundaryKind(kind) {
  assertKnownKind(kind);
  return OPENING_BOUNDARY_KINDS.includes(kind);
}

/** kind の extent 境界解決方式。 */
export function extentAnchorStyle(kind) {
  assertKnownKind(kind);
  return EXTENT_ANCHOR_STYLE[kind];
}

/** kind が端点ルール（isEndpointAt）の対象か。 */
export function hasEndpointRule(kind) {
  assertKnownKind(kind);
  return ENDPOINT_RULE_KINDS.includes(kind);
}

/** kind が常に全軸へ及ぶか。 */
export function spansEntireAxis(kind) {
  assertKnownKind(kind);
  return FULL_SPAN_KINDS.includes(kind);
}

// ================================================================
// CLレベルAPI
// ================================================================

/**
 * cl が direction（'promote'=中心線→通り芯／'demote'=通り芯→中心線）の変換元として妥当か
 * （transform/centerLineConvert.js checkPromoteToGridGuards／checkDemoteToCenterGuardsの入力ガードと、
 * UI側のメニュー可否判定（interaction/clMenuGating.js）が共有する唯一の述語）。
 * RADIAL は変換の対象外（centerLineConvert.jsのV/Hガードと同じ）。
 * @param {object} cl
 * @param {'promote'|'demote'} direction
 * @returns {boolean}
 */
export function isConvertSubject(cl, direction) {
  if (!cl) throw new Error(`isConvertSubject: clは必須です（実際: ${cl}）`);
  const kind = convertSubjectKind(direction);
  if (cl.centerLineType !== CenterLineType.VERTICAL && cl.centerLineType !== CenterLineType.HORIZONTAL) return false;
  return kind === 'struct' ? isGridCenterLine(cl) : centerLineKind(cl) === kind;
}

/**
 * cl の移動中、appMode で梁芯専用の移動スナップ（findBeamAxisMoveSnap）を使うか
 * （使わない場合は通常のfindCLMoveSnapを使う。interaction/usePointerInteraction.js のCL移動
 * pointermoveハンドラが呼び分けに使う）。
 * @param {object} cl
 * @param {string} appMode
 * @returns {boolean}
 */
export function usesBeamAxisMoveSnap(cl, appMode) {
  assertKnownMode(appMode);
  return (BEAM_AXIS_MOVE_SNAP_KINDS_BY_MODE[appMode] ?? []).includes(centerLineKind(cl));
}

/**
 * cl が tier（'primary'|'secondary'|'any'）の柱アンカー候補か（structuralAnchorKinds参照）。
 * 実在の CenterLine またはその POJO スナップショット専用——未生成の仮想候補（discipline／lineType を
 * 持たないダック型オブジェクト）を渡すと、centerLineKind が黙って既定種別'center'に落ちる。
 * @param {object} cl
 * @param {'primary'|'secondary'|'any'} tier
 * @returns {boolean}
 */
export function isStructuralAnchor(cl, tier) {
  if (!cl) throw new Error(`isStructuralAnchor: clは必須です（実際: ${cl}）`);
  return structuralAnchorKinds(tier).includes(centerLineKind(cl));
}

/**
 * cl が coord を軸方向に覆っているか（延長・追加extentの境界判定で使う）。
 * struct、または cl.labeled（旧データ互換——本来 labeled:false のはずの中心線・補助線・梁芯が
 * 旧データで labeled:true のまま残っているケースを、可視性の判定を変えずに全域扱いへ倒す。
 * `|| cl.labeled` は意図的に残す）なら常に true。extent の片側が未解決（null）でも true
 * （はね出し未確定側を障害物にしない）。それ以外は閉区間 [extentLo-tolMm, extentHi+tolMm] に
 * coord が含まれるかで判定する。
 */
export function coversAlongAxis(cl, coord, tolMm = 0) {
  if (centerLineKind(cl) === 'struct' || cl.labeled) return true;
  const { extentLo, extentHi } = cl;
  if (extentLo == null || extentHi == null) return true;
  return coord >= extentLo - tolMm && coord <= extentHi + tolMm;
}

/**
 * 直交端部アンカー候補の判定本体（種別許可＋方向＋範囲被覆）。isOrthoAnchorCandidate（既存CL同士の
 * 単発判定）と orthoAnchorCandidatesForNew（まだグラフに存在しない新規CL用の走査）が共有する唯一の
 * 実装——呼び出し元ごとに再実装すると同じ規約が個別に食い違う（transform/centerLineOps.js・
 * transform/centerLineExtend.js 移行時の教訓。過去に3回、種別条件の無い素の graph.centerLines 走査が
 * 個別に混入して不具合になった）。RADIAL の other は常に false（直交判定が成立しないため）。
 * subject 側の RADIAL 除外は呼び出し元（isOrthoAnchorCandidate／orthoAnchorCandidatesForNew）が担う
 * （前者はsubjectオブジェクトから、後者はcenterLineType引数から判定する——本関数はsubjectオブジェクト
 * 自体を受け取らないため、ここでは判定できない）。
 */
function matchesOrthoAnchor(kind, subjectCenterLineType, other, coord, tolMm) {
  if (other.centerLineType === CenterLineType.RADIAL) return false;
  const subjectIsV = subjectCenterLineType === CenterLineType.VERTICAL;
  const otherIsV   = other.centerLineType === CenterLineType.VERTICAL;
  if (subjectIsV === otherIsV) return false;
  if (!orthoAnchorKinds(kind).includes(centerLineKind(other))) return false;
  return coversAlongAxis(other, coord, tolMm);
}

/**
 * other が subject の直交端部アンカー候補か（追加extent・延長・短縮で使う）。
 * 自身除外＋直交（VERTICAL⇔HORIZONTAL）＋種別（orthoAnchorKinds）＋coversAlongAxis(other, coord, tolMm)
 * を満たすこと。RADIAL は subject・other どちらでも false（直交判定が成立しないため）。
 * @param {{coord?: number, tolMm?: number}} [opts]
 */
export function isOrthoAnchorCandidate(subject, other, { coord = subject.value, tolMm = 0 } = {}) {
  if (subject === other) return false;
  if (subject.centerLineType === CenterLineType.RADIAL) return false;
  return matchesOrthoAnchor(centerLineKind(subject), subject.centerLineType, other, coord, tolMm);
}

/** other が subject と同方向（同 centerLineType）の移動障害物候補か（移動範囲・移動スナップで使う）。 */
export function isSameDirectionObstacle(subject, other) {
  if (subject === other) return false;
  if (subject.centerLineType !== other.centerLineType) return false;
  return sameDirectionObstacleKinds(centerLineKind(subject)).includes(centerLineKind(other));
}

/** other が subject の移動スナップ吸着先候補か（moveSnapTargetKinds ベース。findCLMoveSnap で使う）。 */
export function isMoveSnapTarget(subject, other) {
  if (subject === other) return false;
  if (subject.centerLineType !== other.centerLineType) return false;
  return moveSnapTargetKinds(centerLineKind(subject)).includes(centerLineKind(other));
}

/**
 * other が subject と結合しうるか（同 centerLineType・同種別・両者 labeled:false）。
 *
 * 製品コード（transform/centerLineMerge.js findCenterLineMergeMatch）は本述語ではなく走査API
 * mergeCandidates(graph, {centerLineType, kind, exclude}) 経由へステップ7（2026-09-20）で移行済み——
 * kind を呼び出し元が明示引数で渡す設計のため、本述語は製品コードから未参照（0件）のまま意図的に
 * 残してある（削除しない。centerLineKindPolicy.test.js の特性テストが本述語を直接参照する）。
 * 本述語（subjectオブジェクトからcenterLineKind(subject)を導出する形）が製品コードに向かない理由:
 * 結合の主体（subject）はまだグラフに存在しない仮想候補（centerLineOps.js の virtualCandidate。
 * addCenterLineFromDialog の同種別extent分岐）のことがあり、discipline/lineType を持たないため
 * centerLineKind(subject) が常に既定値 'center' に落ちてしまう（kind='aux'/'beam'の仮想候補を
 * 誤った種別で判定する事故になる）。つまり isMergeCandidate は **subject が実CLオブジェクト
 * （discipline/lineTypeを含む）である場面専用**——仮想候補が絡む場面では使えない。
 * mergeCandidates 側の設計・移行判断の詳細は centerLineMerge.test.js「仮想候補（discipline/lineType
 * 無し）でもkind引数どおりの種別だけを結合相手に選ぶ」参照。
 */
export function isMergeCandidate(subject, other) {
  if (subject === other) return false;
  if (subject.centerLineType !== other.centerLineType) return false;
  if (subject.labeled || other.labeled) return false;
  return mergeableKinds(centerLineKind(subject)).includes(centerLineKind(other));
}

/**
 * まだグラフに存在しない新規CL（AddCLDialog確定前など）の直交端部アンカー候補を graph.centerLines
 * から列挙する走査API。subject が実CLオブジェクトとして存在しない場面（追加ダイアログ確定前）向け——
 * isOrthoAnchorCandidate／orthoAnchorCandidates は既存CLオブジェクトの centerLineType/value に依存
 * するため、生成前に候補を絞りたい呼び出し元がダック型の仮オブジェクトを作ると、value の代わりに
 * coord を渡し忘れても例外にならず非labeled候補だけが静かに脱落する事故になりうる（QA実測:
 * 該当箇所で2件あるべき候補が1件になった）。kind・centerLineType・coord を必須の明示引数にすることで
 * この種の事故を型（呼び出し時の引数不足）で防ぐ。
 * graph は `{ centerLines: Array }` を持つオブジェクトとして引数で受けるだけで、PlanGraph自体は
 * import しない（import ゼロに近い規約を維持し、node:test から単体 import 可能に保つ）。
 * @param {{centerLines: Array}} graph
 * @param {{kind: string, centerLineType: string, coord: number, tolMm?: number, exclude?: object|null}} opts
 * @returns {Array} matchesOrthoAnchor(kind, centerLineType, other, coord, tolMm) を満たし、exclude
 *   自身は除く CenterLine の配列
 */
export function orthoAnchorCandidatesForNew(graph, { kind, centerLineType, coord, tolMm = 0, exclude = null }) {
  assertKnownKind(kind);
  if (typeof coord !== 'number' || Number.isNaN(coord)) {
    throw new Error(`orthoAnchorCandidatesForNew: coordは数値である必要があります（実際: ${coord}）`);
  }
  if (centerLineType === CenterLineType.RADIAL) return [];
  return graph.centerLines.filter(other =>
    other !== exclude && matchesOrthoAnchor(kind, centerLineType, other, coord, tolMm));
}

/**
 * subject の直交端部アンカー候補となる CenterLine を graph.centerLines から列挙する
 * （走査API。過去の不具合（追加→移動→延長の3回に分けて発覚した「非表示の梁芯が障害物になる」）は
 * いずれも「誤った種別条件」ではなく「種別条件の無い素の graph.centerLines 走査」が原因だった——
 * 呼び出し元がこの関数経由で相手を選ぶことで、同じ規約の再実装が個別に食い違うのを防ぐ）。
 * subject が既存CLオブジェクト（centerLineType/valueを持つ）である場面専用——orthoAnchorCandidatesForNew
 * へ委譲する薄いラッパー（判定の本体は matchesOrthoAnchor に一本化してある）。
 * @param {{centerLines: Array}} graph
 * @param {object} subject
 * @param {{coord?: number, tolMm?: number}} [opts]
 * @returns {Array} isOrthoAnchorCandidate(subject, other, opts) を満たす CenterLine の配列
 */
export function orthoAnchorCandidates(graph, subject, opts = {}) {
  return orthoAnchorCandidatesForNew(graph, {
    kind:           centerLineKind(subject),
    centerLineType: subject.centerLineType,
    coord:          opts.coord ?? subject.value,
    tolMm:          opts.tolMm ?? 0,
    exclude:        subject,
  });
}

/**
 * subject の同方向移動障害物候補となる CenterLine を graph.centerLines から列挙する走査API
 * （移動範囲・移動スナップで使う。orthoAnchorCandidates と同じ理由——過去に3回、種別条件の無い素の
 * graph.centerLines 走査が非表示の梁芯を障害物へ混入させる不具合の原因になった——で一本化する）。
 * @param {{centerLines: Array}} graph
 * @param {object} subject
 * @returns {Array} isSameDirectionObstacle(subject, other) を満たす CenterLine の配列
 */
export function sameDirectionObstacles(graph, subject) {
  return graph.centerLines.filter(other => isSameDirectionObstacle(subject, other));
}

/**
 * value（座標）・centerLineType（方向）が一致するCLを graph.centerLines から列挙する走査API
 * （同座標の重複判定・入替えガード・他階の相手探索で使う。orthoAnchorCandidates／sameDirectionObstacles
 * と同じ理由——過去に3回、種別条件の無い素の graph.centerLines 走査が不具合の原因になった——で
 * 一本化する）。種別（kind）による絞り込みは行わない——呼び出し側が coexistenceAt／
 * convertBlockingKinds／CROSS_FLOOR_COUNTERPART_KINDS の結果で判定する（本APIは「同座標の候補を
 * 集める」役割のみを持つ）。
 * exclude は同一グラフ内の既存CLを自分自身として除外する用途（オブジェクト参照比較）——異なる
 * グラフインスタンス間（例: 他階を peek した一時グラフ）の同一id除外にはならない。呼び出し側が
 * id で別途除外すること（transform/centerLineFloorSync.js findFloorsWithCounterpartCL 参照）。
 * @param {{centerLines: Array}} graph
 * @param {{centerLineType: string, value: number, tolMm?: number, exclude?: object|null}} opts
 * @returns {Array}
 */
export function sameCoordCounterparts(graph, { centerLineType, value, tolMm = CL_OVERLAP_TOL_MM, exclude = null }) {
  if (centerLineType == null) {
    throw new Error(`sameCoordCounterparts: centerLineTypeは必須です（実際: ${centerLineType}）`);
  }
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new Error(`sameCoordCounterparts: valueは数値である必要があります（実際: ${value}）`);
  }
  return graph.centerLines.filter(other =>
    other !== exclude && other.centerLineType === centerLineType && Math.abs(other.value - value) < tolMm);
}

/** cl が appMode で描画対象か（可視モード表そのもの）。 */
export function isRenderTarget(cl, appMode) {
  return kindsVisibleIn(appMode).includes(centerLineKind(cl));
}

/** cl が appMode でポインタヒット対象か。 */
export function isHitTestTarget(cl, appMode) {
  return hitTestKinds(appMode).includes(centerLineKind(cl));
}

/**
 * cl が仕上げモードのセル分割線（finish/gridCells.js isDividerCL）として扱われるか
 * （FINISH_CELL_DIVIDER_KINDS参照。通り芯はisGridCenterLine経由、それ以外は種別が中心線
 * （center）であること——labeledの値は問わない）。
 * discipline が arch/struct/fuse 以外（Discipline.MEP／ELEC。現行の CL 生成・デコード経路には
 * 存在しない）も centerLineKind 経由で種別上は中心線になるため true になる。
 *
 * 実在の CenterLine またはその POJO スナップショット（finish/gridCells.js snapshotCL 等、
 * labeled/discipline/lineType フィールドを持つもの）専用——未生成の仮想候補（discipline／
 * lineType を持たないダック型オブジェクト）を渡すと、centerLineKind が黙って既定種別'center'に
 * 落ちる（isFinishCellDivider.test『【失敗系】』参照）。
 * @param {object} cl
 * @returns {boolean}
 */
export function isFinishCellDivider(cl) {
  return isGridCenterLine(cl) || FINISH_CELL_DIVIDER_KINDS.includes(centerLineKind(cl));
}

/**
 * cl が階段下分割CL（finish/stair/stairUnderSplit.js isSplitCLFor）として認めうる種別か
 * （UNDER_STAIR_SPLIT_KINDS参照。幾何署名との組合せで最終判定するのは呼び出し側の責務）。
 * discipline が arch/struct/fuse 以外（Discipline.MEP／ELEC。現行の CL 生成・デコード経路には
 * 存在しない）も centerLineKind 経由で種別上は中心線になるため true になる。
 *
 * 実在の CenterLine またはその POJO スナップショット専用——未生成の仮想候補（discipline／
 * lineType を持たないダック型オブジェクト）を渡すと、centerLineKind が黙って既定種別'center'に
 * 落ちる（isUnderStairSplitKind.test『【失敗系】』参照）。
 * @param {object} cl
 * @returns {boolean}
 */
export function isUnderStairSplitKind(cl) {
  return UNDER_STAIR_SPLIT_KINDS.includes(centerLineKind(cl));
}

/**
 * cl の境界エッジ軸線区分（'grid'|'aux'|'center'）を返す。finish/edgeClassify.js
 * classifyAxisLineType が表示名（通り芯／補助線／中心線）へ変換する前の区分キー
 * （境界マスター選定 selectBoundaryMaster が「無名屋外×有名屋外」のペアで
 * OUTDOOR_FACILITY/CANTILEVER_WALLを分ける唯一の入力）。
 * 'grid'はisGridCenterLine（labeled必須）経由、それ以外はcenterLineKindが'aux'かどうかだけを見る
 * ——'beam'（梁芯）も'center'側にまとめる（HEADのclassifyAxisLineTypeが元々
 * discipline===STRUCT&&labeledだけを特別扱いし、それ以外はlineType==='dashed'かどうかだけで
 * 補助線/中心線を分けていたため、梁芯も「中心線」表示になる。この対応関係は変えない）。
 *
 * 実在の CenterLine またはその POJO スナップショット専用——未生成の仮想候補（discipline／
 * lineType を持たないダック型オブジェクト）を渡すと、centerLineKind が黙って既定種別'center'に
 * 落ちる（axisLineKindOf.test『【失敗系】』参照）。
 * @param {object} cl
 * @returns {'grid'|'aux'|'center'}
 */
export function axisLineKindOf(cl) {
  if (isGridCenterLine(cl)) return 'grid';
  return centerLineKind(cl) === 'aux' ? 'aux' : 'center';
}

/**
 * target が既存の補助線から extentLoRef/HiRef で参照されているか（走査API。追加extent・延長で
 * 「はね出し（静的値）」か「直交CL参照（リアクティブ追従）」かの分岐に使う——他の補助線が同じ
 * target を既に参照していれば ref 化する。transform/centerLineOps.js の anyAuxRefsCL・
 * transform/centerLineExtend.js の同名関数を統合したもの。
 * 素の `ex.lineType==='dashed' && !ex.labeled` を見ている（centerLineKind(ex)==='aux' そのものでは
 * ない）——既知の乖離（旧データ限定）: centerLineKind は lineType==='dashed' のみで aux と判定するため
 * `{lineType:'dashed', labeled:true}` のような旧データがあると centerLineKind ベースでは aux 扱いに
 * なるが、本関数（labeled:false も要求）は候補にしない。通常経路（AddCLDialogのaux分岐）で作られる
 * 補助線は必ず labeled:false のため実害は無い。種別ベースへ統一するかは製品コード移行時の裁定が要る
 * （本関数は挙動を変えず、既存2箇所の実装をそのまま集約しただけ）。
 * @param {{centerLines: Array}} graph
 * @param {object} target
 * @returns {boolean}
 */
export function isReferencedByAux(graph, target) {
  return graph.centerLines.some(ex =>
    ex.lineType === 'dashed' && !ex.labeled &&
    (ex.extentLoRef?.clId === target.id || ex.extentHiRef?.clId === target.id)
  );
}

/**
 * centerLineType・kind が一致し labeled:false な CenterLine を graph.centerLines から列挙する走査API
 * （中心線の結合相手選択で使う。transform/centerLineMerge.js findCenterLineMergeMatch 参照。ステップ7、
 * 2026-09-20移行）。kind は呼び出し元が明示する（isMergeCandidate のように subject オブジェクトから
 * centerLineKind(subject) を自動導出しない）——結合の主体（subject）はまだグラフに存在しない仮想候補
 * （centerLineOps.js の virtualCandidate。addCenterLineFromDialog の同種別extent分岐）のことがあり、
 * discipline/lineType を持たないため centerLineKind(subject) が常に既定値'center'になってしまい、
 * kind='aux'/'beam'では誤った種別で絞り込む事故になる（製品コードは元々 kind を明示引数で受け取り、
 * この問題を避けていた）。orthoAnchorCandidatesForNew と同じ理由（型で事故を防ぐ）で kind を必須の
 * 明示引数にする。
 * @param {{centerLines: Array}} graph
 * @param {{centerLineType: string, kind: string, exclude?: string[]}} opts
 * @returns {Array} mergeableKinds(kind).includes(centerLineKind(other)) かつ !other.labeled かつ
 *   other.centerLineType===centerLineType かつ exclude に含まれない CenterLine の配列
 */
export function mergeCandidates(graph, { centerLineType, kind, exclude = [] }) {
  assertKnownKind(kind);
  return graph.centerLines.filter(other =>
    other.centerLineType === centerLineType && !other.labeled &&
    !exclude.includes(other.id) && mergeableKinds(kind).includes(centerLineKind(other)));
}

/**
 * appMode で可視な種別のうち centerLineType が一致する CenterLine を graph.centerLines から列挙する
 * 走査API（建具のスナップ候補選定で使う。openings/openingMove.js openingSnapCandidates 参照。
 * ステップ7、2026-09-20移行）。kindsVisibleIn(appMode) と centerLineType の単純な絞り込みのみを行う——
 * 幾何条件（壁との位置関係・可動範囲等）は呼び出し側の責務。
 * @param {{centerLines: Array}} graph
 * @param {{appMode: string, centerLineType: string}} opts
 * @returns {Array}
 */
export function candidatesVisibleIn(graph, { appMode, centerLineType }) {
  const kinds = kindsVisibleIn(appMode);
  return graph.centerLines.filter(other => other.centerLineType === centerLineType && kinds.includes(centerLineKind(other)));
}

/**
 * graph.centerLines から通り芯（isGridCenterLine＝labeled かつ種別struct）のみを列挙する走査API
 * （「描かれている通り芯」の一覧を掃く場面で使う。interaction/gutterHitTest.js findGutterCL 参照。
 * ステップ8、2026-09-20移行——旧実装は生の cl.labeled で絞っていた）。
 * renderer/GutterLayer.jsx GutterCircleLabels（ガター内○ラベルの描画条件、
 * `cl.labeled && cl.discipline === Discipline.STRUCT`）と通常データでは同値——lineType==='dashed'な
 * discipline:STRUCT（本関数がisGridCenterLine経由でaux扱いにする組合せ）は通常経路で生じない異常値
 * のみのため、ヒット判定を描画条件に一致させられる。
 * 旧データの{labeled:true, discipline!==STRUCT}な中心線・補助線は、discipline を見ない別系統
 * （core/clQuery.js _labeledCLs＝graph.gridXs/gridYsの供給元。GRID寸法・renderer/gutterLabelHits.js
 * columnAxisLabelHitsの柱芯ラベルが参照）には残るが、本APIの対象（isGridCenterLine）からは外れる
 * ——「通り芯として長押し選択できるか」は種別ベースへ統一済みだが、系統Aは discipline 不問のままの
 * 独立した表であるため、この乖離は本移行の対象外（意図的に残る）。
 * @param {{centerLines: Array}} graph
 * @returns {Array}
 */
export function gridCenterLines(graph) {
  return graph.centerLines.filter(isGridCenterLine);
}

/**
 * gridCenterLines(graph) のうち centerLineType が一致するものを value 昇順で列挙する走査API
 * （軸ごとの通り芯本数・最外郭2本を求める場面で使う。transform/centerLineConvert.js
 * outermostGridExtentRefs・isLastGridOnAxis 参照）。
 * @param {{centerLines: Array}} graph
 * @param {string} centerLineType
 * @returns {Array}
 */
export function gridCenterLinesOnAxis(graph, centerLineType) {
  if (centerLineType == null) {
    throw new Error(`gridCenterLinesOnAxis: centerLineTypeは必須です（実際: ${centerLineType}）`);
  }
  return gridCenterLines(graph)
    .filter(cl => cl.centerLineType === centerLineType)
    .sort((a, b) => a.value - b.value);
}

/**
 * coord（effectiveValue基準、tolMm以内）に一致する tier の柱アンカーCLを graph.centerLines から
 * 1本返す走査API（structural/wallBeamAxes.js findBeamAnchorCL・structural/woodAutoFill.js
 * findCenterAnchorCL が共有する述語。柱アンカー解決・梁芯の重複ガードが同じ結果を共有する——
 * 片方だけ条件を変えると柱が湧く／消える）。単一パスの `.find()`——複数ヒットは配列順で最初
 * （sortしない。呼び出し元は `structuralAnchorAt(..., tier:'primary') ?? structuralAnchorAt(...,
 * tier:'secondary')` の `??` チェーンをそのまま維持すること——単発の tier:'any' に畳むと、同座標に
 * 中心線と梁芯が両方あるとき「配列順で最初」になり、チェーンが保証する「梁芯（第1候補）優先」が
 * 崩れる）。ホットパス（構造再計算1回あたり多数回呼ばれる）のため
 * `structuralAnchorCandidates(...).find(...)` には委譲しない（毎回配列を割り当てることになるため）。
 * @param {{centerLines: Array}} graph
 * @param {{centerLineType: string, coord: number, tier: 'primary'|'secondary'|'any', tolMm?: number}} opts
 * @returns {object|null}
 */
export function structuralAnchorAt(graph, { centerLineType, coord, tier, tolMm = CL_OVERLAP_TOL_MM }) {
  if (centerLineType == null) {
    throw new Error(`structuralAnchorAt: centerLineTypeは必須です（実際: ${centerLineType}）`);
  }
  if (typeof coord !== 'number' || Number.isNaN(coord)) {
    throw new Error(`structuralAnchorAt: coordは数値である必要があります（実際: ${coord}）`);
  }
  const kinds = structuralAnchorKinds(tier); // ループの外で1度だけ解決する
  return graph.centerLines.find(cl =>
    cl.centerLineType === centerLineType &&
    kinds.includes(centerLineKind(cl)) &&
    Math.abs(cl.effectiveValue - coord) < tolMm) ?? null;
}

/**
 * tier の柱アンカー候補となる CenterLine を graph.centerLines から centerLineType 一致で列挙する
 * 走査API（structural/woodAutoFill.js nearestAnchorCL の候補集合。距離によるタイブレークは
 * 呼び出し側=structural/の責務——本APIは候補を絞るだけで並べ替えない）。
 * @param {{centerLines: Array}} graph
 * @param {{centerLineType: string, tier: 'primary'|'secondary'|'any'}} opts
 * @returns {Array}
 */
export function structuralAnchorCandidates(graph, { centerLineType, tier }) {
  if (centerLineType == null) {
    throw new Error(`structuralAnchorCandidates: centerLineTypeは必須です（実際: ${centerLineType}）`);
  }
  const kinds = structuralAnchorKinds(tier);
  return graph.centerLines.filter(cl =>
    cl.centerLineType === centerLineType && kinds.includes(centerLineKind(cl)));
}

/**
 * coord（effectiveValue基準、tolMm以内）に一致する梁芯CL（BEAM_AXIS_KINDS）を graph.centerLines から
 * 1本返す走査API（structural/wallBeamAxes.js findWallBeamAxisCL——壁由来梁芯の追従元探索。通り芯は
 * 対象にしない。追従処理が通り芯を動かす事故を防ぐため意図的に structuralAnchorAt(tier:'primary') とは
 * 別にする）。単一パスの `.find()`。
 * @param {{centerLines: Array}} graph
 * @param {{centerLineType: string, coord: number, tolMm?: number}} opts
 * @returns {object|null}
 */
export function beamAxisAt(graph, { centerLineType, coord, tolMm = CL_OVERLAP_TOL_MM }) {
  if (centerLineType == null) {
    throw new Error(`beamAxisAt: centerLineTypeは必須です（実際: ${centerLineType}）`);
  }
  if (typeof coord !== 'number' || Number.isNaN(coord)) {
    throw new Error(`beamAxisAt: coordは数値である必要があります（実際: ${coord}）`);
  }
  return graph.centerLines.find(cl =>
    cl.centerLineType === centerLineType &&
    BEAM_AXIS_KINDS.includes(centerLineKind(cl)) &&
    Math.abs(cl.effectiveValue - coord) < tolMm) ?? null;
}

/**
 * graph.centerLines から梁芯CL（BEAM_AXIS_KINDS）を列挙する走査API（structural/structuralAutoFill.js
 * beamAxisCenterLinesが使う。同ファイルの再export経由でstructural/MemberListTab.jsxが使う）。
 * centerLineType を渡せばその軸だけに絞る（省略時=nullは全軸）。
 * @param {{centerLines: Array}} graph
 * @param {{centerLineType?: string|null}} [opts]
 * @returns {Array}
 */
export function beamAxisCenterLines(graph, { centerLineType = null } = {}) {
  return graph.centerLines.filter(cl =>
    (centerLineType == null || cl.centerLineType === centerLineType) &&
    BEAM_AXIS_KINDS.includes(centerLineKind(cl)));
}

/**
 * centerLineType が一致する SUPPORT_SPAN_COLUMN_KINDS（通り芯・中心線）の CenterLine を
 * graph.centerLines から列挙する走査API（structural/woodAutoFill.js 支持長超過時の追加柱の走行方向
 * 候補。kind は呼び出し側が優先度ラベルとしてそのまま使う）。
 * @param {{centerLines: Array}} graph
 * @param {{centerLineType: string}} opts
 * @returns {Array<{cl: object, kind: string}>}
 */
export function supportSpanColumnCandidates(graph, { centerLineType }) {
  if (centerLineType == null) {
    throw new Error(`supportSpanColumnCandidates: centerLineTypeは必須です（実際: ${centerLineType}）`);
  }
  return graph.centerLines
    .filter(cl => cl.centerLineType === centerLineType && SUPPORT_SPAN_COLUMN_KINDS.includes(centerLineKind(cl)))
    .map(cl => ({ cl, kind: centerLineKind(cl) }));
}
