import { useState } from 'react';
import { INSET } from '../layout.js';
import { HANDLE_WIDTH, HANDLE_HEIGHT, shouldOpenOnSignal, drawerTransform } from './modePanelDrawer.js';

// モード別パネルの共通シェル（横長＝右端固定のドロワー。キャンバスに重ねたまま右端からスライドする）。
// 仕上げ表(FinishSidebar) / 構造(StructuralPanel) / 平面パレット(FloorplanPalette) /
// 建具(OpeningPanel) / 敷地(SiteInfoPanel) が共有する外枠。title を渡すとヘッダー（任意で × 閉じる）を描画する。
// 上下端は描画エリアと同じ INSET に揃える（ツールバー・ガターと重ならない）。
// 開閉は左端の取っ手で行う。マウント時は開いており、閉じた後は raiseSignal が
// truthy に変化したとき（行・要素の選択時など。BottomSheet と同じ規則）に自動で開く。
export function ModePanel({ title, width = 480, onClose, raiseSignal, children }) {
  const [open, setOpen] = useState(true);
  const [prevSignal, setPrevSignal] = useState(raiseSignal);
  if (raiseSignal !== prevSignal) {
    setPrevSignal(raiseSignal);
    if (shouldOpenOnSignal(prevSignal, raiseSignal)) setOpen(true);
  }

  return (
    <div style={{
      position: 'fixed',
      top: INSET.top, right: 0, bottom: INSET.bottom,
      width,
      transform: drawerTransform(open),
      transition: 'transform 0.25s ease',
      zIndex: 200,
    }}>
      <button
        onClick={() => setOpen(o => !o)}
        aria-label={open ? 'パネルを閉じる' : 'パネルを開く'}
        style={{
          position: 'absolute',
          left: -HANDLE_WIDTH, top: '50%',
          width: HANDLE_WIDTH, height: HANDLE_HEIGHT,
          marginTop: -HANDLE_HEIGHT / 2,
          padding: 0,
          background: 'rgba(255,255,255,0.92)',
          border: '1px solid #e2e8f0', borderRight: 'none',
          borderRadius: '8px 0 0 8px',
          cursor: 'pointer', fontSize: 16, color: '#64748b', lineHeight: 1,
        }}
      >
        {open ? '›' : '‹'}
      </button>
      <div
        inert={!open}
        style={{
          height: '100%',
          background: 'rgba(255,255,255,0.92)',
          backdropFilter: 'blur(8px)',
          borderLeft: '1px solid #e2e8f0',
          boxShadow: open ? '-4px 0 16px rgba(0,0,0,0.08)' : 'none',
          display: 'flex', flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
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
    </div>
  );
}
