import { useEffect, useRef } from 'react';
import { observer } from 'mobx-react-lite';
import { SiteLineKind } from '@core';
import { getSiteLineRedBlue } from '../site/siteGeometry.js';
import { isSanshaKind, computeLineTriNums } from '../site/lineClassification.js';
import { NumPad } from './NumPad.jsx';
import { applyKeyToNumpadValue, toNumpadKey, evalNumpadExpr } from './numpadUtils.js';
import { ModePanel } from './ModePanel.jsx';
import { BottomSheet } from './BottomSheet.jsx';

const KIND_LABEL = {
  [SiteLineKind.BOUNDARY]:   '境界',
  [SiteLineKind.ROAD]:       '道路境界',
  [SiteLineKind.SURVEY]:     '測量',
  [SiteLineKind.ROAD_WIDTH]: '道路幅員',
  [SiteLineKind.OTHER]:      'その他',
};

function makePointIndex(site) {
  return new Map([...site.pointMap.keys()].map((id, i) => [id, i + 1]));
}

// 三角形一覧を底辺長・高さ・面積付きで返す（面積タブ用）
function computeAreaRows(site) {
  const triByLine = new Map([...site.triangleMap.values()].map(t => [t.baseLine.id, t]));
  const rows = [];
  let triNum = 0;
  for (const line of site.lines) {
    const tri = triByLine.get(line.id);
    if (!tri) continue;
    triNum++;
    const base   = line.length;
    const area   = tri.area;
    const height = base > 1e-6 ? (area * 2_000_000) / base : 0;
    rows.push({ num: triNum, base, height, area });
  }
  return rows;
}

// 式文字列を評価して数値を返す。無効なら NaN
const evalExpr = (s) => evalNumpadExpr(s, { positiveOnly: true });

const TH_BASE = {
  padding: '4px 6px',
  background: '#f1f5f9',
  borderBottom: '1px solid #e2e8f0',
  whiteSpace: 'nowrap',
  textAlign: 'center',
  color: '#475569',
  fontWeight: 600,
  fontSize: 11,
};
const TD_BASE = {
  padding: '4px 6px',
  borderBottom: '1px solid #f1f5f9',
  textAlign: 'center',
  color: '#1e293b',
  fontSize: 11,
  userSelect: 'none',
  whiteSpace: 'nowrap',
};

export const SiteInfoPanel = observer(({ site, mode, isLandscape, onSelectLine, onConfirmLineLen, onConfirmTriangle, onCycleLineKind }) => {
  const subMode   = mode.subMode;
  const ptIdx     = makePointIndex(site);

  const sanshaLines = site.orderedLines.filter(l => isSanshaKind(l.lineKind));
  const otherLines  = site.orderedLines.filter(l => !isSanshaKind(l.lineKind));
  const lineTriNums = computeLineTriNums(site);
  const areaRows    = computeAreaRows(site);
  const totalArea   = areaRows.reduce((s, r) => s + r.area, 0);

  // 選択中の行へスクロール（描画エリアでの線分クリック時など）
  const selectedRowRef = useRef(null);
  useEffect(() => {
    selectedRowRef.current?.scrollIntoView({ block: 'nearest' });
  }, [mode.selectedLineId, subMode]);

  // 長さフィールド入力中の外クリック
  // - 数値入力後の外クリックは確定（キャンセルではない）
  // - 空欄での外クリックは、有効な確定値に戻して確定相当
  const lenFieldRef = useRef(null);
  useEffect(() => {
    if (mode.inputState?.focusedCell !== 'len') return;
    const onPointerDown = (e) => {
      if (lenFieldRef.current?.contains(e.target)) return;
      const val = evalExpr(mode.inputState?.lenValue);
      if (isFinite(val) && val > 0) {
        onConfirmLineLen?.();
      } else if (mode.inputState.lenEditing) {
        mode.clearInput();
      } else {
        mode.setFocusedCell('red');
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [mode.inputState, mode, onConfirmLineLen]);

  // キーボード入力（inputState 表示中のみ）
  useEffect(() => {
    if (!mode.inputState) return;
    const onKey = (e) => {
      if (e.key === 'Escape') {
        mode.clearInput();
      } else if (e.key === 'Enter') {
        if (mode.inputState.focusedCell === 'len') {
          onConfirmLineLen?.();
        } else if (mode.inputState.focusedCell === 'red') {
          mode.setFocusedCell('blue');
        } else {
          onConfirmTriangle?.();
        }
      } else if (e.key === 'Tab') {
        // バッヂ1個（線分b）の線分を巡回。編集ボタン経由のロック解除中は対象外
        if (mode.inputState.lenEditing) return;
        const candidates = sanshaLines.filter(l => (lineTriNums.get(l.id)?.length ?? 0) === 1);
        if (candidates.length === 0) return;
        e.preventDefault();
        const curIdx = candidates.findIndex(l => l.id === mode.selectedLineId);
        const dir    = e.shiftKey ? -1 : 1;
        const nextIdx = curIdx === -1
          ? (dir === 1 ? 0 : candidates.length - 1)
          : (curIdx + dir + candidates.length) % candidates.length;
        mode.selectLine(candidates[nextIdx].id);
      } else {
        const numpadKey = toNumpadKey(e.key);
        if (numpadKey != null) {
          e.preventDefault();
          const cur = mode.inputState.focusedCell === 'red'
            ? mode.inputState.redLen
            : mode.inputState.focusedCell === 'blue'
            ? mode.inputState.blueLen
            : mode.inputState.lenValue;
          mode.setInputValue(applyKeyToNumpadValue(cur, numpadKey));
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [mode.inputState, mode, onConfirmTriangle, onConfirmLineLen, lineTriNums, sanshaLines]);

  const inner = (
    <>
      {/* タブヘッダー */}
      <div style={{ display: 'flex', borderBottom: '1px solid #e2e8f0', flexShrink: 0 }}>
        {[
          { key: 'sansha', label: '三斜' },
          { key: 'area',   label: '面積' },
          { key: 'other',  label: 'その他' },
        ].map(tab => (
          <button
            key={tab.key}
            onClick={() => mode.setSubMode(tab.key)}
            style={{
              flex: 1, padding: '10px 0',
              border: 'none',
              borderBottom: subMode === tab.key ? '2px solid #2563eb' : '2px solid transparent',
              background: 'none', cursor: 'pointer',
              fontSize: 13,
              fontWeight: subMode === tab.key ? 700 : 400,
              color: subMode === tab.key ? '#2563eb' : '#64748b',
              transition: 'all 0.1s',
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* テーブル */}
      <div style={{ flex: 1, overflowY: 'auto', overflowX: 'auto' }}>
        {subMode === 'sansha' ? (
          // ---- 三斜タブ（1線1行） ----
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={{ ...TH_BASE, width: 32 }}>番号</th>
                <th style={TH_BASE}>線分長さ</th>
                <th style={{ ...TH_BASE, width: 40 }}>編集</th>
                <th style={TH_BASE}>線種</th>
                <th style={{ ...TH_BASE, width: 56 }}>三角番号</th>
              </tr>
            </thead>
            <tbody>
              {sanshaLines.flatMap((line, idx) => {
                const isSelected = line.id === mode.selectedLineId;
                const kindLabel  = KIND_LABEL[line.lineKind];
                const triNums    = lineTriNums.get(line.id) ?? [];

                const inp        = isSelected ? mode.inputState : null;
                const lenFocused = inp?.focusedCell === 'len';
                const lenEditing = isSelected && !!inp?.lenEditing;

                const lenDisplay = inp
                  ? (inp.lenValue || (inp.focusedCell !== 'len' ? line.length.toFixed(0) : ''))
                  : line.length.toFixed(0);

                const td    = { ...TD_BASE, background: isSelected ? '#eff6ff' : undefined };
                const tdLen = {
                  ...td,
                  background: lenFocused ? '#f0fdf4' : isSelected ? '#dcfce7' : undefined,
                  outline:    lenFocused ? '2px solid #22c55e' : 'none',
                };
                const tdKind = { ...td, cursor: 'pointer' };

                // 行クリック（非選択時に選択）
                const handleRowClick = () => {
                  if (!isSelected) onSelectLine?.(line.id);
                };

                // 線種クリック（確定済み行のみ循環切替）
                const handleKindClick = e => {
                  e.stopPropagation();
                  if (!isSelected) onSelectLine?.(line.id);
                  onCycleLineKind?.(line.id);
                };

                // 編集ボタン：長さフィールドのロックを解除
                const handleEditClick = e => {
                  e.stopPropagation();
                  mode.startLenEdit(line.id);
                };

                const rows = [
                  <tr
                    key={line.id}
                    ref={isSelected ? selectedRowRef : undefined}
                    onClick={handleRowClick}
                    style={{ cursor: 'pointer' }}
                  >
                    <td style={{ ...td, fontWeight: 600 }}>{idx + 1}</td>
                    <td style={tdLen} ref={lenFocused ? lenFieldRef : undefined}>{lenDisplay}</td>
                    <td style={td}>
                      {triNums.length > 0 && !lenEditing && (
                        <button
                          onClick={handleEditClick}
                          style={{
                            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                            width: 22, height: 22, padding: 0,
                            border: '1px solid #cbd5e1', borderRadius: 4,
                            background: '#fff', cursor: 'pointer',
                            fontSize: 11, lineHeight: 1, color: '#475569',
                          }}
                          title="長さを編集"
                        >
                          ✎
                        </button>
                      )}
                    </td>
                    <td style={tdKind} onClick={handleKindClick}>{kindLabel}</td>
                    <td style={td}>
                      {triNums.length === 0 ? '-' : triNums.map(n => (
                        <span key={n} style={{
                          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                          width: 16, height: 16, borderRadius: '50%',
                          border: '1px solid #334155', marginInline: 1,
                          fontSize: 9, lineHeight: 1,
                        }}>{n}</span>
                      ))}
                    </td>
                  </tr>,
                ];

                // 三角形未確定の選択行 → 赤辺・青辺の入力行を追加（線種は表中で循環切替）
                if (isSelected && inp && inp.redLen !== undefined) {
                  const nextNum = site.triangleMap.size + 1;
                  const badge = (color) => (
                    <span style={{
                      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                      width: 16, height: 16, borderRadius: '50%',
                      border: `1px solid ${color}`, color,
                      fontSize: 9, lineHeight: 1,
                    }}>{nextNum}</span>
                  );
                  const edgeRow = (color, label, lenKey, kindKey, bgFocused, bgIdle) => {
                    const focused = inp.focusedCell === color;
                    return (
                      <tr
                        key={`${line.id}-${color}`}
                        onClick={() => {
                          // 線分長さ入力中に赤/青行へ移動する場合は、先に線分長さを確定する
                          if (inp.focusedCell === 'len') onConfirmLineLen?.();
                          mode.setFocusedCell(color);
                        }}
                        style={{ cursor: 'pointer' }}
                      >
                        <td style={{ ...TD_BASE, color: label === '赤' ? '#ef4444' : '#3b82f6', fontWeight: 600 }}>{label}</td>
                        <td style={{
                          ...TD_BASE,
                          background: focused ? bgFocused : bgIdle,
                          outline:    focused ? `2px solid ${label === '赤' ? '#ef4444' : '#3b82f6'}` : 'none',
                          cursor:     'pointer',
                        }}>{inp[lenKey] || ' '}</td>
                        <td style={TD_BASE} />
                        <td style={tdKind} onClick={e => { e.stopPropagation(); mode.cycleEdgeKind(color); }}>
                          {KIND_LABEL[inp[kindKey]]}
                        </td>
                        <td style={TD_BASE}>{badge(label === '赤' ? '#ef4444' : '#3b82f6')}</td>
                      </tr>
                    );
                  };
                  rows.push(edgeRow('red',  '赤', 'redLen',  'redKind',  '#fef2f2', '#fff7f7'));
                  rows.push(edgeRow('blue', '青', 'blueLen', 'blueKind', '#eff6ff', '#f7f9ff'));
                }

                return rows;
              })}
              {sanshaLines.length === 0 && (
                <tr>
                  <td colSpan={5} style={{ ...TD_BASE, color: '#94a3b8', padding: '20px', textAlign: 'center' }}>
                    線分がありません
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        ) : subMode === 'area' ? (
          // ---- 面積タブ ----
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={{ ...TH_BASE, width: 48 }}>番号</th>
                <th style={TH_BASE}>計算式</th>
                <th style={{ ...TH_BASE, width: 80 }}>面積(㎡)</th>
              </tr>
            </thead>
            <tbody>
              {areaRows.map(({ num, base, height, area }) => (
                <tr key={num}>
                  <td style={TD_BASE}>{num}</td>
                  <td style={TD_BASE}>{`${base.toFixed(0)} × ${height.toFixed(0)} ÷ 2`}</td>
                  <td style={TD_BASE}>{area.toFixed(2)}</td>
                </tr>
              ))}
              {areaRows.length === 0 && (
                <tr>
                  <td colSpan={3} style={{ ...TD_BASE, color: '#94a3b8', padding: '20px', textAlign: 'center' }}>
                    三角形がありません
                  </td>
                </tr>
              )}
              <tr>
                <td colSpan={2} style={{ ...TD_BASE, fontWeight: 700, borderTop: '2px solid #cbd5e1' }}>合計</td>
                <td style={{ ...TD_BASE, fontWeight: 700, borderTop: '2px solid #cbd5e1' }}>{totalArea.toFixed(2)}</td>
              </tr>
            </tbody>
          </table>
        ) : (
          // ---- その他タブ ----
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={TH_BASE}>番号</th>
                <th style={{ ...TH_BASE, background: '#fee2e2', color: '#dc2626' }}>赤端点</th>
                <th style={TH_BASE}>線分長さ</th>
                <th style={{ ...TH_BASE, background: '#dbeafe', color: '#2563eb' }}>青端点</th>
                <th style={TH_BASE}>線種</th>
              </tr>
            </thead>
            <tbody>
              {otherLines.map((line, idx) => {
                const isSelected = line.id === mode.selectedLineId;
                const rowBg = isSelected ? '#eff6ff' : undefined;
                const td    = { ...TD_BASE, background: rowBg };
                const tdR   = { ...td, background: isSelected ? '#fce7f3' : '#fff1f2' };
                const tdB   = { ...td, background: isSelected ? '#dbeafe' : '#eff6ff' };
                const { red, blue } = getSiteLineRedBlue(line);

                return (
                  <tr
                    key={line.id}
                    style={{ cursor: 'pointer' }}
                    onClick={() => onSelectLine?.(line.id)}
                  >
                    <td style={td}>{idx + 1}</td>
                    <td style={tdR}>P{ptIdx.get(red.id)  ?? '-'}</td>
                    <td style={td}>{line.length.toFixed(0)}</td>
                    <td style={tdB}>P{ptIdx.get(blue.id) ?? '-'}</td>
                    <td style={td}>{KIND_LABEL[line.lineKind]}</td>
                  </tr>
                );
              })}
              {otherLines.length === 0 && (
                <tr>
                  <td colSpan={5} style={{ ...TD_BASE, color: '#94a3b8', padding: '20px', textAlign: 'center' }}>
                    線分がありません
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>

      {/* NumPad — 三斜タブで行選択中のみ表示 */}
      {subMode === 'sansha' && mode.inputState && (() => {
        const fc = mode.inputState.focusedCell;
        const numpadValue   = fc === 'len' ? mode.inputState.lenValue
                            : fc === 'red' ? mode.inputState.redLen
                            : mode.inputState.blueLen;
        const numpadLabel   = fc === 'len' ? '線分長さ' : fc === 'red' ? '赤辺長' : '青辺長';
        const numpadConfirm = fc === 'len' ? onConfirmLineLen : onConfirmTriangle;
        return (
          <NumPad
            value={numpadValue}
            label={numpadLabel}
            onChange={val => mode.setInputValue(val)}
            onConfirm={numpadConfirm}
            onCancel={() => mode.clearInput()}
            hideDisplay
          />
        );
      })()}
    </>
  );

  return isLandscape
    ? <ModePanel width={360}>{inner}</ModePanel>
    : <BottomSheet title="敷地" initialSnap={0.5} raiseSignal={mode.selectedLineId}>{inner}</BottomSheet>;
});
