// 図面モードの汎用 State（PlacedFigureModeState）の単体テスト。def は試験用の行を直接渡す（定義表は本番では空）。
// undo は仕上げモード以外の State から積んでも undoManager.undo()／redo() で往復することを「置く→undo→redo」で固定する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInAction } from 'mobx';
import { DetailSubject, DetailView } from '../core/constants.js';
import { PlacedFigure } from '../core/placedFigure.js';
import { undoManager } from '../undoManager.js';
import { makeFirstFloorGraph } from '../graphTestFixtures.js';
import { square } from '../finish/placedFigure/placedFigureTestFixtures.js';
import { PlacedFigureModeState } from './PlacedFigureModeState.js';

const DEF = { mode: 'plumbingTest', label: '給排水（試験）', subjects: [DetailSubject.SANITARY] };
const FIGS = [
  square('san', { subject: DetailSubject.SANITARY }),
  square('fur', { subject: DetailSubject.FURNITURE }),
  square('elev', { view: DetailView.ELEVATION }),
];
const figureOf = key => FIGS.find(f => f.key === key) ?? null;
const depth = () => undoManager._undoStack.length;
const TAP = { tolMm: 0, mmPerPx: 1 };
const brief = graph => graph.placedFigures.map(p => [p.id, p.figureKey, p.x, p.y, p.rotationDeg, p.mirror]);

function make(initial = []) {
  const graph = makeFirstFloorGraph();
  graph.setPlacedFigures(initial.map(([id, key, x, y]) => new PlacedFigure({ id, figureKey: key, x, y })));
  return { graph, state: new PlacedFigureModeState(graph, DEF, { figureOf }) };
}
// san（所属）a・fur（他モードの分類）f・参照切れ（分類不明＝所属）g
const seeded = () => make([['a', 'san', 100, 50], ['f', 'fur', 300, 50], ['g', 'gone', 500, 50]]);

test('配置→undo→redo: 1 エントリで 0 件↔1 件（id・座標一致）・丸め・選択・配置待ち解除', () => {
  const { graph, state } = make();
  const d0 = depth();
  state.beginFigurePlacement('san');
  assert.equal(state.placingFigureKey, 'san');
  state.tapAt(300.4, -100.6, TAP);
  assert.equal(depth(), d0 + 1);
  assert.equal(graph.placedFigures.length, 1);
  const [p] = graph.placedFigures;
  assert.deepEqual([p.figureKey, p.x, p.y], ['san', 300, -101]);
  assert.equal(state.placingFigureKey, null);
  assert.equal(state.selectedPlacedFigureId, p.id);
  assert.equal(state.selectedPlacedFigure.id, p.id);
  const snapshot = brief(graph);
  undoManager.undo();
  assert.equal(graph.placedFigures.length, 0);
  assert.equal(state.selectedPlacedFigure?.id ?? null, null, 'undo で消えた選択は null に見える');
  undoManager.redo();
  assert.equal(JSON.stringify(brief(graph)), JSON.stringify(snapshot));
  assert.equal(state.selectedPlacedFigure.id, p.id);
  undoManager.undo();
});

test('beginFigurePlacement: 他モードの分類・引けない図キー・空文字・非文字列は無視（何も変えない）。移動待ちは解く', () => {
  const { state } = seeded();
  state.beginFigureMove('a');
  state.beginFigurePlacement('fur');
  state.beginFigurePlacement('gone');
  state.beginFigurePlacement('elev');
  state.beginFigurePlacement('');
  state.beginFigurePlacement(null);
  assert.equal(state.placingFigureKey, null);
  assert.equal(state.movingFigureId, 'a');
  state.beginFigurePlacement('san');
  assert.equal(state.placingFigureKey, 'san');
  assert.equal(state.movingFigureId, null);
  state.cancelFigurePlacement();
  assert.equal(state.placingFigureKey, null);
});

test('beginFigureMove: 所属する配置なら配置待ちを解いて移動待ちにする。所属しない id は配置待ちを残す', () => {
  const { state } = seeded();
  state.beginFigurePlacement('san');
  state.beginFigureMove('f');
  assert.deepEqual([state.placingFigureKey, state.movingFigureId], ['san', null]);
  state.beginFigureMove('a');
  assert.deepEqual([state.placingFigureKey, state.movingFigureId], [null, 'a']);
});

test('beginFigureMove: 移動待ちにした配置は選択もする。別の配置を選択中なら選択が移り、移動のタップ後も選択はその配置のまま', () => {
  const { graph, state } = seeded();
  state.selectPlacedFigure('g');
  state.beginFigureMove('a');
  assert.equal(state.selectedPlacedFigureId, 'a');
  assert.equal(state.movingFigureId, 'a');
  state.tapAt(700, 700, TAP);
  assert.equal(state.selectedPlacedFigureId, 'a');
  assert.equal(state.movingFigureId, null);
  assert.equal(graph.placedFigures.find(p => p.id === 'a').x, 700);
  undoManager.undo();
});

test('選択と移動待ちを食い違わせない: 移動待ちの間に別の配置を選ぶ・選択を解除すると移動待ちが解ける。同じ配置の選び直し・所属しない id では解けない', () => {
  const { graph, state } = seeded();
  const d0 = depth();
  state.beginFigureMove('a');
  state.selectPlacedFigure('a');
  assert.deepEqual([state.selectedPlacedFigureId, state.movingFigureId], ['a', 'a'], '同じ配置の選び直しでは解けない');
  state.selectPlacedFigure('f');
  assert.deepEqual([state.selectedPlacedFigureId, state.movingFigureId], ['a', 'a'], '所属しない id は無視');
  state.selectPlacedFigure('g');
  assert.deepEqual([state.selectedPlacedFigureId, state.movingFigureId], ['g', null], '別の配置を選ぶと解ける');
  state.tapAt(900, 900, TAP);
  const a = graph.placedFigures.find(p => p.id === 'a');
  assert.deepEqual([a.x, a.y], [100, 50], '解けた後のタップでは動かない');
  assert.equal(depth(), d0);
  state.beginFigureMove('a');
  state.selectPlacedFigure(null);
  assert.deepEqual([state.selectedPlacedFigureId, state.movingFigureId], [null, null], '選択の解除でも解ける');
});

test('【失敗系】beginFigureMove: 所属しない id・無い id は選択も移動待ちも変えない', () => {
  const { state } = seeded();
  state.selectPlacedFigure('g');
  state.beginFigureMove('f');
  state.beginFigureMove('nope');
  assert.deepEqual([state.selectedPlacedFigureId, state.movingFigureId], ['g', null]);
});

test('【失敗系】移動待ちに所属しない id が入っていても動かさず、解くだけで何も積まない', () => {
  const { graph, state } = seeded();
  runInAction(() => { state.movingFigureId = 'f'; });
  const d0 = depth();
  state.tapAt(900, 900, TAP);
  const f = graph.placedFigures.find(p => p.id === 'f');
  assert.deepEqual([f.x, f.y], [300, 50]);
  assert.equal(depth(), d0);
  assert.equal(state.movingFigureId, null);
});

test('タップの優先: 配置待ち ＞ 移動待ち ＞ ヒット', () => {
  const { graph, state } = seeded();
  const d0 = depth();
  runInAction(() => { state.placingFigureKey = 'san'; state.movingFigureId = 'a'; });
  state.tapAt(700, 700, TAP);
  assert.equal(graph.placedFigures.length, 4, '配置待ちが先に効いて置く');
  assert.equal(state.movingFigureId, 'a', '移動待ちは残る');
  assert.equal(state.placingFigureKey, null);
  state.tapAt(900, 900, TAP);
  assert.equal(graph.placedFigures.find(p => p.id === 'a').x, 900, '次は移動待ちが効く');
  assert.equal(state.movingFigureId, null);
  state.tapAt(910, 910, TAP);
  assert.equal(state.selectedPlacedFigureId, 'a', '最後はヒット（移動後の a）');
  assert.equal(depth(), d0 + 2);
  undoManager.undo();
  undoManager.undo();
});

test('移動: 丸めた点へ 1 エントリ・選択維持・移動待ち解除。undo で戻る', () => {
  const { graph, state } = seeded();
  state.selectPlacedFigure('a');
  state.beginFigureMove('a');
  const d0 = depth();
  state.tapAt(400.4, 80.6, TAP);
  assert.equal(depth(), d0 + 1);
  const a = graph.placedFigures.find(p => p.id === 'a');
  assert.deepEqual([a.x, a.y], [400, 81]);
  assert.equal(state.movingFigureId, null);
  assert.equal(state.selectedPlacedFigureId, 'a');
  undoManager.undo();
  const back = graph.placedFigures.find(p => p.id === 'a');
  assert.deepEqual([back.x, back.y], [100, 50]);
});

test('【失敗系】移動待ちの id が既に無ければ解くだけで何も積まない', () => {
  const { graph, state } = seeded();
  state.beginFigureMove('a');
  graph.setPlacedFigures(graph.placedFigures.filter(p => p.id !== 'a')); // undo で消えた相当
  const d0 = depth();
  state.tapAt(400, 80, TAP);
  assert.equal(state.movingFigureId, null);
  assert.equal(depth(), d0);
  assert.equal(graph.placedFigures.length, 2);
});

test('ヒット: 当たれば選択・空振りで選択解除。他モードの分類は当たらず、分類不明は当たる', () => {
  const { state } = seeded();
  state.tapAt(110, 60, TAP);
  assert.equal(state.selectedPlacedFigureId, 'a');
  state.tapAt(310, 60, TAP);
  assert.equal(state.selectedPlacedFigureId, null, '他モードの分類 f は当たらず空振り＝解除');
  state.tapAt(500, 50, TAP);
  assert.equal(state.selectedPlacedFigureId, 'g');
  state.tapAt(2000, 2000, TAP);
  assert.equal(state.selectedPlacedFigureId, null);
});

test('【失敗系】所属しない id・無い id は update・rotate・mirror・remove・select・beginFigureMove・note が無変更で undo も積まない', () => {
  const { graph, state } = seeded();
  state.selectPlacedFigure('a');
  const before = JSON.stringify(graph.placedFigures.map(p => p.toData()));
  const d0 = depth();
  for (const id of ['f', 'nope']) {
    state.updatePlacedFigure(id, { x: 1 });
    state.rotatePlacedFigure(id);
    state.togglePlacedFigureMirror(id);
    state.removePlacedFigure(id);
    state.selectPlacedFigure(id);
    state.beginFigureMove(id);
    state.setPlacedFigureNote(id, 'memo');
  }
  assert.equal(JSON.stringify(graph.placedFigures.map(p => p.toData())), before);
  assert.equal(depth(), d0);
  assert.equal(state.selectedPlacedFigureId, 'a');
  assert.equal(state.movingFigureId, null);
});

test('所属する配置の update・rotate・mirror が 1 エントリずつ積まれ、note は積まない', () => {
  const { graph, state } = seeded();
  const d0 = depth();
  state.updatePlacedFigure('a', { x: 120 });
  state.rotatePlacedFigure('a');
  state.togglePlacedFigureMirror('a');
  assert.equal(depth(), d0 + 3);
  const a = graph.placedFigures.find(p => p.id === 'a');
  assert.deepEqual([a.x, a.rotationDeg, a.mirror], [120, 90, true]);
  state.setPlacedFigureNote('a', 'memo');
  assert.equal(graph.placedFigures.find(p => p.id === 'a').note, 'memo');
  assert.equal(depth(), d0 + 3);
  undoManager.undo();
  undoManager.undo();
  undoManager.undo();
});

test('remove: 選択・移動待ちも解く（無関係な選択は残す）。undo で戻る', () => {
  const { graph, state } = seeded();
  state.selectPlacedFigure('a');
  state.beginFigureMove('a');
  state.removePlacedFigure('a');
  assert.equal(state.selectedPlacedFigureId, null);
  assert.equal(state.movingFigureId, null);
  assert.equal(graph.placedFigures.some(p => p.id === 'a'), false);
  undoManager.undo();
  assert.equal(graph.placedFigures.some(p => p.id === 'a'), true);
  state.selectPlacedFigure('g');
  state.removePlacedFigure('a');
  assert.equal(state.selectedPlacedFigureId, 'g');
  undoManager.undo();
});

test('remove: 移動待ち a の間に別の配置 g を消しても、移動待ちと選択は a のまま', () => {
  const { state } = seeded();
  state.beginFigureMove('a');
  state.removePlacedFigure('g');
  assert.deepEqual([state.movingFigureId, state.selectedPlacedFigureId], ['a', 'a']);
  undoManager.undo();
});

test('movingFigure: 実在する移動待ちだけが見える（undo で消えた移動待ちは null＝帯・カーソルを出さない）。次のタップで id も解ける', () => {
  const { state } = make();
  const d0 = depth();
  state.beginFigurePlacement('san');
  state.tapAt(300, 100, TAP);
  const id = state.selectedPlacedFigureId;
  assert.equal(state.movingFigure, null);
  state.beginFigureMove(id);
  assert.equal(state.movingFigure?.id ?? null, id);
  undoManager.undo(); // 置いた配置が消える
  assert.equal(state.movingFigureId, id, 'id は残る');
  assert.equal(state.movingFigure?.id ?? null, null, '実在しないので見えない');
  state.tapAt(500, 500, TAP);
  assert.equal(state.movingFigureId, null);
  assert.equal(depth(), d0);
});

test('placedFiguresInMode は所属（分類不明を含む）を graph の並びのまま返す。selectPlacedFigure(null) で解除', () => {
  const { state } = seeded();
  assert.deepEqual(state.placedFiguresInMode().map(p => p.id), ['a', 'g']);
  state.selectPlacedFigure('g');
  assert.equal(state.selectedPlacedFigure.id, 'g');
  state.selectPlacedFigure(null);
  assert.equal(state.selectedPlacedFigure?.id ?? null, null);
});

test('cancelDrag・dispose は配置待ち・移動待ちを解く（選択は残す）', () => {
  const { state } = seeded();
  state.selectPlacedFigure('a');
  state.beginFigurePlacement('san');
  state.cancelDrag();
  assert.deepEqual([state.placingFigureKey, state.movingFigureId], [null, null]);
  state.beginFigureMove('a');
  state.cancelFigureMove();
  assert.equal(state.movingFigureId, null);
  state.beginFigureMove('a');
  state.dispose();
  assert.deepEqual([state.placingFigureKey, state.movingFigureId, state.selectedPlacedFigureId], [null, null, 'a']);
});
