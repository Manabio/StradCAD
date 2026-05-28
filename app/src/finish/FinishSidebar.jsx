import { FinishTable } from './FinishTable.jsx';

// 横長デバイス用 — 右端に固定オーバーレイ
export function FinishSidebar({ graph, selectedRoomId, onSelectRoom, floorName, gutter }) {
  return (
    <div style={{
      position: 'fixed',
      top: gutter,
      right: 0,
      bottom: gutter,
      width: 480,
      background: 'rgba(255,255,255,0.92)',
      backdropFilter: 'blur(8px)',
      borderLeft: '1px solid #e2e8f0',
      boxShadow: '-4px 0 16px rgba(0,0,0,0.08)',
      display: 'flex',
      flexDirection: 'column',
      zIndex: 200,
      overflow: 'hidden',
    }}>
      <div style={{
        padding: '10px 16px',
        borderBottom: '1px solid #e2e8f0',
        fontWeight: 700,
        fontSize: 14,
        color: '#1e293b',
        flexShrink: 0,
      }}>
        仕上げ表
      </div>
      <FinishTable
        graph={graph}
        selectedRoomId={selectedRoomId}
        onSelectRoom={onSelectRoom}
        floorName={floorName}
      />
    </div>
  );
}
