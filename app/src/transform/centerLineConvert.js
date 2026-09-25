// 中心⇔通り芯の入替え（平面モード限定）— グラフ変更本体（純粋部分）。
//
// 方式: CenterLine 実体を id ごと graph（階グラフ）⇔ structGraph（全階共通）間で移籍する
// （delete+再生成しない）。壁・開口等は axisCL/clStart/clEnd 等で CenterLine を「オブジェクト参照」で
// 保持している（core/wall.js 参照）ため、id・オブジェクト identity を保てば既存参照は無傷のまま保たれる。
// _teardownCenterLine は絶対に呼ばない（core/clQuery.js 経由で Wall 等が道連れ削除されるため）。
//
// import ゼロに近い規約（extractedModuleImportInvariant）: mobx / @core / import-free な ../error.js
// のみ import する。node:test から本体（applyPromoteToGrid/applyDemoteToCenter）を単体 import 可能に保つ。
//
// ガード契約: 以下の2関数は「実際にグラフを変更した場合のみ error を持たない成功オブジェクトを返す」。
// ガード（instanceof/kind/type の defensive チェックを含む）は必ず { error } を返し、`{}`（error無し）を
// 中途半端に返さない——呼び出し側（centerLineOps.js の *WithUndo）は error の有無だけで
// 「undo push・階またぎ伝播をしてよいか」を判定するため、ガード節が `{}` を返すと変更が無いのに
// 成功扱いされ、no-opのundoが積まれたり後続処理（propagateDemotedCenterLine の loCL/hiCL 参照）が
// 壊れる。instanceof/kind/type の defensive チェック（UIからは到達しない想定）は
// ERR_CL_CONVERT_INVALID を返す。
//
// 同期ガードの分離（checkPromoteToGridGuards/checkDemoteToCenterGuards）: apply*関数内で行う
// 判定と同じロジックを外出しし、呼び出し側（centerLineOps.js）が階またぎ重複チェック
// （findFloorsWithCounterpartCL・IDB peek を伴う）より先に評価できるようにする——同期的に
// 判定可能な失敗（型不一致・直交通り芯不足・軸最後の1本（降格のみ）・図形干渉・同グラフ内重複）で無駄なIDB読み込みが
// 走り、本来と異なるトーストが先に出るのを防ぐ。
import { runInAction } from 'mobx';
import { CenterLine, CenterLineType, Discipline, centerLineKind } from '@core';
import { ERR_CL_CONVERT_NO_GRID, ERR_CL_CONVERT_LAST_GRID, ERR_CL_CONVERT_ATTACHED, ERR_CL_CONVERT_DUP, ERR_CL_CONVERT_DUP_DEMOTE } from '../error.js';
import { sameCoordCounterparts, convertBlockingKinds, isConvertSubject, gridCenterLinesOnAxis, BEAM_AXIS_KINDS } from '../core/centerLineKindPolicy.js';

// UIからは到達しない想定の防御的ガード（instanceof/kind/type 不一致）専用。menu が canToGrid/canToCenter
// で事前に絞り込むため実運用では表示されないが、ガード契約（上記コメント）を満たすため文言を持つ。
const ERR_CL_CONVERT_INVALID = 'この中心線は変換できません。';

// cl と直交する通り芯（gridCenterLinesOnAxis＝labeled struct CL）を value 昇順に見た最外郭2本を返す。
// @returns {{loCL, hiCL}|null} 2本未満なら null
export function outermostGridExtentRefs(graph, cl) {
  const orthoType = cl.centerLineType === CenterLineType.VERTICAL ? CenterLineType.HORIZONTAL : CenterLineType.VERTICAL;
  const structCLs = gridCenterLinesOnAxis(graph, orthoType);
  if (structCLs.length < 2) return null;
  return { loCL: structCLs[0], hiCL: structCLs[structCLs.length - 1] };
}

// cl と同じ軸（centerLineType）の通り芯（gridCenterLinesOnAxis＝labeled struct CL）が cl 自身しか
// 無いか（＝その軸最後の1本）。全体で最後の1本は直交0本になるためoutermostGridExtentRefsのNO_GRIDで
// 既にブロックされる——このチェックが意味を持つのは「直交軸には2本以上あるが、自分の軸だけは
// 自分1本」のケース。降格ガード（checkDemoteToCenterGuards）とメニューのグレー化判定
// （interaction/usePointerInteraction.js の isLastGridOnAxis 算出）の両方がこの関数を共有する
// （二重実装によるズレを防ぐ）。
export function isLastGridOnAxis(graph, cl) {
  return gridCenterLinesOnAxis(graph, cl.centerLineType).length <= 1;
}

// clId が関わる Intersection のいずれかに Shape（斜線・円弧等）が取り付いているか。
// Wall/Opening は Intersection を介さず CenterLine を直接参照するため対象外（このガードには影響しない）。
//
// 交点の走査元（ixGraph）と図形の照会先（shapeGraph）を分離する。斜線・円弧の Shape 本体・ngraph
// リンクは常に階グラフ側（PlanGraph._graph・shapeMap）に登録され、structGraph へ Shape を追加する
// 経路は存在しない——降格（通り芯→中心）で「structGraph の交点」に取り付いた図形を調べる場合、
// 交点は structGraph.intersectionMap にあるが、図形自体は各階グラフの _graph/shapeMap にあるため、
// 両方を渡さないと（同一グラフだけを見ると）このガードは常に false になり機能しない。
// 呼び出し側は昇格=attachedShapeExists(graph, graph, id)、降格=attachedShapeExists(structGraph, graph, id)
// のように使う——降格は「アクティブ階」の図形だけを見る（非アクティブ階の斜線までは見ない。
// 通り芯削除の既存挙動＝アクティブ階の detachFromCenterLine のみが即時反映される、と同じ範囲）。
export function attachedShapeExists(ixGraph, shapeGraph, clId) {
  for (const ix of ixGraph.intersectionMap.values()) {
    if (ix.clVertical.id !== clId && ix.clHorizontal.id !== clId) continue;
    if (shapeGraph.getShapesAtNode(ix).length > 0) return true;
  }
  return false;
}

/**
 * 昇格（中心線→通り芯）の同期ガード判定のみ（グラフは変更しない）。
 * @returns {string|null} 拒否理由（エラー文言）。問題なければ null。
 */
export function checkPromoteToGridGuards(graph, structGraph, cl, opts = {}) {
  const excludeBeamAxisIds = opts.excludeBeamAxisIds ?? [];
  if (!(cl instanceof CenterLine)) return ERR_CL_CONVERT_INVALID;
  if (!isConvertSubject(cl, 'promote')) return ERR_CL_CONVERT_INVALID;
  // 直交通り芯の本数は昇格の技術的前提ではない（ユーザー判断で撤去。.claude/data-model.md参照）。
  // adoptCenterLine→_createIntersectionsは直交labeled CLが0本でも0個の交点を作るだけで破綻せず、
  // AddCLDialogで最初の通り芯を1本だけ追加する通常運用と同じコードパス。昇格はcl.trim=falseを
  // 無条件設定するため、labeled CLの描画範囲（CenterLinesLayer.jsx clExtent）は常にgutterEdgeCoord
  // （viewport/width/heightのみでgraphを取らない）側の枝を通り直交CLの値を参照しない
  // （trim:true枝は直交labeled CLのmin/maxを読むがそちらへは入らない。仮に旧データで入っても
  // null返却→ビューポート範囲フォールバックでクラッシュしない）。setCenterLineExtentRefでの
  // extent無条件null化は描画のためではなく、シリアライズ状態を新規通り芯と揃えるため。結果、
  // 直交通り芯2本未満のまま昇格したCLは直交側に通り芯を追加するまで降格できない（降格側の
  // ガードは技術的必然のため維持。下記）が、これは仕様として許容する。
  if (attachedShapeExists(graph, graph, cl.id)) return ERR_CL_CONVERT_ATTACHED;
  // 拒否する既存種別は convertBlockingKinds('promote')=['struct','beam']（centerLineKindPolicy.js）。
  // 通り芯（structGraphに同座標・同軸のものが既にあれば拒否——通り芯化した瞬間に全階へ同じ座標の
  // グリッド線が現れるため、同座標の既存通り芯と衝突させない）は structGraph を、梁芯（fuse。
  // 階グラフの同座標・同軸にあれば拒否——通り芯と梁芯は同位置に共存できない。大梁と完全重複する
  // 小梁の生成防止。AddCLDialogの通り芯追加と同じ規約）は graph（階グラフ）を走査する——通り芯は
  // 全階共有オブジェクト（project.structGraph）、梁芯は階ローカルの実体のため、走査元のグラフが
  // 種別ごとに異なる（走査自体は sameCoordCounterparts 経由に一本化——素の .some 走査を個別に書かない）。
  // 順序（struct優先）は convertBlockingKinds('promote') の並び順どおり。
  // 発見②・ユーザー裁定・案A・2026-09-25: 同座標の梁芯のうち`opts.excludeBeamAxisIds`に含まれる
  // id（保護されない壁由来梁芯。呼び出し側centerLineOps.jsが`structural/wallBeamAxes.js`の
  // `isProtectedWallBeamAxis`で判定済み）は障害物にしない——本ファイルはimport-free規約
  // （ファイル冒頭コメント）のためwallBeamAxes.jsを直接importせず、判定済みidの配列だけを受け取る。
  for (const blockedKind of convertBlockingKinds('promote')) {
    const scanGraph = blockedKind === 'struct' ? structGraph : graph;
    const dup = sameCoordCounterparts(scanGraph, { centerLineType: cl.centerLineType, value: cl.value, exclude: cl })
      .find(c => centerLineKind(c) === blockedKind && !(BEAM_AXIS_KINDS.includes(blockedKind) && excludeBeamAxisIds.includes(c.id)));
    if (dup) return ERR_CL_CONVERT_DUP(blockedKind);
  }
  return null;
}

/**
 * 中心線 → 通り芯（グラフ間移籍・id維持）。
 * @param {PlanGraph} graph        中心線が現在属する階グラフ（アクティブ階）
 * @param {PlanGraph} structGraph  project.structGraph
 * @param {CenterLine} cl
 * @param {{excludeBeamAxisIds?: string[]}} [opts] - checkPromoteToGridGuardsへそのまま渡す
 *   （発見②・ユーザー裁定・案A・2026-09-25。保護されない壁由来梁芯のidを渡すと障害物にしない）。
 * @returns {{error: string}|{}}
 */
export function applyPromoteToGrid(graph, structGraph, cl, opts = {}) {
  return runInAction(() => {
    const guardError = checkPromoteToGridGuards(graph, structGraph, cl, opts);
    if (guardError) return { error: guardError };

    // extent参照は通り芯化で無意味になる（通り芯は常にガター～ガターの全幅表示）ため全null化する。
    graph.setCenterLineExtentRef(cl, 'lo', null, null);
    graph.setCenterLineExtentRef(cl, 'hi', null, null);
    // shapeMap から外した後に discipline/labeled を倒す — 先に倒すと階グラフの gridXs/gridYs・
    // 自動命名 reaction が変換途中の状態（旧グラフに居ながら通り芯化済み）を一瞬観測してしまう。
    graph.releaseCenterLine(cl.id);
    cl.discipline = Discipline.STRUCT;
    cl.labeled    = true;
    cl.trim       = false;
    // refIdが指す参照先がstructGraphに無ければ絶対値へベイクする（core/planGraph.js の
    // _reparentChildCenterLines の else分岐と同型）——通り芯は全階共通のオブジェクトであり、
    // 階ローカルなCLへの参照（refId）を持てない。参照を持ったままstructGraphへ移すと、
    // 階グラフ側でしか解決できない参照が全階共通のはずの通り芯に残り、階ごとに別座標を
    // 返す事故になる（永続化・再読込のたびに参照解決順序へ依存してしまう）。
    if (cl.refId && !structGraph.shapeMap.has(cl.refId)) {
      cl._value = cl.value; cl.refId = null; cl._referencedCL = null;
    }
    structGraph.adoptCenterLine(cl);
    return {};
  });
}

/**
 * 降格（通り芯→中心線）の同期ガード判定のみ（グラフは変更しない）。
 * @returns {string|null} 拒否理由（エラー文言）。問題なければ null。
 */
export function checkDemoteToCenterGuards(graph, structGraph, cl) {
  if (!(cl instanceof CenterLine)) return ERR_CL_CONVERT_INVALID;
  if (!isConvertSubject(cl, 'demote')) return ERR_CL_CONVERT_INVALID;
  if (!outermostGridExtentRefs(graph, cl)) return ERR_CL_CONVERT_NO_GRID;
  // 直交軸には2本以上あっても、自分の軸の通り芯が自分しか無ければ降格させない
  // （軸最後の1本が消えるのを防ぐ。ユーザー要望で新設。全体最後は上のNO_GRIDで既にブロック済み）。
  if (isLastGridOnAxis(graph, cl)) return ERR_CL_CONVERT_LAST_GRID;
  // structGraph側の当該CLの交点（走査元）に、アクティブ階グラフ（図形の照会先）の図形が
  // 取り付いていれば拒否（昇格側の attachedShapeExists と対称。Shape本体は常に階グラフ側にある）。
  if (attachedShapeExists(structGraph, graph, cl.id)) return ERR_CL_CONVERT_ATTACHED;
  // 移籍先の階グラフに同座標・同軸の中心線・補助線が既にあれば拒否
  // （同一階に同座標の中心線が2本並存する事故を防ぐ）。拒否する既存種別は
  // convertBlockingKinds('demote')=['center','aux']（centerLineKindPolicy.js）——COEXISTENCE表
  // （struct×aux='allowed'）より厳しい（補助線も拒否する）現行仕様を維持する裁定
  // （2026-09-20）。梁芯（fuse）は対象外——在来木造では下階の壁からも自階へ自動生成され平面モードでは
  // 非表示のため、障害物にすると「何も無い位置で降格できない」になる（中心線と梁芯の同位置共存は
  // AddCLDialog の追加経路と同じ規約で許容）。
  // 走査は sameCoordCounterparts 経由。種別ベース（centerLineKind）で判定する——旧データ
  // （`{labeled:true, lineType:'dashed'}` のような labeled と種別が食い違う異常値）は、移行前は
  // 生の `!c.labeled` を見ていたため障害物にならなかったが、移行後は種別ベースのため障害物になる
  // （ピン留めテスト参照。2026-09-20統一）。
  // 逆方向の乖離（QA指摘m-5）: `{labeled:false, discipline:STRUCT}`（centerLineKindは'struct'）の
  // ような旧データ・異常値があった場合、移行前は `!c.labeled` が true（labeled:falseのため）かつ
  // centerLineKind(c)!=='beam' が true となり障害物として拒否していたが、移行後は種別ベースの
  // convertBlockingKinds('demote')=['center','aux']に'struct'が含まれないため拒否しない（見逃す）
  // 方向に割れる。通常経路（AddCLDialog等）で作られるCLは種別とlabeledが必ず一致する
  // （通り芯のみlabeled:true）ため、`discipline:STRUCT`かつ`labeled:false`は通常経路では作れず
  // 実害は無い（挙動を変えないため意図的に許容する）。
  // 両方（中心線・補助線）が同座標に共存しうる（COEXISTENCE center×aux='allowed'）ため、
  // .find()の走査順（graph.centerLinesの並び順）に結果を依存させず、convertBlockingKinds('demote')
  // の並び順（中心線＞補助線）で優先的に選ぶ（centerLineOps.js の priority pick と同じ規約）。
  const candidates = sameCoordCounterparts(graph, { centerLineType: cl.centerLineType, value: cl.value, exclude: cl });
  const dup = convertBlockingKinds('demote').map(k => candidates.find(c => centerLineKind(c) === k)).find(Boolean);
  if (dup) return ERR_CL_CONVERT_DUP_DEMOTE(centerLineKind(dup));
  return null;
}

/**
 * 通り芯 → 中心線（グラフ間移籍・id維持）。extent は直交方向の最外郭通り芯2本へのrefにする
 * （「外側から外側まで」）。
 * @param {PlanGraph} graph        中心線の移籍先となる階グラフ（アクティブ階）
 * @param {PlanGraph} structGraph  project.structGraph
 * @param {CenterLine} cl
 * @returns {{error: string}|{loCL, hiCL}}
 */
export function applyDemoteToCenter(graph, structGraph, cl) {
  return runInAction(() => {
    const guardError = checkDemoteToCenterGuards(graph, structGraph, cl);
    if (guardError) return { error: guardError };
    const { loCL, hiCL } = outermostGridExtentRefs(graph, cl);

    // このCLをrefId参照する他の通り芯を先に繰り上げる（構造グラフ内の相互参照。さもないと
    // 再読込時に参照が解決不能になる）。
    structGraph.reparentChildCenterLines(cl.id);
    structGraph.releaseCenterLine(cl.id);
    cl.discipline = Discipline.ARCH;
    cl.labeled    = false;
    cl.label      = '';
    graph.adoptCenterLine(cl);
    graph.setCenterLineExtentRef(cl, 'lo', { clId: loCL.id, offset: 0 });
    graph.setCenterLineExtentRef(cl, 'hi', { clId: hiCL.id, offset: 0 });
    graph.columnAxisOffsets.delete(cl.id);

    return { loCL, hiCL };
  });
}
