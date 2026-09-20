import RBush from 'rbush';

/**
 * 交点（Intersection）の AABB 空間インデックス。
 *
 * CL.value（確定済み座標）でインデックスを構築する。
 * ドラッグ中は pendingDelta が変化するが cl.value は変わらないため、
 * bake（mouseup）後にのみ rebuild が呼ばれる。
 */
export class SpatialIndex {
  constructor() {
    this._tree    = new RBush();
    this._nodeMap = new Map(); // id → Intersection
  }

  /**
   * インデックスを全再構築する。
   * @param {Intersection[]} intersections
   */
  rebuild(intersections) {
    this._tree.clear();
    this._nodeMap.clear();
    const bulk = [];

    for (const n of intersections) {
      // 確定済み座標で登録（effectiveValue ではなく cl.value）
      const x = n.clVertical.value;
      const y = n.clHorizontal.value;
      const e = { minX: x, minY: y, maxX: x, maxY: y, id: n.id };
      bulk.push(e);
      this._nodeMap.set(n.id, n);
    }

    this._tree.load(bulk);
  }

  /**
   * (cx, cy) から radiusMm 以内の交点を距離順で返す。
   *
   * @param {number} cx
   * @param {number} cy
   * @param {number} radiusMm  検索半径 (mm、ワールド座標)
   * @returns {RTreeEntry[]}
   *   RTreeEntry = { id, minX, minY, maxX, maxY, dist2 }
   */
  query(cx, cy, radiusMm) {
    const raw  = this._tree.search({
      minX: cx - radiusMm, minY: cy - radiusMm,
      maxX: cx + radiusMm, maxY: cy + radiusMm,
    });
    const r2   = radiusMm * radiusMm;
    return raw
      .map(e => ({ ...e, dist2: (e.minX - cx) ** 2 + (e.minY - cy) ** 2 }))
      .filter(e => e.dist2 <= r2)
      .sort((a, b) => a.dist2 - b.dist2);
  }

  /** インデックスに登録済みのノードを ID で引く（O(1)）。 */
  getNode(id) {
    return this._nodeMap.get(id) ?? null;
  }
}
