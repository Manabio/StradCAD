/**
 * 関門（uiBusy）が開いている間、画面全体の入力を塞ぐオーバーレイ。observer配下なので
 * isUiBusy()の変化に追随して自動的に再描画される（現状の最大zIndexはMemberLayoutStudyの
 * 4000のためそれより上に置く）。
 *
 * 短い処理はちらつかせないため、遅延ラベル（uiBusyLabel()＋「中…」）はLABEL_DELAY_MSだけ
 * 待ってから表示する。WARN_AFTER_MSを超えて関門が開いたままならconsole.warnで1回知らせるが、
 * 自動解放はしない——原因はIDB待ち等であり、関門を強制的に閉じると「awaitをまたぐ編集が
 * 関門の外へ漏れない」という不変条件が崩れる。回復は再読込み等、ユーザー操作に委ねる。
 */
import { useEffect, useState } from 'react';
import { observer } from 'mobx-react-lite';
import { isUiBusy, uiBusyLabel } from '../uiBusy.js';
import { LABEL_DELAY_MS, WARN_AFTER_MS, formatBusyLabel } from './busyOverlayTiming.js';

export const BusyOverlay = observer(() => {
  const busy = isUiBusy();
  const [showLabel, setShowLabel] = useState(false);

  useEffect(() => {
    if (!busy) {
      setShowLabel(false);
      return undefined;
    }
    const labelTimer = setTimeout(() => setShowLabel(true), LABEL_DELAY_MS);
    const warnTimer = setTimeout(() => {
      console.warn('[uiBusy] 長時間', uiBusyLabel());
    }, WARN_AFTER_MS);
    return () => {
      clearTimeout(labelTimer);
      clearTimeout(warnTimer);
    };
  }, [busy]);

  if (!busy) return null;

  return (
    <>
      <div style={{ position: 'fixed', inset: 0, zIndex: 5000, cursor: 'progress' }} />
      {showLabel && (
        <div style={{
          position: 'fixed', left: '50%', bottom: 24, transform: 'translateX(-50%)',
          zIndex: 5001, padding: '6px 14px', borderRadius: 6,
          background: 'rgba(0,0,0,0.7)', color: '#fff', fontSize: 13,
          pointerEvents: 'none',
        }}>
          {formatBusyLabel(uiBusyLabel())}
        </div>
      )}
    </>
  );
});
