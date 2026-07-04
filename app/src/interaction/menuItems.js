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

export function getMenuItems(context, endpointState) {
  switch (context) {
    case CONTEXT.INTERSECTION:
      return [
        { id: 'diag',  label: '斜線',   icon: '╱' },
        { id: 'arc',   label: '円弧',   icon: '◜' },
        { id: 'del',   label: '削除',   icon: '✕' },
      ];
    case CONTEXT.CENTER_LINE_ENDPOINT: {
      const { canExtend, canShorten } = endpointState ?? {};
      return [
        { id: 'cl-extend',  label: '延長', icon: '⇥', disabled: !canExtend },
        canShorten
          ? { id: 'cl-shorten', label: '短縮', icon: '⇤' }
          : { id: 'cl-del',     label: '削除', icon: '✕' },
      ];
    }
    case CONTEXT.CENTER_LINE:
      return [
        { id: 'cl-del', label: '削除', icon: '✕' },
      ];
    case CONTEXT.EMPTY:
      return [
        { id: 'cl-v',  label: '垂直線', icon: '┃', angle: -90 },
        { id: 'cl-h',  label: '水平線', icon: '━', angle: 0 },
      ];
    case CONTEXT.WALL:
      return [
        { id: 'add-fitting', label: '建具', icon: '🚪' },
        { id: 'add-window',  label: '窓',   icon: '🪟' },
      ];
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
