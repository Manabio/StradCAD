/**
 * Shape 基底クラス（core.js から分離）。
 *
 * core.js の一般図形・CenterLine・DimensionLine・Wall・Opening 等が extends する共通基底。
 * 非公開: core.js からは再エクスポートしない（元から Shape に export はなかった）。
 */
import { makeObservable, observable, action } from 'mobx';
import { Discipline, ShapeKind, LINE_WEIGHT_MM } from './constants.js';

const SHAPE_DEFAULTS = Object.freeze({
  discipline: Discipline.ARCH,
  layerId:    'default',
  lineWeight: LINE_WEIGHT_MM.medium,
  lineType:   'solid',
  color:      '#000000',
  kind:       ShapeKind.GENERAL,
});

export class Shape {
  constructor(id, props = {}) {
    this.id = id;
    const p = { ...SHAPE_DEFAULTS, ...props };
    this.discipline = p.discipline;
    this.layerId    = p.layerId;
    this.lineWeight = p.lineWeight;
    this.lineType   = p.lineType;
    this.color      = p.color;
    this.kind       = p.kind;
    makeObservable(this, {
      discipline: observable,
      layerId:    observable,
      lineWeight: observable,
      lineType:   observable,
      color:      observable,
      kind:       observable,
      setProps:   action,
    });
  }

  setProps(props) { Object.assign(this, props); }
}
