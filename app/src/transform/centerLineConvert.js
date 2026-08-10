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
// 判定可能な失敗（型不一致・直交通り芯不足・図形干渉・同グラフ内重複）で無駄なIDB読み込みが
// 走り、本来と異なるトーストが先に出るのを防ぐ。
import { runInAction } from 'mobx';
import { CenterLine, CenterLineType, Discipline, centerLineKind, CL_OVERLAP_TOL_MM } from '@core';
import { ERR_CL_CONVERT_NO_GRID, ERR_CL_CONVERT_ATTACHED, ERR_CL_DUPLICATE } from '../error.js';

// UIからは到達しない想定の防御的ガード（instanceof/kind/type 不一致）専用。menu が canToGrid/canToCenter
// で事前に絞り込むため実運用では表示されないが、ガード契約（上記コメント）を満たすため文言を持つ。
const ERR_CL_CONVERT_INVALID = 'この中心線は変換できません。';

// cl と直交する通り芯（labeled struct CL）を value 昇順に見た最外郭2本を返す。
// graph.gridXs/gridYs は structGraph 込み・value昇順（core/planGraph.js）——discipline===STRUCT の
// ものだけに絞り込む（同名の labeled:true な意匠CLが将来増えても混同しない）。
// @returns {{loCL, hiCL}|null} 2本未満なら null
export function outermostGridExtentRefs(graph, cl) {
  const perp = cl.centerLineType === CenterLineType.VERTICAL ? graph.gridYs : graph.gridXs;
  const structCLs = perp.filter(c => c.discipline === Discipline.STRUCT);
  if (structCLs.length < 2) return null;
  return { loCL: structCLs[0], hiCL: structCLs[structCLs.length - 1] };
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
export function checkPromoteToGridGuards(graph, structGraph, cl) {
  if (!(cl instanceof CenterLine)) return ERR_CL_CONVERT_INVALID;
  if (centerLineKind(cl) !== 'center') return ERR_CL_CONVERT_INVALID;
  if (cl.centerLineType !== CenterLineType.VERTICAL && cl.centerLineType !== CenterLineType.HORIZONTAL) {
    return ERR_CL_CONVERT_INVALID;
  }
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
  // structGraphに同座標・同軸の通り芯が既にあれば拒否（centerLineOps.js の重複判定式と同型。
  // 通り芯化した瞬間に全階へ同じ座標のグリッド線が現れるため、同座標の既存通り芯と衝突させない）。
  const dupStruct = structGraph.centerLines.some(c =>
    c.centerLineType === cl.centerLineType && Math.abs(c.value - cl.value) < CL_OVERLAP_TOL_MM
  );
  if (dupStruct) return ERR_CL_DUPLICATE('struct');
  return null;
}

/**
 * 中心線 → 通り芯（グラフ間移籍・id維持）。
 * @param {PlanGraph} graph        中心線が現在属する階グラフ（アクティブ階）
 * @param {PlanGraph} structGraph  project.structGraph
 * @param {CenterLine} cl
 * @returns {{error: string}|{}}
 */
export function applyPromoteToGrid(graph, structGraph, cl) {
  return runInAction(() => {
    const guardError = checkPromoteToGridGuards(graph, structGraph, cl);
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
  if (!(cl.discipline === Discipline.STRUCT && cl.labeled)) return ERR_CL_CONVERT_INVALID;
  if (cl.centerLineType !== CenterLineType.VERTICAL && cl.centerLineType !== CenterLineType.HORIZONTAL) {
    return ERR_CL_CONVERT_INVALID;
  }
  if (!outermostGridExtentRefs(graph, cl)) return ERR_CL_CONVERT_NO_GRID;
  // structGraph側の当該CLの交点（走査元）に、アクティブ階グラフ（図形の照会先）の図形が
  // 取り付いていれば拒否（昇格側の attachedShapeExists と対称。Shape本体は常に階グラフ側にある）。
  if (attachedShapeExists(structGraph, graph, cl.id)) return ERR_CL_CONVERT_ATTACHED;
  // 移籍先の階グラフに同座標・同軸の非labeled CL（中心線・補助線・梁芯）が既にあれば拒否
  // （同一階に同座標の中心線が2本並存する事故を防ぐ）。
  const dupCenter = graph.centerLines.some(c =>
    !c.labeled && c.centerLineType === cl.centerLineType && Math.abs(c.value - cl.value) < CL_OVERLAP_TOL_MM
  );
  if (dupCenter) return ERR_CL_DUPLICATE('center');
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
