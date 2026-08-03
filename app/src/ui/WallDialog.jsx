import { useState } from 'react';
import './AddCLDialog.css';
import { NumPad } from './NumPad.jsx';
import { circleRefSymbol, circleRefKindLabel } from './circleRef.js';

/**
 * 壁追加ダイアログ
 *
 * 参照中心線 + 距離（常に正）を指定する。
 * 方向（右/左/上/下）は参照CL と長押し位置の相対位置から自動決定。
 *
 * nearbyCLs      : 長押し位置に近接するCL（ラベルなし含む）。先頭に丸数字で表示。
 * backingMaterials: 選択可能な WallBackingMaterial の配列（省略可）
 * onConfirm(refCL, dist) : dist は常に正の数値
 */
export function WallDialog({ worldPos, allCLs, nearbyCLs = [], backingMaterials = [], onConfirm, onCancel }) {
  const nearbyIds  = new Set(nearbyCLs.map(cl => cl.id));
  const otherCLs   = allCLs.filter(cl => !nearbyIds.has(cl.id));
  const allOptions = [...nearbyCLs, ...otherCLs];

  const nearest = allOptions.length > 0
    ? allOptions.reduce((best, cl) => {
        const dc = cl.centerLineType === 'X'
          ? Math.abs(cl.value - worldPos.x)
          : Math.abs(cl.value - worldPos.y);
        const db = best.centerLineType === 'X'
          ? Math.abs(best.value - worldPos.x)
          : Math.abs(best.value - worldPos.y);
        return dc < db ? cl : best;
      })
    : null;

  const [refId,       setRefId]       = useState(nearest?.id ?? '');
  const [distStr,     setDistStr]     = useState(() => {
    if (!nearest) return '0';
    const c = nearest.centerLineType === 'X' ? worldPos.x : worldPos.y;
    return String(Math.round(Math.abs(c - nearest.value)));
  });
  const defaultMatId = backingMaterials.length > 0 ? backingMaterials[0].id : '';
  const [backingMatId,  setBackingMatId]  = useState(defaultMatId);
  const [positioning,   setPositioning]   = useState('center');
  const [finishThickStr, setFinishThickStr] = useState('12');

  const selectedMat = backingMaterials.find(m => m.id === backingMatId) ?? null;

  function applyBackingDistance(mat, pos, thick) {
    if (!mat) return;
    const thickNum = Math.abs(Number(thick) || 0);
    if (pos === 'center') {
      setDistStr(String(Math.round(mat.y / 2 + thickNum)));
    }
    // eccentric: offsetFromCL は未定のため自動入力しない
  }

  function handleBackingMatChange(e) {
    const id  = e.target.value;
    setBackingMatId(id);
    const mat = backingMaterials.find(m => m.id === id) ?? null;
    applyBackingDistance(mat, positioning, finishThickStr);
  }

  function handlePositioningChange(e) {
    const pos = e.target.value;
    setPositioning(pos);
    applyBackingDistance(selectedMat, pos, finishThickStr);
  }

  function handleFinishThickChange(e) {
    setFinishThickStr(e.target.value);
    applyBackingDistance(selectedMat, positioning, e.target.value);
  }

  const refCL  = allOptions.find(cl => cl.id === refId) ?? null;
  const isRefV = refCL?.centerLineType === 'X';
  const coord  = isRefV ? worldPos.x : worldPos.y;
  const dir    = refCL ? (coord >= refCL.value ? 1 : -1) : null;
  const dirLabel = dir == null ? null
    : isRefV ? (dir > 0 ? '右→' : '←左') : (dir > 0 ? '↓下' : '上↑');

  const dist        = Math.abs(Number(distStr) || 0);
  const wallCoord   = refCL != null ? refCL.value + dir * dist : null;
  const sign        = isRefV ? 1 : -1;
  const wallDisplay = wallCoord != null ? Math.round(sign * wallCoord) : null;

  function handleRefChange(e) {
    const id = e.target.value;
    setRefId(id);
    const cl = allOptions.find(c => c.id === id);
    if (cl) {
      if (selectedMat) {
        applyBackingDistance(selectedMat, positioning, finishThickStr);
      } else {
        const c = cl.centerLineType === 'X' ? worldPos.x : worldPos.y;
        setDistStr(String(Math.round(Math.abs(c - cl.value))));
      }
    }
  }

  function handleConfirm() {
    if (!refCL) return;
    onConfirm(refCL, dist);
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter' && refCL) handleConfirm();
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
            {nearbyCLs.length > 0 && (
              <optgroup label="近接する中心線">
                {nearbyCLs.map((cl, i) => (
                  <option key={cl.id} value={cl.id}>
                    {circleRefSymbol(i)} {circleRefKindLabel(cl)}{'　'}{cl.centerLineType === 'X' ? '垂直' : '水平'}
                  </option>
                ))}
              </optgroup>
            )}
            {otherCLs.length > 0 && (
              <optgroup label="グリッドCL">
                {otherCLs.map(cl => (
                  <option key={cl.id} value={cl.id}>
                    {cl.label || cl.id}{'　'}{cl.centerLineType === 'X' ? '垂直' : '水平'}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
        </label>

        {backingMaterials.length > 0 && (
          <>
            <label className="cl-dialog-row">
              <span className="cl-dialog-label">下地材</span>
              <select value={backingMatId} onChange={handleBackingMatChange}>
                <option value="">（なし）</option>
                {backingMaterials.map(m => (
                  <option key={m.id} value={m.id}>
                    {m.name}{'　'}{m.x}×{m.y}
                  </option>
                ))}
              </select>
            </label>
            {selectedMat && (
              <label className="cl-dialog-row">
                <span className="cl-dialog-label">配置</span>
                <label style={{ marginRight: 8 }}>
                  <input type="radio" name="positioning" value="center"    checked={positioning === 'center'}    onChange={handlePositioningChange} />
                  {' '}中心
                </label>
                <label>
                  <input type="radio" name="positioning" value="eccentric" checked={positioning === 'eccentric'} onChange={handlePositioningChange} />
                  {' '}偏芯
                </label>
              </label>
            )}
            {selectedMat && positioning === 'center' && (
              <label className="cl-dialog-row">
                <span className="cl-dialog-label">仕上厚</span>
                <input
                  type="number"
                  className="cl-dialog-input"
                  value={finishThickStr}
                  min="0"
                  onChange={handleFinishThickChange}
                  onKeyDown={handleKeyDown}
                />
                <span className="cl-dialog-unit">mm</span>
              </label>
            )}
          </>
        )}

        <label className="cl-dialog-row">
          <span className="cl-dialog-label">
            {refCL ? circleRefKindLabel(refCL) : '距離'}
          </span>
          {dirLabel && <span className="cl-dialog-dir">{dirLabel}</span>}
          <input
            type="number"
            className="cl-dialog-input"
            value={distStr}
            min="0"
            onChange={e => setDistStr(e.target.value)}
            onKeyDown={handleKeyDown}
            autoFocus={backingMaterials.length === 0}
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
            onClick={handleConfirm}
          >
            追加
          </button>
        </div>
      </div>

      <NumPad
        value={distStr}
        label="距離"
        onChange={setDistStr}
        onConfirm={handleConfirm}
        onCancel={onCancel}
      />
    </>
  );
}
