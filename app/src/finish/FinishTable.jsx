import { observer } from 'mobx-react-lite';
import { useState, useEffect } from 'react';
import { useScrollIntoViewWhenActive } from '../ui/useScrollIntoViewWhenActive.js';
import { StairTab } from './stair/StairTab.jsx';
import { EquipmentTab } from './equipment/EquipmentTab.jsx';
import { RoomDeleteConfirm } from './RoomDeleteConfirm.jsx';
import { RoofGroup, MainRoofGroup } from './roof/RoofGroup.jsx';
import { withFinishUndo, beginFieldUndo, endFieldUndo } from './finishUndo.js';
import { roomCeilingHeight } from './roomMetrics.js';
import { parseSlopeInput } from './exteriorLevelInput.js';
import {
  RoomFeature, RoomKind, ExteriorLevelRef, DEFAULT_ROOM_FLOOR_LEVEL, DEFAULT_ROOM_CEILING_HEIGHT,
  ShaftSoundproof, isTopFloorPlane,
} from '@core';
import { interiorTabRooms, interiorRoomDisplayName } from './interiorTabRooms.js';
import { shaftWallMaterialOptions } from './shaftWallMaterialOptions.js';
import { floorHeightAbove } from './stair/stairDimensions.js';
import {
  ROOM_KIND_OPTIONS, CARD_FEATURE_OPTIONS, featureToSelectValue, selectValueToFeature,
} from './roomNamingOptions.js';
import { buildExteriorGroups, isExteriorRoomGroupRoom, isSelectedRoofGroup } from './exteriorGroups.js';
import { rulesFor, effectiveStructure } from '../structural/structureRules.js';
import { CatalogKind } from '../catalog/catalogKinds.js';
import { CATALOG_DIFF_COLOR, CATALOG_DIFF_MARK, diffTooltip } from '../catalog/catalogDiffView.js';

// ---- 内部仕上げ表 ----

// kind  : 'text'（自由文字列・room.finish）/ 'material'（材ドロップダウン・内装マスター管理）
// source: 'finish'（room.finish）/ 'master'（room.getFinishInfo() + setOverride）
// ※ ceilingHeight（CH）は master 管理だが自由入力（傾斜天井のレンジ表記「2300～3500」等を許容）
const INTERIOR_FIELDS = [
  { key: 'floorMaterial',     label: '仕上げ',   group: '床',   groupSpan: 1, kind: 'text',   source: 'finish' },
  { key: 'baseboardMaterial', label: '仕上げ',   group: '巾木', groupSpan: 2, kind: 'text',   source: 'finish' },
  { key: 'baseboardHeight',   label: 'H',        group: null,   groupSpan: 0, kind: 'text',   source: 'finish' },
  { key: 'wallMaterial',      label: '壁材',     group: '壁',   groupSpan: 4, kind: 'material', category: 'panel',  source: 'master' },
  { key: 'wallFinish',        label: '壁仕上げ', group: null,   groupSpan: 0, kind: 'material', category: 'finish', source: 'master' },
  { key: 'dadoMaterial',      label: '腰仕上げ', group: null,   groupSpan: 0, kind: 'text',   source: 'finish' },
  { key: 'dadoHeight',        label: '腰H',      group: null,   groupSpan: 0, kind: 'text',   source: 'finish' },
  { key: 'ceilingPanel',      label: '天井材',   group: '天井', groupSpan: 4, kind: 'material', category: 'panel',  source: 'master' },
  { key: 'ceilingFinish',     label: '仕上げ',   group: null,   groupSpan: 0, kind: 'material', category: 'finish', source: 'master' },
  { key: 'ceilingHeight',     label: 'H',        group: null,   groupSpan: 0, kind: 'text',   source: 'master' },
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
  ceilingPanel:      '天井材',
  ceilingFinish:     '天井仕上げ',
  ceilingHeight:     'CH',
  cornice:           '廻り縁',
};

// 部屋カードのセクション構成（モックアップのレイアウトに合わせた固定定義。INTERIOR_FIELDS自体は変更しない）
const CARD_SECTIONS = [
  { title: '床・巾木', rows: [
    ['floorMaterial', 'baseboardMaterial'],
    ['floorLevel', 'baseboardHeight'],
  ] },
  { title: '壁・腰', rows: [
    ['wallMaterial', 'dadoMaterial'],
    ['wallFinish', 'dadoHeight'],
  ] },
  { title: '天井・廻り縁', rows: [
    ['ceilingPanel', 'ceilingFinish'],
    ['ceilingHeight', 'cornice'],
    ['__bbox_placeholder', null],
  ] },
];

// CH 文字列に 0 以下の数値が含まれるか（CHは0より大きい）。
// 全角数字は半角へ正規化し、レンジ表記「2300～3500」の各数値トークンを個別に検査する。
function chContainsZero(text) {
  const s = String(text).replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
  const tokens = s.match(/-?\d+(?:\.\d+)?/g) ?? [];
  return tokens.some(t => Number(t) <= 0);
}

// CH の 0 指定エラー文（部屋カード・共通仕様タブ共通）
const chZeroError = (fallback) => `CHに０は指定できません。初期値：${fallback}にします。`;

// エラー文のインライン表示スタイル（トーストは App.jsx ローカルのため、欄直下に表示して3.5秒で自動消去）
const fieldErrorStyle = { fontSize: 10, color: '#dc2626', whiteSpace: 'normal' };

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
  { id: 'stair',     label: '階段' },
  { id: 'exterior',  label: '外部' },
  { id: 'fittings',  label: '外部建具' },
  { id: 'structure', label: '構造' },
  { id: 'equipment', label: '機械器具' },
  { id: 'accessory', label: '附帯' },
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
// R13: 文書同梱材が本体（user/builtin）と不一致の材は、名称の後ろに≠を付けオレンジで示す
// （<option>の色は実機で効かない可能性があるため、≠とtitleは必ず付ける）。
export const MaterialSelect = observer(({ mode, category, value, onChange, style, disabled = false, title }) => {
  const materials = mode?.getMaterialsByCategory(category) ?? [];
  return (
    <select
      value={value ?? ''}
      onChange={e => onChange(e.target.value)}
      onClick={e => e.stopPropagation()}
      disabled={disabled}
      title={title}
      style={{ ...cellInputStyle, cursor: disabled ? 'default' : 'pointer', ...style }}
    >
      <option value="">（未選択）</option>
      {materials.map(m => {
        const diff = mode?.materialDiff?.(m.code);
        return (
          <option
            key={m.code}
            value={m.code}
            style={diff ? { color: CATALOG_DIFF_COLOR } : undefined}
            title={diff ? diffTooltip(CatalogKind.MATERIAL, diff.diffFields, m, diff.baseEntry) : undefined}
          >
            {diff ? `${m.name} ${CATALOG_DIFF_MARK}` : m.name}
          </option>
        );
      })}
    </select>
  );
});

// 表の上に1行表示する per-floor 設定行（共通仕様タブの下地材設定）
const PerFloorRow = observer(({ label, mode, category, value, onChange, disabled = false, title }) => (
  <div style={{
    display: 'flex', alignItems: 'center', gap: 8,
    padding: '6px 12px', borderBottom: '1px solid #e2e8f0',
    background: '#fafafa', flexShrink: 0,
  }}>
    <span style={{ fontSize: 12, fontWeight: 700, color: '#374151', whiteSpace: 'nowrap' }}>{label}：</span>
    <MaterialSelect mode={mode} category={category} value={value} onChange={onChange}
      disabled={disabled} title={title} style={{ flex: 1, minWidth: 120 }} />
  </div>
));

// 数値の per-floor 設定行（共通仕様タブの部屋既定値: FL初期値・CH初期値）。
// フォーカス〜ブラーで1 undo エントリ。onChange には入力文字列をそのまま渡す（空欄処理は呼び出し側）。
// onBlurValidate は endFieldUndo より前に呼ぶ（検証による是正を同じ undo エントリに含めるため）。
const PerFloorNumberRow = observer(({ label, graph, value, onChange, onBlurValidate }) => (
  <div style={{
    display: 'flex', alignItems: 'center', gap: 8,
    padding: '6px 12px', borderBottom: '1px solid #e2e8f0',
    background: '#fafafa', flexShrink: 0,
  }}>
    <span style={{ fontSize: 12, fontWeight: 700, color: '#374151', whiteSpace: 'nowrap' }}>{label}：</span>
    <input
      type="number"
      value={value ?? ''}
      onChange={e => onChange(e.target.value)}
      onFocus={() => beginFieldUndo(graph)}
      onBlur={() => { onBlurValidate?.(); endFieldUndo(graph); }}
      style={{ ...cellInputStyle, flex: 1, minWidth: 120 }}
    />
  </div>
));

// 汎用 select による per-floor 設定行（共通仕様タブの昇降路 壁仕上げ材／防音材）。
// PerFloorRow（材マスタ限定の MaterialSelect）と違い、options を直接渡す。
const PerFloorSelectRow = observer(({ label, value, options, onChange }) => (
  <div style={{
    display: 'flex', alignItems: 'center', gap: 8,
    padding: '6px 12px', borderBottom: '1px solid #e2e8f0',
    background: '#fafafa', flexShrink: 0,
  }}>
    <span style={{ fontSize: 12, fontWeight: 700, color: '#374151', whiteSpace: 'nowrap' }}>{label}：</span>
    <select
      value={value ?? ''}
      onChange={e => onChange(e.target.value)}
      style={{ ...cellInputStyle, flex: 1, minWidth: 120 }}
    >
      {options.map(opt => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
    </select>
  </div>
));

// ================================================================
// CommonSpecTable — 共通仕様タブ（下地材のフロア共通設定）
// ================================================================

// 「内外壁」は内部的に graph.exteriorWallBacking と同じ設定を指す（独立フィールドは持たない）。
// 外壁下地の値を変更すると本行の表示も連動して追従する。
const CommonSpecTable = observer(({ graph, mode }) => {
  // 在来木造は壁下地材を「柱同寸×30」へ自動選択する（structural/woodAutoFill.js conformWoodBacking）ため
  // 内壁・外壁の下地材は手で変えられない（主構造ルール backing）。
  const autoBacking = rulesFor(effectiveStructure(graph)).backing != null;
  const autoTitle = autoBacking ? '在来木造では柱同寸×30の間柱を自動選択します' : undefined;
  // CH初期値の 0 指定エラー（部屋カードの CH と同じルール: CHは0より大きい）
  const [chError, setChError] = useState(null);
  useEffect(() => {
    if (!chError) return;
    const t = setTimeout(() => setChError(null), 3500);
    return () => clearTimeout(t);
  }, [chError]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>
      <div style={{ overflowY: 'auto', flex: 1 }}>
        <PerFloorRow label="内壁下地" mode={mode} category="backing" disabled={autoBacking} title={autoTitle}
          value={graph.interiorWallBacking} onChange={code => withFinishUndo(graph, () => graph.setInteriorWallBacking(code))} />
        <PerFloorRow label="内外壁" mode={mode} category="backing" disabled={autoBacking} title={autoTitle}
          value={graph.exteriorWallBacking} onChange={code => withFinishUndo(graph, () => graph.setExteriorWallBacking(code))} />
        <PerFloorRow label="外壁下地" mode={mode} category="backing" disabled={autoBacking} title={autoTitle}
          value={graph.exteriorWallBacking} onChange={code => withFinishUndo(graph, () => graph.setExteriorWallBacking(code))} />
        <PerFloorRow label="天井" mode={mode} category="backing"
          value={graph.ceilingBacking} onChange={code => withFinishUndo(graph, () => graph.setCeilingBacking(code))} />
        <PerFloorRow label="床" mode={mode} category="backing"
          value={graph.floorBacking} onChange={code => withFinishUndo(graph, () => graph.setFloorBacking(code))} />
        {/* 昇降路（昇降機）の壁仕上げ材・防音材 — 内部タブに部屋カードを出さず、ここで一括指定する（Q5）。
            壁仕上げ材は昇降路部屋の壁厚に効く（edgeComposition.wallDimsWith）。 */}
        <PerFloorSelectRow label="昇降路 壁仕上げ材"
          value={graph.shaftWallMaterial}
          options={shaftWallMaterialOptions(graph.shaftWallMaterial, mode.getMaterialsByCategory('panel'))}
          onChange={code => withFinishUndo(graph, () => graph.setShaftWallMaterial(code))} />
        {/* 防音材は表示のみ（断面計算に未接続。天井・床下地と同じ扱い）。 */}
        <PerFloorSelectRow label="昇降路 防音材"
          value={graph.shaftSoundproof}
          options={[
            { value: ShaftSoundproof.NONE,       label: 'なし' },
            { value: ShaftSoundproof.INSULATION, label: '断熱材' },
          ]}
          onChange={v => withFinishUndo(graph, () => graph.setShaftSoundproof(v))} />
        {/* 部屋の既定値 — 部屋カードの FL / CH が未指定のときに参照される（空欄 = 既定へ復帰） */}
        <PerFloorNumberRow label="FL初期値" graph={graph} value={graph.defaultFloorLevel}
          onChange={v => graph.setDefaultFloorLevel(v === '' ? DEFAULT_ROOM_FLOOR_LEVEL : Number(v))} />
        <PerFloorNumberRow label="CH初期値" graph={graph} value={graph.defaultCeilingHeight}
          onChange={v => { setChError(null); graph.setDefaultCeilingHeight(v === '' ? DEFAULT_ROOM_CEILING_HEIGHT : Number(v)); }}
          onBlurValidate={() => {
            // CHは0より大きい: 0以下は既定(2400)へ戻してエラー表示
            if (!(graph.defaultCeilingHeight > 0)) {
              graph.setDefaultCeilingHeight(DEFAULT_ROOM_CEILING_HEIGHT);
              setChError(chZeroError(DEFAULT_ROOM_CEILING_HEIGHT));
            }
          }} />
        {chError && <div style={{ ...fieldErrorStyle, fontSize: 11, padding: '4px 12px' }}>{chError}</div>}
      </div>
    </div>
  );
});

// 空タブの共通プレースホルダ（機械器具・附帯。中身は次ステップ／別課題で実装する）。
// 既存の空状態の流儀（InteriorTable「部屋が登録されていません」）に合わせる。
const EmptyTabPlaceholder = observer(({ message }) => (
  <div style={{ textAlign: 'center', color: '#94a3b8', padding: 20, fontSize: 12 }}>
    {message}
  </div>
));

// ================================================================
// FinishTable — タブ付きメイン
// ================================================================

export const FinishTable = observer(({
  graph, mode, project, selectedRoomId, onSelectRoom, onApplyNaming, floorName,
  onDeleteEquipment, onChangeEquipmentUsage, onDeleteStair,
  onDeleteStairRoom,
}) => {
  const [activeTab, setActiveTab] = useState('interior');
  // 階段化セレクタ（内部タブのカード・部屋名ダイアログ共通）を有効にするか。上階に採用フロアが
  // 無ければ階段化できない（stairEnabled=false。RoomNameInput.jsxと同じ条件）。
  const stairEnabled = floorHeightAbove(project, project?.activePlane) != null;
  // 階段が選択されたら「階段」タブへ自動切替
  useEffect(() => { if (mode.selectedStairId) setActiveTab('stair'); }, [mode.selectedStairId]);
  // 昇降機器具が選択されたら「機械器具」タブへ自動切替
  useEffect(() => { if (mode.selectedEquipmentId) setActiveTab('equipment'); }, [mode.selectedEquipmentId]);
  // 部屋が選択されたら「内部」タブへ自動切替（階段選択時は階段タブが勝つ。宣言順で下の effect が
  // 後に評価されるため、両方セットされた場合はここで内部タブに切り替わらないよう明示的にガードする）
  // 屋外部屋（階段以外）は外部タブが担当するため、選択時はそちらへ切り替える。
  // 選択IDだけでなく kind/feature も依存に含める——新規部屋はドラッグ確定時点で選択済み
  // （selectedRoomId 不変）のため、命名ダイアログで「屋外」を確定した時点で切り替えるには
  // kind の変化で effect を再実行する必要がある（observer なので render 内の参照で追跡される）。
  const selectedRoom = mode.selectedRoomId ? mode.graph.roomMap.get(mode.selectedRoomId) : null;
  const selectedIsExterior = !!selectedRoom
    && selectedRoom.kind === RoomKind.EXTERIOR && selectedRoom.feature !== RoomFeature.STAIR;
  useEffect(() => {
    if (!mode.selectedRoomId || mode.selectedStairId) return;
    setActiveTab(selectedIsExterior ? 'exterior' : 'interior');
  }, [mode.selectedRoomId, mode.selectedStairId, selectedIsExterior]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>
      {/* タブバー（タブ数が増えても折返しせず横スクロール） */}
      <div style={{
        display: 'flex',
        borderBottom: '1px solid #e2e8f0',
        background: '#f8fafc',
        flexShrink: 0,
        overflowX: 'auto',
        overflowY: 'hidden',
        scrollbarWidth: 'thin',
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
              whiteSpace: 'nowrap',
              flexShrink: 0,
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
            onApplyNaming={onApplyNaming}
            onDeleteStairRoom={onDeleteStairRoom}
            stairEnabled={stairEnabled}
            floorName={floorName}
          />
        : activeTab === 'stair'
        ? <StairTab graph={graph} mode={mode} project={project} onDeleteStair={onDeleteStair} />
        : activeTab === 'common'
        ? <CommonSpecTable graph={graph} mode={mode} />
        : activeTab === 'equipment'
        ? <EquipmentTab
            graph={graph}
            mode={mode}
            floorName={floorName}
            onDeleteEquipment={onDeleteEquipment}
            onChangeEquipmentUsage={onChangeEquipmentUsage}
          />
        : activeTab === 'accessory'
        ? <EmptyTabPlaceholder message="附帯は未対応です" />
        : <ExteriorTable
            graph={graph}
            mode={mode}
            onApplyNaming={onApplyNaming}
            category={TAB_TO_CATEGORY[activeTab]}
          />
      }
    </div>
  );
});

// ================================================================
// InteriorTable — 部屋ごとの内部仕上げ（既存テーブル）
// ================================================================

const InteriorTable = observer(({ graph, mode, selectedRoomId, onSelectRoom, onApplyNaming, onDeleteStairRoom, stairEnabled, floorName }) => {
  // 内部タブに載せる部屋の述語は finish/interiorTabRooms.js（天伏パネルと共用。除外の理由もそちら）。
  const rooms = interiorTabRooms(graph);

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
    const original = graph.roomOrder.slice();
    const currentOrder = original.slice();
    const fromIndex = currentOrder.indexOf(dragId);
    if (fromIndex === -1) {
      setDragId(null);
      setOverIndex(null);
      return;
    }
    // 自己ドロップ（自分の位置へ落とす）は no-op — dragId除去後のindexOfが-1になり
    // 末尾へ誤って移動してしまうのを防ぐ
    if (rooms[dropIndex] && rooms[dropIndex].id === dragId) {
      setDragId(null);
      setOverIndex(null);
      return;
    }

    currentOrder.splice(fromIndex, 1);

    // dropIndex は表示用フィルタ後配列（rooms、屋外階段・STAIR_VOID除外済み。屋内階段は含む）の index。
    // graph.roomOrder（未フィルタ、除外分も含む）への挿入位置は、落下先の可視行IDを
    // currentOrder 上で探して求める（フィルタ後indexをそのままspliceに使うと除外分だけずれる）。
    let insertAt;
    if (dropIndex < rooms.length) {
      insertAt = currentOrder.indexOf(rooms[dropIndex].id);
    } else {
      // 末尾ドロップ = 最後の可視行の直後
      const lastVisibleId = rooms[rooms.length - 1]?.id;
      insertAt = lastVisibleId != null ? currentOrder.indexOf(lastVisibleId) + 1 : currentOrder.length;
    }
    if (insertAt === -1) insertAt = currentOrder.length;

    currentOrder.splice(insertAt, 0, dragId);
    const unchanged = currentOrder.length === original.length
      && currentOrder.every((id, i) => id === original[i]);
    if (!unchanged) withFinishUndo(graph, () => graph.reorderRooms(currentOrder));
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
            onApplyNaming={onApplyNaming}
            stairEnabled={stairEnabled}
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
      <RoomDeleteConfirm graph={graph} mode={mode} deleteConfirm={deleteConfirm} onClose={() => setDeleteConfirm(null)} onDeleteStairRoom={onDeleteStairRoom} />
    </div>
  );
});

// カード見出しの名称入力欄（展開時のみ。空なら既定「部屋」。確定は blur と Enter。
// IME変換中のEnterでは確定しない — 変換確定の Enter を早期の blur に横取りさせないため）。
// 見出しクリック（onToggle）を奪わないよう stopPropagation する。
const CardNameInput = observer(({ room, onApplyNaming }) => {
  const [draft, setDraft] = useState(null); // null = 非編集（room.nameをそのまま表示）
  function commit() {
    if (draft === null) return;
    const trimmed = draft.trim();
    if (trimmed !== (room.name || '')) {
      onApplyNaming(room.id, { name: trimmed, kind: room.kind, feature: room.feature });
    }
    setDraft(null);
  }
  return (
    <input
      value={draft ?? room.name}
      onChange={e => setDraft(e.target.value)}
      onClick={e => e.stopPropagation()}
      onKeyDown={e => {
        if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); e.currentTarget.blur(); }
      }}
      onBlur={commit}
      placeholder="部屋"
      style={{
        flex: 1, fontSize: 13, fontWeight: 700, color: '#1e293b',
        border: '1px solid #e2e8f0', borderRadius: 4, padding: '2px 6px',
        background: '#fff', minWidth: 0,
      }}
    />
  );
});

// カード本体の区分（屋内/屋外）・属性（なし/階段/吹抜け）セレクタ。ROOM_KIND_OPTIONS・
// CARD_FEATURE_OPTIONS（roomNamingOptions.js。昇降路は除外）を共通の唯一の供給源とする。
// applyNaming の遷移処理（階段化・階段解除・屋外化→外部タブ行連動）はonApplyNaming経由でそのまま通す。
const CardKindFeatureRow = observer(({ room, onApplyNaming, stairEnabled }) => (
  <div style={cardRowStyle}>
    <div style={cardFieldStyle}>
      <span style={cardLabelStyle}>区分：</span>
      <div style={cardInputWrapStyle}>
        <select
          value={room.kind}
          onClick={e => e.stopPropagation()}
          onChange={e => {
            const kind = e.target.value;
            if (kind !== room.kind) onApplyNaming(room.id, { name: room.name, kind, feature: room.feature });
          }}
          style={cellInputStyle}
        >
          {ROOM_KIND_OPTIONS.map(opt => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
      </div>
    </div>
    <div style={cardFieldStyle}>
      <span style={cardLabelStyle}>属性：</span>
      <div style={cardInputWrapStyle}>
        <select
          value={featureToSelectValue(room.feature)}
          title={stairEnabled ? undefined : '上階に採用階がありません'}
          onClick={e => e.stopPropagation()}
          onChange={e => {
            const feature = selectValueToFeature(e.target.value);
            if (feature !== room.feature) onApplyNaming(room.id, { name: room.name, kind: room.kind, feature });
          }}
          style={cellInputStyle}
        >
          {CARD_FEATURE_OPTIONS.map(opt => (
            <option
              key={featureToSelectValue(opt.value)}
              value={featureToSelectValue(opt.value)}
              disabled={opt.value === RoomFeature.STAIR && !stairEnabled}
            >
              {opt.label}
            </option>
          ))}
        </select>
      </div>
    </div>
  </div>
));

// 部屋1件分のカード。折りたたみ時はヘッダのみ、展開時はセクション群を表示する。
// 展開＝選択（selectedRoomId）で、図面上の部屋タップからも立つため、可視域へ寄せる
// （構造の部材カード・建具の一覧行と共通のフック）。
const RoomCard = observer(({ room, mode, isExpanded, isDragging, isOver,
  onToggle, onDragStart, onDragOver, onDrop, onDragEnd, onRequestDelete, onApplyNaming, stairEnabled }) => {
  const cardRef = useScrollIntoViewWhenActive(isExpanded);
  return (
  <div
    ref={cardRef}
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
      {isExpanded ? (
        <CardNameInput room={room} onApplyNaming={onApplyNaming} />
      ) : (
        <span style={{ flex: 1, fontSize: 13, fontWeight: 700, color: '#1e293b' }}>
          {interiorRoomDisplayName(room)}
        </span>
      )}
      <span style={{ color: '#94a3b8', fontSize: 11 }}>{isExpanded ? '▼' : '◀'}</span>
    </div>
    {isExpanded && (
      <div style={cardBodyStyle}>
        <CardKindFeatureRow room={room} onApplyNaming={onApplyNaming} stairEnabled={stairEnabled} />
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
  );
});

// セクション内の1行（左右2列。leftKey/rightKeyはINTERIOR_FIELDSのキー、nullなら空セル）
const FieldRow = observer(({ leftKey, rightKey, room, mode }) => (
  <div style={cardRowStyle}>
    <FieldCell fieldKey={leftKey} room={room} mode={mode} />
    <FieldCell fieldKey={rightKey} room={room} mode={mode} />
  </div>
));

// FL入力欄。type="number" では「-」だけの中間状態を value に保持できず（DOMが空文字を返す）
// 負値が打てないため、テキスト入力＋編集中ドラフトで受ける。数値として解釈できた時点で Room へ
// 反映し、「-」のまま確定した場合は空欄と同じく null（階基準どおり）に戻す。
const FloorLevelInput = observer(({ room, graph }) => {
  const [draft, setDraft] = useState(null); // 編集中の生テキスト（null = 非編集）
  const committed = room.floorLevel ?? graph?.defaultFloorLevel ?? DEFAULT_ROOM_FLOOR_LEVEL;
  return (
    <input
      type="text"
      inputMode="numeric"
      value={draft ?? String(committed)}
      onChange={e => {
        const t = e.target.value;
        if (!/^-?\d*$/.test(t)) return; // 数字と先頭の「-」のみ許可
        setDraft(t);
        if (t !== '' && t !== '-') room.setFloorLevel(Number(t));
      }}
      onFocus={() => beginFieldUndo(graph)}
      onBlur={() => {
        if (draft === '' || draft === '-') room.setFloorLevel(null); // 空欄 = 階基準どおり
        setDraft(null);
        endFieldUndo(graph);
      }}
      onClick={e => e.stopPropagation()}
      style={cellInputStyle}
    />
  );
});

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
  // FL — Room.floorLevel（当該階FLからの符号付き相対高さmm。空欄 = null = 階基準どおり）。
  // 内装マスターではなく Room 直下のフィールドのため、setOverride を経由しない。
  if (fieldKey === 'floorLevel') {
    const graph = mode?.graph;
    // 階段は踏面ごとにレベルが変わるため入力不可の「-」表示とする（階高欄と同じ扱い）
    if (room.feature === RoomFeature.STAIR) {
      return (
        <div style={cardFieldStyle}>
          <span style={cardLabelStyle}>FL：</span>
          <div style={cardInputWrapStyle}>
            <input disabled value="-" style={cellInputStyle} />
          </div>
        </div>
      );
    }
    return (
      <div style={cardFieldStyle}>
        <span style={cardLabelStyle}>FL：</span>
        <div style={cardInputWrapStyle}>
          <FloorLevelInput room={room} graph={graph} />
        </div>
      </div>
    );
  }
  // 階段カードの天井高欄は「階高」に差し替え、表示値「-」の入力不可とする（データは書き込まない）。
  if (fieldKey === 'ceilingHeight' && room.feature === RoomFeature.STAIR) {
    return (
      <div style={cardFieldStyle}>
        <span style={cardLabelStyle}>階高：</span>
        <div style={cardInputWrapStyle}>
          <input disabled value="-" style={cellInputStyle} />
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
  const graph = mode?.graph;
  // CH の 0 指定エラー（ブラー時検証。3.5秒で自動消去。CH 以外のフィールドでは未使用）
  const [chError, setChError] = useState(null);
  useEffect(() => {
    if (!chError) return;
    const t = setTimeout(() => setChError(null), 3500);
    return () => clearTimeout(t);
  }, [chError]);

  // 内装マスター管理フィールド（壁材・壁仕上げ・天井高さ）— getFinishInfo + setOverride
  if (field.source === 'master') {
    const info = room.getFinishInfo();
    // CH はマスター・上書きとも未指定なら roomCeilingHeight（項目5: 部分指定＋floorLevel差なら
    // 親CHを段差調整、それ以外は従来どおり per-floor 既定=共通仕様タブのCH初期値）へフォールバック。
    // info.ceilingHeight が設定済み（数値・傾斜天井レンジ表記いずれも）ならそのまま自由入力の
    // 原文を表示する——roomCeilingHeight().mm は数値化専用のため、レンジ表記の原文保持には使わない。
    const value = field.key === 'ceilingHeight'
      ? (info.ceilingHeight ?? roomCeilingHeight(graph, room).mm)
      : info[field.key];
    // 空入力はポケットを空に戻す（= 内装マスター値／per-floor 既定へ復帰）
    const handle = v => (v === '' ? room.clearOverride(field.key) : room.setOverride(field.key, v));

    if (field.kind === 'material') {
      return (
        <MaterialSelect
          mode={mode}
          category={field.category}
          value={value}
          onChange={v => withFinishUndo(graph, () => handle(v))}
        />
      );
    }
    // CH（天井高さ）— 自由入力（傾斜天井のレンジ表記可）。フォーカス〜ブラーで1 undo エントリ。
    // 上階の吹抜けが部屋上部を覆う場合は自動計算（階高＋上階吹抜け部屋CH）:
    //   丸ごと吹抜け → 計算値の読取専用表示 / 一部吹抜け → 自CH（編集可）に「, 計算値」を併記
    const voidInfo = field.key === 'ceilingHeight' ? (mode?.voidCHAbove?.(room) ?? null) : null;
    if (voidInfo?.full) {
      return <input disabled value={voidInfo.ch} style={cellInputStyle} />;
    }
    return (
      <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1 }}>
        <span style={{ display: 'flex', alignItems: 'center', minWidth: 0 }}>
          <input
            type="text"
            value={value ?? ''}
            onChange={e => { setChError(null); handle(e.target.value); }}
            onFocus={() => beginFieldUndo(graph)}
            onBlur={() => {
              // CHは0より大きい: 0（レンジ表記中の0含む）は拒否し、上書きを消して
              // マスター／CH初期値へ戻す（endFieldUndo より前に是正 = 同じ undo エントリ）
              const cur = room.getFinishInfo().ceilingHeight;
              if (cur != null && cur !== '' && chContainsZero(cur)) {
                room.clearOverride('ceilingHeight');
                const fallback = room.getFinishInfo().ceilingHeight
                  ?? roomCeilingHeight(graph, room).mm;
                setChError(chZeroError(fallback));
              }
              endFieldUndo(graph);
            }}
            onClick={e => e.stopPropagation()}
            style={cellInputStyle}
          />
          {voidInfo && (
            <span style={{ fontSize: 12, color: '#374151', whiteSpace: 'nowrap' }}>, {voidInfo.ch}</span>
          )}
        </span>
        {chError && <span style={fieldErrorStyle}>{chError}</span>}
      </span>
    );
  }

  // 自由文字列フィールド（room.finish）— フォーカス〜ブラーで1 undo エントリ
  const value = room.finish[field.key] ?? '';
  return (
    <input
      value={value}
      onChange={e => room.finish.setField(field.key, e.target.value)}
      onFocus={() => beginFieldUndo(graph)}
      onBlur={() => endFieldUndo(graph)}
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

const ExteriorTable = observer(({ graph, mode, onApplyNaming, category }) => {
  if (category === 'exteriorRows') {
    return <GroupedExteriorTable graph={graph} mode={mode} onApplyNaming={onApplyNaming} category={category} />;
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
                  <ExteriorCell graph={graph} row={row} fieldKey={col.key} />
                </td>
              ))}
              <td style={{ ...cellBase, textAlign: 'center', padding: '2px 4px' }}>
                <button
                  onClick={() => withFinishUndo(graph, () => graph.removeExteriorRow(category, row.id))}
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
          onClick={() => withFinishUndo(graph, () => graph.addExteriorRow(category))}
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

// 屋外部屋（階段以外）の部位見出し直下に出す仕上げレベル入力（勾配・おさえ基準・おさえmm）。
// FloorLevelInput（部屋カードのFL欄）と同じ draft 方式（文字入力はfocus/blurでundo境界）。
const ExteriorLevelRow = observer(({ room, graph }) => {
  const [slopeDraft, setSlopeDraft] = useState(null);
  const [levelDraft, setLevelDraft] = useState(null);
  // 符号はローカルstateで保持する（levelがnullでも選択が保持されるように。derivedにすると
  // level===nullの間は毎レンダー既定符号へ引き戻され、"－"を選んでも見た目が戻ってしまう）。
  // 初期値は既存の格納値の符号（あれば）／基準の既定符号（room→−／gl→＋）から導出する。
  const [signDraft, setSignDraft] = useState(() => {
    if (room.exteriorLevel != null) return room.exteriorLevel < 0 ? '-' : '+';
    return (room.exteriorLevelRef ?? ExteriorLevelRef.ROOM) === ExteriorLevelRef.GL ? '+' : '-';
  });

  // undo/redo（restoreRoomsState は Room を作り直すが本コンポーネントは再マウントされない）で
  // 格納値の符号が変わったら追従する。null のときは選択を保持する（上記の意図を壊さない）。
  useEffect(() => {
    if (room.exteriorLevel != null) setSignDraft(room.exteriorLevel < 0 ? '-' : '+');
  }, [room.exteriorLevel]);

  const levelRef = room.exteriorLevelRef ?? ExteriorLevelRef.ROOM;
  const level    = room.exteriorLevel;
  const absLevel = level == null ? null : Math.abs(level);

  return (
    <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 6, fontSize: 12, color: '#374151', marginBottom: 6, whiteSpace: 'nowrap' }}>
      <span style={{ fontWeight: 700 }}>仕上げレベル</span>
      <span>勾配 1/</span>
      <input
        type="text"
        inputMode="numeric"
        value={slopeDraft ?? (room.exteriorSlope == null ? '' : String(room.exteriorSlope))}
        onChange={e => {
          const t = e.target.value;
          if (!/^\d*$/.test(t)) return;
          setSlopeDraft(t);
          const n = parseSlopeInput(t);
          if (n !== null) room.setExteriorSlope(n);
        }}
        onFocus={() => beginFieldUndo(graph)}
        onBlur={() => {
          // 空文字/"0" は勾配指定なしとしてクリアする（未編集=null のときは何もしない）
          if (slopeDraft !== null && parseSlopeInput(slopeDraft) === null) room.setExteriorSlope(null);
          setSlopeDraft(null);
          endFieldUndo(graph);
        }}
        onClick={e => e.stopPropagation()}
        style={{ ...cellInputStyle, width: 48, border: '1px solid #cbd5e1', padding: '2px 4px' }}
      />
      <span>おさえ</span>
      <select
        value={levelRef}
        onChange={e => {
          const ref = e.target.value;
          // 基準を変えたら符号を自動選択: room→負、gl→正（signDraftも合わせて更新する）
          const newSign = ref === ExteriorLevelRef.GL ? '+' : '-';
          setSignDraft(newSign);
          withFinishUndo(graph, () => {
            room.setExteriorLevelRef(ref);
            if (room.exteriorLevel != null) {
              room.setExteriorLevel(newSign === '+' ? Math.abs(room.exteriorLevel) : -Math.abs(room.exteriorLevel));
            }
          });
        }}
        style={{ ...cellInputStyle, width: 'auto', border: '1px solid #cbd5e1', padding: '2px 4px' }}
      >
        <option value={ExteriorLevelRef.ROOM}>部屋内レベル</option>
        <option value={ExteriorLevelRef.GL}>GL</option>
      </select>
      <select
        value={signDraft}
        onChange={e => {
          const s = e.target.value;
          setSignDraft(s);
          withFinishUndo(graph, () => {
            if (room.exteriorLevel != null) {
              room.setExteriorLevel(s === '-' ? -Math.abs(room.exteriorLevel) : Math.abs(room.exteriorLevel));
            }
          });
        }}
        style={{ ...cellInputStyle, width: 'auto', border: '1px solid #cbd5e1', padding: '2px 4px' }}
      >
        <option value="+">＋</option>
        <option value="-">－</option>
      </select>
      <input
        type="text"
        inputMode="numeric"
        value={levelDraft ?? (absLevel == null ? '' : String(absLevel))}
        onChange={e => {
          const t = e.target.value;
          if (!/^\d*$/.test(t)) return;
          setLevelDraft(t);
          if (t !== '') room.setExteriorLevel(signDraft === '-' ? -Number(t) : Number(t));
        }}
        onFocus={() => beginFieldUndo(graph)}
        onBlur={() => {
          if (levelDraft === '') room.setExteriorLevel(null);
          setLevelDraft(null);
          endFieldUndo(graph);
        }}
        onClick={e => e.stopPropagation()}
        style={{ ...cellInputStyle, width: 60, border: '1px solid #cbd5e1', padding: '2px 4px' }}
      />
      <span>mm</span>
    </div>
  );
});

// 屋外部屋（階段以外）の部位見出しを部屋名の入力欄にする（外部タブでの改名。Room名と、
// その roomId の全 exteriorRows 行の part を同じ値へ連動更新する。mode.renameExteriorRoom 経由）。
// FloorLevelInput・CardNameInput と同じ draft 方式（blur/Enterで確定。IME変換中のEnterは無視）。
const ExteriorPartHeading = observer(({ room, mode }) => {
  const [draft, setDraft] = useState(null);
  function commit() {
    if (draft === null) return;
    mode.renameExteriorRoom(room.id, draft);
    setDraft(null);
  }
  return (
    <input
      value={draft ?? room.name}
      onChange={e => setDraft(e.target.value)}
      onKeyDown={e => {
        if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); e.currentTarget.blur(); }
      }}
      onBlur={commit}
      placeholder="屋外"
      style={{
        fontSize: 13, fontWeight: 700, color: '#374151',
        border: '1px solid #e2e8f0', borderRadius: 4, padding: '2px 6px', background: '#fff',
      }}
    />
  );
});

// 屋根の群の枠。平面で選ばれた屋根の群だけ、部屋カードと同じ選択の強調（青の枠）を付け、可視域へ寄せる。
const RoofGroupFrame = observer(({ selected, children }) => {
  const frameRef = useScrollIntoViewWhenActive(selected);
  return (
    <div
      ref={frameRef}
      style={{
        marginBottom: 16,
        outline: selected ? '2px solid #2563eb' : 'none',
        outlineOffset: 2,
      }}
    >
      {children}
    </div>
  );
});

const GroupedExteriorTable = observer(({ graph, mode, onApplyNaming, category }) => {
  const rows = graph[category];
  // 群の並び（どの群をどの順で出すか）は exteriorGroups.js（純モジュール）を唯一の供給源にする。
  // 屋外・非階段のRoomは連動行が0件でも群を出す（ユーザー裁定: 屋外タブに削除ボタン・区分
  // セレクタをRoom連動で置く）。
  // 主屋根の群は最上階（とその検討案）の外部タブにだけ出す（判定は core/project.js isTopFloorPlane）。
  const includeMainRoof = isTopFloorPlane(mode.project, graph.plane);
  const groups = buildExteriorGroups({ rows, rooms: graph.rooms, roomOrder: graph.roomOrder, includeMainRoof });
  const [deleteConfirm, setDeleteConfirm] = useState(null); // { roomId, roomName } | null

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>
      <div style={{ overflowX: 'auto', overflowY: 'auto', flex: 1, padding: 8 }}>
      {groups.length === 0 && (
        <div style={{ ...cellBase, textAlign: 'center', color: '#94a3b8', padding: 20, border: 'none' }}>
          部位が登録されていません
        </div>
      )}
      {groups.map(({ key: groupKey, type: groupType, roomId, part, rows: groupRows }) => {
        if (groupType === 'mainRoof') {
          // 主屋根（最上階の建物範囲全体）の固定の群: 見出し「屋根（主屋根）」＋屋根の項目（MainRoofGroup）。セルを持たないため
          // 平面からは選ばれず、選択の枠は付けない。
          return (
            <div key={groupKey} style={{ marginBottom: 16 }}>
              <div style={{ display: 'flex', alignItems: 'center', marginBottom: 4 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: '#374151' }}>{part}</div>
              </div>
              <MainRoofGroup graph={graph} mode={mode} styles={{ cellBase, headerCell, cellInputStyle }} />
            </div>
          );
        }
        if (groupType === 'roof') {
          // 屋根（下屋）の群: 見出し「屋根」＋削除ボタン＋屋根の項目（RoofGroup。フォーム1行＋固定2行の表）。
          // 連動行・仕上げレベル行・改名入力・区分セレクタは出さない。削除は屋外部屋と同じ mode.deleteRoom。
          const roofRoom = graph.roomMap.get(roomId);
          return (
            <RoofGroupFrame key={groupKey} selected={isSelectedRoofGroup({ type: groupType, roomId }, mode.selectedRoomId)}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4, gap: 8 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: '#374151' }}>{part}</div>
                <button onClick={() => setDeleteConfirm({ roomId, roomName: part })} style={deleteButtonStyle}>
                  🗑️ 削除
                </button>
              </div>
              {roofRoom && <RoofGroup room={roofRoom} graph={graph} mode={mode} styles={{ cellBase, headerCell, cellInputStyle }} />}
            </RoofGroupFrame>
          );
        }
        const room   = roomId ? graph.roomMap.get(roomId) : null;
        const isExteriorRoomGroup = isExteriorRoomGroupRoom(room);
        return (
        <div key={groupKey} style={{ marginBottom: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4, gap: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, minWidth: 0 }}>
              {isExteriorRoomGroup
                ? <ExteriorPartHeading room={room} mode={mode} />
                : <div style={{ fontSize: 13, fontWeight: 700, color: '#374151' }}>{part || '（部位未設定）'}</div>
              }
              {isExteriorRoomGroup && (
                <select
                  value={room.kind}
                  onChange={e => {
                    const kind = e.target.value;
                    if (kind !== room.kind) onApplyNaming(room.id, { name: room.name, kind, feature: room.feature });
                  }}
                  style={{ ...cellInputStyle, width: 'auto', border: '1px solid #cbd5e1', padding: '2px 4px' }}
                >
                  {ROOM_KIND_OPTIONS.map(opt => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>
              )}
            </div>
            {isExteriorRoomGroup ? (
              // ユーザー裁定: 屋外部屋の群の削除はRoom連動（内部タブのカードと同じ削除ボタン・
              // 確認ダイアログ）。Room・連動行がまとめて1 undo エントリで消える（mode.deleteRoom）。
              <button onClick={() => setDeleteConfirm({ roomId, roomName: room.name })} style={deleteButtonStyle}>
                🗑️ 削除
              </button>
            ) : (
              <button
                onClick={() => withFinishUndo(graph, () => {
                  // roomId連動行（階段）はremoveExteriorRowsByRoomIdで、手入力行はpart一致で削除する
                  if (roomId) graph.removeExteriorRowsByRoomId(roomId);
                  else graph.removeExteriorRowGroup(category, part);
                })}
                style={{
                  fontSize: 11, color: '#94a3b8', background: 'none',
                  border: 'none', cursor: 'pointer', padding: '0 4px',
                }}
                title="部位を削除"
              >
                × 部位を削除
              </button>
            )}
          </div>
          {isExteriorRoomGroup && <ExteriorLevelRow room={room} graph={graph} />}
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
                      <ExteriorCell graph={graph} row={row} fieldKey={col.key} />
                    </td>
                  ))}
                  <td style={{ ...cellBase, textAlign: 'center', padding: '2px 4px' }}>
                    <button
                      onClick={() => withFinishUndo(graph, () => graph.removeExteriorRow(category, row.id))}
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
            onClick={() => withFinishUndo(graph, () => graph.addExteriorRow(category, part, roomId ?? null))}
            style={{
              marginTop: 4, fontSize: 12, color: '#2563eb', background: 'none',
              border: '1px dashed #93c5fd', borderRadius: 4, padding: '3px 10px', cursor: 'pointer',
            }}
          >
            ＋ 行を追加
          </button>
        </div>
        );
      })}
      <div style={{ marginTop: 8 }}>
        <select
          value=""
          onChange={e => {
            const part = e.target.value;
            if (part) withFinishUndo(graph, () => graph.addExteriorRow(category, part));
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
      <RoomDeleteConfirm graph={graph} mode={mode} deleteConfirm={deleteConfirm} onClose={() => setDeleteConfirm(null)} />
    </div>
  );
});

const ExteriorCell = observer(({ graph, row, fieldKey }) => (
  <input
    value={row[fieldKey]}
    onChange={e => row.setField(fieldKey, e.target.value)}
    onFocus={() => beginFieldUndo(graph)}
    onBlur={() => endFieldUndo(graph)}
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
