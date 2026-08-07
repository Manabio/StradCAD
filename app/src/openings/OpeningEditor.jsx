import { useRef } from 'react';
import { observer } from 'mobx-react-lite';
import { runInAction } from 'mobx';
import { getFittingOptions, WINDOW_CATALOG, getFixtureSymbols, findCatalogEntry, defaultOpeningHeight, parseSillHeight, OpeningMechanism } from './openingCatalog.js';
import { OpeningCategory } from '../core.js';
import { findHostWall } from './openingGeometry.js';
import { buildOpeningElevation } from './openingElevationFigure.js';
import { AutoScaledFigure } from '../structural/sectionFigure/AutoScaledFigure.jsx';
import {
  beginOpeningFieldUndo, endOpeningFieldUndo, withOpeningUndo, validateOpeningEdit, removeOpeningWithUndo,
} from './openingEdit.js';
import { openingTagOf, fixtureSymbolOf } from './openingNumbering.js';

// 数値入力は絶対値化して確定する（幅・高さ・位置・窓台高さ共通の規約。openingCatalog.js の
// parseSillHeight docstring「幅・位置と同じ変換規約」参照）。height はさらに絶対値化後の0を
// 不正値として未設定(null)に正規化する（graphFbs.js OP.HEIGHT の「0=未設定」規約と統一。
// .claude/opening-model.md参照）。入力欄（numField）・図上のdim編集（onEditDim）の両経路で
// 同じ規約を適用する。
function sanitizeHeightInput(v) {
  const n = Math.abs(v) || 0;
  return n === 0 ? null : n;
}

const FIGURE_FRAME = { maxWidth: 380, maxHeight: 260 };

const labelStyle = { fontSize: 12, color: '#475569', width: 72, flexShrink: 0 };
const rowStyle   = { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 };
const inputStyle = { flex: 1, fontSize: 13, padding: '4px 6px', border: '1px solid #cbd5e1', borderRadius: 4 };

// 建具モードパネル下段: 選択中建具の姿図＋数値編集フォーム。StairPanel.jsx の構成を踏襲。
export const OpeningEditor = observer(function OpeningEditor({ graph, project, opening, mode, onToast }) {
  const beforeWidthRef  = useRef(null);
  const beforeOffsetRef = useRef(null);

  if (!opening) {
    return (
      <div style={{ padding: 16, fontSize: 12, color: '#94a3b8' }}>
        図面上、またはリストから建具を選択してください
      </div>
    );
  }

  const wall = findHostWall(opening, graph);
  const wallKind = wall?.isExteriorWall ? 'exterior' : 'interior';
  const isWindow = opening.category === OpeningCategory.WINDOW;
  const catalog  = isWindow ? WINDOW_CATALOG : getFittingOptions(wallKind);
  const entry    = findCatalogEntry(opening.category, opening.subType);
  const tag      = openingTagOf(opening, project);

  const figure = buildOpeningElevation(opening, { tag, entry });

  // 仕様変更でタグが変わった旨を通知する（renumberOpenings は openingEdit.js の pushOpeningUndo が
  // 前進方向・undo・redo いずれの確定でも呼ぶため、ここでは前後のタグを比較するだけでよい）。
  function notifyIfTagChanged(beforeTag) {
    const afterTag = openingTagOf(opening, project);
    if (beforeTag && afterTag && beforeTag !== afterTag) onToast?.(`${beforeTag} → ${afterTag} に変わりました`);
  }

  const commitEdit = (fn) => {
    const beforeTag = openingTagOf(opening, project);
    withOpeningUndo(graph, project, opening, fn);
    notifyIfTagChanged(beforeTag);
  };

  const onEditDim = (dim, value) => {
    if (!dim.target) return;
    const v = dim.target === 'height' ? sanitizeHeightInput(value) : (Math.abs(value) || 0);
    commitEdit(() => { runInAction(() => { opening[dim.target] = v; }); });
  };

  const onSubTypeChange = (e) => commitEdit(() => {
    const key = e.target.value;
    const en = findCatalogEntry(opening.category, key);
    runInAction(() => {
      opening.subType = key;
      if (en) {
        opening.width  = en.defaultWidth;
        opening.height = defaultOpeningHeight(opening.category, key);
      }
    });
  });

  const onFixtureTypeChange = (e) => commitEdit(() => {
    runInAction(() => { opening.fixtureType = e.target.value; });
  });

  const numField = (field, { allowNull = false, zeroAsNull = false } = {}) => (e) => {
    const v = e.target.value;
    runInAction(() => {
      if (v === '') { opening[field] = allowNull ? null : 0; return; }
      const n = Math.abs(Number(v)) || 0; // 数値入力は絶対値化する（幅・高さ・位置の統一規約）
      opening[field] = (zeroAsNull && n === 0) ? null : n;
    });
  };

  // 窓台高さは parseSillHeight（openingCatalog.js）の変換規約（trim・絶対値化・空欄=null）に
  // 一本化する——numField の素朴な Number() 変換と2本並立させない（NaN混入も防げる）。
  const onSillHeightChange = (e) => {
    runInAction(() => { opening.sillHeight = parseSillHeight(e.target.value, isWindow); });
  };

  const onWidthFocus = () => { beforeWidthRef.current = opening.width; beginOpeningFieldUndo(graph, project, opening); };
  const onWidthBlur = () => {
    const beforeTag = openingTagOf(opening, project);
    const err = validateOpeningEdit(opening, graph, { width: opening.width, refOffset: opening.refOffset });
    if (err) {
      runInAction(() => { opening.width = beforeWidthRef.current; });
      onToast?.(err);
    }
    endOpeningFieldUndo(graph, project, opening);
    if (!err) notifyIfTagChanged(beforeTag);
  };

  const onOffsetFocus = () => { beforeOffsetRef.current = opening.refOffset; beginOpeningFieldUndo(graph, project, opening); };
  const onOffsetBlur = () => {
    const beforeTag = openingTagOf(opening, project);
    const err = validateOpeningEdit(opening, graph, { width: opening.width, refOffset: opening.refOffset });
    if (err) {
      runInAction(() => { opening.refOffset = beforeOffsetRef.current; });
      onToast?.(err);
    }
    endOpeningFieldUndo(graph, project, opening);
    if (!err) notifyIfTagChanged(beforeTag);
  };

  const endFieldWithToast = () => {
    const beforeTag = openingTagOf(opening, project);
    endOpeningFieldUndo(graph, project, opening);
    notifyIfTagChanged(beforeTag);
  };

  const fieldUndoProps = {
    onFocus: () => beginOpeningFieldUndo(graph, project, opening),
    onBlur:  endFieldWithToast,
  };

  return (
    <div style={{ padding: 16, overflowY: 'auto' }}>
      <div style={{ marginBottom: 12, border: '1px solid #e2e8f0', borderRadius: 4, padding: 4, display: 'flex', justifyContent: 'center', overflowX: 'auto' }}>
        <AutoScaledFigure primitives={figure} onEditDim={onEditDim} {...FIGURE_FRAME} />
      </div>

      <div style={rowStyle}>
        <span style={labelStyle}>記号</span>
        <select style={inputStyle} value={fixtureSymbolOf(opening)} onChange={onFixtureTypeChange}>
          {getFixtureSymbols(opening.category).map(f => <option key={f.key} value={f.key}>{f.label}</option>)}
        </select>
      </div>

      <div style={rowStyle}>
        <span style={labelStyle}>種別</span>
        <select style={inputStyle} value={opening.subType} onChange={onSubTypeChange}>
          {catalog.map(o => <option key={o.key} value={o.key}>{o.label}</option>)}
        </select>
      </div>

      <div style={rowStyle}>
        <span style={labelStyle}>幅(mm)</span>
        <input type="number" style={inputStyle} value={opening.width}
          onChange={numField('width')} onFocus={onWidthFocus} onBlur={onWidthBlur} />
      </div>

      <div style={rowStyle}>
        <span style={labelStyle}>高さ(mm)</span>
        <input type="number" style={inputStyle} value={opening.height || ''}
          onChange={numField('height', { allowNull: true, zeroAsNull: true })} {...fieldUndoProps} />
      </div>

      {isWindow && (
        <div style={rowStyle}>
          <span style={labelStyle}>窓台高さ(mm)</span>
          <input type="number" style={inputStyle} value={opening.sillHeight ?? ''}
            onChange={onSillHeightChange} {...fieldUndoProps} />
        </div>
      )}

      <div style={rowStyle}>
        <span style={labelStyle}>位置（{opening.refCL?.label ?? '基準'}から）</span>
        <input type="number" style={inputStyle} value={opening.refOffset}
          onChange={numField('refOffset')} onFocus={onOffsetFocus} onBlur={onOffsetBlur} />
      </div>

      {entry?.mechanism === OpeningMechanism.SWING && (
        <div style={rowStyle}>
          <span style={labelStyle}>開き方</span>
          <button type="button" style={{ marginRight: 8 }}
            onClick={() => commitEdit(() => runInAction(() => { opening.hingeSide = -opening.hingeSide; }))}>
            ヒンジ反転
          </button>
          <button type="button"
            onClick={() => commitEdit(() => runInAction(() => { opening.swingSide = -opening.swingSide; }))}>
            開く方向反転
          </button>
        </div>
      )}

      <button
        onClick={() => { removeOpeningWithUndo(graph, project, opening); mode.selectOpening(null); }}
        style={{
          marginTop: 16, width: '100%', padding: '8px',
          border: '1px solid #fca5a5', background: '#fff', color: '#dc2626',
          borderRadius: 4, cursor: 'pointer', fontSize: 13,
        }}
      >
        この建具を削除
      </button>
    </div>
  );
});
