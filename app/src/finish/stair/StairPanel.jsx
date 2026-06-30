import { observer } from 'mobx-react-lite';
import { StructuralMaterialType, StairType } from '@core';
import { ModePanel } from '../../ui/ModePanel.jsx';
import { computeStairDimensions, floorHeightAbove } from './stairDimensions.js';

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

// タイプ別の段構成入力フィールド（[key, ラベル]）
const SEGMENT_FIELDS = {
  [StairType.STRAIGHT_LANDING]: [['first', '最初の段'], ['landing', '踊り場(段相当)'], ['straight', '直進部段']],
  [StairType.SWITCHBACK]:       [['straight', '片側段数']],
  [StairType.WINDING]:          [['straight', '直進部段数'], ['landing', '回り段数']],
  [StairType.L_TURN]:           [['first', '最初の段数'], ['straight', '直進部段数']],
  [StairType.FLARED]:           [['first', '最初の段数'], ['landing', '曲がり段数'], ['straight', '直進部段数']],
  [StairType.OPEN_WELL]:        [['straight', '各直進部段数']],
};

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

export const StairPanel = observer(({ stair, project, onDelete, onClose }) => {
  if (!stair) return null;

  const floorHeight = floorHeightAbove(project, project?.activePlane);
  const dims = computeStairDimensions(stair, { floorHeight });

  const num = (field) => (e) => {
    const v = e.target.value;
    stair.setField(field, v === '' ? (field === 'riser' ? null : 0) : Number(v));
  };

  const segFields = SEGMENT_FIELDS[stair.type] ?? [];
  const seg = stair.segments ?? {
    first: Math.floor(stair.totalSteps / 2),
    landing: 4,
    straight: stair.totalSteps - Math.floor(stair.totalSteps / 2),
  };
  const setSeg = (key) => (e) => {
    const v = e.target.value === '' ? 0 : Number(e.target.value);
    stair.setField('segments', { ...seg, [key]: v });
  };
  const onTypeChange = (e) => {
    const t = e.target.value;
    stair.setField('type', t);
    // 段構成タイプへ切替時に未初期化なら既定値を設定
    if (SEGMENT_FIELDS[t] && !stair.segments) stair.setField('segments', { ...seg });
  };

  return (
    <ModePanel title="階段" width={320} onClose={onClose}>
      <div style={{ padding: 16, overflowY: 'auto' }}>
        <div style={{ fontSize: 12, color: '#64748b', marginBottom: 12 }}>
          {floorHeight != null ? `階高 ${Math.round(floorHeight)}mm` : '階高 未確定'}
        </div>

        <div style={rowStyle}>
          <span style={labelStyle}>タイプ</span>
          <select style={inputStyle} value={stair.type} onChange={onTypeChange}>
            {TYPE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>

        {segFields.map(([key, lbl]) => (
          <div style={rowStyle} key={key}>
            <span style={labelStyle}>{lbl}</span>
            <input type="number" style={inputStyle} value={seg[key] ?? 0} onChange={setSeg(key)} />
          </div>
        ))}

        <div style={rowStyle}>
          <span style={labelStyle}>段数</span>
          <input type="number" style={inputStyle} value={stair.totalSteps} onChange={num('totalSteps')} />
        </div>
        <div style={rowStyle}>
          <span style={labelStyle}>踏面(mm)</span>
          <input type="number" style={inputStyle} value={stair.tread} onChange={num('tread')} />
        </div>
        <div style={rowStyle}>
          <span style={labelStyle}>蹴上(mm)</span>
          <input
            type="number" style={inputStyle}
            placeholder={dims.riser != null ? `自動 ${Math.round(dims.riser)}` : '自動'}
            value={stair.riser ?? ''} onChange={num('riser')}
          />
        </div>
        <div style={rowStyle}>
          <span style={labelStyle}>蹴込(mm)</span>
          <input type="number" style={inputStyle} value={stair.nosing} onChange={num('nosing')} />
        </div>
        <div style={rowStyle}>
          <span style={labelStyle}>幅(mm)</span>
          <input type="number" style={inputStyle} value={stair.width} onChange={num('width')} />
        </div>
        <div style={rowStyle}>
          <span style={labelStyle}>構造</span>
          <select style={inputStyle} value={stair.structure} onChange={e => stair.setField('structure', e.target.value)}>
            {STRUCTURE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
        <div style={rowStyle}>
          <span style={labelStyle}>昇り方向</span>
          <select style={inputStyle} value={stair.upDirection} onChange={e => stair.setField('upDirection', e.target.value)}>
            {DIRECTION_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
        <div style={rowStyle}>
          <span style={labelStyle}>反転</span>
          <input type="checkbox" checked={stair.flip} onChange={e => stair.setField('flip', e.target.checked)} />
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
    </ModePanel>
  );
});
