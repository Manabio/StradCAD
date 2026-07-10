import { observer } from 'mobx-react-lite';
import { Text } from 'react-konva';
import { cellBoundsFromKey, getCellsInRect, roomBounds } from '../finish/gridCells.js';
import { withFinishUndo } from '../finish/finishUndo.js';

const FONT_SIZE_PX = 14; // スクリーン上の表示サイズ (px)

/**
 * 平面モードで部屋名ラベルを表示するレイヤー。
 * ワールド座標 Group 内に配置されるため、位置は mm 座標。
 * fontSize はビューポートスケールで逆補正し、常に FONT_SIZE_PX 相当の大きさで表示する。
 * ドラッグで room.namePosition を更新できる。
 */
export const RoomLabelsLayer = observer(({ graph, viewport }) => {
  if (!graph) return null;

  return graph.rooms.map(room => {
    if (!room.name) return null;

    let cx, cy;
    if (room.namePosition) {
      cx = room.namePosition.x;
      cy = room.namePosition.y;
    } else {
      const bounds = roomBounds(room.cells, graph);
      if (!bounds || bounds.x1 === Infinity) return null;
      const cellsInBounds = getCellsInRect(bounds.x1, bounds.y1, bounds.x2, bounds.y2, graph);
      const isRectangular = cellsInBounds.every(c => room.cells.has(c.key));
      if (isRectangular) {
        cx = (bounds.x1 + bounds.x2) / 2;
        cy = (bounds.y1 + bounds.y2) / 2;
      } else {
        let largest = null, maxArea = 0;
        for (const key of room.cells) {
          const b = cellBoundsFromKey(key, graph);
          if (!b) continue;
          const area = (b.x2 - b.x1) * (b.y2 - b.y1);
          if (area > maxArea) { maxArea = area; largest = b; }
        }
        if (!largest) return null;
        cx = (largest.x1 + largest.x2) / 2;
        cy = (largest.y1 + largest.y2) / 2;
      }
    }

    const fontSize = FONT_SIZE_PX / viewport.scaleX;
    const estimatedHalfWidth = fontSize * room.name.length * 0.5;

    return (
      <Text
        key={room.id}
        x={cx - estimatedHalfWidth}
        y={cy - fontSize / 2}
        text={room.name}
        fontSize={fontSize}
        fill="#1e3a5f"
        fontStyle="bold"
        draggable
        onPointerDown={e => { e.cancelBubble = true; }}
        onMouseEnter={e => { e.target.getStage().container().style.cursor = 'grab'; }}
        onMouseLeave={e => { e.target.getStage().container().style.cursor = 'default'; }}
        onDragEnd={e => {
          withFinishUndo(graph, () => room.setNamePosition(
            e.target.x() + estimatedHalfWidth,
            e.target.y() + fontSize / 2,
          ));
        }}
        listening
      />
    );
  });
});
