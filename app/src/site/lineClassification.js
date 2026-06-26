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
