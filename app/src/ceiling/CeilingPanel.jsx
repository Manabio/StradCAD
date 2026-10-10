import { useState } from 'react';
import { observer } from 'mobx-react-lite';
import { ModePanel } from '../ui/ModePanel.jsx';
import { BottomSheet } from '../ui/BottomSheet.jsx';
import { MaterialSelect } from '../finish/FinishTable.jsx';
import { withFinishUndo } from '../finish/finishUndo.js';
import { markDirty } from '../dirtyState.js';
import { interiorRows, stairRows, selectionSummary, selectionSpanMm, ceilingWriteTargetRoom, ceilingZoneTargetRoom } from './ceilingPanelRows.js';
import { assignZoneShape, clearZoneCells } from './ceilingZones.js';
import { CEILING_SHAPE_OPTIONS, CEILING_BASE_LABEL, CEILING_DIM_FIELDS, parseCeilingZoneDraft, stairCeilingSlopeDefaults } from './ceilingShapeFields.js';

// 天伏モードの専用パネル（仕上げ表とは独立。仕上げ表との共有はデータと純モジュール＋材選択の部品 MaterialSelect だけ）。
// パネルは App から渡る graph prop を使う（mode に graph を持たせない。階切替で古い graph を抱える穴を作らないため）。
// 部屋の無い階段の行（kind==='stair'）は行タップの選択対象外（タップしても selectRoom を呼ばない）。
// ただしキャンバスのドラッグ選択（S2）で選ばれたときは強調する（selectedRoomId === row.id）。
// タブ列の上に選択中のセルの要約を1行出す（selectionSummary）。
// 要約の下に、選択中のセル群の天井材・仕上げの MaterialSelect を2つ出す（S3）。「仕上げは部屋に1つ」なので
// 書込み先は常に部屋の customOverrides（ceilingPanel／ceilingFinish。ceilingWriteTargetRoom が所属から解く）。
// 部屋の無い階段なら disabled の「—」。undo は仕上げ表の master 欄と同じ withFinishUndo（欄単位で1エントリ）。
// 表の天井材・仕上げは読むだけ（略称表示）、CH は読むだけ（区画が効いていれば最小～最大の表記。区画の書込みは下の「区画の高さ」欄）。
// 行の組み立ては ceilingPanelRows.js、区画の組み立ては ceilingZones.js。

const TABS = [
  { id: 'interior', label: '内部' },
  { id: 'stair',    label: '階段' },
];

const COLUMNS = [
  { key: 'name',          label: '部屋名' },
  { key: 'ceilingBoard',  label: '天井材' },
  { key: 'ceilingFinish', label: '仕上げ' },
  { key: 'ch',            label: 'CH' },
];

const cellStyle = { padding: '6px 8px', fontSize: 12, borderBottom: '1px solid #e2e8f0', textAlign: 'left' };

const dash = (v) => (v == null || v === '' ? '—' : v);

// 天井材・仕上げの欄（選択中のセル群の書込み先の部屋へ。空は clearOverride＝既定へ復帰）
const CeilingMaterialFields = observer(({ graph, mode, room }) => {
  const info = room ? room.getFinishInfo() : null;
  const fields = [
    { key: 'ceilingPanel',  label: '天井材', category: 'panel' },
    { key: 'ceilingFinish', label: '仕上げ', category: 'finish' },
  ];
  return (
    <div style={{ display: 'flex', gap: 12, padding: '6px 10px', borderBottom: '1px solid #e2e8f0', background: '#fafafa', flexShrink: 0 }}>
      {fields.map(f => (
        <label key={f.key} style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1, minWidth: 0, fontSize: 12, color: '#374151' }}>
          <span style={{ fontWeight: 700, whiteSpace: 'nowrap' }}>{f.label}：</span>
          {room ? (
            <MaterialSelect
              mode={mode}
              category={f.category}
              value={info[f.key]}
              onChange={v => withFinishUndo(graph, () => (v === '' ? room.clearOverride(f.key) : room.setOverride(f.key, v)))}
              style={{ flex: 1, minWidth: 0 }}
            />
          ) : (
            <select disabled value="" style={{ flex: 1, minWidth: 0 }} title="部屋の無い階段には天井材・仕上げを指定できません">
              <option value="">—</option>
            </select>
          )}
        </label>
      ))}
    </div>
  );
});

// 選択が変わったら入力途中の text を捨てるため、欄を選択の識別子で作り直す
const zoneFieldKey = selection => `${selection.owner.kind}:${selection.owner.id}:${[...selection.cellKeys].sort().join(',')}`;

// 要約の区画表記: 平面は高さ、他は形状名＋基準高（null は部屋のCH）
const zoneSummaryText = z => {
  const h = z.heightMm == null ? '部屋のCH' : `${z.heightMm}mm`;
  return z.shape === 'flat' ? h : `${CEILING_SHAPE_OPTIONS.find(o => o.value === z.shape)?.label ?? z.shape} ${h}`;
};

const DIM_SLOTS = 2; // 寸法欄の数（CEILING_SHAPE_DIM_COUNT の最大。形状が違っても欄を共用する）
const defaultDims = shape => CEILING_DIM_FIELDS[shape].map(f => (f.input === 'select' ? String(f.options[0].value) : ''));

// 下書きの初期値。既存の区画が一様ならその形状・寸法・基準高。区画が無い（none）階段所属で直進系なら階段に沿った傾斜
// （stairCeilingSlopeDefaults。折返し・回り等や算出できないときは null）。それ以外（混在など）は平面＋空（空の基準高＝部屋の CH）
function initialDraft(zone, slopeDefaults) {
  if (zone?.state === 'uniform') {
    return { shape: zone.shape, height: zone.heightMm == null ? '' : String(zone.heightMm), dims: zone.dims.map(String) };
  }
  if (zone?.state === 'none' && slopeDefaults) {
    return { shape: slopeDefaults.shape, height: String(slopeDefaults.heightMm), dims: slopeDefaults.dims.map(String) };
  }
  return { shape: 'flat', height: '', dims: [] };
}

const fieldLabelStyle = { display: 'flex', alignItems: 'center', gap: 4, whiteSpace: 'nowrap' };

// 区画の形状・寸法の欄（S5 の高さ欄を S6a で拡張）。選択中のセル群へ「形状（平面／傾斜）・基準高・寸法1／寸法2」を区画として書く。
// 基準高の意味は形状で変わる（平面＝天井高／傾斜＝低い側／円弧・ドーム＝周縁。空欄＝部屋の CH）。寸法欄は汎用の2欄で、形状ごとにラベルと入力の種類が変わり、使わない欄は disabled。
// 書込み先は所属が部屋ならその部屋、階段なら対の部屋（部屋の無い階段は disabled）。区画の無い直進系の階段は、初期値が階段に沿った傾斜（floorHeight は階高）。
// 下書きは useState（MobX に入れない）。確定は withFinishUndo で1エントリ＋markDirty。部屋の CH 欄（override）には書かない。
// 確定後も選択・下書きは保つ。検証は parseCeilingZoneDraft（エラーは欄の下に1行）。
const CeilingZoneFields = observer(({ graph, selection, zone, floorHeight }) => {
  const [draft, setDraft] = useState(() => {
    const stair = selection.owner.kind === 'stair' ? graph.stairMap.get(selection.owner.id) : null;
    return initialDraft(zone, stair ? stairCeilingSlopeDefaults(graph, stair, selection.cellKeys, floorHeight) : null);
  });
  const [error, setError] = useState('');
  const room = ceilingZoneTargetRoom(graph, selection);
  const disabled = !room;
  const fields = CEILING_DIM_FIELDS[draft.shape];
  const patch = p => { setDraft(d => ({ ...d, ...p })); setError(''); };
  const setDim = (i, v) => patch({ dims: Array.from({ length: DIM_SLOTS }, (_, k) => (k === i ? v : (draft.dims[k] ?? ''))) });
  const commit = () => {
    const result = parseCeilingZoneDraft(draft, { spanMm: selectionSpanMm(graph, selection) });
    if (!result.ok) { setError(result.error); return; }
    setError('');
    withFinishUndo(graph, () => room.setCeilingZones(assignZoneShape(graph, room, selection.cellKeys, result.value)));
    markDirty();
  };
  const clear = () => {
    withFinishUndo(graph, () => room.setCeilingZones(clearZoneCells(graph, room, selection.cellKeys)));
    markDirty();
  };
  const title = disabled ? '部屋の無い階段には天井の区画を指定できません' : undefined;
  const stop = e => { e.stopPropagation(); if (e.key === 'Enter' && !disabled) commit(); };
  return (
    <div style={{ padding: '6px 10px', borderBottom: '1px solid #e2e8f0', background: '#fafafa', flexShrink: 0, fontSize: 12, color: '#374151', display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <label style={fieldLabelStyle}>
          <span style={{ fontWeight: 700 }}>形状：</span>
          <select
            value={draft.shape}
            disabled={disabled}
            title={title}
            onChange={e => patch({ shape: e.target.value, dims: defaultDims(e.target.value) })}
            style={{ fontSize: 12 }}
          >
            {CEILING_SHAPE_OPTIONS.map(o => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </label>
        <label style={fieldLabelStyle}>
          <span style={{ fontWeight: 700 }}>{CEILING_BASE_LABEL[draft.shape]}：</span>
          <input
            type="number"
            value={draft.height}
            disabled={disabled}
            title={title}
            placeholder="部屋のCH"
            onChange={e => patch({ height: e.target.value })}
            onKeyDown={stop}
            style={{ width: 80, fontSize: 12, borderColor: error ? '#dc2626' : undefined }}
          />
          <span>mm</span>
        </label>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        {Array.from({ length: DIM_SLOTS }, (_, i) => {
          const f = fields[i];
          const value = draft.dims[i] ?? '';
          return (
            <label key={i} style={fieldLabelStyle}>
              <span style={{ fontWeight: 700 }}>{f ? `寸法${i + 1}（${f.label}）` : `寸法${i + 1}`}：</span>
              {f && f.input === 'select' ? (
                <select value={value} disabled={disabled} title={title} onChange={e => setDim(i, e.target.value)} style={{ fontSize: 12 }}>
                  {f.options.map(o => <option key={o.value} value={String(o.value)}>{o.label}</option>)}
                </select>
              ) : (
                <input
                  type="number"
                  value={f ? value : ''}
                  disabled={disabled || !f}
                  title={title}
                  placeholder={f ? '' : '—'}
                  onChange={e => setDim(i, e.target.value)}
                  onKeyDown={stop}
                  style={{ width: 80, fontSize: 12, borderColor: error ? '#dc2626' : undefined }}
                />
              )}
              {f?.unit && <span>{f.unit}</span>}
            </label>
          );
        })}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <button onClick={commit} disabled={disabled} title={title} style={{ fontSize: 12 }}>確定</button>
        <button onClick={clear} disabled={disabled || zone?.state === 'none'} title={title} style={{ fontSize: 12 }}>区画を解除</button>
      </div>
      {error && <div style={{ color: '#dc2626' }}>{error}</div>}
    </div>
  );
});

export const CeilingPanel = observer(({ graph, mode, isLandscape, floorHeight }) => {
  const rows = mode.activeTab === 'stair' ? stairRows(graph, mode.materialMap) : interiorRows(graph, mode.materialMap);
  const summary = selectionSummary(graph, mode.selection);
  const inner = (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>
      {summary && (
        <div style={{ padding: '6px 10px', fontSize: 12, color: '#1e3a8a', background: '#eff6ff', borderBottom: '1px solid #e2e8f0', flexShrink: 0 }}>
          選択中: {summary.name}／{summary.cellCount}セル／CH {dash(summary.ch)}
          {summary.zone && summary.zone.state !== 'none' && (
            <>／区画 {summary.zone.state === 'uniform' ? zoneSummaryText(summary.zone) : '混在'}</>
          )}
        </div>
      )}
      {mode.selection && (
        <CeilingMaterialFields graph={graph} mode={mode} room={ceilingWriteTargetRoom(graph, mode.selection)} />
      )}
      {mode.selection && (
        <CeilingZoneFields key={zoneFieldKey(mode.selection)} graph={graph} selection={mode.selection} zone={summary?.zone ?? null} floorHeight={floorHeight ?? null} />
      )}
      <div style={{ display: 'flex', borderBottom: '1px solid #e2e8f0', background: '#f8fafc', flexShrink: 0 }}>
        {TABS.map(tab => (
          <button
            key={tab.id}
            onClick={() => mode.setActiveTab(tab.id)}
            style={{
              padding: '6px 14px',
              fontSize: 12,
              fontWeight: mode.activeTab === tab.id ? 700 : 400,
              color: mode.activeTab === tab.id ? '#2563eb' : '#64748b',
              background: 'none',
              border: 'none',
              borderBottom: mode.activeTab === tab.id ? '2px solid #2563eb' : '2px solid transparent',
              cursor: 'pointer',
              marginBottom: -1,
              whiteSpace: 'nowrap',
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div style={{ overflow: 'auto', flex: 1 }}>
        {rows.length === 0 ? (
          <div style={{ padding: 16, fontSize: 13, color: '#64748b' }}>
            {mode.activeTab === 'stair' ? '階段はありません。' : '部屋はありません。'}
          </div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                {COLUMNS.map(c => (
                  <th key={c.key} style={{ ...cellStyle, fontWeight: 700, color: '#475569', background: '#f8fafc' }}>{c.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map(row => (
                <tr
                  key={row.id}
                  onClick={() => { if (row.kind === 'room') mode.selectRoom(row.id); }}
                  style={{
                    cursor: row.kind === 'room' ? 'pointer' : 'default',
                    background: row.id === mode.selectedRoomId ? '#eff6ff' : '#fff',
                  }}
                >
                  {COLUMNS.map(c => (
                    <td key={c.key} style={cellStyle}>{c.key === 'name' ? row.name : dash(row[c.key])}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
  return isLandscape
    ? <ModePanel title="天伏" raiseSignal={mode.selectedRoomId}>{inner}</ModePanel>
    : <BottomSheet title="天伏" raiseSignal={mode.selectedRoomId}>{inner}</BottomSheet>;
});
