import { useState } from 'react';
import { observer } from 'mobx-react-lite';
import { AutoScaledFigure } from './AutoScaledFigure.jsx';
import {
  getLayoutOverrides, setLayoutOverride, resetLayoutOverrides, applyLayoutOverrides, LABEL_ID_SUFFIX,
} from './layoutStudy.js';

// ================================================================
// 部材リスト配置検討モード（UI）
//
// 断面図の各要素（layoutId付き）をクリックで選択し、矢印キーで移動して配置を詰める。
// 移動は layoutStudy のストアへ書き込み、本番の断面図へも即時反映される（同じ overrides を読むため）。
// 詰めた値は下部の JSON で確認でき、MEMBER_LAYOUT_OVERRIDES へ貼れば恒久化できる（“指示で即反映”の土台）。
//
// 操作：要素クリック=選択／↑↓←→=1mm移動（Shift=10mm）／Delete=その要素のオフセット解除／余白クリック=全位置をコンソール出力。
// ================================================================
export const MemberLayoutStudy = observer(function MemberLayoutStudy({ primitives, scope, title, onClose }) {
  const [selectedId, setSelectedId] = useState(null);
  const overrides = getLayoutOverrides(scope);
  const display = applyLayoutOverrides(primitives, overrides);

  // 図に含まれる全要素の layoutId（出現順・重複排除）。寸法は数値ラベルの独立移動分（::label）も含める。
  // 未移動も dx/dy=0 で含める＝“全要素の位置”。
  const allLayoutIds = [];
  for (const p of primitives) {
    if (!p.layoutId) continue;
    if (!allLayoutIds.includes(p.layoutId)) allLayoutIds.push(p.layoutId);
    if (p.type === 'dim') {
      const lid = `${p.layoutId}${LABEL_ID_SUFFIX}`;
      if (!allLayoutIds.includes(lid)) allLayoutIds.push(lid);
    }
  }
  const fullMap = Object.fromEntries(
    allLayoutIds.map(id => [id, { dx: overrides[id]?.dx ?? 0, dy: overrides[id]?.dy ?? 0 }]),
  );

  // 全要素の位置を、MEMBER_LAYOUT_OVERRIDES.<scope> へそのまま貼れる形でコンソールへ出す。
  function dumpAll() {
    console.log(`[配置検討] MEMBER_LAYOUT_OVERRIDES.${scope} に貼り付け可（全要素の位置）↓`);
    console.log(JSON.stringify(fullMap, null, 2));
  }

  // 要素外をクリック＝選択解除し、全要素の位置をコンソールへ出力する。
  function deselectAndDump() {
    setSelectedId(null);
    dumpAll();
  }

  function nudge(dx, dy) {
    if (!selectedId) return;
    const cur = overrides[selectedId] ?? { dx: 0, dy: 0 };
    setLayoutOverride(scope, selectedId, { dx: cur.dx + dx, dy: cur.dy + dy });
  }

  function handleKeyDown(e) {
    const step = e.shiftKey ? 10 : 1;
    if (e.key === 'ArrowUp')         { e.preventDefault(); nudge(0, -step); }
    else if (e.key === 'ArrowDown')  { e.preventDefault(); nudge(0,  step); }
    else if (e.key === 'ArrowLeft')  { e.preventDefault(); nudge(-step, 0); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); nudge( step, 0); }
    else if (e.key === 'Delete' || e.key === 'Backspace') {
      if (selectedId) { e.preventDefault(); setLayoutOverride(scope, selectedId, { dx: 0, dy: 0 }); }
    } else if (e.key === 'Escape') onClose();
  }

  const cur = selectedId ? (overrides[selectedId] ?? { dx: 0, dy: 0 }) : null;
  const json = JSON.stringify(fullMap, null, 2);

  return (
    <div
      tabIndex={0}
      autoFocus
      ref={el => el?.focus()}
      onKeyDown={handleKeyDown}
      style={{
        position: 'fixed', inset: 0, zIndex: 4000, background: 'rgba(15,23,42,0.55)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', outline: 'none',
      }}
      onClick={() => { dumpAll(); onClose(); }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{ background: '#fff', borderRadius: 8, padding: 16, width: 720, maxWidth: '92vw',
                 maxHeight: '90vh', overflow: 'auto', boxShadow: '0 10px 40px rgba(0,0,0,0.3)' }}
      >
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 8 }}>
          <strong style={{ fontSize: 14, color: '#1e293b' }}>部材リスト配置検討モード</strong>
          <span style={{ marginLeft: 8, fontSize: 12, color: '#64748b' }}>{title}（{scope}）</span>
          <span style={{ flex: 1 }} />
          <button onClick={() => resetLayoutOverrides(scope)} style={btnStyle}>リセット</button>
          <button onClick={onClose} style={{ ...btnStyle, marginLeft: 6 }}>閉じる</button>
        </div>
        <div style={{ fontSize: 12, color: '#64748b', marginBottom: 8 }}>
          要素をクリックで選択 → ↑↓←→で1mm移動（Shift=10mm）・Delete=解除・余白クリックで全位置をコンソール出力。
          {selectedId && (
            <span style={{ marginLeft: 8, color: '#2563eb' }}>
              選択: <code>{selectedId}</code> dx={cur.dx} dy={cur.dy}
            </span>
          )}
        </div>
        <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
          {/* 図の余白（要素以外）をクリック＝選択解除＋全要素の位置をコンソール出力。要素クリックは
              AutoScaledFigure 側で stopPropagation するためここには伝わらない。 */}
          <div style={{ border: '1px solid #e2e8f0', borderRadius: 6, padding: 8 }} onClick={deselectAndDump}>
            <AutoScaledFigure
              primitives={display}
              boundsPrimitives={primitives}
              maxWidth={440}
              maxHeight={440}
              study={{ selectedId, onSelectId: setSelectedId }}
            />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 11, color: '#94a3b8', marginBottom: 4 }}>
              全要素の位置（MEMBER_LAYOUT_OVERRIDES.{scope} へ貼れば指定）
            </div>
            <textarea
              readOnly
              value={json}
              style={{ width: '100%', height: 320, fontFamily: 'monospace', fontSize: 11,
                       border: '1px solid #e2e8f0', borderRadius: 6, padding: 8, resize: 'vertical' }}
            />
          </div>
        </div>
      </div>
    </div>
  );
});

const btnStyle = {
  fontSize: 12, padding: '3px 10px', border: '1px solid #cbd5e1', borderRadius: 4,
  background: '#f8fafc', cursor: 'pointer',
};
