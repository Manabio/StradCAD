// ================================================================
// カタログ種別の登録表（唯一の定義箇所）＋ 材料分類表（MATERIAL_CLASSES）。
//
// カタログ束（.stq 同梱／ユーザーライブラリ）を構成する5種別
// （材料・内装マスター・境界マスター・構造断面・建具種別）を1本の表に持つ。
// 種別の追加はこの表に1行足すだけでよい。
//
// 純モジュール（葉）。store.js / snap.js / .jsx を静的 import しない。
// `loadBuiltin` だけが本体標準マスタへの**動的 import の thunk**——node:test では
// thunk を呼ばない限り何も読み込まれない（既存コード分割を維持する）。
//
// `npm run build` で出る [INEFFECTIVE_DYNAMIC_IMPORT] 警告3件
// （interiorMasters.js/sectionCatalog.js/openingCatalog.js）は想定どおり——この3本は既に
// core/room.js・structural/structuralEntities.js 等から静的 import されており独立チャンクに
// ならない。ここでの動的 import は「コード分割」目的ではなく node:test から本ファイルを
// 静的import しても何も読み込まれない純モジュールを維持するための thunk（catalogImports.test.js
// が固定）。**materialData.js がこの警告に現れたら不変条件7-1（materialDataの独立チャンク
// 維持）の退行——materialData.js は他のどこからも静的importされていないため、警告3件から
// 増えていないかを都度確認すること。
// ================================================================

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}
function isNullableFiniteNumber(v) {
  return v === null || isFiniteNumber(v);
}
function isNonEmptyString(v) {
  return typeof v === 'string' && v.length > 0;
}

/**
 * 建具種別（openingSubType）の isSupported フックが対象とする既知 mechanism の凍結配列
 * （2026-09-23 ステップ10d）。openings/openingCatalog.js の OpeningMechanism を
 * catalogKinds.js から静的 import できない（catalogImports.test.js の許可リスト）ため、
 * 値の集合だけをここに複製する——catalogRealMasters.test.js で Object.values(OpeningMechanism)
 * と一致することを固定し、両者がずれたら即座に検出する。
 */
export const KNOWN_OPENING_MECHANISMS = Object.freeze([
  'swing', 'slideDouble', 'slideSingle', 'fold', 'free', 'fixed', 'hung', 'awning', 'tilt',
  'louver', 'pivot', 'swingDouble', 'swingChild', 'swingIn', 'freeDouble', 'shutter', 'overhead',
  'emergency', 'fireDoor', 'fireFold', 'slideLayout', 'projectVertical', 'projectOut', 'tiltOut',
  'pivotHorizontal', 'drehKipp', 'awningMulti', 'garari', 'glassBlock', 'frameOnly',
]);
const KNOWN_OPENING_MECHANISMS_SET = new Set(KNOWN_OPENING_MECHANISMS);

/** entry に fields が全て存在する（undefined でない）ことを検査する。欠落は例外。 */
function requireFields(entry, fields, label) {
  if (!isPlainObject(entry)) throw new Error(`${label}はオブジェクトである必要があります`);
  for (const f of fields) {
    if (entry[f] === undefined) throw new Error(`${label}に必須項目が欠落しています: ${f}`);
  }
}

export const CatalogKind = Object.freeze({
  MATERIAL:         'material',
  INTERIOR_MASTER:  'interiorMaster',
  BOUNDARY_MASTER:  'boundaryMaster',
  SECTION:          'section',
  OPENING_SUB_TYPE: 'openingSubType',
});

/**
 * 種別タブ表示名（登録表の種別に対する固定の日本語ラベル）。唯一の定義箇所——
 * ステップ7c までは catalog/catalogMaintenance.js にあったが、store.js（同梱の通知文）も
 * 種別名を必要としたためここへ移設した。catalogMaintenance.js は再輸出のみ行う。
 */
export const KIND_LABELS = Object.freeze({
  [CatalogKind.MATERIAL]:         '材料',
  [CatalogKind.INTERIOR_MASTER]:  '内装マスター',
  [CatalogKind.BOUNDARY_MASTER]:  '境界マスター',
  [CatalogKind.SECTION]:          '断面',
  [CatalogKind.OPENING_SUB_TYPE]: '建具種別',
});

// ----------------------------------------------------------------
// 材料コード分類表（R4・R6・R18・Q13確定 2026-09-22）。数値割当・名称の唯一の定義箇所。
// 中分類は全大分類で「10始まりの2刻み」（`11`は旧体系＝未分類として欠番）。
// ----------------------------------------------------------------
export const MATERIAL_CLASSES = Object.freeze({
  10: Object.freeze({
    label: '木材',
    minors: Object.freeze({ 10: '正角材', 12: '面材', 14: '線材' }),
  }),
  20: Object.freeze({
    label: '鋼材',
    minors: Object.freeze({ 10: '構造材', 12: '軽量鉄骨', 14: '鉄筋', 16: 'デッキプレート' }),
  }),
  30: Object.freeze({
    label: 'その他建材',
    minors: Object.freeze({
      10: '面材', 12: 'ALC', 14: '屋根', 16: 'サイディング', 18: '床仕上げ',
      20: 'シート', 22: '断熱', 24: '左官', 26: '石工',
    }),
  }),
  40: Object.freeze({
    label: '塗装',
    minors: Object.freeze({ 10: '塗料', 12: '防水' }),
  }),
  // 暫定分類（2026-09-22 ステップ3・R6追補）。後日RC造図面で構造材へ昇格予定——
  // 現状は仕上げモードの下地材（材データのcategory:'backing'）としてのみ扱う。
  50: Object.freeze({
    label: 'コンクリート',
    minors: Object.freeze({ 10: 'RC壁' }),
  }),
});

/** 大分類・中分類の数値 → {major,majorLabel,minor,minorLabel}。未定義の組合せは null。 */
export function classOf(major, minor) {
  const majorClass = MATERIAL_CLASSES[major];
  if (!majorClass) return null;
  const minorLabel = majorClass.minors[minor];
  if (minorLabel === undefined) return null;
  return { major, majorLabel: majorClass.label, minor, minorLabel };
}

/**
 * INTERIOR_MASTER の builtinList（{key, ...v}[]）を組み立てる純関数（2026-09-23 QA指摘Minor-1）。
 * INTERIOR_MASTER の loadBuiltin（動的import thunk）・store.js・modes/FinishModeState.js・
 * core/room.js の4箇所で同じ変換式が重複していたため1本化する。
 * @param {{ INTERIOR_MASTERS: Record<string, object> }} mod interiorMasters.js のモジュール
 *        （または同じ形の {INTERIOR_MASTERS} オブジェクト）
 */
export function interiorMasterBuiltinList(mod) {
  return Object.entries(mod.INTERIOR_MASTERS).map(([key, v]) => ({ key, ...v }));
}

// ----------------------------------------------------------------
// 登録表本体。Object.create(null) でプロトタイプ無しにする——kindDef('toString') や
// kindDef('constructor') が Object.prototype の継承メンバーを拾って「動く」ことを防ぐ
// （QA指摘 M2・2026-09-22）。CATALOG_KINDS はこの登録表そのもの（凍結）を公開する。
// listKinds() はここから導出し、列挙手段を1本にする（QA指摘・Minor）。
// ----------------------------------------------------------------
const REGISTRY = Object.assign(Object.create(null), {
  [CatalogKind.MATERIAL]: {
    kind: CatalogKind.MATERIAL,
    // codeが非空文字列でなければ例外（2026-09-22 QA指摘A: openingSubTypeと同じ欠落検査を
    // 全種別に揃える。"undefined"のような壊れたキーを作らない）。
    keyOf: entry => {
      if (!isNonEmptyString(entry?.code)) {
        throw new Error(`材エントリのcodeが不正です（キーを組み立てられません）: ${JSON.stringify(entry)}`);
      }
      return entry.code;
    },
    // keyOf の逆変換（積み残し2026-09-22）。材はkeyがそのままcodeなので{code}を返す。
    parseKey(key) {
      if (!isNonEmptyString(key) || !/^\d{12}$/.test(key)) {
        throw new Error(`材のキー（コード）が不正です（12桁数字が必要）: ${key}`);
      }
      return { code: key };
    },
    encoding: 'json',
    knownFields: ['code', 'name', 'spec', 'x', 'y', 'thickness', 'note', 'category', 'backingClass'],
    requiredFields: ['code', 'name'],
    // ステップ12a（本体編集の固定項目。Q-B確定 2026-09-23）: keyBoundFields は出所を問わず常に
    // 固定（codeが変わると別エントリになる＝keyOfの前提が崩れる）。overrideLockedFields は
    // builtin同キーの上書き（override）だけに追加で固定する——category/backingClassは
    // 材の役割・下地区分の分類そのものであり、本体標準の分類を利用者が書き換えると
    // isEditableMaterialCategory/backingClassOf等の判定基盤が崩れるため。
    keyBoundFields: ['code'],
    overrideLockedFields: ['category', 'backingClass'],
    // R12: 不一致判定は code を除く全項目。spec/thickness は通知なし例外（4.3）。
    compareFields: ['name', 'spec', 'x', 'y', 'thickness', 'category', 'note'],
    silentDiffFields: ['spec', 'thickness'],
    // R14: 完全一致→下から1つずつ外して類似検索（末尾=thicknessから外す）。
    matchFields: ['name', 'spec', 'x', 'y', 'thickness'],
    minMatchFields: 1,
    // R17: category が違っても5項目一致は重複禁止。
    dedupeFields: ['name', 'spec', 'x', 'y', 'thickness'],
    validate(entry) {
      // 4.5-2（QA指摘・Minor）: 未設定はnull・省略は不可。spec/x/y/thicknessは必ず存在すること
      // （thicknessだけnull許容）。materialData.jsの実データ132件は全件この形＝省略なし。
      requireFields(entry, ['code', 'name', 'spec', 'x', 'y', 'thickness'], '材エントリ');
      if (!isNonEmptyString(entry.code) || !/^\d{12}$/.test(entry.code)) {
        throw new Error(`材エントリのcodeが不正です（12桁数字が必要）: ${entry.code}`);
      }
      if (!isNonEmptyString(entry.name)) throw new Error('材エントリのnameが不正です');
      if (typeof entry.spec !== 'string') throw new Error('材エントリのspecが不正です');
      if (!isFiniteNumber(entry.x)) throw new Error('材エントリのxが不正です');
      if (!isFiniteNumber(entry.y)) throw new Error('材エントリのyが不正です');
      if (!isNullableFiniteNumber(entry.thickness)) {
        throw new Error('材エントリのthicknessが不正です（数値またはnull）');
      }
      // QA指摘Minor2（2026-09-22）: 負の厚さは物理的に無意味。本体マスタ130件は全件0以上かnull。
      if (typeof entry.thickness === 'number' && entry.thickness < 0) {
        throw new Error('材エントリのthicknessが不正です（0以上の数値またはnullが必要）');
      }
      if (entry.note !== undefined && typeof entry.note !== 'string') throw new Error('材エントリのnoteが不正です');
      if (entry.category !== undefined && typeof entry.category !== 'string') {
        throw new Error('材エントリのcategoryが不正です');
      }
      if (entry.backingClass !== undefined && typeof entry.backingClass !== 'string') {
        throw new Error('材エントリのbackingClassが不正です');
      }
    },
    loadBuiltin: () => import('../finish/materials/materialData.js').then(m => m.MATERIALS),
  },

  [CatalogKind.SECTION]: {
    kind: CatalogKind.SECTION,
    // keyが非空文字列でなければ例外（2026-09-22 QA指摘A）。
    keyOf: entry => {
      if (!isNonEmptyString(entry?.key)) {
        throw new Error(`断面エントリのkeyが不正です（キーを組み立てられません）: ${JSON.stringify(entry)}`);
      }
      return entry.key;
    },
    // keyOf の逆変換（積み残し2026-09-22）。
    parseKey(key) {
      if (!isNonEmptyString(key)) throw new Error(`断面のキーが不正です: ${key}`);
      return { key };
    },
    encoding: 'json',
    knownFields: ['key', 'materialType', 'shape', 'width', 'height', 'webThickness', 'flangeThickness', 'wallThickness', 'label'],
    requiredFields: ['key', 'materialType', 'shape', 'width', 'height', 'label'],
    // ステップ12a（Q-B確定）: keyの他、寸法系すべてを固定——断面のkeyは寸法から組み立てられる
    // （woodBeamSectionForDepth/woodColumnSectionId）ため、寸法を変えるとkeyの実体と乖離する。
    // 編集できるのはlabel（呼称）のみ。overrideLockedFieldsは無し（builtinの上書きでも固定項目は
    // keyBoundFieldsと同じ＝寸法系のみ）。
    keyBoundFields: ['key', 'materialType', 'shape', 'width', 'height', 'webThickness', 'flangeThickness', 'wallThickness'],
    overrideLockedFields: [],
    compareFields: ['materialType', 'shape', 'width', 'height', 'webThickness', 'flangeThickness', 'wallThickness', 'label'],
    silentDiffFields: [],
    matchFields: ['materialType', 'shape', 'width', 'height', 'webThickness', 'flangeThickness', 'wallThickness'],
    minMatchFields: 2,
    dedupeFields: null,
    validate(entry) {
      requireFields(entry, ['key', 'materialType', 'shape', 'width', 'height', 'label'], '断面エントリ');
      // 2026-09-23 QA指摘Minor-2: 空文字のkeyはvalidateを通ったのにkeyOfが例外を投げる
      // 「遅延爆弾」になる（setOverlayは成功するがcomposeCatalogで初めて落ちる）ため、
      // materialのcodeと同型に非空文字列を要求する（typeof==='string'だけでは空文字を通す）。
      if (!isNonEmptyString(entry.key)) throw new Error('断面エントリのkeyが不正です（非空文字列が必要）');
      if (typeof entry.materialType !== 'string') throw new Error('断面エントリのmaterialTypeが不正です');
      if (typeof entry.shape !== 'string') throw new Error('断面エントリのshapeが不正です');
      if (!isFiniteNumber(entry.width) || !isFiniteNumber(entry.height)) {
        throw new Error('断面エントリのwidth/heightが不正です');
      }
      if (typeof entry.label !== 'string') throw new Error('断面エントリのlabelが不正です');
      for (const f of ['webThickness', 'flangeThickness', 'wallThickness']) {
        if (entry[f] !== undefined && !isFiniteNumber(entry[f])) {
          throw new Error(`断面エントリの${f}が不正です`);
        }
      }
    },
    loadBuiltin: () => import('../structural/sectionCatalog.js').then(m => m.SECTION_CATALOG),
  },

  [CatalogKind.OPENING_SUB_TYPE]: {
    kind: CatalogKind.OPENING_SUB_TYPE,
    // 複合キー（QA指摘 B1・2026-09-22）: FITTING_CATALOG/WINDOW_CATALOGはcategoryが違えば
    // 同じkeyを持ちうる（例: 'doubleSliding'が引き違い戸/引き違い窓の両方に存在）。
    // findCatalogEntry(category, subType)・LEGACY_SUBTYPE_ALIASESのcategory層分けと同型にする。
    // category/keyが非空文字列でなければ例外（積み残し2026-09-22: "undefined:…"のような
    // 壊れたキーを作らない）。
    keyOf: entry => {
      if (!isNonEmptyString(entry?.category) || !isNonEmptyString(entry?.key)) {
        throw new Error(`建具種別エントリのcategory/keyが不正です（キーを組み立てられません）: ${JSON.stringify(entry)}`);
      }
      return `${entry.category}:${entry.key}`;
    },
    // keyOf の逆変換（積み残し2026-09-22）。ステップ6で Opening.subType（category, key）へ
    // 戻すときに使う想定（doc/user由来のaliasesをOpening側へ適用する経路）。
    parseKey(key) {
      const m = /^(fitting|window):(.+)$/.exec(key ?? '');
      if (!m) {
        throw new Error(`建具種別のキーが不正です（fitting:...またはwindow:...の形式が必要）: ${key}`);
      }
      return { category: m[1], key: m[2] };
    },
    encoding: 'json',
    knownFields: ['category', 'key', 'label', 'mechanism', 'wallKinds', 'defaultWidth', 'defaultHeight', 'childRatio', 'fireLeaves', 'fireAngle', 'slideLayout'],
    requiredFields: ['category', 'key', 'label', 'mechanism', 'defaultWidth', 'defaultHeight'],
    // ステップ12a（Q-B確定）: category/keyはkeyOfの複合キーそのもの、mechanismは開閉の仕組み
    // （断面と同型の理由——OpeningEditor.jsx等の機構別UI分岐がmechanismを前提にしている）ため固定。
    keyBoundFields: ['category', 'key', 'mechanism'],
    overrideLockedFields: [],
    compareFields: ['label', 'mechanism', 'wallKinds', 'defaultWidth', 'defaultHeight', 'childRatio', 'fireLeaves', 'fireAngle', 'slideLayout'],
    // Q-B（2026-09-23裁定）: 呼称（label）差は通知しない。全文書が建具を同梱するため、本体の
    // 呼称を1件直すと全旧文書で通知が出てしまう（R12＝材のspec/thicknessと同型の割り切り）。
    // defaultWidth/defaultHeight・mechanism等は引き続き通知する（heightが未設定の旧建具が
    // 既定値へ落ちる実害があるため）。
    // Minor-1（QA指摘・2026-09-23）: shouldNotifyDiff（catalogMatch.js）は silentDiffFields の
    // いずれか1つでも diffFields に含まれていれば、他の非silent項目が同時に違っていても通知
    // しない（R12の既存規約。材のspec/thicknessと同じ仕様——silent側を「無視できる差分」ではなく
    // 「これが混ざったら黙る」判定として使う）。そのためlabelとdefaultHeightが同時に違う同梱も
    // 無音になる（defaultHeight単独の差は通知される）。この規約自体を変える（項目ごとに独立で
    // 判定する等）場合は別途裁定が必要——本ステップでは既存のR12規約をそのまま踏襲する。
    silentDiffFields: ['label'],
    // R14・QA指摘 M1（2026-09-22）: 末尾から外す順。自動採用（exact＝matchByContentのlevel===0）は
    // 全項目一致のときだけ（他種別と同じ規約。ここで新たにminMatchFieldsを上げているわけではない）。
    matchFields: ['category', 'mechanism', 'childRatio', 'fireLeaves', 'fireAngle', 'slideLayout', 'wallKinds', 'defaultWidth', 'defaultHeight', 'label'],
    minMatchFields: 2,
    dedupeFields: null,
    validate(entry) {
      requireFields(entry, ['category', 'key', 'label', 'mechanism', 'defaultWidth', 'defaultHeight'], '建具種別エントリ');
      if (entry.category !== 'fitting' && entry.category !== 'window') {
        throw new Error(`建具種別エントリのcategoryが不正です: ${entry.category}`);
      }
      if (typeof entry.key !== 'string') throw new Error('建具種別エントリのkeyが不正です');
      if (typeof entry.label !== 'string') throw new Error('建具種別エントリのlabelが不正です');
      if (typeof entry.mechanism !== 'string') throw new Error('建具種別エントリのmechanismが不正です');
      if (!isFiniteNumber(entry.defaultWidth) || !isFiniteNumber(entry.defaultHeight)) {
        throw new Error('建具種別エントリのdefaultWidth/defaultHeightが不正です');
      }
      if (entry.wallKinds !== undefined && !Array.isArray(entry.wallKinds)) {
        throw new Error('建具種別エントリのwallKindsが不正です（配列が必要）');
      }
      if (entry.childRatio !== undefined && !isFiniteNumber(entry.childRatio)) {
        throw new Error('建具種別エントリのchildRatioが不正です');
      }
      if (entry.fireLeaves !== undefined && !isFiniteNumber(entry.fireLeaves)) {
        throw new Error('建具種別エントリのfireLeavesが不正です');
      }
      if (entry.fireAngle !== undefined && !isFiniteNumber(entry.fireAngle)) {
        throw new Error('建具種別エントリのfireAngleが不正です');
      }
      if (entry.slideLayout !== undefined && !isPlainObject(entry.slideLayout)) {
        throw new Error('建具種別エントリのslideLayoutが不正です（オブジェクトが必要）');
      }
    },
    // 場面(c)unsupported（2026-09-23 ステップ10d）: validateはmechanismの型（string）しか
    // 検査しないため、未知のmechanism文字列（旧アプリのプレビルド版など）を持つ同梱エントリを
    // ここで弾き、incomingReconcile.js planIncomingReconcile が unsupported 行へ振り分ける
    // （既存の分類（同一/alias/propose/add）の対象から外す）。
    isSupported: entry => KNOWN_OPENING_MECHANISMS_SET.has(entry?.mechanism),
    // FITTING_CATALOG（fitting）とWINDOW_CATALOG（window）を category 付きで合成する（唯一の
    // 合成式は openingCatalog.js の openingSubTypeBuiltinList。ここでの二重実装はしない）。
    loadBuiltin: () => import('../openings/openingCatalog.js').then(m => m.openingSubTypeBuiltinList()),
  },

  [CatalogKind.INTERIOR_MASTER]: {
    kind: CatalogKind.INTERIOR_MASTER,
    // keyが非空文字列でなければ例外（2026-09-22 QA指摘A）。
    keyOf: entry => {
      if (!isNonEmptyString(entry?.key)) {
        throw new Error(`内装マスターエントリのkeyが不正です（キーを組み立てられません）: ${JSON.stringify(entry)}`);
      }
      return entry.key;
    },
    // keyOf の逆変換（積み残し2026-09-22）。
    parseKey(key) {
      if (!isNonEmptyString(key)) throw new Error(`内装マスターのキーが不正です: ${key}`);
      return { key };
    },
    encoding: 'json',
    knownFields: ['key', 'label', 'wallMaterial', 'wallFinish', 'ceilingHeight'],
    requiredFields: ['key', 'label', 'wallMaterial', 'wallFinish', 'ceilingHeight'],
    // ステップ12a（Q-B確定）: keyのみ固定。他は編集可（12gで対応）。
    keyBoundFields: ['key'],
    overrideLockedFields: [],
    // E: 内容照合は完全一致のみ（段を外さない）。ラベル以外の全内容。
    compareFields: ['wallMaterial', 'wallFinish', 'ceilingHeight'],
    silentDiffFields: [],
    matchFields: ['wallMaterial', 'wallFinish', 'ceilingHeight'],
    minMatchFields: 3,
    dedupeFields: null,
    validate(entry) {
      requireFields(entry, ['key', 'label', 'wallMaterial', 'wallFinish', 'ceilingHeight'], '内装マスターエントリ');
      // 2026-09-23 QA指摘Minor-2: 空文字のkeyを通さない（section/boundaryMasterと同型。理由は同じ）。
      if (!isNonEmptyString(entry.key)) throw new Error('内装マスターエントリのkeyが不正です（非空文字列が必要）');
      if (typeof entry.label !== 'string') throw new Error('内装マスターエントリのlabelが不正です');
      if (typeof entry.wallMaterial !== 'string') throw new Error('内装マスターエントリのwallMaterialが不正です');
      if (typeof entry.wallFinish !== 'string') throw new Error('内装マスターエントリのwallFinishが不正です');
      if (!isFiniteNumber(entry.ceilingHeight)) throw new Error('内装マスターエントリのceilingHeightが不正です');
    },
    loadBuiltin: () => import('../finish/materials/interiorMasters.js').then(interiorMasterBuiltinList),
  },

  [CatalogKind.BOUNDARY_MASTER]: {
    kind: CatalogKind.BOUNDARY_MASTER,
    // keyが非空文字列でなければ例外（2026-09-22 QA指摘A）。
    keyOf: entry => {
      if (!isNonEmptyString(entry?.key)) {
        throw new Error(`境界マスターエントリのkeyが不正です（キーを組み立てられません）: ${JSON.stringify(entry)}`);
      }
      return entry.key;
    },
    // keyOf の逆変換（積み残し2026-09-22）。
    parseKey(key) {
      if (!isNonEmptyString(key)) throw new Error(`境界マスターのキーが不正です: ${key}`);
      return { key };
    },
    encoding: 'json',
    knownFields: ['key', 'label', 'kind', 'layers', 'derivedFrom', 'fields'],
    requiredFields: ['key', 'label', 'kind'],
    // ステップ12a（Q-B確定）: keyのみ固定。境界マスターは範囲外（閲覧のみ）だが登録表は他種別と
    // 揃えて持たせる（lockedFieldsForがkindDef(kind).keyBoundFieldsを前提なく参照できるように）。
    keyBoundFields: ['key'],
    overrideLockedFields: [],
    // E: 内容照合は完全一致のみ。ラベル以外の全内容（QA指摘 B2・2026-09-22: kind/layers/derivedFrom/fieldsの4項目）。
    compareFields: ['kind', 'layers', 'derivedFrom', 'fields'],
    silentDiffFields: [],
    matchFields: ['kind', 'layers', 'derivedFrom', 'fields'],
    minMatchFields: 4,
    dedupeFields: null,
    validate(entry) {
      requireFields(entry, ['key', 'label', 'kind'], '境界マスターエントリ');
      // 2026-09-23 QA指摘Minor-2: 空文字のkeyを通さない（section/interiorMasterと同型。理由は同じ）。
      if (!isNonEmptyString(entry.key)) throw new Error('境界マスターエントリのkeyが不正です（非空文字列が必要）');
      if (typeof entry.label !== 'string') throw new Error('境界マスターエントリのlabelが不正です');
      if (entry.kind !== 'layered' && entry.kind !== 'meta') {
        throw new Error(`境界マスターエントリのkindが不正です: ${entry.kind}`);
      }
      if (entry.kind === 'layered' && !Array.isArray(entry.layers)) {
        throw new Error('layered境界マスターエントリにはlayers（配列）が必要です');
      }
      if (entry.layers !== undefined && !Array.isArray(entry.layers)) {
        throw new Error('境界マスターエントリのlayersが不正です（配列が必要）');
      }
      if (entry.fields !== undefined && !isPlainObject(entry.fields)) {
        throw new Error('境界マスターエントリのfieldsが不正です（オブジェクトが必要）');
      }
      if (entry.derivedFrom !== undefined && typeof entry.derivedFrom !== 'string') {
        throw new Error('境界マスターエントリのderivedFromが不正です');
      }
    },
    loadBuiltin: () => import('../finish/materials/boundaryMasters.js').then(m => Object.values(m.BOUNDARY_MASTERS)),
  },
});

/**
 * 登録表を行・配列まで再帰的に凍結する（積み残し2026-09-22）。matchFields等の配列は
 * Object.freeze(REGISTRY) だけでは凍結されない（浅い凍結のため）——呼び出し側が誤って
 * 登録表の配列をpush等で書き換えることを防ぐ。
 */
function deepFreezeRegistry(registry) {
  for (const row of Object.values(registry)) {
    for (const value of Object.values(row)) {
      if (Array.isArray(value)) Object.freeze(value);
    }
    Object.freeze(row);
  }
  return Object.freeze(registry);
}

/** 登録済みカタログ種別の定義表そのもの（kind→定義。プロトタイプ無し・行・配列まで凍結。QA指摘・Minor）。 */
export const CATALOG_KINDS = deepFreezeRegistry(REGISTRY);

/** kind → 登録表の行。未知の種別（Object.prototypeの継承メンバー名を含む）は例外。 */
export function kindDef(kind) {
  const def = CATALOG_KINDS[kind];
  if (!def) throw new Error(`未知のカタログ種別です: ${kind}`);
  return def;
}

/** 登録済みの全種別キー（CATALOG_KINDSから導出。列挙手段を1本にする）。 */
export function listKinds() {
  return Object.keys(CATALOG_KINDS);
}
