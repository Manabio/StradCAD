// 図面モードの汎用パネルの判断（候補・一覧の行・部屋名）の単体テスト。
// 末尾の 1 件は「State が実際に返す形（PlacedFigure インスタンス）」と「実カタログのエントリ形（setOverlay → detailFigureCatalog）」を通す。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DetailSubject, DetailView, DETAIL_PRODUCT_FIELD, DetailProductField } from '../../core/constants.js';
import { PlacedFigure } from '../../core/placedFigure.js';
import { DETAIL_PRODUCT_TEXT } from '../../error.js';
import { CatalogKind } from '../../catalog/catalogKinds.js';
import { setOverlay, clearOverlays } from '../../catalog/catalogRegistry.js';
import { detailFigureCatalog, detailFigureEntry } from '../../openings/openingCatalog.js';
import { PlacedFigureModeState } from '../../modes/PlacedFigureModeState.js';
import { makeFirstFloorGraph, makeRectRoom, addCL } from '../../graphTestFixtures.js';
import { CenterLineType, RoomFeature } from '@core';
import { square } from './placedFigureTestFixtures.js';
import { placeableFigureCandidates, productLinesOf, placedFigureRows } from './placedFigureModePanelRows.js';
import { placedFigureRoomNameAt, placedFigureRoomNameLookup } from './placedFigureRooms.js';

const SAN = [DetailSubject.SANITARY];
const product = p => ({ [DETAIL_PRODUCT_FIELD]: p });
const P = DetailProductField;

test.afterEach(() => clearOverlays());

// ---- 候補 ----

test('候補: そのモードの分類の平面の配置図だけ（他の分類・配置図でない図を除く）。並びはカタログのまま', () => {
  const catalog = new Map([
    ['s2', square('s2', { subject: DetailSubject.SANITARY })],
    ['f1', square('f1', { subject: DetailSubject.FURNITURE })],
    ['e1', square('e1', { subject: DetailSubject.SANITARY, view: DetailView.ELEVATION })],
    ['s1', square('s1', { subject: DetailSubject.SANITARY })],
  ]);
  assert.deepEqual(placeableFigureCandidates(catalog, SAN).map(c => c.key), ['s2', 's1']);
  assert.deepEqual(placeableFigureCandidates(catalog, [DetailSubject.FURNITURE, DetailSubject.SANITARY]).map(c => c.key), ['s2', 'f1', 's1']);
});

test('候補: 表示名は 製品名 → 呼称 → キー の順に落ちる', () => {
  const catalog = new Map([
    ['a', { ...square('a', { label: '呼称A' }), ...product({ [P.NAME]: '  便器X  ' }) }],
    ['b', { ...square('b', { label: '呼称B' }), ...product({ [P.NAME]: '   ' }) }],
    ['c', square('c', { label: '' })],
  ]);
  assert.deepEqual(placeableFigureCandidates(catalog, SAN).map(c => c.label), ['便器X', '呼称B', 'c']);
});

test('【失敗系】候補: 空のカタログ・壊れた入力・壊れたエントリは例外にせず除く', () => {
  assert.deepEqual(placeableFigureCandidates(new Map(), SAN), []);
  assert.deepEqual(placeableFigureCandidates(null, SAN), []);
  assert.deepEqual(placeableFigureCandidates(new Map([['a', square('a')]]), null), []);
  assert.deepEqual(placeableFigureCandidates(new Map([['n', null], ['s', 'x'], ['ok', square('ok')]]), SAN).map(c => c.key), ['ok']);
});

// ---- 製品情報・行 ----

test('製品情報: 値がある項目だけを 名称・メーカー・型番・色 の順で（見出しは DETAIL_PRODUCT_TEXT）', () => {
  const fig = product({ [P.COLOR_NAME]: '白', [P.NAME]: '便器X', [P.MODEL_NUMBER]: '  ', [P.MAKER]: '' });
  assert.deepEqual(productLinesOf(fig), [
    { label: DETAIL_PRODUCT_TEXT.name, value: '便器X' },
    { label: DETAIL_PRODUCT_TEXT.colorName, value: '白' },
  ]);
  const all = productLinesOf(product({ [P.COLOR_NAME]: 'c', [P.MODEL_NUMBER]: 'm', [P.MAKER]: 'k', [P.NAME]: 'n' }));
  assert.deepEqual(all.map(l => l.label), ['名称', 'メーカー', '型番', '色']);
  // 値は前後の空白を落として出す（見出しの productDisplayName と同じ）
  assert.deepEqual(productLinesOf(product({ [P.NAME]: '  便器X  ' })).map(l => l.value), ['便器X']);
});

test('【失敗系】製品情報: 図が無い・product が無い・文字列でない値は []／除く', () => {
  assert.deepEqual(productLinesOf(null), []);
  assert.deepEqual(productLinesOf(square('a')), []);
  assert.deepEqual(productLinesOf(product(null)), []);
  assert.deepEqual(productLinesOf(product({ [P.NAME]: 3, [P.MAKER]: null })), []);
});

test('行: 見出し・製品情報・部屋名・位置・向き・備考。図が引けない配置（分類不明）は見出しがキーで製品情報なし', () => {
  const figs = { a: { ...square('a', { label: '呼称A' }), ...product({ [P.NAME]: '便器X', [P.MAKER]: 'K社' }) } };
  const placed = [
    new PlacedFigure({ id: 'p1', figureKey: 'a', x: 100, y: 200, zMm: 50, rotationDeg: 90, mirror: true, note: 'メモ' }),
    new PlacedFigure({ id: 'p2', figureKey: 'gone', x: 1, y: 2 }),
  ];
  const rows = placedFigureRows(placed, key => figs[key] ?? null, (x, y) => (x === 100 ? `室${y}` : null));
  assert.deepEqual(rows, [
    {
      id: 'p1', title: '便器X', productLines: [{ label: '名称', value: '便器X' }, { label: 'メーカー', value: 'K社' }],
      roomName: '室200', x: 100, y: 200, zMm: 50, rotationDeg: 90, mirror: true, note: 'メモ',
    },
    { id: 'p2', title: 'gone', productLines: [], roomName: null, x: 1, y: 2, zMm: 0, rotationDeg: 0, mirror: false, note: '' },
  ]);
});

test('【失敗系】行: 配置が配列でない・null 要素は例外にせず []／除く', () => {
  assert.deepEqual(placedFigureRows(null, () => null, () => null), []);
  assert.deepEqual(placedFigureRows([null], () => null, () => null), []);
});

test('実形: 実カタログのエントリ（setOverlay）と State が返す PlacedFigure インスタンスで 候補・行が通る', () => {
  setOverlay(CatalogKind.DETAIL_FIGURE, {
    user: [
      { ...square('df-wc', { subject: DetailSubject.SANITARY, label: '大便器' }), ...product({ [P.NAME]: 'ネオレスト', [P.COLOR_NAME]: 'ホワイト' }) },
      square('df-sofa', { subject: DetailSubject.FURNITURE }),
    ],
  });
  assert.deepEqual(placeableFigureCandidates(detailFigureCatalog(), SAN).map(c => [c.key, c.label]), [['df-wc', 'ネオレスト']]);
  const graph = makeFirstFloorGraph();
  graph.setPlacedFigures([
    new PlacedFigure({ id: 'a', figureKey: 'df-wc', x: 10, y: 20 }),
    new PlacedFigure({ id: 'b', figureKey: 'df-sofa', x: 30, y: 40 }),
    new PlacedFigure({ id: 'c', figureKey: 'df-gone', x: 50, y: 60 }),
  ]);
  const state = new PlacedFigureModeState(graph, { mode: 'plumbingTest', label: '試験', subjects: SAN });
  const rows = placedFigureRows(state.placedFiguresInMode(), state.figureOf, () => null);
  assert.deepEqual(rows.map(r => [r.id, r.title]), [['a', 'ネオレスト'], ['c', 'df-gone']]);
  assert.deepEqual(rows[0].productLines.map(l => l.value), ['ネオレスト', 'ホワイト']);
  assert.equal(detailFigureEntry('df-wc').label, '大便器');
});

// ---- 部屋名 ----

function roomGraph() {
  const graph = makeFirstFloorGraph();
  makeRectRoom(graph, 0, 0, 3000, 2000, 'トイレ');
  return graph;
}

test('部屋名: 部屋の中は名前・外（セルなし）は null', () => {
  const graph = roomGraph();
  assert.equal(placedFigureRoomNameAt(graph, 1000, 1000), 'トイレ');
  assert.equal(placedFigureRoomNameAt(graph, 5000, 1000), null);
  assert.equal(placedFigureRoomNameAt(graph, -100, -100), null);
});

test('部屋名: 名前が空の部屋は仕上げ表の内部タブと同じ表示名', () => {
  const graph = makeFirstFloorGraph();
  makeRectRoom(graph, 0, 0, 3000, 2000, '');
  assert.equal(placedFigureRoomNameAt(graph, 1000, 1000), '（名称未設定）');
});

test('部屋名: 未定義の部屋（削除された部屋）は部屋なし扱いの null', () => {
  const graph = makeFirstFloorGraph();
  makeRectRoom(graph, 0, 0, 3000, 2000, '旧名').setFeature(RoomFeature.UNDEFINED);
  assert.equal(placedFigureRoomNameAt(graph, 1000, 1000), null);
});

test('部屋名: 階段吹抜け・屋根（下屋）の部屋も器具を置く部屋として数えない＝null（名前の有無によらない）', () => {
  let checked = 0;
  for (const feature of [RoomFeature.STAIR_VOID, RoomFeature.ROOF]) {
    for (const name of ['', '名前あり']) {
      const graph = makeFirstFloorGraph();
      makeRectRoom(graph, 0, 0, 3000, 2000, name).setFeature(feature);
      assert.equal(placedFigureRoomNameAt(graph, 1000, 1000), null, `${feature}・${name}`);
      checked += 1;
    }
  }
  assert.equal(checked, 4);
});

test('部屋名: placedFigureRoomNameLookup は 1 回作って何点でも引ける（1 点ずつの口と同じ結果）', () => {
  const graph = roomGraph();
  const lookup = placedFigureRoomNameLookup(graph);
  const points = [[1000, 1000], [5000, 1000], [-100, -100], [Number.NaN, 0], [2999, 1999]];
  assert.deepEqual(points.map(([x, y]) => lookup(x, y)), points.map(([x, y]) => placedFigureRoomNameAt(graph, x, y)));
  assert.deepEqual(points.map(([x, y]) => lookup(x, y)), ['トイレ', null, null, null, 'トイレ']);
  assert.equal(placedFigureRoomNameLookup(null)(0, 0), null);
});

test('部屋名: 格子はあるが部屋のセルでない点は null', () => {
  const graph = roomGraph();
  addCL(graph, CenterLineType.VERTICAL, 6000);
  addCL(graph, CenterLineType.HORIZONTAL, 4000);
  assert.equal(placedFigureRoomNameAt(graph, 4500, 3000), null);
});

test('【失敗系】部屋名: graph・座標が不正なら null（例外にしない）', () => {
  assert.equal(placedFigureRoomNameAt(null, 0, 0), null);
  assert.equal(placedFigureRoomNameAt(roomGraph(), Number.NaN, 0), null);
  assert.equal(placedFigureRoomNameAt(roomGraph(), 0, undefined), null);
});
