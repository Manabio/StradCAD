// 中心⇔通り芯の入替えメニュー（cl-to-grid・cl-to-center・isLastGridOnAxisグレー化）の可否判定。
// 処理側ガード（transform/centerLineConvert.js checkPromoteToGridGuards／checkDemoteToCenterGuards）と
// 同じ主体判定（centerLineKindPolicy.js isConvertSubject）を共有する——UI側だけを個別に緩めると
// 「メニューには出るが処理は拒否する」食い違いになる（片方だけ直せない理由。以前は
// interaction/usePointerInteraction.js が独自のインライン種別比較を持っており、実際に
// canToCenter（labeled不問）とcheckDemoteToCenterGuards（labeled必須）が食い違っていた）。
//
// メニュー文脈（appMode／menuContext）はUI固有の表示条件のためここに残し、isConvertSubjectへは
// 持ち込まない（処理側ガードは文脈を持たないため）。
//
// react-konva/store.js/snap.js/.jsx を引かない構成を維持する（node:test から安全に import
// できるようにするため）: CONTEXT は同じ規律の menuItems.js から、isConvertSubject/
// isFinishCellDivider は同じ規律の centerLineKindPolicy.js から、isLastGridOnAxis/
// isFootprintBoundaryCL は同じ規律の centerLineConvert.js から取る（centerLineConvert.js冒頭コメント参照）。
import { CONTEXT } from './menuItems.js';
import { isConvertSubject, isFinishCellDivider } from '../core/centerLineKindPolicy.js';
import { isLastGridOnAxis as isLastGridOnAxisOnGraph, isFootprintBoundaryCL } from '../transform/centerLineConvert.js';

/**
 * 長押しメニューの canToGrid／canToCenter／isLastGridOnAxis を算出する
 * （buildMenuState の引数名と一致。呼び出し側は `...convertMenuFlags(...)` のスプレッドで渡す）。
 * @param {PlanGraph} graph
 * @param {{appMode: string, menuContext: string, cl: object|null, clEndpoint: {cl: object}|null}} ctx
 * @returns {{canToGrid: boolean, canToCenter: boolean, isLastGridOnAxis: boolean|undefined}}
 */
export function convertMenuFlags(graph, { appMode, menuContext, cl, clEndpoint }) {
  // CL端点（はね出し側）長押し: 平面モード限定で通り芯化を提案する。RADIAL(R)はisConvertSubject内で除外。
  const canToGrid = appMode === 'floorplan' && !!clEndpoint && isConvertSubject(clEndpoint.cl, 'promote');
  // 通り芯の線上長押し: 平面モード限定で中心線化を提案する。
  // isLastGridOnAxis（cl-to-center・cl-del両方のグレー化に使う共有値）はappMode条件を付けない——
  // cl-to-centerはappMode==='floorplan'限定だがcl-del（通り芯の削除）はモードを問わないため
  // （isDemoteSubjectがmenuContext===CENTER_LINEの下でのみisConvertSubjectを呼ぶのは、それ以外の
  // 文脈ではclがnull/未定義になりうるため——短絡評価で守る）。
  const isDemoteSubject = menuContext === CONTEXT.CENTER_LINE && isConvertSubject(cl, 'demote');
  const canToCenter = appMode === 'floorplan' && isDemoteSubject;
  const isLastGridOnAxis = isDemoteSubject ? isLastGridOnAxisOnGraph(graph, cl) : undefined;
  // cl-del（削除）のグレー化: isLastGridOnAxisと同じ多層防御（transform/centerLineOps.js
  // deleteCenterLineWithUndoのERR_CL_DELETE_FOOTPRINTガードと同じ判定式）。セル分割に参加する
  // 種別（通り芯・中心線。isFinishCellDivider）のみ判定する（補助線・梁芯は対象外）。
  // 他階peekは行わない（自階判定のみ。他階分は処理側ガードのみが拒否する）。
  const isFootprintBoundary = menuContext === CONTEXT.CENTER_LINE && isFinishCellDivider(cl)
    ? isFootprintBoundaryCL(graph, cl)
    : undefined;
  return { canToGrid, canToCenter, isLastGridOnAxis, isFootprintBoundary };
}
