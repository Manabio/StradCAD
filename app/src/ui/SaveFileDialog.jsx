import { useEffect, useRef, useState } from 'react';
import './AddCLDialog.css';

/**
 * 保存ファイル名の指定ダイアログ
 *
 * defaultName: 初期値（拡張子なし。localSnapshot.js の defaultDocumentFileName）
 * onConfirm(name): 確定したファイル名（拡張子なし）を渡す。空入力は defaultName に戻す。
 */
export function SaveFileDialog({ defaultName, onConfirm, onCancel }) {
  const [name, setName] = useState(defaultName);
  const inputRef = useRef(null);

  function handleConfirm() {
    onConfirm(name.trim() || defaultName);
  }

  // 開いたら全選択状態にして、そのまま打ち替えられるようにする
  useEffect(() => {
    inputRef.current?.select();
  }, []);

  // 物理キーボード: Enter=OK / Escape=キャンセル。フォーカス位置に依らず効くよう document で拾う。
  useEffect(() => {
    const onKeyDown = (e) => {
      if (e.key === 'Enter')  { e.preventDefault(); handleConfirm(); }
      if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [name, onConfirm, onCancel]); // eslint-disable-line react-hooks/exhaustive-deps -- handleConfirm は name から再生成される

  return (
    <>
      <div className="cl-dialog-backdrop" onPointerDown={onCancel} />
      <div className="cl-dialog">
        <div className="cl-dialog-title">保存</div>

        <label className="cl-dialog-row" style={{ gap: 8 }}>
          <span style={{ fontSize: 13, color: '#1e293b', whiteSpace: 'nowrap' }}>ファイル名</span>
          <input
            ref={inputRef}
            type="text"
            className="cl-dialog-input"
            value={name}
            style={{ width: 200 }}
            onChange={e => setName(e.target.value)}
          />
          <span className="cl-dialog-unit">.stq</span>
        </label>

        <div className="cl-dialog-actions">
          <button className="cl-dialog-btn cl-dialog-btn--cancel" onClick={onCancel}>
            キャンセル
          </button>
          <button className="cl-dialog-btn cl-dialog-btn--ok" onClick={handleConfirm}>
            保存
          </button>
        </div>
      </div>
    </>
  );
}
