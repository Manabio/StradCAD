// 柱の長クリックの配線（usePointerInteraction.js の longPress.onFire・App.jsx の handleMenuSelect）のソース走査テスト。
// .jsx / フックは node:test から import できないため、ブロックコメントを除いたソースから関数本体を切り出し
// （uiBusySourceScan.js の extractArrowFunctionBody / extractFunctionBody）、**1 行まるごと**一致で数える
// （行末コメントへ移す・文字列リテラルに入れる変異は行の形が変わるので一致しなくなる）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { extractArrowFunctionBody, extractFunctionBody } from '../uiBusySourceScan.js';

const readSrc = rel => fs.readFileSync(path.resolve(import.meta.dirname, rel), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const wholeLines = (text, line) => (text.match(new RegExp(`^\\s*${esc(line)}$`, 'gm')) || []).length;
const count = (text, needle) => text.split(needle).length - 1;

const hookSrc = readSrc('usePointerInteraction.js');
const appSrc = readSrc('../App.jsx');
const onFire = extractArrowFunctionBody(hookSrc, 'onFire:   (sx, sy) => {');
const menuSelect = extractFunctionBody(appSrc, 'function handleMenuSelect(item) {');

test('【配線】usePointerInteraction: longPress.onFire が resolveColumnLongPress を 1 回、発火時の画面座標（sx, sy）から呼ぶ', () => {
  assert.equal(count(onFire, 'resolveColumnLongPress('), 1);
  assert.equal(wholeLines(onFire, 'const columnLP = resolveColumnLongPress({'), 1);
  assert.equal(wholeLines(onFire, 'appMode, activeGraph: graph, composition, project, slotView,'), 1);
  assert.equal(wholeLines(onFire, 'const fireWorld = viewport.screenToWorld(sx, sy);'), 1, '発火位置の世界座標（ホバー時の値ではない）');
  assert.equal(wholeLines(onFire, 'world: fireWorld, scaleX: viewport.scaleX, scaleY: viewport.scaleY, thresholdPx: CL_THRESHOLD_PX,'), 1);
  // 他の候補に譲る規則の入力も発火位置から求める（端点までの距離・建具の有無）
  assert.equal(wholeLines(onFire, "const columnMode = appMode === 'floorplan' || appMode === 'structure';"), 1);
  assert.equal(wholeLines(onFire, 'endpointDistPx: columnMode ? endpointHitDistancePx(graph, viewport, fireWorld, { width: size.width, height: size.height, appMode, columnAxisMode }) : null,'), 1);
  assert.equal(wholeLines(onFire, 'openingHit: columnMode ? openingHitAt(graph, viewport, fireWorld, appMode) : false,'), 1);
  // ホバー時の値（snapRef 等）ではなく発火時の座標から求める（タッチでは押下時に updateSnap が走らない）
  const callStart = onFire.indexOf('resolveColumnLongPress(');
  const callEnd = onFire.indexOf('});', callStart);
  assert.ok(!/snapRef|nearCLRef|nearWallRef/.test(onFire.slice(callStart, callEnd)), '呼び出しの引数がホバー時の ref を読んでいる');
});

test('【配線】usePointerInteraction: 柱の判定は detectContext・buildMenuState より前。結果を両方へ渡す', () => {
  const at = onFire.indexOf('resolveColumnLongPress(');
  assert.ok(at >= 0);
  assert.ok(at < onFire.indexOf('detectContext('), 'detectContext より前');
  assert.ok(at < onFire.indexOf('buildMenuState('), 'buildMenuState より前');
  assert.equal(wholeLines(onFire, 'const menuContext = detectContext(snap, cl, opening, wall, clEndpoint, column, columnSlot);'), 1);
  assert.equal(wholeLines(onFire, 'column, columnSlot, columnSlotAddable: columnLP?.addable ?? false,'), 1, 'buildMenuState の引数');
});

test('【配線】usePointerInteraction: setMenu に columnEdit を渡し、柱の文脈では CL／壁／建具を渡さない', () => {
  assert.equal(wholeLines(onFire, 'columnEdit: inColumnContext ? { graph: columnLP.graph, column, slot: columnSlot } : null,'), 1);
  assert.equal(wholeLines(onFire, 'cl: inColumnContext ? null : (clEndpoint ? clEndpoint.cl : cl),'), 1);
  assert.equal(wholeLines(onFire, 'wall: inColumnContext ? null : wall, opening: inColumnContext ? null : opening,'), 1);
  assert.equal(wholeLines(onFire, 'clEndpointSide: !inColumnContext && clEndpoint ? clEndpoint.side : null,'), 1);
  // 柱の文脈では CL 用の判定値を算出しない（延長・短縮の可否）
  assert.equal(wholeLines(onFire, 'canExtend:  clEndpoint && !inColumnContext ? canExtendCenterLine(graph, clEndpoint.cl, clEndpoint.side) : undefined,'), 1);
  assert.equal(wholeLines(onFire, 'canShorten: clEndpoint && !inColumnContext ? canShortenCenterLine(graph, clEndpoint.cl, clEndpoint.side) : undefined,'), 1);
});

test('【配線】usePointerInteraction: 交点 snap（ホバー時のノード）を buildMenuState へ渡す（斜線・円弧・削除を並べるかは menuItems.js が slot の座標と比べて決める）', () => {
  assert.equal(wholeLines(onFire, 'const snap         = snapRef.current;'), 1);
  assert.equal(wholeLines(onFire, 'snap, cl, clEndpoint, opening, wall,'), 1, 'buildMenuState の先頭の引数');
  assert.equal(wholeLines(onFire, 'pos: { x: sx, y: sy }, items: state.items, snap, worldPos: viewport.screenToWorld(sx, sy),'), 1, 'setMenu に snap・worldPos（斜線・円弧・削除が使う）');
});

test('【配線】usePointerInteraction: import（resolveColumnLongPress・CL_THRESHOLD_PX）と composition 引数', () => {
  assert.equal(wholeLines(hookSrc, "import { resolveColumnLongPress } from './columnLongPress.js';"), 1);
  assert.equal(wholeLines(hookSrc, 'CL_THRESHOLD_PX,'), 1);
  assert.equal(wholeLines(hookSrc, 'endpointHitDistancePx,'), 1);
  assert.equal(wholeLines(hookSrc, 'openingHitAt,'), 1);
  assert.equal(wholeLines(hookSrc, 'composition = null,'), 1);
  // 新しいタイマーを足していない（onFire 本体に setTimeout が無い。柱の判定は発火時に同期で行う）
  assert.equal(count(onFire, 'setTimeout('), 0);
});

test('【配線】snap.js: endpointHitDistancePx・openingHitAt の本体は snapGeometry.js の純関数を呼ぶ薄い形（合成の式を持たない）', () => {
  const snapSrc = readSrc('../snap.js').split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
  const distBody = extractFunctionBody(snapSrc, 'export function endpointHitDistancePx(');
  const openBody = extractFunctionBody(snapSrc, 'export function openingHitAt(');
  assert.equal(wholeLines(distBody, 'return minEndpointHitDistPx(tip, leg, world.x, world.y, viewport.scaleX, viewport.scaleY);'), 1);
  assert.equal(count(distBody, 'Math.min'), 0, '合成（min）は純関数の中だけ');
  assert.equal(count(distBody, 'findNearestCenterLineEndpointWithDist('), 1, '突端の候補');
  assert.equal(count(distBody, 'findCenterDimensionLegEndpoint('), 1, '足の候補');
  assert.equal(count(distBody, 'legEndpointForMode('), 1);
  assert.equal(wholeLines(openBody, 'return openingHitApplies(appMode) && findOpeningAt(graph, world.x, world.y, WALL_THRESHOLD_PX, viewport.scaleX, viewport.scaleY) !== null;'), 1);
  assert.equal(count(openBody, 'pointerTargetScope'), 0, '適用モードの判定は純関数の中だけ');
  assert.equal(count(openBody, 'planTargets'), 0);
  assert.equal(wholeLines(snapSrc, 'clEndpointPerpDist, minEndpointHitDistPx, openingHitApplies,'), 1, 'import');
  assert.equal(count(snapSrc, 'function clEndpointPerpDist('), 0, 'snap.js に同名の私有関数を持たない');
});

test('【配線】App.jsx: handleMenuSelect の柱の分岐は startDraw より前で、runColumnMenuAction を 1 回・選択時に編集先を解決し直して呼ぶ', () => {
  const add = menuSelect.indexOf('ColumnMenuItemId.ADD');
  const del = menuSelect.indexOf('ColumnMenuItemId.DEL');
  const draw = menuSelect.indexOf('startDraw(');
  assert.ok(add >= 0 && del >= 0 && draw >= 0);
  assert.ok(add < draw && del < draw, '柱の分岐は startDraw に落ちる前');
  assert.equal(wholeLines(menuSelect, 'if (item.id === ColumnMenuItemId.ADD || item.id === ColumnMenuItemId.DEL) {'), 1);
  assert.equal(count(menuSelect, 'runColumnMenuAction('), 1);
  assert.equal(wholeLines(menuSelect, 'const result = runColumnMenuAction(item.id, {'), 1);
  assert.equal(wholeLines(menuSelect, 'columnEdit: menu.columnEdit,'), 1);
  assert.equal(wholeLines(menuSelect, 'currentTarget: resolveColumnEditTarget({ appMode, activeGraph: graph, composition: structComposition, project, slotView: structSlotView }),'), 1);
  assert.equal(wholeLines(menuSelect, 'if (!result.ok) setToast({ msg: result.error, key: Date.now() });'), 1);
});

// 置き換え（ユーザー裁定2026-11-12 R5）: 以前は「削除が成功したときだけ構造リストの展開カードを閉じる」を固定していた
// （番号をキーにカードを覚えていた頃、削除後の採番で別グループが開いた扱いになるのを防ぐため）。カードを部材の id で
// 覚えるようにしたので、柱の追加・削除の後に開いているカードへは触らない——開いていたグループの柱が残っていれば
// 開いたまま、すべて消えたら MemberListTab 側の取り直しで閉じる（structural/expandedMemberCard.js）。
test('【配線】App.jsx: 柱の追加・削除の後に構造リストの展開カードへ触らない（成功時は何もしない・失敗時はトーストだけ）', () => {
  const toastLine = 'if (!result.ok) setToast({ msg: result.error, key: Date.now() });';
  const at = menuSelect.indexOf(toastLine);
  assert.ok(at >= 0);
  const branchEnd = menuSelect.indexOf('return;', at);
  assert.ok(branchEnd > at);
  assert.equal(menuSelect.slice(at + toastLine.length, branchEnd).trim(), '', 'トーストの行と return の間に別の処理がある');
  // 行頭コメントは除いて数える（「呼ばない」と書いたコメントで赤にしない）。
  const code = menuSelect.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
  assert.ok(code.includes('runColumnMenuAction('), '本体を読めていない');
  assert.equal(count(code, 'deselectStructuralMembers'), 0, 'handleMenuSelect が展開カードを閉じている');
  assert.equal(count(code, 'setMemberDeselectRequest'), 0, 'handleMenuSelect が閉じる合図を直接進めている');
  assert.equal(count(code, 'setMemberFocusRequest'), 0, 'handleMenuSelect が別のカードを開いている');
  // 伏図の選択は開いているカードの鏡写し——ここで直接いじると、カードは開いたまま強調だけが食い違う。
  assert.equal(count(code, 'selectStructuralMembers'), 0, 'handleMenuSelect が伏図の選択を直接変えている');
  assert.equal(count(code, 'selectMembers'), 0, 'handleMenuSelect が伏図の選択を直接変えている');
});

test('【配線】App.jsx: 柱の追加・削除の確定は runColumnMenuAction に一本化（commit を直接呼ばない）・フックへ composition を渡す', () => {
  assert.equal(count(appSrc, 'commitManualColumnAdd('), 0);
  assert.equal(count(appSrc, 'commitManualMemberRemoval('), 0);
  assert.equal(wholeLines(appSrc, 'composition: structComposition,'), 1);
  assert.equal(wholeLines(appSrc, "import { runColumnMenuAction } from './interaction/columnLongPress.js';"), 1);
  assert.equal(wholeLines(appSrc, "import { resolveColumnEditTarget } from './structural/columnEditTarget.js';"), 1);
  assert.equal(wholeLines(appSrc, "import { ColumnMenuItemId } from './core/constants.js';"), 1);
});

// 基礎伏図では柱の長クリックを出さない（S4）: 見せ分けの視点（structSlotView）を長クリックの判定と選択時の再解決へ渡す。
// 行頭コメントを除いた本文で照合する（コメントの文言に一致して合格しない）。
const codeOf = src => src.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
const appCode = codeOf(appSrc);
const hookCode = codeOf(hookSrc);

test('【配線】App.jsx: usePointerInteraction の引数に slotView: structSlotView（呼び出しの内側）。視点の 4 つの const は呼び出しより前で 1 回だけ', () => {
  const callAt = appCode.indexOf('usePointerInteraction({');
  assert.ok(callAt >= 0);
  const callEnd = appCode.indexOf('\n  });', callAt);
  assert.ok(callEnd > callAt);
  assert.equal(wholeLines(appCode.slice(callAt, callEnd), 'slotView: structSlotView,'), 1, '呼び出しの内側に slotView: structSlotView,');
  assert.equal(count(appCode.slice(callAt, callEnd), 'slotView'), 1, '呼び出しの内側で slotView を上書きしていない（後勝ちの 2 つ目が無い）');
  assert.equal(count(appCode, 'usePointerInteraction({'), 1);
  for (const name of ['structSlots', 'savedStructSlot', 'activeStructSlot', 'structSlotView']) {
    assert.equal(count(appCode, `const ${name} =`), 1, `${name} を複製していない（1 回だけ宣言）`);
    assert.ok(appCode.indexOf(`const ${name} =`) < callAt, `const ${name} は usePointerInteraction の呼び出しより前（TDZ）`);
  }
  // 視点が依存する宣言（appMode・structComposition・activeStructSlotKey）はさらに前
  const viewAt = appCode.indexOf('const structSlots =');
  for (const decl of ['const [appMode,', 'const [structComposition,', 'const [activeStructSlotKey,']) {
    const at = appCode.indexOf(decl);
    assert.ok(at >= 0 && at < viewAt, `${decl} は視点の計算より前`);
  }
});

test('【配線】usePointerInteraction.js: 引数 slotView = null を受け、resolveColumnLongPress の呼び出しの内側で渡す', () => {
  assert.equal(wholeLines(hookCode, 'slotView = null,'), 1);
  const callAt = hookCode.indexOf('resolveColumnLongPress({');
  assert.ok(callAt >= 0);
  assert.equal(count(hookCode, 'resolveColumnLongPress({'), 1);
  const callEnd = hookCode.indexOf('\n      });', callAt);
  assert.ok(callEnd > callAt);
  assert.equal(wholeLines(hookCode.slice(callAt, callEnd), 'appMode, activeGraph: graph, composition, project, slotView,'), 1, '呼び出しの内側に slotView');
  assert.equal(count(hookCode.slice(callAt, callEnd), 'slotView'), 1, '呼び出しの内側で slotView を上書きしていない（後勝ちの 2 つ目が無い）');
});
