import { observer } from 'mobx-react-lite';
import { Line, Circle, Group, Text } from 'react-konva';
import { placementVertexLabelText, placementVertexColorKind, PlacementVertexColorKind } from '../site/sitePlacementView.js';
import { siteTransformGroupProps, applySiteTransform } from '../site/siteTransform.js';
import { layoutBoundaryLabels } from '../site/siteBoundaryLabels.js';
import {
  SITE_LINE_COLOR, SITE_BOUNDARY_DASH, SITE_CORNER_MARK_RADIUS_PX, SITE_CORNER_MARK_WEIGHT, siteLineWeightKey,
  HIT_PX_MAX, SITE_HIT_NODE_NAME,
} from '../site/siteLineStyle.js';
import { MEMBER_SELECTION_COLOR } from '../structural/memberSelection.js';
import { layoutSitePlacementGrid } from '../site/sitePlacementGrid.js';
import {
  SITE_PLACEMENT_ROOF_LINE_WEIGHT, SITE_PLACEMENT_GRID_ORIGIN_COLOR_KEY, SITE_PLACEMENT_GRID_LINE_WEIGHT,
  GRID_DIM_COLOR, GRID_DIM_DOT_RADIUS_PX,
  SITE_PLACEMENT_SECOND_PAIR_COLOR, SITE_PLACEMENT_SHARED_VERTEX_COLOR,
  SITE_PLACEMENT_SELECTED_LABEL_TEXT_COLOR, SITE_PLACEMENT_SELECTED_LINE_WEIGHT,
} from '../core/constants.js';
import { PLAN_SOLIDS_COLOR } from './PlanSolidsLayer.jsx';
import { originColor } from './canvasStyle.js';
import { DIMENSION_LINE_WEIGHT, NUM_FONT_PX, TEXT_GAP_PX, gridLineDash } from './dimensionStyle.js';
import { labelCircle, dimensionRow } from './gutterPrimitives.jsx';
import { labelCircleRadius } from '../layout.js';

// 境界線ラベルの Text の箱幅（画面 px）。実幅に依らず中心を合わせるための箱で、描画都合の値。
const BOUNDARY_LABEL_BOX_PX = 200;

// 敷地の角の色（1 対目＝選択色・2 対目＝赤・共有＝紫）。どの枠でもない角は呼び出し側で SITE_LINE_COLOR
const VERTEX_COLOR_BY_KIND = Object.freeze({
  [PlacementVertexColorKind.FIRST]: MEMBER_SELECTION_COLOR,
  [PlacementVertexColorKind.SECOND]: SITE_PLACEMENT_SECOND_PAIR_COLOR,
  [PlacementVertexColorKind.SHARED]: SITE_PLACEMENT_SHARED_VERTEX_COLOR,
});

// 敷地モードの配置図（site/sitePlacementView.js の composeSitePlacementView の結果を写すだけ。判断は純モジュール側）。
// 屋根伏せ図の線・通り芯（線・寸法・丸ラベル。site/sitePlacementGrid.js が画面 px の離れを世界座標へ直す）は世界座標、
// 敷地の外周は図芯合わせの変換（siteTransformGroupProps）を掛けた Group の中。線は listening しない。
// 当たりを持つのは敷地の角の丸（タップ＝配置指定の頂点。mode.pickPlacementVertex。Group の中なので座標は敷地座標のまま渡る）と、
// 外周の通り芯（exterior）の丸ラベル（タップ＝配置指定の通り芯。mode.pickPlacementCenterLine）。
// 選択中の頂点（mode.placementInput の v1/v2・along.v1/v2）は塗り＋番号、選択中の通り芯（線と丸ラベル）は選択色。
export const SitePlacementLayer = observer(({ view, viewport, mode, didPanEnd, onToast }) => {
  // パンの終了後も Konva は click を出すので、直前がパンの終了なら無視する（SceneLayers の onSelectRectEdge と同じ）
  const pick = c => { if (didPanEnd?.()) return; mode.pickPlacementVertex({ x: c.x, y: c.y }); };
  // 通り芯の丸ラベルのタップ。即時再配置の拒否理由は App のトーストへ
  const pickLabel = id => {
    if (didPanEnd?.()) return;
    const r = mode.pickPlacementCenterLine(id);
    if (r?.toast) onToast?.(r.toast);
  };
  const labelR = labelCircleRadius(viewport); // 丸ラベルの半径（labelCircle と同じ式）
  const markR = SITE_CORNER_MARK_RADIUS_PX / viewport.scaleX; // 外周の角の丸の半径（SiteLinesLayer と同じ式）
  const hitW = HIT_PX_MAX / viewport.scaleX; // 角の当たり幅（SiteRectsLayer の anchorCircle と同じ）
  const numFontSize = NUM_FONT_PX / viewport.scaleX;
  const input = mode.placementInput;
  const selectedGridId = mode.placementCenterLine?.id ?? null;
  const selectedAlongId = mode.placementAlongCenterLine?.id ?? null;
  const selectedGridKey = selectedGridId ? view.grid.lines.find(l => l.id === selectedGridId)?.key ?? null : null;
  const selectedAlongKey = selectedAlongId ? view.grid.lines.find(l => l.id === selectedAlongId)?.key ?? null : null;
  const siteWidth = viewport.lineWeightsPx[siteLineWeightKey(true, false)];
  const g = layoutSitePlacementGrid(view.grid, viewport.scaleX);
  const gridLineWidth = viewport.lineWeightsPx[SITE_PLACEMENT_GRID_LINE_WEIGHT];
  const selectedLineWidth = viewport.lineWeightsPx[SITE_PLACEMENT_SELECTED_LINE_WEIGHT];
  const dimDotR = GRID_DIM_DOT_RADIUS_PX / viewport.scaleX;
  const boundaryBoxW = BOUNDARY_LABEL_BOX_PX / viewport.scaleX;
  const fallbackCenter = view.siteCenter ? applySiteTransform(view.siteCenter, view.siteTransform) : null;
  const boundaryLabels = layoutBoundaryLabels(view.boundaryPieces, view.siteTransform, viewport.scaleX, fallbackCenter);
  return (
    <>
      {g.lines.map(l => {
        const selected = l.key === selectedGridKey || l.key === selectedAlongKey;
        const width = selected ? selectedLineWidth : gridLineWidth;
        return (
          <Line
            key={l.key}
            points={l.points}
            stroke={selected ? MEMBER_SELECTION_COLOR : originColor(SITE_PLACEMENT_GRID_ORIGIN_COLOR_KEY)}
            strokeWidth={width}
            dash={gridLineDash(width)}
            strokeScaleEnabled={false}
            listening={false}
          />
        );
      })}
      {view.roofLines.map(l => (
        <Line
          key={`rf-${l.key}`}
          points={l.points}
          closed={l.closed}
          stroke={PLAN_SOLIDS_COLOR}
          strokeWidth={viewport.lineWeightsPx[SITE_PLACEMENT_ROOF_LINE_WEIGHT]}
          strokeScaleEnabled={false}
          listening={false}
        />
      ))}
      <Group {...siteTransformGroupProps(view.siteTransform)}>
        {view.siteSegments.map(s => (
          <Line
            key={`sg-${s.key}`}
            points={s.points}
            stroke={SITE_LINE_COLOR}
            strokeWidth={siteWidth}
            dash={[...SITE_BOUNDARY_DASH]}
            strokeScaleEnabled={false}
            listening={false}
          />
        ))}
        {view.siteCorners.flatMap(c => {
          // 番号: 1 対目「1」「2」・2 対目「1'」「2'」・共有の角は併記。空文字＝どの枠でもない
          const idx = placementVertexLabelText(input, c);
          const color = VERTEX_COLOR_BY_KIND[placementVertexColorKind(input, c)] ?? SITE_LINE_COLOR;
          return [
            <Circle
              key={`sc-${c.key}`}
              x={c.x} y={c.y}
              radius={markR}
              stroke={color}
              fill={idx ? color : undefined}
              strokeWidth={viewport.lineWeightsPx[SITE_CORNER_MARK_WEIGHT]}
              strokeScaleEnabled={false}
              listening={false}
            />,
            // 当たり専用の透明な丸（anchorCircle と同じ作り。strokeScaleEnabled は既定のまま）
            <Circle
              key={`sh-${c.key}`}
              name={SITE_HIT_NODE_NAME}
              x={c.x} y={c.y}
              radius={markR}
              fill="transparent"
              stroke="transparent"
              strokeWidth={hitW}
              onClick={() => pick(c)}
              onTap={() => pick(c)}
            />,
            ...(idx ? [
              // 番号は丸の右上。Group の回転を打ち消して常に正立で出す
              <Text
                key={`sn-${c.key}`}
                x={c.x} y={c.y}
                offsetX={-markR} offsetY={markR + numFontSize}
                rotation={-view.siteTransform.rotationDeg}
                text={idx}
                fontSize={numFontSize}
                fill={color}
                listening={false}
              />,
            ] : []),
          ];
        })}
      </Group>
      {g.rows.flatMap(row => {
        const { line, labels } = dimensionRow({
          keyBase: row.key, axis: row.axis, side: row.side, lineCoord: row.lineCoord, normalNumCoord: row.normalNumCoord,
          segments: row.segments, color: GRID_DIM_COLOR, strokeWidth: viewport.lineWeightsPx[DIMENSION_LINE_WEIGHT],
          fontSize: NUM_FONT_PX / viewport.scaleX, gap: TEXT_GAP_PX / viewport.scaleX,
        });
        return [
          line,
          ...row.extensions.map((e, i) => (
            <Line key={`${row.key}/ext/${i}`} points={e.points} stroke={GRID_DIM_COLOR}
              strokeWidth={viewport.lineWeightsPx[DIMENSION_LINE_WEIGHT]} strokeScaleEnabled={false} listening={false} />
          )),
          ...row.dots.map(d => (
            <Circle key={d.key} x={d.x} y={d.y} radius={dimDotR} fill={GRID_DIM_COLOR} listening={false} />
          )),
          ...labels,
        ];
      })}
      {g.labels.flatMap(l => {
        const selected = l.id === selectedGridId || l.id === selectedAlongId;
        return [
          // 選択中＝選択色の塗り＋白文字／押せない（外周でない）ラベル＝塗りなし（枠線と文字は従来色）
          ...labelCircle(l.key, l.x, l.y, l.label, viewport, selected
            ? { fill: MEMBER_SELECTION_COLOR, stroke: MEMBER_SELECTION_COLOR, textFill: SITE_PLACEMENT_SELECTED_LABEL_TEXT_COLOR }
            : l.exterior ? {} : { fill: 'transparent' }),
          // 当たり専用の透明な丸（外周の通り芯のラベルだけ。外周でないものは今までどおり描くだけで押せない）
          ...(l.exterior ? [
            <Circle
              key={`${l.key}-hit`}
              name={SITE_HIT_NODE_NAME}
              x={l.x} y={l.y}
              radius={labelR}
              fill="transparent"
              stroke="transparent"
              strokeWidth={hitW}
              onClick={() => pickLabel(l.id)}
              onTap={() => pickLabel(l.id)}
            />,
          ] : []),
        ];
      })}
      {boundaryLabels.map(l => (
        <Text
          key={`bt-${l.key}`}
          x={l.x} y={l.y}
          rotation={l.rotation}
          text={l.text}
          fontSize={numFontSize}
          fill={SITE_LINE_COLOR}
          width={boundaryBoxW}
          offsetX={boundaryBoxW / 2}
          offsetY={numFontSize}
          align="center"
          listening={false}
        />
      ))}
    </>
  );
});
