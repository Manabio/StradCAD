import { useState, useRef, useEffect } from 'react';

const LONGPRESS_DELAY = 450; // ms

// 検討チップ — 現在の階の採否を表示し、検討案（採用＋検討）の起点となる。
//   短タップ      : 検討追加（onTapAdd）
//   ロングタップ  : ドロップダウン（採用/検討案の切替＋管理メニュー）
//
// chipText        : チップ表示文字（例「1階：採用」「1階#a」）
// variants        : [{ id, label, isActive }] 採用＋検討案
// managementItems : [{ id, label, danger }] 現在の階に対する操作（採用昇格/コピー/削除/階変更…）
// onSwitch(id)    : 階・検討案の切替
// onTapAdd()      : 検討追加
// onManage(id)    : 管理メニュー選択
export function AltChip({ chipText, variants, managementItems, onSwitch, onTapAdd, onManage }) {
  const [open, setOpen] = useState(false);
  const ref       = useRef(null);
  const timer     = useRef(null);
  const longFired = useRef(false);

  useEffect(() => {
    if (!open) return;
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open]);

  function handleDown() {
    longFired.current = false;
    timer.current = setTimeout(() => { longFired.current = true; setOpen(true); }, LONGPRESS_DELAY);
  }
  function handleUp() {
    clearTimeout(timer.current);
    if (longFired.current) return;       // ロングタップ確定済み → 何もしない
    if (open) setOpen(false);            // ドロップダウン表示中の短タップ → 閉じる
    else onTapAdd();                     // 短タップ → 検討追加
  }
  function handleCancel() { clearTimeout(timer.current); }

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        onPointerDown={handleDown}
        onPointerUp={handleUp}
        onPointerLeave={handleCancel}
        title="タップ＝検討追加 / 長押し＝切替・管理"
        style={{
          padding: '3px 12px', borderRadius: 12,
          border: '1px solid #2563eb',
          background: '#eff6ff', color: '#2563eb',
          fontSize: 12, fontWeight: 700,
          cursor: 'pointer', whiteSpace: 'nowrap', userSelect: 'none',
          touchAction: 'none',
        }}
      >
        {chipText}
      </button>

      {open && (
        <div style={{
          position: 'absolute', top: 32, left: 0,
          background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8,
          boxShadow: '0 4px 16px rgba(0,0,0,0.12)', overflow: 'hidden',
          minWidth: 160, zIndex: 300,
        }}>
          {variants.map(v => (
            <button
              key={v.id}
              onClick={() => { setOpen(false); onSwitch(v.id); }}
              style={{
                display: 'flex', alignItems: 'center', width: '100%',
                padding: '9px 16px', textAlign: 'left',
                background: v.isActive ? '#eff6ff' : 'none',
                border: 'none', cursor: 'pointer',
                fontSize: 13, color: v.isActive ? '#2563eb' : '#1e293b',
                fontWeight: v.isActive ? 700 : 400,
              }}
            >
              <span style={{ width: 16, color: '#2563eb' }}>{v.isActive ? '✓' : ''}</span>
              {v.label}
            </button>
          ))}

          {managementItems.length > 0 && (
            <div style={{ height: 1, background: '#e2e8f0', margin: '4px 0' }} />
          )}
          {managementItems.map(item => (
            <button
              key={item.id}
              onClick={() => { setOpen(false); onManage(item.id); }}
              style={{
                display: 'block', width: '100%',
                padding: '9px 16px 9px 32px', textAlign: 'left',
                background: 'none', border: 'none', cursor: 'pointer',
                fontSize: 13, color: item.danger ? '#dc2626' : '#475569',
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
