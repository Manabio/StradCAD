// openings/slideOutset.js の openingCutSpan・outsetSlideLayout は host（ホスト壁）の既定が null で、渡し忘れると
// 外壁でも黙って外付けになる（R12 の外壁制限が抜ける）。消費側（テスト以外のソース）の全呼び出しが
// 3 引数（opening, mechanism, host）で呼んでいることをソース走査で固定する。
// 行頭コメント（//・*・/*）は除外する（team-lessons「配線テストをコメント文に一致させない」）。
// 呼び出しは複数行にまたがりうるので、開き括弧から対応する閉じ括弧までを取って、括弧・波括弧・角括弧の外側のカンマで引数を数える。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const SRC = path.resolve(import.meta.dirname, '..');
const HOST_AWARE = ['openingCutSpan', 'outsetSlideLayout'];
const EXPECTED_ARGS = 3;

function sourceFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === 'node_modules' ? [] : sourceFiles(p);
    return /\.(js|jsx)$/.test(e.name) && !/\.test\.js$/.test(e.name) ? [p] : [];
  });
}

function stripComments(text) {
  return text.split(/\r?\n/)
    .map(line => (line.trim().startsWith('//') || line.trim().startsWith('*') || line.trim().startsWith('/*') ? '' : line))
    .join('\n');
}

/** code 中の `name(` の呼び出し（関数定義 `function name(` を除く）ごとに引数の個数を返す。 */
function callArities(code, name) {
  const result = [];
  const re = new RegExp(`(?<![\\w.])${name}\\(`, 'g');
  for (let m = re.exec(code); m; m = re.exec(code)) {
    if (/function\s+$/.test(code.slice(0, m.index))) continue;
    let depth = 1, args = 0, hasToken = false, last = '', i = m.index + m[0].length;
    for (; i < code.length && depth > 0; i += 1) {
      const c = code[i];
      if ('([{'.includes(c)) { depth += 1; hasToken = true; } else if (')]}'.includes(c)) {
        depth -= 1;
        if (depth === 0) { if (last === ',') args -= 1; break; } // 末尾カンマは引数に数えない
      } else if (c === ',' && depth === 1) args += 1;
      else if (!/\s/.test(c)) hasToken = true;
      if (!/\s/.test(c)) last = c;
    }
    result.push(hasToken ? args + 1 : 0);
  }
  return result;
}

test('【配線】openingCutSpan・outsetSlideLayout の消費側の全呼び出しが host を渡している（3 引数）', () => {
  const found = { openingCutSpan: 0, outsetSlideLayout: 0 };
  for (const file of sourceFiles(SRC)) {
    const code = stripComments(fs.readFileSync(file, 'utf8'));
    for (const name of HOST_AWARE) {
      for (const n of callArities(code, name)) {
        found[name] += 1;
        assert.equal(n, EXPECTED_ARGS, `${path.relative(SRC, file)} の ${name}( が ${n} 引数（host を渡していない）`);
      }
    }
  }
  assert.ok(found.openingCutSpan >= 1, '前提: openingCutSpan の消費側（renderer/wallDrawPlan.js）が見つかるはず');
  assert.ok(found.outsetSlideLayout >= 1, '前提: outsetSlideLayout の呼び出し（slideOutset.js 内の openingCutSpan）が見つかるはず');
});

test('【配線】renderer/wallDrawPlan.js は openingCutSpan を host（壁）付きで呼ぶ', () => {
  const code = stripComments(fs.readFileSync(path.join(SRC, 'renderer', 'wallDrawPlan.js'), 'utf8'));
  assert.deepEqual(callArities(code, 'openingCutSpan'), [EXPECTED_ARGS]);
  assert.ok(/openingCutSpan\(o,\s*mechanismOf\(o\),\s*hostOf\(o\)\)/.test(code), 'host に実ホスト壁（hostOf）を渡していない');
  assert.ok(/findHostWallIndexed\(o,\s*wallIndex\)/.test(code), 'hostOf が findHostWallIndexed でない（描いている壁を host にしてはいけない）');
});

test('【配線】slideRecessBand の消費側の全呼び出しが、実ホスト壁（hostOf）の wallFaceRange を面範囲に渡す', () => {
  let found = 0;
  for (const file of sourceFiles(SRC)) {
    const code = stripComments(fs.readFileSync(file, 'utf8'));
    for (const m of code.matchAll(/(?<![\w.])slideRecessBand\(([^;]*)/g)) {
      if (/function\s+$/.test(code.slice(0, m.index))) continue;
      found += 1;
      // 唯一の例外: 純モジュール openingPlanSymbol.js は ctx の faceLo/faceHi（OpeningsLayer が実ホスト壁の wallFaceRange で渡す。下で配線を固定）から作った faceRange を渡す。
      const viaCtx = path.basename(file) === 'openingPlanSymbol.js' && /^\s*layout\.recess,\s*faceRange\)/.test(m[1]);
      assert.ok(viaCtx || /^\s*layout\.recess,\s*wallFaceRange\(host,\s*graph\)\)/.test(m[1]),
        `${path.relative(SRC, file)} の slideRecessBand( が wallFaceRange(host, graph) を渡していない: ${m[1].slice(0, 80)}`);
    }
  }
  assert.equal(found, 2, '前提: 消費側は renderer/wallDrawPlan.js と openings/openingPlanSymbol.js の 2 か所');
  const layer = stripComments(fs.readFileSync(path.join(SRC, 'renderer', 'OpeningsLayer.jsx'), 'utf8'));
  assert.ok(/faceRangeByHostId\.get\(host\.id\) \?\? wallFaceRange\(host, graph\)/.test(layer), 'OpeningsLayer の faceLo/faceHi が実ホスト壁の wallFaceRange でない');
  assert.ok(/const host = hostByOpening\.get\(opening\.id\)/.test(layer), 'OpeningsLayer の host が hostByOpening でない');
  const code = stripComments(fs.readFileSync(path.join(SRC, 'renderer', 'wallDrawPlan.js'), 'utf8'));
  assert.ok(/const host = hostOf\(o\);/.test(code), 'host が実ホスト壁（hostOf）でない（描いている壁を使ってはいけない）');
  assert.ok(/import \{[^}]*wallFaceRange[^}]*\} from '\.\.\/openings\/openingGeometry\.js'/.test(code), 'wallFaceRange は openingGeometry.js のものを使う');
});

// S3c: 判定関数の footprintOf／extraHalf は既定値（開口幅）を持つので、渡し忘れると黙って外付け引き戸が W で判定される。
// 消費側（テスト以外のソース）の全呼び出しが、引数を全部渡していることをソース走査で固定する。
const FOOTPRINT_AWARE = { validateOpeningPlacement: 6, maxOpeningWidthAt: 6, openingMoveRange: 5, openingSnapCandidates: 5 };

test('【配線】S3c: validateOpeningPlacement・maxOpeningWidthAt・openingMoveRange・openingSnapCandidates の全呼び出しが footprintOf／extra を渡している', () => {
  const found = Object.fromEntries(Object.keys(FOOTPRINT_AWARE).map(k => [k, 0]));
  for (const file of sourceFiles(SRC)) {
    const code = stripComments(fs.readFileSync(file, 'utf8'));
    for (const [name, expected] of Object.entries(FOOTPRINT_AWARE)) {
      for (const n of callArities(code, name)) {
        found[name] += 1;
        assert.equal(n, expected, `${path.relative(SRC, file)} の ${name}( が ${n} 引数（footprintOf／extra の渡し忘れ。期待 ${expected}）`);
      }
    }
  }
  for (const name of Object.keys(FOOTPRINT_AWARE)) assert.ok(found[name] >= 1, `前提: ${name} の消費側が見つかるはず`);
  assert.equal(found.validateOpeningPlacement, 3, '前提: openingEdit.js の 3 か所（配置・クランプ後の再検証・編集検証）');
});

test('【配線】S3c: ドラッグ中のスナップ表示の半幅は extraHalf を含む（usePointerInteraction.js・コメント除外）', () => {
  const code = stripComments(fs.readFileSync(path.join(SRC, 'interaction', 'usePointerInteraction.js'), 'utf8'));
  assert.ok(/snapIndicatorAlong\(r\.candidate,\s*st\.opening\.width \/ 2 \+ st\.extraHalf\)/.test(code), 'snapIndicatorAlong の半幅に extraHalf が無い');
  assert.ok(/openingSnapCandidates\(wall, opening, graph, range, extraHalf\)/.test(code));
});

test('callArities（走査器の自己検証）: 引数の数・入れ子・複数行・定義の除外・コメント外の取りこぼし', () => {
  assert.deepEqual(callArities('openingCutSpan(o, m, w)', 'openingCutSpan'), [3]);
  assert.deepEqual(callArities('openingCutSpan(o, m)', 'openingCutSpan'), [2], '失敗側: host 無しは 2');
  assert.deepEqual(callArities('openingCutSpan(o, f(a, b), { x: 1, y: 2 })', 'openingCutSpan'), [3], '入れ子のカンマは数えない');
  assert.deepEqual(callArities('openingCutSpan(\n  o,\n  m,\n  w,\n)', 'openingCutSpan'), [3], '末尾カンマは引数に数えない');
  assert.deepEqual(callArities('export function openingCutSpan(opening, mechanism, host = null) {', 'openingCutSpan'), [], '定義は除く');
  assert.deepEqual(callArities('x.openingCutSpan(o)', 'openingCutSpan'), [], 'メソッド呼び出しは対象外');
  assert.deepEqual(callArities('openingCutSpan()', 'openingCutSpan'), [0]);
});
