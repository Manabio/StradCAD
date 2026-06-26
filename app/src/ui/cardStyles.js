// finish/FinishTable.jsx の RoomCard と同型のアコーディオンカード共通スタイル。
// 構造リストタブ（structural/MemberListTab.jsx）等、他のアコーディオンカードUIから共有する。

export const cardContainerStyle = {
  border: '1px solid #e2e8f0',
  borderRadius: 6,
  margin: '6px 8px',
  background: '#fff',
  overflow: 'hidden',
};

export const cardHeaderStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '8px 10px',
  cursor: 'pointer',
  userSelect: 'none',
};

export const cardBodyStyle = {
  padding: '4px 12px 10px',
  borderTop: '1px solid #e2e8f0',
};

export const cardRowStyle = {
  display: 'flex',
  gap: 12,
  marginBottom: 4,
};

export const cardFieldStyle = {
  flex: 1,
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  minWidth: 0,
};

export const cardLabelStyle = {
  fontSize: 12,
  color: '#64748b',
  whiteSpace: 'nowrap',
  flexShrink: 0,
};

export const cardInputWrapStyle = {
  flex: 1,
  minWidth: 0,
  border: '1px solid #e2e8f0',
  borderRadius: 4,
  padding: '2px 6px',
  background: '#f8fafc',
};

export const deleteButtonStyle = {
  fontSize: 12,
  color: '#dc2626',
  background: 'none',
  border: '1px solid #fca5a5',
  borderRadius: 4,
  padding: '4px 12px',
  cursor: 'pointer',
};

export const cellInputStyle = {
  width: '100%',
  minWidth: 60,
  border: 'none',
  outline: 'none',
  background: 'transparent',
  fontSize: 12,
  padding: 0,
};
