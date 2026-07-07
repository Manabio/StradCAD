import { observer } from 'mobx-react-lite';
import { Rect, Text, Line, Group, Shape } from 'react-konva';
import { getAllCells, gridDividerSegments, cellBoundsFromKey, cellBoundsList, roomBounds, outlineSegments } from './gridCells.js';
import { computeExteriorWallSegments } from './wallGeneration.js';

const EXTERIOR_WALL_WIDTH = 4; // px（ズームに依らない太線幅）

const ROOM_COLORS = [
  '#bfdbfe', '#bbf7d0', '#fde68a', '#fecaca',
  '#ddd6fe', '#fed7aa', '#a7f3d0', '#fbcfe8',
  '#e0f2fe', '#d1fae5', '#fef3c7', '#ffe4e6',
];

function roomColor(index) { return ROOM_COLORS[index % ROOM_COLORS.length]; }

export const FinishModeLayer = observer(({
  graph,
  viewport,
  selectedRoomId,
  onSelectRoom,
  previewCells = [],
}) => {
  // extent を尊重した実在セルのみ列挙してグリッド背景を塗る。
  // 枠線をセル矩形の stroke で描くと L字領域の内部分割位置に実在しない線が
  // 見えるため、区割り線は CL の実在区間の線分として別描画する
  const gridCells = getAllCells(graph).map(cell => (
    <Rect
      key={`g${cell.key}`}
      x={cell.x1} y={cell.y1}
      width={cell.x2 - cell.x1} height={cell.y2 - cell.y1}
      fill="rgba(100,149,237,0.05)"
    />
  ));

  const gridLines = gridDividerSegments(graph).map(seg => (
    <Line
      key={`gl${seg.key}`}
      points={seg.isVertical
        ? [seg.value, seg.lo, seg.value, seg.hi]
        : [seg.lo, seg.value, seg.hi, seg.value]}
      stroke="rgba(100,149,237,0.25)"
      strokeWidth={1 / viewport.scaleX}
      listening={false}
    />
  ));

  // 既存部屋の塗り。セルごとの Rect だと接する辺に塗りの継ぎ目や選択枠の
  // 内部線（L字領域の実在しない分割線）が出るため、部屋全体を1パスで塗り、
  // 選択枠は共有辺を打ち消した外周線分で描く
  const roomRects = [];
  graph.rooms.forEach((room, idx) => {
    const isSelected = room.id === selectedRoomId;
    const boundsList = cellBoundsList(room.cells, graph);
    if (boundsList.length > 0) {
      roomRects.push(
        <Shape
          key={`r${room.id}`}
          sceneFunc={(ctx, shape) => {
            ctx.beginPath();
            for (const b of boundsList) ctx.rect(b.x1, b.y1, b.x2 - b.x1, b.y2 - b.y1);
            ctx.fillStrokeShape(shape);
          }}
          fill={roomColor(idx)}
          opacity={isSelected ? 0.85 : 0.55}
          onClick={() => onSelectRoom(room.id)}
          onTap={() => onSelectRoom(room.id)}
        />
      );
      if (isSelected) {
        for (const seg of outlineSegments(boundsList)) {
          roomRects.push(
            <Line
              key={`rs${room.id}:${seg.isVertical ? 'v' : 'h'}${seg.value}:${seg.lo}`}
              points={seg.isVertical
                ? [seg.value, seg.lo, seg.value, seg.hi]
                : [seg.lo, seg.value, seg.hi, seg.value]}
              stroke="#2563eb"
              strokeWidth={2 / viewport.scaleX}
              listening={false}
            />
          );
        }
      }
    }

    if (room.name) {
      let cx, cy, refWidth;
      if (room.namePosition) {
        cx = room.namePosition.x;
        cy = room.namePosition.y;
        const bounds = roomBounds(room.cells, graph);
        refWidth = isFinite(bounds.x1) ? bounds.x2 - bounds.x1 : null;
      } else {
        let largest = null, maxArea = 0;
        for (const key of room.cells) {
          const b = cellBoundsFromKey(key, graph);
          if (!b) continue;
          const area = (b.x2 - b.x1) * (b.y2 - b.y1);
          if (area > maxArea) { maxArea = area; largest = b; }
        }
        if (largest) {
          cx = (largest.x1 + largest.x2) / 2;
          cy = (largest.y1 + largest.y2) / 2;
          refWidth = largest.x2 - largest.x1;
        }
      }

      if (cx !== undefined) {
        const fontSize = refWidth != null
          ? Math.max(80, Math.min(200, refWidth / 5))
          : 80;
        roomRects.push(
          <Text
            key={`t${room.id}`}
            x={cx} y={cy}
            text={room.name}
            fontSize={fontSize}
            fill={isSelected ? '#1d4ed8' : '#374151'}
            align="center"
            verticalAlign="middle"
            offsetX={fontSize * room.name.length * 0.3}
            offsetY={fontSize / 2}
            onClick={() => onSelectRoom(room.id)}
            onTap={() => onSelectRoom(room.id)}
          />
        );
      }
    }
  });

  // 外壁ループ（建物外周・中庭境界）を太線表示
  const exteriorWalls = computeExteriorWallSegments(graph).map(seg => {
    const points = seg.isVertical
      ? [seg.value, seg.start, seg.value, seg.end]
      : [seg.start, seg.value, seg.end, seg.value];
    return (
      <Line
        key={`ew${seg.axisCLId}:${seg.loopType}:${seg.startCLId}:${seg.endCLId}`}
        points={points}
        stroke="#1e293b"
        strokeWidth={EXTERIOR_WALL_WIDTH / viewport.scaleX}
        listening={false}
      />
    );
  });

  // ドラッグ中プレビュー（部屋塗りと同様、1パス塗り＋外周線分）
  const previewRects = previewCells.length > 0 ? [
    <Shape
      key="pfill"
      sceneFunc={(ctx, shape) => {
        ctx.beginPath();
        for (const c of previewCells) ctx.rect(c.x1, c.y1, c.x2 - c.x1, c.y2 - c.y1);
        ctx.fillStrokeShape(shape);
      }}
      fill="rgba(37,99,235,0.2)"
      listening={false}
    />,
    ...outlineSegments(previewCells).map(seg => (
      <Line
        key={`po${seg.isVertical ? 'v' : 'h'}${seg.value}:${seg.lo}`}
        points={seg.isVertical
          ? [seg.value, seg.lo, seg.value, seg.hi]
          : [seg.lo, seg.value, seg.hi, seg.value]}
        stroke="#2563eb"
        strokeWidth={2 / viewport.scaleX}
        listening={false}
      />
    )),
  ] : [];

  return (
    <Group>
      {gridCells}
      {gridLines}
      {roomRects}
      {exteriorWalls}
      {previewRects}
    </Group>
  );
});
