import { useEffect, useRef, useState } from 'react';
import { observer } from 'mobx-react-lite';
import { isSanshaKind, computeLineTriNums, computeOuterLineIds } from '../site/lineClassification.js';
import { siteLineKindLabel } from '../site/siteLineStyle.js';
import { rowDeleteAction, triangleNumber } from '../site/triangleDeletion.js';
import {
  buildSanshaAreaRows, buildRectAreaRows, sumAreaM2, rectsOverlap, formatAreaM2,
} from '../site/siteArea.js';
import { NumPad } from './NumPad.jsx';
import { applyKeyToNumpadValue, toNumpadKey, evalNumpadExpr } from './numpadUtils.js';
import { ModePanel } from './ModePanel.jsx';
import { BottomSheet } from './BottomSheet.jsx';
import {
  buildRectTableRows, buildOutlineRows, rectInputRowDefs, rectFocusedValue, rectNumpadLabel, rectEnterAction, rectAnchorLabel, rectEditCell, rectEditColumnValue,
} from '../site/siteRectInput.js';

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
// タップで編集を始める数値フィールド（三斜の線分長さ・長方形のよこ/たて）
const FIELD_SPAN = {
  display: 'inline-block', minWidth: 32,
  border: '1px solid #cbd5e1', borderRadius: 4, background: '#fff',
  padding: '2px 6px', cursor: 'pointer',
};
// 表内の小さなアイコンボタン（三斜・長方形の 🗑）
const ICON_BTN = {
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  width: 22, height: 22, padding: 0,
  border: '1px solid #cbd5e1', borderRadius: 4,
  background: '#fff', cursor: 'pointer',
  fontSize: 11, lineHeight: 1, color: '#475569',
};
// ゴミ箱アイコン（削除）。絵文字は小さく薄く出るため、濃い線のインライン SVG で描く（色は番号バッジと同じ #334155）。
// コンポーネントでなく要素の定数（react-refresh/only-export-components を避ける）
const TRASH_ICON = (
  <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="#334155" strokeWidth={2.5}
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ display: 'inline-block', verticalAlign: 'middle' }}>
    <path d="M3 6h18" />
    <path d="M8 6V4h8v2" />
    <path d="M6 6l1 14h10l1-14" />
    <path d="M10 11v6M14 11v6" />
  </svg>
);
const TD_BASE = {
  padding: '4px 6px',
  borderBottom: '1px solid #f1f5f9',
  textAlign: 'center',
  color: '#1e293b',
  fontSize: 11,
  userSelect: 'none',
  whiteSpace: 'nowrap',
};

export const SiteInfoPanel = observer(({ site, mode, isLandscape, onSelectLine, onConfirmLineLen, onConfirmTriangle, onConfirmRect, onCycleLineKind, onToggleRectRoadSide, onStartRectEdit, onDeleteRect, onDeleteSiteRow }) => {
  const subMode   = mode.subMode;

  const sanshaLines = site.orderedLines.filter(l => isSanshaKind(l.lineKind));
  const lineTriNums = computeLineTriNums(site);
  const outerIds    = computeOuterLineIds(site);
  // 面積行（三斜・長方形タブ共通）。▶ の内訳は三斜だけ（長方形は表自体が求積表＝内訳を兼ねる）
  const [areaOpen, setAreaOpen] = useState(false);
  const showArea    = subMode === 'sansha' || subMode === 'rect';
  const rectAreaRows = buildRectAreaRows(site.rects); // rects と同順（長方形タブの表の小計に使う）
  const areaRows    = !showArea ? [] : subMode === 'rect' ? rectAreaRows : buildSanshaAreaRows(site);
  const totalArea   = sumAreaM2(areaRows);
  const areaOverlap = subMode === 'rect' && rectsOverlap(site.rects);

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
    if (mode.inputState?.focusedCell !== 'len' || subMode === 'rect') return;
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
  }, [mode.inputState, mode, subMode, onConfirmLineLen]);

  // キーボード入力（inputState 表示中のみ）
  useEffect(() => {
    if (!mode.inputState || subMode === 'rect') return; // 長方形タブでは三斜の入力状態（残っていても）を動かさない
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
        // バッヂ1個（線分b）の線分を巡回。長さセルのタップによるロック解除中は対象外
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
  }, [mode.inputState, mode, subMode, onConfirmTriangle, onConfirmLineLen, lineTriNums, sanshaLines]);

  // 長方形入力のキーボード（rectInputState 表示中のみ。三斜側の keydown とは別 effect）
  useEffect(() => {
    if (!mode.rectInputState || subMode !== 'rect') return;
    const onKey = (e) => {
      const st = mode.rectInputState;
      if (e.key === 'Escape') {
        mode.clearRectInput();
      } else if (e.key === 'Enter') {
        const act = rectEnterAction(st);
        if (act?.type === 'focus') mode.setRectFocusedCell(act.cell);
        else if (act?.type === 'confirm') onConfirmRect?.();
      } else {
        const numpadKey = toNumpadKey(e.key);
        if (numpadKey != null) {
          e.preventDefault();
          mode.setRectInputValue(applyKeyToNumpadValue(rectFocusedValue(st), numpadKey));
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [mode.rectInputState, mode, subMode, onConfirmRect]);

  const rectTable = buildRectTableRows(site.rects);
  const outlineRows = buildOutlineRows(site.rects);
  const rectIn     = mode.rectInputState;
  const rectSelId  = mode.selectedRectEdge?.rectId ?? null;
  // 入力行・基点行を出す行。修正中は基の長方形ではなく修正対象の行
  const inputOwnerId = rectIn?.editRectId ?? rectSelId;
  // 入力行（よこ/たて・辺長/奥行）。行クリックでフォーカス移動
  const rectInputRows = (keyPrefix) => rectInputRowDefs(rectIn).map(d => {
    const focused = rectIn.focusedCell === d.cell;
    return (
      <tr key={`${keyPrefix}-${d.cell}`} onClick={() => mode.setRectFocusedCell(d.cell)} style={{ cursor: 'pointer' }}>
        <td style={{ ...TD_BASE, color: '#2563eb', fontWeight: 600 }}>{d.label}</td>
        <td colSpan={6} style={{
          ...TD_BASE,
          background: focused ? '#f0fdf4' : '#f7fdf9',
          outline:    focused ? '2px solid #22c55e' : 'none',
        }}>{d.value || ' '}</td>
      </tr>
    );
  });

  const inner = (
    <>
      {/* タブヘッダー */}
      <div style={{ display: 'flex', borderBottom: '1px solid #e2e8f0', flexShrink: 0 }}>
        {[
          { key: 'sansha', label: '三斜' },
          { key: 'rect',   label: '長方形' },
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

      {/* 面積行（三斜・長方形タブ共通。▶ の内訳は三斜だけ。長方形は下の表が内訳を兼ねる） */}
      {showArea && (
        <div style={{ flexShrink: 0, borderBottom: '1px solid #e2e8f0' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 8px', fontSize: 13, color: '#1e293b' }}>
            {subMode === 'sansha' && (
              <button
                onClick={() => setAreaOpen(o => !o)}
                title="内訳"
                style={{ ...ICON_BTN, fontSize: 10 }}
              >{areaOpen ? '▼' : '▶'}</button>
            )}
            <span style={{ fontWeight: 700 }}>面積：</span>
            <span>{formatAreaM2(totalArea)}</span>
            <span>㎡</span>
            {areaOverlap && <span style={{ color: '#94a3b8', fontSize: 11 }}>（重なりあり）</span>}
          </div>
          {areaOpen && subMode === 'sansha' && (
            <div style={{ maxHeight: 160, overflowY: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    <th style={{ ...TH_BASE, width: 48 }}>番号</th>
                    <th style={{ ...TH_BASE, textAlign: 'right' }}>計算式</th>
                    <th style={{ ...TH_BASE, width: 16 }} />
                    <th style={{ ...TH_BASE, width: 80, textAlign: 'right' }}>小計(㎡)</th>
                  </tr>
                </thead>
                <tbody>
                  {areaRows.map(({ num, formula, areaM2 }) => (
                    <tr key={num}>
                      <td style={TD_BASE}>{num}</td>
                      {/* 求積表の書式: 「底辺 × 高さ × 1/2 ＝ 小計」。式は = に寄せて右揃え、小計は等幅数字で桁を揃える */}
                      <td style={{ ...TD_BASE, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{formula}</td>
                      <td style={{ ...TD_BASE, padding: '4px 2px' }}>=</td>
                      <td style={{ ...TD_BASE, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{formatAreaM2(areaM2)}</td>
                    </tr>
                  ))}
                  {areaRows.length === 0 && (
                    <tr>
                      <td colSpan={4} style={{ ...TD_BASE, color: '#94a3b8', padding: '12px', textAlign: 'center' }}>
                        {subMode === 'rect' ? '長方形がありません' : '三角形がありません'}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* テーブル */}
      <div style={{ flex: 1, overflowY: 'auto', overflowX: 'auto' }}>
        {subMode === 'sansha' ? (
          // ---- 三斜タブ（1線1行） ----
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={{ ...TH_BASE, width: 32 }}>番号</th>
                <th style={TH_BASE}>線分長さ</th>
                <th style={TH_BASE}>線種</th>
                <th style={{ ...TH_BASE, width: 56 }}>三角番号</th>
                <th style={{ ...TH_BASE, width: 40 }} title="削除">{TRASH_ICON}</th>
              </tr>
            </thead>
            <tbody>
              {sanshaLines.flatMap((line, idx) => {
                const isSelected = line.id === mode.selectedLineId;
                const isOuter    = outerIds.has(line.id);
                const kindLabel  = siteLineKindLabel(isOuter, line.lineKind);
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
                // 内側の線は線種セルをタップ不可（カーソル・ハンドラなし）
                const tdKind = { ...td, cursor: isOuter ? 'pointer' : undefined };

                // 行クリック（非選択時に選択）
                const handleRowClick = () => {
                  if (!isSelected) onSelectLine?.(line.id);
                };

                // 線種クリック（確定済み行のみ道路指定の切替〔無指定⇄道路〕）
                const handleKindClick = e => {
                  e.stopPropagation();
                  if (!isSelected) onSelectLine?.(line.id);
                  onCycleLineKind?.(line.id);
                };

                // 長さセルのタップ：長さフィールドのロックを解除
                const handleEditClick = e => {
                  e.stopPropagation();
                  mode.startLenEdit(line.id);
                };

                // 削除（端の三角形の赤辺・青辺の行、または三角形が無いときの最初の1本だけ）
                const delAction = rowDeleteAction(site, line.id);
                const delTitle = delAction?.type === 'triangle'
                  ? `三角形 ${triangleNumber(site, delAction.triangleId)} を削除`
                  : '線分を削除';
                const handleDeleteClick = e => {
                  e.stopPropagation();
                  onDeleteSiteRow?.(line.id);
                };

                const rows = [
                  <tr
                    key={line.id}
                    ref={isSelected ? selectedRowRef : undefined}
                    onClick={handleRowClick}
                    style={{ cursor: 'pointer' }}
                  >
                    <td style={{ ...td, fontWeight: 600 }}>{idx + 1}</td>
                    {triNums.length > 0 && !lenEditing && !lenFocused ? (
                      <td style={td}>
                        <span onClick={handleEditClick} style={FIELD_SPAN} title="長さを編集">{lenDisplay}</span>
                      </td>
                    ) : (
                      <td style={tdLen} ref={lenFocused ? lenFieldRef : undefined}>{lenDisplay}</td>
                    )}
                    <td style={tdKind} onClick={isOuter ? handleKindClick : undefined}>{kindLabel}</td>
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
                    <td style={td}>
                      {delAction && (
                        <button onClick={handleDeleteClick} style={ICON_BTN} title={delTitle}>{TRASH_ICON}</button>
                      )}
                    </td>
                  </tr>,
                ];

                // 三角形未確定の選択行 → 赤辺・青辺の入力行を追加（線種は表中で道路指定の切替〔無指定⇄道路〕）
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
                        <td style={tdKind} onClick={e => { e.stopPropagation(); mode.cycleEdgeKind(color); }}>
                          {siteLineKindLabel(true, inp[kindKey])}
                        </td>
                        <td style={TD_BASE}>{badge(label === '赤' ? '#ef4444' : '#3b82f6')}</td>
                        <td style={TD_BASE} />
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
        ) : subMode === 'rect' ? (
          // ---- 長方形タブ（求積表＝内訳を兼ねる: 番号／よこ × たて／=／小計／🗑。合計は見出し直下の「面積：」行）＋外周表（辺ごとの道路指定） ----
          <>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={{ ...TH_BASE, width: 40 }}>番号</th>
                <th colSpan={3} style={TH_BASE}>よこ × たて</th>
                <th style={{ ...TH_BASE, width: 16 }} />
                <th style={{ ...TH_BASE, width: 72, textAlign: 'right' }}>小計(㎡)</th>
                <th style={{ ...TH_BASE, width: 36 }} title="削除">{TRASH_ICON}</th>
              </tr>
            </thead>
            <tbody>
              {rectTable.rows.flatMap((row, idx) => {
                const isSel = row.id === inputOwnerId;
                const td = { ...TD_BASE, background: isSel ? '#eff6ff' : undefined };
                const editing = rectIn?.editRectId === row.id;
                // よこ・たて セル: 修正中＝その場の入力欄、修正可＝タップで修正開始の枠付き数値、不可＝素の数値。
                // よこ は × に寄せて右揃え、たて は左揃え（式として読めるように）
                const dimCell = (col, value) => {
                  const align = { textAlign: col === 'w' ? 'right' : 'left', fontVariantNumeric: 'tabular-nums' };
                  if (editing) {
                    const cell = rectEditCell(rectIn, col);
                    const focused = rectIn.focusedCell === cell;
                    return (
                      <td
                        style={{
                          ...td, ...align, cursor: 'pointer',
                          background: focused ? '#f0fdf4' : '#dcfce7',
                          outline:    focused ? '2px solid #22c55e' : 'none',
                        }}
                        onClick={() => mode.setRectFocusedCell(cell)}
                      >{rectEditColumnValue(rectIn, col) || ' '}</td>
                    );
                  }
                  if (row.canEdit) {
                    return (
                      <td style={{ ...td, ...align }}>
                        <span
                          onClick={() => onStartRectEdit?.(row.id, col)}
                          style={FIELD_SPAN}
                        >{value}</span>
                      </td>
                    );
                  }
                  return <td style={{ ...td, ...align }}>{value}</td>;
                };
                const out = [
                  <tr key={row.id}>
                    <td style={{ ...td, fontWeight: 600 }}>{row.num}</td>
                    {dimCell('w', row.w.toFixed(0))}
                    <td style={{ ...td, padding: '4px 2px' }}>×</td>
                    {dimCell('h', row.h.toFixed(0))}
                    <td style={{ ...td, padding: '4px 2px' }}>=</td>
                    <td style={{ ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{formatAreaM2(rectAreaRows[idx].areaM2)}</td>
                    <td style={td}>
                      {row.canDelete && (
                        <button onClick={() => onDeleteRect?.(row.id)} style={ICON_BTN} title="削除">{TRASH_ICON}</button>
                      )}
                    </td>
                  </tr>,
                ];
                // 修正中は入力欄が表のセルなので入力行は出さない（基点行だけ出す）
                if (isSel && rectIn?.kind === 'first' && !editing) {
                  out.push(...rectInputRows(row.id));
                }
                if (isSel && rectIn?.kind === 'attach') {
                  if (!editing) out.push(...rectInputRows(row.id));
                  out.push(
                    <tr key={`${row.id}-anchor`}>
                      <td style={{ ...TD_BASE, color: '#ef4444', fontWeight: 600 }}>基点</td>
                      <td colSpan={4} style={TD_BASE}>{rectAnchorLabel(mode.selectedRectEdge.side, mode.rectAnchor)}</td>
                      <td colSpan={2} style={TD_BASE}>
                        <button
                          onClick={() => mode.toggleRectAnchor()}
                          style={{
                            padding: '2px 8px', border: '1px solid #cbd5e1', borderRadius: 4,
                            background: '#fff', cursor: 'pointer', fontSize: 11, color: '#475569',
                          }}
                        >切替</button>
                      </td>
                    </tr>,
                  );
                }
                return out;
              })}
              {rectIn?.kind === 'first' && !rectIn.editRectId && rectInputRows('first')}
              {rectTable.rows.length === 0 && !rectIn && (
                <tr>
                  <td colSpan={7} style={{ ...TD_BASE, color: '#94a3b8', padding: '20px', textAlign: 'center' }}>
                    描画エリアをタップして左上角を置いてください
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          {outlineRows.length > 0 && (
            <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 12 }}>
              <thead>
                <tr>
                  <th style={{ ...TH_BASE, width: 64 }}>外周</th>
                  <th style={TH_BASE}>長さ</th>
                  <th style={{ ...TH_BASE, width: 80 }}>線種</th>
                </tr>
              </thead>
              <tbody>
                {outlineRows.map(row => (
                  <tr key={row.key}>
                    <td style={{ ...TD_BASE, fontWeight: 600 }}>{row.label}</td>
                    <td style={TD_BASE}>{row.length.toFixed(0)}</td>
                    <td
                      style={{ ...TD_BASE, cursor: 'pointer' }}
                      onClick={() => onToggleRectRoadSide?.(row.rectId, row.side)}
                    >{row.kindLabel}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          </>
        ) : null /* 'placement' など表を持たないサブモード（「その他」タブは 2026-11-09 廃止） */}
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
      {/* NumPad — 長方形タブで入力中のみ表示 */}
      {subMode === 'rect' && mode.rectInputState && (
        <NumPad
          value={rectFocusedValue(mode.rectInputState)}
          label={rectNumpadLabel(mode.rectInputState)}
          onChange={val => mode.setRectInputValue(val)}
          onConfirm={() => {
            const act = rectEnterAction(mode.rectInputState);
            if (act?.type === 'focus') mode.setRectFocusedCell(act.cell);
            else if (act?.type === 'confirm') onConfirmRect?.();
          }}
          onCancel={() => mode.clearRectInput()}
          hideDisplay
        />
      )}
    </>
  );

  return isLandscape
    ? <ModePanel width={360} raiseSignal={mode.selectedLineId}>{inner}</ModePanel>
    : <BottomSheet title="敷地" initialSnap={0.5} raiseSignal={mode.selectedLineId}>{inner}</BottomSheet>;
});
