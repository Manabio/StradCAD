import { TOP_BAR } from '../layout.js';

// モード切替バー — 横長は上部中央、縦長は下部中央に常時表示。
// 旧 HamburgerMenu のモード項目（平面/仕上げ/構造/敷地）を画面上に昇格したもの。
// キーボード・タッチ共通で操作できるよう、通常の <button> で構成する。
const MODES = [
  { mode: 'floorplan', label: '平面' },
  { mode: 'opening',   label: '建具' },
  { mode: 'finish',    label: '仕上げ' },
  { mode: 'structure', label: '構造' },
  { mode: 'site',      label: '敷地' },
];

export function ModeBar({ appMode, onSelect, isLandscape }) {
  const position = isLandscape
    ? { top: 0, height: TOP_BAR }
    : { bottom: 8 };

  return (
    <div style={{
      position: 'fixed',
      left: '50%', transform: 'translateX(-50%)',
      ...position,
      display: 'flex', alignItems: 'center', gap: 4,
      zIndex: 205,
    }}>
      {MODES.map(({ mode, label }) => {
        const active = appMode === mode;
        return (
          <button
            key={mode}
            onClick={() => onSelect(mode)}
            aria-pressed={active}
            title={label}
            style={{
              padding: '5px 16px',
              border: '1px solid',
              borderColor: active ? '#2563eb' : '#cbd5e1',
              borderRadius: 8,
              background: active ? '#2563eb' : 'rgba(255,255,255,0.95)',
              color: active ? '#fff' : '#1e293b',
              fontSize: 13, fontWeight: 600,
              cursor: 'pointer',
              boxShadow: active ? 'none' : '0 1px 3px rgba(0,0,0,0.08)',
            }}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}
