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
  HUNG:         'hung',        // 上げ下げ窓
  AWNING:       'awning',      // 横すべり出し窓
  TILT:         'tilt',        // 内倒し窓
  LOUVER:       'louver',      // ガラスルーバー窓
  PIVOT:        'pivot',       // 縦軸回転窓
  SWING_DOUBLE: 'swingDouble',      // 両開き戸・両開き窓
  SWING_CHILD:  'swingChild',       // 親子扉
  SWING_IN:     'swingIn',          // 内開き窓
  FREE_DOUBLE:  'freeDouble',       // 自由両開き扉
  SHUTTER:      'shutter',          // シャッター
  OVERHEAD:     'overhead',         // オーバーヘッドドア
  EMERGENCY:    'emergency',        // 非常用進入口
  FIRE_DOOR:    'fireDoor',         // 常時開放式防火戸
  FIRE_FOLD:    'fireFold',         // 常時開放式防火折戸
  SLIDE_LAYOUT: 'slideLayout',      // 片引き/引き分け/両袖片引き/自由片引き/多枚建て引違い
  PROJECT_V:    'projectVertical',  // 縦すべり出し窓
  PROJECT_OUT:  'projectOut',       // 突出し窓
  TILT_OUT:     'tiltOut',          // 外倒し窓
  PIVOT_H:      'pivotHorizontal',  // 横軸回転窓
  DREH_KIPP:    'drehKipp',         // ドレーキップ窓
  AWNING_MULTI: 'awningMulti',      // オーニング窓
  GARARI:       'garari',           // ガラリ（固定）
  GLASS_BLOCK:  'glassBlock',       // ガラスブロック
});

// 吊元(hingeSide)・開き勝手(swingSide)を持つ機構の集合（唯一の定義箇所）。OpeningEditor.jsx の
// 「吊元反転/開く方向反転」ボタン表示条件、openingEdit.js の openDirForMechanism 再計算対象判定
// （種別変更時）が参照する。
export const HINGED_MECHANISMS = new Set([
  OpeningMechanism.SWING,
  OpeningMechanism.SWING_DOUBLE,
  OpeningMechanism.SWING_CHILD,
  OpeningMechanism.SWING_IN,
  OpeningMechanism.FREE,
  OpeningMechanism.FREE_DOUBLE,
  OpeningMechanism.PROJECT_V,
  OpeningMechanism.DREH_KIPP,
  OpeningMechanism.FIRE_DOOR,
  OpeningMechanism.FIRE_FOLD,
]);

// 非蝶番系のうち、一般記号自身が開口全幅の枠矩形（サッシ枠rect）を描く機構の集合（唯一の定義箇所）。
// 詳細LODの方立（縦枠）はこれらの機構では記号側の枠矩形と内側の縦線が同一座標で重なるため、
// 方立側は内側の縦線を持たない3辺（コの字）で描く必要がある——閉じた矩形のまま重ねると
// 「開口の縁の二重描画」になる（renderer/OpeningsLayer.jsx sashFrameOpenSymbol・
// openingPlanSymbolGeometry.js planSymbolPlan の frame:'sashOpen' が参照）。
//
// 既知の例外（未解消・軽微）: SHUTTER/OVERHEADは含めていない。どちらも記号自身が「開口全幅の
// 枠矩形」を持たない（一点鎖線1本・破線Rectの短辺のみ）ため、'sashOpen'（内側縦線なしのコの字）
// へ寄せると方立の外形が内法端で途切れてしまう。'sash'（閉じた矩形）のままなので、内法端
// （coord1+jambW/coord2-jambW）でtick・破線と方立内側縦線がalong座標で一部重なる——F5ほど大きな
// 帯全幅の完全重複ではないため、幾何は変更せずこの既知差異として記録するに留める。
export const SASH_OPEN_MECHANISMS = new Set([
  OpeningMechanism.SLIDE_SINGLE,
  OpeningMechanism.SLIDE_LAYOUT,
  OpeningMechanism.HUNG,
  OpeningMechanism.FIXED,
  OpeningMechanism.TILT,
  OpeningMechanism.TILT_OUT,
  OpeningMechanism.AWNING,
  OpeningMechanism.PROJECT_OUT,
  OpeningMechanism.LOUVER,
  OpeningMechanism.AWNING_MULTI,
  OpeningMechanism.GARARI,
  OpeningMechanism.GLASS_BLOCK,
  OpeningMechanism.PIVOT_H,
]);

// このフェーズで平面記号を実装する機構（姿図は別フェーズ。未実装の姿図はラベル表示へ
// フォールバックする＝openingElevationFigure.js mechanismPrimitives の既定分岐）。
export const IMPLEMENTED_MECHANISMS = new Set([
  OpeningMechanism.SWING,
  OpeningMechanism.SLIDE_DOUBLE,
  OpeningMechanism.SLIDE_SINGLE,
  OpeningMechanism.FOLD,
  OpeningMechanism.FREE,
  OpeningMechanism.FIXED,
  OpeningMechanism.HUNG,
  OpeningMechanism.AWNING,
  OpeningMechanism.TILT,
  OpeningMechanism.LOUVER,
  OpeningMechanism.PIVOT,
  OpeningMechanism.SWING_DOUBLE,
  OpeningMechanism.SWING_CHILD,
  OpeningMechanism.SWING_IN,
  OpeningMechanism.FREE_DOUBLE,
  OpeningMechanism.SHUTTER,
  OpeningMechanism.OVERHEAD,
  OpeningMechanism.EMERGENCY,
  OpeningMechanism.FIRE_DOOR,
  OpeningMechanism.FIRE_FOLD,
  OpeningMechanism.SLIDE_LAYOUT,
  OpeningMechanism.PROJECT_V,
  OpeningMechanism.PROJECT_OUT,
  OpeningMechanism.TILT_OUT,
  OpeningMechanism.PIVOT_H,
  OpeningMechanism.DREH_KIPP,
  OpeningMechanism.AWNING_MULTI,
  OpeningMechanism.GARARI,
  OpeningMechanism.GLASS_BLOCK,
]);

export const FITTING_CATALOG = [
  { key: 'singleSwing',   label: '片開き戸',     mechanism: OpeningMechanism.SWING,        wallKinds: ['interior'],            defaultWidth: 800,  defaultHeight: 2000 },
  { key: 'sliding',       label: '引き戸',       mechanism: OpeningMechanism.SLIDE_SINGLE, wallKinds: ['interior', 'exterior'], defaultWidth: 800,  defaultHeight: 2000 },
  { key: 'doubleSliding', label: '引き違い戸',   mechanism: OpeningMechanism.SLIDE_DOUBLE, wallKinds: ['interior', 'exterior'], defaultWidth: 1600, defaultHeight: 2000 },
  { key: 'folding',       label: '折れ戸',       mechanism: OpeningMechanism.FOLD,         wallKinds: ['interior'],            defaultWidth: 800,  defaultHeight: 2000 },
  { key: 'door',          label: 'ドア',         mechanism: OpeningMechanism.SWING,        wallKinds: ['exterior'],            defaultWidth: 900,  defaultHeight: 2000 },
  { key: 'swing',         label: '開き',         mechanism: OpeningMechanism.SWING,        wallKinds: ['exterior'],            defaultWidth: 900,  defaultHeight: 2000 },
  { key: 'freeDoor',      label: '自由片開き扉', mechanism: OpeningMechanism.FREE,         wallKinds: ['interior', 'exterior'], defaultWidth: 900,  defaultHeight: 2000 },
  { key: 'doubleSwing',   label: '両開き戸',                     mechanism: OpeningMechanism.SWING_DOUBLE, wallKinds: ['interior', 'exterior'], defaultWidth: 1600, defaultHeight: 2000 },
  { key: 'parentChild',   label: '親子扉',                       mechanism: OpeningMechanism.SWING_CHILD,  wallKinds: ['interior', 'exterior'], defaultWidth: 1200, defaultHeight: 2000, childRatio: 0.3 },
  { key: 'freeDouble',    label: '自由両開き扉',                 mechanism: OpeningMechanism.FREE_DOUBLE,  wallKinds: ['interior'],             defaultWidth: 1400, defaultHeight: 2000 },
  { key: 'shutter',       label: 'シャッター',                   mechanism: OpeningMechanism.SHUTTER,      wallKinds: ['exterior'],             defaultWidth: 2000, defaultHeight: 2200 },
  { key: 'overheadDoor',  label: 'オーバーヘッドドア',           mechanism: OpeningMechanism.OVERHEAD,     wallKinds: ['exterior'],             defaultWidth: 2600, defaultHeight: 2200 },
  { key: 'emergencyEntry',label: '非常用進入口',                 mechanism: OpeningMechanism.EMERGENCY,    wallKinds: ['exterior'],             defaultWidth: 750,  defaultHeight: 1200 },
  { key: 'fireDoorDouble',      label: '常時開放式防火戸(両開き)',       mechanism: OpeningMechanism.FIRE_DOOR, wallKinds: ['interior'], defaultWidth: 1800, defaultHeight: 2000, fireLeaves: 2, fireAngle: 90  },
  { key: 'fireDoorSingle',      label: '常時開放式防火戸(片開き)',       mechanism: OpeningMechanism.FIRE_DOOR, wallKinds: ['interior'], defaultWidth: 900,  defaultHeight: 2000, fireLeaves: 1, fireAngle: 90  },
  { key: 'fireDoorDouble180',   label: '常時開放式防火戸(両開き180度)',  mechanism: OpeningMechanism.FIRE_DOOR, wallKinds: ['interior'], defaultWidth: 1800, defaultHeight: 2000, fireLeaves: 2, fireAngle: 180 },
  { key: 'fireDoorSingle180',   label: '常時開放式防火戸(片開き180度)',  mechanism: OpeningMechanism.FIRE_DOOR, wallKinds: ['interior'], defaultWidth: 900,  defaultHeight: 2000, fireLeaves: 1, fireAngle: 180 },
  { key: 'fireFold90',          label: '常時開放式防火折戸(90度)',       mechanism: OpeningMechanism.FIRE_FOLD, wallKinds: ['interior'], defaultWidth: 1600, defaultHeight: 2000, fireAngle: 90  },
  { key: 'fireFold180',         label: '常時開放式防火折戸(180度)',      mechanism: OpeningMechanism.FIRE_FOLD, wallKinds: ['interior'], defaultWidth: 1600, defaultHeight: 2000, fireAngle: 180 },
];

export const WINDOW_CATALOG = [
  { key: 'doubleSliding', label: '引き違い窓',                         mechanism: OpeningMechanism.SLIDE_DOUBLE, defaultWidth: 1690, defaultHeight: 1170 },
  { key: 'casement',      label: '外開き窓',                           mechanism: OpeningMechanism.SWING,        defaultWidth: 600,  defaultHeight: 900  },
  { key: 'doubleHung',    label: '上げ下げ窓',                         mechanism: OpeningMechanism.HUNG,         defaultWidth: 600,  defaultHeight: 900  },
  { key: 'awning',        label: 'すべり出し窓',                       mechanism: OpeningMechanism.AWNING,       defaultWidth: 600,  defaultHeight: 500  },
  { key: 'fixed',         label: 'フィックス窓（FIX窓）',               mechanism: OpeningMechanism.FIXED,        defaultWidth: 600,  defaultHeight: 600  },
  { key: 'hopper',        label: '内倒し窓',                           mechanism: OpeningMechanism.TILT,         defaultWidth: 600,  defaultHeight: 500  },
  { key: 'louver',        label: 'ガラスルーバー窓',                   mechanism: OpeningMechanism.LOUVER,       defaultWidth: 600,  defaultHeight: 900  },
  { key: 'foldingWindow', label: '折りたたみ窓（フォールディング窓）', mechanism: OpeningMechanism.FOLD,         defaultWidth: 1600, defaultHeight: 1800 },
  { key: 'pivot',         label: '縦軸回転窓',                         mechanism: OpeningMechanism.PIVOT,        defaultWidth: 600,  defaultHeight: 900  },
  { key: 'doubleSliding3',    label: '引き違い窓（3枚建て）', mechanism: OpeningMechanism.SLIDE_LAYOUT, defaultWidth: 2550, defaultHeight: 1170, slideLayout: { tracks: 3, panels: [{ arrow: 'neg' }, { arrow: 'both' }, { arrow: 'pos' }] } },
  { key: 'doubleSliding4',    label: '引き違い窓（4枚建て）', mechanism: OpeningMechanism.SLIDE_LAYOUT, defaultWidth: 3370, defaultHeight: 1170, slideLayout: { tracks: 2, panels: [{ arrow: 'neg' }, { arrow: 'neg' }, { arrow: 'pos' }, { arrow: 'pos' }] } },
  { key: 'singleSliding',     label: '片引き窓',              mechanism: OpeningMechanism.SLIDE_LAYOUT, defaultWidth: 1235, defaultHeight: 1170, slideLayout: { tracks: 2, panels: [{ arrow: 'pos' }, { fix: true }] } },
  { key: 'splitSliding',      label: '引き分け窓',            mechanism: OpeningMechanism.SLIDE_LAYOUT, defaultWidth: 2600, defaultHeight: 1170, slideLayout: { tracks: 2, panels: [{ fix: true }, { arrow: 'neg' }, { arrow: 'pos' }, { fix: true }] } },
  { key: 'flankSliding',      label: '両袖片引き窓',          mechanism: OpeningMechanism.SLIDE_LAYOUT, defaultWidth: 2550, defaultHeight: 1170, slideLayout: { tracks: 2, panels: [{ arrow: 'pos' }, { fix: true }, { arrow: 'neg' }] } },
  { key: 'bypassSliding',     label: '自由片引き窓',          mechanism: OpeningMechanism.SLIDE_LAYOUT, defaultWidth: 2550, defaultHeight: 1170, slideLayout: { tracks: 2, panels: [{ fix: true }, { arrow: 'both' }, { fix: true }] } },
  { key: 'casementProjected', label: '縦すべり出し窓',        mechanism: OpeningMechanism.PROJECT_V,   defaultWidth: 600,  defaultHeight: 1100 },
  { key: 'doubleCasement',    label: '両開き窓',              mechanism: OpeningMechanism.SWING_DOUBLE, defaultWidth: 1200, defaultHeight: 900  },
  { key: 'inswing',           label: '内開き窓',              mechanism: OpeningMechanism.SWING_IN,     defaultWidth: 600,  defaultHeight: 900  },
  { key: 'drehKipp',          label: 'ドレーキップ窓',        mechanism: OpeningMechanism.DREH_KIPP,    defaultWidth: 600,  defaultHeight: 1100 },
  { key: 'pivotHorizontal',   label: '横軸回転窓',            mechanism: OpeningMechanism.PIVOT_H,      defaultWidth: 900,  defaultHeight: 600  },
  { key: 'projectedOut',      label: '突出し窓',              mechanism: OpeningMechanism.PROJECT_OUT,  defaultWidth: 600,  defaultHeight: 500  },
  { key: 'tiltOut',           label: '外倒し窓',              mechanism: OpeningMechanism.TILT_OUT,     defaultWidth: 600,  defaultHeight: 500  },
  { key: 'awningMulti',       label: 'オーニング窓',          mechanism: OpeningMechanism.AWNING_MULTI, defaultWidth: 600,  defaultHeight: 1100 },
  { key: 'garari',            label: 'ガラリ（固定）',        mechanism: OpeningMechanism.GARARI,       defaultWidth: 600,  defaultHeight: 600  },
  { key: 'glassBlock',        label: 'ガラスブロック',        mechanism: OpeningMechanism.GLASS_BLOCK,  defaultWidth: 600,  defaultHeight: 600  },
];

// 建具記号（材質×種別）。マスタは1箇所のみ（fixtureType の意味拡張。.claude/opening-model.md）。
export const FIXTURE_SYMBOLS = [
  { key: 'AW', label: 'AW（アルミ製窓）',     category: 'window'  },
  { key: 'JW', label: 'JW（樹脂製窓）',       category: 'window'  },
  { key: 'SW', label: 'SW（スチール製窓）',   category: 'window'  },
  { key: 'WW', label: 'WW（木製窓）',         category: 'window'  },
  { key: 'AD', label: 'AD（アルミ製ドア）',   category: 'fitting' },
  { key: 'SD', label: 'SD（スチール製ドア）', category: 'fitting' },
  { key: 'WD', label: 'WD（木製建具）',       category: 'fitting' },
];

// 建具表「材料・ガラス」欄の記号別初期値。AW/AD=アルミ、WD/WW=木質、JW=樹脂、SW/SD=スチール
// （記号の意味＝材質から導出。WDのみ既製品の慣習表記で建具種別まで含める）。
export const DEFAULT_MATERIALS = {
  AW: 'アルミ',
  AD: 'アルミ',
  WD: 'ポリ合板フラッシュ戸、木製枠',
  WW: '木製',
  JW: '樹脂',
  SW: 'スチール',
  SD: 'スチール',
};

/** wallKind ('interior' | 'exterior') に応じた建具カタログの絞り込み。 */
export function getFittingOptions(wallKind) {
  return FITTING_CATALOG.filter(o => o.wallKinds.includes(wallKind));
}

// 廃止した種別キー → 現行キーの読み替え表（唯一の定義箇所）。旧データのデコード時に正規化する
// ため、カタログ本体・UIのselect・記号採番はすべて現行キーだけを扱えばよい。
//   swingDoor（開き戸）: singleSwing（片開き戸）と機構・既定寸法まで同一の重複項目だったため廃止。
export const LEGACY_SUBTYPE_ALIASES = Object.freeze({
  fitting: { swingDoor: 'singleSwing' },
  window:  {},
});

/** 旧データの種別キーを現行キーへ読み替える（未知・現行キーはそのまま返す）。 */
export function normalizeSubType(category, subType) {
  if (!subType) return subType;
  return LEGACY_SUBTYPE_ALIASES[category === 'window' ? 'window' : 'fitting'][subType] ?? subType;
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

/** 建具記号に応じた「材料・ガラス」欄の既定値（DEFAULT_MATERIALS参照）。未知の記号はnull。 */
export function defaultMaterialGlassFor(symbol) {
  return DEFAULT_MATERIALS[symbol] ?? null;
}

/**
 * カテゴリ・機構に応じた「備考」欄の既定値。建具（fitting）×SWING機構（片開き戸等）はレバーハンドル
 * が一般的なため既定値とする。窓（window）はSWING機構（開き窓等）でも金物としてのレバーハンドルは
 * 想定しないため常にnull（defaultMaterialGlassForと同じ「唯一の定義箇所」規約。openingEdit.js の
 * 配置経路・種別変更差し替え経路の両方がここを呼ぶ）。
 */
export function defaultNoteFor(category, mechanism) {
  return category === 'fitting' && mechanism === OpeningMechanism.SWING ? 'レバーハンドル' : null;
}
