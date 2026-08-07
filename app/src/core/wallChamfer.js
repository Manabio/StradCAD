/**
 * 壁の面取り・トリム処理。
 * PlanGraph.chamferWalls / trimIntersectingWalls から分離した純関数。
 * Wall インスタンス（axisValue/isVertical/coord1/coord2/clStart/clEnd/axisCL/axisOffset/
 * startOffset/endOffset を持つオブジェクト）のみを操作し、core.js には依存しない。
 */

// 壁の端点トリム (chamferWalls 用)
// targetCoord に近い端 (coord1 or coord2) を refCL+refOffset の位置にセット
// フェイスがスパン内部にある場合（入隅）のみ処理
function _trimWallEnd(wall, targetCoord, refCL, refOffset) {
  const faceCoord = refCL.value + refOffset;
  const lo = Math.min(wall.coord1, wall.coord2);
  const hi = Math.max(wall.coord1, wall.coord2);
  if (faceCoord <= lo || faceCoord >= hi) return;
  if (Math.abs(wall.coord1 - targetCoord) <= Math.abs(wall.coord2 - targetCoord)) {
    wall.startOffset = faceCoord - wall.clStart.value;
  } else {
    wall.endOffset = faceCoord - wall.clEnd.value;
  }
}

// 壁の端点延長 (chamferWalls 用)
// フェイスがスパン外部にある場合（出隅）、端点をフェイス位置まで延長する
function _extendWallEnd(wall, targetCoord, refCL, refOffset, tolerance) {
  const faceCoord = refCL.value + refOffset;
  const lo = Math.min(wall.coord1, wall.coord2);
  const hi = Math.max(wall.coord1, wall.coord2);
  if (faceCoord > lo && faceCoord < hi) return; // 入隅は _trimWallEnd の担当
  const d1 = Math.abs(wall.coord1 - targetCoord);
  const d2 = Math.abs(wall.coord2 - targetCoord);
  if (Math.min(d1, d2) > tolerance) return;
  const MIN_LEN = 1;
  if (d1 <= d2) {
    if (Math.abs(faceCoord - wall.coord2) < MIN_LEN) return;
    wall.startOffset = faceCoord - wall.clStart.value;
  } else {
    if (Math.abs(faceCoord - wall.coord1) < MIN_LEN) return;
    wall.endOffset = faceCoord - wall.clEnd.value;
  }
}

/**
 * 壁同士の面取り処理。
 *
 * 垂直壁と水平壁の全ペアを走査し、端点が交点から tolerance 以内にある場合、
 * startOffset / endOffset を調整して端点を交点にスナップする。
 *
 * @param {Wall[]} walls
 * @param {number} [tolerance=150]  スナップ判定の距離閾値 (mm)
 */
export function chamferWalls(walls, tolerance = 150) {
  const verticals   = walls.filter(w =>  w.isVertical);
  const horizontals = walls.filter(w => !w.isVertical);

  for (const v of verticals) {
    const vx  = v.axisValue;
    const vys = v.clStart.value;
    const vye = v.clEnd.value;
    const vy1 = Math.min(vys, vye);
    const vy2 = Math.max(vys, vye);

    for (const h of horizontals) {
      const hy  = h.axisValue;
      const hxs = h.clStart.value;
      const hxe = h.clEnd.value;
      const hx1 = Math.min(hxs, hxe);
      const hx2 = Math.max(hxs, hxe);

      // 交差の可能性がない組み合わせはスキップ
      if (vx < hx1 - tolerance || vx > hx2 + tolerance) continue;
      if (hy < vy1 - tolerance || hy > vy2 + tolerance) continue;

      // CL位置基準でスナップ判定（オフセット後座標ではなくCL位置で判断）
      if (!v.isRoomWall && Math.min(Math.abs(vys - hy), Math.abs(vye - hy)) <= tolerance) {
        _trimWallEnd(v, hy, h.axisCL, h.axisOffset);
        _extendWallEnd(v, hy, h.axisCL, h.axisOffset, tolerance);
      }

      if (!h.isRoomWall && Math.min(Math.abs(hxs - vx), Math.abs(hxe - vx)) <= tolerance) {
        _trimWallEnd(h, vx, v.axisCL, v.axisOffset);
        _extendWallEnd(h, vx, v.axisCL, v.axisOffset, tolerance);
      }
    }
  }
}

/**
 * 新規壁追加時の入隅・出隅トリム処理。
 *
 * 追加された壁と直交する既存壁を走査し、face 座標ベースで近接する場合、
 * 両壁の最近傍端点を互いの face 位置にスナップする。
 * 入隅（face が壁範囲内に交差）・出隅（face が壁端点から tolerance 以内）の両方を処理する。
 *
 * @param {Wall[]} walls
 * @param {Wall} newWall  追加直後の壁
 * @param {number} [tolerance=150]  出隅検出の距離閾値 (mm)
 * @returns {{ wall, clStart, startOffset, clEnd, endOffset }[]}  Undo用スナップショット
 */
export function trimIntersectingWalls(walls, newWall, tolerance = 150) {
  const snapshots = [];
  const perpWalls = walls.filter(w => w !== newWall && w.isVertical !== newWall.isVertical);
  for (const existing of perpWalls) {
    const [v, h] = newWall.isVertical ? [newWall, existing] : [existing, newWall];

    const vx  = v.axisValue;
    const vy1 = Math.min(v.coord1, v.coord2);
    const vy2 = Math.max(v.coord1, v.coord2);
    const hy  = h.axisValue;
    const hx1 = Math.min(h.coord1, h.coord2);
    const hx2 = Math.max(h.coord1, h.coord2);

    // 近接チェック: face 座標が tolerance 以内なら入隅・出隅ともに対象
    if (vx < hx1 - tolerance || vx > hx2 + tolerance) continue;
    if (hy < vy1 - tolerance || hy > vy2 + tolerance) continue;

    snapshots.push({
      wall: existing,
      clStart: existing.clStart, startOffset: existing.startOffset,
      clEnd:   existing.clEnd,   endOffset:   existing.endOffset,
    });

    const MIN_LEN = 1; // mm: 最小残存長

    // 垂直壁: face に最も近い端を faceY にスナップ
    {
      const faceY = h.axisCL.value + h.axisOffset;
      if (v.coord1 <= v.coord2) {
        // coord1 が上側 (小さい y)
        const cand = faceY - v.clStart.value;
        const candCoord1 = v.clStart.value + cand;
        const otherCoord = v.clEnd.value + v.endOffset;
        if (candCoord1 + MIN_LEN < otherCoord) {
          v.startOffset = cand;
        }
      } else {
        // coord2 が上側 (小さい y)
        const cand = faceY - v.clEnd.value;
        const candCoord2 = v.clEnd.value + cand;
        const otherCoord = v.clStart.value + v.startOffset;
        if (candCoord2 + MIN_LEN < otherCoord) {
          v.endOffset = cand;
        }
      }
    }

    // 水平壁: face に最も近い端を faceX にスナップ
    {
      const faceX = v.axisCL.value + v.axisOffset;
      if (h.coord1 <= h.coord2) {
        // coord1 が左側 (小さい x)
        const cand = faceX - h.clStart.value;
        const candCoord1 = h.clStart.value + cand;
        const otherCoord = h.clEnd.value + h.endOffset;
        if (candCoord1 + MIN_LEN < otherCoord) {
          h.startOffset = cand;
        }
      } else {
        // coord2 が左側 (小さい x)
        const cand = faceX - h.clEnd.value;
        const candCoord2 = h.clEnd.value + cand;
        const otherCoord = h.clStart.value + h.startOffset;
        if (candCoord2 + MIN_LEN < otherCoord) {
          h.endOffset = cand;
        }
      }
    }
  }

  return snapshots;
}
