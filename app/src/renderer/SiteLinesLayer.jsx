import { observer } from 'mobx-react-lite';
import { Line, Circle, Group, Text } from 'react-konva';
import { SiteLineKind } from '@core';
import { getSiteLineRedBlue } from '../site/siteGeometry.js';

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
