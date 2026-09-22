import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  valuesEqual, diffEntries, shouldNotifyDiff, matchByContent, rankCandidates,
  classifyIncoming, assertNoDuplicate, suggestByClass,
} from './catalogMatch.js';
import { kindDef } from './catalogKinds.js';

function material(overrides) {
  return {
    code: '111111111165', name: 'せっこうボード t=9.5', spec: 'JIS A 6901', x: 0, y: 0, thickness: 9.5, note: '', category: 'panel',
    ...overrides,
  };
}

// ---- 値の等価判定 ----
test('valuesEqual: nullと0を区別する', () => {
  assert.equal(valuesEqual(null, 0), false);
  assert.equal(valuesEqual(0, 0), true);
  assert.equal(valuesEqual(null, null), true);
});

test('valuesEqual: 文字列は前後の空白を除いて完全一致', () => {
  assert.equal(valuesEqual(' 木材 ', '木材'), true);
  assert.equal(valuesEqual('木材', '鋼材'), false);
});

test('valuesEqual: 配列・オブジェクトは項目ごとの深い比較（文字列化比較ではない）', () => {
  assert.equal(valuesEqual({ tracks: 2, panels: [{ arrow: 'pos' }] }, { tracks: 2, panels: [{ arrow: 'pos' }] }), true);
  assert.equal(valuesEqual({ tracks: 2, panels: [{ arrow: 'pos' }] }, { tracks: 2, panels: [{ arrow: 'neg' }] }), false);
  assert.equal(valuesEqual([{ a: 1 }, { a: 2 }], [{ a: 1 }, { a: 2 }]), true);
});

// ---- R12: 不一致検出・通知条件 ----
test('diffEntries: codeを除く全項目を比較する', () => {
  const a = material();
  const b = material({ note: '違う備考' });
  assert.deepEqual(diffEntries('material', a, b), ['note']);
});

test('diffEntries: x・y・categoryの差も拾う（Minor指摘）', () => {
  const a = material();
  const b = material({ x: 10, y: 20, category: 'backing' });
  assert.deepEqual(diffEntries('material', a, b).sort(), ['category', 'x', 'y'].sort());
});

test('diffEntries: 境界マスターはderivedFrom/fieldsの差も拾う（QA指摘B2）', () => {
  const a = { key: 'CANTILEVER_WALL', label: 'x', kind: 'layered', layers: [], derivedFrom: 'EXTERIOR_WALL' };
  const b = { key: 'Y', label: 'y', kind: 'layered', layers: [], derivedFrom: 'INTERIOR_WALL' };
  assert.deepEqual(diffEntries('boundaryMaster', a, b), ['derivedFrom']);
});

test('shouldNotifyDiff: 差分が無ければ通知しない', () => {
  assert.equal(shouldNotifyDiff('material', []), false);
});

test('shouldNotifyDiff: spec/thickness以外の差は通知する', () => {
  assert.equal(shouldNotifyDiff('material', ['name']), true);
  assert.equal(shouldNotifyDiff('material', ['note', 'category']), true);
});

test('shouldNotifyDiff: specまたはthicknessの差は通知しない', () => {
  assert.equal(shouldNotifyDiff('material', ['spec']), false);
  assert.equal(shouldNotifyDiff('material', ['thickness']), false);
});

test('shouldNotifyDiff: spec/thicknessが他の項目と同時に違っても通知しない（両方混在は通知なし）', () => {
  assert.equal(shouldNotifyDiff('material', ['name', 'spec']), false);
  assert.equal(shouldNotifyDiff('material', ['note', 'thickness', 'category']), false);
});

test('shouldNotifyDiff: silentDiffFieldsを持たない種別（section）は常に通知する', () => {
  assert.equal(shouldNotifyDiff('section', ['width']), true);
});

// ---- R14: 内容照合の各段 ----
test('matchByContent: 完全一致（段0=exact）を返す', () => {
  const target = material({ code: '999999999999' });
  const result = matchByContent('material', target, [material()]);
  assert.equal(result.exact, true);
  assert.equal(result.level, 0);
  assert.equal(result.hits.length, 1);
});

test('matchByContent: thicknessだけ違う場合は段1（name,spec,x,y一致）で見つかる', () => {
  const target = material({ code: '999999999999', thickness: 12.5 });
  const result = matchByContent('material', target, [material()]);
  assert.equal(result.exact, false);
  assert.equal(result.level, 1);
  assert.equal(result.hits.length, 1);
});

test('matchByContent: yだけ違う場合は段2（name,spec,x一致）で見つかる', () => {
  const target = material({ code: '999999999999', y: 999 });
  const result = matchByContent('material', target, [material()]);
  assert.equal(result.level, 2);
  assert.equal(result.exact, false);
  assert.equal(result.hits.length, 1);
});

test('matchByContent: x・yが違う場合は段3（name,spec一致）で見つかる', () => {
  const target = material({ code: '999999999999', x: 999, y: 999 });
  const result = matchByContent('material', target, [material()]);
  assert.equal(result.level, 3);
  assert.equal(result.hits.length, 1);
});

test('matchByContent: name以外すべて違う場合は段4（name一致のみ）まで外れて見つかる', () => {
  const target = material({ code: '999999999999', spec: '別規格', x: 1, y: 1, thickness: 1 });
  const result = matchByContent('material', target, [material()]);
  assert.equal(result.level, 4);
  assert.equal(result.hits.length, 1);
});

test('matchByContent: 何も一致しなければ空配列（全滅=追加）。levelはfields.length-minMatchFields+1（Minor指摘）', () => {
  const target = material({ code: '999999999999', name: '無関係の材' });
  const result = matchByContent('material', target, [material()]);
  assert.equal(result.hits.length, 0);
  assert.equal(result.level, 5); // matchFields.length(5) - minMatchFields(1) + 1
});

test('matchByContent: 内装マスターは完全一致のみ（1項目違えば見つからない＝段を外さない）', () => {
  const base = { key: 'LIVING_ROOM', label: '居室', wallMaterial: '111111111166', wallFinish: '111111111201', ceilingHeight: 2700 };
  const target = { ...base, key: 'X', ceilingHeight: 2400 }; // ceilingHeightだけ違う
  const result = matchByContent('interiorMaster', target, [base]);
  assert.equal(result.hits.length, 0);
  assert.equal(result.exact, false);
});

test('matchByContent: 境界マスターも完全一致のみ', () => {
  const base = { key: 'EXTERIOR_WALL', label: '外壁', kind: 'layered', layers: [{ role: 'a', code: '1' }] };
  const exactTarget = { ...base, key: 'X' };
  const diffTarget = { ...base, key: 'X', layers: [{ role: 'a', code: '2' }] };
  assert.equal(matchByContent('boundaryMaster', exactTarget, [base]).exact, true);
  assert.equal(matchByContent('boundaryMaster', diffTarget, [base]).hits.length, 0);
});

test('matchByContent: 境界マスターはderivedFromが違うと完全一致にならない（QA指摘B2・compareFields/matchFieldsに追加済み）', () => {
  const base = { key: 'CANTILEVER_WALL', label: 'x', kind: 'layered', layers: [{ role: 'a', code: '1' }], derivedFrom: 'EXTERIOR_WALL' };
  const target = { ...base, key: 'Y', derivedFrom: 'INTERIOR_WALL' };
  assert.equal(matchByContent('boundaryMaster', target, [base]).hits.length, 0);
});

// ---- 候補の順位（同段複数）----
test('rankCandidates: builtin優先 → 数値差が小さい順 → キー昇順', () => {
  const target = material({ code: '999999999999', thickness: 10 });
  const closeUser    = material({ code: '111111111200', thickness: 9,  category: undefined }); // 数値差1・user
  const farBuiltin    = material({ code: '111111111100', thickness: 20, category: undefined }); // 数値差10・builtin
  const closeBuiltinA = material({ code: '111111111300', thickness: 11, category: undefined }); // 数値差1・builtin
  const closeBuiltinB = material({ code: '111111111050', thickness: 9,  category: undefined }); // 数値差1・builtin・キーが小さい
  const origins = new Map([
    [closeUser.code, 'user'], [farBuiltin.code, 'builtin'],
    [closeBuiltinA.code, 'builtin'], [closeBuiltinB.code, 'builtin'],
  ]);
  const ranked = rankCandidates('material', target, [closeUser, farBuiltin, closeBuiltinA, closeBuiltinB], origins);
  // builtin優先のため closeUser は最後。builtin同士は数値差1のcloseBuiltinA/Bがfarより先、
  // 同じ数値差1同士はキー昇順でcloseBuiltinBが先。
  assert.deepEqual(ranked.map(e => e.code), [closeBuiltinB.code, closeBuiltinA.code, farBuiltin.code, closeUser.code]);
});

// ---- QA指摘M7: compareCandidatesの口 ----
test('rankCandidates: 登録表の行がcompareCandidates(a,b,target)を指定していればそれを使う（共通規則より優先）', () => {
  // 凍結された本番登録表（kindDef経由）は書き換えず、行と同じ形（keyOf/matchFields/compareCandidates）の
  // オブジェクトを直接渡して口が実際に効くことを確認する。
  const def = {
    keyOf: e => e.id,
    matchFields: ['value'],
    compareCandidates: (a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0), // わざとキー降順にする
  };
  const hits = [{ id: 'a', value: 1 }, { id: 'b', value: 1 }, { id: 'c', value: 1 }];
  const ranked = rankCandidates(def, { value: 1 }, hits, new Map());
  // 共通規則（キー昇順）ならa,b,cのはずが、compareCandidates指定により降順になる
  assert.deepEqual(ranked.map(e => e.id), ['c', 'b', 'a']);
});

test('rankCandidates: compareCandidates未指定なら共通規則（builtin優先→数値差→キー昇順）を使う（現状は全種別未指定）', () => {
  for (const kind of ['material', 'section', 'openingSubType', 'interiorMaster', 'boundaryMaster']) {
    assert.equal(kindDef(kind).compareCandidates, undefined, `${kind}にcompareCandidatesが指定されている`);
  }
});

// ---- classifyIncoming: 照合の各段 ----
test('classifyIncoming: idが一致し内容も一致 → same', () => {
  const appEntries = [material()];
  const result = classifyIncoming('material', material(), appEntries, new Map());
  assert.equal(result.action, 'same');
});

test('classifyIncoming: idが一致し内容が違う → adopt-doc（notifyはR12に従う）', () => {
  const appEntries = [material()];
  const docEntry = material({ note: '別の備考' });
  const result = classifyIncoming('material', docEntry, appEntries, new Map());
  assert.equal(result.action, 'adopt-doc');
  assert.deepEqual(result.diffFields, ['note']);
  assert.equal(result.notify, true);
});

test('classifyIncoming: idが一致し内容が違うがspec差のみ → adopt-docだが通知なし', () => {
  const appEntries = [material()];
  const docEntry = material({ spec: '別規格' });
  const result = classifyIncoming('material', docEntry, appEntries, new Map());
  assert.equal(result.action, 'adopt-doc');
  assert.equal(result.notify, false);
});

test('classifyIncoming: idは不一致だが内容が完全一致 → alias自動（承認不要）', () => {
  const existing = material({ code: '111111111165' });
  const docEntry = material({ code: '999999999999' }); // 5項目は同じ、codeだけ違う
  const result = classifyIncoming('material', docEntry, [existing], new Map());
  assert.equal(result.action, 'alias');
  assert.equal(result.from, '999999999999');
  assert.equal(result.to, '111111111165');
});

test('classifyIncoming: idは不一致・部分一致（2-1〜2-4段） → propose（候補付き・承認UI行き）', () => {
  const existing = material({ code: '111111111165' });
  const docEntry = material({ code: '999999999999', thickness: 15 }); // thicknessだけ違う=段1
  const result = classifyIncoming('material', docEntry, [existing], new Map());
  assert.equal(result.action, 'propose');
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].code, '111111111165');
});

test('classifyIncoming: 何も一致しない → add', () => {
  const existing = material({ code: '111111111165' });
  const docEntry = material({ code: '999999999999', name: '無関係の材' });
  const result = classifyIncoming('material', docEntry, [existing], new Map());
  assert.equal(result.action, 'add');
  assert.equal(result.entry, docEntry);
});

test('classifyIncoming: 内装マスターは1項目違えばpropose/aliasではなくadd（完全一致のみ）', () => {
  const existing = { key: 'LIVING_ROOM', label: '居室', wallMaterial: '111111111166', wallFinish: '111111111201', ceilingHeight: 2700 };
  const docEntry = { key: 'DOC_ROOM', label: '居室(文書)', wallMaterial: '111111111166', wallFinish: '111111111201', ceilingHeight: 2400 };
  const result = classifyIncoming('interiorMaster', docEntry, [existing], new Map());
  assert.equal(result.action, 'add');
});

// ---- QA指摘M1: openingSubTypeは全項目一致（wallKinds/defaultWidth/defaultHeight/label含む）のときだけalias自動 ----
test('classifyIncoming(openingSubType): 全項目一致のときだけalias自動', () => {
  const existing = { category: 'fitting', key: 'singleSwing', label: '片開き戸', mechanism: 'swing', wallKinds: ['interior'], defaultWidth: 800, defaultHeight: 2000 };
  const docEntry = { category: 'fitting', key: 'newKey', label: '片開き戸', mechanism: 'swing', wallKinds: ['interior'], defaultWidth: 800, defaultHeight: 2000 };
  const result = classifyIncoming('openingSubType', docEntry, [existing], new Map());
  assert.equal(result.action, 'alias');
  assert.equal(result.to, 'fitting:singleSwing'); // 複合キー（B1）
});

test('classifyIncoming(openingSubType): defaultWidthだけ違う場合はaliasにならずpropose（旧matchFields6項目ならexact誤判定していたケース。QA指摘M1）', () => {
  const existing = { category: 'fitting', key: 'singleSwing', label: '片開き戸', mechanism: 'swing', wallKinds: ['interior'], defaultWidth: 800, defaultHeight: 2000 };
  const docEntry = { category: 'fitting', key: 'newKey', label: '片開き戸', mechanism: 'swing', wallKinds: ['interior'], defaultWidth: 900, defaultHeight: 2000 };
  const result = classifyIncoming('openingSubType', docEntry, [existing], new Map());
  assert.equal(result.action, 'propose');
});

test('classifyIncoming(openingSubType): fitting/windowで同じkeyでも複合キーで区別する（B1）', () => {
  const fittingDoubleSliding = { category: 'fitting', key: 'doubleSliding', label: '引き違い戸', mechanism: 'slideDouble', wallKinds: ['interior', 'exterior'], defaultWidth: 1600, defaultHeight: 2000 };
  const windowDoubleSliding = { category: 'window', key: 'doubleSliding', label: '引き違い窓', mechanism: 'slideDouble', defaultWidth: 1690, defaultHeight: 1170 };
  const docEntry = { ...windowDoubleSliding }; // windowのdoubleSlidingと同じ内容の同梱エントリ
  const result = classifyIncoming('openingSubType', docEntry, [fittingDoubleSliding, windowDoubleSliding], new Map());
  assert.equal(result.action, 'same'); // fittingの同名キーと誤って同一視しない
});

// ---- R17: 重複登録の禁止 ----
test('assertNoDuplicate: 5項目一致（categoryが違っても）は例外を投げる', () => {
  const entries = [material({ code: '111111111165', category: 'panel' })];
  const incoming = material({ code: '999999999999', category: 'backing' });
  assert.throws(() => assertNoDuplicate('material', incoming, entries), /既に登録されています/);
});

test('assertNoDuplicate: 同一キーのエントリ自身は重複扱いにしない（Minor指摘）', () => {
  const self = material({ code: '111111111165' });
  const entries = [self]; // リストに自分自身が既に含まれる状態（編集時の再検証を想定）
  assert.doesNotThrow(() => assertNoDuplicate('material', self, entries));
  // 内容が同一の「別オブジェクト・同じキー」も自己とみなして弾かない
  const sameKeyClone = material({ code: '111111111165' });
  assert.doesNotThrow(() => assertNoDuplicate('material', sameKeyClone, entries));
});

test('assertNoDuplicate: 1項目でも違えば通す', () => {
  const entries = [material({ code: '111111111165' })];
  const incoming = material({ code: '999999999999', thickness: 12 });
  assert.doesNotThrow(() => assertNoDuplicate('material', incoming, entries));
});

test('assertNoDuplicate: dedupeFieldsを持たない種別（section）は常に許容（no-op）', () => {
  const entries = [{ key: 'a', materialType: 'WOOD', shape: 'rect', width: 90, height: 90, label: '90×90' }];
  const incoming = { key: 'b', materialType: 'WOOD', shape: 'rect', width: 90, height: 90, label: '90×90' };
  assert.doesNotThrow(() => assertNoDuplicate('section', incoming, entries));
});

// ---- 4.6.1(b): 変換先候補の選定（大分類・中分類が同じ材）----
test('suggestByClass: 大分類・中分類が同じ材を候補にする', () => {
  const entries = [
    material({ code: '102000000001', name: 'A' }),
    material({ code: '102000000002', name: 'B' }),
    material({ code: '103000000001', name: '別の中分類' }),
  ];
  const hits = suggestByClass('102099999999', entries);
  assert.deepEqual(hits.map(e => e.code), ['102000000001', '102000000002']);
});

test('suggestByClass: 候補が無ければ空配列', () => {
  const entries = [material({ code: '102000000001' })];
  assert.deepEqual(suggestByClass('409999999999', entries), []);
});

test('【失敗系】suggestByClass: codeが材料コード形式でなければ空配列', () => {
  assert.deepEqual(suggestByClass('not-a-code', [material()]), []);
});
