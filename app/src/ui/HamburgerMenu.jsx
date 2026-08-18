import { useState, useRef, useEffect } from 'react';

const SITE_INFO_ITEM       = { id: 'site-info',       label: '敷地情報' };
const BUILDING_INFO_ITEM   = { id: 'building-info',   label: '建築情報' };

const FILE_ITEMS = [
  { id: 'new',      label: '新規（全消去）' },
  { id: 'open',     label: '開く' },
  { id: 'save',     label: '保存' },
  { id: 'load',     label: '読込み' },
  { id: 'export',   label: '書出し' },
  { id: 'settings', label: '画面校正' },
];

export function HamburgerMenu({ onSelect }) {
  const [open, setOpen]       = useState(false);
  const [hovered, setHovered] = useState(null);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open]);

  const renderItem = (item) => (
    <button
      key={item.id}
      onPointerEnter={() => setHovered(item.id)}
      onPointerLeave={() => setHovered(null)}
      onClick={() => { setOpen(false); setHovered(null); onSelect(item.id); }}
      style={{
        display: 'flex', alignItems: 'center', width: '100%',
        padding: '10px 18px',
        textAlign: 'left',
        background: hovered === item.id ? '#f1f5f9' : 'none',
        border: 'none', cursor: 'pointer',
        fontSize: 14, color: '#1e293b',
        transition: 'background 0.1s',
      }}
    >
      {item.label}
    </button>
  );

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen(o => !o)}
        title="メニュー"
        style={{
          width: 36, height: 36,
          background: open ? '#e2e8f0' : 'none',
          border: 'none', cursor: 'pointer',
          borderRadius: 6, padding: 0,
          display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center', gap: 5,
          transition: 'background 0.12s',
        }}
      >
        {[0, 1, 2].map(i => (
          <div
            key={i}
            style={{ width: 18, height: 2, background: '#475569', borderRadius: 1 }}
          />
        ))}
      </button>

      {open && (
        <div style={{
          position: 'absolute', top: 40, right: 0,
          background: '#fff',
          border: '1px solid #e2e8f0',
          borderRadius: 8,
          boxShadow: '0 4px 16px rgba(0,0,0,0.12)',
          overflow: 'hidden',
          minWidth: 140,
          zIndex: 300,
        }}>
          {renderItem(SITE_INFO_ITEM)}
          {renderItem(BUILDING_INFO_ITEM)}
          <div style={{ height: 1, background: '#e2e8f0', margin: '4px 0' }} />
          {FILE_ITEMS.map(renderItem)}
        </div>
      )}
    </div>
  );
}
