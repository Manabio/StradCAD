import { TOP_BAR } from '../layout.js';
import { ModeIcon } from './modeIcons.jsx';
import { PLACED_FIGURE_MODE_IDS, placedFigureModeLabelOf } from '../core/placedFigureModes.js';

// モード切替バー — 横長は上部中央、縦長は下部中央に常時表示。
// 旧 HamburgerMenu のモード項目（平面/仕上げ/構造/敷地）を画面上に昇格したもの。
// キーボード・タッチ共通で操作できるよう、通常の <button> で構成する。
// 項目2: 「建具」ボタンはここから外す（建具モードへの突入は「平面モードで建具追加」
// 「他モードでの建具ターゲットクリック」の2経路に一本化する）。モード自体・境界処理
// （modeBoundaries.opening）・undo履歴ナビゲーションでの復元経路（switchHistoryContext）は
// App.jsx にそのまま残っている——ここはボタンを配列から外すだけ。
// ボタンの中身は文字でなくアイコン（ui/modeIcons.jsx。万国共通の図柄・文字なし）。label は
// ツールチップ（title）・読み上げ（aria-label）・App.jsx のトースト文言の対応付けに残す。
const MODES = [
  { mode: 'floorplan', label: '平面' },
  { mode: 'finish',    label: '仕上げ' },
  { mode: 'ceiling',   label: '天伏' },
  { mode: 'structure', label: '構造' },
  { mode: 'site',      label: '敷地' },
  { mode: 'elevation', label: '展開' },
  { mode: 'facade',    label: '立面' },
  // 図面モード（姿図配置モード）は定義表から導く（モードごとにここへ足さない。core/placedFigureModes.js）
  ...PLACED_FIGURE_MODE_IDS.map(id => ({ mode: id, label: placedFigureModeLabelOf(id) })),
];

export function ModeBar({ appMode, onSelect, isLandscape }) {
  const position = isLandscape
    ? { top: 0, height: TOP_BAR }
    : { bottom: 8 };

  return (
    <div style={{
      position: 'fixed',
      left: '50%', transform: 'translateX(-50%)',
      ...position,
      display: 'flex', alignItems: 'center', gap: 4,
      zIndex: 205,
    }}>
      {MODES.map(({ mode, label }) => {
        const active = appMode === mode;
        return (
          <button
            key={mode}
            onClick={() => onSelect(mode)}
            aria-pressed={active}
            aria-label={label}
            title={label}
            style={{
              padding: '4px 10px',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              lineHeight: 0,
              border: '1px solid',
              borderColor: active ? '#2563eb' : '#cbd5e1',
              borderRadius: 8,
              background: active ? '#2563eb' : 'rgba(255,255,255,0.95)',
              color: active ? '#fff' : '#1e293b',
              fontSize: 13, fontWeight: 600,
              cursor: 'pointer',
              boxShadow: active ? 'none' : '0 1px 3px rgba(0,0,0,0.08)',
            }}
          >
            <ModeIcon mode={mode} />
          </button>
        );
      })}
    </div>
  );
}
