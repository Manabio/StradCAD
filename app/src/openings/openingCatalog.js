// ================================================================
// 開口（建具・窓）カタログ — 種別・ラベル・機構・既定寸法
//
// 仕上げモードの材マスタ（finish/materials/*）とは異なり、開口カタログは
// フロアプランモードでも使うため動的 import にせず静的 import する
// （小さな静的データのため interiorMasters.js と同じ扱い）。
// ================================================================

export const OpeningMechanism = Object.freeze({
  SWING:        'swing',       // 1枚の扉が蝶番で回転して開く
  SLIDE_DOUBLE: 'slideDouble', // 2枚が重なってスライドする
  SLIDE_SINGLE: 'slideSingle', // 1枚がスライドする
  FOLD:         'fold',        // 折れ戸・折りたたみ窓
  FREE:         'free',        // 自由扉（自由蝶番）
  FIXED:        'fixed',       // 開閉なし
  HUNG:         'hung',
  AWNING:       'awning',
  TILT:         'tilt',
  LOUVER:       'louver',
  PIVOT:        'pivot',
});

// このフェーズで実描画を実装する機構。他は壁開口（ギャップ）のみ描画し、記号は未実装。
export const IMPLEMENTED_MECHANISMS = new Set([
  OpeningMechanism.SWING,
  OpeningMechanism.SLIDE_DOUBLE,
]);

export const FITTING_CATALOG = [
  { key: 'singleSwing',   label: '片開き戸',   mechanism: OpeningMechanism.SWING,        wallKinds: ['interior'],            defaultWidth: 800,  defaultHeight: 2000 },
  { key: 'sliding',       label: '引き戸',     mechanism: OpeningMechanism.SLIDE_SINGLE, wallKinds: ['interior', 'exterior'], defaultWidth: 800,  defaultHeight: 2000 },
  { key: 'doubleSliding', label: '引き違い戸', mechanism: OpeningMechanism.SLIDE_DOUBLE, wallKinds: ['interior', 'exterior'], defaultWidth: 1600, defaultHeight: 2000 },
  { key: 'folding',       label: '折れ戸',     mechanism: OpeningMechanism.FOLD,         wallKinds: ['interior'],            defaultWidth: 800,  defaultHeight: 2000 },
  { key: 'swingDoor',     label: '開き戸',     mechanism: OpeningMechanism.SWING,        wallKinds: ['interior'],            defaultWidth: 800,  defaultHeight: 2000 },
  { key: 'door',          label: 'ドア',       mechanism: OpeningMechanism.SWING,        wallKinds: ['exterior'],            defaultWidth: 900,  defaultHeight: 2000 },
  { key: 'swing',         label: '開き',       mechanism: OpeningMechanism.SWING,        wallKinds: ['exterior'],            defaultWidth: 900,  defaultHeight: 2000 },
  { key: 'freeDoor',      label: '自由扉',     mechanism: OpeningMechanism.FREE,         wallKinds: ['exterior'],            defaultWidth: 900,  defaultHeight: 2000 },
];

export const WINDOW_CATALOG = [
  { key: 'doubleSliding', label: '引き違い窓',                         mechanism: OpeningMechanism.SLIDE_DOUBLE, defaultWidth: 1690, defaultHeight: 1170 },
  { key: 'casement',      label: '開き窓',                             mechanism: OpeningMechanism.SWING,        defaultWidth: 600,  defaultHeight: 900  },
  { key: 'doubleHung',    label: '上げ下げ窓',                         mechanism: OpeningMechanism.HUNG,         defaultWidth: 600,  defaultHeight: 900  },
  { key: 'awning',        label: 'すべり出し窓',                       mechanism: OpeningMechanism.AWNING,       defaultWidth: 600,  defaultHeight: 500  },
  { key: 'fixed',         label: 'フィックス窓（FIX窓）',               mechanism: OpeningMechanism.FIXED,        defaultWidth: 600,  defaultHeight: 600  },
  { key: 'hopper',        label: '倒し窓',                             mechanism: OpeningMechanism.TILT,         defaultWidth: 600,  defaultHeight: 500  },
  { key: 'louver',        label: 'ルーバー窓',                         mechanism: OpeningMechanism.LOUVER,       defaultWidth: 600,  defaultHeight: 900  },
  { key: 'foldingWindow', label: '折りたたみ窓（フォールディング窓）', mechanism: OpeningMechanism.FOLD,         defaultWidth: 1600, defaultHeight: 1800 },
  { key: 'pivot',         label: '回転窓',                             mechanism: OpeningMechanism.PIVOT,        defaultWidth: 600,  defaultHeight: 900  },
];

// 建具記号（材質×種別）。マスタは1箇所のみ（fixtureType の意味拡張。.claude/opening-model.md）。
export const FIXTURE_SYMBOLS = [
  { key: 'AW', label: 'AW（アルミ製窓）',     category: 'window'  },
  { key: 'JW', label: 'JW（樹脂製窓）',       category: 'window'  },
  { key: 'SW', label: 'SW（スチール製窓）',   category: 'window'  },
  { key: 'AD', label: 'AD（アルミ製ドア）',   category: 'fitting' },
  { key: 'SD', label: 'SD（スチール製ドア）', category: 'fitting' },
  { key: 'WD', label: 'WD（木製建具）',       category: 'fitting' },
];

/** wallKind ('interior' | 'exterior') に応じた建具カタログの絞り込み。 */
export function getFittingOptions(wallKind) {
  return FITTING_CATALOG.filter(o => o.wallKinds.includes(wallKind));
}

export function findCatalogEntry(category, subType) {
  const list = category === 'window' ? WINDOW_CATALOG : FITTING_CATALOG;
  return list.find(o => o.key === subType) ?? null;
}

/** category ('window' | 'fitting') に一致する建具記号一覧。 */
export function getFixtureSymbols(category) {
  return FIXTURE_SYMBOLS.filter(f => f.category === category);
}

/** 建具記号未設定（旧データ）時のカテゴリ既定記号。唯一の定義箇所。 */
export function defaultFixtureSymbol(category) {
  return category === 'window' ? 'AW' : 'WD';
}

/** 新規配置時の既定建具記号（wallKind も加味）。 */
export function defaultFixtureSymbolFor(category, wallKind) {
  if (category === 'window') return 'AW';
  return wallKind === 'exterior' ? 'AD' : 'WD';
}

/** カテゴリ・種別に応じた既定建具高さ(mm)。カタログに無い場合はカテゴリ既定にフォールバック。 */
export function defaultOpeningHeight(category, subType) {
  return findCatalogEntry(category, subType)?.defaultHeight ?? (category === 'window' ? 1100 : 2000);
}

/**
 * 窓台高さ入力文字列 → Opening.sillHeight（number | null）。
 * core.js のコメントどおり null=未設定 の意味論をUI側でも守る:
 *   - 窓カテゴリでなければ null（窓以外は意味を持たないフィールド）。
 *   - 窓カテゴリで入力欄が空欄なら null（0mmと未設定を区別する）。
 *   - それ以外（不正入力含む）は幅・位置と同じ変換規約（Math.abs(Number(s)) || 0）。
 * @param {string} sillStr
 * @param {boolean} isWindow
 * @returns {number|null}
 */
export function parseSillHeight(sillStr, isWindow) {
  if (!isWindow) return null;
  const s = (sillStr ?? '').trim();
  if (s === '') return null;
  return Math.abs(Number(s)) || 0;
}
