import { FinishTable } from './FinishTable.jsx';
import { BottomSheet } from '../ui/BottomSheet.jsx';

// 縦長デバイス用 — 下からせり上がるハーフモーダル（タブ: 内部 / 階段 / 外部 / …）。
export function FinishHalfModal({ graph, mode, project, selectedRoomId, onSelectRoom, floorName }) {
  return (
    <BottomSheet title="仕上げ表" raiseSignal={selectedRoomId}>
      <FinishTable
        graph={graph}
        mode={mode}
        project={project}
        selectedRoomId={selectedRoomId}
        onSelectRoom={onSelectRoom}
        floorName={floorName}
      />
    </BottomSheet>
  );
}
