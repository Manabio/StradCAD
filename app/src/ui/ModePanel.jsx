import { INSET } from '../layout.js';

// モード別パネルの共通シェル（横長＝右端固定オーバーレイ）。
// 仕上げ表(FinishSidebar) / 構造(StructuralPanel) / 平面パレット(FloorplanPalette)
// が共有する外枠。title を渡すとヘッダー（任意で × 閉じる）を描画する。
// 上下端は描画エリアと同じ INSET に揃える（ツールバー・ガターと重ならない）。
export function ModePanel({ title, width = 480, onClose, children }) {
  return (
    <div style={{
      position: 'fixed',
      top: INSET.top, right: 0, bottom: INSET.bottom,
      width,
      background: 'rgba(255,255,255,0.92)',
      backdropFilter: 'blur(8px)',
      borderLeft: '1px solid #e2e8f0',
      boxShadow: '-4px 0 16px rgba(0,0,0,0.08)',
      display: 'flex', flexDirection: 'column',
      zIndex: 200, overflow: 'hidden',
    }}>
      {title != null && (
        <div style={{
          padding: '10px 16px',
          borderBottom: '1px solid #e2e8f0',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          flexShrink: 0,
        }}>
          <span style={{ fontWeight: 700, fontSize: 14, color: '#1e293b' }}>{title}</span>
          {onClose && (
            <button
              onClick={onClose}
              style={{
                border: 'none', background: 'none', cursor: 'pointer',
                fontSize: 16, color: '#64748b', lineHeight: 1, padding: 4,
              }}
            >
              ×
            </button>
          )}
        </div>
      )}
      {children}
    </div>
  );
}
