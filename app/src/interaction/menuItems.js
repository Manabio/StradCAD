export const CONTEXT = Object.freeze({
  INTERSECTION: 'intersection',
  CENTER_LINE:  'centerLine',
  SHAPE:        'shape',
  EMPTY:        'empty',
});

export function detectContext(snapPoint, nearCL) {
  if (snapPoint) return CONTEXT.INTERSECTION;
  if (nearCL)   return CONTEXT.CENTER_LINE;
  return CONTEXT.EMPTY;
}

export function getMenuItems(context, nearCL = null) {
  switch (context) {
    case CONTEXT.INTERSECTION:
      return [
        { id: 'diag',  label: '斜線',   icon: '╱' },
        { id: 'arc',   label: '円弧',   icon: '◜' },
        { id: 'del',   label: '削除',   icon: '✕' },
      ];
    case CONTEXT.CENTER_LINE: {
      const moveIcon = nearCL?.centerLineType === 'Y' ? '⇕' : '⇔';
      return [
        { id: 'cl-move', label: '移動', icon: moveIcon },
        { id: 'cl-del',  label: '削除', icon: '✕' },
      ];
    }
    case CONTEXT.EMPTY:
      return [
        { id: 'cl-v',  label: '垂直線',   icon: '┃' },
        { id: 'cl-h',  label: '水平線',   icon: '━' },
        { id: 'wall',  label: '壁',       icon: '▬' },
        { id: 'undo',  label: 'もどす',   icon: '↩' },
        { id: 'redo',  label: 'やり直し', icon: '↪' },
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
