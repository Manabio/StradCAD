import { observer } from 'mobx-react-lite';
import { Rect, Text, Group } from 'react-konva';
import { getAllCells, cellBoundsFromKey, roomBounds } from './gridCells.js';

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
  previewCells,
}) => {
  // extent を尊重した実在セルのみ列挙してグリッド背景を描画
  const gridCells = getAllCells(graph).map(cell => (
    <Rect
      key={`g${cell.key}`}
      x={cell.x1} y={cell.y1}
      width={cell.x2 - cell.x1} height={cell.y2 - cell.y1}
      fill="rgba(100,149,237,0.05)"
      stroke="rgba(100,149,237,0.25)"
      strokeWidth={1 / viewport.scaleX}
    />
  ));

  // 既存部屋の塗り
  const roomRects = [];
  graph.rooms.forEach((room, idx) => {
    const isSelected = room.id === selectedRoomId;
    for (const key of room.cells) {
      const b = cellBoundsFromKey(key, graph);
      if (!b) continue;
      roomRects.push(
        <Rect
          key={`r${room.id}:${key}`}
          x={b.x1} y={b.y1}
          width={b.x2 - b.x1} height={b.y2 - b.y1}
          fill={roomColor(idx)}
          opacity={isSelected ? 0.85 : 0.55}
          stroke={isSelected ? '#2563eb' : 'transparent'}
          strokeWidth={isSelected ? 2 / viewport.scaleX : 0}
          onClick={() => onSelectRoom(room.id)}
          onTap={() => onSelectRoom(room.id)}
        />
      );
    }

    if (room.name) {
      const bounds = roomBounds(room.cells, graph);
      if (isFinite(bounds.x1)) {
        const cx = (bounds.x1 + bounds.x2) / 2;
        const cy = (bounds.y1 + bounds.y2) / 2;
        const fontSize = Math.max(80, Math.min(200, (bounds.x2 - bounds.x1) / 5));
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

  // ドラッグ中プレビュー
  const previewRects = previewCells.map(cell => (
    <Rect
      key={`p${cell.key}`}
      x={cell.x1} y={cell.y1}
      width={cell.x2 - cell.x1} height={cell.y2 - cell.y1}
      fill="rgba(37,99,235,0.2)"
      stroke="#2563eb"
      strokeWidth={2 / viewport.scaleX}
      listening={false}
    />
  ));

  return (
    <Group>
      {gridCells}
      {roomRects}
      {previewRects}
    </Group>
  );
});
