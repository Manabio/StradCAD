import { observer } from 'mobx-react-lite';
import { Group, Text } from 'react-konva';
import { cellBoundsFromKey, getCellsInRect, roomBounds } from '../finish/gridCells.js';
import { withFinishUndo } from '../finish/finishUndo.js';
import { LodLevel } from '../viewport.js';

const FONT_SIZE_PX    = 14; // 部屋名のスクリーン上の表示サイズ (px)
const FL_FONT_SIZE_PX = 11; // FL表示のスクリーン上の表示サイズ (px)。部屋名より控えめに小さく
const FL_GAP_PX       = 2;  // 部屋名とFL表示の行間 (px)
// FL表示は半角英数のみ。1文字あたりの幅比率（センター合わせの推定幅算出用）
const FL_CHAR_WIDTH_RATIO = 0.55;

/**
 * 平面モードで部屋名ラベルを表示するレイヤー。
 * ワールド座標 Group 内に配置されるため、位置は mm 座標。
 * fontSize はビューポートスケールで逆補正し、常に FONT_SIZE_PX 相当の大きさで表示する。
 * ドラッグで room.namePosition を更新できる。
 * 詳細LODでは、部屋のFL（room.floorLevel ?? graph.defaultFloorLevel）が0でない場合、
 * 部屋名の下に符号付きでFL表示を添える（部屋名と同じGroupにまとめてドラッグに追従させる）。
 */
export const RoomLabelsLayer = observer(({ graph, viewport, floorPrefix = '' }) => {
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

    const flValue = room.floorLevel ?? graph.defaultFloorLevel;
    const showFL = viewport.lodLevel === LodLevel.DETAIL && flValue !== 0;
    const flFontSize = FL_FONT_SIZE_PX / viewport.scaleX;
    const flGap = FL_GAP_PX / viewport.scaleX;
    // 「2FL+300」のように当該階を頭に付ける。符号は必ず表示（負値は数値表記が自前で持つ）
    const flText = `${floorPrefix}FL${flValue > 0 ? '+' : ''}${flValue}`;
    const flHalfWidth = flText.length * flFontSize * FL_CHAR_WIDTH_RATIO / 2;

    return (
      <Group
        key={room.id}
        x={cx - estimatedHalfWidth}
        y={cy - fontSize / 2}
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
      >
        <Text
          text={room.name}
          fontSize={fontSize}
          fill="#1e3a5f"
          fontStyle="bold"
        />
        {showFL && (
          /* width を与えると幅超過時に折り返す＆センタリングも効かないため、width は使わず
             部屋名の中心X（= estimatedHalfWidth）へ FL文字列の推定半幅ぶん offsetX して
             1行のままセンター合わせにする */
          <Text
            x={estimatedHalfWidth}
            y={fontSize + flGap}
            offsetX={flHalfWidth}
            text={flText}
            fontSize={flFontSize}
            fill="#1e3a5f"
          />
        )}
      </Group>
    );
  });
});
