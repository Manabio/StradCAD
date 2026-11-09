import { observer } from 'mobx-react-lite';
import { Line, Circle, Group, Text } from 'react-konva';
import { getSiteLineRedBlue } from '../site/siteGeometry.js';
import { resolveSiteLinePointsMm } from '../site/siteLineJoinPrimitives.js';
import { computeOuterLineIds } from '../site/lineClassification.js';
import {
  SITE_LINE_COLOR, SITE_CORNER_MARK_RADIUS_PX, SITE_CORNER_MARK_WEIGHT, lineHitWidth, SITE_HIT_NODE_NAME,
} from '../site/siteLineStyle.js';

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

export const SiteLinesLayer = observer(({ site, viewport, selectedLineId, onSelectLine }) => {
  const r       = 4  / viewport.scaleX; // 端点丸の半径（スクリーン 4px 相当）
  const badgeR  = 10 / viewport.scaleX; // 丸番号バッジ半径（スクリーン 10px 相当）
  const sw      = viewport.lineWeightsPx.medium / viewport.scaleX; // バッジ枠 strokeWidth
  const badgeFs = 9  / viewport.scaleX; // バッジ文字 fontSize（スクリーン 9px 相当）
  const markR   = SITE_CORNER_MARK_RADIUS_PX / viewport.scaleX; // 境界線の交点○の半径

  // site.lines の順番に三角形へ連番を付ける（三斜タブと同じ順序）
  const triByLine = new Map([...site.triangleMap.values()].map(t => [t.baseLine.id, t]));
  let triNum = 0;
  const orderedTriData = site.lines.flatMap(line => {
    const tri = triByLine.get(line.id);
    return tri ? [{ line, tri, num: ++triNum }] : [];
  });

  // 外周（境界線）が2本以上集まる端点に小さな○を表示
  const outerIds = computeOuterLineIds(site);
  const pointHitCount = new Map(); // pointId -> 外周線分の本数
  for (const line of site.lines) {
    if (!outerIds.has(line.id)) continue;
    pointHitCount.set(line.startPoint.id, (pointHitCount.get(line.startPoint.id) ?? 0) + 1);
    pointHitCount.set(line.endPoint.id,   (pointHitCount.get(line.endPoint.id)   ?? 0) + 1);
  }
  const intersectionPoints = site.points.filter(p => (pointHitCount.get(p.id) ?? 0) >= 2);

  // L字の角の外角を閉じる延長（site/siteLineJoinPrimitives.js。展開図と同じ規則を境界線へ適用。
  // 詳細は同モジュール冒頭コメント・.claude/elevation-model.md「L字の角の外角を閉じる」節）。
  // 幅・dash（外周=中線の一点鎖線／内側=細線）の判断もこの関数が唯一の供給源——.jsx側でisSelectedから再導出しない。
  const resolvedLines = resolveSiteLinePointsMm(site.lines, selectedLineId, viewport.lineWeightsPx, outerIds, viewport);

  return (
    <>
      {/* 線分・端点マーカー */}
      {site.lines.map(line => {
        const isSelected = line.id === selectedLineId;
        const { red, blue } = getSiteLineRedBlue(line);
        const resolved = resolvedLines.get(line.id);

        return [
          // 線分
          <Line
            key={`l-${line.id}`}
            points={resolved.points}
            stroke={SITE_LINE_COLOR}
            strokeWidth={resolved.width}
            dash={resolved.dash ? [...resolved.dash] : undefined}
            strokeScaleEnabled={false}
            name={SITE_HIT_NODE_NAME}
            hitStrokeWidth={lineHitWidth()}
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

      {/* 境界線（外周）同士の交点に小さな○ */}
      {intersectionPoints.map(p => (
        <Circle
          key={`ix-${p.id}`}
          x={p.x} y={p.y}
          radius={markR}
          stroke={SITE_LINE_COLOR}
          strokeWidth={viewport.lineWeightsPx[SITE_CORNER_MARK_WEIGHT]}
          strokeScaleEnabled={false}
          listening={false}
        />
      ))}
    </>
  );
});
