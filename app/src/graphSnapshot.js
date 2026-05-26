import { runInAction } from 'mobx';
import { ShapeType } from '@core';

function baseProps(s) {
  return {
    discipline: s.discipline,
    lineWeight: s.lineWeight,
    lineType:   s.lineType,
    color:      s.color,
  };
}

// ----------------------------------------------------------------
// シリアライズ: graph → plain object
// ----------------------------------------------------------------
export function serializeGraph(graph) {
  const gs = graph.generalShapes;
  return {
    centerLines: graph.centerLines.map(cl => ({
      id: cl.id, centerLineType: cl.centerLineType,
      value: cl._value, labeled: cl.labeled, trim: cl.trim,
      refId: cl.refId ?? null, refOffset: cl.refOffset ?? 0,
      extentLo: cl.extentLo ?? null, extentHi: cl.extentHi ?? null,
      ...baseProps(cl),
    })),
    points: graph.points.map(p => ({
      id: p.id, x: p.x, y: p.y,
    })),
    walls: gs.filter(s => s.type === ShapeType.WALL).map(w => ({
      id: w.id, axisCLId: w.axisCL.id, axisOffset: w.axisOffset, isVertical: w.isVertical,
      clStartId: w.clStart.id, startOffset: w.startOffset,
      clEndId:   w.clEnd.id,   endOffset:   w.endOffset,
      ...baseProps(w),
    })),
    diagonals: gs.filter(s => s.type === ShapeType.DIAGONAL).map(d => ({
      id: d.id, nodeAId: d.nodeA.id, nodeBId: d.nodeB.id,
      ...baseProps(d),
    })),
    verticalLines: gs.filter(s => s.type === ShapeType.VERTICAL).map(v => ({
      id: v.id, clVerticalId: v.clVertical.id,
      clHStartId: v.clHStart.id, clHEndId: v.clHEnd.id,
      ...baseProps(v),
    })),
    horizontalLines: gs.filter(s => s.type === ShapeType.HORIZONTAL).map(h => ({
      id: h.id, clHorizontalId: h.clHorizontal.id,
      clVStartId: h.clVStart.id, clVEndId: h.clVEnd.id,
      ...baseProps(h),
    })),
    arcs: gs.filter(s => s.type === ShapeType.ARC).map(a => ({
      id: a.id, centerId: a.center.id,
      radius: a.radius, startAngle: a.startAngle, includedAngle: a.includedAngle,
      ...baseProps(a),
    })),
    circles: gs.filter(s => s.type === ShapeType.CIRCLE).map(c => ({
      id: c.id, centerId: c.center.id, radius: c.radius,
      ...baseProps(c),
    })),
  };
}

// ----------------------------------------------------------------
// ノード解決: intersectionMap → pointMap → ID分解による遅延生成
// ----------------------------------------------------------------
function resolveNode(graph, id) {
  if (graph.intersectionMap.has(id)) return graph.intersectionMap.get(id);
  if (graph.pointMap.has(id))        return graph.pointMap.get(id);
  // Intersection ID は "${clVerticalId}:${clHorizontalId}"
  const sep = id.indexOf(':');
  if (sep > 0) {
    const clV = graph.shapeMap.get(id.slice(0, sep));
    const clH = graph.shapeMap.get(id.slice(sep + 1));
    if (clV && clH) return graph.getOrCreateIntersection(clV, clH);
  }
  return null;
}

// ----------------------------------------------------------------
// リストア: plain object → graph  (runInAction で一括反映)
// ----------------------------------------------------------------
export function restoreGraph(graph, snapshot) {
  runInAction(() => {
    graph.clear();

    // 1. 中心線（labeled:true なら交点を自動生成）
    for (const d of snapshot.centerLines) {
      graph.addCenterLine(d.centerLineType, d.value, {
        labeled: d.labeled, trim: d.trim ?? false, discipline: d.discipline,
        lineWeight: d.lineWeight, lineType: d.lineType, color: d.color,
        extentLo: d.extentLo ?? null, extentHi: d.extentHi ?? null,
        refId: d.refId ?? null, refOffset: d.refOffset ?? 0,
      }, d.id);
    }

    // 2. 自由点
    for (const d of snapshot.points) {
      graph.addPoint(d.x, d.y, d.id);
    }

    // 3. 壁
    for (const d of snapshot.walls) {
      const axisCL  = graph.shapeMap.get(d.axisCLId);
      const clStart = graph.shapeMap.get(d.clStartId);
      const clEnd   = graph.shapeMap.get(d.clEndId);
      if (axisCL && clStart && clEnd) {
        graph.addWall(axisCL, d.axisOffset ?? 0, d.isVertical, clStart, d.startOffset, clEnd, d.endOffset,
          { discipline: d.discipline, lineWeight: d.lineWeight, lineType: d.lineType, color: d.color },
          d.id);
      }
    }

    // 4. 斜線
    for (const d of snapshot.diagonals) {
      const nodeA = resolveNode(graph, d.nodeAId);
      const nodeB = resolveNode(graph, d.nodeBId);
      if (nodeA && nodeB) {
        graph.addDiagonalLine(nodeA, nodeB,
          { discipline: d.discipline, lineWeight: d.lineWeight, lineType: d.lineType, color: d.color },
          d.id);
      }
    }

    // 5. 垂直線
    for (const d of snapshot.verticalLines) {
      const clV  = graph.shapeMap.get(d.clVerticalId);
      const clH1 = graph.shapeMap.get(d.clHStartId);
      const clH2 = graph.shapeMap.get(d.clHEndId);
      if (clV && clH1 && clH2) {
        graph.addVerticalLine(clV, clH1, clH2,
          { discipline: d.discipline, lineWeight: d.lineWeight, lineType: d.lineType, color: d.color },
          d.id);
      }
    }

    // 6. 水平線
    for (const d of snapshot.horizontalLines) {
      const clH  = graph.shapeMap.get(d.clHorizontalId);
      const clV1 = graph.shapeMap.get(d.clVStartId);
      const clV2 = graph.shapeMap.get(d.clVEndId);
      if (clH && clV1 && clV2) {
        graph.addHorizontalLine(clH, clV1, clV2,
          { discipline: d.discipline, lineWeight: d.lineWeight, lineType: d.lineType, color: d.color },
          d.id);
      }
    }

    // 7. 円弧
    for (const d of snapshot.arcs) {
      const center = resolveNode(graph, d.centerId);
      if (center) {
        graph.addArc(center, d.radius, d.startAngle, d.includedAngle,
          { discipline: d.discipline, lineWeight: d.lineWeight, lineType: d.lineType, color: d.color },
          d.id);
      }
    }

    // 8. 円
    for (const d of snapshot.circles) {
      const center = resolveNode(graph, d.centerId);
      if (center) {
        graph.addCircle(center, d.radius,
          { discipline: d.discipline, lineWeight: d.lineWeight, lineType: d.lineType, color: d.color },
          d.id);
      }
    }
  });
}
