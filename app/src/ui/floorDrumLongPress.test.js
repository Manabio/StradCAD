// FloorDrum の長押し（階設定表を開く入口。階設定表 S5）。判断は floorDrumLogic.js の純関数で固め、
// FloorDrum.jsx（.jsx は node:test から import できない）・App.jsx の配線はソース走査で固定する
// （コメント行を除き、1行まるごと一致〔m フラグ・行頭行末アンカー〕。包含はブロックを括弧対応で切り出す）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  ITEM_H, indexAtPointer, canStartFloorLongPress, shouldFireFloorLongPress, shouldOpenOnContextMenu, isDrumGestureButton,
} from './floorDrumLogic.js';
import { floorSettingsPlaneIdForSlot } from '../structural/structuralFigureSlots.js';
import { SLOT_TYPE } from '../structural/structuralClassification.js';
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
  assert.match(code, /^\s*onContextMenu=\{onContextMenu\}\s*$/m, 'ドラムの onContextMenu={onContextMenu} 行が見つからない');
});

test('【配線】FloorDrum: FloorWheel へ onLongPress と決着待ちの同期 getter を渡す', () => {
  const code = drumCode();
  assert.match(code, /^\s*onLongPress=\{onLongPress\} getPendingId=\{\(\) => pendingRef\.current\}\s*$/m, 'FloorWheel への onLongPress/getPendingId 配線行が見つからない');
  assert.match(code, /^export function FloorDrum\(\{ floors, activeFloorId, onSwitch, isLandscape, onLongPress \}\) \{\s*$/m, 'FloorDrum の props に onLongPress が無い');
});

// ---- App.jsx の配線 ----

test('【配線】App.jsx: ドラム長押し・右クリックは guardUi(openFloorSettingsFromDrum)。構造モードはスロット→階に読み替える', () => {
  const src = fs.readFileSync(appSrcPath, 'utf8');
  const code = stripCommentLines(src);
  assert.match(code, /^\s*onLongPress=\{guardUi\(openFloorSettingsFromDrum\)\}.*$/m,
    'FloorDrum の onLongPress={guardUi(openFloorSettingsFromDrum)} が1行まるごとの形で見つからない');
  const body = extractFunctionBody(src, 'function openFloorSettingsFromDrum');
  assert.match(body, /^\s*openFloorSettings\(appMode === 'structure'\s*$/m, 'openFloorSettings(appMode === structure の行が見つからない');
  assert.match(body, /^\s*\? floorSettingsPlaneIdForSlot\(buildStructuralFigureSlots\(project\), rowId, project\.planes\)\s*$/m, 'スロット→階の読み替え行が見つからない');
  assert.match(body, /^\s*: rowId\);\s*$/m, '構造モード以外は行 id そのままの行が見つからない');
});

// ---- スロット→階設定表の行 ----

const plane = (id, startFloor) => ({ id, startFloor });
const slot = (slotType, p) => ({ key: `${slotType}:${p.id}`, planeId: p.id, slotType, plane: p });

test('floorSettingsPlaneIdForSlot: 基礎伏図→最下階・小屋伏図/R階伏図→最上階・通常の階→その階', () => {
  const p1 = plane('p1', 1), p2 = plane('p2', 2), p3 = plane('p3', 3), roof = plane('r', 4);
  const planes = [p1, p2, p3];
  const slots = [
    slot(SLOT_TYPE.FOUNDATION, p1), slot(SLOT_TYPE.GROUND_FLOOR, p1), slot(SLOT_TYPE.FLOOR, p2), slot(SLOT_TYPE.FLOOR, p3),
    slot(SLOT_TYPE.ROOF_SLAB, roof), slot(SLOT_TYPE.ROOF_FRAME, roof),
  ];
  assert.equal(floorSettingsPlaneIdForSlot(slots, 'foundation:p1', planes), 'p1');
  assert.equal(floorSettingsPlaneIdForSlot(slots, 'groundFloor:p1', planes), 'p1');
  assert.equal(floorSettingsPlaneIdForSlot(slots, 'floor:p2', planes), 'p2');
  assert.equal(floorSettingsPlaneIdForSlot(slots, 'roofFrame:r', planes), 'p3'); // 屋根専用平面 id ではなく最上階
  assert.equal(floorSettingsPlaneIdForSlot(slots, 'roofSlab:r', planes), 'p3');
});

test('floorSettingsPlaneIdForSlot: 地階のみの文書・1階建て・地中梁図', () => {
  const b2 = plane('b2', -2), b1 = plane('b1', -1), roof = plane('r', 0);
  const bsOnly = [b2, b1];
  const slotsB = [slot(SLOT_TYPE.UNDERGROUND_BEAM, b2), slot(SLOT_TYPE.UNDERGROUND_BODY, b2), slot(SLOT_TYPE.UNDERGROUND_BODY, b1), slot(SLOT_TYPE.ROOF_FRAME, roof)];
  assert.equal(floorSettingsPlaneIdForSlot(slotsB, 'undergroundBeam:b2', bsOnly), 'b2'); // 最下階
  assert.equal(floorSettingsPlaneIdForSlot(slotsB, 'undergroundBody:b1', bsOnly), 'b1');
  assert.equal(floorSettingsPlaneIdForSlot(slotsB, 'roofFrame:r', bsOnly), 'b1');        // 最上階＝地階の最上
  const one = plane('p1', 1);
  const slots1 = [slot(SLOT_TYPE.FOUNDATION, one), slot(SLOT_TYPE.ROOF_FRAME, plane('r', 2))];
  assert.equal(floorSettingsPlaneIdForSlot(slots1, 'foundation:p1', [one]), 'p1');
  assert.equal(floorSettingsPlaneIdForSlot(slots1, 'roofFrame:r', [one]), 'p1');         // 基礎伏図と小屋伏図が同じ行
});

test('【失敗系】floorSettingsPlaneIdForSlot: 未知の key・採用階が空・採用階に無い階は null', () => {
  const p1 = plane('p1', 1);
  const slots = [slot(SLOT_TYPE.FLOOR, p1)];
  assert.equal(floorSettingsPlaneIdForSlot(slots, 'floor:zzz', [p1]), null);
  assert.equal(floorSettingsPlaneIdForSlot(slots, 'floor:p1', []), null);
  assert.equal(floorSettingsPlaneIdForSlot(slots, 'floor:p1', [plane('other', 1)]), null);
  assert.equal(floorSettingsPlaneIdForSlot([], null, [p1]), null);
});

// ---- 右クリック（contextmenu）----

test('shouldOpenOnContextMenu: マウスの右クリックだけ開く。タッチ・ペン・不明は開かない（長押し側が開くので二重にしない）', () => {
  const ok = { pointerType: 'mouse', hasHandler: true, pendingId: null, busy: false };
  assert.equal(shouldOpenOnContextMenu(ok), true);
  assert.equal(shouldOpenOnContextMenu({ ...ok, pointerType: 'touch' }), false); // タッチ長押し後の contextmenu
  assert.equal(shouldOpenOnContextMenu({ ...ok, pointerType: 'pen' }), false);
  assert.equal(shouldOpenOnContextMenu({ ...ok, pointerType: null }), false);    // キーボードのメニューキー等
});

test('【失敗系】shouldOpenOnContextMenu: 開く手段なし・決着待ち・関門中は開かない', () => {
  const ok = { pointerType: 'mouse', hasHandler: true, pendingId: null, busy: false };
  assert.equal(shouldOpenOnContextMenu({ ...ok, hasHandler: false }), false);
  assert.equal(shouldOpenOnContextMenu({ ...ok, pendingId: 'p2' }), false);
  assert.equal(shouldOpenOnContextMenu({ ...ok, busy: true }), false);
});

test('isDrumGestureButton: 左ボタン（0）だけ。右（2）・中（1）はドラッグも切替も始めない', () => {
  assert.equal(isDrumGestureButton(0), true);
  assert.equal(isDrumGestureButton(2), false);
  assert.equal(isDrumGestureButton(1), false);
});

test('【配線】FloorWheel: 右クリックは既定メニューを止め、shouldOpenOnContextMenu を通して押した位置の階で開く', () => {
  const body = extractArrowFunctionBody(drumCode(), 'const onContextMenu = e => {');
  assert.match(body, /^\s*e\.preventDefault\(\);\s*$/m, 'e.preventDefault(); が見つからない');
  assert.match(body, /^\s*if \(!shouldOpenOnContextMenu\(\{ pointerType: pointerTypeRef\.current, hasHandler: !!onLongPress, pendingId: getPendingId\?\.\(\) \?\? null, busy: isUiBusy\(\) \}\)\) return;\s*$/m,
    'shouldOpenOnContextMenu の判定行が見つからない');
  assert.match(body, /^\s*onLongPress\(ordered\[indexAtPointer\(displayIndex, offset, ordered\.length\)\]\.id\);\s*$/m, '押した位置の階で onLongPress を呼ぶ行が見つからない');
  assert.ok(body.indexOf('e.preventDefault();') < body.indexOf('if (!shouldOpenOnContextMenu('), 'preventDefault が判定より前にない');
  assert.match(body, /^\s*longPress\.abort\(\);.*$/m, '右クリックで開く前に長押しを止める行が見つからない');
  assert.ok(body.indexOf('if (!shouldOpenOnContextMenu(') < body.indexOf('longPress.abort();')
    && body.indexOf('longPress.abort();') < body.indexOf('onLongPress('), 'longPress.abort() が判定の後・onLongPress の前にない');
});

test('【配線】FloorWheel: pointerdown は種類を記録し、右・中ボタンではドラッグを始めない（pending 判定・setDragging より前）', () => {
  const body = extractArrowFunctionBody(drumCode(), 'const onPointerDown = e => {');
  assert.match(body, /^\s*pointerTypeRef\.current = e\.pointerType;\s*$/m, 'pointerType の記録行が見つからない');
  assert.match(body, /^\s*if \(!isDrumGestureButton\(e\.button\)\) return;.*$/m, 'isDrumGestureButton の早期 return 行が見つからない');
  const btn = body.indexOf('if (!isDrumGestureButton(');
  assert.ok(body.indexOf('pointerTypeRef.current = e.pointerType;') < btn, 'pointerType の記録がボタン判定より前にない');
  assert.ok(btn < body.indexOf('setDragging(true);'), 'ボタン判定が setDragging より前にない');
});

// ---- 縦長ピル ----

test('【配線】PillButton: 長押しは useFloorLongPress を共有し、開始は canStartFloorLongPress・成立後のクリックは切替にしない', () => {
  const code = drumCode();
  assert.match(code, /^\s*const longPress = useFloorLongPress\(\{ pendingId, getPendingId, onLongPress, pressIdRef \}\);\s*$/m, 'フックの共有行が見つからない（ドラムとピル）');
  assert.equal((code.match(/^\s*const longPress = useFloorLongPress\(\{ pendingId, getPendingId, onLongPress, pressIdRef \}\);\s*$/gm) ?? []).length, 2, 'ドラムとピルの2か所で共有されていない');
  assert.equal((code.match(/useLongPress\(/g) ?? []).length, 1, 'useLongPress が二重に呼ばれている（共有フック1か所のみ）');
  const down = extractArrowFunctionBody(code, 'const onPillDown = e => {');
  assert.match(down, /^\s*if \(canStartFloorLongPress\(\{ button: e\.button, isPrimary: e\.isPrimary, hasHandler, pendingId: getPendingId\?\.\(\) \?\? null, busy: isUiBusy\(\) \}\)\) \{\s*$/m, 'ピルの開始条件行が見つからない');
  assert.match(code, /^\s*suppressClickRef\.current = pressActiveRef\.current && longPress\.hasFired\(\);\s*$/m, '成立後のクリック抑止の算出行が見つからない');
  assert.match(code, /^\s*if \(suppressClickRef\.current\) \{ suppressClickRef\.current = false; return; \}.*$/m, 'クリック抑止の早期 return 行が見つからない');
});

test('【配線】PillButton: 移動で取り消し、pointercancel（スクロール）・ポインタが外れたら取り消す。右クリックは既定メニューを止める', () => {
  const code = drumCode();
  assert.match(code, /^\s*if \(pressActiveRef\.current\) longPress\.move\(e\.clientX, e\.clientY\);\s*$/m, 'ピルの longPress.move 行が見つからない');
  assert.match(code, /^\s*onPointerCancel=\{cancel\}\s*$/m, 'onPointerCancel={cancel} が見つからない');
  assert.match(code, /^\s*onPointerLeave=\{cancel\}\s*$/m, 'onPointerLeave={cancel} が見つからない');
  assert.match(code, /^\s*onContextMenu=\{onPillContextMenu\}\s*$/m, 'ピルの onContextMenu 配線行が見つからない');
  const ctx = extractArrowFunctionBody(code, 'const onPillContextMenu = e => {');
  assert.match(ctx, /^\s*e\.preventDefault\(\);\s*$/m, 'ピルの右クリックで e.preventDefault(); が見つからない');
  assert.match(ctx, /^\s*if \(!shouldOpenOnContextMenu\(\{ pointerType: pointerTypeRef\.current, hasHandler, pendingId: getPendingId\?\.\(\) \?\? null, busy: isUiBusy\(\) \}\)\) return;\s*$/m, 'ピルの右クリック判定行が見つからない');
  assert.match(ctx, /^\s*longPress\.abort\(\);.*$/m, 'ピルの右クリックで開く前に長押しを止める行が見つからない');
  assert.ok(ctx.indexOf('e.preventDefault();') < ctx.indexOf('if (!shouldOpenOnContextMenu(')
    && ctx.indexOf('if (!shouldOpenOnContextMenu(') < ctx.indexOf('longPress.abort();')
    && ctx.indexOf('longPress.abort();') < ctx.indexOf('onLongPress(pressId);'), 'ピルの右クリック: preventDefault → 判定 → abort → onLongPress の順でない');
});

test('【配線】PillButton: 押し始めでクリック抑止を解除する（長押しの後に click が来なくても次のタップを捨てない）', () => {
  const down = extractArrowFunctionBody(drumCode(), 'const onPillDown = e => {');
  assert.match(down, /^\s*suppressClickRef\.current = false;.*$/m, 'onPillDown に suppressClickRef.current = false; が無い');
});

test('【配線】FloorDrum: 縦長のピル（展開・折りたたみとも）へ onLongPress と決着待ちの getter を渡し、タッチでは pointerenter で入れ替えない', () => {
  const code = drumCode();
  assert.equal((code.match(/^\s*pressId=\{[^}]+\} onLongPress=\{onLongPress\} getPendingId=\{\(\) => pendingRef\.current\} pendingId=\{pendingId\}\s*$/gm) ?? []).length, 2, 'ピル2か所の配線行が見つからない');
  assert.match(code, /^\s*onPointerEnter=\{e => \{ if \(e\.pointerType !== 'touch'\) setExpanded\(true\); \}\}.*$/m, 'タッチを除く pointerenter の行が見つからない');
});

test('【配線】App.jsx: openFloorSettings は存在しない階を無視し、beginUiTransition() してからダイアログを開く', () => {
  const body = extractFunctionBody(fs.readFileSync(appSrcPath, 'utf8'), 'function openFloorSettings');
  assert.match(body, /^\s*if \(!project\.planeMap\.has\(planeId\)\) return;\s*$/m, '階の存在確認行が見つからない');
  assert.match(body, /^\s*beginUiTransition\(\);\s*$/m, 'beginUiTransition(); が見つからない');
  assert.match(body, /^\s*setFloorSettingsDlg\(\{ planeId \}\);\s*$/m, 'setFloorSettingsDlg({ planeId }); が見つからない');
  assert.ok(body.indexOf('beginUiTransition();') < body.indexOf('setFloorSettingsDlg({ planeId });'), 'beginUiTransition がダイアログを開くより前にない');
});
