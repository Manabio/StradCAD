import { useState } from 'react';
import './AddCLDialog.css';
import { NumPad } from './NumPad.jsx';

/**
 * 壁追加ダイアログ
 *
 * 参照中心線 + 距離（常に正）を指定する。
 * 方向（右/左/上/下）は参照CL と長押し位置の相対位置から自動決定。
 *
 * onConfirm(refCL, dist) : dist は常に正の数値
 */
export function WallDialog({ worldPos, allCLs, onConfirm, onCancel }) {
  const nearest = allCLs.length > 0
    ? allCLs.reduce((best, cl) => {
        const dc = cl.centerLineType === 'X'
          ? Math.abs(cl.value - worldPos.x)
          : Math.abs(cl.value - worldPos.y);
        const db = best.centerLineType === 'X'
          ? Math.abs(best.value - worldPos.x)
          : Math.abs(best.value - worldPos.y);
        return dc < db ? cl : best;
      })
    : null;

  const [refId,   setRefId]   = useState(nearest?.id ?? '');
  const [distStr, setDistStr] = useState(() => {
    if (!nearest) return '0';
    const c = nearest.centerLineType === 'X' ? worldPos.x : worldPos.y;
    return String(Math.round(Math.abs(c - nearest.value)));
  });

  const refCL  = allCLs.find(cl => cl.id === refId) ?? null;
  const isRefV = refCL?.centerLineType === 'X';
  const coord  = isRefV ? worldPos.x : worldPos.y;
  const dir    = refCL ? (coord >= refCL.value ? 1 : -1) : null;
  const dirLabel = dir == null ? null
    : isRefV ? (dir > 0 ? '右→' : '←左') : (dir > 0 ? '↓下' : '上↑');

  const dist       = Math.abs(Number(distStr) || 0);
  const wallCoord  = refCL != null ? refCL.value + dir * dist : null;
  const sign       = isRefV ? 1 : -1;
  const wallDisplay = wallCoord != null ? Math.round(sign * wallCoord) : null;

  function handleRefChange(e) {
    const id = e.target.value;
    setRefId(id);
    const cl = allCLs.find(c => c.id === id);
    if (cl) {
      const c = cl.centerLineType === 'X' ? worldPos.x : worldPos.y;
      setDistStr(String(Math.round(Math.abs(c - cl.value))));
    }
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter' && refCL) onConfirm(refCL, dist);
    if (e.key === 'Escape') onCancel();
    e.stopPropagation();
  }

  return (
    <>
      <div className="cl-dialog-backdrop" onPointerDown={onCancel} />
      <div className="cl-dialog">
        <div className="cl-dialog-title">壁を追加</div>

        <label className="cl-dialog-row">
          <span className="cl-dialog-label">参照</span>
          <select value={refId} onChange={handleRefChange}>
            <option value="">（選択してください）</option>
            {allCLs.map(cl => (
              <option key={cl.id} value={cl.id}>
                {cl.label || cl.id}　{cl.centerLineType === 'X' ? '垂直' : '水平'}
              </option>
            ))}
          </select>
        </label>

        <label className="cl-dialog-row">
          <span className="cl-dialog-label">
            {refCL ? refCL.label : '距離'}
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

        {wallDisplay != null && (
          <div className="cl-dialog-result">
            {isRefV ? 'X' : 'Y'} = {wallDisplay} mm
          </div>
        )}

        <div className="cl-dialog-actions">
          <button className="cl-dialog-btn cl-dialog-btn--cancel" onClick={onCancel}>
            キャンセル
          </button>
          <button
            className="cl-dialog-btn cl-dialog-btn--ok"
            disabled={!refCL}
            onClick={() => refCL && onConfirm(refCL, dist)}
          >
            追加
          </button>
        </div>
      </div>

      <NumPad
        value={distStr}
        label="距離"
        onChange={setDistStr}
        onConfirm={() => refCL && onConfirm(refCL, dist)}
        onCancel={onCancel}
      />
    </>
  );
}
