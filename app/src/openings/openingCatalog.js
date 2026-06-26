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
  { key: 'singleSwing',   label: '片開き戸',   mechanism: OpeningMechanism.SWING,        wallKinds: ['interior'],            defaultWidth: 800  },
  { key: 'sliding',       label: '引き戸',     mechanism: OpeningMechanism.SLIDE_SINGLE, wallKinds: ['interior', 'exterior'], defaultWidth: 800  },
  { key: 'doubleSliding', label: '引き違い戸', mechanism: OpeningMechanism.SLIDE_DOUBLE, wallKinds: ['interior', 'exterior'], defaultWidth: 1600 },
  { key: 'folding',       label: '折れ戸',     mechanism: OpeningMechanism.FOLD,         wallKinds: ['interior'],            defaultWidth: 800  },
  { key: 'swingDoor',     label: '開き戸',     mechanism: OpeningMechanism.SWING,        wallKinds: ['interior'],            defaultWidth: 800  },
  { key: 'door',          label: 'ドア',       mechanism: OpeningMechanism.SWING,        wallKinds: ['exterior'],            defaultWidth: 900  },
  { key: 'swing',         label: '開き',       mechanism: OpeningMechanism.SWING,        wallKinds: ['exterior'],            defaultWidth: 900  },
  { key: 'freeDoor',      label: '自由扉',     mechanism: OpeningMechanism.FREE,         wallKinds: ['exterior'],            defaultWidth: 900  },
];

export const WINDOW_CATALOG = [
  { key: 'doubleSliding', label: '引き違い窓',                         mechanism: OpeningMechanism.SLIDE_DOUBLE, defaultWidth: 1690 },
  { key: 'casement',      label: '開き窓',                             mechanism: OpeningMechanism.SWING,        defaultWidth: 600  },
  { key: 'doubleHung',    label: '上げ下げ窓',                         mechanism: OpeningMechanism.HUNG,         defaultWidth: 600  },
  { key: 'awning',        label: 'すべり出し窓',                       mechanism: OpeningMechanism.AWNING,       defaultWidth: 600  },
  { key: 'fixed',         label: 'フィックス窓（FIX窓）',               mechanism: OpeningMechanism.FIXED,        defaultWidth: 600  },
  { key: 'hopper',        label: '倒し窓',                             mechanism: OpeningMechanism.TILT,         defaultWidth: 600  },
  { key: 'louver',        label: 'ルーバー窓',                         mechanism: OpeningMechanism.LOUVER,       defaultWidth: 600  },
  { key: 'foldingWindow', label: '折りたたみ窓（フォールディング窓）', mechanism: OpeningMechanism.FOLD,         defaultWidth: 1600 },
  { key: 'pivot',         label: '回転窓',                             mechanism: OpeningMechanism.PIVOT,        defaultWidth: 600  },
];

/** wallKind ('interior' | 'exterior') に応じた建具カタログの絞り込み。 */
export function getFittingOptions(wallKind) {
  return FITTING_CATALOG.filter(o => o.wallKinds.includes(wallKind));
}

export function findCatalogEntry(category, subType) {
  const list = category === 'window' ? WINDOW_CATALOG : FITTING_CATALOG;
  return list.find(o => o.key === subType) ?? null;
}
