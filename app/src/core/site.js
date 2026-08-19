/**
 * 敷地モードのドメインモデル（点・線分・三角形・敷地図全体）
 *
 * core.js から分離した独立島。core の他クラスに依存しない
 * （定数 SiteLineKind のみ参照）。後方互換のため core.js が再エクスポートする。
 */
import { makeObservable, observable, computed, action } from 'mobx';
import { SiteLineKind } from './constants.js';

// 敷地上の端点（SiteLine が共有する）
export class SitePoint {
  constructor(id, x, y) {
    this.id = id;
    this.x  = x;
    this.y  = y;
    makeObservable(this, {
      x: observable,
      y: observable,
    });
  }
}

// 敷地線分: 2つの SitePoint を結ぶ
export class SiteLine {
  // redPointId: 赤端点の SitePoint ID（生成時に1度だけ決定し、以降は不変）
  constructor(id, startPoint, endPoint, lineKind = SiteLineKind.SURVEY, redPointId = startPoint.id) {
    this.id         = id;
    this.startPoint = startPoint; // SitePoint
    this.endPoint   = endPoint;   // SitePoint
    this.lineKind   = lineKind;
    this.redPointId = redPointId;
    makeObservable(this, {
      lineKind: observable,
      length:   computed,
    });
  }
  get length() {
    return Math.hypot(
      this.endPoint.x - this.startPoint.x,
      this.endPoint.y - this.startPoint.y,
    );
  }
}

// 三斜の三角形: 底辺 SiteLine + 頂点 SitePoint
export class SiteTriangle {
  constructor(id, baseLine, apexPoint, lineKind = SiteLineKind.SURVEY) {
    this.id        = id;
    this.baseLine  = baseLine;  // SiteLine（底辺）
    this.apexPoint = apexPoint; // SitePoint（頂点）
    this.lineKind  = lineKind;  // 境界/道路境界/測量
    makeObservable(this, {
      lineKind: observable,
      area:     computed,
    });
  }
  // 外積で三角形面積を算出 (mm² → ㎡)
  get area() {
    const { startPoint: A, endPoint: B } = this.baseLine;
    const C = this.apexPoint;
    const areaMm2 = Math.abs(
      (B.x - A.x) * (C.y - A.y) - (C.x - A.x) * (B.y - A.y),
    ) / 2;
    return areaMm2 / 1_000_000;
  }
}

// 敷地図全体: 点・線分・三角形を管理する
export class Site {
  constructor() {
    this.pointMap    = observable.map(); // id → SitePoint
    this.lineMap     = observable.map(); // id → SiteLine
    this.triangleMap = observable.map(); // id → SiteTriangle
    this.lineOrder   = observable.array([]); // 三斜タブ表示順 (SiteLine ID)
    // 三斜の作成手順（線分長さ編集時の再計算に使用）
    // [0]:        { type: 'base', lineId, length }
    // [1..]:      { type: 'triangle', baseLineId, redLineId, redLen, redKind,
    //               blueLineId, blueLen, blueKind, triangleId, triangleLineKind, side }
    this.history     = observable.array([]);
    makeObservable(this, {
      points:        computed,
      lines:         computed,
      orderedLines:  computed,
      triangles:     computed,
      addPoint:      action,
      removePoint:   action,
      addLine:       action,
      removeLine:    action,
      addTriangle:   action,
      removeTriangle: action,
      clear:         action,
    });
  }

  get points()      { return [...this.pointMap.values()]; }
  get lines()       { return [...this.lineMap.values()]; }
  get triangles()   { return [...this.triangleMap.values()]; }

  get orderedLines() {
    return this.lineOrder
      .filter(id => this.lineMap.has(id))
      .map(id => this.lineMap.get(id));
  }

  addPoint(x, y, id = crypto.randomUUID()) {
    const pt = new SitePoint(id, x, y);
    this.pointMap.set(pt.id, pt);
    return pt;
  }

  removePoint(id) {
    this.pointMap.delete(id);
  }

  addLine(startPoint, endPoint, lineKind = SiteLineKind.SURVEY, id = crypto.randomUUID(), redPointId = startPoint.id) {
    const line = new SiteLine(id, startPoint, endPoint, lineKind, redPointId);
    this.lineMap.set(line.id, line);
    this.lineOrder.push(line.id);
    return line;
  }

  removeLine(id) {
    // 底辺として使われている triangle も連鎖削除
    for (const [tid, tri] of this.triangleMap) {
      if (tri.baseLine.id === id) this.triangleMap.delete(tid);
    }
    this.lineMap.delete(id);
    const idx = this.lineOrder.indexOf(id);
    if (idx >= 0) this.lineOrder.splice(idx, 1);
  }

  addTriangle(baseLine, apexPoint, lineKind = SiteLineKind.SURVEY, id = crypto.randomUUID()) {
    const tri = new SiteTriangle(id, baseLine, apexPoint, lineKind);
    this.triangleMap.set(tri.id, tri);
    return tri;
  }

  removeTriangle(id) {
    this.triangleMap.delete(id);
  }

  // 全消去（起動時の復元 restoreSite 専用。undo スタックとは無関係に実体を作り直す）
  clear() {
    this.pointMap.clear();
    this.lineMap.clear();
    this.triangleMap.clear();
    this.lineOrder.clear();
    this.history.clear();
  }
}
