import { observer } from 'mobx-react-lite';
import { undoManager } from '../undoManager.js';
import { TOP_BAR } from '../layout.js';

// Undo/Redo ボタン — 左上
export const HistoryButtons = observer(({ onUndo, onRedo }) => {
  return (
    <div style={{
      position: 'fixed', top: 0, left: 6,
      height: TOP_BAR, display: 'flex', alignItems: 'center', gap: 2, zIndex: 200,
    }}>
      {[
        { label: '↩', title: '元に戻す (Ctrl+Z / 2本指タップ)', can: undoManager.canUndo, action: () => onUndo() },
        { label: '↪', title: 'やり直す (Ctrl+Y / 3本指タップ)', can: undoManager.canRedo, action: () => onRedo() },
      ].map(({ label, title, can, action }) => (
        <button
          key={label}
          onClick={action}
          disabled={!can}
          title={title}
          style={{
            width: 32, height: 32, borderRadius: 8,
            border: '1px solid #e2e8f0',
            background: can ? '#fff' : '#f8fafc',
            color: can ? '#334155' : '#cbd5e1',
            fontSize: 16, cursor: can ? 'pointer' : 'default',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            lineHeight: 1,
          }}
        >
          {label}
        </button>
      ))}
    </div>
  );
});
