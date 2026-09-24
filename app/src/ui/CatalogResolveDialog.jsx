import { useState } from 'react';
import './CatalogResolveDialog.css';
import { CatalogKind, kindDef } from '../catalog/catalogKinds.js';
import { displayNameOf } from '../catalog/catalogMatch.js';
import { CATALOG_DIFF_COLOR, CATALOG_DIFF_MARK, diffPairs } from '../catalog/catalogDiffView.js';
import { buildCatalogRows } from '../catalog/catalogMaintenance.js';
import { defaultResolveDecision, openingCategoryOf } from '../catalog/resolveQueue.js';

const SCENARIO_LABELS = Object.freeze({
  'library-conflict': '(a) ライブラリ内の衝突',
  'unresolved-code':  '(b) 未解決の参照',
  unsupported:        '(c) 未対応の項目',
  propose:            '類似項目の提案',
});

// ステップ7d QA指摘Minor-2: 「材料」固定の文言を種別非依存にする（材以外の行でも意味が通るように）。
function actionLabel(action) {
  if (action === 'approve') return '承認';
  if (action === 'pick') return '代替を指示';
  if (action === 'markOverride') return '本体の編集として扱う';
  if (action === 'addToLibrary') return '置きかえずにライブラリへ追加';
  if (action === 'defer') return '保留';
  return action;
}

// ステップ7d QA指摘Minor-5: usage の location（参照箇所の種類）を日本語化する唯一の対応表。
// ステップ8g: 断面（section）の未解決usageはgraph.columns/beams/structuralWalls/slabs/footings
// のいずれかをlocationに持つ（modes/StructuralModeState.js _missingSectionUsage参照）。
const LOCATION_LABELS = Object.freeze({
  floor: '階',
  room: '部屋',
  edge: '境界',
  clEccentricity: 'CL偏芯',
  exteriorWallBacking: '外壁下地',
  interiorWallBacking: '内壁下地',
  ceilingBacking: '天井下地',
  floorBacking: '床下地',
  opening: '建具',
  columns: '柱',
  beams: '梁',
  structuralWalls: '構造壁',
  slabs: 'スラブ',
  footings: '基礎',
});

function usageSummary(usage) {
  if (!usage || usage.length === 0) return null;
  const byLocation = new Map();
  for (const u of usage) byLocation.set(u.location, (byLocation.get(u.location) ?? 0) + 1);
  return [...byLocation.entries()].map(([loc, n]) => `${LOCATION_LABELS[loc] ?? loc}×${n}`).join('・');
}

// 既定の決定（候補があれば承認、proposeは既定defer、無ければ保留）は
// catalog/resolveQueue.js defaultResolveDecision が唯一の定義箇所（コーディネーター指摘・
// 2026-09-23: 「まとめて承認」で未接触のpropose行まで自動承認してしまわないための裁定を、
// ここと重複させず1箇所にまとめる）。
const defaultDecision = defaultResolveDecision;

function keyOfCandidate(row, candidate) {
  if (!candidate) return null;
  try {
    return kindDef(row.kind).keyOf(candidate);
  } catch {
    return null;
  }
}

/**
 * 代替の汎用ピッカー（ステップ7d QA指摘Major-1: 種別非依存のEntryPicker。旧MaterialPickerを
 * 一般化）。buildCatalogRows({kind, builtinList, search}) で kind の一覧を合成し、候補に無い
 * 項目も検索して選べる。value/optionの値は kindDef(kind).keyOf(entry)、表示名は displayNameOf。
 * categoryFilter（10b QA指摘Minor-3申し送り・ステップ10e）: openingSubType のときだけ渡され、
 * 一覧を同カテゴリ（fitting/window）だけに絞る——catalog/resolveQueue.js applyResolveDecisions の
 * pick/approve検証（カテゴリ跨ぎはrejected）と揃え、選べても弾かれるだけの選択肢を見せない。
 * category抽出は catalog/resolveQueue.js openingCategoryOf に一本化（QA指摘Minor-5）。
 */
function EntryPicker({ kind, builtinList, value, onChange, categoryFilter }) {
  const [search, setSearch] = useState('');
  const def = kindDef(kind);
  let rows = builtinList ? buildCatalogRows({ kind, builtinList, search }) : [];
  if (categoryFilter) rows = rows.filter(r => openingCategoryOf(def.keyOf(r.entry)) === categoryFilter);
  return (
    <div className="catresolve-picker">
      <input
        className="catresolve-picker-search"
        placeholder="名称で検索"
        value={search}
        onChange={e => setSearch(e.target.value)}
      />
      <select className="catresolve-picker-select" value={value ?? ''} onChange={e => onChange(e.target.value || null)}>
        <option value="">（ライブラリから選ぶ）</option>
        {rows.map(r => {
          const key = def.keyOf(r.entry);
          return <option key={key} value={key}>{displayNameOf(r.entry)}（{key}）</option>;
        })}
      </select>
    </div>
  );
}

function ResolveRow({ row, decision, onChange, builtinListByKind }) {
  const pickedCandidate = row.candidates.find(c => keyOfCandidate(row, c) === decision.pick) ?? row.candidates[0] ?? null;
  const diffTargetEntry = row.scenario === 'unresolved-code' ? null : row.targetEntry;
  const diffs = (diffTargetEntry && pickedCandidate) ? diffPairs(row.kind, diffTargetEntry, pickedCandidate) : [];
  const usage = usageSummary(row.usage);

  return (
    <div className="catresolve-row">
      <div className="catresolve-row-header">
        <span className="catresolve-scenario-badge">{SCENARIO_LABELS[row.scenario] ?? row.scenario}</span>
        <span className="catresolve-target-label">{row.targetLabel || row.targetKey}</span>
        <span className="catresolve-target-key">{row.targetKey}</span>
      </div>
      {usage && <div className="catresolve-usage">参照箇所: {usage}</div>}

      {diffs.length > 0 && (
        <div className="catresolve-diffs">
          {diffs.map(d => (
            <span key={d.field} className="catresolve-diff-pair" style={{ color: CATALOG_DIFF_COLOR }}>
              {d.label} {d.from ?? '（未設定）'} → {d.to ?? '（未設定）'} {CATALOG_DIFF_MARK}
            </span>
          ))}
        </div>
      )}

      {row.candidates.length === 0 && row.scenario !== 'library-conflict' && (
        <div className="catresolve-no-candidate">候補なし</div>
      )}

      <div className="catresolve-actions">
        {row.allowedActions.map(action => (
          <label key={action} className="catresolve-action-option">
            <input
              type="radio"
              name={`catresolve-action-${row.id}`}
              checked={decision.action === action}
              onChange={() => onChange({ ...decision, action })}
            />
            {actionLabel(action)}
          </label>
        ))}
      </div>

      {(decision.action === 'approve' || decision.action === 'pick') && row.candidates.length > 0 && (
        <div className="catresolve-candidate-picker">
          <select
            value={decision.pick ?? ''}
            disabled={decision.action === 'approve'}
            onChange={e => onChange({ ...decision, pick: e.target.value || null })}
          >
            {row.candidates.map(c => {
              const key = keyOfCandidate(row, c);
              return <option key={key} value={key}>{displayNameOf(c)}（{key}）</option>;
            })}
          </select>
        </div>
      )}

      {decision.action === 'pick' && builtinListByKind?.[row.kind] && (
        <EntryPicker
          kind={row.kind}
          builtinList={builtinListByKind[row.kind]}
          value={decision.pick}
          onChange={pick => onChange({ ...decision, pick })}
          categoryFilter={row.kind === CatalogKind.OPENING_SUB_TYPE ? openingCategoryOf(row.targetKey) : null}
        />
      )}
    </div>
  );
}

/**
 * 指示UI（ステップ6-3・自動では置き換えない原則）。project.catalogResolveRows が非空のときApp.jsxが動的importして開く。
 * 描くだけ（純ロジックはcatalog/resolveQueue.js）。1画面に全行、行ごとに
 * 対象→差分→候補→操作、フッタに「まとめて承認」「すべて保留（閉じる）」。
 * 保留は記録しない——「すべて保留」はdecisionsを送らずonCloseするだけで、行はproject側に
 * 残ったまま次回の再計算で再掲される。
 * @param {{ rows: object[], builtinListByKind: Record<string, object[]>, onApply: (decisions: Map) => void, onClose: () => void }} props
 */
export function CatalogResolveDialog({ rows, builtinListByKind, onApply, onClose }) {
  // 明示的にユーザーが触った行の決定だけを持つ（疎なMap）。rows は App.jsx 側で場面ごとに
  // 置き換えられる（replaceRowsByScenario）が、ここでは触っていない行の決定
  // （既定値=defaultDecision(row)）を都度row自身から算出するため、rowsが変わっても
  // 同期用のeffectは要らない（setState-in-effectのcascading render警告を避ける）。
  const [decisions, setDecisions] = useState(() => new Map());

  function updateDecision(rowId, next) {
    setDecisions(prev => new Map(prev).set(rowId, next));
  }

  function handleApplyAll() {
    // 触っていない行は defaultDecision（候補があれば先頭候補を承認）で解決してから渡す——
    // 「まとめて承認」は候補ありの行を一括承認するボタンのため、疎なMapのまま渡すと
    // 未接触行が保留（defer）扱いになってしまう。
    const resolved = new Map(rows.map(row => [row.id, decisions.get(row.id) ?? defaultDecision(row)]));
    onApply(resolved);
  }

  function handleKeyDown(e) {
    if (e.key === 'Escape') { e.stopPropagation(); onClose?.(); }
  }

  return (
    <div
      className="catresolve-backdrop"
      onPointerDown={e => { if (e.target === e.currentTarget) onClose?.(); }}
      onKeyDown={handleKeyDown}
    >
      <div className="catresolve-panel">
        <div className="catresolve-header">
          <span>カタログの確認事項（{rows.length}件）</span>
          <button className="catresolve-close-btn" onClick={onClose}>閉じる</button>
        </div>
        <div className="catresolve-body">
          {rows.map(row => (
            <ResolveRow
              key={row.id}
              row={row}
              decision={decisions.get(row.id) ?? defaultDecision(row)}
              onChange={next => updateDecision(row.id, next)}
              builtinListByKind={builtinListByKind}
            />
          ))}
        </div>
        <div className="catresolve-footer">
          <span className="catresolve-footer-note">読み替えは文書を保存するまで確定しません（保存前に閉じると次回また確認します）。ライブラリへの追加・変更は承認時に保存されます</span>
          <button className="catresolve-btn catresolve-btn--primary" onClick={handleApplyAll}>まとめて承認</button>
          <button className="catresolve-btn catresolve-btn--secondary" onClick={onClose}>すべて保留（閉じる）</button>
        </div>
      </div>
    </div>
  );
}
