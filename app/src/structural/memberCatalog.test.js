// memberCatalog.js（WP-B1: 踊り場受け梁 role:'landing' の受け入れ）の単体テスト。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memberSymbol, MEMBER_GROUPS, FIELD_DEFS_BY_CATEGORY, SIGNATURE_FIELDS_BY_MAP, MEMBER_CATEGORY } from './memberCatalog.js';
import { makeBeam } from './memberTestFixtures.js';

test('【WP-B1】memberSymbol: beamMapのrole:landingは記号LGを返す', () => {
  const landing = makeBeam('b1', 'STEEL-H200x100', { role: 'landing' });
  assert.equal(memberSymbol(landing, 'beamMap'), 'LG');
});

test('【WP-B1】MEMBER_GROUPS: 「梁」グループのfilterはrole:secondary/landingの両方を除外する', () => {
  const beamGroup = MEMBER_GROUPS.find(g => g.key === 'beam');
  const primary = makeBeam('b1', 'STEEL-H200x100', { role: 'primary' });
  const secondary = makeBeam('b2', 'STEEL-H200x100', { role: 'secondary' });
  const landing = makeBeam('b3', 'STEEL-H200x100', { role: 'landing' });
  assert.equal(beamGroup.filter(primary), true);
  assert.equal(beamGroup.filter(secondary), false);
  assert.equal(beamGroup.filter(landing), false);
});

test('【WP-B1】MEMBER_GROUPS: 「踊り場梁」グループはrole:landingのみを対象にし、手動追加不可・0件時は非表示', () => {
  const landingGroup = MEMBER_GROUPS.find(g => g.key === 'beamLanding');
  assert.ok(landingGroup);
  assert.equal(landingGroup.mapName, 'beamMap');
  assert.equal(landingGroup.category, MEMBER_CATEGORY.ROD);
  assert.equal(landingGroup.allowManualAdd, false);
  assert.equal(landingGroup.hideWhenEmpty, true);
  const landing = makeBeam('b1', 'STEEL-H200x100', { role: 'landing' });
  const primary = makeBeam('b2', 'STEEL-H200x100', { role: 'primary' });
  const secondary = makeBeam('b3', 'STEEL-H200x100', { role: 'secondary' });
  assert.equal(landingGroup.filter(landing), true);
  assert.equal(landingGroup.filter(primary), false);
  assert.equal(landingGroup.filter(secondary), false);
});

test('【失敗系・WP-B1】MEMBER_GROUPS: 「小梁」グループのfilterはrole:landingの梁を対象に含めない', () => {
  const beamSubGroup = MEMBER_GROUPS.find(g => g.key === 'beamSub');
  const landing = makeBeam('b1', 'STEEL-H200x100', { role: 'landing' });
  assert.equal(beamSubGroup.filter(landing), false);
});

test('【WP-B1】FIELD_DEFS_BY_CATEGORY[ROD]: levelOffsetのラベルは「天端レベル（FL基準）」', () => {
  const field = FIELD_DEFS_BY_CATEGORY[MEMBER_CATEGORY.ROD].find(f => f.key === 'levelOffset');
  assert.ok(field);
  assert.equal(field.label, '天端レベル（FL基準）');
});

test('【WP-B1】SIGNATURE_FIELDS_BY_MAP.beamMapはlevelOffsetを含まない（材寸署名は不変）', () => {
  assert.ok(!SIGNATURE_FIELDS_BY_MAP.beamMap.includes('levelOffset'));
});
