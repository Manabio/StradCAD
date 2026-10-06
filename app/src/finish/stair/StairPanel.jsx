import { observer } from 'mobx-react-lite';
import { StructuralMaterialType, StairType, StairPortSide } from '@core';
import { computeStairDimensions, floorHeightAbove } from './stairDimensions.js';
import { roomBounds } from '../gridCells.js';
import { measureStairSpans } from './stairClassify.js';
import { stairFigurePrimitives } from './stairFigure.js';
import { portSpansOf, portZone, resolveStairPorts, portSideValue, stairPortCandidates } from './stairPorts.js';
import { applySectionDimEdit, sectionsForType, sameSections, portSideChange, resetPortSides, alignPortTurnSteps } from './stairSectionEdit.js';
import { resetUnderStairSplit } from './stairUnderSplit.js';
import { AutoScaledFigure } from '../../structural/sectionFigure/AutoScaledFigure.jsx';
import { annotatedFigure } from '../../structural/sectionFigure/sectionGeometry.js';
import { withFinishUndo, beginFieldUndo, endFieldUndo } from '../finishUndo.js';

const STAIR_FIGURE_FRAME = { maxWidth: 280, maxHeight: 220 };

// 実装済みのタイプのみ選択肢に出す（未実装タイプは順次追加）
const TYPE_OPTIONS = [
  { value: StairType.STRAIGHT,         label: '直進階段' },
  { value: StairType.STRAIGHT_LANDING, label: '踊り場付直進階段' },
  { value: StairType.SWITCHBACK,       label: '屈折階段（折り返し）' },
  { value: StairType.WINDING,          label: '回り階段' },
  { value: StairType.L_TURN,           label: '矩折階段（L字）' },
  { value: StairType.FLARED,           label: '曲がり階段' },
  { value: StairType.OPEN_WELL,        label: '中空き階段' },
];

// セル選択で判定されたタイプと相互に切替可能なタイプのグループ。
// 選択肢はこのグループ内に限定する（中空きは単独＝切替先なし）。
const TYPE_GROUPS = [
  [StairType.STRAIGHT, StairType.STRAIGHT_LANDING],
  [StairType.SWITCHBACK, StairType.WINDING],
  [StairType.L_TURN, StairType.FLARED],
  [StairType.OPEN_WELL],
];

// 指定タイプが属するグループの選択肢だけを返す。
function typeOptionsFor(type) {
  const group = TYPE_GROUPS.find(g => g.includes(type));
  if (!group) return TYPE_OPTIONS;
  return TYPE_OPTIONS.filter(o => group.includes(o.value));
}

// 区間別・段数（sections配列）を持つタイプ。図中の寸法クリックで stair.sections[index] を編集する。
const HAS_SECTIONS = new Set([
  StairType.STRAIGHT, StairType.STRAIGHT_LANDING, StairType.SWITCHBACK, StairType.WINDING,
  StairType.L_TURN, StairType.FLARED, StairType.OPEN_WELL,
]);

const STRUCTURE_OPTIONS = [
  { value: StructuralMaterialType.WOOD,  label: '木造' },
  { value: StructuralMaterialType.STEEL, label: '鉄骨' },
];

// 折返し・回り階段の出入口の辺（候補が2つ以上あるときだけ表示。左右はその口を歩く向きから見る）
const PORT_SIDE_LABELS = {
  [StairPortSide.END]:   '走行端',
  [StairPortSide.LEFT]:  '左（上りから見て）',
  [StairPortSide.RIGHT]: '右（上りから見て）',
};
const U_TURN_TYPES = new Set([StairType.SWITCHBACK, StairType.WINDING]);

const DIRECTION_OPTIONS = [
  { value: 'up',    label: '上(↑)' },
  { value: 'down',  label: '下(↓)' },
  { value: 'left',  label: '左(←)' },
  { value: 'right', label: '右(→)' },
];

const labelStyle ={ fontSize: 12, color: '#475569', width: 64, flexShrink: 0 };
const rowStyle   = { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 };
const inputStyle = { flex: 1, fontSize: 13, padding: '4px 6px', border: '1px solid #cbd5e1', borderRadius: 4 };

// 階段パラメータ編集の中身（仕上げパレットの「階段」タブ内に配置）。
// どの階の階段も自分の階で削除できる（削除ボタンは常に有効）。
export const StairEditor = observer(({ stair, graph, project, upperGraph = null, onDelete }) => {
  if (!stair) return null;

  const floorHeight = floorHeightAbove(project, project?.activePlane);
  const dims = computeStairDimensions(stair, { floorHeight });

  // 選択中セルの包絡矩形を bounds に、選択セル状態に即した形状・向きで模式図を描く。
  // annotatedFigure（一般解）で形状基準の縮尺を決め、注記の隙間を px 一定にする。
  const b = graph ? roomBounds(stair.cells, graph) : null;
  const validB = b && [b.x1, b.y1, b.x2, b.y2].every(Number.isFinite) && b.x2 > b.x1 && b.y2 > b.y1;
  const riser = stair.riser ?? (floorHeight != null ? floorHeight / Math.max(1, stair.totalSteps) : null);
  const spans = validB ? measureStairSpans(stair, graph) : null; // セル実測の区間長（区間長指定の反映）
  const figure = validB
    ? annotatedFigure(scale => stairFigurePrimitives(stair, b, { riser, scale, spans, graph }), STAIR_FIGURE_FRAME)
    : null;
  // 出入口の辺（折返し・回り階段。stairGeometry.js と同じ解決）と、選べる候補（床のある部屋に面する辺だけ。
  // 上り口は自階、到達口は上階の床で確かめる。上階が読めなければ幾何だけで絞り、注記を出す）
  const portInfo = validB && U_TURN_TYPES.has(stair.type) ? portSpansOf(spans) : null;
  const ports = portInfo ? resolveStairPorts(stair, portInfo) : null;
  const portRows = ports ? ['entry', 'arrival'].map(port => {
    const cands = stairPortCandidates(stair, graph, port, { floorGraph: port === 'entry' ? graph : upperGraph });
    const current = portSideValue(stair, port, ports);
    const sides = cands.sides.includes(current) ? cands.sides : [...cands.sides, current];
    return { port, label: port === 'entry' ? '上り口' : '到達口', current, sides, floorChecked: cands.floorChecked };
  }) : [];
  const applyFields = (fields) => { for (const [k, v] of Object.entries(fields)) stair.setField(k, v); };
  // 出入口の切替: 走行端へ戻すと取りつき回転部は 0、側面へ切り替えると初期蹴上数を入れる。総蹴上数は保つ
  // （直進部が 2 段未満になる切替は何もしない。stairSectionEdit.js）
  const onPortSideChange = (port) => (e) => withFinishUndo(graph, () => {
    const fields = portSideChange(stair, port, e.target.value, portZone(portInfo, port).zoneLen);
    if (!fields) return;
    applyFields(fields);
    afterEdit();
  });

  // 直進階段の編集時は階段下の分割セル指定を元に戻す（stairUnderSplit.js。
  // 分割CL自体は現仕様＝破れ線位置 FL+1600 へ同期され、STRAIGHT のままなら指定経路は
  // 維持される）。蹴上は編集後の値で解決し直す（render 時の riser は編集前のため）。
  // 出入口が走行端なのに取りつき蹴上が残る状態は 0 にそろえる（編集で解決が変わりうるため）。
  const afterEdit = () => {
    if (!graph) return;
    if (U_TURN_TYPES.has(stair.type)) {
      const info = portSpansOf(measureStairSpans(stair, graph));
      if (info) applyFields(alignPortTurnSteps(stair, resolveStairPorts(stair, info)));
    }
    const r = stair.riser ?? (floorHeight != null ? floorHeight / Math.max(1, stair.totalSteps) : null);
    resetUnderStairSplit(stair, graph, r);
  };

  // 数値入力はキーストローク単位でなくフォーカス〜ブラーで1 undo エントリに集約する
  const num = (field) => (e) => {
    const v = e.target.value;
    stair.setField(field, v === '' ? (field === 'riser' ? null : 0) : Number(v));
    afterEdit();
  };
  const fieldUndoProps = {
    onFocus: () => beginFieldUndo(graph),
    onBlur:  () => endFieldUndo(graph),
  };

  const onTypeChange = (e) => withFinishUndo(graph, () => {
    const t = e.target.value;
    stair.setField('type', t);
    // 切替先タイプと区間数が合わないsections（未初期化・直進[1区間]↔踊り場付[3区間]等）は既定値で
    // 組み直し、折返し⇄回りの切替では回転部の段数を型に揃える（stairSectionEdit.js）。
    if (HAS_SECTIONS.has(t)) {
      const next = sectionsForType(t, stair);
      if (next && !sameSections(next, stair.sections)) stair.setField('sections', next);
    }
    afterEdit();
  });
  // 図中編集：踏面寸・区間踏面数の寸法をクリック→NumPad 確定でフィールドへ反映（パネル入力は撤去済み）。
  // 区間の入力値は踏面数（回転部は段数 R）。sections（実段数）への換算と、R による
  // 折返し⇄回りのタイプ導出は stairSectionEdit.js に一本化。
  const onEditDim = (dim, value) => withFinishUndo(graph, () => {
    if (dim.target === 'sections') {
      const { sections, type } = applySectionDimEdit(stair, dim.index, value);
      stair.setField('sections', sections);
      if (type !== stair.type) stair.setField('type', type);
    } else if (dim.target) {
      stair.setField(dim.target, value);
    }
    afterEdit();
  });

  return (
    <div style={{ padding: 16, overflowY: 'auto' }}>
        <div style={{ fontSize: 12, color: '#64748b', marginBottom: 12 }}>
          {floorHeight != null ? `階高 ${Math.round(floorHeight)}mm` : '階高 未確定'}
        </div>

        {figure && (
          <div style={{ marginBottom: 12, border: '1px solid #e2e8f0', borderRadius: 4, padding: 4, display: 'flex', justifyContent: 'center', overflowX: 'auto' }}>
            <AutoScaledFigure primitives={figure.primitives} scale={figure.scale} onEditDim={onEditDim} {...STAIR_FIGURE_FRAME} />
          </div>
        )}

        <div style={rowStyle}>
          <span style={labelStyle}>タイプ</span>
          <select style={inputStyle} value={stair.type} onChange={onTypeChange}>
            {typeOptionsFor(stair.type).map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>

        {/* 区間別の踏面数は図中の寸法クリックで編集（パネル入力は撤去）。総段数は総マス数+1の派生値。 */}
        <div style={rowStyle}>
          <span style={labelStyle}>段数</span>
          <input
            type="number" style={inputStyle} value={stair.totalSteps}
            disabled={HAS_SECTIONS.has(stair.type)}
            onChange={num('totalSteps')} {...fieldUndoProps}
          />
        </div>
        <div style={rowStyle}>
          <span style={labelStyle}>蹴上(mm)</span>
          <input
            type="number" style={inputStyle}
            placeholder={dims.riser != null ? `自動 ${Math.round(dims.riser)}` : '自動'}
            value={stair.riser ?? ''} onChange={num('riser')} {...fieldUndoProps}
          />
        </div>
        <div style={rowStyle}>
          <span style={labelStyle}>蹴込(mm)</span>
          <input type="number" style={inputStyle} value={stair.nosing} onChange={num('nosing')} {...fieldUndoProps} />
        </div>
        <div style={rowStyle}>
          <span style={labelStyle}>幅(mm)</span>
          <input type="number" style={inputStyle} value={stair.width} onChange={num('width')} {...fieldUndoProps} />
        </div>
        <div style={rowStyle}>
          <span style={labelStyle}>構造</span>
          <select style={inputStyle} value={stair.structure} onChange={e => withFinishUndo(graph, () => { stair.setField('structure', e.target.value); afterEdit(); })}>
            {STRUCTURE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
        <div style={rowStyle}>
          <span style={labelStyle}>昇り方向</span>
          <select style={inputStyle} value={stair.upDirection} onChange={e => withFinishUndo(graph, () => { stair.setField('upDirection', e.target.value); applyFields(resetPortSides(stair)); afterEdit(); })}>
            {DIRECTION_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
        <div style={rowStyle}>
          <span style={labelStyle}>反転</span>
          <input type="checkbox" checked={stair.flip} onChange={e => withFinishUndo(graph, () => { stair.setField('flip', e.target.checked); applyFields(resetPortSides(stair)); afterEdit(); })} />
        </div>
        {portRows.filter(r => r.sides.length > 1).map(r => (
          <div key={r.port} style={{ marginBottom: 8 }}>
            <div style={{ ...rowStyle, marginBottom: 0 }}>
              <span style={labelStyle}>{r.label}</span>
              <select style={inputStyle} value={r.current} onChange={onPortSideChange(r.port)}>
                {r.sides.map(v => <option key={v} value={v}>{PORT_SIDE_LABELS[v]}</option>)}
              </select>
            </div>
            {!r.floorChecked && <div style={{ fontSize: 11, color: '#64748b', marginLeft: 72 }}>上階の床は未確認</div>}
          </div>
        ))}

        {dims.warnings.length > 0 && (
          <div style={{ marginTop: 8, padding: 8, background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 4 }}>
            {dims.warnings.map((w, i) => (
              <div key={i} style={{ fontSize: 12, color: '#b91c1c' }}>⚠ {w}</div>
            ))}
          </div>
        )}

        <button
          onClick={() => onDelete && onDelete(stair.id)}
          style={{
            marginTop: 16, width: '100%', padding: '8px',
            border: '1px solid #fca5a5', background: '#fff', color: '#dc2626',
            borderRadius: 4, fontSize: 13, cursor: 'pointer',
          }}
        >
          階段を削除
        </button>
    </div>
  );
});
