// structural/memberSelection.js（構造リスト選択→伏図ハイライト矩形）の単体テスト。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  memberSelectionRects, sameIdSet,
  MEMBER_SELECTION_MIN_HALF_PX, MEMBER_SELECTION_PAD_PX,
} from './memberSelection.js';

const PX = 2; // 1画面px = 2mm（scale 0.5）
const PAD = MEMBER_SELECTION_PAD_PX * PX;
const MIN_HALF = MEMBER_SELECTION_MIN_HALF_PX * PX;

const SRC = {
  columns:  [{ id: 'c1', x: 100, y: 200, rotation: 30, width: 120, height: 105 }, { id: 'c2', x: 0, y: 0, rotation: 0, width: 120, height: 120 }],
  beams:    [{ id: 'b1', isVertical: false, axisValue: 1000, coord1: 60, coord2: 2940, halfWidth: 60 },
             { id: 'b2', isVertical: true,  axisValue: 500,  coord1: 3000, coord2: 0, halfWidth: null }],
  footings: [{ id: 'f1', x: 10, y: 20, widthX: 800, widthY: 600 }],
  walls:    [{ id: 'w1', isVertical: true, axisValue: 700, coord1: 0, coord2: 4000, half: 75 }],
  slabs:    [{ id: 's1', cells: [{ x1: 0, y1: 0, x2: 1000, y2: 2000 }, { x1: 1000, y1: 0, x2: 3000, y2: 2000 }] }],
};

test('memberSelectionRects: 選択idに含まれる部材だけを返し、分類ごとにキー接頭辞が付く', () => {
  const rects = memberSelectionRects(SRC, new Set(['c1', 'b1', 'f1', 'w1', 's1']), PX);
  assert.deepEqual(rects.map(r => r.key), ['sel:column:c1', 'sel:beam:b1', 'sel:footing:f1', 'sel:wall:w1', 'sel:slab:s1:0', 'sel:slab:s1:1']);
});

test('memberSelectionRects: 柱は中心原点（offset=半分）で回転を引き継ぎ、外形に余白padを足す', () => {
  const [r] = memberSelectionRects(SRC, ['c1'], PX);
  assert.deepEqual(r, {
    key: 'sel:column:c1', x: 100, y: 200, width: 120 + 2 * PAD, height: 105 + 2 * PAD,
    offsetX: (120 + 2 * PAD) / 2, offsetY: (105 + 2 * PAD) / 2, rotation: 30,
  });
});

test('memberSelectionRects: 横梁は軸±(半幅+pad)・スパン[lo-pad, hi+pad]の軸並行矩形', () => {
  const [r] = memberSelectionRects(SRC, ['b1'], PX);
  assert.deepEqual(r, {
    key: 'sel:beam:b1', x: 60 - PAD, y: 1000 - 60 - PAD, width: 2940 - 60 + 2 * PAD, height: 2 * (60 + PAD),
    offsetX: 0, offsetY: 0, rotation: 0,
  });
});

test('memberSelectionRects: 縦梁の単線（halfWidth null）は最小半幅（画面px換算）を使い、coord1>coord2 でも lo/hi を正規化する', () => {
  const [r] = memberSelectionRects(SRC, ['b2'], PX);
  assert.equal(r.x, 500 - MIN_HALF - PAD);
  assert.equal(r.width, 2 * (MIN_HALF + PAD));
  assert.equal(r.y, 0 - PAD);
  assert.equal(r.height, 3000 + 2 * PAD);
});

test('memberSelectionRects: 帯の半幅が最小半幅より太ければ実幅を優先する（細い帯だけ底上げ）', () => {
  const thick = { beams: [{ id: 'b', isVertical: false, axisValue: 0, coord1: 0, coord2: 100, halfWidth: 200 }] };
  const thin  = { beams: [{ id: 'b', isVertical: false, axisValue: 0, coord1: 0, coord2: 100, halfWidth: 1 }] };
  assert.equal(memberSelectionRects(thick, ['b'], PX)[0].height, 2 * (200 + PAD));
  assert.equal(memberSelectionRects(thin,  ['b'], PX)[0].height, 2 * (MIN_HALF + PAD));
});

test('memberSelectionRects: 耐力壁は梁と同じ帯規約、基礎は回転なしの中心原点矩形、スラブはセルごとの矩形（余白なし）', () => {
  const [w] = memberSelectionRects(SRC, ['w1'], PX);
  assert.deepEqual([w.x, w.width, w.y, w.height], [700 - 75 - PAD, 2 * (75 + PAD), -PAD, 4000 + 2 * PAD]);
  const [f] = memberSelectionRects(SRC, ['f1'], PX);
  assert.deepEqual([f.x, f.y, f.width, f.height, f.offsetX, f.offsetY, f.rotation], [10, 20, 800 + 2 * PAD, 600 + 2 * PAD, (800 + 2 * PAD) / 2, (600 + 2 * PAD) / 2, 0]);
  const cells = memberSelectionRects(SRC, ['s1'], PX);
  assert.deepEqual(cells.map(c => [c.x, c.y, c.width, c.height]), [[0, 0, 1000, 2000], [1000, 0, 2000, 2000]]);
});

test('【失敗系】memberSelectionRects: 選択なし・null・未知id・src未定義・配列欠落は空配列（例外を投げない）', () => {
  assert.deepEqual(memberSelectionRects(SRC, new Set(), PX), []);
  assert.deepEqual(memberSelectionRects(SRC, null, PX), []);
  assert.deepEqual(memberSelectionRects(SRC, undefined, PX), []);
  assert.deepEqual(memberSelectionRects(SRC, ['no-such-id'], PX), []);
  assert.deepEqual(memberSelectionRects(undefined, ['c1'], PX), []);
  assert.deepEqual(memberSelectionRects({}, ['c1'], PX), []);
  assert.deepEqual(memberSelectionRects({ slabs: [{ id: 's', cells: undefined }] }, ['s'], PX), []);
});

// ---- 本番経路のソース走査不変条件（team-lessons「テストはヘルパーではなく本番の呼び出し経路を守る」）----
const readSrc = rel => fs.readFileSync(path.resolve(import.meta.dirname, rel), 'utf8');

test('【不変条件】選択の配線: App.jsx は onSelectMembers を useCallback(…, []) の安定参照で渡し、StructuralPanel→MemberListTab へ引き回す', () => {
  const app = readSrc('../App.jsx');
  // 安定参照が崩れると MemberListTab/MemberCard の effect（onSelectMembers を依存に持つ）が App の再レンダー
  // ごとに空回りする。インライン矢印 onSelectMembers={ids => ...} への差し戻しを検出する。
  assert.ok(/const selectStructuralMembers = useCallback\(ids => modeRef\.current\?\.selectMembers\?\.\(ids\), \[\]\);/.test(app),
    'App.jsx: selectStructuralMembers が useCallback(…, []) で定義されていない');
  assert.ok(/onSelectMembers=\{selectStructuralMembers\}/.test(app), 'App.jsx: StructuralPanel へ onSelectMembers={selectStructuralMembers} が渡されていない');
  assert.ok(!/onSelectMembers=\{ids =>/.test(app), 'App.jsx: onSelectMembers がインライン矢印（毎レンダー新しい参照）に戻っている');
  const panel = readSrc('./StructuralPanel.jsx');
  assert.ok(/<MemberListTab[^>]*onSelectMembers=\{onSelectMembers\}/.test(panel), 'StructuralPanel.jsx: MemberListTab へ onSelectMembers が渡されていない');
});

test('【不変条件】選択の配線: MemberListTab は「展開なし」とアンマウントで空にし、MemberCard は展開中に members の id を報告する', () => {
  const src = readSrc('./MemberListTab.jsx');
  assert.ok(/if \(expandedKey == null\) onSelectMembers\?\.\(\[\]\);/.test(src), 'MemberListTab: expandedKey==null で onSelectMembers([]) していない');
  assert.ok(/useEffect\(\(\) => \(\) => onSelectMembersRef\.current\?\.\(\[\]\), \[\]\);/.test(src),
    'MemberListTab: アンマウント時の解除が ref 経由・依存なし（[]）になっていない');
  assert.ok(/if \(isExpanded\) onSelectMembers\?\.\(memberIdsKey \? memberIdsKey\.split\(','\) : \[\]\);/.test(src),
    'MemberCard: 展開中に members の id を報告していない');
  assert.ok(/<MemberCard[\s\S]*?onSelectMembers=\{onSelectMembers\}/.test(src), 'MemberGroupSection: MemberCard へ onSelectMembers が渡されていない');
});

test('【不変条件】選択の描画: SceneLayers は mode.selectedMemberIds を StructuralLayer へ渡し、StructuralLayer は memberSelectionRects で解いた矩形を最後（最前面）の member-selection Group に描く', () => {
  const scene = readSrc('../renderer/SceneLayers.jsx');
  assert.ok(/<StructuralLayer[\s\S]*?selectedMemberIds=\{mode\?\.selectedMemberIds \?\? null\}/.test(scene),
    'SceneLayers.jsx: StructuralLayer へ selectedMemberIds={mode?.selectedMemberIds ?? null} が渡されていない');
  const layer = readSrc('../renderer/StructuralLayer.jsx');
  assert.ok(/memberSelectionRects\(\{/.test(layer), 'StructuralLayer.jsx: memberSelectionRects( を呼んでいない（矩形の解き方をレンダラで再実装している疑い）');
  const selPos = layer.indexOf('name="member-selection"');
  assert.ok(selPos > 0, 'StructuralLayer.jsx: <Group name="member-selection"> が無い');
  for (const marker of ['structuralWalls', 'slabs', 'footings', 'beamDrawSpans.flatMap']) {
    assert.ok(layer.lastIndexOf(marker) < selPos, `StructuralLayer.jsx: ハイライトが ${marker} の描画より前にある（最前面でない）`);
  }
});

test('sameIdSet: 同一要素なら true、要素数・内容が違えば false、null は同一参照のときだけ true', () => {
  assert.equal(sameIdSet(new Set(['a', 'b']), new Set(['b', 'a'])), true);
  assert.equal(sameIdSet(new Set(['a']), new Set(['a', 'b'])), false);
  assert.equal(sameIdSet(new Set(['a']), new Set(['b'])), false);
  assert.equal(sameIdSet(null, new Set()), false);
  assert.equal(sameIdSet(null, null), true);
});
