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
// G5: 同座標の線から相手を選ぶ入口の固定（限界16 (i)、2026-10-27）。他階の対応する線を「座標だけ」で
//     探していたため、梁芯が中心線の代わりに選ばれた不良（課題(i) i1）の再発防止。
//     G5a: `sameCoordCounterparts(` の呼び出し（種別を問わず同座標の線を全部返す走査API）を、製品コード
//          （許可ドメイン=core/。定義側）ではファイルごとの件数で固定する。呼び出し側は戻り値から
//          「どの種別をどう選ぶか」を自分で決めるため、新しい呼び出しが増えたら種別の扱いを理由欄に
//          書いて足す（category 'caller-chooses-kind'）。
//     G5b: 種別を見ない `findCounterpartCL(` の呼び出し（定義 `function findCounterpartCL(` は数えない）を
//          finish/floorCLMap.js の2件に固定し、他ファイルは0。他階の対応する線は findCounterpartForCL
//          （同種別）を使う。
//     どちらも codeOnly で数える（コメント・文字列の中の語は数えない）。数えるのは「識別子の出現」
//     （`\b名前\b`。import 行・呼び出し・値としての参照・`P.名前(` のすべて。`function 名前` の定義は除く、
//     別名の識別子 `名前Foo`・`my名前`・findCounterpartForCL は `\b` で一致しない）。呼び出し形だけを
//     数えると `import { 名前 as f }` して f() を呼ぶ・`const f = 名前` する形ですり抜けるため。import 別名・
//     値としての受け渡しも件数が変わって赤になる（件数は import 行を含む）。
//     残る限界: (1) 登録済みファイルが包み関数を新たに export して他ファイルから呼ばれる経路（件数は
//     変わらない）。(2) 許可ドメイン core/ の除外（G5a。core/ 内の新しい使い方は数えない）。
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

// テスト専用ヘルパ（*.test.js から import されるだけで製品には載らない）。本ガードの対象は製品コード
// なので走査から外す（ユーザー裁定2026-09-22。allowlist に載せると、フィクスチャを直すたびに件数の
// 調整が要りラチェットの意味が薄れる）。**ファイル名パターンではなく明示列挙にする**——将来
// 「…Fixtures.js」という名前の製品モジュールが現れても、黙って対象外にならないようにするため。
// ここへ足すときは、そのファイルを製品コード（非 *.test.js）が import していないことを確かめること
// （下の「テスト専用ヘルパ」テストが機械的に確かめる）。
const TEST_ONLY_HELPERS = new Set([
  'structural/memberTestFixtures.js',
  'structural/structuralOrchestrationFixtures.js',
]);

const relFromSrc = (full) => path.relative(SRC_ROOT, full).split(path.sep).join('/');

function listProductFiles(dir = SRC_ROOT, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      listProductFiles(full, out);
    } else if (/\.(js|jsx)$/.test(ent.name) && !ent.name.endsWith('.test.js') && !TEST_ONLY_HELPERS.has(relFromSrc(full))) {
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
// graphList(graph, 'centerLines')（graphReadScope.js。読み取りスコープ内キャッシュ経由の CL 全件列挙）。`.centerLines` の
// プロパティアクセスを経由しないため RE_CENTERLINES を素通りする（QA S8a Blocker 3）。文字列リテラル 'centerLines' を
// 見るので withoutComments 側で数える。
const RE_GRAPHLIST_CENTERLINES = /graphList\([^)]*['"]centerLines['"]\)/g;
const RE_LABELED       = /\.labeled\b/g;
// centerLineKind(x) <op> 'kind' は左右どちらの辺にリテラルが来てもよい形に対応する
// （op = ===/!==/==/!=。`[!=]==?` は「!か=」+「=」+「省略可能な=」の3要素で4通りの演算子を
// 1本の文字クラスで拾う——例: '===' は '='(class)+'='(必須)+'='(任意)、'!=' は '!'(class)+'='(必須)）。
const RE_INLINE_KIND   =
  /centerLineKind\([^)]*\)\s*[!=]==?\s*'(?:struct|center|aux|beam|ceiling)'|'(?:struct|center|aux|beam|ceiling)'\s*[!=]==?\s*centerLineKind\([^)]*\)/g;
// G4: `.discipline`／`.lineType` を比較演算子つきで使う形のみ対象（代入・コピーは対象外）。
// 定数側（Discipline.<定数> / 文字列リテラル。'・"どちらも）は比較の左右どちらの辺に来てもよい。
// Discipline.<定数>は core/constants.js で素の文字列（'arch'/'struct'/'fuse'…）のため、
// `cl.discipline === Discipline.STRUCT` と `cl.discipline === 'struct'` は等価な抜け道——
// 両方を1本の選択（Discipline.\w+|'...'|"..."）で拾う（QA指摘M-1）。
const RE_DISCIPLINE    =
  /\.discipline\s*[!=]==?\s*(?:Discipline\.\w+|'[^'\n]*'|"[^"\n]*")|(?:Discipline\.\w+|'[^'\n]*'|"[^"\n]*")\s*[!=]==?\s*[\w$]+(?:\.[\w$]+)*\.discipline/g;
const RE_LINETYPE      =
  /\.lineType\s*[!=]==?\s*(?:'[^'\n]*'|"[^"\n]*")|(?:'[^'\n]*'|"[^"\n]*")\s*[!=]==?\s*[\w$]+(?:\.[\w$]+)*\.lineType/g;

// G5: 識別子の出現を数える（import 行・呼び出し・値としての参照・`P.name(` のすべて。`function ` 直後の
// 定義だけ除く）。`\b` で別名（sameCoordCounterpartsFoo・myFindCounterpartCL・findCounterpartForCL）は除く。
// 呼び出し形だけを数えると `import { findCounterpartCL as f }` して f() を呼ぶ形ですり抜けるため。
const RE_SAME_COORD_CALL = /(?<!function\s+)\bsameCoordCounterparts\b/g;
const RE_FIND_COUNTERPART_CL_CALL = /(?<!function\s+)\bfindCounterpartCL\b/g;

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
// G5a 許可ドメイン: core/（sameCoordCounterparts の定義側）だけ。G5b は許可ドメインなし（定義は数えない）。
function isG5aExempt(rel) {
  return isUnderRoot(rel, 'core');
}
const isG5bExempt = () => false;

// ================================================================
// allowlist（残課題の台帳）
// ================================================================
// 区分:
//   'not-partner-selection' — 相手選択（種別ベースで候補を絞る処理）ではない
//                              （シリアライズ・id解決・全件列挙・reactionの依存収集・幾何署名判定等）。
//   'unmigrated'             — 相手選択だが、既存ロジックへの手入れが波及大のため本ステップでは
//                              未移行（別タスクで種別ベースへ統一する）。
//   'caller-chooses-kind'    — G5 専用。相手選択そのもの（同座標の線のうち何を相手にするかを呼び出し側が
//                              決める）で、種別の扱い（絞り込み・優先順・全種別を対象にする等）を
//                              呼び出し側のコードで決めている。reason に「何をどう選ぶか」を書くこと。

// ---- G1: `.centerLines` 直接参照 ----
const G1_ALLOWLIST = {
  'finish/stair/stairUnderSplit.js': { count: 1, category: 'not-partner-selection',
    reason: 'findUnderStairSplitCLs（graph.centerLines走査）→isSplitCLForによる同定。種別条件は' +
      'isUnderStairSplitKind（core/centerLineKindPolicy.js。UNDER_STAIR_SPLIT_KINDS）へ移行済み' +
      '（ステップ6、2026-09-20）——残る絞り込みは幾何署名（外形内を横切り、extentが外形の直交範囲と' +
      '一致する）による同定で、既存の走査API（orthoAnchorCandidates等）が扱う「同座標・同方向・' +
      '可視種別」の形に合わないため、走査API化は対象外（相手選択ではなく幾何署名判定）。' },
  'finish/floorCLMap.js': { count: 4, category: 'not-partner-selection',
    reason: 'mergeAdjacentDividers（snapshot.centerLines。保存形式の中間オブジェクトから、id で指定された' +
      '接する2本の中心線のエントリを引いて1本に結合する）。相手は呼び出し元が種別・座標で選び済み' +
      '（sameCoordCounterparts経由）のid指定で、ここでの走査は相手選択ではない。' },
  'plan/planSolidsLayerFilter.js': { count: 1, category: 'not-partner-selection',
    reason: 'isCenterLineDragging（全 CL の pendingDelta が 0 でないかの真偽。平面の断面解決レイヤが通り芯ドラッグ中は' +
      '前回の線を描き続けるための判定）。相手の選択ではなく、種別を問わず「どれかがドラッグ中か」を見るだけ。' },
  'graphSnapshot.js': { count: 2, category: 'not-partner-selection',
    reason: 'restoreStructCLs/applySnapshot。永続化からの全件復元（snapshot.centerLines）——種別を問わず' +
      '全件を作り直す責務のため種別条件を持たない。' },
  'lineIdRemap.js': { count: 1, category: 'not-partner-selection',
    reason: 'makeFreshLineIdMap（snapshot.centerLines）。線idの列挙のための走査で、相手選択ではない。' },
  'lineIdUniqueness.js': { count: 2, category: 'not-partner-selection',
    reason: 'lineIdsOfSnapshot（snapshot.centerLines）・scanProjectLineIds（project.structGraph.centerLines）。' +
      'いずれも線idの列挙のための走査で、相手選択ではない。' },
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
  'structural/structuralAutoFill.js': { count: 1, category: 'not-partner-selection',
    reason: 'resolveCLById。landingEdgeCLsが返すCL id文字列（踊り場外周の境界壁。階固有CL・通り芯CLの' +
      'どちらもあり得る）から実CLオブジェクトを引くid解決——種別を問わず全件から同一idを探すため' +
      '相手選択ではない。beamAxisCenterLinesはcore/centerLineKindPolicy.jsへ委譲済み（ステップ7、' +
      '2026-09-20）。' },
  'transform/centerLineExtend.js': { count: 1, category: 'not-partner-selection',
    reason: 'isEndpointAt。refCLが生きて存在するかのid解決（同一参照 or 同id）——相手選択ではない。' },
  'transform/centerLineFloorSync.js': { count: 1, category: 'not-partner-selection',
    reason: 'applyCenterLineAbsorptionOnPromote内、復号後のsnapshot.centerLines（保存形式の中間オブジェクト。' +
      'graphインスタンスではない）から吸収する中心線のエントリを除くための走査——lineIdRemap.js' +
      'makeFreshLineIdMapと同じ「snapshot.centerLinesの列挙」であり、種別条件のない全件操作（相手選択ではない）。' },
  // 以下5件は graphList(graph, 'centerLines')（読み取りスコープ経由の全件列挙）。RE_GRAPHLIST_CENTERLINES で数える。
  'elevation/elevationFloorProfile.js': { count: 1, category: 'not-partner-selection',
    reason: 'findRunCLAt。value 一致の最初を返す走査——種別条件あり（天井芯 isCeilingOnlyKind を除外済み。同座標の天井芯が先に並んでも中心線を返す回帰テストあり）。' },
  'elevation/space/zoneCeiling.js': { count: 1, category: 'not-partner-selection',
    reason: 'parallelCLAt（zoneCeilingFarEdge）。傾斜の面の奥の端の座標に立つ面と平行な CL を value 一致で探す走査——種別条件あり（天井芯 isCeilingOnlyKind を除外済み。findRunCLAt と同じ除外。elevationFloorProfile.js は本モジュールを import するため循環を避けて同型を持つ。回帰テストあり）。' },
  'elevation/section/cuts/switchbackCuts.js': { count: 1, category: 'not-partner-selection',
    reason: 'midCL（往復間の壁が無いときの同位置の中心線）の探索。許容差内の最初の CL——種別条件あり（天井芯 isCeilingOnlyKind を除外済み。回帰テストあり）。' },
  'elevation/elevationPrimitives.js': { count: 1, category: 'not-partner-selection',
    reason: 'collectGridCLs。isGridCenterLine（通り芯だけ）で絞る——種別条件あり（天井芯は通り芯でないので入らない）。' },
  'finish/gridCells.js': { count: 1, category: 'not-partner-selection',
    reason: 'buildGridIndex。格子索引の構築——分割線の判定は grid.isDivider（変種ごとの種別ポリシー）、allXValues/allYValues は天井芯除外済み、clById は id 解決のみ。`all` も天井芯を含むが buildGridIndex 内部のみ（外部から読まれない）。' },
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
  'transform/centerLineConvert.js': { count: 2, category: 'not-partner-selection',
    reason: 'promoteToGrid/demoteToCenterのcl.labeled=true/false代入そのもの（昇格・降格操作の定義側）——' +
      '種別の「代用読み取り」ではなくlabeledフィールド自体を変更する操作のため対象外だが、機械的な' +
      '文字列一致では区別できないためallowlistで扱う。cl自身が変換元として妥当かの妥当性ガードは' +
      'isConvertSubject（centerLineKindPolicy.js。core/配下のためG2対象外）へ移行済み。' },
  'transform/centerLineMerge.js': { count: 1, category: 'not-partner-selection',
    reason: 'absorbCenterLine内のloserSnapshot（undo用にloserの状態をそのまま保存するため）。種別判定では' +
      'ない。' },
  'structural/wallBeamAxisFollow.js': { count: 1, category: 'not-partner-selection',
    reason: 'snapshotForRestore内（案B・2026-09-26。追従先に既存の梁芯・通り芯があり保護されない旧梁芯を' +
      '吸収撤去する前に、undo用にそのCLの状態をそのまま保存するため——centerLineMerge.jsの' +
      'absorbCenterLine loserSnapshotと同じ手法・同じ理由。種別判定ではない。' },
  'transform/centerLineOps.js': { count: 1, category: 'not-partner-selection',
    reason: 'commitCLMoveOp（!cl.labeledで結合対象=通り芯以外かを判定。呼び出し元が保証する前提は' +
      'centerLineKindPolicy.js冒頭コメント参照）。deleteCenterLineWithUndoのisStruct判定はisGridCenterLine' +
      '（core/centerLine.js。core/配下のためG2対象外）へ移行済み。COEXISTENCE=promote分岐は' +
      'promoteCenterToGridWithUndoへの委譲に統一され、deletedPropsのコピーは無くなった' +
      '（線種変更の移籍一本化 ステップ5・2026-09-30）。' },
};

// ---- G3: `centerLineKind(x) === '<リテラル>'` インライン種別比較 ----
const G3_ALLOWLIST = {
  'openings/openingMove.js': { count: 1, category: 'not-partner-selection',
    reason: 'candidateTier（スナップ候補の優先順位付け。通り芯を最優先にするUI都合のロジックで、ポリシーの' +
      '関係述語の代替ではない）。' },
  'transform/centerLineOps.js': { count: 2, category: 'not-partner-selection',
    reason: 'commitCLMoveOp（centerLineKind(cl)!==\'beam\'／===\'beam\'で通常経路と梁芯専用のグラフ' +
      'スナップショット方式Undoに分岐する対の判定）。それぞれ「kind===梁芯なら専用処理」' +
      'という分岐そのもので、ポリシーの関係述語（例: coexistenceAt）の重複実装ではない。' +
      '（線種変更の移籍一本化・ステップ6・2026-09-30: COEXISTENCE同種別分岐の梁芯重複ガード' +
      '（sameCoord.some(cl=>centerLineKind(cl)===\'beam\')）は、struct追加時の梁芯拒否を' +
      'addGridLinesWithFloorAbsorptionの吸収判定へ置き換えたことで削除し、3件→2件になった。）' },
};

// ---- G4: 生の `discipline`／`lineType` を比較演算子つきで種別の代用に読む ----
const G4_ALLOWLIST = {
};

// ---- G5a: `sameCoordCounterparts(` の呼び出し（core/ を除く） ----
const G5A_ALLOWLIST = {
  'transform/centerLineOps.js': { count: 4, category: 'caller-chooses-kind',
    reason: '件数は import 行を含む識別子の出現数（import 1＋呼び出し3）。commitCLMoveOp 通り芯の移動の重複ガード' +
      '（同座標のうち isGridCenterLine＝通り芯だけを相手にし、動かす線が通り芯のときだけ拒否。exclude で自分自身を除く）。' +
      ':1444 スパン配列の通り芯追加の重複除外（includeCeilingOnly 既定=false で天井芯は除くが、' +
      '残りは種別を問わず1本でもあれば同座標とみなしてその値を飛ばす＝全種別が相手）。' +
      ':1594 単体追加の重複判定（includeCeilingOnly:true。同座標の全種別を取り、同種別を先に、無ければ' +
      'CL_KINDS の優先順で existing を1本選ぶ。梁芯ガードは全件に対して coexistenceAt で判定）。' },
  'transform/centerLineFloorSync.js': { count: 3, category: 'caller-chooses-kind',
    reason: '件数は import 行を含む識別子の出現数（import 1＋呼び出し2）。:97 findFloorsWithCounterpartCL（他階の peek グラフで同座標を取り、CROSS_FLOOR_COUNTERPART_KINDS ' +
      'に含まれる種別だけに絞って、吸収可能な梁芯・昇格で吸収される種別を除く＝種別は呼び出し側のフィルタで決める）。' +
      ':733 findCenterLinesToAbsorbForValues（他階の同座標から isPromoteAbsorbedKind の種別＝吸収される中心線' +
      'だけを id で拾う）。' },
  'transform/centerLineConvert.js': { count: 3, category: 'caller-chooses-kind',
    reason: '件数は import 行を含む識別子の出現数（import 1＋呼び出し2）。:166 昇格ガード（convertBlockingKinds(\'promote\') の各種別ごとに、struct は structGraph・それ以外は' +
      '階グラフを走査し、同座標のうちその種別（梁芯は保護されないものを除く）が1本でもあれば拒否）。' +
      ':244 降格ガード（階グラフの同座標を取り、convertBlockingKinds(\'demote\') の並び順＝中心線＞補助線で' +
      '最初に見つかった種別を障害物とする。exclude で自分自身を除く）。' },
  'finish/floorCLMap.js': { count: 6, category: 'caller-chooses-kind',
    reason: '件数は import 行を含む識別子の出現数（import 1＋呼び出し5）。:55 findCounterpartCL 本体（種別を見ない。predicate 省略時は同座標の先頭＝G5b で呼び出しを固定）。' +
      ':72 findCounterpartForCL 本体（同座標のうち isFloorClMapCounterpart＝同じ種別だけに絞り、範囲の' +
      '重なりを優先して1本選ぶ＝種別ベースの正規の入口）。:238 セルキー辺の置換（同座標のうち' +
      'isFinishCellDivider かつ辺を覆う分割線を探す）。:251 extendOneEdge（同座標の有無の確認と、' +
      'isFinishCellDivider の分割線だけを延長対象にする）。:266 同関数の延長ループ（同座標の分割線ピースだけ' +
      'を引き直す）。' },
  'finish/stair/stairPartitionWalls.js': { count: 2, category: 'caller-chooses-kind',
    reason: '件数は import 行を含む識別子の出現数（import 1＋呼び出し1）。:41 findDividerCL（同座標のうち isFinishCellDivider の分割線だけに絞り、coverCoords をすべて' +
      '軸方向に覆う先頭の1本を返す）。' },
};

// ---- G5b: 種別を見ない `findCounterpartCL(` の呼び出し（定義は数えない） ----
const G5B_ALLOWLIST = {
  'finish/floorCLMap.js': { count: 2, category: 'caller-chooses-kind',
    reason: '件数は識別子の出現数（定義は除く。同ファイル内なので import 行は無く呼び出し2）。:136 translateCellKeyId（セルキーの例外＝2026-10-27 ユーザー裁定 案A。同種別が無いときだけ同座標の' +
      '線へ写す。null だと上階の同座標に梁芯・補助線しか無い階段の足元が写らず吹抜けが置かれない）。' +
      ':342 addMissingCLs の「対応先あり」判定（isCounterpart 省略時は種別を問わず先頭を対応先とみなす。' +
      'U4 で据え置き＝階段の既存挙動を変えない。昇降機の経路は isFinishCellDivider を渡す）。' },
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
  // graphList(graph, 'centerLines') 経由の列挙も同じ allowlist で数える（文字列リテラルを見るので withoutComments）
  const viaGraphList = buildActual(files, RE_GRAPHLIST_CENTERLINES, isG1Exempt, 'withoutComments');
  for (const [rel, n] of Object.entries(viaGraphList)) actual[rel] = (actual[rel] ?? 0) + n;
  assertAgainstAllowlist(actual, G1_ALLOWLIST, "G1 (.centerLines / 分割代入 / graphList 'centerLines')",
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

test('【ガード G5a】app/src 配下の製品コードは sameCoordCounterparts( の呼び出しを増やさない（許可ドメイン=core/。それ以外は allowlist の件数のみ許可。種別の扱いは reason に書く）', () => {
  const actual = buildActual(files, RE_SAME_COORD_CALL, isG5aExempt, 'codeOnly');
  assertAgainstAllowlist(actual, G5A_ALLOWLIST, 'G5a (sameCoordCounterparts( の呼び出し)',
    'sameCoordCounterparts は種別を問わず同座標の線を全部返す。他階の対応する線を探すなら ' +
    'findCounterpartForCL（finish/floorCLMap.js。同種別だけ）を使ってください。それ以外の相手選択で' +
    '本当に必要なら、呼び出し側で種別をどう扱うか（絞り込み・優先順・全種別を対象）を reason に書いて、' +
    '本ファイルの G5A_ALLOWLIST に追加してください。');
});

test('【ガード G5b】種別を見ない findCounterpartCL( の呼び出しは finish/floorCLMap.js の2件（セルキーの例外・addMissingCLs の対応先あり判定）だけ。定義は数えない', () => {
  const actual = buildActual(files, RE_FIND_COUNTERPART_CL_CALL, isG5bExempt, 'codeOnly');
  assertAgainstAllowlist(actual, G5B_ALLOWLIST, 'G5b (findCounterpartCL( の呼び出し)',
    '他階の対応する線は findCounterpartForCL（同種別。finish/floorCLMap.js）を使ってください。' +
    'findCounterpartCL は種別を見ず、同座標に梁芯が先に並ぶと中心線の代わりに選ぶ（課題(i)・限界16 (i)）。');
});

test('【ガード自己診断】G5 の検出正規表現が識別子の出現（import・呼び出し・値参照）に一致し、定義・コメント・文字列・別名には一致しない', () => {
  const callsIn = (src, re) => countMatches(tokenize(src).codeOnly, re);
  const cases = [
    [RE_SAME_COORD_CALL, 'sameCoordCounterparts', 'sameCoordCounterpartsFoo'],
    [RE_FIND_COUNTERPART_CL_CALL, 'findCounterpartCL', 'myFindCounterpartCL'],
  ];
  for (const [re, name, alias] of cases) {
    // 一致すべき形（各1件）
    assert.equal(callsIn(`import { ${name} as f } from './floorCLMap.js';`, re), 1, `${name}: import 別名に一致しない`);
    assert.equal(callsIn(`const f = ${name};`, re), 1, `${name}: 値としての参照に一致しない`);
    assert.equal(callsIn(`P.${name}(g)`, re), 1, `${name}: P.name( に一致しない`);
    assert.equal(callsIn(`const a = ${name}(g, {});`, re), 1, `${name}: 呼び出しに一致しない`);
    assert.equal(callsIn(`const a = ${name} (g);`, re), 1, `${name}: 空白つきの呼び出しに一致しない`);
    assert.equal(callsIn(`x.filter(c => ${name}(c))`, re), 1, `${name}: 式中の呼び出しに一致しない`);
    // 一致してはいけない形（各0件）
    assert.equal(callsIn(`export function ${name}(g, v) {}`, re), 0, `${name}: export 定義に一致した`);
    assert.equal(callsIn(`function ${name}(g, v) {}`, re), 0, `${name}: 定義に一致した`);
    assert.equal(callsIn(`// ${name}(g) を使う`, re), 0, `${name}: 行コメント内に一致した`);
    assert.equal(callsIn(`/* ${name}(g) */`, re), 0, `${name}: ブロックコメント内に一致した`);
    assert.equal(callsIn(`const s = '${name}(g)';`, re), 0, `${name}: 文字列内に一致した`);
    assert.equal(callsIn(`const s = \`${name}(g)\`;`, re), 0, `${name}: テンプレートリテラル内に一致した`);
    assert.equal(callsIn(`${alias}(g)`, re), 0, `${alias}: 別名に一致した`);
    assert.equal(callsIn(`${alias}`, re), 0, `${alias}: 別名の識別子（呼び出し形でなくても）に一致した`);
  }
  // findCounterpartForCL（同種別の正規の入口）は G5b の対象外
  assert.equal(callsIn('findCounterpartForCL(g, cl)', RE_FIND_COUNTERPART_CL_CALL), 0);
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
    "centerLineKind(cl) === 'ceiling'",        // G3: 天井芯（S8a）
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
  // G1 の graphList 形
  assert.equal(countMatches("(graphList(graph, 'centerLines') ?? [])", RE_GRAPHLIST_CENTERLINES), 1);
  assert.equal(countMatches('(graphList(graph, "centerLines") ?? [])', RE_GRAPHLIST_CENTERLINES), 1, 'ダブルクォートも当たる');
  assert.equal(countMatches("graphList(wallGraph, 'walls')", RE_GRAPHLIST_CENTERLINES), 0);
});

test('【ガード自己診断】allowlist の全エントリは category が既定の3種のいずれかで、reason が空でない', () => {
  const tables = [['G1', G1_ALLOWLIST], ['G2', G2_ALLOWLIST], ['G3', G3_ALLOWLIST], ['G4', G4_ALLOWLIST],
    ['G5a', G5A_ALLOWLIST], ['G5b', G5B_ALLOWLIST]];
  for (const [name, table] of tables) {
    for (const [rel, entry] of Object.entries(table)) {
      assert.ok(['not-partner-selection', 'unmigrated', 'caller-chooses-kind'].includes(entry.category), `${name} ${rel}: 未知のcategory`);
      assert.ok(entry.reason && entry.reason.length > 0, `${name} ${rel}: reasonが空`);
      assert.ok(entry.count > 0, `${name} ${rel}: countは1以上のはず（0件ならallowlistから削除する）`);
    }
  }
});

// 走査から外した「テスト専用ヘルパ」が本当にテスト専用であること——製品コードが import していたら、
// そのファイルは製品に載るので本ガードの対象に戻さなければならない（除外リストが抜け穴にならないための固定）。
test('【ガード自己診断】TEST_ONLY_HELPERS は実在し、製品コード（非 *.test.js）から import されていない', () => {
  const productFiles = listProductFiles();
  for (const rel of TEST_ONLY_HELPERS) {
    assert.ok(fs.existsSync(path.join(SRC_ROOT, rel)), `${rel}: 除外リストにあるが実在しない（リネーム・削除したらリストも直す）`);
    const base = path.basename(rel, '.js');
    const importers = productFiles.filter(f => new RegExp(`from\\s+['"][^'"]*/${base}(\\.js)?['"]`).test(fs.readFileSync(f, 'utf8')));
    assert.deepEqual(importers.map(relFromSrc), [], `${rel}: 製品コードが import している＝テスト専用ではない。除外リストから外して本ガードの対象へ戻すこと`);
  }
});
