import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  STORY_HEIGHT_MIN_MM, STORY_HEIGHT_FALLBACK_MM,
  legacyTopStoryHeightMm, topStoryHeightMmOf, resolveTopStoryHeightMm, storyHeightsMm, eaveTopZMm,
} from './floorHeights.js';
import { TRADITIONAL_WOOD_STRUCTURE, TRADITIONAL_WOOD_FRAMING } from './structural/structureRules.js';
import { Project } from './core/project.js';

test('定数: 階高の下限 1450・フォールバック 3000', () => {
  assert.equal(STORY_HEIGHT_MIN_MM, 1450);
  assert.equal(STORY_HEIGHT_FALLBACK_MM, 3000);
});

test('legacyTopStoryHeightMm: 在来木造は 3000 − 横架材天端オフセット（2900）、framing の無い構造・未定・未知は 3000', () => {
  assert.equal(legacyTopStoryHeightMm(TRADITIONAL_WOOD_STRUCTURE), 3000 - TRADITIONAL_WOOD_FRAMING.beamTopBelowFLMm);
  assert.equal(legacyTopStoryHeightMm(TRADITIONAL_WOOD_STRUCTURE), 2900);
  for (const s of ['S造', 'SRC造', 'RC造(ラーメン)', 'RC造(壁式)', '木造（2"×4"）', '未定', undefined, null, 'どこにもない構造']) {
    assert.equal(legacyTopStoryHeightMm(s), 3000, String(s));
  }
});

test('topStoryHeightMmOf: 設定値（有限の正数）が優先される。構造に依らない', () => {
  assert.equal(topStoryHeightMmOf({ topStoryHeightMm: 2750 }, TRADITIONAL_WOOD_STRUCTURE), 2750);
  assert.equal(topStoryHeightMmOf({ topStoryHeightMm: 3333.5 }, 'S造'), 3333.5);
});

test('【失敗系】topStoryHeightMmOf: 0・負・NaN・Infinity・非数・未定義・plane 無しは legacy', () => {
  for (const bad of [0, -1, NaN, Infinity, '2750', undefined, null]) {
    assert.equal(topStoryHeightMmOf({ topStoryHeightMm: bad }, TRADITIONAL_WOOD_STRUCTURE), 2900, String(bad));
    assert.equal(topStoryHeightMmOf({ topStoryHeightMm: bad }, 'S造'), 3000, String(bad));
  }
  assert.equal(topStoryHeightMmOf(null, TRADITIONAL_WOOD_STRUCTURE), 2900);
  assert.equal(topStoryHeightMmOf(undefined, 'S造'), 3000);
});

test('topStoryHeightMmOf: 読んでも plane へ書き込まない', () => {
  const plane = { topStoryHeightMm: 0 };
  topStoryHeightMmOf(plane, TRADITIONAL_WOOD_STRUCTURE);
  assert.equal(plane.topStoryHeightMm, 0);
});

// ---- storyHeightsMm / eaveTopZMm ----
test('storyHeightsMm: 不均一な階高（最上階以外は次の階との差、最上階は topHeightMm）', () => {
  const planes = [
    { id: 'a', elevation: 0, stories: 1 },
    { id: 'b', elevation: 2800, stories: 1 },
    { id: 'c', elevation: 6000, stories: 1 },
  ];
  const m = storyHeightsMm(planes, 2900);
  assert.deepEqual([...m], [['a', 2800], ['b', 3200], ['c', 2900]]);
});

test('storyHeightsMm: 複層（stories=2）は 1層分に割る。最上階が複層でも topHeightMm は 1層分のまま', () => {
  const planes = [
    { id: 'a', elevation: 0, stories: 2 },
    { id: 'b', elevation: 6400, stories: 2 },
  ];
  assert.deepEqual([...storyHeightsMm(planes, 3000)], [['a', 3200], ['b', 3000]]);
});

test('storyHeightsMm: 地階を含む3階建て以上（地階の elevation は負）', () => {
  const planes = [
    { id: 'b2', elevation: -6000, stories: 1 },
    { id: 'b1', elevation: -3000, stories: 1 },
    { id: 'f1', elevation: 0, stories: 1 },
    { id: 'f2', elevation: 3000, stories: 1 },
    { id: 'f3', elevation: 6200, stories: 1 },
  ];
  assert.deepEqual([...storyHeightsMm(planes, 2900)],
    [['b2', 3000], ['b1', 3000], ['f1', 3000], ['f2', 3200], ['f3', 2900]]);
});

test('storyHeightsMm: project.planes（検討案・屋根専用平面を除く）を渡せば採用階だけが入る', () => {
  const project = new Project('proj', 'test');
  project.addPlane(0, '1階', 'p1', 1, 1);
  project.addPlane(3100, '2階', 'p2', 2, 1);
  project.addPlane(0, '検討A', 'alt1', 1, 1, true, 'p1', 0);
  project.addPlane(9999, '小屋伏', 'roof', 1, 1, false, null, 0, true, 'p2');
  const m = storyHeightsMm(project.planes, 3000);
  assert.deepEqual([...m], [['p1', 3100], ['p2', 3000]]);
  assert.equal(m.has('alt1'), false);
  assert.equal(m.has('roof'), false);
});

test('storyHeightsMm: 階が無ければ空の Map', () => {
  assert.equal(storyHeightsMm([], 3000).size, 0);
});

test('eaveTopZMm: 最上階 elevation + 1層分の階高 × stories（複層の最上階）', () => {
  const planes = [
    { id: 'a', elevation: 0, stories: 1 },
    { id: 'b', elevation: 3000, stories: 2 },
  ];
  assert.equal(eaveTopZMm(planes, 2900), 3000 + 2900 * 2);
  assert.equal(eaveTopZMm([{ id: 'a', elevation: 0, stories: 1 }], 2900), 2900);
});

test('【失敗系】eaveTopZMm: 階が無ければ null', () => {
  assert.equal(eaveTopZMm([], 3000), null);
});

test('データモデル: Plane.topStoryHeightMm の既定は 0（addPlane 引数省略）、Project.glBelow1FlMm の既定は 0 で setGlBelow1FlMm で変わる', () => {
  const project = new Project('proj', 'test');
  const { plane } = project.addPlane(0, '1階', 'p1', 1, 1);
  assert.equal(plane.topStoryHeightMm, 0);
  assert.equal(project.addPlane(3000, '2階', 'p2', 2, 1, false, null, 0, false, null, undefined, undefined, 2700).plane.topStoryHeightMm, 2700);
  assert.equal(project.glBelow1FlMm, 0);
  project.setGlBelow1FlMm(300);
  assert.equal(project.glBelow1FlMm, 300);
});

// ---- resolveTopStoryHeightMm ----
function makeProject(structure, topSetting) {
  const project = new Project('proj', 'test');
  project.addPlane(0, '1階', 'p1', 1, 1);
  const { plane } = project.addPlane(3000, '2階', 'p2', 2, 1);
  if (topSetting !== undefined) plane.topStoryHeightMm = topSetting;
  project.structuralInfo.mainStructure = structure;
  return project;
}

test('resolveTopStoryHeightMm: 最上階の未設定は建物全体の構造から legacy（在来木造 2900・S造 3000）', () => {
  assert.equal(resolveTopStoryHeightMm(makeProject(TRADITIONAL_WOOD_STRUCTURE)), 2900);
  assert.equal(resolveTopStoryHeightMm(makeProject('S造')), 3000);
});

test('resolveTopStoryHeightMm: 設定値は最上階のものだけを読む（最上階以外の値は無視）', () => {
  const project = makeProject(TRADITIONAL_WOOD_STRUCTURE, 2600);
  project.planeMap.get('p1').topStoryHeightMm = 1800; // 最上階ではない
  assert.equal(resolveTopStoryHeightMm(project), 2600);
  project.planeMap.get('p2').topStoryHeightMm = 0;
  assert.equal(resolveTopStoryHeightMm(project), 2900);
});

test('resolveTopStoryHeightMm: 検討案・屋根専用平面は最上階に数えない', () => {
  const project = makeProject('S造', 2500);
  project.addPlane(3000, '検討B', 'alt2', 2, 1, true, 'p2', 0);
  project.addPlane(9000, '小屋伏', 'roof', 1, 1, false, null, 0, true, 'p2');
  project.planeMap.get('alt2').topStoryHeightMm = 1111;
  project.planeMap.get('roof').topStoryHeightMm = 2222;
  assert.equal(resolveTopStoryHeightMm(project), 2500);
});

test('【失敗系】resolveTopStoryHeightMm: 採用階が無い・project が無いときは legacy（例外にしない）', () => {
  assert.equal(resolveTopStoryHeightMm(new Project('proj', 'empty')), 3000);
  assert.equal(resolveTopStoryHeightMm(null), 3000);
});
