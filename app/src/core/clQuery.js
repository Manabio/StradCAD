/**
 * CenterLine・Shape のクエリ用ヘルパ（core.js から分離した純関数）。
 *
 * CenterLine / Intersection は core.js 定義のクラスで instanceof 判定に用いるが、
 * core/*.js は core.js を import しない規約のため、呼び出し側（core.js）から
 * クラス参照を引数として受け取る。
 */
import { Discipline, ShapeType, CenterLineType } from './constants.js';

// labeled な指定軸種の CenterLine か（系統A: discipline 不問・グリッド用）
export function _isLabeledCL(s, type, CenterLine) {
  return s instanceof CenterLine && s.centerLineType === type && s.labeled;
}
// labeled かつ構造の指定軸種か（系統B: 自動命名・reaction 用）
export function _isLabeledStructCL(s, type, CenterLine) {
  return _isLabeledCL(s, type, CenterLine) && s.discipline === Discipline.STRUCT;
}
// shapeMap から系統A を集める（並べ替えなし）
export function _labeledCLs(shapeMap, type, CenterLine) {
  return [...shapeMap.values()].filter(s => _isLabeledCL(s, type, CenterLine));
}

// labeled:true の CenterLine をソートして返す (自動命名対象)
export function _sortedCenterLines(shapeMap, type, CenterLine) {
  const all = [...shapeMap.values()].filter(s => _isLabeledStructCL(s, type, CenterLine));
  switch (type) {
    case CenterLineType.VERTICAL:   return all.sort((a, b) => a.value - b.value);
    case CenterLineType.HORIZONTAL: return all.sort((a, b) => b.value - a.value);
    case CenterLineType.RADIAL:     return all; // 挿入順
  }
}

// 中心線参照チェック (_teardownCenterLine 用)
// CenterLine 削除時に依存する一般 Shape を特定する
export function _shapeUsesCenterLine(shape, id, Intersection) {
  switch (shape.type) {
    case ShapeType.VERTICAL:
      return shape.clVertical.id === id
          || shape.clHStart.id  === id
          || shape.clHEnd.id    === id;
    case ShapeType.HORIZONTAL:
      return shape.clHorizontal.id === id
          || shape.clVStart.id     === id
          || shape.clVEnd.id       === id;
    case ShapeType.DIAGONAL: {
      const uses = (n) => n instanceof Intersection
        && (n.clVertical.id === id || n.clHorizontal.id === id);
      return uses(shape.nodeA) || uses(shape.nodeB);
    }
    case ShapeType.ARC:
    case ShapeType.CIRCLE:
      return shape.center instanceof Intersection
          && (shape.center.clVertical.id === id || shape.center.clHorizontal.id === id);
    case ShapeType.WALL:
      return shape.axisCL.id === id || shape.clStart.id === id || shape.clEnd.id === id;
    case ShapeType.OPENING:
      return shape.axisCL.id === id || shape.refCL.id === id;
    default: return false;
  }
}
