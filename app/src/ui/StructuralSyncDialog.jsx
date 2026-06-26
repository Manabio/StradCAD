import './AddCLDialog.css';

/**
 * 構造モードへの外部問合せ（階追加・仕上げ退出）でフットプリント外に出た構造部材の整理ダイアログ。
 *
 * 選択肢は「通常は A（保持）/ C（全削除）。手動編集部材（🔒）が候補にある場合のみ B（自動生成分のみ削除）」。
 * 各オプションはベースライン（削除前状態）から再適用されるため非累積で、閉じる前に何度でも切替できる。
 *
 * @param summary { autoCount, protectedCount, floors:[{ name, auto, protected }] }
 * @param applied 現在適用中のモード 'keep'|'auto'|'all'|null（✓表示用）
 * @param onApply (mode:'keep'|'auto'|'all') => void
 * @param onClose () => void   確定（結果を保持してダイアログを閉じる）
 */
export function StructuralSyncDialog({ summary, applied, onApply, onClose }) {
  const { autoCount, protectedCount, floors } = summary;
  const hasProtected = protectedCount > 0;
  const total = autoCount + protectedCount;

  const optionBtn = (mode, label, danger) => (
    <button
      className={`cl-dialog-btn ${applied === mode ? 'cl-dialog-btn--ok' : 'cl-dialog-btn--cancel'}`}
      style={{
        width: '100%', textAlign: 'left', marginBottom: 6,
        ...(danger && applied !== mode ? { color: '#dc2626' } : null),
      }}
      onClick={() => onApply(mode)}
    >
      {applied === mode ? '✓ ' : ''}{label}
    </button>
  );

  return (
    <>
      <div className="cl-dialog-backdrop" onPointerDown={onClose} />
      <div className="cl-dialog" style={{ minWidth: 340 }}>
        <div style={{ fontSize: 13, color: '#1e293b', lineHeight: 1.6, marginBottom: 10 }}>
          フットプリント外に出た構造部材が <b>{total}</b> 件あります。<br />
          自動生成 {autoCount} 件{hasProtected ? <> / 手動編集🔒 {protectedCount} 件</> : null}
          {floors.length > 1 && (
            <div style={{ fontSize: 11, color: '#64748b', marginTop: 6 }}>
              {floors.map(f => (
                <div key={f.name}>
                  {f.name}：自動 {f.auto}{f.protected > 0 ? ` / 🔒 ${f.protected}` : ''}
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="cl-dialog-actions" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
          {optionBtn('keep', '削除しない（保持）')}
          {hasProtected && optionBtn('auto', '自動生成分のみ削除（🔒は保持）')}
          {optionBtn('all', 'フットプリント外を全削除', true)}
          <button
            className="cl-dialog-btn cl-dialog-btn--ok"
            style={{ width: '100%', marginTop: 4 }}
            onClick={onClose}
          >
            閉じる
          </button>
        </div>
      </div>
    </>
  );
}
