import { observer } from 'mobx-react-lite';
import { Line, Circle, Group, Text } from 'react-konva';
import { getSiteLineRedBlue } from '../site/siteGeometry.js';
import { resolveSiteLinePointsMm } from '../site/siteLineJoinPrimitives.js';
import { computeOuterLineIds, computeOuterCornerPoints } from '../site/lineClassification.js';
import { composeSiteBoundaryChains, isLinesLayerChain } from '../site/siteBoundaryChain.js';
import {
  SITE_LINE_COLOR, SITE_CORNER_MARK_RADIUS_PX, SITE_CORNER_MARK_WEIGHT, lineHitWidth, SITE_HIT_NODE_NAME,
  siteLineWeightKey,
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
  const intersectionPoints = computeOuterCornerPoints(site, outerIds);

  // L字の角の外角を閉じる延長（site/siteLineJoinPrimitives.js。展開図と同じ規則を境界線へ適用。
  // 詳細は同モジュール冒頭コメント・.claude/elevation-model.md「L字の角の外角を閉じる」節）。
  // resolved は当たり線（外周は透明）と内側の線（細線）の幅・座標にだけ使う。外周（境界線）の見える線の幅は
  // siteBoundaryChain の owners と siteLineWeightKey から引く（下の boundaryChains）。
  const resolvedLines = resolveSiteLinePointsMm(site.lines, selectedLineId, viewport.lineWeightsPx, outerIds, viewport);
  const boundaryChains = composeSiteBoundaryChains(site, viewport.scaleX); // 最長の判定は敷地全体（三斜＋長方形）

  return (
    <>
      {/* 線分・端点マーカー */}
      {site.lines.map(line => {
        const isSelected = line.id === selectedLineId;
        const { red, blue } = getSiteLineRedBlue(line);
        const resolved = resolvedLines.get(line.id);

        return [
          // 線分。外周（境界線）の見える線は下の境界線の runs が描くので、ここは当たり専用の透明な線にする
          <Line
            key={`l-${line.id}`}
            points={resolved.points}
            stroke={resolved.dash ? 'transparent' : SITE_LINE_COLOR}
            strokeWidth={resolved.width}
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

      {/* 境界線（外周）の見える線＝実線の小区間（破線部は間・点・間。site/siteBoundaryChain.js）。三斜の線を含む区間だけここで描く（長方形だけの区間は SiteRectsLayer） */}
      {boundaryChains.filter(isLinesLayerChain).flatMap(c => {
        const isSelected = c.owners.some(o => o.lineId === selectedLineId);
        return c.runs.map((run, i) => (
          <Line
            key={`bc-${c.key}/${i}`}
            points={run.points}
            stroke={SITE_LINE_COLOR}
            strokeWidth={viewport.lineWeightsPx[siteLineWeightKey(true, isSelected)]}
            strokeScaleEnabled={false}
            listening={false}
          />
        ));
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
