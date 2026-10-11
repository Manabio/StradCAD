import { useState } from 'react';
import { observer } from 'mobx-react-lite';
import { ModePanel } from '../ui/ModePanel.jsx';
import { BottomSheet } from '../ui/BottomSheet.jsx';
import { MaterialSelect } from '../finish/FinishTable.jsx';
import { withFinishUndo } from '../finish/finishUndo.js';
import { markDirty } from '../dirtyState.js';
import { interiorRows, stairRows, selectionSummary, selectionSpanMm, selectionGroupInfo, ceilingWriteTargetRoom, rowZoneDetail } from './ceilingPanelRows.js';
import { updateZoneSpec, removeZone } from './ceilingZones.js';
import { roomCeilingShapeOf, setRoomCeilingShape, applyRoomCeilingHeightDraft } from './roomCeilingShape.js';
import { roomHasCeiling } from './ceilingOwners.js';
import { roomCeilingHeight } from '../finish/roomMetrics.js';
import { CEILING_SHAPE_OPTIONS, CEILING_BASE_LABEL, CEILING_DIM_FIELDS, parseCeilingZoneDraft } from './ceilingShapeFields.js';

// 天伏モードの専用パネル（仕上げ表とは独立。仕上げ表との共有はデータと純モジュール＋材選択の部品 MaterialSelect だけ）。
// パネルは App から渡る graph prop を使う（mode に graph を持たせない。階切替で古い graph を抱える穴を作らないため）。
// 部屋の無い階段の行（kind==='stair'）は行タップの選択対象外（タップしても selectRoom を呼ばない）。
// ただしキャンバスのドラッグ選択（S2）で選ばれたときは強調する（selectedRoomId === row.id）。
// 上段は持たない。選択中の群の要約と欄は、選択した部屋の展開した行の中に出す（S11）。選択の単位は群（ceilingGroups.js。S12b）:
// 区画の群は CeilingZoneFields（区画単位。確定は updateZoneSpec・解除は removeZone）、部屋の残りは RoomCeilingFields（部屋の形状・天井高）、
// 階段の残りは案内だけ（区画はキャンバスで残りを再タップ／ドラッグして作る）。
// 表の各行で天井材・仕上げの MaterialSelect を直接編集する（S10。「仕上げは部屋に1つ」なので入口は行だけ）。
// 書込み先は部屋の customOverrides（ceilingPanel／ceilingFinish。ceilingWriteTargetRoom が行の所属から解く。階段行は対の部屋）。
// 部屋の無い階段の行は disabled の「—」。undo は仕上げ表の master 欄と同じ withFinishUndo（欄単位で1エントリ）＋markDirty。
// CH は読むだけ（区画が効いていれば最小～最大の表記。区画の書込みは展開行内の CeilingZoneFields）。
// 選択された行は展開する（mode.expandedRowId。アコーディオン）。三角は常に出し、展開行は 選択ブロック（選択がその行の所属のときだけ）→内訳（zoneDetailRows／remainderRow）。
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

const MATERIAL_FIELDS = [
  { key: 'ceilingPanel',  label: '天井材', category: 'panel' },
  { key: 'ceilingFinish', label: '仕上げ', category: 'finish' },
];

// 行の天井材・仕上げの欄（書込み先の部屋へ。空は clearOverride＝既定へ復帰）。room が null（部屋の無い階段）は disabled の「—」
const RowMaterialSelect = observer(({ graph, mode, room, field }) => {
  if (!room) {
    return (
      <select disabled value="" style={{ width: '100%', minWidth: 0, fontSize: 12 }} title="部屋の無い階段には天井材・仕上げを指定できません">
        <option value="">—</option>
      </select>
    );
  }
  return (
    <MaterialSelect
      mode={mode}
      category={field.category}
      value={room.getFinishInfo()[field.key]}
      onChange={v => { withFinishUndo(graph, () => (v === '' ? room.clearOverride(field.key) : room.setOverride(field.key, v))); markDirty(); }}
      style={{ width: '100%', minWidth: 0, fontSize: 12 }}
    />
  );
});

const triangleStyle = { width: 16, height: 16, padding: 0, border: 'none', background: 'none', cursor: 'pointer', fontSize: 11, lineHeight: '16px', color: '#475569', flexShrink: 0 };

// 展開した行の内訳（読むだけ。編集は同じ展開行内の CeilingZoneFields）
// 部屋行は部屋所属のセル（zoneDetailRows＋残り）、階段行は対の部屋の区画のうちその階段所属のセル（stairZoneDetailRows。残りなし）
const ZoneDetail = observer(({ graph, row }) => {
  const { zones, rest, pairMissing } = rowZoneDetail(graph, row);
  const line = { fontSize: 12, color: '#374151', padding: '2px 0' };
  let empty = null;
  if (pairMissing) empty = '区画なし（対の部屋なし）';
  else if (zones.length === 0 && !rest) empty = row.kind === 'stair' ? '区画なし' : `区画なし（部屋 CH ${dash(row.ch)}）`;
  return (
    <div style={{ padding: '4px 8px 6px 24px' }}>
      {zones.map(z => (
        <div key={z.zoneId} style={line}>
          {z.shapeLabel}｜基準高 {z.heightLabel}{z.dimsLabel && `｜${z.dimsLabel}`}｜{z.cellCount}セル
        </div>
      ))}
      {rest && <div style={line}>残り: 部屋 CH {dash(rest.chLabel)}｜{rest.cellCount}セル</div>}
      {empty && <div style={line}>{empty}</div>}
    </div>
  );
});

// 表の1行（部屋名｜天井材｜仕上げ｜CH）。区画がある部屋は先頭に三角を出し、開くと下に内訳。選択された行は展開される（mode.expandedRowId）
const CeilingRow = observer(({ graph, mode, row }) => {
  const target = ceilingWriteTargetRoom(graph, { owner: { kind: row.kind, id: row.id } });
  const expanded = mode.expandedRowId === row.id;
  const summary = expanded && mode.selection && mode.selection.owner.rowId === row.id ? selectionSummary(graph, mode.selection) : null;
  const groupInfo = summary ? selectionGroupInfo(graph, mode.selection) : null;
  return (
    <>
      <tr
        onClick={() => { if (row.kind === 'room') mode.selectRoom(row.id); }}
        style={{
          cursor: row.kind === 'room' ? 'pointer' : 'default',
          background: row.id === mode.selectedRoomId ? '#eff6ff' : '#fff',
        }}
      >
        <td style={cellStyle}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
            <button
              aria-label={expanded ? '内訳を閉じる' : '内訳を開く'}
              onClick={e => { e.stopPropagation(); mode.toggleExpandedRow(row.id); }}
              style={triangleStyle}
            >
              {expanded ? '▾' : '▸'}
            </button>
            <span>{row.name}</span>
          </div>
        </td>
        {MATERIAL_FIELDS.map(f => (
          <td key={f.key} style={cellStyle}>
            <RowMaterialSelect graph={graph} mode={mode} room={target} field={f} />
          </td>
        ))}
        <td style={cellStyle}>{dash(row.ch)}</td>
      </tr>
      {expanded && (
        <tr style={{ background: '#f1f5f9' }}>
          <td colSpan={COLUMNS.length} style={{ ...cellStyle, padding: 0 }}>
            {summary && (
              <>
                <div style={{ padding: '6px 10px', fontSize: 12, color: '#1e3a8a', background: '#eff6ff', borderBottom: '1px solid #e2e8f0' }}>
                  選択中: {summary.cellCount}セル
                  {summary.zone && summary.zone.state !== 'none' && (
                    <>｜区画 {summary.zone.state === 'uniform' ? zoneSummaryText(summary.zone) : '混在'}</>
                  )}
                </div>
                <GroupFields graph={graph} info={groupInfo} />
              </>
            )}
            <ZoneDetail graph={graph} row={row} />
          </td>
        </tr>
      )}
    </>
  );
});

// 要約の区画表記: 平面は高さ、他は形状名＋基準高（null は部屋のCH）
const zoneSummaryText = z => {
  const h = z.heightMm == null ? '部屋のCH' : `${z.heightMm}mm`;
  return z.shape === 'flat' ? h : `${CEILING_SHAPE_OPTIONS.find(o => o.value === z.shape)?.label ?? z.shape} ${h}`;
};

const DIM_SLOTS = 2; // 寸法欄の数（CEILING_SHAPE_DIM_COUNT の最大。形状が違っても欄を共用する）
const defaultDims = shape => CEILING_DIM_FIELDS[shape].map(f => (f.input === 'select' ? String(f.options[0].value) : ''));

// 下書き（形状・基準高/天井高・寸法）の初期値。区画は区画の値、部屋は部屋の形状と CH の原文
const zoneDraft = zone => ({ shape: zone.shape, height: zone.heightMm == null ? '' : String(zone.heightMm), dims: zone.dims.map(String) });
const roomDraft = room => {
  const { shape, dims } = roomCeilingShapeOf(room);
  return { shape, height: String(room.getFinishInfo().ceilingHeight ?? ''), dims: dims.map(String) };
};

const fieldLabelStyle = { display: 'flex', alignItems: 'center', gap: 4, whiteSpace: 'nowrap' };
const fieldsBoxStyle = { padding: '6px 10px', borderBottom: '1px solid #e2e8f0', background: '#fafafa', flexShrink: 0, fontSize: 12, color: '#374151', display: 'flex', flexDirection: 'column', gap: 6 };

// 形状・基準高(天井高)・寸法1/2 の入力欄（区画と部屋で共用）。基準高の意味は形状で変わる（平面＝天井高／傾斜＝低い側／円弧・ドーム＝周縁）。
// 寸法欄は汎用の2欄で、形状ごとにラベルと入力の種類が変わり、使わない欄は disabled。keydown は伝播させず、Enter で onEnter（確定）。
const ShapeFieldRows = observer(({ draft, patch, error, disabled, title, heightPlaceholder, heightType, onEnter }) => {
  const fields = CEILING_DIM_FIELDS[draft.shape];
  const setDim = (i, v) => patch({ dims: Array.from({ length: DIM_SLOTS }, (_, k) => (k === i ? v : (draft.dims[k] ?? ''))) });
  const stop = e => { e.stopPropagation(); if (e.key === 'Enter' && !disabled) onEnter(); };
  return (
    <>
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
            type={heightType}
            value={draft.height}
            disabled={disabled}
            title={title}
            placeholder={heightPlaceholder}
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
    </>
  );
});

// 区画単位の欄（S12b。ユーザー指定の区画ごとに1つ）。初期値は区画の値、key は zone.id（別の区画を選んだら作り直す）。
// 確定は updateZoneSpec（id・セルを保ち形状・基準高・寸法だけ差し替え。他の区画と統合しない）、解除は removeZone（セルは部屋の残りへ戻る）。
// 検証は parseCeilingZoneDraft（平面で天井高が空欄は弾く。やめるときは解除）。下書きは useState（MobX に入れない）。
// 書込みは withFinishUndo で1エントリ＋markDirty。部屋の CH 欄（override）には書かない。
const CeilingZoneFields = observer(({ graph, room, zone, spanMm }) => {
  const [draft, setDraft] = useState(() => zoneDraft(zone));
  const [error, setError] = useState('');
  const patch = p => { setDraft(d => ({ ...d, ...p })); setError(''); };
  const commit = () => {
    const result = parseCeilingZoneDraft(draft, { spanMm, requireFlatHeight: true });
    if (!result.ok) { setError(result.error); return; }
    setError('');
    withFinishUndo(graph, () => room.setCeilingZones(updateZoneSpec(graph, room, zone.id, result.value)));
    markDirty();
  };
  const clear = () => {
    withFinishUndo(graph, () => room.setCeilingZones(removeZone(graph, room, zone.id)));
    markDirty();
  };
  return (
    <div style={fieldsBoxStyle}>
      <ShapeFieldRows draft={draft} patch={patch} error={error} disabled={false} title={undefined} heightPlaceholder="天井高" heightType="number" onEnter={commit} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <button onClick={commit} style={{ fontSize: 12 }}>確定</button>
        <button onClick={clear} style={{ fontSize: 12 }}>区画を解除</button>
      </div>
      {error && <div style={{ color: '#dc2626' }}>{error}</div>}
    </div>
  );
});

// 部屋の残り（区画に入らなかったセル）の形状・天井高の欄（S12b）。形状・寸法は customOverrides の ceilingShape／ceilingDims（setRoomCeilingShape）、
// 天井高は CH 欄の原文（applyRoomCeilingHeightDraft: 原文不変は触らない・空で clear・正数は数値で set）。空欄の placeholder は継承・既定の mm。
// 円弧の幅は残りの群のセルの外接矩形（spanMm）。確定は withFinishUndo で1エントリ＋markDirty。
const RoomCeilingFields = observer(({ graph, room, spanMm }) => {
  const [draft, setDraft] = useState(() => roomDraft(room));
  const [error, setError] = useState('');
  const original = String(room.getFinishInfo().ceilingHeight ?? '');
  const patch = p => { setDraft(d => ({ ...d, ...p })); setError(''); };
  const commit = () => {
    const result = parseCeilingZoneDraft({ ...draft, height: '' }, { spanMm }); // 形状・寸法だけ検証（天井高は CH の規則で別に判定）
    if (!result.ok) { setError(result.error); return; }
    let accepted = false;
    withFinishUndo(graph, () => {
      accepted = applyRoomCeilingHeightDraft(room, draft.height, original);
      if (accepted) setRoomCeilingShape(room, result.value);
    });
    if (!accepted) { setError('天井高は正の数を入力してください（空欄は既定）'); return; }
    setError('');
    markDirty();
  };
  if (!roomHasCeiling(room)) return <div style={fieldsBoxStyle}>天井なし</div>;
  return (
    <div style={fieldsBoxStyle}>
      <ShapeFieldRows draft={draft} patch={patch} error={error} disabled={false} title={undefined} heightPlaceholder={String(roomCeilingHeight(graph, room).mm)} heightType="text" onEnter={commit} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <button onClick={commit} style={{ fontSize: 12 }}>確定</button>
      </div>
      {error && <div style={{ color: '#dc2626' }}>{error}</div>}
    </div>
  );
});

// 選択中の群の欄（info は selectionGroupInfo。群が今は無い・書込み先の部屋が無いときは何も出さない）
const GroupFields = observer(({ graph, info }) => {
  if (!info) return null;
  const { group, room, zone } = info;
  const spanMm = selectionSpanMm(graph, { cellKeys: group.cells });
  if (group.kind === 'zone') {
    return zone && room ? <CeilingZoneFields key={zone.id} graph={graph} room={room} zone={zone} spanMm={spanMm} /> : null;
  }
  if (group.kind === 'room') {
    const key = `${room?.id}:${room?.getFinishInfo().ceilingHeight}:${room?.getFinishInfo().ceilingShape}:${room?.getFinishInfo().ceilingDims}`;
    return room ? <RoomCeilingFields key={key} graph={graph} room={room} spanMm={spanMm} /> : null;
  }
  return <div style={fieldsBoxStyle}>階段の残りは天井を持ちません。セルを再タップ／ドラッグで区画を作れます</div>;
});

export const CeilingPanel = observer(({ graph, mode, isLandscape }) => {
  const rows = mode.activeTab === 'stair' ? stairRows(graph, mode.materialMap) : interiorRows(graph, mode.materialMap);
  const inner = (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>
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
                <CeilingRow key={row.id} graph={graph} mode={mode} row={row} />
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
