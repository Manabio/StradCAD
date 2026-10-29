// S造スラブカード（S6・2026-10-29）の純モデルと部材番号の署名のテスト。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SteelSlab, RcSlab } from '../core.js';
import { SteelSlabKind, RAISE_CHANNEL_SPECS } from '../core/constants.js';
import { defaultSteelSlabSpec, projectToKind, resolveSteelSlabSpec } from './steelSlabSpec.js';
import { memberSignature, memberSpecString } from './memberCatalog.js';
import {
  steelSlabCardView, planSteelSlabCardEdit, planSteelSlabRevert, slabCardFields, steelSlabSummary, slabWriteIsNoop,
  SLAB_CARD_STATUS_COMMON, SLAB_CARD_STATUS_INDIVIDUAL, SLAB_CARD_INDIVIDUAL_SUFFIX, braceHeightNote,
} from './steelSlabCardModel.js';

const COMMON = defaultSteelSlabSpec();
const slabOf = steelSpec => ({ steelSpec });
const keysOf = view => [view.kindRow, ...view.rows].map(r => r.key);

test('【S6】カード表示: 共通に従うスラブは「共通仕様に従う」・共通の種別の行・戻すボタンなし', () => {
  const v = steelSlabCardView({ slab: slabOf(null), common: COMMON });
  assert.equal(v.individual, false);
  assert.equal(v.statusLabel, SLAB_CARD_STATUS_COMMON);
  assert.equal(v.showRevert, false);
  assert.deepEqual(keysOf(v), ['kind', 'deckPlateCode', 'concreteType', 'concreteThicknessMm', 'concreteTopBelowFlMm']);
  assert.equal(v.rows.find(r => r.key === 'concreteThicknessMm').value, COMMON.concreteThicknessMm);
});

test('【S6】カード表示: 個別指定は実効（個別）仕様の行・「個別指定」・戻すボタンあり', () => {
  const alc = { ...projectToKind(COMMON, SteelSlabKind.ALC), alcTopBelowFlMm: 40 };
  const v = steelSlabCardView({ slab: slabOf(alc), common: COMMON });
  assert.equal(v.individual, true);
  assert.equal(v.statusLabel, SLAB_CARD_STATUS_INDIVIDUAL);
  assert.equal(v.showRevert, true);
  assert.deepEqual(keysOf(v), ['kind', 'alcCode', 'alcThickness', 'alcTopBelowFlMm', 'raiseChannelSpec']);
  assert.equal(v.rows.find(r => r.key === 'alcTopBelowFlMm').value, 40);
});

test('【S7】設置高さの注記: 自動「子梁成 300 → 自動 150」・指定が収まる「子梁成 300 → 100」・超過「上限 300 に丸め」。braceInfo が無ければ注記なし', () => {
  const brace = { ...projectToKind(COMMON, SteelSlabKind.BRACE) };
  const noteOf = (spec, info) => steelSlabCardView({ slab: slabOf(spec), common: COMMON, braceInfo: info })
    .rows.find(r => r.key === 'braceHeightMm').note;
  assert.equal(noteOf(brace, { childDepthMm: 300, resolvedMm: 150, clamped: false }), '子梁成 300 → 自動 150');
  assert.equal(noteOf({ ...brace, braceHeightMm: 100 }, { childDepthMm: 300, resolvedMm: 100, clamped: false }), '子梁成 300 → 100');
  assert.equal(noteOf({ ...brace, braceHeightMm: 500 }, { childDepthMm: 300, resolvedMm: 300, clamped: true }), '上限 300 に丸め');
  assert.equal(braceHeightNote({ childDepthMm: 200, resolvedMm: 100, clamped: false }, { braceHeightMm: null }), '子梁成 200 → 自動 100');
  assert.equal(noteOf(brace, { childDepthMm: 300, resolvedMm: 150, clamped: false, exceededBays: 2 }),
    '子梁成 300 → 自動 150／対角線長が上限を超えるベイ 2（短辺が上限以上、または記録で分割数が固定）');
  assert.equal(noteOf(brace, { childDepthMm: 300, resolvedMm: 150, clamped: false, exceededBays: 0 }), '子梁成 300 → 自動 150', '0 件は足さない');
  assert.equal(noteOf(brace, null), undefined, 'braceInfo なし（デッキ等・未計算）は注記を付けない');
});

test('【S6】サマリー: 種別名・個別指定なら（個別）付き。基底の厚みは出さない', () => {
  assert.equal(steelSlabSummary(slabOf(null), COMMON), 'デッキプレート');
  assert.equal(steelSlabSummary(slabOf(projectToKind(COMMON, SteelSlabKind.ALC)), COMMON), `ALC${SLAB_CARD_INDIVIDUAL_SUFFIX}`);
});

test('【S6】編集: 共通に従うスラブの項目を変えると、自種別の項目だけの個別仕様になる', () => {
  const r = planSteelSlabCardEdit({ slab: slabOf(null), common: COMMON, key: 'concreteThicknessMm', value: '180' });
  assert.equal(r.error, null);
  assert.equal(r.nextSpec.kind, SteelSlabKind.DECK);
  assert.equal(r.nextSpec.concreteThicknessMm, 180);
  assert.equal('alcCode' in r.nextSpec, false, '他種別の項目は持たない');
  assert.equal(r.nextSpec.deckPlateCode, COMMON.deckPlateCode, '触っていない項目は共通の値のまま');
});

test('【S6】編集: 個別を共通と同じ値へ戻すと nextSpec=null（個別扱いを削除して共通へ畳む）', () => {
  const indiv = { ...projectToKind(COMMON, SteelSlabKind.DECK), concreteThicknessMm: 180 };
  const r = planSteelSlabCardEdit({ slab: slabOf(indiv), common: COMMON, key: 'concreteThicknessMm', value: String(COMMON.concreteThicknessMm) });
  assert.equal(r.error, null);
  assert.equal(r.nextSpec, null);
});

test('【S6】編集: 種別の切替は共通のその種別の値から始める（個別の元の種別の値を持ち越さない）', () => {
  const common = { ...COMMON, alcTopBelowFlMm: 25, raiseChannelSpec: RAISE_CHANNEL_SPECS[0] };
  const indiv = { ...projectToKind(common, SteelSlabKind.DECK), concreteThicknessMm: 180 };
  const toAlc = planSteelSlabCardEdit({ slab: slabOf(indiv), common, key: 'kind', value: SteelSlabKind.ALC });
  assert.equal(toAlc.error, null);
  assert.equal(toAlc.nextSpec.kind, SteelSlabKind.ALC);
  assert.equal(toAlc.nextSpec.alcTopBelowFlMm, 25);
  assert.equal(toAlc.nextSpec.raiseChannelSpec, RAISE_CHANNEL_SPECS[0]);
  assert.equal('concreteThicknessMm' in toAlc.nextSpec, false);
  // 共通の種別（デッキ）へ戻すと、共通と同じ（デッキの厚も共通の値から始まる）ので共通へ畳む。
  const back = planSteelSlabCardEdit({ slab: slabOf(toAlc.nextSpec), common, key: 'kind', value: SteelSlabKind.DECK });
  assert.equal(back.nextSpec, null);
});

test('【S6】編集: 共通がデッキのとき ALC の個別を共通の ALC 値と同じにしても個別のまま（種別は畳まない）', () => {
  const r = planSteelSlabCardEdit({ slab: slabOf(null), common: COMMON, key: 'kind', value: SteelSlabKind.ALC });
  assert.equal(r.error, null);
  assert.deepEqual(r.nextSpec, projectToKind(COMMON, SteelSlabKind.ALC));
  const again = planSteelSlabCardEdit({ slab: slabOf(r.nextSpec), common: COMMON, key: 'alcTopBelowFlMm', value: String(COMMON.alcTopBelowFlMm) });
  assert.equal(again.nextSpec, undefined, '同じ値の再確定は書かない（個別のまま）');
});

test('【S6】混在: 仕様が揃わない members は「（仕様が混在）」・代表と同じ値の確定でも全員へ書く', () => {
  const rep = slabOf(null);
  const other = slabOf(projectToKind(COMMON, SteelSlabKind.ALC));
  const members = [rep, other];
  const v = steelSlabCardView({ slab: rep, common: COMMON, members });
  assert.equal(v.mixed, true);
  assert.match(v.statusLabel, /（仕様が混在）$/);
  assert.equal(steelSlabCardView({ slab: rep, common: COMMON, members: [rep, slabOf(null)] }).mixed, false);
  const same = planSteelSlabCardEdit({ slab: rep, common: COMMON, key: 'concreteThicknessMm', value: String(COMMON.concreteThicknessMm), members });
  assert.equal(same.nextSpec, null, '代表の値（共通に従う）で全員を揃える');
  assert.equal(slabWriteIsNoop(members, same.nextSpec), false);
  assert.equal(slabWriteIsNoop([rep, slabOf(null)], null), true, 'null 同士は等しい');
  assert.equal(planSteelSlabRevert(rep, members), null, '代表が共通でも混在なら共通へ揃えられる');
});

test('【S6】編集: 変化なし（同じ値・同じ種別の再選択）は nextSpec=undefined（書かない）', () => {
  const same = planSteelSlabCardEdit({ slab: slabOf(null), common: COMMON, key: 'concreteThicknessMm', value: String(COMMON.concreteThicknessMm) });
  assert.deepEqual(same, { error: null, nextSpec: undefined });
  const sameKind = planSteelSlabCardEdit({ slab: slabOf(null), common: COMMON, key: 'kind', value: COMMON.kind });
  assert.deepEqual(sameKind, { error: null, nextSpec: undefined });
});

test('【S6・失敗系】編集: 不正な厚（0・数値でない）は error を返し nextSpec は undefined', () => {
  for (const bad of ['0', '-5', 'abc', '']) {
    const r = planSteelSlabCardEdit({ slab: slabOf(null), common: COMMON, key: 'concreteThicknessMm', value: bad });
    assert.ok(r.error, `error が出る: ${JSON.stringify(bad)}`);
    assert.equal(r.nextSpec, undefined);
  }
  const badKind = planSteelSlabCardEdit({ slab: slabOf(null), common: COMMON, key: 'kind', value: 'zzz' });
  assert.ok(badKind.error);
  assert.equal(badKind.nextSpec, undefined);
});

test('【S6】編集: 消えた材料コードを持つ個別仕様でも、別の項目の編集で既定へ落とさない（カタログ照合を渡さない）', () => {
  const gone = '201600009999';
  const indiv = { ...projectToKind(COMMON, SteelSlabKind.DECK), deckPlateCode: gone };
  const r = planSteelSlabCardEdit({ slab: slabOf(indiv), common: COMMON, key: 'concreteThicknessMm', value: '200' });
  assert.equal(r.nextSpec.deckPlateCode, gone);
});

test('【S6】共通に戻す: 個別のときだけ null、共通のときは undefined', () => {
  assert.equal(planSteelSlabRevert(slabOf(projectToKind(COMMON, SteelSlabKind.ALC))), null);
  assert.equal(planSteelSlabRevert(slabOf(null)), undefined);
  assert.deepEqual(resolveSteelSlabSpec(null, COMMON), projectToKind(COMMON, COMMON.kind), '戻した後の実効は共通');
});

test('【S6】RC 欄: SteelSlab には出さず、RcSlab には従来どおり出す', () => {
  const defs = [{ key: 'thickness' }, { key: 'slabKind' }];
  assert.deepEqual(slabCardFields(new SteelSlab('s', null, new Set()), defs), []);
  assert.equal(slabCardFields(new RcSlab('r', null, new Set()), defs), defs);
});

test('【S6・番号】署名: 共通に従う SteelSlab は同署名、個別仕様が違えば別署名、RC 項目は署名に入らない', () => {
  const a = new SteelSlab('a', null, new Set(['1:2:3:4']));
  const b = new SteelSlab('b', null, new Set(['5:6:7:8']), { thickness: 300 }); // 基底の厚は無視される
  const c = new SteelSlab('c', null, new Set(['9:10:11:12']), { steelSpec: projectToKind(COMMON, SteelSlabKind.ALC) });
  const d = new SteelSlab('d', null, new Set(), { steelSpec: projectToKind(COMMON, SteelSlabKind.ALC) });
  assert.equal(memberSignature(a, 'slabMap'), memberSignature(b, 'slabMap'));
  assert.notEqual(memberSignature(a, 'slabMap'), memberSignature(c, 'slabMap'));
  assert.equal(memberSignature(c, 'slabMap'), memberSignature(d, 'slabMap'), '同じ個別仕様は同署名');
  assert.ok(!/thickness|slabKind|mainBars/.test(memberSignature(a, 'slabMap')));
  assert.equal(memberSpecString(c, 'slabMap'), '', '台帳の spec は書き戻し対象外（setField で steelSpec を壊さない）');
});

test('【S6・番号】RcSlab の署名・spec 文字列は従来どおり（回帰）', () => {
  const rc = new RcSlab('r', null, new Set());
  assert.match(memberSignature(rc, 'slabMap'),
    /^slabMap\|.*\|RC\|thickness=150\|slabKind=slab\|deckDirection=x\|mainBars\.size=D10\|mainBars\.pitch=200\|distributionBars\.size=D10\|distributionBars\.pitch=200$/);
  assert.equal(memberSpecString(rc, 'slabMap'),
    'thickness=150|slabKind=slab|deckDirection=x|mainBars.size=D10|mainBars.pitch=200|distributionBars.size=D10|distributionBars.pitch=200');
});
