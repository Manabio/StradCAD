import { useState, useEffect } from 'react';
import { circleRefSymbol, circleRefKindLabel } from './circleRef.js';
import { NumPad } from './NumPad.jsx';
import { evalNumpadExpr } from './numpadUtils.js';
import { initialRef, distStrForRef, foldRefForConfirm } from './addCLDialogRefs.js';
import './AddCLDialog.css';

const KINDS = [
  { id: 'center', label: '中心',   hint: 'ラベルなし中心線' },
  { id: 'struct', label: '通り芯', hint: '構造通り芯（ガターラベルあり）' },
  { id: 'aux',    label: '補助線', hint: 'ラベルなし補助線（破線）' },
];

const BEAM_KIND = { id: 'beam', label: '梁芯', hint: '小梁を生成する梁芯（伏図）' };

// 天伏の追加は天井芯（天井セルを分割する線。S8b）だけ。通り芯・中心・補助線は天伏では引かない。
const CEILING_KIND = { id: 'ceiling', label: '天井芯', hint: '天井セルを分割する線（天伏専用）' };

// appMode ごとに出す種別を絞る。未登録モード（floorplan/finish/site）は従来通り KINDS 全種。
const KINDS_BY_MODE = { structure: [BEAM_KIND], ceiling: [CEILING_KIND] };

/**
 * 通り芯追加ダイアログ
 *
 * Y軸は上が正・下が負（表示座標 = −ワールドY）。
 * onConfirm(worldValue, kind, refId, refOffset) : kind = 'center'|'struct'|'aux'|'beam'
 * columnAxisRefs: 構造モード（appMode==='structure'）専用の「柱芯」参照選択肢。
 * 要素は { id:'colaxis:'+clId, clId, value(柱芯実位置), axisOffset(通り芯からの偏芯量), label } の合成CL
 * （実CLではない）。他モードでは常に空配列＝従来と完全に同一。
 */
export function AddCLDialog({ type, worldCoord, gridCLs, nearbyCLs = [], appMode, columnAxisRefs = [], onConfirm, onCancel, onPreviewChange }) {
  const isV  = type === 'vertical';
  const sign = isV ? 1 : -1;
  const axisLabel = isV ? 'X' : 'Y';
  const kinds = KINDS_BY_MODE[appMode] ?? KINDS;

  const nearbyIds  = new Set(nearbyCLs.map(cl => cl.id));
  const gridOnly   = gridCLs.filter(cl => !nearbyIds.has(cl.id));
  const allOptions = [...nearbyCLs, ...gridOnly, ...columnAxisRefs];

  // 既定の参照（最寄り）と距離の初期値。吸着専用の参照（構造モードの中心線）なら距離 '0'
  const [initial] = useState(() => initialRef(allOptions, worldCoord, appMode, sign));
  const [kind,    setKind]    = useState(kinds[0].id);
  const [refId,   setRefId]   = useState(initial.refId);
  const [distStr, setDistStr] = useState(initial.distStr);

  const refCL = allOptions.find(cl => cl.id === refId) ?? null;

  // direction from ref to target (positive = right/down in world coords)
  const dir = refCL ? (worldCoord >= refCL.value ? 1 : -1) : null;
  const dirLabel = dir == null ? null
    : isV ? (dir > 0 ? '右→' : '←左') : (dir > 0 ? '↓下' : '上↑');

  // 計算式対応（例: 910×3, 1820+455）。未完成・不正な式は 0 扱い（従来の || 0 と同挙動）
  const distVal  = evalNumpadExpr(distStr, { positiveOnly: false });
  const distNum  = Number.isNaN(distVal) ? 0 : distVal;
  const dist = refCL ? Math.abs(distNum) : distNum;
  const previewWorld   = refCL ? refCL.value + dir * dist : sign * dist;
  const previewDisplay = sign * previewWorld;

  // スパン配列モード: kind='struct' かつカンマ区切りの場合
  const isMultiSpan = kind === 'struct' && distStr.includes(',');
  const parsedSpans = isMultiSpan
    ? distStr.split(',').map(s => evalNumpadExpr(s.trim())).filter(n => n > 0 && isFinite(n))
    : null;
  const batchWorldValues = (isMultiSpan && parsedSpans && parsedSpans.length > 0)
    ? (() => {
        const base = refCL ? refCL.value : 0;
        const d    = refCL ? (dir ?? 1) : sign;
        let cursor = base;
        return parsedSpans.map(span => { cursor += d * span; return cursor; });
      })()
    : null;

  useEffect(() => {
    onPreviewChange?.(isMultiSpan ? null : previewWorld);
    return () => onPreviewChange?.(null);
  }, [previewWorld, isMultiSpan]); // eslint-disable-line react-hooks/exhaustive-deps

  function handleRefChange(e) {
    const id = e.target.value;
    setRefId(id);
    const cl = allOptions.find(c => c.id === id);
    setDistStr(distStrForRef(cl, worldCoord, appMode, sign));
  }

  function handleConfirm() {
    if (isMultiSpan && batchWorldValues) {
      onConfirm(batchWorldValues, kind, null, null);
      return;
    }
    // 参照の畳み込み（柱芯の合成CL→通り芯clId＋オフセット、吸着専用の参照→絶対座標）は addCLDialogRefs.js
    const folded = foldRefForConfirm(refCL, appMode, { dist, dir });
    onConfirm(previewWorld, kind, folded.refId, folded.refOffset);
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter')  handleConfirm();
    if (e.key === 'Escape') onCancel();
  }

  return (
    <>
      <div className="cl-dialog-backdrop" onPointerDown={onCancel} />
      <div className="cl-dialog">
        <div className="cl-dialog-title">
          {isV ? '垂直線を追加' : '水平線を追加'}
        </div>

        {/* 種別セレクタ */}
        <div className="cl-kind-group">
          {kinds.map(k => (
            <button
              key={k.id}
              className={`cl-kind-btn${kind === k.id ? ' cl-kind-btn--active' : ''}`}
              title={k.hint}
              onClick={() => setKind(k.id)}
            >
              {k.label}
            </button>
          ))}
        </div>

        <label className="cl-dialog-row">
          <span className="cl-dialog-label">参照</span>
          <select value={refId} onChange={handleRefChange}>
            <option value="">なし（絶対座標）</option>
            {nearbyCLs.length > 0 && (
              <optgroup label="近接する中心線">
                {nearbyCLs.map((cl, i) => (
                  <option key={cl.id} value={cl.id}>
                    {circleRefSymbol(i)} {circleRefKindLabel(cl)}
                  </option>
                ))}
              </optgroup>
            )}
            {gridOnly.length > 0 && (
              <optgroup label="グリッドCL">
                {gridOnly.map(cl => (
                  <option key={cl.id} value={cl.id}>{cl.label || cl.id}</option>
                ))}
              </optgroup>
            )}
            {columnAxisRefs.length > 0 && (
              <optgroup label="柱芯">
                {columnAxisRefs.map(ref => (
                  <option key={ref.id} value={ref.id}>{ref.label}</option>
                ))}
              </optgroup>
            )}
          </select>
        </label>

        <label className="cl-dialog-row">
          <span className="cl-dialog-label">
            {refCL ? circleRefKindLabel(refCL) : `${axisLabel} =`}
          </span>
          {dirLabel && <span className="cl-dialog-dir">{dirLabel}</span>}
          <input
            type="text"
            className="cl-dialog-input"
            value={distStr}
            placeholder={kind === 'struct' ? '例: 3000,3000' : ''}
            onChange={e => setDistStr(e.target.value)}
            onKeyDown={handleKeyDown}
            autoFocus
          />
          <span className="cl-dialog-unit">mm</span>
        </label>

        <div className="cl-dialog-result">
          {isMultiSpan && batchWorldValues
            ? `${batchWorldValues.length}本追加 (累計 ${Math.abs(Math.round(sign * (batchWorldValues[batchWorldValues.length - 1] - (refCL?.value ?? 0))))} mm)`
            : `${axisLabel} = ${Math.round(previewDisplay)} mm`
          }
        </div>

        <div className="cl-dialog-actions">
          <button className="cl-dialog-btn cl-dialog-btn--cancel" onClick={onCancel}>
            キャンセル
          </button>
          <button className="cl-dialog-btn cl-dialog-btn--ok" onClick={handleConfirm}>
            {isMultiSpan && batchWorldValues ? `${batchWorldValues.length}本追加` : '追加'}
          </button>
        </div>
      </div>

      {/* 値はダイアログ内の入力欄に表示されるため hideDisplay。物理キーボードは入力欄の onKeyDown が担うため keyboard は付けない */}
      <NumPad
        value={distStr}
        hideDisplay
        onChange={setDistStr}
        onConfirm={handleConfirm}
        onCancel={onCancel}
      />
    </>
  );
}
