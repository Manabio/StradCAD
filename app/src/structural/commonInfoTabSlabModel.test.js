// 共通タブ「スラブ（S造）」欄の純モデル（S造スラブ指定 S5・2026-10-29）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  showSteelSlabSection, steelSlabCommonRows, planSlabEdit, nextSpecOnChange, commitSteelSlabSpec,
  SLAB_REMOVED_CODE_SUFFIX, ALC_THICKNESS_NOTE, BRACE_HEIGHT_PLACEHOLDER, SLAB_ROW_KIND,
} from './commonInfoTabSlabModel.js';
import { StructuralInfo } from '../core/structuralInfo.js';
import {
  defaultSteelSlabSpec, SteelSlabKind, BraceMemberType, ANGLE_BRACE_SPECS, ROUND_BAR_BRACE_SPECS,
} from './steelSlabSpec.js';

const MATERIALS = [
  { code: '201600000001', name: 'QL99-50-10', thickness: 50 },
  { code: '201600000002', name: 'QL99-75-10', thickness: 75 },
  { code: '201700000001', name: 'JF50', thickness: 50 },
  { code: '201700000002', name: 'JFPL調整', thickness: 50 },
  { code: '301200000008', name: 'ALC-100', thickness: 100 },
  { code: '301200000009', name: 'ALC-125', thickness: 125 },
  { code: '100000000001', name: '無関係', thickness: 12 },
];
const spec = (over = {}) => ({ ...defaultSteelSlabSpec(), ...over });
const project = main => ({ structuralInfo: { mainStructure: main } });
const graph = (override = null) => ({ structureOverride: override, plane: null });
const rowsOf = over => steelSlabCommonRows({ spec: spec(over), materials: MATERIALS });
const keys = r => r.rows.map(x => x.key);

test('【S5・表示】建物がS造なら出る／階の上書きだけがS造でも出る／どちらでもなければ出ない', () => {
  assert.equal(showSteelSlabSection(graph(), project('S造')), true);
  assert.equal(showSteelSlabSection(graph('S造'), project('RC造')), true);
  assert.equal(showSteelSlabSection(graph(), project('RC造')), false);
  assert.equal(showSteelSlabSection(graph(), project('在来木造')), false);
});

test('【S5・表示】建物がS造で階だけ別構造に上書きされていても入口は残る', () => {
  assert.equal(showSteelSlabSection(graph('RC造'), project('S造')), true);
});

test('【S5・行】デッキ: プレート（2016帯）・コンクリート種別・厚・上面FL−', () => {
  const r = rowsOf({ kind: SteelSlabKind.DECK });
  assert.deepEqual(keys(r), ['deckPlateCode', 'concreteType', 'concreteThicknessMm', 'concreteTopBelowFlMm']);
  assert.deepEqual(r.rows[0].options, [
    { value: '201600000001', label: 'QL99-50-10' }, { value: '201600000002', label: 'QL99-75-10' },
  ]);
  assert.deepEqual(r.rows[1].options.map(o => o.label), ['普通', '軽量']);
  assert.equal(r.rows[2].kind, SLAB_ROW_KIND.NUMBER);
  assert.equal(r.rows[2].unit, 'mm');
  assert.deepEqual(r.kindRow.options.map(o => o.label), ['デッキプレート', 'フラットデッキ', 'ブレース', 'ALC']);
  assert.equal(r.kindRow.label, '種別');
});

test('【S5・行】フラットデッキ: 調整プレート（JFPL）は選択肢に出ない', () => {
  const r = rowsOf({ kind: SteelSlabKind.FLAT_DECK });
  assert.deepEqual(keys(r), ['flatDeckPlateCode', 'concreteType', 'concreteThicknessMm', 'concreteTopBelowFlMm']);
  assert.deepEqual(r.rows[0].options.map(o => o.value), ['201700000001']);
});

test('【S5・行】ブレース: 規格の選択肢は種別で変わり、設置高さが空なら薄字（自動）', () => {
  const round = rowsOf({ kind: SteelSlabKind.BRACE });
  assert.deepEqual(keys(round), ['braceMemberType', 'braceSpec', 'braceHeightMm']);
  assert.deepEqual(round.rows[1].options.map(o => o.value), [...ROUND_BAR_BRACE_SPECS]);
  assert.equal(round.rows[2].value, null);
  assert.equal(round.rows[2].placeholder, BRACE_HEIGHT_PLACEHOLDER);
  const angle = rowsOf({ kind: SteelSlabKind.BRACE, braceMemberType: BraceMemberType.ANGLE, braceSpec: ANGLE_BRACE_SPECS[0] });
  assert.deepEqual(angle.rows[1].options.map(o => o.value), [...ANGLE_BRACE_SPECS]);
});

test('【S5・行】ALC: 厚は読取専用で選択中の材料の thickness（材料を替えれば追従）', () => {
  const a = rowsOf({ kind: SteelSlabKind.ALC, alcCode: '301200000008' });
  assert.deepEqual(keys(a), ['alcCode', 'alcThickness', 'alcTopBelowFlMm', 'raiseChannelSpec']);
  assert.equal(a.rows[1].kind, SLAB_ROW_KIND.READONLY);
  assert.equal(a.rows[1].value, '100');
  assert.equal(a.rows[1].note, ALC_THICKNESS_NOTE);
  assert.equal(rowsOf({ kind: SteelSlabKind.ALC, alcCode: '301200000009' }).rows[1].value, '125');
});

test('【S5・行】カタログに無いコードが現在値なら選択肢の先頭へ補う（ALC の厚は空）', () => {
  const r = rowsOf({ kind: SteelSlabKind.ALC, alcCode: '301200000099' });
  assert.deepEqual(r.rows[0].options[0], { value: '301200000099', label: `301200000099${SLAB_REMOVED_CODE_SUFFIX}` });
  assert.equal(r.rows[0].options.length, 3);
  assert.equal(r.rows[1].value, '');
});

test('【S5・編集】braceMemberType を替えて規格が合わなければ同じ差分で規格を新種別の既定へ', () => {
  const s = spec({ braceMemberType: BraceMemberType.ROUND_BAR, braceSpec: 'M20' });
  assert.deepEqual(nextSpecOnChange(s, 'braceMemberType', BraceMemberType.ANGLE),
    { braceMemberType: BraceMemberType.ANGLE, braceSpec: ANGLE_BRACE_SPECS[0] });
  const back = spec({ braceMemberType: BraceMemberType.ANGLE, braceSpec: ANGLE_BRACE_SPECS[2] });
  assert.deepEqual(nextSpecOnChange(back, 'braceMemberType', BraceMemberType.ROUND_BAR),
    { braceMemberType: BraceMemberType.ROUND_BAR, braceSpec: 'M16' });
  // 規格が新種別にもあれば触らない（同じ種別への再選択）
  assert.deepEqual(nextSpecOnChange(s, 'braceMemberType', BraceMemberType.ROUND_BAR), { braceMemberType: BraceMemberType.ROUND_BAR });
});

test('【S5・編集】種別を替えても差分は kind だけ（他種別の選択は共通仕様に残る）', () => {
  const s = spec({ concreteThicknessMm: 180 });
  const r = planSlabEdit({ spec: s, key: 'kind', value: SteelSlabKind.ALC, materials: MATERIALS });
  assert.deepEqual(r, { error: null, patch: { kind: SteelSlabKind.ALC } });
  assert.equal(planSlabEdit({ spec: s, key: 'kind', value: 'xx', materials: MATERIALS }).error, '種別が不正です');
});

test('【S5・編集】数値: 文字列は数値へ、設置高さの空は null（自動）', () => {
  const s = spec({ kind: SteelSlabKind.DECK });
  assert.deepEqual(planSlabEdit({ spec: s, key: 'concreteThicknessMm', value: '180', materials: MATERIALS }).patch,
    { concreteThicknessMm: 180 });
  const b = spec({ kind: SteelSlabKind.BRACE, braceHeightMm: 100 });
  assert.deepEqual(planSlabEdit({ spec: b, key: 'braceHeightMm', value: '', materials: MATERIALS }).patch, { braceHeightMm: null });
  assert.deepEqual(planSlabEdit({ spec: b, key: 'braceHeightMm', value: '0', materials: MATERIALS }).patch, { braceHeightMm: 0 });
});

test('【S5・編集】不正入力は書かずに日本語の理由を返す（負の厚・数値でない文字・負のFL−・プレートの帯違い）', () => {
  const s = spec({ kind: SteelSlabKind.DECK });
  const t = planSlabEdit({ spec: s, key: 'concreteThicknessMm', value: '-5', materials: MATERIALS });
  assert.deepEqual(t, { error: '厚は0より大きい数値で入力してください', patch: null });
  assert.equal(planSlabEdit({ spec: s, key: 'concreteThicknessMm', value: 'abc', materials: MATERIALS }).error,
    '厚は0より大きい数値で入力してください');
  assert.equal(planSlabEdit({ spec: s, key: 'concreteThicknessMm', value: '', materials: MATERIALS }).patch, null);
  assert.equal(planSlabEdit({ spec: s, key: 'concreteTopBelowFlMm', value: '-1', materials: MATERIALS }).error,
    '上面のFL−は0以上の数値で入力してください');
  assert.equal(planSlabEdit({ spec: s, key: 'deckPlateCode', value: '301200000008', materials: MATERIALS }).error,
    'デッキプレートの材料コードが不正です');
  const b = spec({ kind: SteelSlabKind.BRACE });
  assert.equal(planSlabEdit({ spec: b, key: 'braceHeightMm', value: '-3', materials: MATERIALS }).error,
    '設置高さは0以上の数値で入力してください');
});

test('【S5・編集】規格は現在の種別の選択肢で検証する', () => {
  const b = spec({ kind: SteelSlabKind.BRACE, braceMemberType: BraceMemberType.ROUND_BAR });
  assert.equal(planSlabEdit({ spec: b, key: 'braceSpec', value: 'M20', materials: MATERIALS }).error, null);
  assert.equal(planSlabEdit({ spec: b, key: 'braceSpec', value: ANGLE_BRACE_SPECS[0], materials: MATERIALS }).error,
    'ブレースの規格が選択肢にありません');
});

test('【S5・行】材料が未読込み（undefined）なら現在値はコードのまま補い「カタログに無い」を付けない', () => {
  const r = steelSlabCommonRows({ spec: spec({ kind: SteelSlabKind.ALC, alcCode: '301200000099' }), materials: undefined });
  assert.deepEqual(r.rows[0].options, [{ value: '301200000099', label: '301200000099' }]);
});

test('【S5・書込み】厚の確定で、編集していない項目・選択中でない種別の消えた材料コードは既定へ落ちない（commitSteelSlabSpec）', () => {
  const info = new StructuralInfo();
  info.setSteelSlabSpec({ ...defaultSteelSlabSpec(), deckPlateCode: '201600099999', alcCode: '301200099999' });
  assert.equal(info.steelSlabSpec.deckPlateCode, '201600099999');
  const { error, patch } = planSlabEdit({ spec: info.steelSlabSpec, key: 'concreteThicknessMm', value: '120', materials: MATERIALS });
  assert.equal(error, null);
  commitSteelSlabSpec(info, patch);
  assert.equal(info.steelSlabSpec.concreteThicknessMm, 120);
  assert.equal(info.steelSlabSpec.deckPlateCode, '201600099999');
  assert.equal(info.steelSlabSpec.alcCode, '301200099999');
});

test('【S5・編集】値が変わらない確定は patch=null（同じ数値・空→null の据置き・同じ種別への再選択）', () => {
  const s = spec({ kind: SteelSlabKind.DECK, concreteThicknessMm: 150 });
  assert.deepEqual(planSlabEdit({ spec: s, key: 'concreteThicknessMm', value: '150', materials: MATERIALS }), { error: null, patch: null });
  const b = spec({ kind: SteelSlabKind.BRACE, braceHeightMm: null });
  assert.deepEqual(planSlabEdit({ spec: b, key: 'braceHeightMm', value: '', materials: MATERIALS }), { error: null, patch: null });
  assert.equal(planSlabEdit({ spec: s, key: 'kind', value: SteelSlabKind.DECK, materials: MATERIALS }).patch, null);
  assert.equal(planSlabEdit({ spec: b, key: 'braceMemberType', value: b.braceMemberType, materials: MATERIALS }).patch, null);
  assert.notEqual(planSlabEdit({ spec: s, key: 'concreteThicknessMm', value: '151', materials: MATERIALS }).patch, null);
});
