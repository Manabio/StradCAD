// ガードテスト（ステップ7、2026-09-20）。
//
// 背景: 「中心線・補助線の操作が非表示の梁芯に阻まれる」不具合が、追加→移動→延長と3回に分けて
// 発覚した。3回とも原因は「誤った種別条件」ではなく「種別条件の無い素の graph.centerLines 走査」
// だった。centerLineKindPolicy.js（本ディレクトリ）に相手選択・可視性判定を集約したうえで、
// 本ファイルは「その入口を機械的に閉じる」——app/src 配下の製品コード（*.test.js を除く）を走査し、
// 許可ドメイン外での新しい直接走査・labeled代用・インライン種別比較・discipline/lineType生比較が
// 増えたら即座に赤くする（ラチェット）。
//
// G1: `.centerLines` の直接参照の禁止（許可ドメイン=core/・renderer/・schema/。それ以外は allowlist
//     に載っている件数だけ許可）。
// G2: 生の `.labeled` を種別（centerLineKind）の代用に読むことの禁止（許可ドメイン=core/・renderer/・
//     schema/・graphSnapshot.js。`.labeled` は CenterLine 以外のプロパティ名として再利用されうる汎用語
//     ではなく、このコードベースでは core/centerLine.js の CenterLine クラスだけが定義するフィールド
//     ——誤検出のリスクは低いが、「CL由来の.labeledプロパティへのアクセスすべて」を機械的に数える
//     ため、種別判定以外の用途（undoスナップショット等）も一緒に数えてしまう限界がある。allowlistの
//     理由欄にその旨を明記する）。
// G3: `centerLineKind(x) <op> '<リテラル>'`（<op>は===/!==/==/!=、リテラルは比較の左右どちらの辺でも
//     よい）形のインライン種別比較の禁止（許可ドメインはG2と同じ）。リテラル側が文字列リテラルの
//     場合のみを対象にする——`centerLineKind(cl) === kind`（kindは変数）のような汎用的な同値比較は
//     ポリシー関係の重複実装ではなく通常の分岐ロジックのため対象外（限界として明記）。
// G4: CL の種別判定を `discipline`／`lineType` の生フィールド比較で代用することの禁止（許可ドメインは
//     G2/G3と同じ）。`.discipline <op> (Discipline.<定数>|'<リテラル>'|"<リテラル>")` および
//     `.lineType <op> ('<リテラル>'|"<リテラル>")`（<op>・左右の扱いはG3と同じ）の形を対象にする——
//     `Discipline` は core/constants.js で素の文字列定数（'arch'/'struct'/'fuse'…）のため、
//     `cl.discipline === Discipline.STRUCT` と `cl.discipline === 'struct'` は等価な抜け道であり
//     両方を検出する（QA指摘M-1。lineType側はもともと文字列リテラル形のみのため、ダブルクォートにも
//     対応を広げて左右対称にした）。`.discipline`／`.lineType` は `{ discipline: cl.discipline }` の
//     ような代入・コピーにも使われる汎用フィールド名（Shape基底クラス由来。CenterLine専用ではない）で、
//     それらは種別判定ではないため「比較演算子を伴う場合」だけに絞ることで機械的に除外する（限界:
//     CenterLine以外のShape（Wall等）が同名フィールドを比較する将来のコードは区別できず誤検出になり
//     うるが、実測ではapp/src中の比較演算子つき出現はすべてCenterLineに対するものだった）。
//
// 数え方: ソースを1文字ずつ走査するトークナイザ（tokenize、下記）でコメント（`//`・`/* */`）・
// 文字列リテラル（'・"・`）・正規表現リテラルの境界を認識したうえで、2種類のテキストを作る——
// (a) codeOnly: コメントに加え文字列・正規表現リテラルの「中身」も空白に置換したテキスト（G1/G2用。
//     エラーメッセージ等の文字列中に `.centerLines`/`.labeled` という語が偶然含まれていても実際の
//     プロパティアクセスとして数えない）。
// (b) withoutComments: コメントだけを除去し文字列リテラルはそのまま残したテキスト（G3・G4用。
//     `centerLineKind(cl) === 'struct'` や `cl.lineType === 'dashed'` のような比較はリテラルの
//     引用符自体が検出対象の一部であり codeOnly では消えてしまうため別系統にする必要がある）。
// 正規表現マッチ数は決定的・再現可能——allowlist の件数は tokenize を実際に各ファイルへ適用すれば
// 誰でも再現できる。allowlist に載っているのに実際の件数が0（掃除漏れ・移行済みなのに項目が
// 残っている）でも赤くなる。
//
// トークナイザの既知の限界（意図的な簡易実装。JS/JSXのフルパーサではない——QA指摘対応）:
//  - 正規表現リテラルと除算演算子の判別はヒューリスティック（直前の非空白文字が識別子文字・数字・
//    `)`・`]` なら除算、それ以外なら正規表現）。真のJS文法（直前トークンの意味）までは見ないため、
//    稀な組み合わせでは誤判定しうる——このコードベースの実測では問題を起こしていない。
//  - テンプレートリテラル（`...`）は `${}` 内の式を「コードとして」は解釈せず、リテラル全体を
//    1つの文字列として扱う（`${}` の中に `.centerLines` 等が書かれても検出できない）。
//  - 変数エイリアスは追跡しない（正規表現ベースのため）——`const cls = graph.centerLines;` の代入行
//    自体は検出できるが、以後 `cls.filter(...)` のように別名を使い回す箇所は検出できない（同様に
//    G3も `const k = centerLineKind(cl); k === 'beam'` のような変数経由の比較は検出しない。G4も
//    `const { discipline, lineType } = cl; discipline === Discipline.STRUCT` のように分割代入で
//    フィールドを取り出してから比較する形は、比較式に `.discipline`／`.lineType` という文字列が
//    現れないため検出できない）。
//  - 許可ドメイン（renderer/等）の内部で同種の判定ロジックが並行実装されていても、ドメインごと対象外
//    のため射程外（例: renderer/gutterLabelHits.js の isCenterDimensionTarget は cl.labeled 等の
//    独自判定を持つが、renderer/ は描画層の正当な責務としてG1〜G4いずれも検査しない）。
//  - G4は `.discipline`／`.lineType` というフィールド名そのもので判別するため、Shape基底クラスを
//    共有する CenterLine 以外のオブジェクト（Wall等）への比較演算が将来増えると誤検出になりうる
//    （代入・コピーは比較演算子を伴わないため自然に対象外になる）。
//  - G3・G4は withoutComments（文字列リテラルの中身を残す）を見るため、エラーメッセージ等の
//    文字列リテラルの中に判定パターン全体（例: `"旧実装は centerLineKind(cl) !== 'aux' だった"`）が
//    そのまま埋め込まれていると誤検出する（実測で確認済み）。文字列内にキーワード単体
//    （例: `"'aux' 表記"`）が現れるだけでは判定パターン全体に一致しないため誤検出しない。
//  - G4は比較演算子（===等）を伴う形のみ対象——`switch (cl.lineType) { case 'dashed': ... }` や
//    `[Discipline.STRUCT, Discipline.FUSE].includes(cl.discipline)` のように比較演算子を伴わずに
//    種別判定を代用する形は検出できない（app/src 中には現存しない。実測でapp/src中の
//    `.discipline`／`.lineType` 出現はすべて代入・コピー・比較演算子つき比較のいずれかだった）。
//
// ガードが赤くなったら: (1) 相手選択（同座標・同方向・可視種別等でCLを選ぶ処理）なら
// centerLineKindPolicy.js の走査API（orthoAnchorCandidates(ForNew)・sameDirectionObstacles・
// sameCoordCounterparts・mergeCandidates・candidatesVisibleIn等。無ければ追加）経由に直す。
// (2) 相手選択でない（シリアライズ・id解決・全件列挙・MobX reactionの依存収集・幾何署名判定等）なら、
// このファイル末尾の allowlist に「ファイル＋理由＋件数」を追記する。
// (3) 未移行（既存ロジックに手を入れると波及が大きく別タスクが要る）なら、その理由を allowlist に
// 明記する。G4（discipline/lineType生比較）の場合はまず centerLineKind(cl) を使った判定に
// 置き換えられないか検討し、無理なら同様に allowlist へ追記する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const SRC_ROOT = path.resolve(import.meta.dirname, '..'); // app/src

// ---- ソース走査ユーティリティ ----

function listProductFiles(dir = SRC_ROOT, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      listProductFiles(full, out);
    } else if (/\.(js|jsx)$/.test(ent.name) && !ent.name.endsWith('.test.js')) {
      out.push(full);
    }
  }
  return out;
}

// トークナイザ本体。ソースを1文字ずつ走査し、コメント・文字列（'・"）・テンプレートリテラル（`）・
// 正規表現リテラルの境界を認識する。改行はすべての出力で保持する（行数・全体長を変えず、正規表現の
// `^`/`$`・行コメントのスコープ判定に影響しないようにするため）。
// @returns {{codeOnly: string, withoutComments: string}}
function tokenize(src) {
  let codeOnly = '';
  let withoutComments = '';
  let i = 0;
  const n = src.length;
  const blank = (ch) => (ch === '\n' ? '\n' : ' ');

  // codeOnly に積んだ最後の非空白文字（正規表現/除算の判別用ヒューリスティック）。
  const lastSignificantChar = () => {
    for (let j = codeOnly.length - 1; j >= 0; j--) {
      const c = codeOnly[j];
      if (c === ' ' || c === '\n' || c === '\t' || c === '\r') continue;
      return c;
    }
    return '';
  };
  const isRegexContext = () => {
    const c = lastSignificantChar();
    if (c === '') return true;
    return !/[A-Za-z0-9_$)\]]/.test(c);
  };

  while (i < n) {
    const c = src[i];
    const c2 = i + 1 < n ? src[i + 1] : '';

    // 行コメント（文字列・正規表現の外でのみ、というのはこのif分岐に来る時点で保証されている）。
    if (c === '/' && c2 === '/') {
      i += 2;
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    // ブロックコメント。
    if (c === '/' && c2 === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
        const b = blank(src[i]);
        codeOnly += b; withoutComments += b;
        i++;
      }
      i += 2; // */ を読み飛ばす
      continue;
    }
    // 文字列リテラル（'・"）・テンプレートリテラル（`）。中身は codeOnly では空白化、
    // withoutComments ではそのまま保持する（G3がリテラル `'struct'` 等を見る必要があるため）。
    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      codeOnly += ' '; withoutComments += quote;
      i++;
      while (i < n && src[i] !== quote) {
        if (src[i] === '\\' && i + 1 < n) {
          codeOnly += blank(src[i]); withoutComments += src[i];
          i++;
          codeOnly += blank(src[i]); withoutComments += src[i];
          i++;
          continue;
        }
        codeOnly += blank(src[i]); withoutComments += src[i];
        i++;
      }
      if (i < n) { codeOnly += ' '; withoutComments += quote; i++; }
      continue;
    }
    // 正規表現リテラル（ヒューリスティック判別。改行をまたがない・文字クラス[...]内の/は終端にしない）。
    if (c === '/' && isRegexContext()) {
      let j = i + 1;
      let inClass = false;
      let closed = false;
      while (j < n) {
        const cj = src[j];
        if (cj === '\\') { j += 2; continue; }
        if (cj === '\n') break;
        if (cj === '[') inClass = true;
        else if (cj === ']') inClass = false;
        else if (cj === '/' && !inClass) { closed = true; break; }
        j++;
      }
      if (closed) {
        let k = j + 1;
        while (k < n && /[a-zA-Z]/.test(src[k])) k++; // 末尾フラグ
        for (let p = i; p < k; p++) { codeOnly += ' '; withoutComments += ' '; }
        i = k;
        continue;
      }
      // 閉じなかった＝実は除算演算子だった可能性が高い（誤判定の保険）。1文字だけ通常どおり出力する。
    }
    codeOnly += c; withoutComments += c;
    i++;
  }
  return { codeOnly, withoutComments };
}

function relPath(file) {
  return path.relative(SRC_ROOT, file).replace(/\\/g, '/');
}

function countMatches(text, regex) {
  return (text.match(regex) || []).length;
}

const RE_CENTERLINES   = /\.centerLines\b/g;
// 分割代入形（`{ centerLines }`・`{ centerLines: x }`。`,`や複数プロパティの並びにも対応）。
// `{`または`,`の直後にプロパティ名centerLinesが来て、任意で`: 単純な識別子`のエイリアスを伴い、
// 直後が`,`か`}`で終わるものだけを対象にする——`{ centerLines: graph.centerLines }`のような
// オブジェクトリテラル構築（値がドットを含む式）はエイリアス部分が単純識別子でないため一致しない。
const RE_DESTRUCTURE_CENTERLINES = /[{,]\s*centerLines\s*(?::\s*[A-Za-z_$][\w$]*\s*)?[,}]/g;
const RE_LABELED       = /\.labeled\b/g;
// centerLineKind(x) <op> 'kind' は左右どちらの辺にリテラルが来てもよい形に対応する
// （op = ===/!==/==/!=。`[!=]==?` は「!か=」+「=」+「省略可能な=」の3要素で4通りの演算子を
// 1本の文字クラスで拾う——例: '===' は '='(class)+'='(必須)+'='(任意)、'!=' は '!'(class)+'='(必須)）。
const RE_INLINE_KIND   =
  /centerLineKind\([^)]*\)\s*[!=]==?\s*'(?:struct|center|aux|beam)'|'(?:struct|center|aux|beam)'\s*[!=]==?\s*centerLineKind\([^)]*\)/g;
// G4: `.discipline`／`.lineType` を比較演算子つきで使う形のみ対象（代入・コピーは対象外）。
// 定数側（Discipline.<定数> / 文字列リテラル。'・"どちらも）は比較の左右どちらの辺に来てもよい。
// Discipline.<定数>は core/constants.js で素の文字列（'arch'/'struct'/'fuse'…）のため、
// `cl.discipline === Discipline.STRUCT` と `cl.discipline === 'struct'` は等価な抜け道——
// 両方を1本の選択（Discipline.\w+|'...'|"..."）で拾う（QA指摘M-1）。
const RE_DISCIPLINE    =
  /\.discipline\s*[!=]==?\s*(?:Discipline\.\w+|'[^'\n]*'|"[^"\n]*")|(?:Discipline\.\w+|'[^'\n]*'|"[^"\n]*")\s*[!=]==?\s*[\w$]+(?:\.[\w$]+)*\.discipline/g;
const RE_LINETYPE      =
  /\.lineType\s*[!=]==?\s*(?:'[^'\n]*'|"[^"\n]*")|(?:'[^'\n]*'|"[^"\n]*")\s*[!=]==?\s*[\w$]+(?:\.[\w$]+)*\.lineType/g;

function isUnderRoot(rel, root) {
  return rel === root || rel.startsWith(`${root}/`);
}
// G1 許可ドメイン: ポリシー自身・描画層・シリアライズ層は生の graph.centerLines を扱うのが正当な責務。
const G1_EXEMPT_ROOTS = ['core', 'renderer', 'schema'];
function isG1Exempt(rel) {
  return G1_EXEMPT_ROOTS.some(root => isUnderRoot(rel, root));
}
// G2/G3 許可ドメイン: G1と同じ3ディレクトリに加え、graphSnapshot.js（永続化からの全件復元は
// 種別を問わず全フィールドを読み書きするのが正しい責務のため）。
const G2G3_EXEMPT_FILES = new Set(['graphSnapshot.js']);
function isG2G3Exempt(rel) {
  return isG1Exempt(rel) || G2G3_EXEMPT_FILES.has(rel);
}

// ================================================================
// allowlist（残課題の台帳）
// ================================================================
// 区分:
//   'not-partner-selection' — 相手選択（種別ベースで候補を絞る処理）ではない
//                              （シリアライズ・id解決・全件列挙・reactionの依存収集・幾何署名判定等）。
//   'unmigrated'             — 相手選択だが、既存ロジックへの手入れが波及大のため本ステップでは
//                              未移行（別タスクで種別ベースへ統一する）。

// ---- G1: `.centerLines` 直接参照 ----
const G1_ALLOWLIST = {
  'finish/stair/stairUnderSplit.js': { count: 1, category: 'not-partner-selection',
    reason: 'findUnderStairSplitCLs（graph.centerLines走査）→isSplitCLForによる同定。種別条件は' +
      'isUnderStairSplitKind（core/centerLineKindPolicy.js。UNDER_STAIR_SPLIT_KINDS）へ移行済み' +
      '（ステップ6、2026-09-20）——残る絞り込みは幾何署名（外形内を横切り、extentが外形の直交範囲と' +
      '一致する）による同定で、既存の走査API（orthoAnchorCandidates等）が扱う「同座標・同方向・' +
      '可視種別」の形に合わないため、走査API化は対象外（相手選択ではなく幾何署名判定）。' },
  'graphSnapshot.js': { count: 2, category: 'not-partner-selection',
    reason: 'restoreStructCLs/applySnapshot。永続化からの全件復元（snapshot.centerLines）——種別を問わず' +
      '全件を作り直す責務のため種別条件を持たない。' },
  'openings/openingMove.js': { count: 1, category: 'not-partner-selection',
    reason: 'openingMoveRange。perpendicularWallMaterial が種別を問わずCL上の直交壁材を先に確認する必要が' +
      'あり、種別で絞り込んでからループすると素通りしてしまうため走査APIに畳めない。' },
  'snapGeometry.js': { count: 4, category: 'not-partner-selection',
    reason: 'findCLMoveSnap・findNearestCenterLine・findNearbyCenterLines・findNearestCenterLineEndpoint。' +
      '距離計算を伴う最近傍探索（ポインタ移動毎フレーム呼ばれうる）で、種別判定はisMoveSnapTarget・' +
      'spansEntireAxis・kindFilter経由（ポリシー由来）——候補選定自体は種別ベースだが、ループの走査元' +
      '（graph.centerLines）を毎回filter/sortする走査APIに置き換えると性能上の理由で不利なため、' +
      'ループ内条件だけを種別ベースへ寄せている。nonLabeledClExtentは2026-09-20に' +
      'gridCenterLinesOnAxis（走査API）へ移行しG1から外れた（extentLo/Hi未確定の古いデータのみが' +
      '通る稀な分岐のため性能上の懸念はない）。' },
  'storage/FloorSwapManager.js': { count: 2, category: 'not-partner-selection',
    reason: 'autorun内のdirty追跡（MobX reactionの依存収集）。cl._value/cl.refOffsetを読むためだけに全件を' +
      '辿る——相手選択ではない。' },
  'store.js': { count: 1, category: 'not-partner-selection',
    reason: 'reaction() の依存収集（spatialIndex再構築のトリガー）。' },
  'structural/structuralAutoFill.js': { count: 2, category: 'unmigrated',
    reason: 'beamAxisCenterLines・resolveCLById。木造・構造の自動補完（柱のアンカー解決と共有する述語）。' +
      '種別ベース化は柱の増減に直結するため構造golden（golden13/struct-*）で検証する独立タスク。' },
  'structural/wallBeamAxes.js': { count: 2, category: 'unmigrated',
    reason: 'findWallBeamAxisCL・findBeamAnchorCL。壁交点柱のアンカー解決・梁芯重複ガードが共有する述語' +
      '（centerLineKindPolicy.js冒頭「既知の乖離」節参照）。同上の理由で独立タスク。' },
  'structural/woodAutoFill.js': { count: 3, category: 'unmigrated',
    reason: 'findCenterAnchorCL・nearestAnchorCL・柱直下解決。同上（木造の柱アンカー解決）。' },
  'transform/centerLineExtend.js': { count: 1, category: 'not-partner-selection',
    reason: 'isEndpointAt。refCLが生きて存在するかのid解決（同一参照 or 同id）——相手選択ではない。' },
  'transform/followerGraph.js': { count: 3, category: 'not-partner-selection',
    reason: 'gatherShapes・collectFollowerOffsets候補集め＋gatherShapesの戻り値 `{ centerLines, walls, ' +
      'diagonals }`（shorthandオブジェクトリテラル構築。分割代入検出RE_DESTRUCTURE_CENTERLINESと同じ' +
      'テキスト形のため一緒に数えられる——中身は既にwalk済みのローカル変数を束ねて返すだけで新規の走査' +
      'ではない）。随伴（refId連鎖）はCL種別を問わず辿る規約のため種別で絞らない全件列挙——' +
      'sameDirectionObstacles等の相手選択とは別物。' },
};

// ---- G2: 生の `.labeled` を種別の代用に読む ----
const G2_ALLOWLIST = {
  'finish/gridCells.js': { count: 1, category: 'not-partner-selection',
    reason: 'snapshotCL の labeled: cl.labeled（性能最適化のためのPOJOスナップショットへの生フィールド' +
      'コピーそのもの。isDividerCL・isActiveAcrossRange・gridDividerSegmentsの種別分類自体は' +
      'isFinishCellDivider・isGridCenterLine（centerLineKindPolicy.js/core.js）へ移行済み——' +
      'ステップ6、2026-09-20）。gridDividerSegmentsの全長判定（isGridCenterLine）は、手前の' +
      'isDividerCLを通る入力では新旧の式が常に一致するため挙動テストでは守れず、生フィールド比較の' +
      '再混入は本ガードが検出する。' },
  'structural/wallBeamAxes.js': { count: 1, category: 'unmigrated', reason: 'G1と同じ（findBeamAnchorCL）。' },
  'structural/woodAutoFill.js': { count: 2, category: 'unmigrated', reason: 'G1と同じ（柱アンカー解決）。' },
  'transform/centerLineConvert.js': { count: 2, category: 'not-partner-selection',
    reason: 'promoteToGrid/demoteToCenterのcl.labeled=true/false代入そのもの（昇格・降格操作の定義側）——' +
      '種別の「代用読み取り」ではなくlabeledフィールド自体を変更する操作のため対象外だが、機械的な' +
      '文字列一致では区別できないためallowlistで扱う。cl自身が変換元として妥当かの妥当性ガードは' +
      'isConvertSubject（centerLineKindPolicy.js。core/配下のためG2対象外）へ移行済み。' },
  'transform/centerLineMerge.js': { count: 1, category: 'not-partner-selection',
    reason: 'absorbCenterLine内のloserSnapshot（undo用にloserの状態をそのまま保存するため）。種別判定では' +
      'ない。' },
  'transform/centerLineOps.js': { count: 2, category: 'not-partner-selection',
    reason: 'commitCLMoveOp（!cl.labeledで結合対象=通り芯以外かを判定。呼び出し元が保証する前提は' +
      'centerLineKindPolicy.js冒頭コメント参照）・COEXISTENCE=promote分岐のdeletedProps（既存CLの状態を' +
      'そのままコピーして復元用に保存）。deleteCenterLineWithUndoのisStruct判定はisGridCenterLine' +
      '（core/centerLine.js。core/配下のためG2対象外）へ移行済み。' },
};

// ---- G3: `centerLineKind(x) === '<リテラル>'` インライン種別比較 ----
const G3_ALLOWLIST = {
  'openings/openingMove.js': { count: 1, category: 'not-partner-selection',
    reason: 'candidateTier（スナップ候補の優先順位付け。通り芯を最優先にするUI都合のロジックで、ポリシーの' +
      '関係述語の代替ではない）。' },
  'structural/structuralAutoFill.js': { count: 1, category: 'unmigrated',
    reason: 'beamAxisCenterLines。G1と同じ理由（独立タスク）。' },
  'structural/wallBeamAxes.js': { count: 2, category: 'unmigrated',
    reason: 'findWallBeamAxisCL・findBeamAnchorCL内のcenterLineKind(cl)===\'beam\'。G1と同じ理由。' },
  'structural/woodAutoFill.js': { count: 1, category: 'unmigrated',
    reason: 'findCenterAnchorCL。G1と同じ理由。' },
  'transform/centerLineOps.js': { count: 3, category: 'not-partner-selection',
    reason: 'commitCLMoveOp（centerLineKind(cl)!==\'beam\'／===\'beam\'で通常経路と梁芯専用のグラフ' +
      'スナップショット方式Undoに分岐する対の判定）・COEXISTENCE同種別分岐の梁芯重複ガード' +
      '（centerLineKind(cl)===\'beam\'を含むsameCoordの絞り込み）。それぞれ「kind===梁芯なら専用処理」' +
      'という分岐そのもので、ポリシーの関係述語（例: coexistenceAt）の重複実装ではない。' },
  'ui/circleRef.js': { count: 1, category: 'not-partner-selection',
    reason: 'circleRefKindLabel。参照候補CLの表示ラベル文言（「梁芯」/「中心線」）を決めるUI表示ロジック。' },
};

// ---- G4: 生の `discipline`／`lineType` を比較演算子つきで種別の代用に読む ----
const G4_ALLOWLIST = {
};

// variant: 'codeOnly'（文字列・正規表現の中身も空白化。G1/G2用）または
// 'withoutComments'（文字列はそのまま。G3/G4用）。regexes は複数渡せば合算する（G1の
// RE_CENTERLINES + RE_DESTRUCTURE_CENTERLINES、G4の RE_DISCIPLINE + RE_LINETYPE 用）。
function buildActual(files, regexes, predicate, variant) {
  const list = Array.isArray(regexes) ? regexes : [regexes];
  const actual = {};
  for (const file of files) {
    const rel = relPath(file);
    if (predicate(rel)) continue;
    const { codeOnly, withoutComments } = tokenize(fs.readFileSync(file, 'utf8'));
    const text = variant === 'withoutComments' ? withoutComments : codeOnly;
    const n = list.reduce((sum, re) => sum + countMatches(text, re), 0);
    if (n > 0) actual[rel] = n;
  }
  return actual;
}

function assertAgainstAllowlist(actual, allowlist, label, guidance) {
  const files = new Set([...Object.keys(actual), ...Object.keys(allowlist)]);
  const mismatches = [];
  for (const rel of files) {
    const actualCount = actual[rel] ?? 0;
    const expected = allowlist[rel]?.count ?? 0;
    if (actualCount !== expected) {
      mismatches.push(`  ${rel}: 実際=${actualCount} allowlist=${expected}`);
    }
  }
  assert.deepEqual(mismatches, [], `${label} の件数が allowlist と食い違っています。\n${guidance}\n${mismatches.join('\n')}`);
}

const files = listProductFiles();

test('【ガード G1】app/src 配下の製品コードは graph.centerLines を種別条件なしに直接走査しない（プロパティアクセス・分割代入の両形。許可ドメイン=core/・renderer/・schema/。それ以外は allowlist の件数のみ許可）', () => {
  const actual = buildActual(files, [RE_CENTERLINES, RE_DESTRUCTURE_CENTERLINES], isG1Exempt, 'codeOnly');
  assertAgainstAllowlist(actual, G1_ALLOWLIST, 'G1 (.centerLines / 分割代入)',
    '相手選択（種別ベースで候補を絞る処理）なら centerLineKindPolicy.js の走査API（orthoAnchorCandidates' +
    '(ForNew)・sameDirectionObstacles・sameCoordCounterparts・mergeCandidates・candidatesVisibleIn等。' +
    '無ければ追加）経由に直してください。相手選択でなければ本ファイルの G1_ALLOWLIST に理由付きで追加' +
    'してください。');
});

test('【ガード G2】app/src 配下の製品コードは生の .labeled を種別（centerLineKind）の代用に読まない（許可ドメイン=core/・renderer/・schema/・graphSnapshot.js）', () => {
  const actual = buildActual(files, RE_LABELED, isG2G3Exempt, 'codeOnly');
  assertAgainstAllowlist(actual, G2_ALLOWLIST, 'G2 (.labeled)',
    'centerLineKind(cl) を使ってください（例: centerLineKind(cl)===\'struct\'）。種別判定でない場合' +
    '（undoスナップショット・labeledフィールド自体の代入等）は本ファイルの G2_ALLOWLIST に理由付きで' +
    '追加してください。');
});

test('【ガード G3】app/src 配下の製品コードは centerLineKind(x) === \'<リテラル>\' 形のインライン種別比較を新規に増やさない（変数同士の同値比較は対象外。左右どちらの辺にリテラルが来ても対象。許可ドメインはG2と同じ）', () => {
  const actual = buildActual(files, RE_INLINE_KIND, isG2G3Exempt, 'withoutComments');
  assertAgainstAllowlist(actual, G3_ALLOWLIST, 'G3 (centerLineKind(x)===\'literal\')',
    'centerLineKindPolicy.js の述語（isOpeningBoundaryKind・isRenderTarget・isHitTestTarget・' +
    'coexistenceAt等）で置き換えられないか検討してください。置き換えられない場合は本ファイルの' +
    'G3_ALLOWLIST に理由付きで追加してください。');
});

test('【ガード G4】app/src 配下の製品コードは discipline／lineType の生フィールドを比較演算子つきで種別（centerLineKind）の代用に使わない（代入・コピー等の非比較用途は対象外。許可ドメインはG2と同じ）', () => {
  const actual = buildActual(files, [RE_DISCIPLINE, RE_LINETYPE], isG2G3Exempt, 'withoutComments');
  assertAgainstAllowlist(actual, G4_ALLOWLIST, 'G4 (discipline/lineType生比較)',
    'centerLineKind(cl) を使ってください（例: centerLineKind(cl)===\'struct\'）。種別判定でない場合' +
    '（代入・コピー等はそもそも比較演算子を伴わないため本ガードの対象外）は本ファイルの G4_ALLOWLIST ' +
    'に理由付きで追加してください。');
});

test('【ガード自己診断】G3・G4 の検出正規表現が意図した形だけに一致する', () => {
  // countMatches は String.prototype.match を使う——global正規表現でも毎回lastIndex=0から
  // 走査し直すため（match()自体の仕様）、同じ正規表現オブジェクトを使い回しても持ち越しは無い
  // （test()と違い安全。QA指摘m-3）。
  const ALL_G3G4_REGEXES = [RE_INLINE_KIND, RE_DISCIPLINE, RE_LINETYPE];
  const totalMatches = (s) => ALL_G3G4_REGEXES.reduce((sum, re) => sum + countMatches(s, re), 0);

  // 一致すべき形（各1件）。
  const shouldMatchOnce = [
    "centerLineKind(cl) !== 'beam'",           // G3: !==（M-1前は===のみだった）
    "'beam' === centerLineKind(cl)",           // G3: リテラル左辺
    'cl.discipline === Discipline.STRUCT',     // G4: discipline×定数
    'Discipline.FUSE !== a.b.discipline',      // G4: discipline×定数・リテラル左辺・!==
    "cl.discipline === 'struct'",              // G4: discipline×生文字列リテラル（QA指摘M-1の抜け道）
    "cl?.lineType === 'center'",               // G4: lineType（オプショナルチェイニング経由でも一致）
    'cl.discipline\n  !== Discipline.ARCH',    // G4: 改行をまたぐ比較（\sは改行も含むため一致する）
  ];
  for (const s of shouldMatchOnce) {
    assert.equal(totalMatches(s), 1, `一致すべき形が一致しない: ${JSON.stringify(s)}`);
  }

  // 一致してはいけない形（各0件）。
  const shouldNotMatch = [
    'cl.discipline = Discipline.STRUCT',   // 代入（比較演算子ではない）
    '{ discipline: cl.discipline }',       // オブジェクトリテラルのコピー
    'cl => cl.discipline',                 // アロー関数本体（比較を伴わない参照のみ）
    'centerLineKind(cl) === kind',         // 右辺が変数（リテラルではない同値比較）
  ];
  for (const s of shouldNotMatch) {
    assert.equal(totalMatches(s), 0, `一致してはいけない形が一致した: ${JSON.stringify(s)}`);
  }
});

test('【ガード自己診断】allowlist の全エントリは category が既定の2種のいずれかで、reason が空でない', () => {
  for (const [name, table] of [['G1', G1_ALLOWLIST], ['G2', G2_ALLOWLIST], ['G3', G3_ALLOWLIST], ['G4', G4_ALLOWLIST]]) {
    for (const [rel, entry] of Object.entries(table)) {
      assert.ok(['not-partner-selection', 'unmigrated'].includes(entry.category), `${name} ${rel}: 未知のcategory`);
      assert.ok(entry.reason && entry.reason.length > 0, `${name} ${rel}: reasonが空`);
      assert.ok(entry.count > 0, `${name} ${rel}: countは1以上のはず（0件ならallowlistから削除する）`);
    }
  }
});
