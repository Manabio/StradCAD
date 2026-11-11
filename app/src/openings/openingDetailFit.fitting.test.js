// 建具一式（FITTING）の部品を枠・姿図の解決へ通す口（C3）。解決順（建具個別 ＞ 一式〔個別 fitting ＞ 種別 fitting〕＞ 記号 ＞ 既定）・
// 合成キーの読み出し（detailFigureEntry）・fittingKey 無しの不変・通知・配線（ソース走査）を検証する。
// 一式の fixture は C1 の fittingSet（detail/detailModel.test.js）と同じ形（最上位の strokes 空・parts に部品の本体）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { OpeningCategory } from '@core';
import { CatalogKind } from '../catalog/catalogKinds.js';
import { setOverlay, clearOverlays } from '../catalog/catalogRegistry.js';
import {
  DetailSlot, DetailCategory, DetailView, DetailSubject, FittingPartRole, FIXTURE_SYMBOL_DETAIL_FIGURES_FIELD,
} from '../core/constants.js';
import { detailFigureEntry, findCatalogEntry, subTypeDetailFigureRefsFor } from './openingCatalog.js';
import { resolveDetailFigure, resolveDetailFrame, resolveDetailElevation, fittingKeyOf } from './openingDetailFit.js';
import { collectDetailFigureFailures } from './openingDetailFitCheck.js';
import {
  jambFigure, headFigure, elevationFigure, materialBoundFigure, installFrameSymbol, uniqueSymbolKey, subTypeEntry,
} from './openingDetailTestFixtures.js';

test.afterEach(() => clearOverlays());

const { JAMB, HEAD, SILL, FIGURE, FIGURE_BACK, FITTING } = DetailSlot;
const DF = CatalogKind.DETAIL_FIGURE;
const ST = CatalogKind.OPENING_SUB_TYPE;

// カタログの重複禁止（同内容の図は登録不可）を避けるため、図は呼ぶたびに最初の手の長さを僅かに変えて別物にする。
let serial = 0;
const unique = fig => {
  serial += 1;
  const s = structuredClone(fig);
  const m = s.strokes[0].moves[0];
  m.len = { ...m.len, mm: m.len.mm + serial * 0.001 };
  return s;
};
const J = (key, over) => unique(jambFigure(key, over));
const H = (key, over) => unique(headFigure(key, over));
const E = (key, opts) => unique(elevationFigure(key, opts));

/** 図 → 部品の本体（分類・strokes・datums・anchors）。 */
const bodyOf = fig => ({ category: fig.category, view: fig.view, subject: fig.subject, strokes: fig.strokes, datums: fig.datums, anchors: fig.anchors });
const partOf = (role, fig) => ({ id: `p-${role}`, role, figure: bodyOf(fig) });
function fittingSet(key, parts, over = {}) {
  return {
    key, version: 1, label: `一式${key}`, category: DetailCategory.FITTING, view: DetailView.PLAN, subject: DetailSubject.OPENING,
    strokes: [], datums: [], anchors: [], provenance: null, note: null, parts, ...over,
  };
}
const jambPart = () => partOf(FittingPartRole.JAMB, J('x'));
const headPart = () => partOf(FittingPartRole.HEAD, H('x'));
const figurePart = () => partOf(FittingPartRole.FIGURE, E('x'));

/** 記号 sym（方立 sym-j・上枠 sym-h を割当て）と一式 set1（jamb・head 部品）と個別指定用の図を user overlay に立てる。 */
function install({ withHead = true, sets = [fittingSet('set1', [jambPart(), headPart()])] } = {}) {
  const sym = uniqueSymbolKey();
  const symJamb = J(`${sym}-j`);
  const symHead = H(`${sym}-h`);
  const ovJamb = J('ov-j'), ovHead = H('ov-h');
  installFrameSymbol(sym, withHead ? { [JAMB]: symJamb, [HEAD]: symHead } : { [JAMB]: symJamb }, {
    extraFigures: [ovJamb, ovHead, ...sets],
  });
  return { sym, symJamb, symHead, plain: [ovJamb, ovHead, symJamb, ...(withHead ? [symHead] : [])], sets };
}

// ---- 合成キーの読み出し（detailFigureEntry）----

test('合成キー: 一式の部品を "<一式>#<役割>" で引ける（key・label が合成・分類は部品本体）。同じ世代では同一オブジェクト', () => {
  install();
  const e = detailFigureEntry('set1#jamb');
  assert.equal(e.key, 'set1#jamb');
  assert.equal(e.label, '一式set1（jamb）');
  assert.equal(e.category, DetailCategory.PAIRED);
  assert.equal(detailFigureEntry('set1#jamb'), e, 'キャッシュ');
});

test('【失敗系】合成キー: 部品の無い役割・一式でない図の # 付き・未知の一式・未知の役割・空側は null（例外にしない）', () => {
  install();
  assert.equal(detailFigureEntry('set1#sill'), null, '部品の無い役割');
  assert.equal(detailFigureEntry('ov-j#jamb'), null, '一式でない図');
  assert.equal(detailFigureEntry('nope#jamb'), null, '未知の一式');
  assert.equal(detailFigureEntry('set1#bogus'), null, '未知の役割');
  assert.equal(detailFigureEntry('set1#'), null);
  assert.equal(detailFigureEntry('#jamb'), null);
});

test('合成キー: 完全一致が優先される（合成キーと同じキーの単独図が登録されていればそれを返す）', () => {
  install({ sets: [fittingSet('set1', [jambPart()]), J('set1#jamb', { label: '単独の図' })] });
  assert.equal(detailFigureEntry('set1#jamb').label, '単独の図');
});

test('合成キー: overlay の世代で破棄する（一式を差し替えると部品も変わる・消すと null。null の結果もキャッシュ越しに更新される）', () => {
  setOverlay(DF, { user: [fittingSet('set1', [jambPart()])] });
  assert.equal(detailFigureEntry('set1#jamb').label, '一式set1（jamb）');
  assert.equal(detailFigureEntry('set1#head'), null);
  setOverlay(DF, { user: [fittingSet('set1', [jambPart(), headPart()], { label: '改' })] });
  assert.equal(detailFigureEntry('set1#jamb').label, '改（jamb）');
  assert.notEqual(detailFigureEntry('set1#head'), null, '前世代の null が残らない');
  setOverlay(DF, { user: [] });
  assert.equal(detailFigureEntry('set1#jamb'), null);
});

// ---- 解決順 ----

test('解決順（jamb）: 建具個別 ＞ 一式（個別の fitting ＞ 種別の fitting は fittingKeyOf が決める）＞ 記号 ＞ 既定（候補なし）', () => {
  const { sym, symJamb } = install();
  const r = extra => resolveDetailFigure({ symbolKey: sym, slot: JAMB, ...extra });
  assert.deepEqual([r({ detailRefs: { [JAMB]: 'ov-j' }, fittingKey: 'set1' }).drawn.key, r({ detailRefs: { [JAMB]: 'ov-j' }, fittingKey: 'set1' }).drawn.source], ['ov-j', 'opening']);
  const viaFitting = r({ fittingKey: 'set1' });
  assert.deepEqual([viaFitting.drawn.key, viaFitting.drawn.source, viaFitting.drawn.slot], ['set1#jamb', 'fitting', JAMB]);
  assert.equal(viaFitting.intended.key, 'set1#jamb', '一式の部品が意図の先頭（記号より前）');
  const viaSymbol = r({});
  assert.deepEqual([viaSymbol.drawn.key, viaSymbol.drawn.source], [symJamb.key, 'symbol']);
  assert.equal(resolveDetailFigure({ symbolKey: 'NO-SUCH', slot: JAMB }), null, '全部無ければ null＝既定へ');
});

test('解決順: 個別の detailRefs.fitting ＞ 種別の detailFigures.fitting（fittingKeyOf）。明示の null は種別の一式も見ない', () => {
  setOverlay(DF, { user: [fittingSet('set-op', [jambPart()]), fittingSet('set-st', [jambPart()])] });
  setOverlay(ST, { user: [subTypeEntry('stF', null, { [FIXTURE_SYMBOL_DETAIL_FIGURES_FIELD]: { [FITTING]: 'set-st' } })] });
  const entry = findCatalogEntry(OpeningCategory.FITTING, 'stF');
  const o = over => ({ category: OpeningCategory.FITTING, subType: 'stF', ...over });
  assert.equal(fittingKeyOf(o({}), entry), 'set-st');
  assert.equal(fittingKeyOf(o({}), undefined), 'set-st', 'entry 省略時はカタログから引く');
  assert.equal(fittingKeyOf(o({ detailRefs: { [FITTING]: 'set-op' } }), entry), 'set-op');
  assert.equal(fittingKeyOf(o({ detailRefs: { [FITTING]: null } }), entry), null, '明示 null は種別の一式を見ない');
  assert.equal(fittingKeyOf(o({ detailRefs: { [JAMB]: 'ov-j' } }), entry), 'set-st', '他の slot の指定は無関係');
  assert.equal(fittingKeyOf(o({ subType: 'none-such' }), undefined), null);
  assert.equal(fittingKeyOf(null, null), null);
  // 解決側も明示 null の detailRefs では fittingKey が渡っても一式を候補にしない（記号へ進む）
  const { sym } = install();
  const r = resolveDetailFigure({ symbolKey: sym, slot: JAMB, detailRefs: { [FITTING]: null }, fittingKey: 'set1' });
  assert.equal(r.drawn.source, 'symbol');
});

test('slot の明示 null（「なし」）は記号だけでなく一式の段も飛ばす。キー無し・undefined は一式が効く', () => {
  const { sym } = install();
  const none = resolveDetailFigure({ symbolKey: sym, slot: JAMB, detailRefs: { [JAMB]: null }, fittingKey: 'set1' });
  assert.equal(none, null, '一式も記号も候補にならず既定へ落ちる');
  const undef = resolveDetailFigure({ symbolKey: sym, slot: JAMB, detailRefs: { [JAMB]: undefined }, fittingKey: 'set1' });
  assert.deepEqual([undef.drawn.key, undef.drawn.source], ['set1#jamb', 'fitting']);
  const noKey = resolveDetailFigure({ symbolKey: sym, slot: JAMB, detailRefs: { [HEAD]: null }, fittingKey: 'set1' });
  assert.equal(noKey.drawn.source, 'fitting', '別の slot の null は無関係');
  // head の要求で head だけ null: head の段（一式・記号）を飛ばし、jamb の段（R9）には一式の jamb が効く
  const headNone = resolveDetailFigure({ symbolKey: sym, slot: HEAD, detailRefs: { [HEAD]: null }, fittingKey: 'set1' });
  assert.deepEqual([headNone.drawn.key, headNone.drawn.slot], ['set1#jamb', JAMB]);
});

test('Q-C3: detailRefs.jamb に合成キーを直接書くと一式の部品で解決する。部品の無い合成キーは drawn null で notFound の行（主語は建具個別の指定）', () => {
  setOverlay(DF, { user: [fittingSet('kset', [jambPart()])] });
  const r = resolveDetailFigure({ symbolKey: 'NONE', slot: JAMB, detailRefs: { [JAMB]: 'kset#jamb' } });
  assert.deepEqual([r.drawn.key, r.drawn.source], ['kset#jamb', 'opening']);
  const missing = resolveDetailFigure({ symbolKey: 'NONE', slot: JAMB, detailRefs: { [JAMB]: 'kset#head' } });
  assert.equal(missing.drawn, null);
  assert.equal(missing.intended.key, 'kset#head');
  // 通知（姿図 slot で同じ経路。枠の slot は collectDetailFitFailures が同じ pushFailuresOf を通る）
  const o = { category: OpeningCategory.FITTING, subType: 'singleSwing', width: 800, height: 2000, detailRefs: { [FIGURE]: 'kset#head' } };
  const rows = collectDetailFigureFailures([o]);
  assert.equal(rows.length, 1);
  assert.match(rows[0].message, /建具個別の指定 の姿図の詳細図がカタログに見つかりません/);
});

test('解決順（head）: 一式に head があれば 建具個別 ＞ 一式 ＞ 記号 head', () => {
  const { sym } = install();
  const withHead = resolveDetailFigure({ symbolKey: sym, slot: HEAD, fittingKey: 'set1' });
  assert.deepEqual([withHead.drawn.key, withHead.drawn.source, withHead.drawn.slot], ['set1#head', 'fitting', HEAD]);
  const opening = resolveDetailFigure({ symbolKey: sym, slot: HEAD, detailRefs: { [HEAD]: 'ov-h' }, fittingKey: 'set1' });
  assert.deepEqual([opening.drawn.key, opening.drawn.source], ['ov-h', 'opening']);
});

test('解決順（head・記号の head あり）: 一式に head 部品が無ければ記号の head が一式の jamb より先に選ばれる', () => {
  const { sym, symHead } = install({ sets: [fittingSet('set1', [jambPart()])] });
  const r = resolveDetailFigure({ symbolKey: sym, slot: HEAD, fittingKey: 'set1' });
  assert.deepEqual([r.drawn.key, r.drawn.source], [symHead.key, 'symbol']);
});

test('解決順（head・R9）: head がどこにも無ければ jamb を流用＝一式の jamb（個別の jamb が先・記号の jamb は一式の後）', () => {
  const { sym } = install({ withHead: false, sets: [fittingSet('set1', [jambPart()])] });
  const viaFitting = resolveDetailFigure({ symbolKey: sym, slot: HEAD, fittingKey: 'set1' });
  assert.deepEqual([viaFitting.drawn.key, viaFitting.drawn.slot, viaFitting.drawn.source], ['set1#jamb', JAMB, 'fitting']);
  const viaOpening = resolveDetailFigure({ symbolKey: sym, slot: HEAD, detailRefs: { [JAMB]: 'ov-j' }, fittingKey: 'set1' });
  assert.deepEqual([viaOpening.drawn.key, viaOpening.drawn.source], ['ov-j', 'opening']);
});

test('解決順（sill・figure・figureBack）: 一式の対応する部品だけが候補。部品が無い slot は一式を見ない', () => {
  const set = fittingSet('set2', [partOf(FittingPartRole.SILL, H('x', { subject: DetailSubject.SILL })), figurePart(),
    partOf(FittingPartRole.FIGURE_BACK, E('x'))]);
  setOverlay(DF, { user: [set] });
  const sill = resolveDetailFigure({ slot: SILL, fittingKey: 'set2' });
  assert.deepEqual([sill.drawn.key, sill.drawn.source], ['set2#sill', 'fitting']);
  const fig = resolveDetailFigure({ slot: FIGURE, fittingKey: 'set2' });
  assert.deepEqual([fig.drawn.key, fig.drawn.source], ['set2#figure', 'fitting']);
  const back = resolveDetailFigure({ slot: FIGURE_BACK, fittingKey: 'set2' });
  assert.deepEqual([back.drawn.key, back.drawn.source], ['set2#figureBack', 'fitting']);
  // jamb 部品の無い一式では jamb は null（一式の sill などを流用しない）
  assert.equal(resolveDetailFigure({ symbolKey: 'NO-SUCH', slot: JAMB, fittingKey: 'set2' }), null);
  // 姿図: 建具個別 ＞ 一式 ＞ 建具種別
  setOverlay(DF, { user: [set, E('df-ov'), E('df-st')] });
  const refs = { [FIGURE]: 'df-st' };
  assert.deepEqual(['df-ov', 'opening'], (r => [r.drawn.key, r.drawn.source])(resolveDetailFigure({ slot: FIGURE, detailRefs: { [FIGURE]: 'df-ov' }, subTypeRefs: refs, fittingKey: 'set2' })));
  assert.deepEqual(['set2#figure', 'fitting'], (r => [r.drawn.key, r.drawn.source])(resolveDetailFigure({ slot: FIGURE, subTypeRefs: refs, fittingKey: 'set2' })));
  assert.deepEqual(['df-st', 'subType'], (r => [r.drawn.key, r.drawn.source])(resolveDetailFigure({ slot: FIGURE, subTypeRefs: refs })));
});

test('【失敗系】解決順: 一式の参照切れ（一式が無い・空文字・非文字列）は候補を積まず次の段（記号）へ。例外にしない', () => {
  const { sym, symJamb } = install();
  for (const fittingKey of ['gone-set', '', null, undefined, 5]) {
    const r = resolveDetailFigure({ symbolKey: sym, slot: JAMB, fittingKey });
    assert.deepEqual([r.drawn.key, r.drawn.source], [symJamb.key, 'symbol'], String(fittingKey));
  }
  // 一式が一式でない図（単独の図）を指していても部品は引けない
  const r = resolveDetailFigure({ symbolKey: sym, slot: JAMB, fittingKey: 'ov-j' });
  assert.equal(r.drawn.source, 'symbol');
});

test('fittingKey 無しの呼び出しは一式が overlay にあっても従来と deepEqual（渡したときは変わる）', () => {
  const { sym, plain } = install();
  const args = { symbolKey: sym, slot: HEAD, detailRefs: { [JAMB]: 'ov-j' } };
  const withSet = resolveDetailFigure(args);
  const withSetNull = resolveDetailFigure({ ...args, fittingKey: null });
  setOverlay(DF, { user: plain });
  const withoutSet = resolveDetailFigure(args);
  assert.deepEqual(withSet.drawn.key, withoutSet.drawn.key);
  assert.deepEqual(withSet, withoutSet);
  assert.deepEqual(withSetNull, withoutSet);
  // 恒真でないことの対: 一式を置いて fittingKey を渡すと結果が変わる
  setOverlay(DF, { user: [...plain, fittingSet('set1', [headPart()])] });
  const passed = resolveDetailFigure({ ...args, fittingKey: 'set1' });
  assert.notDeepEqual(passed, withoutSet);
  assert.equal(passed.drawn.key, 'set1#head');
});

// ---- 呼び出し元への配線（結果）----

test('resolveDetailFrame: fittingKey を渡すと一式の部品で枠を fit して写す。渡さなければ記号の図', () => {
  const { sym } = install({ sets: [fittingSet('set1', [jambPart()])] });
  const base = { symbolKey: sym, slot: JAMB, coord1: 0, coord2: 900, faceMin: 0, wallThickness: 120, faceWidth: 20, projection: 12 };
  const viaFitting = resolveDetailFrame({ ...base, fittingKey: 'set1' });
  const viaSymbol = resolveDetailFrame(base);
  assert.ok(viaFitting.sides.length === 2 && !viaFitting.error);
  assert.deepEqual(viaFitting, viaSymbol, '同じ形の図なので寸法は同じ（出所だけ違う）');
  // 一式の図だけが壊れている（材束縛）ときは error が一式の部品から出る＝出所が一式だと分かる
  setOverlay(DF, { user: [J(`${sym}-j`), fittingSet('set1', [partOf(FittingPartRole.JAMB, unique(materialBoundFigure('x')))])] });
  const broken = resolveDetailFrame({ ...base, fittingKey: 'set1' });
  assert.ok(broken.error, '一式の部品が fit 不能');
  assert.equal(resolveDetailFrame(base).error, undefined, '一式を渡さなければ記号の図で成功');
});

test('resolveDetailElevation: 建具種別の detailFigures.fitting から姿図を解決する（個別の fitting:null で止まる）', () => {
  setOverlay(DF, { user: [fittingSet('set-el', [figurePart()])] });
  setOverlay(ST, { user: [subTypeEntry('stE', null, { [FIXTURE_SYMBOL_DETAIL_FIGURES_FIELD]: { [FITTING]: 'set-el' } })] });
  const entry = findCatalogEntry(OpeningCategory.FITTING, 'stE');
  assert.deepEqual(subTypeDetailFigureRefsFor(OpeningCategory.FITTING, 'stE', entry), { [FITTING]: 'set-el' });
  const o = over => ({ category: OpeningCategory.FITTING, subType: 'stE', width: 800, height: 2000, ...over });
  const r = resolveDetailElevation({ opening: o({}), entry });
  assert.equal(r.slot, FIGURE);
  assert.ok(r.primitives.length > 0);
  assert.equal(resolveDetailElevation({ opening: o({ detailRefs: { [FITTING]: null } }), entry }), null, '明示 null で一式を見ない');
  assert.equal(resolveDetailElevation({ opening: o({ subType: 'noFitting' }), entry: null }), null);
});

// ---- 通知 ----

test('通知: 一式の部品が fit 不能なら 1 行（主語「建具一式」・キー表示は「一式キー（役割）」）。同じ組は重複排除', () => {
  setOverlay(DF, { user: [fittingSet('set-bad', [partOf(FittingPartRole.FIGURE, E('x', { sFixed: 900 }))])] });
  setOverlay(ST, { user: [subTypeEntry('stB', null, { [FIXTURE_SYMBOL_DETAIL_FIGURES_FIELD]: { [FITTING]: 'set-bad' } })] });
  const o = { category: OpeningCategory.FITTING, subType: 'stB', width: 800, height: 2000 };
  const rows = collectDetailFigureFailures([o, { ...o }]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].slot, FIGURE);
  assert.equal(rows[0].symbolKey, '建具一式');
  assert.equal(rows[0].label, 'set-bad（figure）');
  assert.match(rows[0].message, /^詳細図 set-bad（figure） を 建具一式 の姿図に合わせられません: 固定寸法の和が目標を超える/);
});

test('【失敗系】通知: 一式の部品が合わせられる・fitting:null 明示・一式の参照切れは 0 行（従来の行も増減しない）', () => {
  setOverlay(DF, { user: [fittingSet('set-ok', [figurePart()]), fittingSet('set-bad', [partOf(FittingPartRole.FIGURE, E('x', { sFixed: 900 }))])] });
  setOverlay(ST, { user: [subTypeEntry('stO', null, { [FIXTURE_SYMBOL_DETAIL_FIGURES_FIELD]: { [FITTING]: 'set-ok' } }),
    subTypeEntry('stN', null, { [FIXTURE_SYMBOL_DETAIL_FIGURES_FIELD]: { [FITTING]: 'set-bad' } }),
    subTypeEntry('stG', null, { [FIXTURE_SYMBOL_DETAIL_FIGURES_FIELD]: { [FITTING]: 'set-gone' } })] });
  const o = subType => ({ category: OpeningCategory.FITTING, subType, width: 800, height: 2000 });
  assert.deepEqual(collectDetailFigureFailures([o('stO')]), []);
  assert.deepEqual(collectDetailFigureFailures([{ ...o('stN'), detailRefs: { [FITTING]: null } }]), []);
  assert.deepEqual(collectDetailFigureFailures([o('stG')]), []);
});

// ---- 配線（ソース走査。行頭・行末のコメントは除外）----

const SRC = path.resolve(import.meta.dirname, '..');
// 引数の形（fittingKey: …・fittingKey,・fittingKey }）だけを渡したとみなす（コメントや別名の語に一致させない）。
const FITTING_KEY_ARG = /\bfittingKey\b\s*[:,}]/;
const stripComments = text => text.split(/\r?\n/)
  .map(line => (/^\s*(\/\/|\*|\/\*)/.test(line) ? '' : line.replace(/\s\/\/.*$/, ''))).join('\n');
const sourceFiles = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
  const p = path.join(dir, e.name);
  if (e.isDirectory()) return e.name === 'node_modules' ? [] : sourceFiles(p);
  return /\.(js|jsx)$/.test(e.name) && !/\.test\.js$/.test(e.name) ? [p] : [];
});
/** code 中の `name(` の呼び出し（`function name(` の定義を除く）ごとに、対応する閉じ括弧までの本文を返す。 */
function callBodies(code, name) {
  const out = [];
  const re = new RegExp(`(?<![\\w.])${name}\\(`, 'g');
  for (let m = re.exec(code); m; m = re.exec(code)) {
    if (/function\s+$/.test(code.slice(0, m.index))) continue;
    let depth = 1, i = m.index + m[0].length;
    for (; i < code.length && depth > 0; i += 1) {
      if ('([{'.includes(code[i])) depth += 1;
      else if (')]}'.includes(code[i])) depth -= 1;
    }
    out.push(code.slice(m.index, i));
  }
  return out;
}

test('【配線】resolveDetailFigure・resolveDetailFrame・resolveSwingDoorFrame の消費側の全呼び出しが fittingKey を渡している', () => {
  const NAMES = ['resolveDetailFigure', 'resolveDetailFrame', 'resolveSwingDoorFrame'];
  let total = 0;
  for (const file of sourceFiles(SRC)) {
    const code = stripComments(fs.readFileSync(file, 'utf8'));
    for (const name of NAMES) {
      for (const body of callBodies(code, name)) {
        total += 1;
        assert.match(body, FITTING_KEY_ARG, `${path.relative(SRC, file)}: ${body.slice(0, 80)}`);
      }
    }
  }
  assert.equal(total, 13, `呼び出しを走査できている（${total} 件。resolveDetailFigure 8・resolveDetailFrame 2・resolveSwingDoorFrame 3）`);
});

test('【配線の自己検査】行末コメントに fittingKey と書いた渡し忘れは不一致になる。実際の引数は一致する', () => {
  const forgot = stripComments('const r = resolveDetailFigure({ symbolKey, slot }); // fittingKey を渡す');
  const forgotMulti = stripComments('resolveDetailFigure({\n  symbolKey, slot, // fittingKey\n});');
  const passed = stripComments('const r = resolveDetailFigure({ symbolKey, slot, fittingKey: fittingKeyOf(o) });');
  const shorthand = stripComments('resolveDetailFigure({ slot, fittingKey });');
  assert.doesNotMatch(callBodies(forgot, 'resolveDetailFigure')[0], FITTING_KEY_ARG);
  assert.doesNotMatch(callBodies(forgotMulti, 'resolveDetailFigure')[0], FITTING_KEY_ARG);
  assert.match(callBodies(passed, 'resolveDetailFigure')[0], FITTING_KEY_ARG);
  assert.match(callBodies(shorthand, 'resolveDetailFigure')[0], FITTING_KEY_ARG);
});

test('【配線】resolveDetailElevation の本体は entry から fittingKey を求めて姿図の 2 呼び出しに渡す', () => {
  const code = stripComments(fs.readFileSync(path.join(SRC, 'openings/openingDetailFit.js'), 'utf8'));
  const body = callBodies(code, 'resolveDetailFigure').filter(b => /subTypeRefs/.test(b));
  assert.equal(body.length, 2);
  for (const b of body) assert.match(b, FITTING_KEY_ARG);
  assert.match(code, /const fittingKey = fittingKeyOf\(opening, entry\)/);
});
