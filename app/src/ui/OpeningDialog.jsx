import { useState } from 'react';
import './AddCLDialog.css';
import { NumPad } from './NumPad.jsx';
import { getFittingOptions, WINDOW_CATALOG, findCatalogEntry, OpeningMechanism } from '../openings/openingCatalog.js';
import { OpeningCategory } from '@core';
import { validateOpeningPlacement } from '../openings/openingGeometry.js';

/**
 * 建具・窓 追加・編集ダイアログ。
 *
 * wall     : ホスト壁（長押しされた壁。編集時は findHostWall で再解決した現在の壁）
 * worldPos : 長押し位置のワールド座標（新規追加時のみ。位置の初期値算出に使う）
 * category : OpeningCategory.FITTING | WINDOW（新規追加時のみ。編集時は existing.category を使う）
 * existing : 編集対象の Opening | null
 * graph    : 配置検証（validateOpeningPlacement）用
 * onConfirm({ refCL, refOffset, width, subType, hingeSide, swingSide })
 */
export function OpeningDialog({ wall, worldPos, category, existing = null, graph, onConfirm, onCancel }) {
  const effCategory = existing ? existing.category : category;
  const isFitting    = effCategory === OpeningCategory.FITTING;

  const [wallKind, setWallKind] = useState(() => (wall?.isExteriorWall ? 'exterior' : 'interior'));

  const catalog = isFitting ? getFittingOptions(wallKind) : WINDOW_CATALOG;

  const [subType, setSubType] = useState(() => existing?.subType ?? catalog[0]?.key ?? '');
  const entry = findCatalogEntry(effCategory, subType) ?? catalog[0] ?? null;

  const [widthStr, setWidthStr] = useState(() => String(existing?.width ?? entry?.defaultWidth ?? 800));

  // 位置: refCL = wall.clStart からの符号付き距離（長押し位置への投影、または既存値）
  const refCL = existing?.refCL ?? wall?.clStart ?? null;
  const [offsetStr, setOffsetStr] = useState(() => {
    if (existing) return String(existing.refOffset);
    if (!wall || !worldPos || !refCL) return '0';
    const along = wall.isVertical ? worldPos.y : worldPos.x;
    return String(Math.round(along - refCL.value));
  });

  const [hingeSide, setHingeSide] = useState(existing?.hingeSide ?? -1);
  const [swingSide, setSwingSide] = useState(existing?.swingSide ?? 1);
  const [focusedField, setFocusedField] = useState('position'); // 'width' | 'position'
  const [error, setError] = useState(null);

  function handleSubTypeChange(e) {
    const key = e.target.value;
    setSubType(key);
    const en = findCatalogEntry(effCategory, key);
    if (en) setWidthStr(String(en.defaultWidth));
  }

  function handleWallKindChange(e) {
    const kind = e.target.value;
    setWallKind(kind);
    const opts = getFittingOptions(kind);
    if (opts.length > 0 && !opts.some(o => o.key === subType)) {
      setSubType(opts[0].key);
      setWidthStr(String(opts[0].defaultWidth));
    }
  }

  const width  = Math.abs(Number(widthStr)) || 0;
  const offset = Number(offsetStr) || 0;

  function handleConfirm() {
    if (!refCL || !entry) return;
    if (wall) {
      const centerCoord = refCL.value + offset;
      const err = validateOpeningPlacement(wall, centerCoord - width / 2, centerCoord + width / 2, graph, existing?.id ?? null);
      if (err) { setError(err); return; }
    }
    onConfirm({ refCL, refOffset: offset, width, subType, hingeSide, swingSide });
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter')  handleConfirm();
    if (e.key === 'Escape') onCancel();
    e.stopPropagation();
  }

  const numpadValue = focusedField === 'width' ? widthStr : offsetStr;
  const numpadLabel = focusedField === 'width' ? '幅' : '位置';
  function handleNumpadChange(v) {
    if (focusedField === 'width') setWidthStr(v); else setOffsetStr(v);
  }

  return (
    <>
      <div className="cl-dialog-backdrop" onPointerDown={onCancel} />
      <div className="cl-dialog">
        <div className="cl-dialog-title">
          {existing ? '開口を編集' : (isFitting ? '建具を追加' : '窓を追加')}
        </div>

        {isFitting && (
          <label className="cl-dialog-row">
            <span className="cl-dialog-label">壁分類</span>
            <label style={{ marginRight: 8 }}>
              <input type="radio" name="wallKind" value="interior" checked={wallKind === 'interior'} onChange={handleWallKindChange} />
              {' '}内壁
            </label>
            <label>
              <input type="radio" name="wallKind" value="exterior" checked={wallKind === 'exterior'} onChange={handleWallKindChange} />
              {' '}外皮
            </label>
          </label>
        )}

        <label className="cl-dialog-row">
          <span className="cl-dialog-label">種別</span>
          <select value={subType} onChange={handleSubTypeChange}>
            {catalog.map(o => <option key={o.key} value={o.key}>{o.label}</option>)}
          </select>
        </label>

        <label className="cl-dialog-row">
          <span className="cl-dialog-label">幅</span>
          <input
            type="text"
            className="cl-dialog-input"
            value={widthStr}
            onFocus={() => setFocusedField('width')}
            onChange={e => setWidthStr(e.target.value)}
            onKeyDown={handleKeyDown}
          />
          <span className="cl-dialog-unit">mm</span>
        </label>

        <label className="cl-dialog-row">
          <span className="cl-dialog-label">位置（{refCL?.label || '基準'}から）</span>
          <input
            type="text"
            className="cl-dialog-input"
            value={offsetStr}
            onFocus={() => setFocusedField('position')}
            onChange={e => setOffsetStr(e.target.value)}
            onKeyDown={handleKeyDown}
            autoFocus
          />
          <span className="cl-dialog-unit">mm</span>
        </label>

        {entry?.mechanism === OpeningMechanism.SWING && (
          <label className="cl-dialog-row">
            <span className="cl-dialog-label">開き方</span>
            <button type="button" className="cl-kind-btn" onClick={() => setHingeSide(s => -s)} style={{ marginRight: 8 }}>
              ヒンジ反転
            </button>
            <button type="button" className="cl-kind-btn" onClick={() => setSwingSide(s => -s)}>
              開く方向反転
            </button>
          </label>
        )}

        {error && <div className="cl-dialog-result" style={{ color: '#dc2626' }}>{error}</div>}

        <div className="cl-dialog-actions">
          <button className="cl-dialog-btn cl-dialog-btn--cancel" onClick={onCancel}>
            キャンセル
          </button>
          <button className="cl-dialog-btn cl-dialog-btn--ok" onClick={handleConfirm} disabled={!refCL || !entry}>
            {existing ? '更新' : '追加'}
          </button>
        </div>
      </div>

      <NumPad
        value={numpadValue}
        label={numpadLabel}
        onChange={handleNumpadChange}
        onConfirm={handleConfirm}
        onCancel={onCancel}
      />
    </>
  );
}
