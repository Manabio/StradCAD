// import は core/constants.js の ColumnMenuItemId だけを例外とする（ユーザー承認 2026-11-11 のリテラル計画。
// constants.js 自体が import を持たない）。それ以外は import ゼロを維持する（node:test から安全に import できるようにするため。centerLineExtend.js /
// edgeClassify.js / kneeDropWall.js は snap.js → store.js（localStorage/indexedDB）へ連鎖しており、
// これらに依存すると node:test 環境で import 不能になる）。graph 依存の判定値
// （canExtend/canShorten/hasInteriorWall/wallEligible）は呼び出し側（interaction/usePointerInteraction.js）が算出して渡す。
// CenterLineType.VERTICAL は 'X' 固定値で判定する（core/constants.js 参照。snap.js と同じ回避策）。

import { ColumnMenuItemId, CL_OVERLAP_TOL_MM } from '../core/constants.js';

// 柱追加の位置（columnSlot）と同じ交点に交点 snap があるか。snap のノード（core/nodes.js Intersection）の x・y は
// 通り芯の effectiveValue（描画位置）、slot の x・y は押した交点の線の value——通常は同じ座標。graph に依存しない数値比較だけ
// なのでここで行う（許容は CL_OVERLAP_TOL_MM）。ホバーで拾った近くの別の交点は同じ交点とみなさない。
function snapAtSlot(snap, slot) {
  return !!snap && Math.abs(snap.x - slot.x) < CL_OVERLAP_TOL_MM && Math.abs(snap.y - slot.y) < CL_OVERLAP_TOL_MM;
}

export const CONTEXT = Object.freeze({
  COLUMN:              'column',
  COLUMN_SLOT:         'columnSlot',
  INTERSECTION:        'intersection',
  CENTER_LINE_ENDPOINT: 'centerLineEndpoint',
  CENTER_LINE:         'centerLine',
  OPENING:             'opening',
  WALL:                'wall',
  SHAPE:               'shape',
  EMPTY:               'empty',
});

// 柱（断面内）> CL交点の柱追加位置 > 交点 > CL端点(延長/短縮) > (CL/開口/壁のうち画面距離が最も近いもの。呼び出し側
// updateSnap で排他的に解決済み) > 空。CL と壁は軸オフセットが小さく8px判定が重なるため、
// 呼び出し側で画面距離による排他選択を行ってから渡すこと（cl と nearWall/
// nearOpening が同時に真になることは想定しない）。柱・柱追加位置は呼び出し側（interaction/columnLongPress.js
// resolveColumnLongPress）が平面・構造モードでだけ渡す（省略時は従来どおり）。
export function detectContext(snapPoint, nearCL, nearOpening, nearWall, nearCLEndpoint, column = null, columnSlot = null) {
  if (column)         return CONTEXT.COLUMN;
  if (columnSlot)     return CONTEXT.COLUMN_SLOT;
  if (snapPoint)      return CONTEXT.INTERSECTION;
  if (nearCLEndpoint) return CONTEXT.CENTER_LINE_ENDPOINT;
  if (nearCL)         return CONTEXT.CENTER_LINE;
  if (nearOpening)    return CONTEXT.OPENING;
  if (nearWall)       return CONTEXT.WALL;
  return CONTEXT.EMPTY;
}

// 延長方向の画面角度（0=右, 90=下, 180=左, -90=上。CSS transform:rotate() と同じ時計回り）
// side='hi'(値が大きい側)は縦線なら下、横線なら右。side='lo'はその逆。
function extendIconAngle(isVertical, side) {
  if (isVertical) return side === 'hi' ? 90 : -90;
  return side === 'hi' ? 0 : 180;
}

// 交点（既存の斜線・円弧・削除）の項目。INTERSECTION 文脈と、平面で CL の交点に snap が併存する柱追加メニューが共有する。
function intersectionItems() {
  return [
    { id: 'diag',  label: '斜線',   icon: '╱' },
    { id: 'arc',   label: '円弧',   icon: '◜' },
    { id: 'del',   label: '削除',   icon: '✕' },
  ];
}

export function getMenuItems(context, endpointState, clState, wallState, columnSlotState) {
  switch (context) {
    case CONTEXT.COLUMN:
      return [{ id: ColumnMenuItemId.DEL, label: '柱削除', icon: '✕' }];
    case CONTEXT.COLUMN_SLOT: {
      // 主構造が未確定・柱を持たない種別・位置が占有済みのときは押せない（addable 偽。グレー化）。
      const { addable, withIntersection } = columnSlotState ?? {};
      const items = [{ id: ColumnMenuItemId.ADD, label: '柱追加', icon: '□', disabled: !addable }];
      if (withIntersection) items.push(...intersectionItems());
      return items;
    }
    case CONTEXT.INTERSECTION:
      return intersectionItems();
    case CONTEXT.CENTER_LINE_ENDPOINT: {
      const { canExtend, canShorten, canToGrid, isVertical, side } = endpointState ?? {};
      const extendAngle  = extendIconAngle(isVertical, side);
      const shortenAngle = extendAngle + 180; // 短縮は延長と正反対（内向き）を指す
      const items = [
        { id: 'cl-extend',  label: '延長', icon: '→', iconRotate: extendAngle, disabled: !canExtend },
        canShorten
          ? { id: 'cl-shorten', label: '短縮', icon: '→', iconRotate: shortenAngle }
          : { id: 'cl-del',     label: '削除', icon: '✕' },
      ];
      // 中心線のはね出し（CL端点）長押し: 平面モード限定で通り芯化を提案する。角度指定なし＝均等配置
      // のまま維持する（延長/短縮|削除は固定角にしない）——canToGrid=trueで3項目化すると
      // angleStep=120°に変わり既存2項目の表示位置も動くが、意図した挙動として許容する。
      if (canToGrid) items.push({ id: 'cl-to-grid', label: '通り芯に', icon: '◎' });
      return items;
    }
    case CONTEXT.CENTER_LINE: {
      // 12時=移動、4時=削除、8時=偏芯（内壁指定のあるCLのみ。仕上げモードでの部屋命名により
      // 生成されたINTERIOR_WALLエッジ分類は脱出後も保持されるため、移動可能なモード側の
      // 長押しメニューで扱う）。移動アイコンはスナップ移動の方向（線と直交）を指す両矢印。
      // 移動をサポートしないモード（clState.canMove が偽）では従来どおり削除のみ。
      const { canMove, isVertical, hasInteriorWall, canToCenter, isLastGridOnAxis, isFootprintBoundary, isUnresolvable } = clState ?? {};
      // 軸最後の通り芯（isLastGridOnAxis）・フットプリント境界（isFootprintBoundary。外壁線を担う
      // 通り芯・中心線）・復元不能セル（isUnresolvable。削除すると部屋セルが再解釈で救えなくなる）は
      // 削除もグレー化する（中心化と同じ多層防御。transform/centerLineOps.js deleteCenterLineWithUndoの
      // ERR_CL_DELETE_LAST_GRID/ERR_CL_DELETE_FOOTPRINT/ERR_CL_DELETE_UNRESOLVABLEと対）。
      // isLastGridOnAxisは呼び出し側でcenterLineKind(cl)==='struct'のときのみ算出される
      // （非structのCLではundefined→!!undefined=falseで従来どおり削除可能）。isFootprintBoundary・
      // isUnresolvableはセル分割に参加する種別（通り芯・中心線）のときのみ算出される
      // （補助線・梁芯はundefined）。
      const delDisabled = !!isLastGridOnAxis || !!isFootprintBoundary || !!isUnresolvable;
      if (!canMove) return [{ id: 'cl-del', label: '削除', icon: '✕', disabled: delDisabled }];
      const items = [
        { id: 'cl-move', label: '移動', icon: '⇄', iconRotate: isVertical ? 0 : 90, angle: -90 },
        { id: 'cl-del',  label: '削除', icon: '✕', angle: 30, disabled: delDisabled },
      ];
      if (hasInteriorWall) items.push({ id: 'cl-ecc', label: '偏芯', icon: '◨', angle: 150 });
      // 通り芯の線上長押し: 平面モード限定で中心線化を提案する。軸最後の1本（isLastGridOnAxis）は
      // 項目自体は出すがグレー化（disabled）して押せなくする——非表示にすると「押せる操作が
      // ある」という期待自体を消してしまい、なぜ消えたか分かりにくいため（transform/centerLineConvert.js
      // checkDemoteToCenterGuardsのERR_CL_CONVERT_LAST_GRIDと同じ判定式=isLastGridOnAxisを共有）。
      if (canToCenter) items.push({ id: 'cl-to-center', label: '中心に', icon: '┄', angle: 90, disabled: !!isLastGridOnAxis });
      return items;
    }
    case CONTEXT.EMPTY:
      return [
        { id: 'cl-v',  label: '垂直線', icon: '┃', angle: -90 },
        { id: 'cl-h',  label: '水平線', icon: '━', angle: 0 },
      ];
    case CONTEXT.WALL: {
      const items = [
        { id: 'add-fitting', label: '建具', icon: '🚪' },
        { id: 'add-window',  label: '窓',   icon: '🪟' },
        { id: 'add-frame',   label: '三方枠', icon: '⊓' },
      ];
      // 腰壁・垂れ壁: 2a壁（階段下部屋の偏芯壁）は対象外（wallState.eligible が false）
      if (wallState?.eligible) items.push({ id: 'knee-drop-wall', label: '腰/垂壁', icon: '▤' });
      return items;
    }
    case CONTEXT.OPENING:
      return [
        { id: 'opening-edit', label: '編集', icon: '✎' },
        { id: 'opening-del',  label: '削除', icon: '✕' },
      ];
    case CONTEXT.SHAPE:
      return [
        { id: 'del',   label: '削除',       icon: '✕' },
        { id: 'props', label: 'プロパティ', icon: '⚙' },
      ];
    default:
      return [];
  }
}

/**
 * 長押しメニューの状態組立（context 判定＋items 生成）。interaction/usePointerInteraction.js longPress の onFire から抽出。
 * appMode==='opening'（建具モード）は壁・開口以外の長押しメニューを出さない（CL移動等の平面編集
 * 操作は行わない）ため null を返す——呼び出し側はこれを合図にメニューを開かない。
 * canMove は「CL移動をサポートするモードか」（呼び出し側の modeRef.current?.startMove の有無）。
 * canExtend/canShorten（CL端点の延長/短縮可否）・hasInteriorWall（中心線に内壁指定があるか）・
 * wallEligible（腰壁・垂れ壁の適格性）・canToGrid/canToCenter（中心⇔通り芯の入替え可否。平面モード限定）・
 * isLastGridOnAxis（canToCenter=true時のみ意味を持つ。cl-to-center項目のグレー化判定）・
 * isFootprintBoundary（セル分割に参加する種別のCENTER_LINE文脈でのみ意味を持つ。cl-del項目の
 * グレー化判定。外壁線を担うCLの削除を拒否するガードの多層防御）・
 * isUnresolvable（isFootprintBoundaryと同条件。削除すると部屋セルが再解釈で救えなくなるCLの
 * 削除を拒否するガードの多層防御。cl-del項目のグレー化判定）は
 * graph 依存のため呼び出し側（interaction/usePointerInteraction.js）が算出して渡す
 * （このモジュールを import ゼロに保つため。ファイル冒頭コメント参照）。
 * column・columnSlot・columnSlotAddable は interaction/columnLongPress.js resolveColumnLongPress の結果
 * （平面・構造モードだけ有効。addable 偽なら柱追加はグレー化）。
 * @returns {{context, items, endpointState, clState, wallState, columnSlotState}|null}
 */
export function buildMenuState(appMode, {
  snap, cl, clEndpoint, opening, wall, canMove, canExtend, canShorten, hasInteriorWall, wallEligible,
  canToGrid, canToCenter, isLastGridOnAxis, isFootprintBoundary, isUnresolvable,
  column = null, columnSlot = null, columnSlotAddable = false,
}) {
  // 柱の文脈は平面・構造モードだけ（それ以外のモードでは渡されても無視する。多層防御）。
  const columnMode = appMode === 'floorplan' || appMode === 'structure';
  const context = detectContext(snap, cl, opening, wall, clEndpoint, columnMode ? column : null, columnMode ? columnSlot : null);
  if (appMode === 'opening' && context !== CONTEXT.WALL && context !== CONTEXT.OPENING) return null;
  // 天伏（S8b）は天井芯の追加（空）・移動/削除（線上）・延長/短縮/削除（端点）だけ。交点・壁・開口の
  // メニューは出さない（snap.js が天伏ではそれらの候補自体を解決しない——ここは多層防御）。
  if (appMode === 'ceiling'
      && context !== CONTEXT.CENTER_LINE && context !== CONTEXT.CENTER_LINE_ENDPOINT && context !== CONTEXT.EMPTY) return null;
  // 構造モードの壁・開口メニュー抑止はここでは行わない——snap.js resolvePointerTargets が同モードでは
  // 壁・開口の候補解決自体をスキップするため、context が WALL/OPENING になること自体がない
  // （部材ごとの間引きではなくモード単位の一箇所で塞ぐ規律。.claude/structural-model.md 参照）。
  const endpointState = clEndpoint ? {
    canExtend,
    canShorten,
    canToGrid,
    isVertical: clEndpoint.cl.centerLineType === 'X', // CenterLineType.VERTICAL
    side:       clEndpoint.side,
  } : null;
  // 中心線上メニュー: 移動可否と線の向き（移動アイコンの矢印方向）を渡す。
  const clState = context === CONTEXT.CENTER_LINE ? {
    canMove,
    isVertical: cl.centerLineType === 'X', // CenterLineType.VERTICAL
    hasInteriorWall,
    canToCenter,
    isLastGridOnAxis,
    isFootprintBoundary,
    isUnresolvable,
  } : null;
  // 壁上メニュー: 腰壁・垂れ壁の適格性（2a壁は対象外）を渡す。
  const wallState = context === CONTEXT.WALL ? { eligible: wallEligible } : null;
  // 柱追加メニュー: 平面で、押した交点と同じ交点の snap があるときだけ、既存の斜線・円弧・削除を後ろに並べる（構造モードでは足さない）。
  const columnSlotState = context === CONTEXT.COLUMN_SLOT
    ? { addable: !!columnSlotAddable, withIntersection: appMode === 'floorplan' && snapAtSlot(snap, columnSlot) } : null;
  const items = getMenuItems(context, endpointState, clState, wallState, columnSlotState);
  return { context, items, endpointState, clState, wallState, columnSlotState };
}
