// ================================================================
// 建具番号（記号別採番＋枝番） — 設計意図は .claude/opening-model.md 参照。
//
// structural/memberNumbering.js の2パス構造をなぞるが共通化はしない
// （構造固有の台帳・sizeKey・階プレフィックス等が流れ込むため並行実装が正当）。
//
// signature は「base（記号|種別|幅|高さ|窓台高さ）」＋「sub（仕上|材料・ガラス|見込み|金物|備考）」の
// 結合キー（openingSignature = openingBaseSignature + openingSubSignature）。グループの粒度は
// フラット（project.openingNumberIndex は signature 単一階層の Map のまま。base→variantsの
// ネストMapにはしない）——deep observable の再発防止パターン（差し替え・ゴースト掃除。下記コメント）を
// 二重に持たずに済み、openingTagOf/openingGroupsOnFloor の「signatureで1件引く」形も変わらないため、
// 既存コードへの追加差分が最小になる。各グループは自身の baseSignature を持ち、assignOpeningNumbers が
// 採番の瞬間だけ symbol→baseSignature→variants の一時的な入れ子（Mapのローカル変数）を組み立てる。
//
// 「同一仕様（signature）＝同一グループ」（signatureから毎回導出。手動タグ台帳は持たない）。
//
// 採番は2パスに分かれる（建物全体の情報が必要なため、単一graphでは完結しない）:
//   パス1（各階）: collectFloorOpeningGroups で project.openingNumberIndex（非永続キャッシュ）に
//                  signature → {symbol, subType, width, height, sillHeight, baseSignature, counts} を積む。
//   パス2（建物全体で1回）: assignOpeningNumbers(project) が純関数として signature → タグ の
//                  対応表を作り、applyOpeningTags(project, tags) が各グループの .tag/.no/.branch へ書き戻す。
//
// 採番規則（assignOpeningNumbers）:
//   1. 記号（symbol）ごとに分ける。
//   2. 記号内を baseSignature でまとめ、各baseの代表値で 幅降順 → 高さ降順 → 窓台高さ昇順 →
//      baseSignature辞書順 にソートして 1,2,3… の基本番号を振る（ソート規則は枝番導入前と同じ）。
//   3. 各base内の建具表バリアント（sub側の組）が1種類だけなら枝番なし（タグ＝`${symbol}-${n}`）。
//      2種類以上ならsignature辞書順（＝sub側の辞書順）で a, b, c… を振り、タグ＝`${symbol}-${n}${枝番}`
//      （無印と枝番の混在はしない——1種類→2種類に増えた瞬間、既存の無印タグも枝番付きへ動く）。
//   4. 階プレフィックスは付けない（採番は全階統一＝記号-番号(-枝番)は仕様を指す）。
// ================================================================

import { defaultFixtureSymbol, defaultOpeningHeight } from './openingCatalog.js';

/** opening.fixtureType（未設定ならカテゴリ既定へフォールバック）。 */
export function fixtureSymbolOf(opening) {
  return opening.fixtureType ?? defaultFixtureSymbol(opening.category);
}

/**
 * opening.height（未設定・不正値ならカタログ既定へフォールバック）。
 * height<=0（null/0/負値）は不正値として未設定と同じ扱いにする（graphFbs.js の OP.HEIGHT
 * 「0=未設定」規約を負値にも広げたもの——UI入力は絶対値化で負値を弾いているが（openings/
 * OpeningEditor.jsx）、復元データ・直接代入等 UI を経由しない経路からの負値混入に対しても
 * 姿図（rect の高さ）が壊れないよう、ここでも防御する）。
 */
export function effectiveHeight(opening) {
  const h = opening.height;
  return (h != null && h > 0) ? h : defaultOpeningHeight(opening.category, opening.subType);
}

function round(v) { return Math.round(v); }

// signature の各項目に使う正規化（null/未入力は'-'、値ありはそのまま。文字列化して結合する）。
function norm(v) { return v == null || v === '' ? '-' : String(v); }

/** 基本番号のグルーピングキー（記号|種別|幅|高さ|窓台高さ）。枝番導入前の signature と同じ形。 */
export function openingBaseSignature(opening) {
  const symbol = fixtureSymbolOf(opening);
  const height = effectiveHeight(opening);
  const sill = opening.sillHeight;
  return `${symbol}|${opening.subType}|${round(opening.width)}|${round(height)}|${sill == null ? '-' : round(sill)}`;
}

/** 枝番のグルーピングキー（仕上|材料・ガラス|見込み|金物|備考）。 */
export function openingSubSignature(opening) {
  return `${norm(opening.finish)}|${norm(opening.materialGlass)}|${norm(opening.frameDepth)}|${norm(opening.hardware)}|${norm(opening.note)}`;
}

/** 採番グループの同一性キー（openingBaseSignature + openingSubSignature の結合）。 */
export function openingSignature(opening) {
  return `${openingBaseSignature(opening)}||${openingSubSignature(opening)}`;
}

// 0始まりindex → 'a','b',…,'z','aa','ab',…（スプレッドシートの列名と同じ26進）。
function branchLetter(index) {
  let n = index + 1;
  let s = '';
  while (n > 0) {
    n -= 1;
    s = String.fromCharCode(97 + (n % 26)) + s;
    n = Math.floor(n / 26);
  }
  return s;
}

// ----------------------------------------------------------------
// パス1: 収集
// ----------------------------------------------------------------

/**
 * graph.openings を project.openingNumberIndex（非永続・observable.map）に積む。
 * この関数だけでは opening のタグは確定しない（確定は assignOpeningNumbers/applyOpeningTags）。
 *
 * このplane分の寄与は毎回「洗い替え」する（memberNumbering.collectFloorGroups と同じ理由）:
 *   1. 収集前に、既存の全エントリからこのplaneの寄与（counts.delete(planeId)）を取り消す。
 *   2. このgraphの現在の開口を再収集する。
 *   3. counts.size===0（どの階からも参照されなくなった）グループを index から削除する。
 */
export function collectFloorOpeningGroups(graph, project) {
  const planeId = graph.plane.id;

  for (const group of project.openingNumberIndex.values()) {
    group.counts.delete(planeId);
  }

  const localCounts = new Map(); // signature → このgraphでの本数

  for (const opening of graph.openings) {
    const signature = openingSignature(opening);
    localCounts.set(signature, (localCounts.get(signature) ?? 0) + 1);
    if (!project.openingNumberIndex.has(signature)) {
      project.openingNumberIndex.set(signature, {
        symbol: fixtureSymbolOf(opening),
        subType: opening.subType,
        width: opening.width,
        height: effectiveHeight(opening),
        sillHeight: opening.sillHeight,
        finish: opening.finish,
        materialGlass: opening.materialGlass,
        frameDepth: opening.frameDepth,
        hardware: opening.hardware,
        note: opening.note,
        baseSignature: openingBaseSignature(opening),
        counts: new Map(),
        tag: null,
        no: null,
        branch: null,
      });
    }
  }

  // project.openingNumberIndex は deep な observable.map（core.js）のため、直前の set() に渡した
  // plain object はそのまま格納されず、MobXが別のobservableオブジェクトへ深変換した複製が格納される
  // （値渡しではなく複製）。以後 group.counts.set で変異する対象を「格納実体」に揃えるため、
  // 変異の直前に必ず get() して差し替える（構造側 memberNumbering.js:83-92 で再発したバグと同型。
  // 差し替えないとこのplaneにしか存在しない新規グループの counts が空のまま残り、末尾のゴースト掃除で
  // 直後に削除されタグがnullのままになる）。
  for (const [signature, n] of localCounts) {
    const group = project.openingNumberIndex.get(signature);
    group.counts.set(planeId, n);
  }

  for (const [signature, group] of project.openingNumberIndex) {
    if (group.counts.size === 0) project.openingNumberIndex.delete(signature);
  }
}

// ----------------------------------------------------------------
// パス2: 採番（純関数）
// ----------------------------------------------------------------

// 幅降順・高さ降順・窓台高さ昇順・signature（baseレベルではbaseSignature）昇順のタイブレークで
// 比較する（負=aが先）。entry = { signature, group }
function compareGroupsDesc(a, b) {
  if (a.group.width !== b.group.width) return b.group.width - a.group.width;
  if (a.group.height !== b.group.height) return b.group.height - a.group.height;
  const sa = a.group.sillHeight ?? -Infinity, sb = b.group.sillHeight ?? -Infinity;
  if (sa !== sb) return sa - sb;
  return a.signature < b.signature ? -1 : (a.signature > b.signature ? 1 : 0);
}

/**
 * project.openingNumberIndex（建物全体、収集済み）から signature → { tag, no, branch } の
 * 対応表を作る純関数。副作用なし（entity・index には触れない）。
 *   no     = 記号内の基本番号（数値）。タグ文字列（`AW-10`等）は辞書順ソートだと`AW-2`より
 *            前に来てしまうため、number順に並べたいリスト側（openingGroupsOnFloor）は
 *            tag ではなく no（→同点ならbranch）を比較に使う。
 *   branch = 同一base内に建具表バリアントが複数あるときだけ付く枝番（'a'|'b'|…）。単一なら null。
 */
export function assignOpeningNumbers(project) {
  // symbol → baseSignature → [{signature, group}]（枝番判定のための一時的な入れ子。
  // project.openingNumberIndex 自体はフラットなまま——上部ヘッダコメント参照）。
  const bySymbol = new Map();
  for (const [signature, group] of project.openingNumberIndex) {
    if (!bySymbol.has(group.symbol)) bySymbol.set(group.symbol, new Map());
    const bases = bySymbol.get(group.symbol);
    if (!bases.has(group.baseSignature)) bases.set(group.baseSignature, []);
    bases.get(group.baseSignature).push({ signature, group });
  }

  const tags = new Map();
  for (const [symbol, bases] of bySymbol) {
    // 各baseの代表値（同一base内は幅・高さ・窓台高さが必ず同値）でbase間の順位を決める。
    const baseList = [...bases.entries()].map(([baseSignature, variants]) => ({
      baseSignature, variants, repGroup: variants[0].group,
    }));
    baseList.sort((a, b) => compareGroupsDesc(
      { signature: a.baseSignature, group: a.repGroup },
      { signature: b.baseSignature, group: b.repGroup },
    ));

    baseList.forEach((base, i) => {
      const no = i + 1;
      const variants = [...base.variants].sort((a, b) => (a.signature < b.signature ? -1 : (a.signature > b.signature ? 1 : 0)));
      if (variants.length === 1) {
        tags.set(variants[0].signature, { tag: `${symbol}-${no}`, no, branch: null });
      } else {
        variants.forEach((v, vi) => {
          const branch = branchLetter(vi);
          tags.set(v.signature, { tag: `${symbol}-${no}${branch}`, no, branch });
        });
      }
    });
  }
  return tags;
}

/** assignOpeningNumbers の結果を project.openingNumberIndex の各グループの .tag/.no/.branch へ書き戻す。 */
export function applyOpeningTags(project, tags) {
  for (const [signature, { tag, no, branch }] of tags) {
    const group = project.openingNumberIndex.get(signature);
    if (group) { group.tag = tag; group.no = no; group.branch = branch; }
  }
}

/** opening のタグ（未確定なら null）。 */
export function openingTagOf(opening, project) {
  return project.openingNumberIndex.get(openingSignature(opening))?.tag ?? null;
}

/**
 * 建具記号丸の上下2段テキスト用パーツ。symbol はグループが無くても fixtureSymbolOf へ
 * フォールバックする（未収集でも記号自体は常に確定するため）。number は「no+branch」の
 * 文字列（例 '1'/'1a'）で、採番未確定（グループ未収集）なら null（呼び出し側で空文字表示）。
 * @returns {{symbol: string, number: string|null}}
 */
export function openingTagPartsOf(opening, project) {
  const group = project.openingNumberIndex.get(openingSignature(opening));
  const symbol = group?.symbol ?? fixtureSymbolOf(opening);
  const number = group?.no != null ? `${group.no}${group.branch ?? ''}` : null;
  return { symbol, number };
}

/**
 * 自階だけ collect → assign → apply する即時反映用（構造の renumberMembers と同格）。
 * project.openingNumberIndex に既に積まれている他階分（直近の反映パスで得た情報）を使って
 * 番号を決める——他階が一度も反映されていない場合は自階だけの相対順位で決まり、次のモード境界の
 * 反映パス（App.jsx collectOpeningNumbersAllFloors）で建物全体の順位に補正される。
 */
export function renumberOpenings(graph, project) {
  collectFloorOpeningGroups(graph, project);
  const tags = assignOpeningNumbers(project);
  applyOpeningTags(project, tags);
}

/**
 * パネル用: アクティブ階の開口を、その記号別グループごとにまとめて返す（tag昇順）。
 * @returns {Array<{ tag: string|null, group: object, openings: object[] }>}
 */
export function openingGroupsOnFloor(graph, project) {
  const bySignature = new Map(); // signature → openings[]
  for (const opening of graph.openings) {
    const signature = openingSignature(opening);
    if (!bySignature.has(signature)) bySignature.set(signature, []);
    bySignature.get(signature).push(opening);
  }
  const out = [];
  for (const [signature, openings] of bySignature) {
    const group = project.openingNumberIndex.get(signature);
    out.push({ tag: group?.tag ?? null, group, openings });
  }
  out.sort((a, b) => {
    if (a.tag == null && b.tag == null) return 0;
    if (a.tag == null) return 1;
    if (b.tag == null) return -1;
    // タグ文字列（`AW-10`等）の辞書順ソートだと`AW-2`より前に来てしまうため、
    // 記号は文字列比較・番号は数値比較・枝番は文字列比較の3段ソートにする（Finding 2 再発防止）。
    const symA = a.group?.symbol ?? '', symB = b.group?.symbol ?? '';
    if (symA !== symB) return symA < symB ? -1 : 1;
    const noA = a.group?.no ?? 0, noB = b.group?.no ?? 0;
    if (noA !== noB) return noA - noB;
    const brA = a.group?.branch ?? '', brB = b.group?.branch ?? '';
    if (brA.length !== brB.length) return brA.length - brB.length; // 26進は桁数が長いほど必ず後ろ（a,b,…,z,aa,ab,…）
    return brA < brB ? -1 : (brA > brB ? 1 : 0);
  });
  return out;
}
