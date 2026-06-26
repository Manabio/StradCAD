import { observer } from 'mobx-react-lite';
import { useState } from 'react';
import { ConfirmDialog } from '../ui/ConfirmDialog.jsx';

// ---- 内部仕上げ表 ----

// kind  : 'text'（自由文字列・room.finish）/ 'material'（材ドロップダウン・内装マスター管理）/ 'number'（数値・内装マスター管理）
// source: 'finish'（room.finish）/ 'master'（room.getFinishInfo() + setOverride）
const INTERIOR_FIELDS = [
  { key: 'floorMaterial',     label: '仕上げ',   group: '床',   groupSpan: 1, kind: 'text',   source: 'finish' },
  { key: 'baseboardMaterial', label: '仕上げ',   group: '巾木', groupSpan: 2, kind: 'text',   source: 'finish' },
  { key: 'baseboardHeight',   label: 'H',        group: null,   groupSpan: 0, kind: 'text',   source: 'finish' },
  { key: 'wallMaterial',      label: '壁材',     group: '壁',   groupSpan: 4, kind: 'material', category: 'panel',  source: 'master' },
  { key: 'wallFinish',        label: '壁仕上げ', group: null,   groupSpan: 0, kind: 'material', category: 'finish', source: 'master' },
  { key: 'dadoMaterial',      label: '腰仕上げ', group: null,   groupSpan: 0, kind: 'text',   source: 'finish' },
  { key: 'dadoHeight',        label: '腰H',      group: null,   groupSpan: 0, kind: 'text',   source: 'finish' },
  { key: 'ceilingMaterial',   label: '仕上げ',   group: '天井', groupSpan: 3, kind: 'text',   source: 'finish' },
  { key: 'ceilingHeight',     label: 'H',        group: null,   groupSpan: 0, kind: 'number', source: 'master' },
  { key: 'cornice',           label: '周り縁',   group: null,   groupSpan: 0, kind: 'text',   source: 'finish' },
  { key: 'note',              label: '備考',     group: '備考', groupSpan: 1, kind: 'text',   source: 'finish' },
];

const FIELD_BY_KEY = Object.fromEntries(INTERIOR_FIELDS.map(f => [f.key, f]));

// 部屋カード内のフィールドラベル（テーブルの「グループ+列見出し」を1つの見出しに合成したもの）
const CARD_FIELD_LABELS = {
  floorMaterial:     '床仕上げ',
  baseboardMaterial: '巾木',
  baseboardHeight:   '巾木 H',
  wallMaterial:      '壁材',
  wallFinish:        '壁仕上げ',
  dadoMaterial:      '腰仕上げ',
  dadoHeight:        '腰 H',
  ceilingMaterial:   '天井',
  ceilingHeight:     '天井高',
  cornice:           '廻り縁',
};

// 部屋カードのセクション構成（モックアップのレイアウトに合わせた固定定義。INTERIOR_FIELDS自体は変更しない）
const CARD_SECTIONS = [
  { title: '床・巾木', rows: [
    ['floorMaterial', 'baseboardMaterial'],
    [null, 'baseboardHeight'],
  ] },
  { title: '壁・腰', rows: [
    ['wallMaterial', 'dadoMaterial'],
    ['wallFinish', 'dadoHeight'],
  ] },
  { title: '天井・廻り縁', rows: [
    ['ceilingMaterial', 'cornice'],
    ['__bbox_placeholder', 'ceilingHeight'],
  ] },
];

// セル内入力の共通スタイル
const cellInputStyle = {
  width: '100%',
  minWidth: 60,
  border: 'none',
  outline: 'none',
  background: 'transparent',
  fontSize: 12,
  padding: 0,
};

const cellBase = {
  border: '1px solid #cbd5e1',
  padding: '4px 8px',
  fontSize: 12,
  whiteSpace: 'nowrap',
  verticalAlign: 'middle',
};

const headerCell = {
  ...cellBase,
  background: '#f1f5f9',
  fontWeight: 600,
  textAlign: 'center',
  color: '#374151',
};

// ---- 部屋カード（内部タブ）の共通スタイル ----

const cardContainerStyle = {
  border: '1px solid #e2e8f0',
  borderRadius: 6,
  margin: '6px 8px',
  background: '#fff',
  overflow: 'hidden',
};

const cardHeaderStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '8px 10px',
  cursor: 'pointer',
  userSelect: 'none',
};

const cardBodyStyle = {
  padding: '4px 12px 10px',
  borderTop: '1px solid #e2e8f0',
};

const sectionTitleStyle = {
  fontSize: 12,
  fontWeight: 700,
  color: '#374151',
  margin: '10px 0 4px',
};

const cardRowStyle = {
  display: 'flex',
  gap: 12,
  marginBottom: 4,
};

const cardFieldStyle = {
  flex: 1,
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  minWidth: 0,
};

const cardLabelStyle = {
  fontSize: 12,
  color: '#64748b',
  whiteSpace: 'nowrap',
  flexShrink: 0,
};

const cardInputWrapStyle = {
  flex: 1,
  minWidth: 0,
  border: '1px solid #e2e8f0',
  borderRadius: 4,
  padding: '2px 6px',
  background: '#f8fafc',
};

const deleteButtonStyle = {
  fontSize: 12,
  color: '#dc2626',
  background: 'none',
  border: '1px solid #fca5a5',
  borderRadius: 4,
  padding: '4px 12px',
  cursor: 'pointer',
};

// ---- タブ定義 ----

const TABS = [
  { id: 'interior',  label: '内部' },
  { id: 'exterior',  label: '外部' },
  { id: 'fittings',  label: '外部建具' },
  { id: 'structure', label: '構造' },
  { id: 'common',    label: '共通仕様' },
];

const TAB_TO_CATEGORY = {
  exterior:  'exteriorRows',
  fittings:  'exteriorFittingRows',
  structure: 'structureRows',
};

// ================================================================
// 共通: 材ドロップダウン / per-floor 設定行
// ================================================================

// 材選択ドロップダウン（カテゴリで材マスタをフィルタ。値は材コード）
const MaterialSelect = observer(({ mode, category, value, onChange, style }) => {
  const materials = mode?.getMaterialsByCategory(category) ?? [];
  return (
    <select
      value={value ?? ''}
      onChange={e => onChange(e.target.value)}
      onClick={e => e.stopPropagation()}
      style={{ ...cellInputStyle, cursor: 'pointer', ...style }}
    >
      <option value="">（未選択）</option>
      {materials.map(m => (
        <option key={m.code} value={m.code}>{m.name}</option>
      ))}
    </select>
  );
});

// 表の上に1行表示する per-floor 設定行（内壁 / 外壁下地）
const PerFloorRow = observer(({ label, mode, category, value, onChange }) => (
  <div style={{
    display: 'flex', alignItems: 'center', gap: 8,
    padding: '6px 12px', borderBottom: '1px solid #e2e8f0',
    background: '#fafafa', flexShrink: 0,
  }}>
    <span style={{ fontSize: 12, fontWeight: 700, color: '#374151', whiteSpace: 'nowrap' }}>{label}：</span>
    <MaterialSelect mode={mode} category={category} value={value} onChange={onChange}
      style={{ flex: 1, minWidth: 120 }} />
  </div>
));

// ================================================================
// CommonSpecTable — 共通仕様タブ（下地材のフロア共通設定）
// ================================================================

// 「内外壁」は内部的に graph.exteriorWallBacking と同じ設定を指す（独立フィールドは持たない）。
// 外壁下地の値を変更すると本行の表示も連動して追従する。
const CommonSpecTable = observer(({ graph, mode }) => (
  <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>
    <div style={{ overflowY: 'auto', flex: 1 }}>
      <PerFloorRow label="内壁下地" mode={mode} category="backing"
        value={graph.interiorWallBacking} onChange={code => graph.setInteriorWallBacking(code)} />
      <PerFloorRow label="内外壁" mode={mode} category="backing"
        value={graph.exteriorWallBacking} onChange={code => graph.setExteriorWallBacking(code)} />
      <PerFloorRow label="外壁下地" mode={mode} category="backing"
        value={graph.exteriorWallBacking} onChange={code => graph.setExteriorWallBacking(code)} />
      <PerFloorRow label="天井" mode={mode} category="backing"
        value={graph.ceilingBacking} onChange={code => graph.setCeilingBacking(code)} />
      <PerFloorRow label="床" mode={mode} category="backing"
        value={graph.floorBacking} onChange={code => graph.setFloorBacking(code)} />
    </div>
  </div>
));

// ================================================================
// FinishTable — タブ付きメイン
// ================================================================

export const FinishTable = observer(({ graph, mode, selectedRoomId, onSelectRoom, floorName }) => {
  const [activeTab, setActiveTab] = useState('interior');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>
      {/* タブバー */}
      <div style={{
        display: 'flex',
        borderBottom: '1px solid #e2e8f0',
        background: '#f8fafc',
        flexShrink: 0,
      }}>
        {TABS.map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            style={{
              padding: '6px 14px',
              fontSize: 12,
              fontWeight: activeTab === tab.id ? 700 : 400,
              color: activeTab === tab.id ? '#2563eb' : '#64748b',
              background: 'none',
              border: 'none',
              borderBottom: activeTab === tab.id ? '2px solid #2563eb' : '2px solid transparent',
              cursor: 'pointer',
              marginBottom: -1,
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* タブコンテンツ */}
      {activeTab === 'interior'
        ? <InteriorTable
            graph={graph}
            mode={mode}
            selectedRoomId={selectedRoomId}
            onSelectRoom={onSelectRoom}
            floorName={floorName}
          />
        : activeTab === 'common'
        ? <CommonSpecTable graph={graph} mode={mode} />
        : <ExteriorTable
            graph={graph}
            category={TAB_TO_CATEGORY[activeTab]}
          />
      }
    </div>
  );
});

// ================================================================
// InteriorTable — 部屋ごとの内部仕上げ（既存テーブル）
// ================================================================

const InteriorTable = observer(({ graph, mode, selectedRoomId, onSelectRoom, floorName }) => {
  const rooms = graph.rooms;

  const [dragId, setDragId]             = useState(null);
  const [overIndex, setOverIndex]       = useState(null);
  const [deleteConfirm, setDeleteConfirm] = useState(null); // { roomId, roomName } | null

  function handleDragStart(e, roomId) {
    setDragId(roomId);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', roomId);
  }

  function handleDragOver(e, idx) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setOverIndex(idx);
  }

  function handleDrop(e, dropIndex) {
    e.preventDefault();
    if (dragId === null) return;
    const currentOrder = graph.roomOrder.slice();
    const fromIndex = currentOrder.indexOf(dragId);
    if (fromIndex === -1 || fromIndex === dropIndex) {
      setDragId(null);
      setOverIndex(null);
      return;
    }
    currentOrder.splice(fromIndex, 1);
    const adjusted = fromIndex < dropIndex ? dropIndex - 1 : dropIndex;
    currentOrder.splice(adjusted, 0, dragId);
    graph.reorderRooms(currentOrder);
    setDragId(null);
    setOverIndex(null);
  }

  function handleDragEnd() {
    setDragId(null);
    setOverIndex(null);
  }

  // 展開中のカードを再クリックしたら折りたたむ（選択解除）
  function handleToggle(roomId) {
    onSelectRoom(roomId === selectedRoomId ? null : roomId);
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>
      {/* 内壁（面材選択肢・このフロア共通） */}
      <PerFloorRow
        label="内壁"
        mode={mode}
        category="panel"
        value={graph.interiorWallPanel}
        onChange={code => graph.setInteriorWallPanel(code)}
      />
      {floorName && (
        <div style={{ padding: '8px 12px 0', fontSize: 12, fontWeight: 700, color: '#64748b', flexShrink: 0 }}>
          {floorName}
        </div>
      )}
      <div style={{ overflowY: 'auto', flex: 1 }}>
        {rooms.length === 0 && (
          <div style={{ textAlign: 'center', color: '#94a3b8', padding: 20, fontSize: 12 }}>
            部屋が登録されていません
          </div>
        )}
        {rooms.map((room, idx) => (
          <RoomCard
            key={room.id}
            room={room}
            mode={mode}
            isExpanded={room.id === selectedRoomId}
            isDragging={room.id === dragId}
            isOver={overIndex === idx}
            onToggle={() => handleToggle(room.id)}
            onDragStart={e => handleDragStart(e, room.id)}
            onDragOver={e => handleDragOver(e, idx)}
            onDrop={e => handleDrop(e, idx)}
            onDragEnd={handleDragEnd}
            onRequestDelete={(roomId, roomName) => setDeleteConfirm({ roomId, roomName })}
          />
        ))}
        {rooms.length > 0 && (
          <div
            style={{ height: 8, borderTop: overIndex === rooms.length ? '2px solid #2563eb' : 'none' }}
            onDragOver={e => handleDragOver(e, rooms.length)}
            onDrop={e => handleDrop(e, rooms.length)}
          />
        )}
      </div>
      {deleteConfirm && (
        <ConfirmDialog
          message={`「${deleteConfirm.roomName || '（名称未設定）'}」を削除しますか？`}
          buttons={[
            { label: 'キャンセル', value: 'cancel' },
            { label: '削除', value: 'ok', danger: true },
          ]}
          onSelect={value => {
            if (value === 'ok') mode.deleteRoom(deleteConfirm.roomId);
            setDeleteConfirm(null);
          }}
        />
      )}
    </div>
  );
});

// 部屋1件分のカード。折りたたみ時はヘッダのみ、展開時はセクション群を表示する。
const RoomCard = observer(({ room, mode, isExpanded, isDragging, isOver,
  onToggle, onDragStart, onDragOver, onDrop, onDragEnd, onRequestDelete }) => (
  <div
    style={{
      ...cardContainerStyle,
      opacity: isDragging ? 0.4 : 1,
      borderTop: isOver ? '2px solid #2563eb' : cardContainerStyle.border,
      outline: isExpanded ? '2px solid #2563eb' : 'none',
      outlineOffset: -2,
    }}
    onDragOver={onDragOver}
    onDrop={onDrop}
  >
    <div style={cardHeaderStyle} onClick={onToggle}>
      <span
        draggable
        style={{ cursor: 'grab', color: '#94a3b8' }}
        onClick={e => e.stopPropagation()}
        onDragStart={e => { e.stopPropagation(); onDragStart(e); }}
        onDragEnd={onDragEnd}
      >
        ⠿
      </span>
      <span style={{ flex: 1, fontSize: 13, fontWeight: 700, color: '#1e293b' }}>
        {room.name || '（名称未設定）'}
      </span>
      <span style={{ color: '#94a3b8', fontSize: 11 }}>{isExpanded ? '▼' : '◀'}</span>
    </div>
    {isExpanded && (
      <div style={cardBodyStyle}>
        {CARD_SECTIONS.map(section => (
          <div key={section.title}>
            <div style={sectionTitleStyle}>【 {section.title} 】</div>
            {section.rows.map((row, i) => (
              <FieldRow key={i} leftKey={row[0]} rightKey={row[1]} room={room} mode={mode} />
            ))}
          </div>
        ))}
        <div style={sectionTitleStyle}>【 その他 】 +</div>
        <div style={{ borderTop: '1px solid #e2e8f0', margin: '10px 0 8px' }} />
        <div style={{ fontSize: 12, color: '#64748b', marginBottom: 2 }}>備考</div>
        <div style={cardInputWrapStyle}>
          <FinishCell room={room} field={FIELD_BY_KEY.note} mode={mode} />
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 10 }}>
          <button onClick={() => onRequestDelete(room.id, room.name)} style={deleteButtonStyle}>
            🗑️ 削除
          </button>
        </div>
      </div>
    )}
  </div>
));

// セクション内の1行（左右2列。leftKey/rightKeyはINTERIOR_FIELDSのキー、nullなら空セル）
const FieldRow = observer(({ leftKey, rightKey, room, mode }) => (
  <div style={cardRowStyle}>
    <FieldCell fieldKey={leftKey} room={room} mode={mode} />
    <FieldCell fieldKey={rightKey} room={room} mode={mode} />
  </div>
));

// '__bbox_placeholder' は表示のみの非機能プレースホルダ（データ未接続）
const FieldCell = observer(({ fieldKey, room, mode }) => {
  if (!fieldKey) return <div style={cardFieldStyle} />;
  if (fieldKey === '__bbox_placeholder') {
    return (
      <div style={cardFieldStyle}>
        <span style={cardLabelStyle}>Bボックス：</span>
        <div style={cardInputWrapStyle}>
          <input disabled style={cellInputStyle} />
        </div>
      </div>
    );
  }
  const field = FIELD_BY_KEY[fieldKey];
  return (
    <div style={cardFieldStyle}>
      <span style={cardLabelStyle}>{CARD_FIELD_LABELS[fieldKey] ?? field.label}：</span>
      <div style={cardInputWrapStyle}>
        <FinishCell room={room} field={field} mode={mode} />
      </div>
    </div>
  );
});

const FinishCell = observer(({ room, field, mode }) => {
  // 内装マスター管理フィールド（壁材・壁仕上げ・天井高さ）— getFinishInfo + setOverride
  if (field.source === 'master') {
    const value = room.getFinishInfo()[field.key];
    // 空入力はポケットを空に戻す（= 内装マスター値へ復帰）
    const handle = v => (v === '' ? room.clearOverride(field.key) : room.setOverride(field.key, v));

    if (field.kind === 'material') {
      return (
        <MaterialSelect
          mode={mode}
          category={field.category}
          value={value}
          onChange={handle}
        />
      );
    }
    // number（天井高さ）
    return (
      <input
        type="number"
        value={value ?? ''}
        onChange={e => handle(e.target.value === '' ? '' : Number(e.target.value))}
        onClick={e => e.stopPropagation()}
        style={cellInputStyle}
      />
    );
  }

  // 自由文字列フィールド（room.finish）
  const value = room.finish[field.key] ?? '';
  return (
    <input
      value={value}
      onChange={e => room.finish.setField(field.key, e.target.value)}
      onClick={e => e.stopPropagation()}
      style={cellInputStyle}
    />
  );
});

// ================================================================
// ExteriorTable — 外部 / 外部建具 / 構造（部位・仕上げ・下地・備考）
// ================================================================

const EXTERIOR_COLS = [
  { key: 'part',   label: '部位',   minWidth: 80 },
  { key: 'finish', label: '仕上げ', minWidth: 120 },
  { key: 'base',   label: '下地',   minWidth: 120 },
  { key: 'note',   label: '備考',   minWidth: 80 },
];

// 部位指定なしの列（部位は部位グループの見出しとして表示）
const PART_GROUP_COLS = EXTERIOR_COLS.filter(c => c.key !== 'part');

// 「部位追加」で選択可能な部位の一覧
const PART_OPTIONS = [
  '屋根庇', '屋上', 'パラペット', '外壁', '軒天', '柱', '梁', '開口部', '窓サッシ', 'ドア',
  '外部建具', 'ガラス', '土庇', 'ポーチ', 'テラス', 'バルコニー', 'ベランダ', '出窓', '巾木',
  '基礎', '犬走り', '物置', '目地', '雨樋', '笠木', '手摺', 'ルーバー', 'サイン', '門扉', '塀', 'フェンス',
];

const ExteriorTable = observer(({ graph, category }) => {
  if (category === 'exteriorRows') {
    return <GroupedExteriorTable graph={graph} category={category} />;
  }
  return <FlatExteriorTable graph={graph} category={category} />;
});

// ----------------------------------------------------------------
// FlatExteriorTable — 外部建具 / 構造（部位は自由入力の単一テーブル）
// ----------------------------------------------------------------

const FlatExteriorTable = observer(({ graph, category }) => {
  const rows = graph[category];

  return (
    <div style={{ overflowX: 'auto', overflowY: 'auto', flex: 1 }}>
      <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 12 }}>
        <thead>
          <tr>
            {EXTERIOR_COLS.map(col => (
              <th key={col.key} style={{ ...headerCell, minWidth: col.minWidth }}>{col.label}</th>
            ))}
            <th style={{ ...headerCell, width: 28 }} />
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td colSpan={EXTERIOR_COLS.length + 1} style={{ ...cellBase, textAlign: 'center', color: '#94a3b8', padding: 20 }}>
                行がありません
              </td>
            </tr>
          )}
          {rows.map(row => (
            <tr key={row.id} style={{ background: '#fff' }}>
              {EXTERIOR_COLS.map(col => (
                <td key={col.key} style={cellBase}>
                  <ExteriorCell row={row} fieldKey={col.key} />
                </td>
              ))}
              <td style={{ ...cellBase, textAlign: 'center', padding: '2px 4px' }}>
                <button
                  onClick={() => graph.removeExteriorRow(category, row.id)}
                  style={{
                    background: 'none',
                    border: 'none',
                    color: '#94a3b8',
                    cursor: 'pointer',
                    fontSize: 14,
                    lineHeight: 1,
                    padding: '0 2px',
                  }}
                  title="削除"
                >
                  ×
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div style={{ padding: '6px 8px' }}>
        <button
          onClick={() => graph.addExteriorRow(category)}
          style={{
            fontSize: 12,
            color: '#2563eb',
            background: 'none',
            border: '1px dashed #93c5fd',
            borderRadius: 4,
            padding: '3px 10px',
            cursor: 'pointer',
          }}
        >
          ＋ 行を追加
        </button>
      </div>
    </div>
  );
});

// ----------------------------------------------------------------
// GroupedExteriorTable — 外部（部位ごとにテーブルを分割し、部位追加で増減）
// ----------------------------------------------------------------

const GroupedExteriorTable = observer(({ graph, category }) => {
  const rows = graph[category];

  const groups = new Map();
  for (const row of rows) {
    const key = row.part || '';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>
      <div style={{ overflowX: 'auto', overflowY: 'auto', flex: 1, padding: 8 }}>
      {groups.size === 0 && (
        <div style={{ ...cellBase, textAlign: 'center', color: '#94a3b8', padding: 20, border: 'none' }}>
          部位が登録されていません
        </div>
      )}
      {[...groups.entries()].map(([part, groupRows]) => (
        <div key={part} style={{ marginBottom: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: '#374151' }}>{part || '（部位未設定）'}</div>
            <button
              onClick={() => graph.removeExteriorRowGroup(category, part)}
              style={{
                fontSize: 11, color: '#94a3b8', background: 'none',
                border: 'none', cursor: 'pointer', padding: '0 4px',
              }}
              title="部位を削除"
            >
              × 部位を削除
            </button>
          </div>
          <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 12 }}>
            <thead>
              <tr>
                {PART_GROUP_COLS.map(col => (
                  <th key={col.key} style={{ ...headerCell, minWidth: col.minWidth }}>{col.label}</th>
                ))}
                <th style={{ ...headerCell, width: 28 }} />
              </tr>
            </thead>
            <tbody>
              {groupRows.map(row => (
                <tr key={row.id} style={{ background: '#fff' }}>
                  {PART_GROUP_COLS.map(col => (
                    <td key={col.key} style={cellBase}>
                      <ExteriorCell row={row} fieldKey={col.key} />
                    </td>
                  ))}
                  <td style={{ ...cellBase, textAlign: 'center', padding: '2px 4px' }}>
                    <button
                      onClick={() => graph.removeExteriorRow(category, row.id)}
                      style={{
                        background: 'none', border: 'none', color: '#94a3b8',
                        cursor: 'pointer', fontSize: 14, lineHeight: 1, padding: '0 2px',
                      }}
                      title="削除"
                    >
                      ×
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <button
            onClick={() => graph.addExteriorRow(category, part)}
            style={{
              marginTop: 4, fontSize: 12, color: '#2563eb', background: 'none',
              border: '1px dashed #93c5fd', borderRadius: 4, padding: '3px 10px', cursor: 'pointer',
            }}
          >
            ＋ 行を追加
          </button>
        </div>
      ))}
      <div style={{ marginTop: 8 }}>
        <select
          value=""
          onChange={e => {
            const part = e.target.value;
            if (part) graph.addExteriorRow(category, part);
          }}
          style={{
            fontSize: 12, color: '#2563eb', background: '#fff',
            border: '1px dashed #93c5fd', borderRadius: 4, padding: '3px 10px', cursor: 'pointer',
          }}
        >
          <option value="">＋ 部位を追加...</option>
          {PART_OPTIONS.map(p => (
            <option key={p} value={p}>{p}</option>
          ))}
        </select>
      </div>
      </div>
    </div>
  );
});

const ExteriorCell = observer(({ row, fieldKey }) => (
  <input
    value={row[fieldKey]}
    onChange={e => row.setField(fieldKey, e.target.value)}
    style={{
      width: '100%',
      minWidth: 60,
      border: 'none',
      outline: 'none',
      background: 'transparent',
      fontSize: 12,
      padding: 0,
    }}
  />
));
