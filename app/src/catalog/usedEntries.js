// ================================================================
// 保存時の使用エントリ収集（同梱は使用中エントリのみとする規約・値の等価判定・ステップ4）。
//
// codeNormalization.js の走査器（enumerateMaterialCodeRefs）を共有する——材コードの
// 「どのフィールドが対象か」を二重実装しない（走査器を壊すと codeNormalization.test.js と
// usedEntries.test.js の両方が赤くなる）。
//
// 葉モジュール。codeNormalization.js・materialCode.js・catalogKinds.js・catalogBundle.js
// （いずれも葉）にのみ依存する。store.js / snap.js / .jsx を静的 import しない。
// ================================================================

import { enumerateMaterialCodeRefs, SNAPSHOT_REF_WALKERS } from './codeNormalization.js';
import { isMaterialCode } from './materialCode.js';
import { CatalogKind, kindDef } from './catalogKinds.js';
import { emptyBundle, withEntries, bundleEntries } from './catalogBundle.js';
import { DetailLenMode, DetailProvenanceSource, FIXTURE_SYMBOL_DETAIL_FIGURES_FIELD } from '../core/constants.js';
import { moveParts } from '../detail/detailModel.js';

// 読み込んだ外部ファイル（DXF・PDF）由来の出所。文書に同梱しない対象（R10）。
export const IMPORTED_SOURCES = Object.freeze([DetailProvenanceSource.DXF, DetailProvenanceSource.PDF]);

/**
 * 外部ファイル（DXF・PDF）由来の詳細図か（provenance.source が 'dxf' か 'pdf'）。文書に同梱しない対象（R10）。
 * @param {object|null|undefined} figure
 * @returns {boolean}
 */
export function isImportedFigure(figure) {
  return IMPORTED_SOURCES.includes(figure?.provenance?.source);
}

/**
 * snapshot（1階分）が参照する材コードを Set で返す（12桁数字として不正な値は含めない）。
 * @param {object} snapshot
 * @returns {Set<string>}
 */
export function collectUsedMaterialCodes(snapshot) {
  const codes = new Set();
  for (const ref of enumerateMaterialCodeRefs(snapshot)) {
    if (isMaterialCode(ref.code)) codes.add(ref.code);
  }
  return codes;
}

/**
 * snapshot（1階分）が参照するカタログキーを種別ごとに収集する。走査は
 * codeNormalization.js の SNAPSHOT_REF_WALKERS（kind → enumerate）を共有する——
 * 「どのフィールドが対象か」を二重実装しない（collectUsedMaterialCodesが
 * enumerateMaterialCodeRefsを共有しているのと同型）。
 * - interiorMaster: rooms[].templateKey
 * - boundaryMaster: edges[].masterType
 * - section: columns/beams/structuralWalls/slabs/footings の sectionDefId
 * - openingSubType: openings[] の `${category}:${subType}`（catalogKinds.js の keyOf と同型）
 * - fixtureSymbol: openings[].fixtureType（空でない文字列のみ）
 * - detailFigure: openings[].detailRefs の値（建具個別の上書き。S6a）。
 *   建具記号経由の使用は expandUsedDetailFiguresTransitively が推移展開する
 * @returns {{ interiorMaster: Set<string>, boundaryMaster: Set<string>, section: Set<string>,
 *             openingSubType: Set<string>, fixtureSymbol: Set<string>, detailFigure: Set<string> }}
 */
export function collectUsedKeys(snapshot) {
  const interiorMaster = new Set();
  const boundaryMaster = new Set();
  const section = new Set();
  const openingSubType = new Set();
  const fixtureSymbol = new Set();
  const detailFigure = new Set();
  if (!snapshot) return { interiorMaster, boundaryMaster, section, openingSubType, fixtureSymbol, detailFigure };

  for (const ref of SNAPSHOT_REF_WALKERS.interiorMaster.enumerate(snapshot)) interiorMaster.add(ref.code);
  for (const ref of SNAPSHOT_REF_WALKERS.boundaryMaster.enumerate(snapshot)) boundaryMaster.add(ref.code);
  for (const ref of SNAPSHOT_REF_WALKERS.section.enumerate(snapshot)) section.add(ref.code);
  for (const ref of SNAPSHOT_REF_WALKERS.openingSubType.enumerate(snapshot)) openingSubType.add(ref.code);
  for (const ref of SNAPSHOT_REF_WALKERS.fixtureSymbol.enumerate(snapshot)) fixtureSymbol.add(ref.code);
  for (const ref of SNAPSHOT_REF_WALKERS.detailFigure.enumerate(snapshot)) detailFigure.add(ref.code);

  return { interiorMaster, boundaryMaster, section, openingSubType, fixtureSymbol, detailFigure };
}

/**
 * snapshot群（複数階分。decode済み）から、指定した種別（kinds）ぶんの使用キーを集めて返す
 * （ステップ7c QA指摘Major-1）。kinds に渡した種別は、使用0件でも戻り値の Map に必ず
 * 空Setとして持つ——呼び出し側（store.js collectCatalogUsageAcrossFloors）が「全種別を空Setで
 * 立ててから全階を回して埋める」という手順を個別に実装していたところを純関数として抽出した
 * もの（store.js は decode してこれに渡すだけにする）。material の直接参照（4フィールド）は
 * collectUsedMaterialCodes を、他種別は collectUsedKeys を使う——collectUsedKeys が返す
 * フィールド名（interiorMaster/boundaryMaster/section/openingSubType）は catalogKinds.js の
 * CatalogKind の値と文字列として一致するため、種別名からそのまま引ける。
 * @param {Iterable<object>} snapshots decode済みスナップショット（複数階分）
 * @param {Iterable<string>} kinds 収集対象の種別（catalogKinds.js CatalogKind の値）
 * @returns {Map<string, Set<string>>} kind → 使用キーのSet（kinds に渡した全種別ぶん、
 *          使用0件でも空Setとして存在する）
 */
export function collectUsedKeysByKind(snapshots, kinds) {
  const usedKeysByKind = new Map([...kinds].map(kind => [kind, new Set()]));
  for (const snapshot of snapshots) {
    if (usedKeysByKind.has(CatalogKind.MATERIAL)) {
      for (const code of collectUsedMaterialCodes(snapshot)) usedKeysByKind.get(CatalogKind.MATERIAL).add(code);
    }
    const used = collectUsedKeys(snapshot);
    for (const [kind, set] of usedKeysByKind) {
      if (kind === CatalogKind.MATERIAL) continue;
      const keys = used[kind]; // フィールド名はCatalogKindの値と一致する
      // 一致が崩れた種別を黙って「使用0件」扱いにすると、空配列で同梱され前回のレコードを
      // 消してしまう。登録表にはあるが収集に未対応の種別は例外で止める。
      if (!keys) throw new Error(`使用キーの収集に未対応の種別です: ${kind}`);
      for (const key of keys) set.add(key);
    }
  }
  return usedKeysByKind;
}

/**
 * 建具記号・建具種別エントリが割り当てている詳細図キー（detailFigures の値のうち空でない文字列）。
 * detailFigures が無い・オブジェクトでない旧形のエントリは空。
 * @param {object|null|undefined} entry
 * @returns {string[]}
 */
function detailFigureKeysOfEntry(entry) {
  const slots = entry?.[FIXTURE_SYMBOL_DETAIL_FIGURES_FIELD];
  if (slots === null || typeof slots !== 'object' || Array.isArray(slots)) return [];
  return Object.values(slots).filter(v => typeof v === 'string' && v.length > 0);
}

/**
 * 詳細図の全 LenSpec（Move の len／V の dx・dy）のうち mode が material のものが指す材コード
 * （12桁数字として正しいものだけ）。壊れた図（strokes が配列でない・未知の dir）でも例外にしない。
 * @param {object|null|undefined} figure
 * @returns {Set<string>}
 */
function detailFigureMaterialCodes(figure) {
  const codes = new Set();
  const strokes = Array.isArray(figure?.strokes) ? figure.strokes : [];
  for (const stroke of strokes) {
    const moves = Array.isArray(stroke?.moves) ? stroke.moves : [];
    for (const move of moves) {
      for (const part of moveParts(move) ?? []) {
        if (part.len?.mode === DetailLenMode.MATERIAL && isMaterialCode(part.len.code)) codes.add(part.len.code);
      }
    }
  }
  return codes;
}

/**
 * 使用材コードの集合に、内装マスター・境界マスターが内部で参照する材コードを推移的に追加する
 * （同梱は使用中エントリのみとする規約）。LAYER_SOURCE の層（実行時解決）は辿らない——固定コード（layer.code）だけを見る
 * （ステップ7b）。理由: LAYER_SOURCE.FLOOR_EXTERIOR_BACKING/FLOOR_INTERIOR_BACKING の実体は
 * graph.exteriorWallBacking/interiorWallBacking（codeNormalization.js BACKING_FIELDS 経由で
 * collectUsedMaterialCodes が既に収集済み）、ROOM_WALL_MATERIAL/ROOM_FINISH の実体は
 * room.customOverrides の wallMaterial/wallFinish（同じく isRoomMaterialOverride 経由で
 * 別経路収集済み）——ここで LAYER_SOURCE を辿ると同じ材コードを二重収集するだけになる。
 * @param {Set<string>|Iterable<string>} codes 直接参照された材コード
 * @param {{ interiorMasters?: Iterable<{wallMaterial?: string, wallFinish?: string}>,
 *           boundaryMasters?: Iterable<{layers?: Array<{code?: string|null}>}>,
 *           detailFigures?: Iterable<object> }} used
 *        使用されている（解決済みの）内装・境界マスター・部分詳細図のエントリ本体
 *        （詳細図は material 束縛の LenSpec が指す材コード）
 * @returns {Set<string>}
 */
export function expandTransitiveMaterials(codes, { interiorMasters = [], boundaryMasters = [], detailFigures = [] } = {}) {
  const expanded = new Set(codes);
  for (const figure of detailFigures) {
    for (const code of detailFigureMaterialCodes(figure)) expanded.add(code);
  }
  for (const master of interiorMasters) {
    if (isMaterialCode(master?.wallMaterial)) expanded.add(master.wallMaterial);
    if (isMaterialCode(master?.wallFinish)) expanded.add(master.wallFinish);
  }
  for (const master of boundaryMasters) {
    for (const layer of master?.layers ?? []) {
      if (isMaterialCode(layer?.code)) expanded.add(layer.code);
    }
  }
  return expanded;
}

/**
 * ステップ12b QA指摘M1/m3（2026-09-24再報告）: collectUsedKeysByKind の戻り値（kind→使用キーの
 * Set）のうち CatalogKind.MATERIAL を、使用中の interiorMaster/boundaryMaster が参照する材コード
 * まで expandTransitiveMaterials で推移展開したものに差し替える（非破壊。新しい Map を返す）。
 * store.js の saveCatalogDocument・collectCurrentCatalogUsage の両方が同じ式を呼ぶことで、
 * 「使用キー収集→材の推移展開」という手順そのものを二重実装しない（M1の症状——削除確認が
 * 未保存の作業中の使用を見落とす——を新設する collectCurrentCatalogUsage で修正するにあたり、
 * 保存時（saveCatalogDocument）と同じ判定式を使うことを保証する）。
 * resolvedByKind は kind→Map<key,entry>（catalogRegistry.js composeCatalog の戻り値。呼び出し側が
 * 解決済みのものを渡すDI型——composeCatalogは本体標準マスタの動的importを伴うI/Oのため、
 * この関数自身は呼ばない・catalogRegistry.jsも静的importしない。純関数として保つ）。
 * usedKeysByKind が CatalogKind.MATERIAL を含まない（収集対象に material を含めなかった）場合は
 * 何もせずそのまま返す。
 * @param {Map<string, Set<string>>} usedKeysByKind
 * @param {Map<string, Map<string, object>>} resolvedByKind
 * @returns {Map<string, Set<string>>}
 */
export function expandUsedMaterialsTransitively(usedKeysByKind, resolvedByKind) {
  if (!usedKeysByKind.has(CatalogKind.MATERIAL)) return usedKeysByKind;
  const usedInteriorMasters = [...(usedKeysByKind.get(CatalogKind.INTERIOR_MASTER) ?? [])]
    .map(k => resolvedByKind.get(CatalogKind.INTERIOR_MASTER)?.get(k))
    .filter(Boolean);
  const usedBoundaryMasters = [...(usedKeysByKind.get(CatalogKind.BOUNDARY_MASTER) ?? [])]
    .map(k => resolvedByKind.get(CatalogKind.BOUNDARY_MASTER)?.get(k))
    .filter(Boolean);
  const expandedMaterial = expandTransitiveMaterials(usedKeysByKind.get(CatalogKind.MATERIAL), {
    interiorMasters: usedInteriorMasters,
    boundaryMasters: usedBoundaryMasters,
  });
  const next = new Map(usedKeysByKind);
  next.set(CatalogKind.MATERIAL, expandedMaterial);
  return next;
}

/**
 * カタログ→カタログの推移展開（2 例目）。expandUsedMaterialsTransitively の**前段**で呼ぶ
 * （詳細図の material 束縛が増やす材を、後段の材の推移展開が取りこぼさないため）。
 * (a) 使用中の建具記号・建具種別（三層合成後）の detailFigures の値 → 詳細図キー
 * (b) 使用中の詳細図の material 束縛 LenSpec の code → 材コード（material が収集対象のときだけ）
 * 詳細図から別の詳細図へは辿らない。usedKeysByKind が DETAIL_FIGURE を含まなければそのまま返す
 * （expandUsedMaterialsTransitively と同じ）。非破壊（新しい Map を返す）。
 * @param {Map<string, Set<string>>} usedKeysByKind
 * @param {Map<string, Map<string, object>>} resolvedByKind
 * @returns {Map<string, Set<string>>}
 */
export function expandUsedDetailFiguresTransitively(usedKeysByKind, resolvedByKind, { excludeImported = false } = {}) {
  if (!usedKeysByKind.has(CatalogKind.DETAIL_FIGURE)) return usedKeysByKind;
  const figureKeys = new Set(usedKeysByKind.get(CatalogKind.DETAIL_FIGURE));
  for (const symbolKey of usedKeysByKind.get(CatalogKind.FIXTURE_SYMBOL) ?? []) {
    const symbol = resolvedByKind.get(CatalogKind.FIXTURE_SYMBOL)?.get(symbolKey);
    for (const figureKey of detailFigureKeysOfEntry(symbol)) figureKeys.add(figureKey);
  }
  // 使用中の建具種別（三層合成後）の detailFigures（姿図。S6b）も同じ
  for (const subTypeKey of usedKeysByKind.get(CatalogKind.OPENING_SUB_TYPE) ?? []) {
    const subType = resolvedByKind.get(CatalogKind.OPENING_SUB_TYPE)?.get(subTypeKey);
    for (const figureKey of detailFigureKeysOfEntry(subType)) figureKeys.add(figureKey);
  }
  // 同梱（excludeImported）のときだけ、外部ファイル（DXF・PDF）由来の図を対象から外す（R10。割当てのキーは文書に残り、
  // 図を持たない環境では既定の描きに戻る。材の推移展開にも載せない）。使用中の判定（削除確認・使用中バッジ）では外さない。
  if (excludeImported) {
    for (const figureKey of [...figureKeys]) {
      if (isImportedFigure(resolvedByKind.get(CatalogKind.DETAIL_FIGURE)?.get(figureKey))) figureKeys.delete(figureKey);
    }
  }
  const next = new Map(usedKeysByKind);
  next.set(CatalogKind.DETAIL_FIGURE, figureKeys);
  if (next.has(CatalogKind.MATERIAL)) {
    const codes = new Set(next.get(CatalogKind.MATERIAL));
    for (const figureKey of figureKeys) {
      const figure = resolvedByKind.get(CatalogKind.DETAIL_FIGURE)?.get(figureKey);
      for (const code of detailFigureMaterialCodes(figure)) codes.add(code);
    }
    next.set(CatalogKind.MATERIAL, codes);
  }
  return next;
}

/**
 * ステップ12a: `overridesBuiltin`（resolveQueue.js markOverrideが付ける「本体の上書き」印）を
 * 同梱から除去する。この属性はユーザーライブラリ側の状態（このプロジェクトのuserエントリが
 * builtinを上書きしているかどうか）であって、doc（文書同梱）はそれを持ち運ぶべきではない——
 * 別環境（overridesBuiltin無しのuserを持つ、または全く持たない環境）でこの.stqを開いたとき、
 * doc側にoverridesBuiltin:trueが残っていると、そのuserエントリを衝突検出（catalogBundle.js
 * detectLibraryConflicts）から誤って除外してしまう（「衝突なし」に見えるが実際はuser側にその
 * 上書きが存在しない）。
 * QA指摘Minor-1（2026-09-24・12a再報告）: export して catalog/catalogMaintenance.js
 * （同ディレクトリの兄弟モジュール。catalogImports.test.jsの許可リスト内）からも使う——
 * planRemoveUserEntryのdocAppend（使用中userを削除するときにdocへ書き写す1件）も同じ理由で
 * この印を持ち込んではいけない。
 * @param {object} entry
 * @returns {object}
 */
export function stripOverridesBuiltin(entry) {
  if (!entry || !Object.prototype.hasOwnProperty.call(entry, 'overridesBuiltin')) return entry;
  const rest = { ...entry };
  delete rest.overridesBuiltin;
  return rest;
}

/**
 * 使用キー（種別ごと）と解決済みMap（種別ごと。composeCatalogの結果）から、文書同梱束を
 * 組み立てる。解決できないキー（resolvedByKindにエントリが無い）は同梱**せず**、
 * unresolvedKeys（種別ごとのSet）として返す——呼び出し側（store.js）が黙って落とさず、
 * 既存の同梱レコードから回収する（recoverUnresolvedEntries）か、回収できなければ
 * 利用者へ通知する材料にする（2026-09-22 QA指摘A: 解決できないユーザー材を無言で
 * 落として上書き保存すると .stq から材が消えるため）。
 * @param {{ usedKeysByKind: Map<string, Set<string>|Iterable<string>>,
 *           resolvedByKind: Map<string, Map<string, object>>,
 *           aliases?: object }} args
 * @returns {{ bundle: object, unresolvedKeys: Map<string, Set<string>> }}
 *          bundle はカタログ束（{version, catalogs, encodings, aliases}）。
 *          unresolvedKeys は解決できなかったキーの種別ごとのSet（空なら全解決）。
 */
export function buildDocumentBundle({ usedKeysByKind, resolvedByKind, aliases = {} }) {
  let bundle = emptyBundle();
  const unresolvedKeys = new Map();
  for (const [kind, keys] of usedKeysByKind) {
    const resolved = resolvedByKind.get(kind);
    const entries = [];
    const unresolved = new Set();
    for (const key of keys) {
      const entry = resolved?.get(key);
      if (entry) entries.push(stripOverridesBuiltin(entry));
      else unresolved.add(key);
    }
    bundle = withEntries(bundle, kind, entries);
    bundle = { ...bundle, encodings: { ...bundle.encodings, [kind]: kindDef(kind).encoding } };
    if (unresolved.size > 0) unresolvedKeys.set(kind, unresolved);
  }
  return { bundle: { ...bundle, aliases }, unresolvedKeys };
}

/**
 * buildDocumentBundle が解決できなかったキー（unresolvedKeys）を、既存の同梱束
 * （前回保存分。IDBから読んだ decode 済みの束）から回収して bundle へ追記する
 * （2026-09-22 QA指摘A）。既存にもエントリが無いキーは stillUnresolvedByKind として返す
 * ——呼び出し側（store.js）はこれを利用者への通知（件数・キー名）に使う。
 * 純関数（IDB非依存）: 既存束はデコード済みの状態で受け取る。
 * QA指摘Minor-1（2026-09-24・12a再報告）: 回収元（旧保存の同梱束）に`overridesBuiltin`印が
 * 残っている可能性がある（保存直後の旧バージョンや、12a以前の.stqを開いた場合等）ため、
 * buildDocumentBundleと同様にstripOverridesBuiltinを通してから追記する。
 * @param {object} bundle buildDocumentBundle の bundle
 * @param {Map<string, Set<string>>} unresolvedKeys buildDocumentBundle の unresolvedKeys
 * @param {Map<string, object|null|undefined>} existingBundlesByKind 種別ごとの既存の束（無ければ省略可）
 * @returns {{ bundle: object, stillUnresolvedByKind: Map<string, Set<string>> }}
 */
export function recoverUnresolvedEntries(bundle, unresolvedKeys, existingBundlesByKind = new Map()) {
  let result = bundle;
  const stillUnresolvedByKind = new Map();
  for (const [kind, keys] of unresolvedKeys) {
    if (!keys || keys.size === 0) continue;
    const def = kindDef(kind);
    const existingBundle = existingBundlesByKind.get(kind);
    const existingEntries = existingBundle ? bundleEntries(existingBundle, kind) : [];
    const existingByKey = new Map(existingEntries.map(e => [def.keyOf(e), e]));
    const recovered = [];
    const stillUnresolved = new Set();
    for (const key of keys) {
      const entry = existingByKey.get(key);
      if (entry) recovered.push(stripOverridesBuiltin(entry));
      else stillUnresolved.add(key);
    }
    if (recovered.length > 0) {
      result = withEntries(result, kind, [...bundleEntries(result, kind), ...recovered]);
    }
    if (stillUnresolved.size > 0) stillUnresolvedByKind.set(kind, stillUnresolved);
  }
  return { bundle: result, stillUnresolvedByKind };
}

/**
 * recoverUnresolvedEntries が既存の同梱束から回収した fixtureSymbol エントリが割り当てている
 * 詳細図（detailFigures）も含め、bundle 上の fixtureSymbol 全エントリから詳細図への推移的展開を
 * やり直す（reexpandTransitiveMaterials の詳細図版）。不足分を detailFigureMap
 * （composeCatalog(DETAIL_FIGURE, ...) の結果）で解決して detailFigure 束へ追記し、解決できない
 * キーは unresolvedDetailFigureKeys として返す（呼び出し側が既存束から回収し、残りを通知する）。
 * この関数の後に reexpandTransitiveMaterials を呼ぶこと（追記された詳細図の材を展開させるため）。
 * @param {object} bundle
 * @param {Map<string, object>|undefined} detailFigureMap 詳細図の解決済み Map（省略時は全て未解決扱い）
 * @returns {{ bundle: object, unresolvedDetailFigureKeys: Set<string> }}
 */
export function reexpandTransitiveDetailFigures(bundle, detailFigureMap) {
  const figureDef = kindDef(CatalogKind.DETAIL_FIGURE);
  const existingFigures = bundleEntries(bundle, CatalogKind.DETAIL_FIGURE);
  const existingKeys = new Set(existingFigures.map(e => figureDef.keyOf(e)));

  const wanted = new Set();
  for (const kind of [CatalogKind.FIXTURE_SYMBOL, CatalogKind.OPENING_SUB_TYPE]) {
    for (const entry of bundleEntries(bundle, kind)) {
      for (const figureKey of detailFigureKeysOfEntry(entry)) wanted.add(figureKey);
    }
  }

  const newEntries = [];
  const unresolvedDetailFigureKeys = new Set();
  for (const key of wanted) {
    if (existingKeys.has(key)) continue;
    const entry = detailFigureMap?.get(key);
    if (isImportedFigure(entry)) continue; // DXF・PDF 由来の図は同梱しない（未解決にも数えない）
    if (entry) newEntries.push(stripOverridesBuiltin(entry));
    else unresolvedDetailFigureKeys.add(key);
  }
  if (newEntries.length === 0) return { bundle, unresolvedDetailFigureKeys };
  return {
    bundle: withEntries(bundle, CatalogKind.DETAIL_FIGURE, [...existingFigures, ...newEntries]),
    unresolvedDetailFigureKeys,
  };
}

/**
 * recoverUnresolvedEntries が既存の同梱束から回収した interiorMaster/boundaryMaster エントリも
 * 含め、bundle 上の interiorMaster/boundaryMaster 全エントリから material への推移的展開を
 * やり直す（QA指摘Minor-2・回収分の推移展開）。saveCatalogDocument が最初に呼ぶ
 * expandTransitiveMaterials は「builtin/overlayで直接解決できた使用マスター」しか見ておらず、
 * 回収によって新たに束へ入った内装・境界マスターが参照する材コードはまだ material 束に無い
 * ——ここで改めて展開し、不足分を materialMap（composeCatalog(MATERIAL, ...)の結果）で解決して
 * material 束へ追記する。それでも解決できない材コードは unresolvedMaterialKeys として返す
 * （呼び出し側がさらに既存の材束から回収するか、それでも無ければ通知するかを決める）。
 * @param {object} bundle 束（withEntriesされたcatalogsを持つ。recoverUnresolvedEntries後の想定）
 * @param {Map<string, object>|undefined} materialMap 材の解決済みMap（省略時は全て未解決扱い）
 * @returns {{ bundle: object, unresolvedMaterialKeys: Set<string> }}
 */
export function reexpandTransitiveMaterials(bundle, materialMap) {
  const interiorMasters = bundleEntries(bundle, CatalogKind.INTERIOR_MASTER);
  const boundaryMasters = bundleEntries(bundle, CatalogKind.BOUNDARY_MASTER);
  const materialDef = kindDef(CatalogKind.MATERIAL);
  const existingMaterials = bundleEntries(bundle, CatalogKind.MATERIAL);
  const existingCodes = new Set(existingMaterials.map(e => materialDef.keyOf(e)));
  // 束の詳細図（直接解決分＋回収分）の material 束縛が指す材も同じ式で展開する。
  const detailFigures = bundleEntries(bundle, CatalogKind.DETAIL_FIGURE);

  const expanded = expandTransitiveMaterials(existingCodes, { interiorMasters, boundaryMasters, detailFigures });

  const newEntries = [];
  const unresolvedMaterialKeys = new Set();
  for (const code of expanded) {
    if (existingCodes.has(code)) continue;
    const entry = materialMap?.get(code);
    if (entry) newEntries.push(entry);
    else unresolvedMaterialKeys.add(code);
  }
  if (newEntries.length === 0) return { bundle, unresolvedMaterialKeys };
  return {
    bundle: withEntries(bundle, CatalogKind.MATERIAL, [...existingMaterials, ...newEntries]),
    unresolvedMaterialKeys,
  };
}
