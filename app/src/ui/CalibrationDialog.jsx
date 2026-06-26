import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { observer } from 'mobx-react-lite';
import { CalibrationMethod, CARD_WIDTH_MM, CARD_HEIGHT_MM, getRecommendedCalibrationMethod } from '../calibration.js';

const REF_MM = 100; // 基準線の長さ (mm)

const LINE_COLOR = '#3b82f6';

const inputStyle = {
  width: 80, fontSize: 13, textAlign: 'right',
  border: '1px solid #cbd5e1', borderRadius: 4, padding: '4px 8px',
};

function btn(primary) {
  return {
    flex: 1, padding: '7px 0', borderRadius: 6, fontSize: 13, cursor: 'pointer',
    border:     primary ? 'none'    : '1px solid #cbd5e1',
    background: primary ? '#3b82f6' : '#f8fafc',
    color:      primary ? '#fff'    : '#333',
  };
}

const switchLinkStyle = {
  alignSelf: 'flex-start', background: 'none', border: 'none', padding: 0,
  fontSize: 12, color: LINE_COLOR, textDecoration: 'underline', cursor: 'pointer',
};

export const CalibrationDialog = observer(({ viewport, onClose }) => {
  const [method, setMethod] = useState(getRecommendedCalibrationMethod);

  if (method === CalibrationMethod.CARD_MATCH) {
    return (
      <CardCalibrationView
        viewport={viewport}
        onClose={onClose}
        onSwitchMethod={() => setMethod(CalibrationMethod.RULER_MEASURE)}
      />
    );
  }
  return (
    <RulerCalibrationView
      viewport={viewport}
      onClose={onClose}
      onSwitchMethod={() => setMethod(CalibrationMethod.CARD_MATCH)}
    />
  );
});

// 定規実測方式 — 画面上に100mm基準線を表示し、実測値を入力する（PC・タブレット向け）
const RulerCalibrationView = observer(({ viewport, onClose, onSwitchMethod }) => {
  const lineWPx = Math.round(REF_MM * viewport.pxPerMmX); // 水平基準線の CSS px 幅
  const lineHPx = Math.round(REF_MM * viewport.pxPerMmY); // 垂直基準線の CSS px 高さ

  const [measuredH, setMeasuredH] = useState(''); // 水平方向の実測値
  const [measuredV, setMeasuredV] = useState(''); // 垂直方向の実測値

  function apply() {
    const h = parseFloat(measuredH);
    const v = parseFloat(measuredV);
    const hasH = isFinite(h) && h > 0;
    const hasV = isFinite(v) && v > 0;
    if (!hasH && !hasV) return;
    viewport.calibrate(
      hasH ? viewport.pxPerMmX * (REF_MM / h) : viewport.pxPerMmX,
      hasV ? viewport.pxPerMmY * (REF_MM / v) : viewport.pxPerMmY,
    );
    onClose();
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 200 }}>

      {/* 水平基準線 — 画面上部 (正確に lineWPx px) */}
      <div style={{
        position: 'absolute', top: '22%',
        left: '50%', transform: `translateX(-${lineWPx / 2}px)`,
        width: lineWPx, height: 2,
        background: LINE_COLOR, pointerEvents: 'none',
      }}>
        {/* 左端目盛り */}
        <div style={{ position: 'absolute', left: 0,   top: -4, width: 2, height: 10, background: LINE_COLOR }} />
        {/* 右端目盛り */}
        <div style={{ position: 'absolute', right: 0,  top: -4, width: 2, height: 10, background: LINE_COLOR }} />
        {/* ラベル */}
        <div style={{
          position: 'absolute', left: '50%', top: 6,
          transform: 'translateX(-50%)',
          fontSize: 11, color: LINE_COLOR, whiteSpace: 'nowrap',
        }}>
          ← 水平 {REF_MM} mm（想定）→
        </div>
      </div>

      {/* 垂直基準線 — 画面左側 (正確に lineHPx px) */}
      <div style={{
        position: 'absolute', left: '12%',
        top: '50%', transform: `translateY(-${lineHPx / 2}px)`,
        width: 2, height: lineHPx,
        background: LINE_COLOR, pointerEvents: 'none',
      }}>
        {/* 上端目盛り */}
        <div style={{ position: 'absolute', top: 0,    left: -4, width: 10, height: 2, background: LINE_COLOR }} />
        {/* 下端目盛り */}
        <div style={{ position: 'absolute', bottom: 0, left: -4, width: 10, height: 2, background: LINE_COLOR }} />
        {/* ラベル (横向き) */}
        <div style={{
          position: 'absolute', left: 10, top: '50%',
          transform: 'translateY(-50%)',
          fontSize: 11, color: LINE_COLOR, whiteSpace: 'nowrap',
        }}>
          ↕ 垂直 {REF_MM} mm（想定）
        </div>
      </div>

      {/* ダイアログ */}
      <div style={{
        position: 'absolute', top: '50%', left: '50%',
        transform: 'translate(-50%, -50%)',
        background: '#fff', borderRadius: 8, padding: 20, width: 300,
        boxShadow: '0 4px 24px rgba(0,0,0,0.25)',
        display: 'flex', flexDirection: 'column', gap: 12,
      }}>
        <div style={{ fontSize: 14, fontWeight: 600 }}>画面校正</div>
        <button onClick={onSwitchMethod} style={switchLinkStyle}>
          → カード当て方式に切り替える（小型デバイス向け）
        </button>
        <div style={{ fontSize: 12, color: '#64748b', lineHeight: 1.6 }}>
          画面上の基準線を定規で計測し、実測値を入力してください。
          入力した軸のみ更新されます。
        </div>

        {/* 水平 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 13, width: 56 }}>水平 →</span>
          <input
            type="number" min="1" step="0.1"
            value={measuredH}
            onChange={e => setMeasuredH(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') apply(); if (e.key === 'Escape') onClose(); }}
            placeholder={`${REF_MM}`}
            autoFocus
            style={inputStyle}
          />
          <span style={{ fontSize: 13 }}>mm</span>
        </div>

        {/* 垂直 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 13, width: 56 }}>垂直 ↕</span>
          <input
            type="number" min="1" step="0.1"
            value={measuredV}
            onChange={e => setMeasuredV(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') apply(); if (e.key === 'Escape') onClose(); }}
            placeholder={`${REF_MM}`}
            style={inputStyle}
          />
          <span style={{ fontSize: 13 }}>mm</span>
        </div>

        {/* 現在値 */}
        <div style={{ fontSize: 11, color: '#94a3b8' }}>
          現在: 水平 {viewport.pxPerMmX.toFixed(3)} px/mm
                ／ 垂直 {viewport.pxPerMmY.toFixed(3)} px/mm
        </div>

        <div style={{ display: 'flex', gap: 8, marginTop: 2 }}>
          <button onClick={onClose} style={btn(false)}>キャンセル</button>
          <button onClick={apply}   style={btn(true)}>適用</button>
        </div>
      </div>
    </div>
  );
});

const STEP_PX = 2;  // +/- 1回あたりの調整量 (px)
const MIN_PX  = 40; // 枠の最小サイズ (px)

const HOLD_DELAY_MS    = 400; // 押しっぱなし判定までの遅延
const HOLD_INTERVAL_MS = 80;  // 押しっぱなし中の連続実行間隔

const TOP_AREA_PADDING = 16; // 矩形表示エリアの内側余白 (px、下記 JSX の padding と一致させる)

// 表示可能な幅の上限（画面幅から表示エリアの左右余白を引いた値。常に厳密）
function maxCardWidthPx() { return window.innerWidth - TOP_AREA_PADDING * 2; }
// 高さは操作バーの実高さに依存するため、実測できるまでの暫定値（実測後 topAreaRef 経由で更新）
function fallbackMaxCardHeightPx() { return window.innerHeight * 0.65; }

function clampCardWidthPx(v) {
  return Math.max(MIN_PX, Math.min(v, maxCardWidthPx()));
}
function clampCardHeightPx(v, maxHeightPx) {
  return Math.max(MIN_PX, Math.min(v, maxHeightPx));
}

// カード当て方式 — クレジットカード等の規格サイズの実物を画面に当てて矩形を合わせる（小型デバイス向け）
const CardCalibrationView = observer(({ viewport, onClose, onSwitchMethod }) => {
  // 画面が縦長なら、カードも縦長（短辺を画面の幅方向）に表示する
  const isPortrait  = window.innerHeight > window.innerWidth;
  const mmForWidth  = isPortrait ? CARD_HEIGHT_MM : CARD_WIDTH_MM;
  const mmForHeight = isPortrait ? CARD_WIDTH_MM  : CARD_HEIGHT_MM;

  const topAreaRef = useRef(null);
  // 操作バーの実高さが分かるまでの暫定値。マウント後に実測して正確な値へ更新する
  const [maxHeightPx, setMaxHeightPx] = useState(fallbackMaxCardHeightPx);

  const [widthPx,  setWidthPx]  = useState(() => clampCardWidthPx(mmForWidth * viewport.pxPerMmX));
  const [heightPx, setHeightPx] = useState(() => clampCardHeightPx(mmForHeight * viewport.pxPerMmY, fallbackMaxCardHeightPx()));

  // 矩形表示エリア（画面 − 操作バーの実高さ）を実測し、デバイス画面の大きさに正確に合わせる
  useLayoutEffect(() => {
    const el = topAreaRef.current;
    if (!el) return;
    const available = Math.max(MIN_PX, el.clientHeight - TOP_AREA_PADDING * 2);
    setMaxHeightPx(available);
    setHeightPx(h => Math.min(h, available));
  }, []);

  function apply() {
    viewport.calibrate(widthPx / mmForWidth, heightPx / mmForHeight);
    onClose();
  }

  // +/- 押しっぱなしでの連続増減（最初の1回は即時反映、HOLD_DELAY_MS 後から HOLD_INTERVAL_MS 間隔で繰り返す）
  const holdTimeoutRef  = useRef(null);
  const holdIntervalRef = useRef(null);

  function stopHold() {
    clearTimeout(holdTimeoutRef.current);
    clearInterval(holdIntervalRef.current);
    holdTimeoutRef.current  = null;
    holdIntervalRef.current = null;
  }
  useEffect(() => stopHold, []);

  function startHold(setter, clamp, delta) {
    const step = () => setter(v => {
      const next = clamp(v + delta);
      if (next === v) stopHold(); // 下限/上限に達したら自動停止
      return next;
    });
    step();
    holdTimeoutRef.current = setTimeout(() => {
      holdIntervalRef.current = setInterval(step, HOLD_INTERVAL_MS);
    }, HOLD_DELAY_MS);
  }

  const stepperBtnStyle = {
    flex: 1, minWidth: 0, height: 32, borderRadius: 6, fontSize: 15, lineHeight: 1, cursor: 'pointer',
    border: '1px solid #cbd5e1', background: '#f8fafc', color: '#333',
    // 押しっぱなし操作中に OS のロングタップ判定（コピー/共有/全選択メニュー）が割り込むのを抑制する
    touchAction: 'none', WebkitTouchCallout: 'none', WebkitUserSelect: 'none', userSelect: 'none',
  };

  function preventContextMenu(e) { e.preventDefault(); }

  function stepperGroup(label, value, setter, clamp, maxFn) {
    const atMin = value <= MIN_PX;
    const atMax = value >= maxFn();
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1 }}>
        <span style={{ fontSize: 13, flexShrink: 0 }}>{label}</span>
        <button
          disabled={atMin}
          onPointerDown={() => startHold(setter, clamp, -STEP_PX)}
          onPointerUp={stopHold}
          onPointerLeave={stopHold}
          onPointerCancel={stopHold}
          onContextMenu={preventContextMenu}
          style={{ ...stepperBtnStyle, opacity: atMin ? 0.4 : 1, cursor: atMin ? 'default' : 'pointer' }}
        >−</button>
        <button
          disabled={atMax}
          onPointerDown={() => startHold(setter, clamp, STEP_PX)}
          onPointerUp={stopHold}
          onPointerLeave={stopHold}
          onPointerCancel={stopHold}
          onContextMenu={preventContextMenu}
          style={{ ...stepperBtnStyle, opacity: atMax ? 0.4 : 1, cursor: atMax ? 'default' : 'pointer' }}
        >＋</button>
      </div>
    );
  }

  return (
    <div
      onKeyDown={e => { if (e.key === 'Escape') onClose(); }}
      style={{
        position: 'fixed', inset: 0, zIndex: 200,
        display: 'flex', flexDirection: 'column', pointerEvents: 'none',
        // 長押し操作中に OS のテキスト選択コールアウト（コピー/共有等）が出ないようにする
        WebkitTouchCallout: 'none', WebkitUserSelect: 'none', userSelect: 'none',
      }}
    >
      {/* 矩形表示エリア — 背景は暗転させず、画面を覆わない */}
      <div
        ref={topAreaRef}
        style={{
          flex: 1, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
          padding: TOP_AREA_PADDING, boxSizing: 'border-box',
        }}
      >
        <div style={{
          width: widthPx, height: heightPx,
          border: `2px solid ${LINE_COLOR}`, borderRadius: 10,
          background: 'rgba(59,130,246,0.08)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <span style={{ fontSize: 11, color: LINE_COLOR, whiteSpace: 'nowrap' }}>
            {mmForWidth} × {mmForHeight} mm
          </span>
        </div>
      </div>

      {/* 操作バー — 下部固定の小さなパネル（画面全体は覆わない） */}
      <div style={{
        pointerEvents: 'auto', flexShrink: 0,
        background: 'rgba(255,255,255,0.95)',
        borderTop: '1px solid #e2e8f0', borderRadius: '16px 16px 0 0',
        boxShadow: '0 -4px 24px rgba(0,0,0,0.12)',
        padding: '8px 16px 12px',
        display: 'flex', flexDirection: 'column', gap: 6,
      }}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
          <span style={{ fontSize: 14, fontWeight: 600, whiteSpace: 'nowrap' }}>画面校正（カード当て）</span>
          <button onClick={onSwitchMethod} style={{ ...switchLinkStyle, alignSelf: 'auto', whiteSpace: 'nowrap' }}>
            → 定規実測方式に切り替える
          </button>
        </div>
        <div style={{ fontSize: 11, color: '#64748b' }}>
          実物のクレジットカード等（{mmForWidth}×{mmForHeight}mm）を当て、枠の大きさを合わせてください。
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%' }}>
          {stepperGroup('幅 ↔',  widthPx,  setWidthPx,  clampCardWidthPx,                          maxCardWidthPx)}
          {stepperGroup('高さ ↕', heightPx, setHeightPx, v => clampCardHeightPx(v, maxHeightPx), () => maxHeightPx)}
        </div>

        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={onClose} style={btn(false)}>キャンセル</button>
          <button onClick={apply}   style={btn(true)}>適用</button>
        </div>
      </div>
    </div>
  );
});
