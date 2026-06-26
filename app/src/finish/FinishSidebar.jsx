import { FinishTable } from './FinishTable.jsx';
import { ModePanel } from '../ui/ModePanel.jsx';

// 横長デバイス用 — 右端に固定オーバーレイ
export function FinishSidebar({ graph, mode, selectedRoomId, onSelectRoom, floorName }) {
  return (
    <ModePanel title="仕上げ表">
      <FinishTable
        graph={graph}
        mode={mode}
        selectedRoomId={selectedRoomId}
        onSelectRoom={onSelectRoom}
        floorName={floorName}
      />
    </ModePanel>
  );
}
