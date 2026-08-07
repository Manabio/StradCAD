// 敷地モード（三斜計算）の純幾何ヘルパー。renderer/SiteLinesLayer.jsx（JSX。plain Node から
// import 不可）から分離し、transform/siteHistory.js・transform/siteEdit.js 等のテスト可能な
// モジュールから参照できるようにしたもの（snap.js に対する snapGeometry.js と同じ位置付け）。

// 赤端点・青端点を返す（line.redPointId に基づく固定割り当て）
export function getSiteLineRedBlue(line) {
  return line.startPoint.id === line.redPointId
    ? { red: line.startPoint, blue: line.endPoint }
    : { red: line.endPoint,   blue: line.startPoint };
}

// 線分生成時に赤端点を1度だけ決定する（画面左上原点に近い方を赤とする）
export function pickRedPointId(startPoint, endPoint, viewport) {
  const sA = viewport.worldToScreen(startPoint.x, startPoint.y);
  const sB = viewport.worldToScreen(endPoint.x,   endPoint.y);
  return Math.hypot(sA.x, sA.y) <= Math.hypot(sB.x, sB.y)
    ? startPoint.id
    : endPoint.id;
}

/**
 * 底辺の赤端点から redLen mm、青端点から blueLen mm の頂点を求める。
 * 垂直線: 中点が画面中央より左 → 右側候補、右 → 左側候補。
 * 水平線: 中点が画面中央より上 → 下側候補、下 → 上側候補。
 * 斜め線: y が小さい（画面上方）側の解を返す。
 * 解なしなら null。
 */
export function computeSiteApex(line, redLen, blueLen, viewport, screenW, screenH) {
  const { red, blue } = getSiteLineRedBlue(line);
  const ax = red.x, ay = red.y;
  const bx = blue.x, by = blue.y;
  const dx = bx - ax, dy = by - ay;
  const d = Math.hypot(dx, dy);
  if (d < 1e-6) return null;
  const a  = (redLen * redLen - blueLen * blueLen + d * d) / (2 * d);
  const h2 = redLen * redLen - a * a;
  if (h2 < 0) return null;
  const h  = Math.sqrt(h2);
  const mx = ax + a * dx / d;
  const my = ay + a * dy / d;
  const px = -dy / d;
  const py =  dx / d;
  const c1 = { x: mx + h * px, y: my + h * py };
  const c2 = { x: mx - h * px, y: my - h * py };

  const adx = Math.abs(dx), ady = Math.abs(dy);
  if (ady > adx) {
    // 垂直線: 中点が画面中央より左 → 右側(x大)を選ぶ
    const midSx = viewport.worldToScreen((ax + bx) / 2, (ay + by) / 2).x;
    const wantRight = midSx < screenW / 2;
    return (c1.x >= c2.x) === wantRight ? c1 : c2;
  } else if (adx > ady) {
    // 水平線: 中点が画面中央より上(y小) → 下側(y大)を選ぶ
    const midSy = viewport.worldToScreen((ax + bx) / 2, (ay + by) / 2).y;
    const wantDown = midSy < screenH / 2;
    return (c1.y >= c2.y) === wantDown ? c1 : c2;
  } else {
    // 斜め線: 従来通り y 小（上方）を選ぶ
    return c1.y <= c2.y ? c1 : c2;
  }
}

// 底辺ベクトル(blue-red)に対する頂点(apex)の配置側を符号で返す（+1 / -1）。
// computeSiteApex の c1 側が +1、c2 側が -1 に対応する。
export function computeApexSide(baseLine, apex) {
  const { red, blue } = getSiteLineRedBlue(baseLine);
  const dx = blue.x - red.x, dy = blue.y - red.y;
  const cross = dx * (apex.y - red.y) - dy * (apex.x - red.x);
  return cross >= 0 ? 1 : -1;
}

// computeSiteApex のビューポート非依存版。side（computeApexSide で記録した符号）で
// 2解のどちらを採用するかを一意に決定する。線分長さ編集後の再計算に使用。
export function computeApexFromSide(baseLine, redLen, blueLen, side) {
  const { red, blue } = getSiteLineRedBlue(baseLine);
  const ax = red.x, ay = red.y;
  const bx = blue.x, by = blue.y;
  const dx = bx - ax, dy = by - ay;
  const d = Math.hypot(dx, dy);
  if (d < 1e-6) return null;
  const a  = (redLen * redLen - blueLen * blueLen + d * d) / (2 * d);
  const h2 = redLen * redLen - a * a;
  if (h2 < 0) return null;
  const h  = Math.sqrt(h2);
  const mx = ax + a * dx / d;
  const my = ay + a * dy / d;
  const px = -dy / d;
  const py =  dx / d;
  return side >= 0
    ? { x: mx + h * px, y: my + h * py }
    : { x: mx - h * px, y: my - h * py };
}
