import { observer } from 'mobx-react-lite';
import { Line, Group, Shape } from 'react-konva';
import { cellBoundsList, outlineSegments } from '../finish/gridCells.js';
import { dividerSegmentsOutsideWalls } from '../finish/finishGuideGeometry.js';

// 天伏モードの天井セル選択の強調（確定した選択＋ドラッグ中のプレビュー＋セルの区切り線）。
// 仕上げモードの FinishModeLayer と同じ流儀（1パス塗り＋共有辺を打ち消した外周線）。選択は
// usePointerInteraction → CeilingModeState に一本化するため listening={false}。
// 解けないキー（CL 削除などで消失）は cellBoundsList が黙って落とす。

const segLine = (key, seg, stroke, strokeWidth) => (
  <Line
    key={key}
    points={seg.isVertical
      ? [seg.value, seg.lo, seg.value, seg.hi]
      : [seg.lo, seg.value, seg.hi, seg.value]}
    stroke={stroke}
    strokeWidth={strokeWidth}
    listening={false}
  />
);

const fillShape = (key, list, fill) => (
  <Shape
    key={key}
    sceneFunc={(ctx, shape) => {
      ctx.beginPath();
      for (const b of list) ctx.rect(b.x1, b.y1, b.x2 - b.x1, b.y2 - b.y1);
      ctx.fillStrokeShape(shape);
    }}
    fill={fill}
    listening={false}
  />
);

export const CeilingSelectionLayer = observer(({ graph, viewport, selectedCellKeys, previewCells }) => {
  const w = 2 / viewport.scaleX;
  const dividers = dividerSegmentsOutsideWalls(graph).map(seg => segLine(
    `dv${seg.key}`, seg, 'rgba(100,149,237,0.25)', 1 / viewport.scaleX));

  const selected = selectedCellKeys && selectedCellKeys.size > 0 ? cellBoundsList(selectedCellKeys, graph) : [];
  const selectedNodes = selected.length > 0 ? [
    fillShape('sfill', selected, 'rgba(37,99,235,0.15)'),
    ...outlineSegments(selected).map(seg =>
      segLine(`so${seg.isVertical ? 'v' : 'h'}${seg.value}:${seg.lo}`, seg, '#2563eb', w)),
  ] : [];

  const previewNodes = previewCells && previewCells.length > 0 ? [
    fillShape('pfill', previewCells, 'rgba(37,99,235,0.2)'),
    ...outlineSegments(previewCells).map(seg =>
      segLine(`po${seg.isVertical ? 'v' : 'h'}${seg.value}:${seg.lo}`, seg, '#2563eb', w)),
  ] : [];

  return (
    <Group>
      {dividers}
      {selectedNodes}
      {previewNodes}
    </Group>
  );
});
