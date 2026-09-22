import { useState } from 'react';
import './CatalogResolveDialog.css';
import { CatalogKind, kindDef } from '../catalog/catalogKinds.js';
import { displayNameOf } from '../catalog/catalogMatch.js';
import { CATALOG_DIFF_COLOR, CATALOG_DIFF_MARK, diffPairs } from '../catalog/catalogDiffView.js';
import { buildMaterialRows } from '../catalog/catalogMaintenance.js';

const SCENARIO_LABELS = Object.freeze({
  'library-conflict': '(a) ライブラリ内の衝突',
  'unresolved-code':  '(b) 未解決の材コード',
  unsupported:        '(c) 未対応の項目',
  propose:            '類似材の提案',
});

function actionLabel(scenario, action) {
  if (action === 'approve') return '承認';
  if (action === 'pick') return scenario === 'propose' ? '別材を指示' : '代替材を指示';
  if (action === 'markOverride') return '本体材の編集として扱う';
  if (action === 'addToLibrary') return '置きかえずにライブラリへ追加';
  if (action === 'defer') return '保留';
  return action;
}

function usageSummary(usage) {
  if (!usage || usage.length === 0) return null;
  const byLocation = new Map();
  for (const u of usage) byLocation.set(u.location, (byLocation.get(u.location) ?? 0) + 1);
  return [...byLocation.entries()].map(([loc, n]) => `${loc}×${n}`).join('・');
}

/** 既定の決定: 候補があれば承認、無ければ保留。 */
function defaultDecision(row) {
  if (row.candidates.length > 0 && row.allowedActions.includes('approve')) {
    return { action: 'approve', pick: keyOfCandidate(row, row.candidates[0]) };
  }
  return { action: 'defer', pick: null };
}

function keyOfCandidate(row, candidate) {
  if (!candidate) return null;
  try {
    return kindDef(row.kind).keyOf(candidate);
  } catch {
    return null;
  }
}

/** 代替材ピッカー（buildMaterialRows再利用）。候補に無い材料も検索して選べる。 */
function MaterialPicker({ builtinList, value, onChange }) {
  const [search, setSearch] = useState('');
  const rows = builtinList ? buildMaterialRows({ builtinList, search }) : [];
  return (
    <div className="catresolve-picker">
      <input
        className="catresolve-picker-search"
        placeholder="材料名で検索"
        value={search}
        onChange={e => setSearch(e.target.value)}
      />
      <select className="catresolve-picker-select" value={value ?? ''} onChange={e => onChange(e.target.value || null)}>
        <option value="">（ライブラリから選ぶ）</option>
        {rows.map(r => (
          <option key={r.entry.code} value={r.entry.code}>{r.entry.name}（{r.entry.code}）</option>
        ))}
      </select>
    </div>
  );
}

function ResolveRow({ row, decision, onChange, builtinList }) {
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
            {actionLabel(row.scenario, action)}
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

      {decision.action === 'pick' && row.kind === CatalogKind.MATERIAL && (
        <MaterialPicker
          builtinList={builtinList}
          value={decision.pick}
          onChange={pick => onChange({ ...decision, pick })}
        />
      )}
    </div>
  );
}

/**
 * 指示UI（ステップ6-3・R10）。project.catalogResolveRows が非空のときApp.jsxが動的importして開く。
 * 描くだけ（純ロジックはcatalog/resolveQueue.js）。1画面に全行、行ごとに
 * 対象→差分→候補→操作、フッタに「まとめて承認」「すべて保留（閉じる）」。
 * 保留は記録しない——「すべて保留」はdecisionsを送らずonCloseするだけで、行はproject側に
 * 残ったまま次回の再計算で再掲される。
 * @param {{ rows: object[], builtinList: object[], onApply: (decisions: Map) => void, onClose: () => void }} props
 */
export function CatalogResolveDialog({ rows, builtinList, onApply, onClose }) {
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
              builtinList={builtinList}
            />
          ))}
        </div>
        <div className="catresolve-footer">
          <span className="catresolve-footer-note">材料コードの読み替えは文書を保存するまで確定しません（保存前に閉じると次回また確認します）。ライブラリへの追加・変更は承認時に保存されます</span>
          <button className="catresolve-btn catresolve-btn--primary" onClick={handleApplyAll}>まとめて承認</button>
          <button className="catresolve-btn catresolve-btn--secondary" onClick={onClose}>すべて保留（閉じる）</button>
        </div>
      </div>
    </div>
  );
}
