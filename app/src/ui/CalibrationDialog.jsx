import { useState } from 'react';
import { observer } from 'mobx-react-lite';

const REF_MM = 100; // 基準線の長さ (mm)

const LINE_COLOR = '#3b82f6';

export const CalibrationDialog = observer(({ viewport, onClose }) => {
  const lineWPx = Math.round(REF_MM * viewport.pxPerMmX); // 水平基準線の CSS px 幅
  const lineHPx = Math.round(REF_MM * viewport.pxPerMmY); // 垂直基準線の CSS px 高さ

  const [measuredH, setMeasuredH] = useState(''); // 水平方向の実測値
  const [measuredV, setMeasuredV] = useState(''); // 垂直方向の実測値

  function apply() {
    const h = parseFloat(measuredH);
    const v = parseFloat(measuredV);
    const hasH = isFinite(h) && h > 0;
    const hasV = isFinite(v) && v > 0;
    if (!hasH && !hasV) return;
    viewport.calibrate(
      hasH ? viewport.pxPerMmX * (REF_MM / h) : viewport.pxPerMmX,
      hasV ? viewport.pxPerMmY * (REF_MM / v) : viewport.pxPerMmY,
    );
    onClose();
  }

  const inputStyle = {
    width: 80, fontSize: 13, textAlign: 'right',
    border: '1px solid #cbd5e1', borderRadius: 4, padding: '4px 8px',
  };
  const btn = (primary) => ({
    flex: 1, padding: '7px 0', borderRadius: 6, fontSize: 13, cursor: 'pointer',
    border:     primary ? 'none'    : '1px solid #cbd5e1',
    background: primary ? '#3b82f6' : '#f8fafc',
    color:      primary ? '#fff'    : '#333',
  });

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 200 }}>

      {/* 水平基準線 — 画面上部 (正確に lineWPx px) */}
      <div style={{
        position: 'absolute', top: '22%',
        left: '50%', transform: `translateX(-${lineWPx / 2}px)`,
        width: lineWPx, height: 2,
        background: LINE_COLOR, pointerEvents: 'none',
      }}>
        {/* 左端目盛り */}
        <div style={{ position: 'absolute', left: 0,   top: -4, width: 2, height: 10, background: LINE_COLOR }} />
        {/* 右端目盛り */}
        <div style={{ position: 'absolute', right: 0,  top: -4, width: 2, height: 10, background: LINE_COLOR }} />
        {/* ラベル */}
        <div style={{
          position: 'absolute', left: '50%', top: 6,
          transform: 'translateX(-50%)',
          fontSize: 11, color: LINE_COLOR, whiteSpace: 'nowrap',
        }}>
          ← 水平 {REF_MM} mm（想定）→
        </div>
      </div>

      {/* 垂直基準線 — 画面左側 (正確に lineHPx px) */}
      <div style={{
        position: 'absolute', left: '12%',
        top: '50%', transform: `translateY(-${lineHPx / 2}px)`,
        width: 2, height: lineHPx,
        background: LINE_COLOR, pointerEvents: 'none',
      }}>
        {/* 上端目盛り */}
        <div style={{ position: 'absolute', top: 0,    left: -4, width: 10, height: 2, background: LINE_COLOR }} />
        {/* 下端目盛り */}
        <div style={{ position: 'absolute', bottom: 0, left: -4, width: 10, height: 2, background: LINE_COLOR }} />
        {/* ラベル (横向き) */}
        <div style={{
          position: 'absolute', left: 10, top: '50%',
          transform: 'translateY(-50%)',
          fontSize: 11, color: LINE_COLOR, whiteSpace: 'nowrap',
        }}>
          ↕ 垂直 {REF_MM} mm（想定）
        </div>
      </div>

      {/* ダイアログ */}
      <div style={{
        position: 'absolute', top: '50%', left: '50%',
        transform: 'translate(-50%, -50%)',
        background: '#fff', borderRadius: 8, padding: 20, width: 300,
        boxShadow: '0 4px 24px rgba(0,0,0,0.25)',
        display: 'flex', flexDirection: 'column', gap: 12,
      }}>
        <div style={{ fontSize: 14, fontWeight: 600 }}>画面校正</div>
        <div style={{ fontSize: 12, color: '#64748b', lineHeight: 1.6 }}>
          画面上の基準線を定規で計測し、実測値を入力してください。
          入力した軸のみ更新されます。
        </div>

        {/* 水平 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 13, width: 56 }}>水平 →</span>
          <input
            type="number" min="1" step="0.1"
            value={measuredH}
            onChange={e => setMeasuredH(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') apply(); if (e.key === 'Escape') onClose(); }}
            placeholder={`${REF_MM}`}
            autoFocus
            style={inputStyle}
          />
          <span style={{ fontSize: 13 }}>mm</span>
        </div>

        {/* 垂直 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 13, width: 56 }}>垂直 ↕</span>
          <input
            type="number" min="1" step="0.1"
            value={measuredV}
            onChange={e => setMeasuredV(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') apply(); if (e.key === 'Escape') onClose(); }}
            placeholder={`${REF_MM}`}
            style={inputStyle}
          />
          <span style={{ fontSize: 13 }}>mm</span>
        </div>

        {/* 現在値 */}
        <div style={{ fontSize: 11, color: '#94a3b8' }}>
          現在: 水平 {viewport.pxPerMmX.toFixed(3)} px/mm
                ／ 垂直 {viewport.pxPerMmY.toFixed(3)} px/mm
        </div>

        <div style={{ display: 'flex', gap: 8, marginTop: 2 }}>
          <button onClick={onClose} style={btn(false)}>キャンセル</button>
          <button onClick={apply}   style={btn(true)}>適用</button>
        </div>
      </div>
    </div>
  );
});
