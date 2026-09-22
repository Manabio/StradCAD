// ================================================================
// 指示UI（ステップ6-3・R10・4.6.1の場面(a)(b)(c)＋propose）— 行モデルの組み立て・候補選定・
// 決定の適用。
//
// 純モジュール（葉。I/O なし）。同ディレクトリの兄弟モジュール（catalogKinds.js・catalogMatch.js・
// materialCode.js）にのみ依存する（catalogImports.test.js の許可リストに従う）。
// 永続化（addDocumentAliases・commitUserEntries・restoreGraphの往復）は呼び出し側（store.js
// applyCatalogResolutions）が applyResolveDecisions の戻り値（aliasPairs/userOps）を使って行う。
//
// 裁定（U1・2026-09-22）: 「参照を外す」はやらない（承認／代替材を指示／ライブラリへ追加／保留の
// 4種のみ）。保留は記録しない——deferredRowIds は「今回反映されなかった行」を返すだけで、
// 呼び出し側はそれを消さずに project.catalogResolveRows へ残す（次回の再計算で再掲される）。
// ================================================================

import { CatalogKind, kindDef } from './catalogKinds.js';
import { matchByContent, rankCandidates, suggestByClass, displayNameOf } from './catalogMatch.js';
import { parseMaterialCode, formatMaterialCode, nextSerial } from './materialCode.js';

/** 場面ごとに許可される操作id（行モデル allowedActions の唯一の定義箇所）。 */
const ALLOWED_ACTIONS = Object.freeze({
  'library-conflict': Object.freeze(['approve', 'pick', 'markOverride', 'defer']),
  'unresolved-code':  Object.freeze(['approve', 'pick', 'defer']),
  unsupported:        Object.freeze(['approve', 'pick', 'defer']),
  propose:            Object.freeze(['approve', 'pick', 'addToLibrary']),
});

/**
 * 4.6.1場面(b): 実体が無くコードしか無いとき、旧内容（removedEntry。REMOVED_MATERIALS参照）が
 * あれば内容一致検索（matchByContent→rankCandidates）、無ければ大分類・中分類が同じ材
 * （suggestByClass）を候補にする。候補が無ければ空配列（「候補なし」）。
 * 旧1111コード（旧体系＝未分類）は major/minor が MATERIAL_CLASSES に存在しないため、
 * suggestByClass が自然に空配列を返す（特別扱いは不要）。
 * @param {string} code
 * @param {{ removedEntry?: object|null, appEntries?: object[], origins?: Map<string,string>, kind?: string }} args
 * @returns {object[]}
 */
export function candidatesForUnresolved(code, { removedEntry, appEntries = [], origins, kind = CatalogKind.MATERIAL } = {}) {
  if (removedEntry) {
    const { hits } = matchByContent(kind, removedEntry, appEntries);
    return rankCandidates(kind, removedEntry, hits, origins);
  }
  return suggestByClass(code, appEntries);
}

function knownCodesOf(appEntries) {
  const codes = new Set();
  for (const e of appEntries ?? []) {
    if (typeof e?.code === 'string') codes.add(e.code);
  }
  return codes;
}

/** 同じ大分類・中分類の空き番（renumber用。material専用）。材コード以外のkeyはnull。 */
function nextFreeCodeInSameClass(code, appEntries) {
  const parsed = parseMaterialCode(code);
  if (!parsed) return null;
  return formatMaterialCode(parsed.major, parsed.minor, Number(nextSerial(parsed.major, parsed.minor, knownCodesOf(appEntries))));
}

/**
 * 場面(a): 4.4 の overridesBuiltin 無し衝突（catalogBundle.js detectLibraryConflicts の1件）
 * から行を組み立てる。対象（targetEntry）は userEntries から key で引く。候補は appEntries
 * （同key除く）に対する内容一致検索——衝突しているユーザー材を「別の既存材の参照」に
 * 差し替える（代替材を指示＝pick）ための候補。
 */
function libraryConflictRow(kind, conflict, { userEntries = [], appEntries = [], origins } = {}) {
  const def = kindDef(kind);
  const targetEntry = userEntries.find(e => def.keyOf(e) === conflict.key) ?? null;
  const others = appEntries.filter(e => def.keyOf(e) !== conflict.key);
  const candidates = targetEntry
    ? rankCandidates(kind, targetEntry, matchByContent(kind, targetEntry, others).hits, origins)
    : [];
  return {
    id: `library-conflict:${kind}:${conflict.key}`,
    scenario: 'library-conflict', kind,
    targetKey: conflict.key, targetLabel: displayNameOf(targetEntry), targetEntry,
    usage: [],
    candidates,
    allowedActions: [...ALLOWED_ACTIONS['library-conflict']],
    // 承認（同分類の空き番へ付け替え=renumber）の付け替え先を事前計算しておく——
    // applyResolveDecisions を appEntries 非依存の純関数にするため（行が計算結果を運ぶ）。
    // material以外（parseMaterialCodeが解けないkey）は null（承認は保留扱いにフォールバック）。
    renumberTo: targetEntry ? nextFreeCodeInSameClass(conflict.key, appEntries) : null,
  };
}

/** 場面(c): 登録表の isSupported(entry) フックが false を返した doc エントリから行を組み立てる。 */
function unsupportedRow(kind, entry) {
  const def = kindDef(kind);
  const key = def.keyOf(entry);
  return {
    id: `unsupported:${kind}:${key}`,
    scenario: 'unsupported', kind,
    targetKey: key, targetLabel: displayNameOf(entry), targetEntry: entry,
    usage: [],
    candidates: [],
    allowedActions: [...ALLOWED_ACTIONS.unsupported],
  };
}

/** propose: planIncomingReconcile の proposals 1件（{from, candidates, entry}）から行を組み立てる。 */
function proposeRow(kind, p) {
  return {
    id: `propose:${kind}:${p.from}`,
    scenario: 'propose', kind,
    targetKey: p.from, targetLabel: displayNameOf(p.entry), targetEntry: p.entry,
    usage: [],
    candidates: p.candidates,
    allowedActions: [...ALLOWED_ACTIONS.propose],
  };
}

/** unresolved（[{code, location, ...}]）を code でグルーピングし usage 配列を作る。 */
function groupUnresolvedByCode(unresolved) {
  const byCode = new Map();
  for (const u of unresolved ?? []) {
    if (!byCode.has(u.code)) byCode.set(u.code, []);
    byCode.get(u.code).push(u);
  }
  return byCode;
}

/** 場面(b): 未解決コード1件（グルーピング後）から行を組み立てる。 */
function unresolvedCodeRow(kind, code, usage, { appEntries = [], origins, removedMaterials = [] } = {}) {
  const removedEntry = removedMaterials.find(m => m.code === code) ?? null;
  const candidates = candidatesForUnresolved(code, { removedEntry, appEntries, origins, kind });
  return {
    id: `unresolved-code:${kind}:${code}`,
    scenario: 'unresolved-code', kind,
    targetKey: code, targetLabel: removedEntry?.name ?? code, targetEntry: null,
    usage,
    candidates,
    allowedActions: [...ALLOWED_ACTIONS['unresolved-code']],
  };
}

/**
 * 場面ごとの検出結果から指示UIの行一覧を組み立てる（I/O なし。同じ入力からは同じ行が
 * 再構築される——idはtargetKey由来の決定的な文字列、ソースの配列順を保つだけで乱数・時刻は
 * 使わない）。
 * @param {{ kind?: string,
 *           proposals?: Array<{from:string, candidates:object[], entry:object}>,
 *           libraryConflicts?: Array<{key:string, diffFields:string[]}>,
 *           unsupported?: object[],
 *           unresolved?: Array<{code:string, location:string, [k:string]: unknown}>,
 *           appEntries?: object[], userEntries?: object[], builtinEntries?: object[],
 *           origins?: Map<string,string>, removedMaterials?: object[] }} args
 * @returns {Array<object>} 行モデルの配列
 */
export function buildResolveRows({
  kind = CatalogKind.MATERIAL,
  proposals = [], libraryConflicts = [], unsupported = [], unresolved = [],
  appEntries = [], userEntries = [], builtinEntries = [], origins,
  removedMaterials = [],
} = {}) {
  void builtinEntries; // 予約（現状の行組み立てはappEntries/userEntriesのみで足りる）
  const rows = [];
  for (const conflict of libraryConflicts) {
    rows.push(libraryConflictRow(kind, conflict, { userEntries, appEntries, origins }));
  }
  for (const [code, usage] of groupUnresolvedByCode(unresolved)) {
    rows.push(unresolvedCodeRow(kind, code, usage, { appEntries, origins, removedMaterials }));
  }
  for (const entry of unsupported) rows.push(unsupportedRow(kind, entry));
  for (const p of proposals) rows.push(proposeRow(kind, p));
  return rows;
}

/**
 * 既存の行から scenarios に含まれる場面の行を取り除き、newRows を追加した配列を返す
 * （非破壊。I/O なし）。検出元が複数ある（store.js起動時reconcile＝(a)library-conflict/
 * (c)unsupported/propose・modes/FinishModeState.js init＝(b)unresolved-code）ため、
 * それぞれ「自分が担当する場面の行」だけを最新の内容へ置き換えて project.catalogResolveRows
 * へ書き戻すための合流点（他の検出元が積んだ行・保留中の行を消さない）。
 * @param {object[]} existingRows
 * @param {object[]} newRows
 * @param {string[]} scenarios 置き換え対象の場面（例: ['unresolved-code']）
 * @returns {object[]}
 */
export function replaceRowsByScenario(existingRows, newRows, scenarios) {
  const kept = (existingRows ?? []).filter(r => !scenarios.includes(r.scenario));
  return [...kept, ...newRows];
}

function decisionOf(decisions, id) {
  if (decisions instanceof Map) return decisions.get(id);
  return decisions?.[id];
}

/**
 * 行と決定（Map<rowId, {action, pick?}>。プレーンオブジェクト {[rowId]: {action, pick?}} も可）
 * から、反映内容（aliasPairs/userOps）を組み立てる（I/O なし。永続化は呼び出し側の責務）。
 * 決定が無い行・action==='defer'の行は反映せず deferredRowIds へ積む——保留は「今回何もしなかった
 * 行」を表すだけで、この関数自身は状態を持たない（呼び出し側が deferredRowIds に残る行を
 * project.catalogResolveRows に残せば「次回再掲」になる）。
 *
 * QA指摘Major-1（2026-09-22）→ステップ7d QA指摘Major-2（2026-09-23）: `pick`（と `approve` の
 * 候補先）の `to` は、呼び出し側が渡す `validKeysByKind`（Map<kind, Set<string>>。種別ごとに
 * 実在するキーの集合を持つ——ステップ7dで行が複数種別を持つようになったため、種別をまたいだ
 * 単一Setへ合流すると他種別の実在キーを誤って通してしまう。行ごとに `row.kind` で引く）に
 * 無ければ**その行を保留へ戻す**——未知コード・空白のみの文字列が alias（文書の参照）に積まれ、
 * 実体の無いコードが保存で焼き付くのを防ぐ。弾いた行は deferredRowIds にも積み、
 * `rejected`（{rowId, key, reason}の配列）で理由を返す（呼び出し側=store.jsがproject.setCatalogErrorで
 * 通知する）。`validKeysByKind` 省略時は検証しない（既存の呼び出し・テストとの後方互換。
 * renumber/markOverride/addToLibraryは既存キーを参照しない操作のため検証対象外）。
 * 「候補に縛らず全ライブラリから選べる」は維持する——縛るのは「実在するキーか」だけ。
 *
 * ステップ7d QA指摘Major-1（2026-09-23）: pick で pick が未指定（空文字・非文字列）の行は
 * 例外を投げず rejected（理由「代替を指定してください」）＋保留へ回す——1行の入力漏れで
 * まとめて承認の適用全体が失敗し、他の行の決定（material の alias 等）まで失われる事故を防ぐ。
 * @param {object[]} rows buildResolveRows の戻り値
 * @param {Map<string, {action:string, pick?:string}>|Object<string,{action:string,pick?:string}>} decisions
 * @param {{ validKeysByKind?: Map<string, Set<string>> }} [opts]
 * @returns {{ aliasPairs: Array<{kind:string,from:string,to:string}>,
 *             userOps: Array<{op:'upsert'|'remove'|'renumber', kind:string, [k:string]: unknown}>,
 *             deferredRowIds: string[],
 *             rejected: Array<{rowId:string, key:string, reason:string}> }}
 */
export function applyResolveDecisions(rows, decisions, { validKeysByKind } = {}) {
  const aliasPairs = [];
  const userOps = [];
  const deferredRowIds = [];
  const rejected = [];

  // validKeysByKind省略時は検証しない（後方互換。呼び出し側=store.jsは常に渡す）。
  const keyIsValid = (row, key) => {
    const validKeys = validKeysByKind?.get(row.kind);
    return !validKeys || validKeys.has(key);
  };

  function rejectToDeferred(row, key, reason) {
    deferredRowIds.push(row.id);
    rejected.push({ rowId: row.id, key, reason });
  }

  for (const row of rows) {
    const decision = decisionOf(decisions, row.id);
    const action = decision?.action ?? 'defer';
    if (action !== 'defer' && !row.allowedActions.includes(action)) {
      throw new Error(`行 ${row.id}（${row.scenario}）に許可されていない操作です: ${action}`);
    }

    switch (action) {
      case 'defer':
        deferredRowIds.push(row.id);
        break;

      case 'approve':
        if (row.scenario === 'library-conflict') {
          if (row.renumberTo) {
            userOps.push({ op: 'renumber', kind: row.kind, from: row.targetKey, to: row.renumberTo });
          } else {
            deferredRowIds.push(row.id); // 付け替え先を計算できない（material以外のkey）→保留扱い
          }
        } else {
          const top = row.candidates[0];
          if (!top) { deferredRowIds.push(row.id); break; } // 候補なし→承認しようがない
          const toKey = kindDef(row.kind).keyOf(top);
          if (!keyIsValid(row, toKey)) {
            rejectToDeferred(row, toKey, '候補が現在のライブラリに見つかりません');
            break;
          }
          aliasPairs.push({ kind: row.kind, from: row.targetKey, to: toKey });
        }
        break;

      case 'pick': {
        const pick = decision?.pick;
        if (typeof pick !== 'string' || pick === '') {
          rejectToDeferred(row, pick, '代替を指定してください');
          break;
        }
        if (!keyIsValid(row, pick)) {
          rejectToDeferred(row, pick, '指定した代替が現在のライブラリに見つかりません');
          break;
        }
        aliasPairs.push({ kind: row.kind, from: row.targetKey, to: pick });
        if (row.scenario === 'library-conflict') {
          userOps.push({ op: 'remove', kind: row.kind, key: row.targetKey });
        }
        break;
      }

      case 'markOverride':
        if (!row.targetEntry) throw new Error(`行 ${row.id}: 対象エントリがありません`);
        userOps.push({ op: 'upsert', kind: row.kind, entry: { ...row.targetEntry, overridesBuiltin: true } });
        break;

      case 'addToLibrary':
        if (!row.targetEntry) throw new Error(`行 ${row.id}: 対象エントリがありません`);
        userOps.push({ op: 'upsert', kind: row.kind, entry: row.targetEntry });
        break;

      default:
        throw new Error(`行 ${row.id}: 未知の操作です: ${action}`);
    }
  }

  return { aliasPairs, userOps, deferredRowIds, rejected };
}
