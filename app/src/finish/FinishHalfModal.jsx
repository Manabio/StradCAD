import { FinishTable } from './FinishTable.jsx';
import { BottomSheet } from '../ui/BottomSheet.jsx';

// 縦長デバイス用 — 下からせり上がるハーフモーダル（仕上げ表）。
// ドラッグ基盤は汎用 BottomSheet に集約。行選択時は half へ引き上げる。
export function FinishHalfModal({ graph, mode, selectedRoomId, onSelectRoom, floorName }) {
  return (
    <BottomSheet title="仕上げ表" raiseSignal={selectedRoomId}>
      <FinishTable
        graph={graph}
        mode={mode}
        selectedRoomId={selectedRoomId}
        onSelectRoom={onSelectRoom}
        floorName={floorName}
      />
    </BottomSheet>
  );
}
