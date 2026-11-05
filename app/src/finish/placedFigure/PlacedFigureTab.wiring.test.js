// PlacedFigureTab.jsx（タブ「衛生・家具・空調」。S10 P4）の配線不変条件と、文言・定数の固定。
// .jsx は node:test から単体 import できないため、ソーステキスト検査（コメントと行末コメントを除いたトリム後の 1 行まるごと一致）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PLACED_FIGURE_TAB_TEXT } from '../../error.js';

const text = fs.readFileSync(path.resolve(import.meta.dirname, 'PlacedFigureTab.jsx'), 'utf8');
const code = text.replace(/\/\*[\s\S]*?\*\//g, '').split(/\r?\n/)
  .filter(line => !line.trim().startsWith('//'))
  .join('\n');
const lines = code.split('\n').map(l => l.replace(/\s\/\/.*$/, '').trim());

test('【配線】選択行は useScrollIntoViewWhenActive(selected) の ref を行に付ける', () => {
  assert.ok(lines.includes("import { useScrollIntoViewWhenActive } from '../../ui/useScrollIntoViewWhenActive.js';"));
  assert.ok(lines.includes('const ref = useScrollIntoViewWhenActive(selected);'));
  assert.ok(lines.includes('ref={ref}'));
});

test('【配線】タブを離れる（unmount）cleanup で mode.cancelFigurePlacement() を呼ぶ', () => {
  assert.ok(lines.includes('useEffect(() => () => mode.cancelFigurePlacement(), [mode]);'));
});

test('【配線】NumPad の確定は mode.updatePlacedFigure(id, {項目: 値}) を通る（有限値のときだけ）', () => {
  assert.ok(lines.includes("import { NumPad } from '../../ui/NumPad.jsx';"));
  assert.ok(lines.includes('if (Number.isFinite(v)) mode.updatePlacedFigure(pad.id, { [pad.field]: v });'));
  assert.ok(lines.includes('onConfirm={confirmPad}'));
  assert.equal((lines.join('\n').match(/mode\.updatePlacedFigure\(/g) ?? []).length, 1, '確定の 1 か所だけ');
});

test('【配線】備考は focus/blur で field undo（begin/end）・onChange で setPlacedFigureNote', () => {
  assert.ok(lines.includes('onFocus={() => beginFieldUndo(graph)}'));
  assert.ok(lines.includes('onBlur={() => endFieldUndo(graph)}'));
  assert.ok(lines.includes('onChange={e => mode.setPlacedFigureNote(pf.id, e.target.value)}'));
});

test('【配線】操作は mode の口を通る（回転・鏡像・削除・配置・取消・選択）', () => {
  // 行末コメントを除いたトリム後の 1 行がまるごと一致（部分一致・コメントに残した式で通さない）
  const body = lines.join('\n');
  for (const l of [
    'onClick={() => mode.selectPlacedFigure(pf.id)}',
    '<button onClick={() => mode.beginFigurePlacement(effectiveKey)} style={linkButtonStyle}>{PLACED_FIGURE_TAB_TEXT.place}</button>',
    '<button onClick={() => mode.cancelFigurePlacement()} style={linkButtonStyle}>{PLACED_FIGURE_TAB_TEXT.cancel}</button>',
    '<button onClick={e => { stop(e); mode.rotatePlacedFigure(pf.id); }} style={linkButtonStyle}>{PLACED_FIGURE_TAB_TEXT.rotate}</button>',
    '<button onClick={e => { stop(e); mode.togglePlacedFigureMirror(pf.id); }} style={linkButtonStyle}>{PLACED_FIGURE_TAB_TEXT.mirror}</button>',
    'onClick={e => { stop(e); mode.removePlacedFigure(pf.id); }}',
  ]) {
    const escaped = l.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    assert.match(body, new RegExp(`^${escaped}$`, 'm'), `${l} が 1 行まるごとは見つからない`);
  }
});

test('【不変条件】文言は PLACED_FIGURE_TAB_TEXT 経由＝ファイル内（コメント除く）に日本語リテラルが無い', () => {
  assert.ok(lines.includes("import { PLACED_FIGURE_TAB_TEXT } from '../../error.js';"));
  assert.ok(!/[぀-ヿ㐀-鿿]/.test(lines.join('\n')), '日本語リテラルが直書きされている');
});

test('PLACED_FIGURE_TAB_TEXT: 承認済みの文言そのまま・凍結', () => {
  assert.deepEqual(PLACED_FIGURE_TAB_TEXT, {
    place: '配置', tapPoint: '配置点をタップ', cancel: '取消', rotate: '90° 回転', mirror: '鏡像', remove: '削除',
    note: '備考', x: 'X', y: 'Y', height: '高さ', registerHint: '部分詳細図ヘルパーで登録',
  });
  assert.ok(Object.isFrozen(PLACED_FIGURE_TAB_TEXT));
});
