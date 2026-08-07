import { useState } from 'react';
import { observer } from 'mobx-react-lite';
import { viewport } from '../appViewport.js';

// 縮尺表示 / 入力 — 右下。width/height は画面中心ズーム(zoomAt)の基準点として
// App のリサイズ state（size）をそのまま受け取る。
export const ScaleIndicator = observer(({ width, height }) => {
  const [scaleInput, setScaleInput] = useState(null); // null=非編集, string=編集中

  function applyScaleInput() {
    const d = parseInt(scaleInput, 10);
    if (d > 0) {
      viewport.zoomAt(width / 2, height / 2, viewport.scaleDenominator / d);
    }
    setScaleInput(null);
  }

  return (
    <div style={{
      position: 'fixed', bottom: 8, right: 12,
      display: 'flex', alignItems: 'center', gap: 6,
    }}>
      {scaleInput === null ? (
        <div
          onClick={() => setScaleInput(String(viewport.scaleDenominator))}
          title="クリックして縮尺を入力"
          style={{ fontSize: 12, color: '#666', cursor: 'pointer', userSelect: 'none' }}
        >
          1/{viewport.scaleDenominator}
        </div>
      ) : (
        <div style={{
          fontSize: 12, color: '#333',
          background: '#fff', border: '1px solid #94a3b8',
          borderRadius: 4, padding: '2px 6px',
          display: 'flex', alignItems: 'center', gap: 2,
        }}>
          1/
          <input
            value={scaleInput}
            onChange={e => setScaleInput(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter')  applyScaleInput();
              if (e.key === 'Escape') setScaleInput(null);
            }}
            onBlur={() => setScaleInput(null)}
            autoFocus
            style={{
              width: 52, fontSize: 12, border: 'none', outline: 'none',
              textAlign: 'right', padding: 0,
            }}
          />
        </div>
      )}
    </div>
  );
});
