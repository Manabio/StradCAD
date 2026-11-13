// モードバーのアイコン（ui/ModeBar.jsx の MODES の mode 値ごとに1つ）。
// 文字（どの言語の文字も）を入れず、図柄・記号だけで万国共通に伝わる形にする。
// 線は currentColor で描くので、ボタンの色（active/非active）にそのまま追従する。
// 24×24 のビューボックス・線幅 1.6・丸端で統一。
import { isPlacedFigureMode } from '../core/placedFigureModes.js';

const BASE = {
  width: 20, height: 20, viewBox: '0 0 24 24',
  fill: 'none', stroke: 'currentColor', strokeWidth: 1.6,
  strokeLinecap: 'round', strokeLinejoin: 'round',
  'aria-hidden': true, focusable: 'false',
};

/** 平面: 外壁の四角＋間仕切り＋扉の開き（平面図の記号）。 */
const FloorplanIcon = () => (
  <svg {...BASE}>
    <rect x="3" y="3" width="18" height="18" />
    <path d="M12 3v8M3 13h7" />
    <path d="M12 13h3" />
    <path d="M15 13a5 5 0 0 1 5 5" />
    <path d="M20 13v8" />
  </svg>
);

/** 仕上げ: ペイントローラー（仕上げ・塗装）。 */
const FinishIcon = () => (
  <svg {...BASE}>
    <rect x="4" y="3" width="13" height="6" rx="1" />
    <path d="M17 6h3v5h-8v3" />
    <rect x="10.5" y="14" width="3" height="7" rx="1" />
  </svg>
);

/** 天伏: 天井（上の太い線と壁の立ち上がり）を下から見上げる上向き矢印。 */
const CeilingIcon = () => (
  <svg {...BASE}>
    <path d="M3 4h18" />
    <path d="M3 4v4M21 4v4" />
    <path d="M12 21V9" />
    <path d="M7 14l5-5 5 5" />
  </svg>
);

/** 構造: 柱・梁・ブレースの骨組み。 */
const StructureIcon = () => (
  <svg {...BASE}>
    <path d="M3 4h18" />
    <path d="M5 4v17M19 4v17" />
    <path d="M5 8l14 11M19 8L5 19" />
    <path d="M3 21h18" />
  </svg>
);

/** 敷地: 敷地境界（不整形）と、その中の建物。 */
const SiteIcon = () => (
  <svg {...BASE}>
    <path d="M3 6l9-3 9 5-2 13H5z" strokeDasharray="2.4 1.6" />
    <rect x="9" y="10" width="7" height="6" />
  </svg>
);

/** 展開: 箱の展開図（十字に開いた5面）。 */
const ElevationIcon = () => (
  <svg {...BASE}>
    <rect x="9" y="9" width="6" height="6" />
    <rect x="9" y="3" width="6" height="6" />
    <rect x="9" y="15" width="6" height="6" />
    <rect x="3" y="9" width="6" height="6" />
    <rect x="15" y="9" width="6" height="6" />
  </svg>
);

/** 立面: 建物の正面（屋根・壁・中央の窓1つ）。扉は入れず要素を絞って視認性を上げる。 */
const FacadeIcon = () => (
  <svg {...BASE}>
    <path d="M2 11l10-7 10 7" />
    <path d="M5 10v11h14V10" />
    <rect x="9.5" y="13" width="5" height="5" />
  </svg>
);

/** 図面モード（姿図配置モード）共通: 平面（外形の四角）に置いた器具（円）。個別のアイコンは持たない。 */
const PlacedFigureIcon = () => (
  <svg {...BASE}>
    <rect x="3" y="3" width="18" height="18" />
    <circle cx="12" cy="12" r="4" />
  </svg>
);

// mode 値→アイコン部品。export は部品（ModeIcon）だけにする（react-refresh/only-export-components）。
// 図面モードはこの表に載せず、ModeIcon が isPlacedFigureMode で共通のアイコンへ落とす（モードごとに表へ足さない）。
const MODE_ICONS = Object.freeze({
  floorplan: FloorplanIcon,
  finish:    FinishIcon,
  ceiling:   CeilingIcon,
  structure: StructureIcon,
  site:      SiteIcon,
  elevation: ElevationIcon,
  facade:    FacadeIcon,
});

/** モードバーのアイコン。図面モードは共通のアイコン。未知の mode は描かない（null）。 */
export function ModeIcon({ mode }) {
  const Icon = MODE_ICONS[mode] ?? (isPlacedFigureMode(mode) ? PlacedFigureIcon : null);
  return Icon ? <Icon /> : null;
}
