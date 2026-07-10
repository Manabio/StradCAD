import { observer } from 'mobx-react-lite';
import { StructuralMaterialType, StairType } from '@core';
import { computeStairDimensions, floorHeightAbove } from './stairDimensions.js';
import { roomBounds } from '../gridCells.js';
import { measureStairSpans } from './stairClassify.js';
import { stairFigurePrimitives } from './stairFigure.js';
import { defaultSections } from './stairGeometry.js';
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
export const StairEditor = observer(({ stair, graph, project, onDelete }) => {
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
    ? annotatedFigure(scale => stairFigurePrimitives(stair, b, { riser, scale, spans }), STAIR_FIGURE_FRAME)
    : null;

  // 数値入力はキーストローク単位でなくフォーカス〜ブラーで1 undo エントリに集約する
  const num = (field) => (e) => {
    const v = e.target.value;
    stair.setField(field, v === '' ? (field === 'riser' ? null : 0) : Number(v));
  };
  const fieldUndoProps = {
    onFocus: () => beginFieldUndo(graph),
    onBlur:  () => endFieldUndo(graph),
  };

  const onTypeChange = (e) => withFinishUndo(graph, () => {
    const t = e.target.value;
    stair.setField('type', t);
    // 切替先タイプと区間数が合わないsections（未初期化・直進[1区間]↔踊り場付[3区間]等）は既定値で組み直す
    const expected = defaultSections({ type: t, totalSteps: stair.totalSteps });
    if (HAS_SECTIONS.has(t) && (!stair.sections || stair.sections.length !== expected?.length)) {
      stair.setField('sections', expected);
    }
  });
  // 図中編集：踏面寸・区間踏面数の寸法をクリック→NumPad 確定でフィールドへ反映（パネル入力は撤去済み）。
  // 区間の入力値は踏面数（マス数）。内部の sections は実段数のため、
  // 直進部（偶数index）は +1（実段数=踏面数+1）、踊場・周回部（奇数index）はそのまま換算する。
  const onEditDim = (dim, value) => withFinishUndo(graph, () => {
    if (dim.target === 'sections') {
      const arr = [...(stair.sections ?? defaultSections(stair))];
      arr[dim.index] = Math.max(1, dim.index % 2 === 0 ? value + 1 : value);
      stair.setField('sections', arr);
    } else if (dim.target) {
      stair.setField(dim.target, value);
    }
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
          <select style={inputStyle} value={stair.structure} onChange={e => withFinishUndo(graph, () => stair.setField('structure', e.target.value))}>
            {STRUCTURE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
        <div style={rowStyle}>
          <span style={labelStyle}>昇り方向</span>
          <select style={inputStyle} value={stair.upDirection} onChange={e => withFinishUndo(graph, () => stair.setField('upDirection', e.target.value))}>
            {DIRECTION_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
        <div style={rowStyle}>
          <span style={labelStyle}>反転</span>
          <input type="checkbox" checked={stair.flip} onChange={e => withFinishUndo(graph, () => stair.setField('flip', e.target.checked))} />
        </div>

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
            borderRadius: 4, cursor: 'pointer', fontSize: 13,
          }}
        >
          階段を削除
        </button>
    </div>
  );
});
