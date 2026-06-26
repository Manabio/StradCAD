// 部材タグの右クリックメニュー。「適合(Calculated)」状態の暫定の手動トグル専用。
// 本物の構造計算ロジック（次フェーズ）が判定するようになるまでのplaceholder。
export function MemberStatusMenu({ pos, isCalculated, onSelect, onClose }) {
  if (!pos) return null;
  return (
    <>
      <div style={{ position: 'fixed', inset: 0, zIndex: 999 }} onPointerDown={onClose} />
      <div
        style={{
          position: 'fixed', left: pos.x, top: pos.y, zIndex: 1000,
          background: '#fff', border: '1px solid #cbd5e1', borderRadius: 6,
          boxShadow: '0 4px 12px rgba(0,0,0,0.15)', padding: 4, minWidth: 160,
        }}
      >
        <button
          onClick={onSelect}
          style={{
            display: 'block', width: '100%', textAlign: 'left', padding: '6px 10px',
            fontSize: 12, background: 'none', border: 'none', borderRadius: 4, cursor: 'pointer',
          }}
          onMouseEnter={e => { e.currentTarget.style.background = '#f1f5f9'; }}
          onMouseLeave={e => { e.currentTarget.style.background = 'none'; }}
        >
          {isCalculated ? '検査済みを解除' : '検査済みにする（暫定）'}
        </button>
      </div>
    </>
  );
}
