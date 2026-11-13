// 図面モード（姿図配置モード）の汎用パネル（PlacedFigureModePanel.jsx）の配線不変条件。.jsx・App.jsx は node:test から単体 import できないため、
// ソーステキストを走査して固定する。検査はコメントを除いた本体（stripCommentsKeepStrings）の「トリム後の 1 行まるごと」一致で行い、
// コメントや文字列リテラルに残した元の式で通らないようにする（placedFigureModeWiring.test.js と同じ流儀）。
// 設計意図は .claude/mode-system.md の「図面モード」の節。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { readAppSrc, stripCommentsKeepStrings } from '../../uiBusySourceScan.js';
import { PLACED_FIGURE_MODE_PANEL_TEXT } from '../../error.js';

const linesOf = (file) => stripCommentsKeepStrings(fs.readFileSync(path.resolve(import.meta.dirname, file), 'utf8'))
  .split(/\r?\n/).map(l => l.trim());
const panel = linesOf('PlacedFigureModePanel.jsx');
const tab = linesOf('PlacedFigureTab.jsx');
const app = stripCommentsKeepStrings(readAppSrc()).split(/\r?\n/).map(l => l.trim());

const has = (lines, line, label) => assert.equal(lines.filter(l => l === line).length, 1, `${label ?? line} が 1 行まるごとちょうど 1 つ`);
const count = (text, needle) => text.split(needle).length - 1;

// ---- App.jsx ----

test('【配線】App.jsx: パネルは isPlacedFigureMode(appMode) かつ mode が appMode の図面モードの State のときだけ載せる（表の 1 行ごとに足さない）', () => {
  const i = app.indexOf('{isPlacedFigureMode(appMode) && mode?.def?.mode === appMode && (');
  assert.ok(i >= 0 && app.filter(l => l.includes('<PlacedFigureModePanel')).length === 1, '条件つきの 1 か所');
  assert.equal(app[i + 1], '<PlacedFigureModePanel graph={graph} mode={mode} isLandscape={isLandscape} />');
  assert.equal(app[i + 2], ')}');
  has(app, "import { PlacedFigureModePanel } from './finish/placedFigure/PlacedFigureModePanel.jsx';");
});

// ---- PlacedFigureModePanel.jsx ----

test('【配線】パネル: 候補は純モジュール placeableFigureCandidates（カタログ・mode.def.subjects）から。select の選択肢と配置ボタンを描く', () => {
  has(panel, "import { placeableFigureCandidates, placedFigureRows } from './placedFigureModePanelRows.js';");
  has(panel, 'const candidates = placeableFigureCandidates(detailFigureCatalog(), mode.def.subjects);');
  has(panel, '{candidates.map(c => <option key={c.key} value={c.key}>{c.label}</option>)}');
  has(panel, '<button onClick={() => mode.beginFigurePlacement(effectiveKey)} style={linkButtonStyle}>{PLACED_FIGURE_TAB_TEXT.place}</button>');
  has(panel, '<span style={hintStyle}>{PLACED_FIGURE_TAB_TEXT.registerHint}</span>');
  has(panel, '<div style={pickBarStyle}>');
});

test('【配線】パネル: 配置待ちの表示（タップ案内・取消）は仕上げタブと同じ文言・配置待ちの間だけ', () => {
  has(panel, '{mode.placingFigureKey && (');
  has(panel, '<div style={placingBarStyle}>');
  has(panel, '<span style={{ flex: 1 }}>{PLACED_FIGURE_TAB_TEXT.tapPoint}</span>');
  has(panel, '<button onClick={() => mode.cancelFigurePlacement()} style={linkButtonStyle}>{PLACED_FIGURE_TAB_TEXT.cancel}</button>');
});

test('【配線】パネル: 一覧の行は純モジュール placedFigureRows（State の placedFiguresInMode・figureOf・配置点の部屋名）から。FigureRow に title・extra（製品情報・部屋・向き）を渡す', () => {
  // 部屋の逆引きは描画 1 回につき 1 回だけ作る（行ごとに作り直さない）
  has(panel, 'const rows = placedFigureRows([...placed.values()], mode.figureOf, placedFigureRoomNameLookup(graph));');
  assert.ok(!panel.some(l => l.includes('placedFigureRoomNameAt')), 'パネルは 1 点ずつ引く口を使わない');
  const rooms = linesOf('placedFigureRooms.js');
  has(rooms, 'const cellToRoom = buildCellToRoom(graph);');
  assert.ok(rooms.indexOf('const cellToRoom = buildCellToRoom(graph);') < rooms.indexOf('return (x, y) => {'), '逆引きは返す関数の外で作る');
  assert.equal(rooms.filter(l => l.includes('buildCellToRoom(')).length, 1);
  has(panel, 'const placed = new Map(mode.placedFiguresInMode().map(pf => [pf.id, pf]));');
  has(panel, '{rows.map(row => (');
  has(panel, "import { FigureRow, lineStyle, linkButtonStyle, pickBarStyle, placingBarStyle, hintStyle } from './PlacedFigureTab.jsx';");
  has(panel, "import { placedFigureRoomNameLookup } from './placedFigureRooms.js';");
  const i = panel.indexOf('<FigureRow');
  assert.ok(i >= 0 && panel.filter(l => l.startsWith('<FigureRow')).length === 1, 'FigureRow は 1 か所');
  assert.deepEqual(panel.slice(i, i + 9), [
    '<FigureRow', 'key={row.id}', 'graph={graph}', 'mode={mode}', 'pf={placed.get(row.id)}', 'entry={null}', 'onPad={setPad}',
    'title={row.title}', 'extra={(',
  ]);
  const j = panel.indexOf('extra={(');
  has(panel, '{row.productLines.map(l => <div key={l.label} style={lineStyle}>{l.label} {l.value}</div>)}');
  has(panel, '<div style={lineStyle}>{PLACED_FIGURE_MODE_PANEL_TEXT.room} {row.roomName ?? PLACED_FIGURE_MODE_PANEL_TEXT.noRoom}</div>');
  has(panel, "<div style={lineStyle}>{PLACED_FIGURE_MODE_PANEL_TEXT.direction} {row.rotationDeg}°{row.mirror ? ` ${PLACED_FIGURE_TAB_TEXT.mirror}` : ''}</div>");
  // 3 つの追加行は extra の中（FigureRow の要素の内側）にある
  const close = panel.indexOf('/>', j + 1);
  assert.ok(close > j, 'FigureRow の閉じが見つからない');
  for (const l of ['{row.productLines.map(', '{PLACED_FIGURE_MODE_PANEL_TEXT.room}', '{PLACED_FIGURE_MODE_PANEL_TEXT.direction}']) {
    const k = panel.findIndex(x => x.includes(l));
    assert.ok(k > j && k < close, `${l} は extra の中`);
  }
});

test('【配線】パネル: 見出しは定義表の表示名（mode.def.label）・選択の信号は mode.selectedPlacedFigureId（横長 ModePanel・縦長 BottomSheet）', () => {
  has(panel, '? <ModePanel title={mode.def.label} raiseSignal={mode.selectedPlacedFigureId}>{inner}</ModePanel>');
  has(panel, ': <BottomSheet title={mode.def.label} raiseSignal={mode.selectedPlacedFigureId}>{inner}</BottomSheet>;');
  has(panel, 'return isLandscape');
});

test('【配線】パネル: 離れたら配置待ちを解く・NumPad の確定は mode.updatePlacedFigure（有限値のときだけ）', () => {
  has(panel, 'useEffect(() => () => mode.cancelFigurePlacement(), [mode]);');
  has(panel, 'if (Number.isFinite(v)) mode.updatePlacedFigure(pad.id, { [pad.field]: v });');
  has(panel, 'onConfirm={confirmPad}');
});

test('【不変条件】パネルは日本語リテラル・モード id を直書きしない（文言は error.js・見出しは定義表）', () => {
  const body = panel.join('\n');
  assert.ok(!/[぀-ヿ㐀-鿿]/.test(body), '日本語リテラルが直書きされている');
  assert.ok(!/plumbing/.test(body), 'モード id を書かない');
  assert.equal(count(body, 'mode.def.label'), 2);
});

test('【不変条件】パネルは色・余白の値を書き写さない（帯・案内のスタイルは仕上げタブの定数を共用。仕上げタブも同じ定数で描く）', () => {
  const body = panel.join('\n');
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(body), '色の値が直書きされている');
  assert.ok(!/padding/.test(body), '余白の値が直書きされている');
  has(tab, "export const pickBarStyle = { ...lineStyle, padding: '6px 10px', borderBottom: '1px solid #e2e8f0' };");
  has(tab, "export const placingBarStyle = { ...lineStyle, padding: '6px 10px', background: '#eff6ff', color: '#2563eb' };");
  has(tab, "export const hintStyle = { color: '#94a3b8' };");
  has(tab, '<div style={pickBarStyle}>');
  has(tab, '<div style={placingBarStyle}>');
  has(tab, '<span style={hintStyle}>{PLACED_FIGURE_TAB_TEXT.registerHint}</span>');
});

// ---- 仕上げタブ（不変）----

test('【配線】仕上げタブ: FigureRow は title・extra なしで描く（仕上げタブの見た目は不変）', () => {
  has(tab, '<FigureRow key={pf.id} graph={graph} mode={mode} pf={pf} entry={catalog.get(pf.figureKey) ?? null} onPad={setPad} />');
  assert.equal(tab.filter(l => l.includes('<FigureRow')).length, 1);
  assert.ok(!tab.some(l => /\b(title|extra)=/.test(l)), '仕上げタブの呼び出しに title・extra を渡さない');
});

test('【配線】FigureRow: title は見出しの差し替え（無ければ従来の見出し）・extra は見出しの下に描き、渡したときだけ既定の回転角・鏡像の表示を出さない', () => {
  has(tab, 'export const FigureRow = observer(({ graph, mode, pf, entry, onPad, title, extra }) => {');
  has(tab, '<span style={{ fontWeight: 700, flex: 1 }}>{title ?? (entry?.label || pf.figureKey)}</span>');
  has(tab, '{extra}');
  has(tab, "{extra == null && <span style={{ color: '#64748b' }}>{pf.rotationDeg}°{pf.mirror ? ` ${PLACED_FIGURE_TAB_TEXT.mirror}` : ''}</span>}");
  // 見出しの行の閉じ → extra → 位置の行、の順
  const iExtra = tab.indexOf('{extra}');
  assert.ok(tab.indexOf("{valueButton('x', PLACED_FIGURE_TAB_TEXT.x)}") > iExtra);
  assert.ok(tab.indexOf('{PLACED_FIGURE_TAB_TEXT.remove}') < iExtra);
});

test('PLACED_FIGURE_MODE_PANEL_TEXT: 承認済みの文言そのまま・凍結', () => {
  assert.deepEqual(PLACED_FIGURE_MODE_PANEL_TEXT, { room: '部屋', noRoom: '（部屋なし）', direction: '向き' });
  assert.ok(Object.isFrozen(PLACED_FIGURE_MODE_PANEL_TEXT));
});
