import { FinishTable } from './FinishTable.jsx';
import { ModePanel } from '../ui/ModePanel.jsx';

// 横長デバイス用 — 右端に固定オーバーレイ（タブ: 内部 / 階段 / 外部 / …）
export function FinishSidebar({
  graph, mode, project, selectedRoomId, onSelectRoom, onApplyNaming, floorName,
  onDeleteEquipment, onChangeEquipmentUsage, onDeleteStair,
  onDeleteStairRoom,
}) {
  return (
    <ModePanel title="仕上げ表" raiseSignal={selectedRoomId}>
      <FinishTable
        graph={graph}
        mode={mode}
        project={project}
        selectedRoomId={selectedRoomId}
        onSelectRoom={onSelectRoom}
        onApplyNaming={onApplyNaming}
        floorName={floorName}
        onDeleteEquipment={onDeleteEquipment}
        onChangeEquipmentUsage={onChangeEquipmentUsage}
        onDeleteStair={onDeleteStair}
        onDeleteStairRoom={onDeleteStairRoom}
      />
    </ModePanel>
  );
}
