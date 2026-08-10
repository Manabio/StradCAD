import { useRef } from 'react';
import { observer } from 'mobx-react-lite';
import { runInAction } from 'mobx';
import { getFittingOptions, WINDOW_CATALOG, getFixtureSymbols, findCatalogEntry, defaultOpeningHeight, OpeningMechanism } from './openingCatalog.js';
import { OpeningCategory } from '../core.js';
import { findHostWall, maxOpeningWidthAt, findOpeningsOnWall } from './openingGeometry.js';
import { ERR_OPENING_OUT_OF_WALL, ERR_OPENING_OVERLAP } from '../error.js';
import { buildOpeningElevation } from './openingElevationFigure.js';
import { openingMountLocation } from './openingRoomLabel.js';
import { AutoScaledFigure } from '../structural/sectionFigure/AutoScaledFigure.jsx';
import {
  beginOpeningFieldUndo, endOpeningFieldUndo, withOpeningUndo, validateOpeningEdit, removeOpeningWithUndo,
  materialGlassAfterFixtureChange,
} from './openingEdit.js';
import { openingTagOf, fixtureSymbolOf } from './openingNumbering.js';

// 数値入力は絶対値化して確定する（幅・高さ・位置・窓台高さ共通の規約。図上のdim編集（onEditDim）・
// numField の両方で使う）。height/handleHeight はさらに絶対値化後の0を不正値として未設定(null)に
// 正規化する（graphFbs.js OP.HEIGHT/OP.HANDLE_H の「0=未設定」規約と統一。.claude/opening-model.md参照）。
// 幅・高さ・窓台高さ・レバーハンドル高さはフォームの数値入力欄を持たず、onEditDim（図上クリック編集）のみで編集する。
function sanitizeHeightInput(v) {
  const n = Math.abs(v) || 0;
  return n === 0 ? null : n;
}

const FIGURE_FRAME = { maxWidth: 380, maxHeight: 260 };

const labelStyle = { fontSize: 12, color: '#475569', width: 72, flexShrink: 0 };
const rowStyle   = { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 };
const inputStyle = { flex: 1, fontSize: 13, padding: '4px 6px', border: '1px solid #cbd5e1', borderRadius: 4 };
const readonlyStyle = { ...inputStyle, background: '#f1f5f9', color: '#475569' };

// 建具モードパネル下段: 選択中建具の姿図＋建具表フォーム。StairPanel.jsx の構成を踏襲。
// 幅・高さ・窓台高さは姿図中のクリック編集寸法（onEditDim）に一本化し、フォームには置かない。
export const OpeningEditor = observer(function OpeningEditor({ graph, project, opening, mode, onToast }) {
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
  const mountLocation = openingMountLocation(opening, graph);

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
    let v = (dim.target === 'height' || dim.target === 'handleHeight')
      ? sanitizeHeightInput(value) : (Math.abs(value) || 0);
    // 幅編集は「丸められるときは丸める／そもそも置けないときは弾く」の二段構え（壁が引けない
    // とき=findHostWallがnullのときは従来どおり幾何検証をスキップしてそのまま確定）。
    // maxOpeningWidthAt自体が既にMath.floorで整数化して返すため、ここで重ねて丸めない
    // （CL偏芯ドラッグ中でもクランプ後の値・トースト文言に半端な小数mmが出ない）。
    if (dim.target === 'width' && wall) {
      const centerCoord = opening.refCL.effectiveValue + opening.refOffset;
      const maxWidth = maxOpeningWidthAt(wall, centerCoord, graph, opening.id);
      if (maxWidth <= 0) {
        // 上限0の真因が「壁自体に収まらない」か「隣接開口(自分以外)で埋まっている」かで
        // トースト文言を分ける（openingEdit.js placeOpeningWithDefaults と同じ判定規約）。
        const hasOtherOpenings = findOpeningsOnWall(wall, graph).some(o => o.id !== opening.id);
        onToast?.(hasOtherOpenings ? ERR_OPENING_OVERLAP : ERR_OPENING_OUT_OF_WALL);
        return; // 代入しない＝undoエントリも積まない
      }
      if (v > maxWidth) {
        v = maxWidth;
        onToast?.(`間口の上限 ${maxWidth}mm に丸めました`);
      }
    }
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
    const oldSymbol = fixtureSymbolOf(opening);
    const newSymbol = e.target.value;
    runInAction(() => {
      opening.fixtureType = newSymbol;
      // 材料・ガラスが旧記号の初期値のままなら新記号の初期値へ差し替える（編集済みの値は維持）。
      opening.materialGlass = materialGlassAfterFixtureChange(opening.materialGlass, oldSymbol, newSymbol);
    });
  });

  const numField = (field, { allowNull = false, zeroAsNull = false } = {}) => (e) => {
    const v = e.target.value;
    runInAction(() => {
      if (v === '') { opening[field] = allowNull ? null : 0; return; }
      const n = Math.abs(Number(v)) || 0; // 数値入力は絶対値化する（幅・高さ・位置の統一規約）
      opening[field] = (zeroAsNull && n === 0) ? null : n;
    });
  };

  // 自由入力（テキスト）欄: 空欄・空白のみはnull（未入力）に正規化し、保存値もtrimで統一する
  // （前後空白の有無だけで枝番のバリアントが割れてしまうのを防ぐ）。
  const textField = (field) => (e) => {
    const t = e.target.value.trim();
    runInAction(() => { opening[field] = t === '' ? null : t; });
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
      <div style={{ marginBottom: 12, border: '1px solid #e2e8f0', borderRadius: 4, padding: 4, position: 'relative', display: 'flex', justifyContent: 'center', overflowX: 'auto' }}>
        <AutoScaledFigure primitives={figure} onEditDim={onEditDim} {...FIGURE_FRAME} />
        {entry?.mechanism === OpeningMechanism.SWING && (
          <div style={{ position: 'absolute', top: 4, right: 4, display: 'flex', gap: 4 }}>
            <button type="button" style={{ fontSize: 11, padding: '2px 6px' }}
              onClick={() => commitEdit(() => runInAction(() => { opening.hingeSide = -opening.hingeSide; }))}>
              吊元反転
            </button>
            <button type="button" style={{ fontSize: 11, padding: '2px 6px' }}
              onClick={() => commitEdit(() => runInAction(() => { opening.swingSide = -opening.swingSide; }))}>
              開く方向反転
            </button>
          </div>
        )}
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
        <span style={labelStyle}>取付箇所</span>
        <input type="text" readOnly style={readonlyStyle} value={mountLocation} />
      </div>

      <div style={rowStyle}>
        <span style={labelStyle}>仕上</span>
        <input type="text" style={inputStyle} value={opening.finish ?? ''}
          onChange={textField('finish')} {...fieldUndoProps} />
      </div>

      <div style={rowStyle}>
        <span style={labelStyle}>材料・ガラス</span>
        <input type="text" style={inputStyle} value={opening.materialGlass ?? ''}
          onChange={textField('materialGlass')} {...fieldUndoProps} />
      </div>

      <div style={rowStyle}>
        <span style={labelStyle}>見込み(mm)</span>
        <input type="number" style={inputStyle} value={opening.frameDepth || ''}
          onChange={numField('frameDepth', { allowNull: true, zeroAsNull: true })} {...fieldUndoProps} />
      </div>

      <div style={rowStyle}>
        <span style={labelStyle}>金物</span>
        <input type="text" style={inputStyle} value={opening.hardware ?? ''}
          onChange={textField('hardware')} {...fieldUndoProps} />
      </div>

      <div style={rowStyle}>
        <span style={labelStyle}>備考</span>
        <input type="text" style={inputStyle} value={opening.note ?? ''}
          onChange={textField('note')} {...fieldUndoProps} />
      </div>

      <div style={rowStyle}>
        <span style={labelStyle}>位置（{opening.refCL?.label ?? '基準'}から）</span>
        <input type="number" style={inputStyle} value={opening.refOffset}
          onChange={numField('refOffset')} onFocus={onOffsetFocus} onBlur={onOffsetBlur} />
      </div>

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
