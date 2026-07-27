import { useState, useEffect, useMemo } from 'react';
import './AddCLDialog.css';
import { NumPad } from './NumPad.jsx';
import { evalNumpadExpr } from './numpadUtils.js';
import { AutoScaledFigure } from '../structural/sectionFigure/AutoScaledFigure.jsx';
import { eccentricityFigurePrimitives } from './eccentricityFigure.js';
import { CenterLineType } from '@core';

// finish/clEccentricity.js は edgeComposition.js 経由で materials/materialData.js（材マスタ全件）を
// 静的に引くため、materialData.js と合わせて動的 import する（コード分割維持。ヘッダコメント参照）。

// 部屋の壁仕上げ材名（read-only表示用）。部屋が無ければ「（部屋なし）」。
function wallFinishLabel(room, materialMap) {
  if (!room) return '（部屋なし）';
  const info   = room.getFinishInfo();
  const panel  = materialMap.get(info.wallMaterial);
  const finish = info.wallFinish ? materialMap.get(info.wallFinish) : null;
  return [panel?.name, finish?.name].filter(Boolean).join(' + ') || '（未設定）';
}

/**
 * CL偏芯ダイアログ（内壁指定のあるCLの偏芯仕様を編集する）。
 * WallDialog.jsx と同パターン（AddCLDialog.css を流用）。
 *
 * 材データ（下地材選択肢・仕上げ面合わせの解決に使う materialMap）は平面図モードでは
 * 未ロードのため、ダイアログ内で動的 import する（ロード中は確定を無効化する）。
 *
 * @param {object}   graph
 * @param {object}   cl        対象CL（centerLineType, id, value を持つ）
 * @param {(rec:object|null, materialMap:Map)=>void} onConfirm  rec=null は偏芯解除
 * @param {()=>void} onCancel
 */
export function EccentricityDialog({ graph, cl, onConfirm, onCancel }) {
  const isVertical = cl.centerLineType === CenterLineType.VERTICAL;
  const existing   = graph.clEccentricities.get(cl.id) ?? null;

  const [materialMap,        setMaterialMap]        = useState(null);
  const [materials,          setMaterials]          = useState(null);
  const [backingCat,         setBackingCat]         = useState(null);
  const [resolveEccentricity, setResolveEccentricity] = useState(null); // 関数参照（useState更新は関数化して渡す）
  const [loadFailed,         setLoadFailed]         = useState(false);

  const [mode,        setMode]        = useState(existing?.mode ?? 'value');
  const [side,        setSide]        = useState(existing?.side ?? 1);
  const [valueStr,    setValueStr]    = useState(String(existing?.mode === 'value' ? existing.value : 0));
  const [backingCode, setBackingCode] = useState(existing?.backing ?? '');

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      import('../finish/materials/materialData.js'),
      import('../finish/clEccentricity.js'),
    ]).then(([matMod, eccMod]) => {
      if (cancelled) return;
      setMaterials(matMod.MATERIALS);
      setBackingCat(matMod.MATERIAL_CATEGORY.BACKING);
      setMaterialMap(new Map(matMod.MATERIALS.map(m => [m.code, m])));
      setResolveEccentricity(() => eccMod.resolveEccentricity);
    }).catch(() => { if (!cancelled) setLoadFailed(true); });
    return () => { cancelled = true; };
  }, []);

  const numericValue = evalNumpadExpr(valueStr, { positiveOnly: false });
  const ready = materialMap && resolveEccentricity;

  // ドラフトspec（未確定の編集中内容）。resolveEccentricity のライブプレビューへ渡す
  // （graph.clEccentricities は確定まで書き換えない）。resolveEccentricity は buildCellToRoom
  // 等グラフ走査を伴うため、編集中の値が変わったときだけ再計算する（QA finding 11）。
  const resolved = useMemo(() => {
    if (!ready) return null;
    const draftSpec = mode === 'value'
      ? (Number.isNaN(numericValue) ? null : { mode: 'value', value: numericValue, side, backing: backingCode })
      : { mode: 'face', value: 0, side, backing: backingCode };
    return resolveEccentricity(graph, cl.id, materialMap, draftSpec);
  }, [ready, mode, side, backingCode, materialMap, resolveEccentricity, graph, cl.id, numericValue]);
  const backingMaterials = (materials && backingCat) ? materials.filter(m => m.category === backingCat) : [];
  const commonBackingName = materialMap?.get(graph.interiorWallBacking)?.name ?? '未設定';

  const canConfirm = mode === 'value' ? !Number.isNaN(numericValue) : true;

  function handleConfirm() {
    if (!ready || !canConfirm) return;
    if (mode === 'value') {
      onConfirm({ mode: 'value', value: numericValue, side: 1, backing: backingCode }, materialMap);
    } else {
      onConfirm({ mode: 'face', value: 0, side, backing: backingCode }, materialMap);
    }
  }

  // 数値欄（value/faceどちらのモードでもフォーカスを保持できる。readOnlyは値変更のみ抑止し
  // フォーカス・keydown発火は妨げない）に付ける。ボタンにフォーカスがある場合のEnterは
  // ブラウザ既定でそのボタンのclickとして自然に発火するため、ここでの処理は不要。
  function handleKeyDown(e) {
    if (e.key === 'Enter' && canConfirm) handleConfirm();
    if (e.key === 'Escape') onCancel();
    e.stopPropagation();
  }

  const displayValueStr = mode === 'value' ? valueStr : String(Math.round(resolved?.e ?? 0));

  const figurePrimitives = resolved
    ? eccentricityFigurePrimitives({
        isVertical,
        e: resolved.e,
        b: resolved.b,
        fPos: resolved.sides.pos,
        fNeg: resolved.sides.neg,
        posLabel: resolved.sides.posRoom?.name ?? null,
        negLabel: resolved.sides.negRoom?.name ?? null,
      })
    : [];

  return (
    <>
      <div className="cl-dialog-backdrop" onPointerDown={onCancel} />
      <div className="cl-dialog" style={{ minWidth: 320 }}>
        <div className="cl-dialog-title">CL偏芯</div>

        {!ready && !loadFailed && <div className="cl-dialog-result">材データを読み込み中…</div>}
        {loadFailed && <div className="cl-dialog-result">材データの読み込みに失敗しました</div>}

        {ready && (
          <>
            <div className="cl-dialog-row" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 6 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
                <input
                  type="radio"
                  name="ecc-mode"
                  checked={mode === 'value'}
                  onChange={() => {
                    // face→value切替時は導出済みの偏芯量eを引き継ぐ（数値欄をいきなり0に戻さない）。
                    // 丸めない——Math.round だと 0.5mm 単位の値（下地厚が奇数等）が欠落する
                    // （表示用 displayValueStr の丸めとは別。QA finding 7）。
                    if (mode !== 'value') setValueStr(String(resolved?.e ?? 0));
                    setMode('value');
                  }}
                />
                数値指定
              </label>
              {resolved?.sides.posRoom && (
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
                  <input type="radio" name="ecc-mode" checked={mode === 'face' && side === 1}
                    onChange={() => { setMode('face'); setSide(1); }} />
                  仕上げ面合わせ（{resolved.sides.posRoom.name}側）
                </label>
              )}
              {resolved?.sides.negRoom && (
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
                  <input type="radio" name="ecc-mode" checked={mode === 'face' && side === -1}
                    onChange={() => { setMode('face'); setSide(-1); }} />
                  仕上げ面合わせ（{resolved.sides.negRoom.name}側）
                </label>
              )}
            </div>

            <label className="cl-dialog-row">
              <span className="cl-dialog-label">偏芯量</span>
              <input
                type="text"
                className="cl-dialog-input"
                value={displayValueStr}
                readOnly={mode !== 'value'}
                onChange={e => setValueStr(e.target.value)}
                onKeyDown={handleKeyDown}
                autoFocus
              />
              <span className="cl-dialog-unit">mm</span>
            </label>

            <label className="cl-dialog-row">
              <span className="cl-dialog-label">下地材</span>
              <select value={backingCode} onChange={e => setBackingCode(e.target.value)}>
                <option value="">{`（共通仕様に従う: ${commonBackingName}）`}</option>
                {backingMaterials.map(m => (
                  <option key={m.code} value={m.code}>{m.name}</option>
                ))}
              </select>
            </label>

            <div className="cl-dialog-result" style={{ textAlign: 'left', lineHeight: 1.6 }}>
              +側仕上げ材: {wallFinishLabel(resolved?.sides.posRoom, materialMap)}<br />
              -側仕上げ材: {wallFinishLabel(resolved?.sides.negRoom, materialMap)}
            </div>

            <AutoScaledFigure primitives={figurePrimitives} maxWidth={280} maxHeight={220} />

            <div className="cl-dialog-actions">
              {existing && (
                <button
                  className="cl-dialog-btn cl-dialog-btn--cancel"
                  style={{ color: '#dc2626' }}
                  onClick={() => onConfirm(null, materialMap)}
                >
                  偏芯解除
                </button>
              )}
              <button className="cl-dialog-btn cl-dialog-btn--cancel" onClick={onCancel}>
                キャンセル
              </button>
              <button className="cl-dialog-btn cl-dialog-btn--ok" disabled={!canConfirm} onClick={handleConfirm}>
                確定
              </button>
            </div>
          </>
        )}
      </div>

      {ready && (
        <div style={mode !== 'value' ? { opacity: 0.4, pointerEvents: 'none' } : undefined}>
          <NumPad
            value={displayValueStr}
            label="偏芯量"
            onChange={setValueStr}
            onConfirm={handleConfirm}
            onCancel={onCancel}
          />
        </div>
      )}
    </>
  );
}
