import { useState, useEffect } from 'react';
import './AddCLDialog.css';

const KINDS = [
  { id: 'center', label: '中心',   hint: '通り芯（ラベルあり）' },
  { id: 'struct', label: '構造芯', hint: '構造通り芯（ラベルあり）' },
  { id: 'aux',    label: '補助線', hint: 'ラベルなし補助線' },
];

/**
 * 通り芯追加ダイアログ
 *
 * Y軸は上が正・下が負（表示座標 = −ワールドY）。
 * onConfirm(worldValue, kind) : kind = 'center'|'struct'|'aux'
 */
export function AddCLDialog({ type, worldCoord, gridCLs, onConfirm, onCancel, onPreviewChange }) {
  const isV  = type === 'vertical';
  const sign = isV ? 1 : -1;
  const axisLabel = isV ? 'X' : 'Y';

  const nearest = gridCLs.length > 0
    ? gridCLs.reduce((best, cl) =>
        Math.abs(cl.value - worldCoord) < Math.abs(best.value - worldCoord) ? cl : best
      )
    : null;

  const [kind,    setKind]    = useState('center');
  const [trim,    setTrim]    = useState(false);
  const [refId,   setRefId]   = useState(nearest?.id ?? '');
  const [distStr, setDistStr] = useState(() =>
    nearest
      ? String(Math.round(Math.abs(worldCoord - nearest.value)))
      : String(Math.round(sign * worldCoord))
  );

  const refCL = gridCLs.find(cl => cl.id === refId) ?? null;

  // direction from ref to target (positive = right/down in world coords)
  const dir = refCL ? (worldCoord >= refCL.value ? 1 : -1) : null;
  const dirLabel = dir == null ? null
    : isV ? (dir > 0 ? '右→' : '←左') : (dir > 0 ? '↓下' : '上↑');

  const dist = refCL
    ? Math.abs(Number(distStr) || 0)
    : (Number(distStr) || 0);
  const previewWorld   = refCL ? refCL.value + dir * dist : sign * dist;
  const previewDisplay = sign * previewWorld;

  useEffect(() => {
    onPreviewChange?.(previewWorld);
    return () => onPreviewChange?.(null);
  }, [previewWorld]); // eslint-disable-line react-hooks/exhaustive-deps

  function handleRefChange(e) {
    const id = e.target.value;
    setRefId(id);
    const cl = gridCLs.find(c => c.id === id);
    setDistStr(cl
      ? String(Math.round(Math.abs(worldCoord - cl.value)))
      : String(Math.round(sign * worldCoord))
    );
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter')  onConfirm(previewWorld, kind, trim);
    if (e.key === 'Escape') onCancel();
  }

  return (
    <>
      <div className="cl-dialog-backdrop" onPointerDown={onCancel} />
      <div className="cl-dialog">
        <div className="cl-dialog-title">
          {isV ? '垂直線を追加' : '水平線を追加'}
        </div>

        {/* 種別セレクタ */}
        <div className="cl-kind-group">
          {KINDS.map(k => (
            <button
              key={k.id}
              className={`cl-kind-btn${kind === k.id ? ' cl-kind-btn--active' : ''}`}
              title={k.hint}
              onClick={() => setKind(k.id)}
            >
              {k.label}
            </button>
          ))}
        </div>

        <label className="cl-dialog-row">
          <span className="cl-dialog-label">参照</span>
          <select value={refId} onChange={handleRefChange}>
            <option value="">なし（絶対座標）</option>
            {gridCLs.map(cl => (
              <option key={cl.id} value={cl.id}>{cl.label}</option>
            ))}
          </select>
        </label>

        <label className="cl-dialog-row">
          <span className="cl-dialog-label">
            {refCL ? `${refCL.label}` : `${axisLabel} =`}
          </span>
          {dirLabel && <span className="cl-dialog-dir">{dirLabel}</span>}
          <input
            type="number"
            className="cl-dialog-input"
            value={distStr}
            min="0"
            onChange={e => setDistStr(e.target.value)}
            onKeyDown={handleKeyDown}
            autoFocus
          />
          <span className="cl-dialog-unit">mm</span>
        </label>

        <div className="cl-dialog-result">
          {axisLabel} = {Math.round(previewDisplay)} mm
        </div>

        <label className="cl-dialog-row cl-dialog-row--check">
          <input
            type="checkbox"
            checked={trim}
            onChange={e => setTrim(e.target.checked)}
          />
          <span className="cl-dialog-label">トリム（直交芯端でカット）</span>
        </label>

        <div className="cl-dialog-actions">
          <button className="cl-dialog-btn cl-dialog-btn--cancel" onClick={onCancel}>
            キャンセル
          </button>
          <button className="cl-dialog-btn cl-dialog-btn--ok" onClick={() => onConfirm(previewWorld, kind, trim)}>
            追加
          </button>
        </div>
      </div>
    </>
  );
}
