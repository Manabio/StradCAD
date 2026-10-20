// FloorDrum の長押し（階設定表を開く入口。階設定表 S5）。判断は floorDrumLogic.js の純関数で固め、
// FloorDrum.jsx（.jsx は node:test から import できない）・App.jsx の配線はソース走査で固定する
// （コメント行を除き、1行まるごと一致〔m フラグ・行頭行末アンカー〕。包含はブロックを括弧対応で切り出す）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ITEM_H, indexAtPointer, canStartFloorLongPress, shouldFireFloorLongPress } from './floorDrumLogic.js';
import { appSrcPath, stripCommentLines, extractFunctionBody, extractArrowFunctionBody } from '../uiBusySourceScan.js';

// ---- 純関数 ----

test('indexAtPointer: 中心（ずれ 0）は表示中の階。下へ ITEM_H ごとに1階下（インデックス大）、上へは1階上', () => {
  assert.equal(indexAtPointer(2, 0, 5), 2);
  assert.equal(indexAtPointer(2, ITEM_H, 5), 3);
  assert.equal(indexAtPointer(2, -ITEM_H, 5), 1);
  assert.equal(indexAtPointer(2, ITEM_H * 2, 5), 4);
  assert.equal(indexAtPointer(2, -ITEM_H * 2, 5), 0);
});

test('indexAtPointer: 半スロット未満のずれは同じ階。丸めは最寄りのスロット', () => {
  assert.equal(indexAtPointer(2, ITEM_H * 0.4, 5), 2);
  assert.equal(indexAtPointer(2, ITEM_H * 0.6, 5), 3);
  assert.equal(indexAtPointer(2, -ITEM_H * 0.6, 5), 1);
});

test('【失敗系】indexAtPointer: 端の階より外を押しても [0, length-1] に収まる', () => {
  assert.equal(indexAtPointer(0, -ITEM_H * 2, 3), 0);
  assert.equal(indexAtPointer(2, ITEM_H * 2, 3), 2);
  assert.equal(indexAtPointer(0, 0, 1), 0);
});

test('canStartFloorLongPress: 左ボタン・開く手段あり・決着待ちなし・関門なしのときだけ始める', () => {
  const ok = { button: 0, hasHandler: true, pendingId: null, busy: false };
  assert.equal(canStartFloorLongPress(ok), true);
  assert.equal(canStartFloorLongPress({ ...ok, button: 2 }), false);   // 右ボタン
  assert.equal(canStartFloorLongPress({ ...ok, button: 1 }), false);   // 中ボタン
  assert.equal(canStartFloorLongPress({ ...ok, hasHandler: false }), false); // 構造モードのスロット
  assert.equal(canStartFloorLongPress({ ...ok, pendingId: 'p2' }), false);   // 切替の決着待ち
  assert.equal(canStartFloorLongPress({ ...ok, busy: true }), false);        // 関門中
});

test('【失敗系】canStartFloorLongPress: 2本目以降の指（isPrimary=false）では始めない。省略時は主ポインタ扱い', () => {
  const ok = { button: 0, hasHandler: true, pendingId: null, busy: false };
  assert.equal(canStartFloorLongPress({ ...ok, isPrimary: false }), false);
  assert.equal(canStartFloorLongPress({ ...ok, isPrimary: true }), true);
  assert.equal(canStartFloorLongPress(ok), true);
});

test('shouldFireFloorLongPress: 成立時に決着待ち・関門に入っていたら開かない', () => {
  assert.equal(shouldFireFloorLongPress({ pendingId: null, busy: false }), true);
  assert.equal(shouldFireFloorLongPress({ pendingId: 'p2', busy: false }), false);
  assert.equal(shouldFireFloorLongPress({ pendingId: null, busy: true }), false);
});

// ---- FloorDrum.jsx の配線 ----

const drumCode = () => stripCommentLines(fs.readFileSync(path.resolve(import.meta.dirname, 'FloorDrum.jsx'), 'utf8'));

test('【配線】FloorWheel: 長押しの発火は shouldFireFloorLongPress（決着待ち・関門の再確認）を通り、押した位置の階 id で onLongPress を呼ぶ', () => {
  const code = drumCode();
  assert.match(code, /^\s*if \(!shouldFireFloorLongPress\(\{ pendingId: getPendingId\?\.\(\) \?\? null, busy: isUiBusy\(\) \}\)\) return;\s*$/m,
    'shouldFireFloorLongPress の再確認行が1行まるごとの形で見つからない');
  assert.match(code, /^\s*if \(pressIdRef\.current != null\) onLongPress\?\.\(pressIdRef\.current\);\s*$/m,
    'onLongPress(pressIdRef.current) の行が見つからない');
});

test('【配線】FloorWheel: 長押しの開始は canStartFloorLongPress（ボタン・決着待ち・関門）で守り、押した位置の階を indexAtPointer で決める', () => {
  const body = extractArrowFunctionBody(drumCode(), 'const onPointerDown = e => {');
  assert.match(body, /^\s*if \(canStartFloorLongPress\(\{ button: e\.button, isPrimary: e\.isPrimary, hasHandler: !!onLongPress, pendingId, busy: isUiBusy\(\) \}\)\) \{\s*$/m,
    'canStartFloorLongPress の開始条件行が見つからない');
  const startIdx = body.indexOf('if (canStartFloorLongPress(');
  // 2本目の指: begin を呼び直す前に、押し始めのタイマーを必ず止める（無条件・開始条件より前）
  assert.match(body, /^\s*longPress\.abort\(\);.*$/m, 'onPointerDown に begin 前の longPress.abort(); が無い');
  assert.ok(body.indexOf('longPress.abort();') >= 0 && body.indexOf('longPress.abort();') < startIdx,
    'longPress.abort(); が canStartFloorLongPress の開始条件より前にない');
  const blockEnd = body.indexOf('longPress.begin(e.clientX, e.clientY);');
  const block = body.slice(startIdx, blockEnd);
  assert.match(block, /^\s*pressIdRef\.current = ordered\[indexAtPointer\(displayIndex, offset, ordered\.length\)\]\.id;\s*$/m,
    'indexAtPointer で押した位置の階 id を決める行が開始ブロックに無い');
  assert.ok(blockEnd > startIdx, 'begin が canStartFloorLongPress ブロックの中にない');
  // pending 中は何も始めない（既存の連打無視）が長押しより先にある
  assert.ok(body.indexOf('if (pendingId != null) return;') >= 0 && body.indexOf('if (pendingId != null) return;') < startIdx,
    'pendingId の早期 return が長押し開始より前にない');
});

test('【配線】FloorWheel: ドラッグが始まったら長押しを取り消し、成立後はドラッグで階を動かさない', () => {
  const body = extractArrowFunctionBody(drumCode(), 'const onPointerMove = e => {');
  assert.match(body, /^\s*longPress\.move\(e\.clientX, e\.clientY\);.*$/m, 'longPress.move の行が見つからない');
  assert.match(body, /^\s*if \(longPress\.hasFired\(\)\) return;.*$/m, '成立後のドラッグ抑止行が見つからない');
  assert.ok(body.indexOf('longPress.move(') < body.indexOf('setDrag(e.clientY - startY.current);'),
    'longPress.move がドラッグ更新より前にない');
});

test('【配線】FloorWheel: 長押しが成立していたら離しても requestSwitch を呼ばない（成立判定は requestSwitch より前）', () => {
  const body = extractArrowFunctionBody(drumCode(), 'const endDrag = e => {');
  assert.match(body, /^\s*const fired = pressActiveRef\.current && longPress\.hasFired\(\);\s*$/m, 'fired の算出行が見つからない');
  assert.match(body, /^\s*if \(fired\) \{ setDrag\(0\); return; \}.*$/m, 'fired の早期 return 行が見つからない');
  assert.match(body, /^\s*longPress\.abort\(\);\s*$/m, 'endDrag で longPress.abort() が呼ばれていない');
  const firedRet = body.indexOf('if (fired) {');
  const req = body.indexOf('requestSwitch(ordered[next].id);');
  assert.ok(firedRet >= 0 && req >= 0 && firedRet < req, 'fired の早期 return が requestSwitch より前にない');
});

test('【配線】FloorWheel: 関門が開いたとき・自分が切替を要求したときに長押しのタイマーを止める', () => {
  const code = drumCode();
  assert.match(code, /^\s*useEffect\(\(\) => reaction\(\(\) => isUiBusy\(\), busy => \{ if \(busy\) longPressRef\.current\.abort\(\); \}\), \[\]\);\s*$/m,
    '関門開始で longPress.abort() する reaction の行が見つからない');
  assert.match(code, /^\s*useEffect\(\(\) => \{ if \(pendingId != null\) longPressRef\.current\.abort\(\); \}, \[pendingId\]\);\s*$/m,
    '決着待ち開始で longPress.abort() する effect の行が見つからない');
});

test('【配線】FloorWheel: アンマウント時に長押しのタイマーを止める', () => {
  assert.match(drumCode(), /^\s*useEffect\(\(\) => \(\) => longPressRef\.current\?\.abort\(\), \[\]\);\s*$/m,
    'アンマウント時の longPress.abort() の行が見つからない');
});

test('【配線】FloorWheel: 長押し中の文字選択・OS のメニューを防ぐ', () => {
  const code = drumCode();
  assert.match(code, /^\s*userSelect: 'none', WebkitUserSelect: 'none', WebkitTouchCallout: 'none',\s*$/m, 'userSelect/WebkitTouchCallout の行が見つからない');
  assert.match(code, /^\s*onContextMenu=\{e => e\.preventDefault\(\)\}\s*$/m, 'onContextMenu の preventDefault 行が見つからない');
});

test('【配線】FloorDrum: 長押しの入口は横長ドラムだけ。FloorWheel へ onLongPress と決着待ちの同期 getter を渡す', () => {
  const code = drumCode();
  assert.match(code, /^\s*onLongPress=\{onLongPress\} getPendingId=\{\(\) => pendingRef\.current\}\s*$/m, 'FloorWheel への onLongPress/getPendingId 配線行が見つからない');
  assert.match(code, /^export function FloorDrum\(\{ floors, activeFloorId, onSwitch, isLandscape, onLongPress \}\) \{\s*$/m, 'FloorDrum の props に onLongPress が無い');
});

// ---- App.jsx の配線 ----

test('【配線】App.jsx: ドラム長押しは guardUi(openFloorSettings)。構造モード（スロット）は渡さない', () => {
  const code = stripCommentLines(fs.readFileSync(appSrcPath, 'utf8'));
  assert.match(code, /^\s*onLongPress=\{appMode === 'structure' \? undefined : guardUi\(openFloorSettings\)\}.*$/m,
    'FloorDrum の onLongPress={... guardUi(openFloorSettings)} が1行まるごとの形で見つからない');
});

test('【配線】App.jsx: openFloorSettings は存在しない階を無視し、beginUiTransition() してからダイアログを開く', () => {
  const body = extractFunctionBody(fs.readFileSync(appSrcPath, 'utf8'), 'function openFloorSettings');
  assert.match(body, /^\s*if \(!project\.planeMap\.has\(planeId\)\) return;\s*$/m, '階の存在確認行が見つからない');
  assert.match(body, /^\s*beginUiTransition\(\);\s*$/m, 'beginUiTransition(); が見つからない');
  assert.match(body, /^\s*setFloorSettingsDlg\(\{ planeId \}\);\s*$/m, 'setFloorSettingsDlg({ planeId }); が見つからない');
  assert.ok(body.indexOf('beginUiTransition();') < body.indexOf('setFloorSettingsDlg({ planeId });'), 'beginUiTransition がダイアログを開くより前にない');
});
