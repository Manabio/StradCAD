// 外部タブの屋根（下屋＝RoofGroup・主屋根＝MainRoofGroup）の群の中身。フォーム1行（形状・［高い側］・［棟木の向き］・勾配・軒の出・妻側の出）＋表に固定2行
// （「屋根」行: 仕上げ＝屋根仕上げ／下地＝防水シート・野地板の選択欄／備考、「軒裏」行: 仕上げ＝軒裏）。
// 見出し「屋根」と削除ボタンは FinishTable.jsx 側（群の枠）が持つ。判断（選択肢・実効の形状・入力の検証）は
// roofDefaults.js／roofInput.js の純関数に置き、ここは描くだけ。確定は mode.setRoofField／setMainRoofField（1確定＝undo 1エントリ）。
// 文字・数値の欄は draft 方式（blur／Enter で確定。不正な数値は確定せず元の値へ戻す）。
import { observer } from 'mobx-react-lite';
import { useState } from 'react';
import { ROOF_SHEATHING_CODES, ROOF_UNDERLAYMENT_CODES } from '@core';
import { resolveRoofShape, roofRoomBounds } from './roofDefaults.js';
import { resolveMainRoofShape, mainRoofHighSideView, mainRoofRidgeDirectionView } from './mainRoof.js';
import { roofHighSideViewOfRoom, roofRidgeDirectionViewOfRoom } from './roofOrientation.js';
import {
  roofShapeOptions, roofHighSideOptions, roofRidgeDirectionOptions, roofRidgeDirectionFromSelect,
  roofMaterialOptions, parseRoofSlopeInput, parseRoofOverhangInput,
} from './roofInput.js';

// 文字列の欄（屋根仕上げ・軒裏・備考）。blur／Enter で確定する（既存の CardNameInput・ExteriorPartHeading と
// 同じ流儀。Escape の専用処理は持たない）。
const RoofTextInput = observer(({ value, onCommit, style }) => {
  const [draft, setDraft] = useState(null);
  const commit = () => {
    if (draft !== null) onCommit(draft);
    setDraft(null);
  };
  return (
    <input
      value={draft ?? value}
      onChange={e => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={e => {
        if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); e.currentTarget.blur(); }
      }}
      onClick={e => e.stopPropagation()}
      style={style}
    />
  );
});

// 数値の欄（勾配・出幅）。parse が null を返す入力は確定せず、blur で元の値へ戻す。
const RoofNumberInput = observer(({ value, parse, onCommit, style }) => {
  const [draft, setDraft] = useState(null);
  const commit = () => {
    if (draft !== null) {
      const n = parse(draft);
      if (n !== null) onCommit(n);
    }
    setDraft(null);
  };
  return (
    <input
      type="text"
      inputMode="decimal"
      value={draft ?? String(value)}
      onChange={e => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={e => {
        if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); e.currentTarget.blur(); }
      }}
      onClick={e => e.stopPropagation()}
      style={style}
    />
  );
});

const formLabelStyle = { fontSize: 12, color: '#374151', whiteSpace: 'nowrap' };

/**
 * 下屋（屋根セルの群）。項目の描画は RoofSpecFields（主屋根と共通）。確定は mode.setRoofField。
 * @param {{ room: object, graph: object, mode: object, styles: { cellBase: object, headerCell: object, cellInputStyle: object } }} props
 *   styles は FinishTable.jsx の既存の表のスタイル（群の見た目をそろえるため受け取る）。
 */
export const RoofGroup = observer(({ room, graph, mode, styles }) => {
  const spec = room.roofSpec;
  if (!spec) return null; // I1 により屋根の部屋には必ずある。復元の途中などで一瞬無いときは何も出さない
  const set = (field, value) => mode.setRoofField(room.id, field, value);
  const shape = resolveRoofShape(spec, { boundsList: roofRoomBounds(room, graph) });
  const highSide = roofHighSideViewOfRoom(room, graph);
  const ridgeDirection = roofRidgeDirectionViewOfRoom(room, graph);
  return <RoofSpecFields spec={spec} shape={shape} highSide={highSide} ridgeDirection={ridgeDirection} set={set} mode={mode} styles={styles} />;
});

/**
 * 主屋根（最上階とその検討案の外部タブ先頭の固定の群）。範囲は最上階の建物範囲、形状の既定は主構造のルール
 * （resolveMainRoofShape）。項目の描画は RoofSpecFields（下屋と共通）。確定は mode.setMainRoofField。
 * @param {{ graph: object, mode: object, styles: { cellBase: object, headerCell: object, cellInputStyle: object } }} props
 */
export const MainRoofGroup = observer(({ graph, mode, styles }) => {
  const spec = graph.mainRoofSpec;
  const set = (field, value) => mode.setMainRoofField(field, value);
  const shape = resolveMainRoofShape(graph, mode.project);
  const highSide = mainRoofHighSideView(graph, mode.project);
  const ridgeDirection = mainRoofRidgeDirectionView(graph, mode.project);
  return <RoofSpecFields spec={spec} shape={shape} highSide={highSide} ridgeDirection={ridgeDirection} set={set} mode={mode} styles={styles} />;
});

/**
 * 屋根の項目のフォーム1行＋固定2行の表（下屋・主屋根で共通）。spec＝表示する RoofSpec、shape＝形状の実効値
 * （呼び出し側が範囲・主構造から導く）、highSide＝「高い側」欄の表示判断 { visible, value }（呼び出し側が導く。
 * visible のときだけ形状の直後に選択欄を出す）、ridgeDirection＝「棟木の向き」欄の表示判断 { visible, value }（同。切妻のときだけ
 * visible。value は明示値、自動は null）、set＝項目の確定関数 (field, value)。
 */
const RoofSpecFields = observer(({ spec, shape, highSide, ridgeDirection, set, mode, styles }) => {
  const { cellBase, headerCell, cellInputStyle } = styles;
  const boxed = { ...cellInputStyle, border: '1px solid #cbd5e1', padding: '2px 4px' };
  const nameOf = code => mode.getMaterial(code)?.name;
  const materialSelect = (field, codes) => (
    <select
      value={spec[field]}
      onChange={e => set(field, e.target.value)}
      onClick={e => e.stopPropagation()}
      style={{ ...cellInputStyle, cursor: 'pointer' }}
    >
      {roofMaterialOptions(codes, spec[field], nameOf).map(o => (
        <option key={o.value} value={o.value}>{o.label}</option>
      ))}
    </select>
  );

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 6, marginBottom: 6 }}>
        <span style={{ ...formLabelStyle, fontWeight: 700 }}>形状</span>
        <select
          value={shape}
          onChange={e => set('shape', e.target.value)}
          onClick={e => e.stopPropagation()}
          style={{ ...boxed, width: 'auto' }}
        >
          {roofShapeOptions().map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        {highSide.visible && <span style={formLabelStyle}>高い側</span>}
        {highSide.visible && (
          <select
            value={highSide.value}
            onChange={e => set('highSide', e.target.value)}
            onClick={e => e.stopPropagation()}
            style={{ ...boxed, width: 'auto' }}
          >
            {roofHighSideOptions().map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        )}
        {ridgeDirection.visible && <span style={formLabelStyle}>棟木の向き</span>}
        {ridgeDirection.visible && (
          <select
            value={ridgeDirection.value ?? ''}
            onChange={e => set('ridgeDirection', roofRidgeDirectionFromSelect(e.target.value))}
            onClick={e => e.stopPropagation()}
            style={{ ...boxed, width: 'auto' }}
          >
            {roofRidgeDirectionOptions().map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        )}
        <span style={formLabelStyle}>勾配</span>
        <RoofNumberInput value={spec.slope} parse={parseRoofSlopeInput} onCommit={n => set('slope', n)}
          style={{ ...boxed, width: 40, minWidth: 0 }} />
        <span style={formLabelStyle}>/10</span>
        <span style={formLabelStyle}>軒の出</span>
        <RoofNumberInput value={spec.eaveOverhangMm} parse={parseRoofOverhangInput} onCommit={n => set('eaveOverhangMm', n)}
          style={{ ...boxed, width: 56, minWidth: 0 }} />
        <span style={formLabelStyle}>mm</span>
        <span style={formLabelStyle}>妻側の出</span>
        <RoofNumberInput value={spec.gableOverhangMm} parse={parseRoofOverhangInput} onCommit={n => set('gableOverhangMm', n)}
          style={{ ...boxed, width: 56, minWidth: 0 }} />
        <span style={formLabelStyle}>mm</span>
      </div>
      <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 12 }}>
        <thead>
          <tr>
            <th style={{ ...headerCell, minWidth: 80 }}>部位</th>
            <th style={{ ...headerCell, minWidth: 120 }}>仕上げ</th>
            <th style={{ ...headerCell, minWidth: 120 }}>下地</th>
            <th style={{ ...headerCell, minWidth: 80 }}>備考</th>
          </tr>
        </thead>
        <tbody>
          <tr style={{ background: '#fff' }}>
            <td style={cellBase}>屋根</td>
            <td style={cellBase}>
              <RoofTextInput value={spec.roofFinish} onCommit={v => set('roofFinish', v)} style={cellInputStyle} />
            </td>
            <td style={cellBase}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <span style={{ ...formLabelStyle, color: '#64748b' }}>防水シート</span>
                  {materialSelect('underlaymentMaterial', ROOF_UNDERLAYMENT_CODES)}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <span style={{ ...formLabelStyle, color: '#64748b' }}>野地板</span>
                  {materialSelect('sheathingMaterial', ROOF_SHEATHING_CODES)}
                </div>
              </div>
            </td>
            <td style={cellBase}>
              <RoofTextInput value={spec.note} onCommit={v => set('note', v)} style={cellInputStyle} />
            </td>
          </tr>
          <tr style={{ background: '#fff' }}>
            <td style={cellBase}>軒裏</td>
            <td style={cellBase}>
              <RoofTextInput value={spec.soffit} onCommit={v => set('soffit', v)} style={cellInputStyle} />
            </td>
            <td style={cellBase} />
            <td style={cellBase} />
          </tr>
        </tbody>
      </table>
    </div>
  );
});
