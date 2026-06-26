import { observer } from 'mobx-react-lite';
import { Line, Circle, Group, Text } from 'react-konva';
import { SiteLineKind } from '@core';

// ---- 描画中プレビュー ----
export const SiteDrawPreview = observer(({ mode }) => {
  const ds = mode?.siteDrawState;
  if (!ds) return null;
  const ep = mode.siteDrawPreviewEnd;
  if (!ep) return null;
  return (
    <Line
      points={[ds.startWorld.x, ds.startWorld.y, ep.x, ep.y]}
      stroke="#f97316"
      strokeWidth={2}
      dash={[8, 4]}
      strokeScaleEnabled={false}
      listening={false}
    />
  );
});

const KIND_COLOR = {
  [SiteLineKind.BOUNDARY]:   '#f97316', // 隣地境界線 — オレンジ
  [SiteLineKind.ROAD]:       '#ef4444', // 道路境界   — 赤
  [SiteLineKind.SURVEY]:     '#3b82f6', // 測量       — 青
  [SiteLineKind.ROAD_WIDTH]: '#22c55e', // 道路幅員   — 緑
  [SiteLineKind.OTHER]:      '#94a3b8', // その他     — グレー
};

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

// 線分の当たり判定幅（スクリーンpx）の上限・下限・線分長に対する比率
const HIT_PX_MAX   = 12;
const HIT_PX_MIN   = 2;
const HIT_PX_RATIO = 0.15;

// 線分のスクリーン上の長さに応じて hitStrokeWidth（ワールド単位）を狭める。
// 図形が小さいほど当たり判定も狭くし、隣接する辺との誤選択を防ぐ。
function lineHitWidth(line, viewport) {
  const screenLen = line.length * viewport.scaleX;
  const hitPx = Math.min(HIT_PX_MAX, Math.max(HIT_PX_MIN, screenLen * HIT_PX_RATIO));
  return hitPx / viewport.scaleX;
}

export const SiteLinesLayer = observer(({ site, viewport, selectedLineId, onSelectLine }) => {
  const r       = 4  / viewport.scaleX; // 端点丸の半径（スクリーン 4px 相当）
  const badgeR  = 10 / viewport.scaleX; // 丸番号バッジ半径（スクリーン 10px 相当）
  const sw      = viewport.lineWeightsPx.medium / viewport.scaleX; // バッジ枠 strokeWidth
  const badgeFs = 9  / viewport.scaleX; // バッジ文字 fontSize（スクリーン 9px 相当）
  const markR   = 6  / viewport.scaleX; // 境界/道路境界 交点○の半径（スクリーン 6px 相当）

  // site.lines の順番に三角形へ連番を付ける（三斜タブと同じ順序）
  const triByLine = new Map([...site.triangleMap.values()].map(t => [t.baseLine.id, t]));
  let triNum = 0;
  const orderedTriData = site.lines.flatMap(line => {
    const tri = triByLine.get(line.id);
    return tri ? [{ line, tri, num: ++triNum }] : [];
  });

  // 境界・道路境界 線分が2本以上集まる端点に小さな○を表示
  const boundaryRoadKinds = new Set([SiteLineKind.BOUNDARY, SiteLineKind.ROAD]);
  const pointHitCount = new Map(); // pointId -> 境界/道路境界線分の本数
  for (const line of site.lines) {
    if (!boundaryRoadKinds.has(line.lineKind)) continue;
    pointHitCount.set(line.startPoint.id, (pointHitCount.get(line.startPoint.id) ?? 0) + 1);
    pointHitCount.set(line.endPoint.id,   (pointHitCount.get(line.endPoint.id)   ?? 0) + 1);
  }
  const intersectionPoints = site.points.filter(p => (pointHitCount.get(p.id) ?? 0) >= 2);

  return (
    <>
      {/* 線分・端点マーカー */}
      {site.lines.map(line => {
        const isSelected = line.id === selectedLineId;
        const color = KIND_COLOR[line.lineKind] ?? KIND_COLOR[SiteLineKind.OTHER];
        const { red, blue } = getSiteLineRedBlue(line);

        return [
          // 線分
          <Line
            key={`l-${line.id}`}
            points={[
              line.startPoint.x, line.startPoint.y,
              line.endPoint.x,   line.endPoint.y,
            ]}
            stroke={isSelected ? '#1e293b' : color}
            strokeWidth={isSelected ? viewport.lineWeightsPx.ultraThick : viewport.lineWeightsPx.thick}
            strokeScaleEnabled={false}
            hitStrokeWidth={lineHitWidth(line, viewport)}
            onClick={() => onSelectLine?.(line.id)}
            onTap={() => onSelectLine?.(line.id)}
            onMouseEnter={e => { e.target.getStage().container().style.cursor = 'pointer'; }}
            onMouseLeave={e => { e.target.getStage().container().style.cursor = 'default'; }}
          />,
          // 赤端点（選択時のみ表示）
          <Circle
            key={`r-${line.id}`}
            x={red.x} y={red.y}
            radius={r}
            fill="#ef4444"
            visible={isSelected}
            listening={false}
          />,
          // 青端点（選択時のみ表示）
          <Circle
            key={`b-${line.id}`}
            x={blue.x} y={blue.y}
            radius={r}
            fill="#3b82f6"
            visible={isSelected}
            listening={false}
          />,
        ];
      })}

      {/* 三角形の重心に丸番号バッジ（辺自体は site.lines として描画済み） */}
      {orderedTriData.map(({ line, tri, num }) => {
        const cx = (line.startPoint.x + line.endPoint.x + tri.apexPoint.x) / 3;
        const cy = (line.startPoint.y + line.endPoint.y + tri.apexPoint.y) / 3;
        return (
          <Group key={`tb-${tri.id}`} x={cx} y={cy} listening={false}>
            <Circle
              radius={badgeR}
              fill="white"
              stroke="#334155"
              strokeWidth={sw}
            />
            <Text
              text={String(num)}
              fontSize={badgeFs}
              fill="#334155"
              align="center"
              verticalAlign="middle"
              width={badgeR * 2}
              height={badgeR * 2}
              offsetX={badgeR}
              offsetY={badgeR}
            />
          </Group>
        );
      })}

      {/* 境界・道路境界同士の交点に小さな○ */}
      {intersectionPoints.map(p => (
        <Circle
          key={`ix-${p.id}`}
          x={p.x} y={p.y}
          radius={markR}
          stroke="#334155"
          strokeWidth={viewport.lineWeightsPx.thick}
          strokeScaleEnabled={false}
          listening={false}
        />
      ))}
    </>
  );
});
