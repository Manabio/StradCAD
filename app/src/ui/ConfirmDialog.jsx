import './AddCLDialog.css';

/**
 * 汎用確認ダイアログ
 *
 * buttons: [{ label, value, primary?, danger? }, ...]
 * onSelect(value) が呼ばれる
 */
export function ConfirmDialog({ message, buttons, onSelect }) {
  return (
    <>
      <div className="cl-dialog-backdrop" onPointerDown={() => onSelect('cancel')} />
      <div className="cl-dialog">
        <div style={{ fontSize: 13, color: '#1e293b', lineHeight: 1.6 }}>{message}</div>
        <div className="cl-dialog-actions">
          {buttons.map(btn => (
            <button
              key={btn.value}
              className={`cl-dialog-btn ${btn.primary ? 'cl-dialog-btn--ok' : 'cl-dialog-btn--cancel'}`}
              style={btn.danger ? { background: '#dc2626', color: '#fff', border: 'none' } : undefined}
              onClick={() => onSelect(btn.value)}
            >
              {btn.label}
            </button>
          ))}
        </div>
      </div>
    </>
  );
}
