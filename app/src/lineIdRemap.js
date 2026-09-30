// 線（中心線・通り芯）の id の一括振り直しと、事後検査。
//
// 不変条件: 対象は「保存形式の中間オブジェクト」（plain object。生きているグラフ＝クラス
// インスタンスは直接書き換えない）。置換は文字列値・オブジェクトのキーの両方に対し、参照の種類
// ごとの書き換え処理を書かず1関数で行う——旧 id を「部分文字列として」置換することで、`:` で
// 連結したセルキー・`|` 等で連結した交点キー・id をキーにした辞書のすべてに効く。
//
// node:test から単体で import できる純モジュール（store.js・snap.js・.jsx を静的に引かない）。

/**
 * idMap（旧id→新id）の妥当性を検査する。
 * @param {Map<string,string>} idMap
 */
function validateIdMap(idMap) {
  if (!(idMap instanceof Map)) {
    throw new Error('remapLineIdsInSnapshot: idMap は Map<string,string> である必要があります');
  }
  const seenNewIds = new Set();
  for (const [oldId, newId] of idMap) {
    if (typeof oldId !== 'string' || oldId === '') {
      throw new Error(`remapLineIdsInSnapshot: idMap の旧idが不正です（空文字または非文字列）: ${JSON.stringify(oldId)}`);
    }
    if (typeof newId !== 'string' || newId === '') {
      throw new Error(`remapLineIdsInSnapshot: idMap の新idが不正です（空文字または非文字列）: 旧id=${oldId}`);
    }
    if (seenNewIds.has(newId)) {
      throw new Error(`remapLineIdsInSnapshot: idMap に重複する新idがあります: ${newId}`);
    }
    seenNewIds.add(newId);
  }
}

const RE_ESCAPE = /[.*+?^${}()|[\]\\]/g;
function escapeRegExp(s) {
  return s.replace(RE_ESCAPE, '\\$&');
}

/**
 * idMap の全ての旧idを一度に検出する正規表現を作る（同時置換のため）。
 * 順序依存の不良（連鎖置換・入替え・部分文字列の誤爆）を避けるため、置換は1回の走査・
 * 1回のマッチごとに完結させる——マッチした文字列は元のsnapshotに存在した旧idそのものであり、
 * 置換後の新idの中に別の旧idが偶然含まれていても再走査しない。
 * 長い旧idを先に試す（短い旧idが長い旧idの部分文字列であるケースの誤マッチを避ける）。
 * @param {Map<string,string>} idMap
 * @returns {RegExp|null} idMapが空ならnull
 */
function buildIdRegex(idMap) {
  if (idMap.size === 0) return null;
  const ids = [...idMap.keys()].sort((a, b) => b.length - a.length);
  return new RegExp(ids.map(escapeRegExp).join('|'), 'g');
}

/**
 * 文字列 str に含まれる旧idをすべて新idへ置換する（部分文字列一致・同時置換）。
 * @param {string} str
 * @param {Map<string,string>} idMap
 * @param {RegExp|null} idRegex buildIdRegexの戻り値
 * @returns {string}
 */
function replaceIdsInString(str, idMap, idRegex) {
  if (!idRegex) return str;
  return str.replace(idRegex, matched => idMap.get(matched));
}

/**
 * snapshot（またはその一部）を再帰的に走査し、旧idを新idへ置換した新しい値を返す。
 * 入力は書き換えない。オブジェクトのキー置換で異なる旧キーが同じ新キーへ衝突する場合は throw する
 * （吸収＝複数の旧idを1つの新idへ寄せる操作でも、どちらの値を採るかは呼び出し側が事前に解決して
 * おくべきで、この関数が黙ってどちらかを消してはならない）。
 * @param {*} value
 * @param {Map<string,string>} idMap
 * @param {RegExp|null} idRegex
 * @param {string} path エラーメッセージ用
 * @returns {*}
 */
function remapValue(value, idMap, idRegex, path) {
  if (value === null || typeof value !== 'object') {
    return typeof value === 'string' ? replaceIdsInString(value, idMap, idRegex) : value;
  }
  // バイナリはそのまま（走査対象外）。同じ参照を返してよい（不変値）。
  if (value instanceof Uint8Array || value instanceof ArrayBuffer) return value;
  // 中間オブジェクトには現れない想定。現れたら設計が違うので黙って通さない。
  if (value instanceof Map || value instanceof Set) {
    throw new Error(`remapLineIdsInSnapshot: Map/Set は中間オブジェクトに現れない想定のためサポートしません（path=${path}）`);
  }
  if (Array.isArray(value)) {
    return value.map((v, i) => remapValue(v, idMap, idRegex, `${path}[${i}]`));
  }
  // plain object: キーも値も置換対象。走査順に依らないよう、先に全キーの置換後の名前を求めてから
  // 衝突を検査する。
  const entries = Object.entries(value);
  const newKeys = entries.map(([key]) => replaceIdsInString(key, idMap, idRegex));
  const seen = new Map(); // newKey -> 元のkey（衝突検出用）
  for (let i = 0; i < entries.length; i++) {
    const [key] = entries[i];
    const newKey = newKeys[i];
    if (seen.has(newKey)) {
      throw new Error(
        `remapLineIdsInSnapshot: キーの置換が衝突しました（path=${path}）: ` +
        `"${seen.get(newKey)}" と "${key}" がどちらも "${newKey}" へ置換されます`,
      );
    }
    seen.set(newKey, key);
  }
  const result = {};
  for (let i = 0; i < entries.length; i++) {
    const [key, val] = entries[i];
    const newKey = newKeys[i];
    const childPath = path ? `${path}.${key}` : key;
    result[newKey] = remapValue(val, idMap, idRegex, childPath);
  }
  return result;
}

/**
 * snapshot 全体に対し、idMap（旧id→新id）で線の id を一括置換した新しい snapshot を返す。
 * 入力を書き換えない（深いコピー）。置換は同時置換（idMap の全ての旧idを1回の走査で見分ける）で
 * 行うため、旧idどうしの連鎖（a→b, b→c）・入替え（a↔b）・部分文字列関係（cl-1 と cl-10）があっても
 * 誤った結果にならない。
 * @param {object} snapshot 保存形式の中間オブジェクト
 * @param {Map<string,string>} idMap 旧id→新id
 * @returns {object} 置換済みの新しい plain object
 */
export function remapLineIdsInSnapshot(snapshot, idMap) {
  validateIdMap(idMap);
  const idRegex = buildIdRegex(idMap);
  return remapValue(snapshot, idMap, idRegex, '');
}

/**
 * value・path を再帰的に走査し、ids に含まれる id が文字列値・オブジェクトキーの部分文字列として
 * 残っている箇所を集める。
 * @param {*} value
 * @param {string} path
 * @param {string[]} ids
 * @param {{id:string, path:string}[]} results
 */
function collectOccurrences(value, path, ids, results) {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'string') {
      for (const id of ids) {
        if (value.includes(id)) results.push({ id, path });
      }
    }
    return;
  }
  if (value instanceof Uint8Array || value instanceof ArrayBuffer) return;
  if (value instanceof Map || value instanceof Set) {
    throw new Error('findLineIdOccurrences: Map/Set は中間オブジェクトに現れない想定のためサポートしません');
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => collectOccurrences(v, `${path}[${i}]`, ids, results));
    return;
  }
  for (const [key, val] of Object.entries(value)) {
    const childPath = path ? `${path}.${key}` : key;
    for (const id of ids) {
      if (key.includes(id)) results.push({ id, path: childPath });
    }
    collectOccurrences(val, childPath, ids, results);
  }
}

/**
 * ids の各 id が snapshot のどこに残っているかを返す（事後条件の検査・既存データの検出に共用）。
 * @param {object} snapshot
 * @param {Iterable<string>} ids
 * @returns {{id:string, path:string}[]}
 */
export function findLineIdOccurrences(snapshot, ids) {
  const idList = Array.isArray(ids) ? ids : [...ids];
  const results = [];
  collectOccurrences(snapshot, '', idList, results);
  return results;
}

/**
 * snapshot.centerLines の全idについて新idを割り当てた Map<旧id,新id> を返す
 * （通り芯は階の snapshot に含まれないため対象外＝線だけを振り直す）。
 * @param {object} snapshot
 * @param {{newId?: () => string}} [opts] newId はテストの決定性のために注入可能
 * @returns {Map<string,string>}
 */
export function makeFreshLineIdMap(snapshot, { newId = () => crypto.randomUUID() } = {}) {
  const idMap = new Map();
  for (const cl of snapshot.centerLines ?? []) {
    idMap.set(cl.id, newId());
  }
  return idMap;
}
