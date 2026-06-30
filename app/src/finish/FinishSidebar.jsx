import { FinishTable } from './FinishTable.jsx';
import { ModePanel } from '../ui/ModePanel.jsx';

// 横長デバイス用 — 右端に固定オーバーレイ（タブ: 内部 / 階段 / 外部 / …）
export function FinishSidebar({ graph, mode, project, selectedRoomId, onSelectRoom, floorName }) {
  return (
    <ModePanel title="仕上げ表">
      <FinishTable
        graph={graph}
        mode={mode}
        project={project}
        selectedRoomId={selectedRoomId}
        onSelectRoom={onSelectRoom}
        floorName={floorName}
      />
    </ModePanel>
  );
}
