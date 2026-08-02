import { useState } from 'react';
import './AddCLDialog.css';
import { memberSizeKey } from '../structural/memberCatalog.js';
import { getGroupManualTag } from '../structural/memberGroups.js';

// sizeKey配列の降順比較（memberNumbering.js の compareGroupsDesc と同じ規約）。
// 負=aがbより大きい（先に来る）。
function compareSizeKeyDesc(a, b) {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const va = a[i] ?? 0, vb = b[i] ?? 0;
    if (va !== vb) return vb - va;
  }
  return 0;
}

/**
 * 統合の材寸採用ダイアログ（design-member-numbering-ui.md セクション3.3）。
 * AddCLDialog.css のクラス（ConfirmDialog.jsx と同じ流儀）を再利用した軽量ダイアログ。
 *
 * @param {Array<{ tag: string, members: object[] }>} groups 統合選択モードでチェックされた各グループ
 *   （members はこの階の部材配列。呼び出し側は members.length>=1 のものだけを渡すこと）
 * @param {string} mapName memberSizeKey の算出に使う（columnMap/beamMap/...）
 * @param {string} categoryLabel 内訳文言に使う部材種別名（例「梁」。group.label）
 * @param {(entity, mapName) => string} specLabel 材寸の表示ラベル関数（MemberListTab.summaryDims を渡す）
 * @param {object} project 吸収される側の手動タグ（grp.no）警告表示に使う（project.memberGroupLedger）
 * @param {() => void} onCancel
 * @param {(chosenIndex: number) => void} onConfirm
 */
export function MergeGroupsDialog({ groups, mapName, categoryLabel, specLabel, project, onCancel, onConfirm }) {
  const totalCount = groups.reduce((n, g) => n + g.members.length, 0);
  const sizeKeys = groups.map(g => memberSizeKey(g.members[0], mapName));
  // 既定は選択集合中の最大材寸（安全側）。同着は先勝ち（UIの既定値決定用途のため厳密なタイブレークは不要）。
  const maxIndex = sizeKeys.reduce((best, k, i) => (compareSizeKeyDesc(k, sizeKeys[best]) < 0 ? i : best), 0);
  const [chosenIndex, setChosenIndex] = useState(maxIndex);

  const chosenLabel = specLabel(groups[chosenIndex].members[0], mapName);
  // 採用spec以外で材寸が変わる（拡大/縮小）グループの内訳。縮小（cmp<0=採用specよりこのグループの方が大きい
  // ＝採用すると小さくなる）は警告色にする。
  const changed = groups
    .map((g, i) => ({ g, i, cmp: compareSizeKeyDesc(sizeKeys[i], sizeKeys[chosenIndex]) }))
    .filter(({ i, cmp }) => i !== chosenIndex && cmp !== 0);
  // 吸収される側（非採用）が手動タグ（grp.no）を持っていれば、統合で破棄される旨を警告する
  // （mergeGroups は吸収側の grp.no を必ず削除する。孤児化させないための仕様どおりの挙動をここで予告する）。
  const discardedManualTags = project
    ? groups
        .map((g, i) => ({ g, i }))
        .filter(({ i }) => i !== chosenIndex)
        .map(({ g }) => ({ g, manualTag: g.members[0]?.numberGroupId ? getGroupManualTag(project.memberGroupLedger, g.members[0].numberGroupId) : null }))
        .filter(({ manualTag }) => manualTag)
    : [];

  return (
    <>
      <div className="cl-dialog-backdrop" onPointerDown={onCancel} />
      <div className="cl-dialog" style={{ minWidth: 320 }}>
        <div className="cl-dialog-title">{groups.length}グループ・{totalCount}本 を統合します</div>
        <div style={{ fontSize: 12, color: '#475569' }}>採用する材寸を選んでください</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {groups.map((g, i) => (
            <label
              key={g.tag}
              style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer', minHeight: 36 }}
            >
              <input
                type="radio"
                name="merge-spec-choice"
                checked={chosenIndex === i}
                onChange={() => setChosenIndex(i)}
                style={{ width: 16, height: 16, flexShrink: 0, cursor: 'pointer' }}
              />
              <span>
                {specLabel(g.members[0], mapName)}
                <span style={{ color: '#64748b', fontSize: 12 }}>
                  {' '}（{i === maxIndex ? '最大・' : ''}{g.tag}）
                </span>
              </span>
            </label>
          ))}
        </div>
        {changed.map(({ g, cmp }) => (
          <div
            key={g.tag}
            style={{
              fontSize: 12, borderRadius: 4, padding: '6px 8px', lineHeight: 1.5,
              background: cmp < 0 ? '#fef2f2' : '#f1f5f9',
              color: cmp < 0 ? '#b91c1c' : '#475569',
              border: cmp < 0 ? '1px solid #fca5a5' : '1px solid #e2e8f0',
            }}
          >
            {cmp < 0 ? '⚠ ' : ''}
            {g.members.length}本の{categoryLabel ?? '部材'}が {specLabel(g.members[0], mapName)} → {chosenLabel} に{cmp < 0 ? '縮小' : '拡大'}されます
          </div>
        ))}
        {discardedManualTags.map(({ g, manualTag }) => (
          <div
            key={`manual-${g.tag}`}
            style={{ fontSize: 12, borderRadius: 4, padding: '6px 8px', lineHeight: 1.5, background: '#fef2f2', color: '#b91c1c', border: '1px solid #fca5a5' }}
          >
            ⚠ 手動番号「{manualTag}」は破棄されます
          </div>
        ))}
        <div className="cl-dialog-actions">
          <button type="button" className="cl-dialog-btn cl-dialog-btn--cancel" onClick={onCancel}>キャンセル</button>
          <button type="button" className="cl-dialog-btn cl-dialog-btn--ok" onClick={() => onConfirm(chosenIndex)}>統合する</button>
        </div>
      </div>
    </>
  );
}
