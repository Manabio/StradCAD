import { useState } from 'react';
import { observer } from 'mobx-react-lite';
import { ModePanel } from '../ui/ModePanel.jsx';
import { BottomSheet } from '../ui/BottomSheet.jsx';
import { MaterialSelect } from '../finish/FinishTable.jsx';
import { withFinishUndo } from '../finish/finishUndo.js';
import { markDirty } from '../dirtyState.js';
import { ceilingPanelTree, ceilingPanelLines, selectedNodeId, selectionSpanMm } from './ceilingPanelRows.js';
import { updateZoneSpec, removeZone } from './ceilingZones.js';
import { roomCeilingShapeOf, setRoomCeilingShape, applyRoomCeilingHeightDraft } from './roomCeilingShape.js';
import { roomHasCeiling } from './ceilingOwners.js';
import { roomCeilingHeight } from '../finish/roomMetrics.js';
import { CEILING_SHAPE_OPTIONS, CEILING_BASE_LABEL, CEILING_DIM_FIELDS, parseCeilingZoneDraft } from './ceilingShapeFields.js';

// 天伏モードの専用パネル（仕上げ表とは独立。仕上げ表との共有はデータと純モジュール＋材選択の部品 MaterialSelect だけ）。
// パネルは App から渡る graph prop を使う（mode に graph を持たせない。階切替で古い graph を抱える穴を作らないため）。
// 表は木（S12c）: 1行＝1親部屋、部分指定の子は親の中に入れ子（階段タブは階段が最上位）。列は 部屋名｜天井材｜仕上げ｜CH｜▸（三角は行末。全ノードに出す）。
// ノード id＝群 id（ceilingGroups.js）。行クリックは mode.selectNode（群を選ぶ。タブは切り替えない）、強調は selection の群 id とノード id の一致だけ。
// 並び替えは持たない（仕上げ表の部屋の並び＝graph.rooms の順）。木と平らな行の組み立ては ceilingPanelRows.js（純関数）。このファイルは描くだけ。
// 展開は mode.expandedPath（各段1つだけ＝アコーディオン）。部屋を開くと 形状・天井高の欄（RoomCeilingFields。天井を持たない部屋は「天井なし」）→区画→子の部屋、
// 区画を開くと区画単位の欄（CeilingZoneFields。確定は updateZoneSpec・解除は removeZone）、階段を開くとその階段の区画だけ（階段の残りは天井を持たない。区画はキャンバスで
// 残りを再タップ／ドラッグして作る）。
// 表の各行で天井材・仕上げの MaterialSelect を直接編集する（S10。「仕上げは部屋に1つ」なので入口は行だけ）。
// 書込み先は部屋の customOverrides（ceilingPanel／ceilingFinish。ノードの room＝階段は対の部屋）。
// 部屋の無い階段の行は disabled の「—」。undo は仕上げ表の master 欄と同じ withFinishUndo（欄単位で1エントリ）＋markDirty。
// CH は読むだけ（区画が効いていれば最小～最大の表記。区画の書込みは区画の欄）。

const TABS = [
  { id: 'interior', label: '内部' },
  { id: 'stair',    label: '階段' },
];

// 列幅・罫線・見出し行は仕上げ表（FinishTable.jsx の cellBase／headerCell）に揃える
const COLUMNS = [
  { key: 'name',          label: '部屋名', width: undefined },
  { key: 'ceilingBoard',  label: '天井材', width: '28%' },
  { key: 'ceilingFinish', label: '仕上げ', width: '28%' },
  { key: 'ch',            label: 'CH',     width: 72 },
  { key: 'toggle',        label: '',       width: 28 },
];

const INDENT_PX = 16;

const cellStyle = { border: '1px solid #cbd5e1', padding: '4px 8px', fontSize: 12, whiteSpace: 'nowrap', verticalAlign: 'middle', textAlign: 'left' };
const headerStyle = { ...cellStyle, background: '#f1f5f9', fontWeight: 600, textAlign: 'center', color: '#374151' };

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

// ノードの行（部屋名｜天井材｜仕上げ｜CH｜▸）。区画の行は天井材・仕上げの2列を 形状｜寸法｜セル数 の1つにまとめる。
// 行クリックは群を選ぶ（タブは切り替えない）。三角と select のクリックは行へ伝播させない。三角は行末。
const NodeRow = observer(({ graph, mode, line, selectedId }) => {
  const { node, depth, expanded } = line;
  return (
    <tr
      onClick={() => mode.selectNode(graph, node.id, line.path)}
      style={{ cursor: 'pointer', background: node.id === selectedId ? '#eff6ff' : '#fff' }}
    >
      <td style={{ ...cellStyle, paddingLeft: 8 + depth * INDENT_PX, overflow: 'hidden', textOverflow: 'ellipsis' }}>{node.name}</td>
      {node.type === 'zone' ? (
        <td colSpan={2} style={{ ...cellStyle, overflow: 'hidden', textOverflow: 'ellipsis' }}>{node.summary}</td>
      ) : (
        MATERIAL_FIELDS.map(f => (
          <td key={f.key} onClick={e => e.stopPropagation()} style={cellStyle}>
            <RowMaterialSelect graph={graph} mode={mode} room={node.room} field={f} />
          </td>
        ))
      )}
      <td style={cellStyle}>{dash(node.ch)}</td>
      <td style={{ ...cellStyle, padding: '4px 2px', textAlign: 'center' }}>
        <button
          aria-label={expanded ? '内訳を閉じる' : '内訳を開く'}
          onClick={e => { e.stopPropagation(); mode.toggleNode(depth, node.id); }}
          style={triangleStyle}
        >
          {expanded ? '▾' : '▸'}
        </button>
      </td>
    </tr>
  );
});

// 欄・注記の行（ノードの下に1段深く出す）
const InnerRow = observer(({ depth, children }) => (
  <tr style={{ background: '#f8fafc' }}>
    <td colSpan={COLUMNS.length} style={{ ...cellStyle, padding: 0, whiteSpace: 'normal' }}>
      <div style={{ paddingLeft: depth * INDENT_PX }}>{children}</div>
    </td>
  </tr>
));

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

// 平らな行1本の描画（ceilingPanelLines の出力を種類で振り分けるだけ）。欄の外接幅 spanMm はノードの群のセルから（円弧のライズ上限）
const PanelLine = observer(({ graph, mode, line, selectedId }) => {
  const { node } = line;
  if (line.type === 'note') return <InnerRow depth={line.depth}><div style={fieldsBoxStyle}>{line.text}</div></InnerRow>;
  if (line.type === 'roomFields') {
    const info = node.room.getFinishInfo();
    const key = `${node.room.id}:${info.ceilingHeight}:${info.ceilingShape}:${info.ceilingDims}`;
    return (
      <InnerRow depth={line.depth}>
        <RoomCeilingFields key={key} graph={graph} room={node.room} spanMm={selectionSpanMm(graph, { cellKeys: node.cells })} />
      </InnerRow>
    );
  }
  if (line.type === 'zoneFields') {
    return (
      <InnerRow depth={line.depth}>
        <CeilingZoneFields key={node.zone.id} graph={graph} room={node.room} zone={node.zone} spanMm={selectionSpanMm(graph, { cellKeys: node.cells })} />
      </InnerRow>
    );
  }
  return <NodeRow graph={graph} mode={mode} line={line} selectedId={selectedId} />;
});

export const CeilingPanel = observer(({ graph, mode, isLandscape }) => {
  const tree = ceilingPanelTree(graph, mode.activeTab, mode.materialMap);
  const lines = ceilingPanelLines(tree, mode.expandedPath);
  const selectedId = selectedNodeId(graph, mode.selection); // 群が今は無い選択（undo 後など）は選択なし扱い
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
        {tree.length === 0 ? (
          <div style={{ padding: 16, fontSize: 13, color: '#64748b' }}>
            {mode.activeTab === 'stair' ? '階段はありません。' : '部屋はありません。'}
          </div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed' }}>
            <colgroup>
              {COLUMNS.map(c => <col key={c.key} style={{ width: c.width }} />)}
            </colgroup>
            <thead>
              <tr>
                {COLUMNS.map(c => (
                  <th key={c.key} style={headerStyle}>{c.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {lines.map(line => (
                <PanelLine key={line.key} graph={graph} mode={mode} line={line} selectedId={selectedId} />
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
