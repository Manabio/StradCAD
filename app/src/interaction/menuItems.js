// import ゼロを維持する（node:test から安全に import できるようにするため。centerLineExtend.js /
// edgeClassify.js / kneeDropWall.js は snap.js → store.js（localStorage/indexedDB）へ連鎖しており、
// これらに依存すると node:test 環境で import 不能になる）。graph 依存の判定値
// （canExtend/canShorten/hasInteriorWall/wallEligible）は呼び出し側（interaction/usePointerInteraction.js）が算出して渡す。
// CenterLineType.VERTICAL は 'X' 固定値で判定する（core/constants.js 参照。snap.js と同じ回避策）。

export const CONTEXT = Object.freeze({
  INTERSECTION:        'intersection',
  CENTER_LINE_ENDPOINT: 'centerLineEndpoint',
  CENTER_LINE:         'centerLine',
  OPENING:             'opening',
  WALL:                'wall',
  SHAPE:               'shape',
  EMPTY:               'empty',
});

// 交点 > CL端点(延長/短縮) > (CL/開口/壁のうち画面距離が最も近いもの。呼び出し側
// updateSnap で排他的に解決済み) > 空。CL と壁は軸オフセットが小さく8px判定が重なるため、
// 呼び出し側で画面距離による排他選択を行ってから渡すこと（cl と nearWall/
// nearOpening が同時に真になることは想定しない）。
export function detectContext(snapPoint, nearCL, nearOpening, nearWall, nearCLEndpoint) {
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

export function getMenuItems(context, endpointState, clState, wallState) {
  switch (context) {
    case CONTEXT.INTERSECTION:
      return [
        { id: 'diag',  label: '斜線',   icon: '╱' },
        { id: 'arc',   label: '円弧',   icon: '◜' },
        { id: 'del',   label: '削除',   icon: '✕' },
      ];
    case CONTEXT.CENTER_LINE_ENDPOINT: {
      const { canExtend, canShorten, isVertical, side } = endpointState ?? {};
      const extendAngle  = extendIconAngle(isVertical, side);
      const shortenAngle = extendAngle + 180; // 短縮は延長と正反対（内向き）を指す
      return [
        { id: 'cl-extend',  label: '延長', icon: '→', iconRotate: extendAngle, disabled: !canExtend },
        canShorten
          ? { id: 'cl-shorten', label: '短縮', icon: '→', iconRotate: shortenAngle }
          : { id: 'cl-del',     label: '削除', icon: '✕' },
      ];
    }
    case CONTEXT.CENTER_LINE: {
      // 12時=移動、4時=削除、8時=偏芯（内壁指定のあるCLのみ。仕上げモードでの部屋命名により
      // 生成されたINTERIOR_WALLエッジ分類は脱出後も保持されるため、移動可能なモード側の
      // 長押しメニューで扱う）。移動アイコンはスナップ移動の方向（線と直交）を指す両矢印。
      // 移動をサポートしないモード（clState.canMove が偽）では従来どおり削除のみ。
      const { canMove, isVertical, hasInteriorWall } = clState ?? {};
      if (!canMove) return [{ id: 'cl-del', label: '削除', icon: '✕' }];
      const items = [
        { id: 'cl-move', label: '移動', icon: '⇄', iconRotate: isVertical ? 0 : 90, angle: -90 },
        { id: 'cl-del',  label: '削除', icon: '✕', angle: 30 },
      ];
      if (hasInteriorWall) items.push({ id: 'cl-ecc', label: '偏芯', icon: '◨', angle: 150 });
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
 * wallEligible（腰壁・垂れ壁の適格性）は graph 依存のため呼び出し側（interaction/usePointerInteraction.js）が算出して渡す
 * （このモジュールを import ゼロに保つため。ファイル冒頭コメント参照）。
 * @returns {{context, items, endpointState, clState, wallState}|null}
 */
export function buildMenuState(appMode, {
  snap, cl, clEndpoint, opening, wall, canMove, canExtend, canShorten, hasInteriorWall, wallEligible,
}) {
  const context = detectContext(snap, cl, opening, wall, clEndpoint);
  if (appMode === 'opening' && context !== CONTEXT.WALL && context !== CONTEXT.OPENING) return null;
  const endpointState = clEndpoint ? {
    canExtend,
    canShorten,
    isVertical: clEndpoint.cl.centerLineType === 'X', // CenterLineType.VERTICAL
    side:       clEndpoint.side,
  } : null;
  // 中心線上メニュー: 移動可否と線の向き（移動アイコンの矢印方向）を渡す。
  const clState = context === CONTEXT.CENTER_LINE ? {
    canMove,
    isVertical: cl.centerLineType === 'X', // CenterLineType.VERTICAL
    hasInteriorWall,
  } : null;
  // 壁上メニュー: 腰壁・垂れ壁の適格性（2a壁は対象外）を渡す。
  const wallState = context === CONTEXT.WALL ? { eligible: wallEligible } : null;
  const items = getMenuItems(context, endpointState, clState, wallState);
  return { context, items, endpointState, clState, wallState };
}
