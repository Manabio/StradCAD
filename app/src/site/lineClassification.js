import { SiteLineKind } from '@core';

export function isSanshaKind(kind) {
  return kind === SiteLineKind.BOUNDARY
      || kind === SiteLineKind.ROAD
      || kind === SiteLineKind.SURVEY;
}

// 各 SiteLine が関与する三角番号一覧（底辺 or 辺）を、site.lines の生成順で採番して返す
// 戻り値の配列長 = その線分の「三角バッヂ数」（線分a/b/cの分類に使用）
export function computeLineTriNums(site) {
  const map = new Map(); // lineId -> number[]
  const findLine = (idA, idB) => site.lines.find(l =>
    (l.startPoint.id === idA && l.endPoint.id === idB) ||
    (l.startPoint.id === idB && l.endPoint.id === idA));
  const triByLine = new Map([...site.triangleMap.values()].map(t => [t.baseLine.id, t]));
  const add = (id, num) => {
    if (!id) return;
    const arr = map.get(id) ?? [];
    arr.push(num);
    map.set(id, arr);
  };
  let triNum = 0;
  for (const line of site.lines) {
    const tri = triByLine.get(line.id);
    if (!tri) continue;
    triNum++;
    add(line.id, triNum);
    add(findLine(tri.apexPoint.id, tri.baseLine.startPoint.id)?.id, triNum);
    add(findLine(tri.apexPoint.id, tri.baseLine.endPoint.id)?.id, triNum);
  }
  return map;
}

// 最外周（境界線）の線分ID集合。幾何で自動判定する: 三角形1つにしか属さない辺、
// および三角形が無い線分が外周（computeLineTriNums の配列長 ≤ 1）。
// 三斜の線（isSanshaKind）だけが対象——OTHER/ROAD_WIDTH 種別の線（旧「その他」タブ。UI は 2026-11-09 廃止、旧データに残り得る）は外周の概念の外。
export function computeOuterLineIds(site) {
  const triNums = computeLineTriNums(site);
  const ids = new Set();
  for (const line of site.lines) {
    if (!isSanshaKind(line.lineKind)) continue;
    if ((triNums.get(line.id)?.length ?? 0) <= 1) ids.add(line.id);
  }
  return ids;
}

// 外周（outerIds の線分）が2本以上集まる端点（SitePoint）。境界線の角の丸を置く点。
// 敷地モードの描画（renderer/SiteLinesLayer.jsx）と配置図（site/sitePlacementView.js）が共有する。
export function computeOuterCornerPoints(site, outerIds) {
  const pointHitCount = new Map(); // pointId -> 外周線分の本数
  for (const line of site.lines) {
    if (!outerIds.has(line.id)) continue;
    pointHitCount.set(line.startPoint.id, (pointHitCount.get(line.startPoint.id) ?? 0) + 1);
    pointHitCount.set(line.endPoint.id,   (pointHitCount.get(line.endPoint.id)   ?? 0) + 1);
  }
  return site.points.filter(p => (pointHitCount.get(p.id) ?? 0) >= 2);
}
