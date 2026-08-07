import { useMemo, useState } from 'react';
import './AddCLDialog.css';
import { NumPad } from './NumPad.jsx';
import { evalNumpadExpr } from './numpadUtils.js';
import { AutoScaledFigure } from '../structural/sectionFigure/AutoScaledFigure.jsx';
import { figureBounds, chooseScale, makeTransform } from '../structural/sectionFigure/sectionGeometry.js';
import { kneeDropWallFigurePrimitives } from './kneeDropWallFigure.js';
import { buildCellToRoom } from '../finish/edgeClassify.js';
import { effectiveCeilingHeight, validateKneeDropWall, ERR_CEILING_HEIGHT_UNRESOLVED } from '../finish/kneeDropWall.js';

/**
 * 腰壁・垂れ壁ダイアログ（壁の長押し「腰/垂壁」から開く）。
 * 複数フィールド + 単一NumPad、focusedFieldでどのフィールドを編集中か切り替えるパターン
 * （旧 OpeningDialog.jsx が同型だったが建具モード新設に伴い削除済み。現在この形の他の参照先はない）。
 * 位置は長押し位置アンカー＋クランプ（AddFloorDialog.jsx の前例）。
 *
 * @param {object}   graph
 * @param {string}   spanKey  対象区間キー（edgeKey）
 * @param {{x:number,y:number}} anchor 長押し位置（スクリーン座標）。壁に重ならないよう少しずらして表示する。
 * @param {boolean}  isVerticalWall 長押しした壁が縦壁か（レイアウトのミラーリング判定に使う）
 * @param {number}   wallOffsetSign 軸CLに対する壁の生成側（axisOffsetの符号。+1/-1/0）
 * @param {(rec:object|null)=>void} onConfirm rec = { knee: {topHeight}|null, drop: {bottomHeight}|null } | null（null=両方未指定＝解除）
 * @param {()=>void} onCancel
 */
export function KneeDropWallDialog({ graph, spanKey, anchor, isVerticalWall = true, wallOffsetSign = 1, onConfirm, onCancel }) {
  const existing = graph.kneeDropWalls.get(spanKey) ?? null;

  // ceilingHeight はダイアログを開いた時点のグラフ状態から一度だけ解決する（部屋名・天井高さの
  // 編集はこのダイアログを閉じないと行えないため、開いている間は再計算不要）。
  const ceilingHeight = useMemo(() => {
    const cellToRoom = buildCellToRoom(graph);
    return effectiveCeilingHeight(graph, spanKey, cellToRoom);
  }, [graph, spanKey]);

  const [kneeStr, setKneeStr] = useState(String(existing?.knee?.topHeight ?? ''));
  const [dropStr, setDropStr] = useState(String(existing?.drop?.bottomHeight ?? ''));
  const [focusedField, setFocusedField] = useState('knee'); // 'knee' | 'drop'

  const kneeVal = kneeStr.trim() === '' ? null : evalNumpadExpr(kneeStr);
  const dropVal = dropStr.trim() === '' ? null : evalNumpadExpr(dropStr);
  const kneeInvalid = kneeStr.trim() !== '' && Number.isNaN(kneeVal);
  const dropInvalid = dropStr.trim() !== '' && Number.isNaN(dropVal);

  const { valid, error } = validateKneeDropWall(
    kneeInvalid ? null : kneeVal,
    dropInvalid ? null : dropVal,
    ceilingHeight,
  );
  const canConfirm = !kneeInvalid && !dropInvalid && valid;

  function handleConfirm() {
    if (!canConfirm) return;
    if (kneeVal == null && dropVal == null) { onConfirm(null); return; }
    onConfirm({
      knee: kneeVal != null ? { topHeight: kneeVal } : null,
      drop: dropVal != null ? { bottomHeight: dropVal } : null,
    });
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter' && canConfirm) handleConfirm();
    if (e.key === 'Escape') onCancel();
    e.stopPropagation();
  }

  const numpadValue = focusedField === 'knee' ? kneeStr : dropStr;
  const numpadLabel = focusedField === 'knee' ? '腰壁H' : '垂れ壁H';
  function handleNumpadChange(v) {
    if (focusedField === 'knee') setKneeStr(v); else setDropStr(v);
  }

  // レイアウトのミラーリング: 「右側/上側の壁」＝軸CLに対して壁がどちら側に生成されているか
  // （axisOffsetの符号）。縦壁で+側（CLの右）・横壁で−側（y軸下向き正のためCLの上）なら
  // 「図=左・寸法線=断面の右・入力欄=右」（layoutA）。左側・下側の壁なら鏡像。
  const layoutA = isVerticalWall ? wallOffsetSign >= 0 : wallOffsetSign <= 0;

  const figurePrimitives = ceilingHeight != null
    ? kneeDropWallFigurePrimitives({
        ceilingHeight,
        kneeTop: !kneeInvalid ? kneeVal : null,
        dropBottom: !dropInvalid ? dropVal : null,
        dimSide: layoutA ? 1 : -1,
      })
    : [];

  // 入力欄の位置合わせ: AutoScaledFigure と同じ変換（figureBounds→chooseScale→makeTransform）を
  // 再現し、入力欄を「寸法線の値」として寸法線の中央高さ（寸法線と同じ側の脇カラム）へ置く。
  // 値が未入力の間は寸法線が無いため FL線／CH線の高さに置く。
  const FIG_MAX_W = 240, FIG_MAX_H = 220;
  const SIDE_W = 104;        // 図の脇に確保する入力欄の幅(px)
  const INPUT_GROUP_H = 40;  // ラベル＋入力欄のおおよその高さ(px)。中央合わせとクランプに使う
  let fig = null, kneePosTop = null, dropPosTop = null;
  if (figurePrimitives.length > 0) {
    const b = figureBounds(figurePrimitives);
    fig = makeTransform(b, chooseScale(b.width, b.height, FIG_MAX_W, FIG_MAX_H));
    const kneeH = !kneeInvalid && kneeVal != null && kneeVal > 0 ? Math.min(kneeVal, ceilingHeight) : 0;
    const dropH = !dropInvalid && dropVal != null && dropVal > 0 ? Math.min(dropVal, ceilingHeight) : 0;
    const clampTop = mid => Math.max(0, Math.min(mid - INPUT_GROUP_H / 2, fig.pxHeight - INPUT_GROUP_H));
    kneePosTop = clampTop((fig.ty(0) + fig.ty(-kneeH)) / 2);
    dropPosTop = clampTop((fig.ty(-ceilingHeight) + fig.ty(-(ceilingHeight - dropH))) / 2);
    // 両入力欄が同じ脇カラムに並ぶため、接近したら上下へ押し分ける（垂れ壁=上・腰壁=下を維持）
    if (kneePosTop - dropPosTop < INPUT_GROUP_H) {
      const mid = (kneePosTop + dropPosTop) / 2;
      dropPosTop = Math.max(0, mid - INPUT_GROUP_H);
      kneePosTop = Math.min(fig.pxHeight - INPUT_GROUP_H, mid + 2);
    }
  }

  // ダイアログは壁と同じ側（CLに対する壁の生成側）へ開く: CLの右側の壁→壁の右、
  // 左側の壁→壁の左、上側の壁→壁の上、下側の壁→壁の下。
  // 画面外へはみ出さないようクランプ（AddFloorDialog.jsx と同じ手法）。
  const DIALOG_W = 250, DIALOG_H = 290, OFFSET = 20;
  let anchorStyle;
  if (anchor) {
    let left, top;
    if (isVerticalWall) {
      left = layoutA ? anchor.x + OFFSET : anchor.x - OFFSET - DIALOG_W;
      top  = anchor.y + OFFSET;
    } else {
      left = anchor.x + OFFSET;
      top  = layoutA ? anchor.y - OFFSET - DIALOG_H : anchor.y + OFFSET;
    }
    anchorStyle = {
      top:  Math.max(8, Math.min(top,  window.innerHeight - DIALOG_H)),
      left: Math.max(8, Math.min(left, window.innerWidth  - DIALOG_W)),
      transform: 'none',
    };
  }

  return (
    <>
      <div className="cl-dialog-backdrop" onPointerDown={onCancel} />
      {/* minWidth は指定せず内容にフィットさせる（余白を作らない）。padding/gap も詰める。 */}
      <div className="cl-dialog" style={{ minWidth: 0, padding: '10px 12px', gap: 6, ...anchorStyle }}>
        <div className="cl-dialog-title">腰壁・垂れ壁</div>

        {/* フィールド未入力（validateKneeDropWallが両方null短絡でerror未算出）でも先出しする。
            下部の error 表示（validateKneeDropWall由来）と文言は同一定数を共有し、
            同じ内容を二重表示しないよう下部側で除外する（QA指摘）。 */}
        {ceilingHeight == null && (
          <div className="cl-dialog-result" style={{ color: '#dc2626' }}>
            {ERR_CEILING_HEIGHT_UNRESOLVED}
          </div>
        )}

        {/* 断面図と入力欄を寸法線と同じ側に並べる（layoutA: 図=左・入力欄=右／鏡像: 図=右・入力欄=左）。
            入力欄は「寸法線の値」として寸法線の中央高さに絶対配置（未入力時はFL/CH線付近）。 */}
        {fig ? (
          <div style={{ position: 'relative', width: fig.pxWidth + SIDE_W, height: fig.pxHeight, margin: '0 auto' }}>
            <div style={{ position: 'absolute', left: layoutA ? 0 : SIDE_W, top: 0 }}>
              <AutoScaledFigure primitives={figurePrimitives} maxWidth={FIG_MAX_W} maxHeight={FIG_MAX_H} />
            </div>

            <label style={{
              position: 'absolute', left: layoutA ? fig.pxWidth + 4 : 0, width: SIDE_W - 4, top: dropPosTop,
              display: 'flex', flexDirection: 'column', alignItems: layoutA ? 'flex-start' : 'flex-end', gap: 2,
            }}>
              <span className="cl-dialog-label" style={{ width: 'auto' }} title="垂れ壁H（天井〜下端）">垂れ壁H</span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                <input
                  type="text"
                  className="cl-dialog-input"
                  style={{ width: 60 }}
                  value={dropStr}
                  onFocus={() => setFocusedField('drop')}
                  onChange={e => setDropStr(e.target.value)}
                  onKeyDown={handleKeyDown}
                />
                <span className="cl-dialog-unit">mm</span>
              </span>
            </label>

            <label style={{
              position: 'absolute', left: layoutA ? fig.pxWidth + 4 : 0, width: SIDE_W - 4, top: kneePosTop,
              display: 'flex', flexDirection: 'column', alignItems: layoutA ? 'flex-start' : 'flex-end', gap: 2,
            }}>
              <span className="cl-dialog-label" style={{ width: 'auto' }} title="腰壁H（床〜上端）">腰壁H</span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                <input
                  type="text"
                  className="cl-dialog-input"
                  style={{ width: 60 }}
                  value={kneeStr}
                  onFocus={() => setFocusedField('knee')}
                  onChange={e => setKneeStr(e.target.value)}
                  onKeyDown={handleKeyDown}
                  autoFocus
                />
                <span className="cl-dialog-unit">mm</span>
              </span>
            </label>
          </div>
        ) : (
          /* 天井高さが解決できず図が無いとき: 縦積みの入力欄のみ */
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span className="cl-dialog-label" style={{ width: 'auto', textAlign: 'left' }}>垂れ壁H（天井〜下端）</span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <input
                  type="text"
                  className="cl-dialog-input"
                  value={dropStr}
                  onFocus={() => setFocusedField('drop')}
                  onChange={e => setDropStr(e.target.value)}
                  onKeyDown={handleKeyDown}
                />
                <span className="cl-dialog-unit">mm</span>
              </span>
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span className="cl-dialog-label" style={{ width: 'auto', textAlign: 'left' }}>腰壁H（床〜上端）</span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <input
                  type="text"
                  className="cl-dialog-input"
                  value={kneeStr}
                  onFocus={() => setFocusedField('knee')}
                  onChange={e => setKneeStr(e.target.value)}
                  onKeyDown={handleKeyDown}
                  autoFocus
                />
                <span className="cl-dialog-unit">mm</span>
              </span>
            </label>
          </div>
        )}

        {error && error !== ERR_CEILING_HEIGHT_UNRESOLVED && (
          <div className="cl-dialog-result" style={{ color: '#dc2626' }}>{error}</div>
        )}

        {/* アクションはダイアログ全幅の下段・横中心 */}
        <div className="cl-dialog-actions" style={{ justifyContent: 'center', marginTop: 0 }}>
          {existing && (
            <button
              className="cl-dialog-btn cl-dialog-btn--cancel"
              style={{ color: '#dc2626' }}
              onClick={() => onConfirm(null)}
            >
              解除
            </button>
          )}
          <button className="cl-dialog-btn cl-dialog-btn--cancel" onClick={onCancel}>
            キャンセル
          </button>
          <button className="cl-dialog-btn cl-dialog-btn--ok" disabled={!canConfirm} onClick={handleConfirm}>
            確定
          </button>
        </div>
      </div>

      <NumPad
        value={numpadValue}
        label={numpadLabel}
        onChange={handleNumpadChange}
        onConfirm={handleConfirm}
        onCancel={onCancel}
      />
    </>
  );
}
