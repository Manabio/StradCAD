// 天伏モード（appMode 'ceiling'）の配線不変条件（S1a'・S2）。.jsx は node:test から単体 import できないため
// ソーステキスト検査で固定する。1行まるごと一致（m フラグの行頭・行末アンカー）で照合し、行コメントは
// 落としてから検査する（コメント文への誤マッチで変異を見逃さない）。App.jsx の走査は
// uiBusySourceScan.js の共用関数を使う。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { readAppSrc, stripCommentLines, extractArrowFunctionBody, extractFunctionBody } from './uiBusySourceScan.js';

const readSrc = (rel) => fs.readFileSync(path.resolve(import.meta.dirname, rel), 'utf8');
const appCode = stripCommentLines(readAppSrc());

test('【配線】App.jsx: ceiling のローダーは CeilingModeState を new して await s.init() してから返す（材データのロード。finish と同型）', () => {
  assert.match(appCode,
    /^\s*\? import\('\.\/modes\/CeilingModeState\.js'\)\.then\(async m => \{\s*$/m);
  const start = appCode.indexOf("import('./modes/CeilingModeState.js')");
  assert.ok(start >= 0, 'CeilingModeState のローダーが見つからない');
  const block = appCode.slice(start, appCode.indexOf('})', start));
  assert.match(block, /^\s*const s = new m\.CeilingModeState\(\);\s*$/m);
  assert.match(block, /^\s*await s\.init\(\);/m);
  assert.match(block, /^\s*return s;\s*$/m);
  assert.match(appCode, /^\s*: appMode === 'ceiling'\s*$/m);
});

test('【配線】App.jsx: 天伏の階段下の群は、直下階 peek（belowPlanPeek）から mode.setStairUnderContext へ渡す。未解決の間は渡さず、別の階の peek・graph なしは null（分けない）。階高は自階（floorHeightAbove）', () => {
  const start = appCode.indexOf("appMode !== 'ceiling' || !mode?.setStairUnderContext || belowPlanPeek === undefined");
  assert.ok(start >= 0, '天伏の stairUnderContext の effect が見つからない');
  const block = appCode.slice(start, appCode.indexOf('\n  }, [', start));
  assert.match(block, /^\s*const adopted = !!active && project\.planes\.some\(p => p\.id === active\.id\);\s*$/m, '採用階に無い平面（検討案）は判定できない');
  assert.match(block, /^\s*if \(!adopted\) \{\s*$/m);
  assert.match(block, /^\s*\} else if \(belowPlanPeek === null\) \{\s*$/m, '採用階で下階なし＝最下階だけ lowerStairCellBounds: []');
  assert.match(block, /^\s*\} else if \(belowPlanPeek\.graph && belowPlanPeek\.activePlaneId === active\.id\) \{\s*$/m, '別の階の peek・graph なしは ctx null のまま');
  assert.match(block, /^\s*lowerStairCellBounds: below\.stairs\.map\(s => \(\{ stair: s, cellBounds: cellBoundsList\(s\.cells, below\) \}\)\),\s*$/m);
  assert.equal((block.match(/floorHeightMm: floorHeightAbove\(project, active\)/g) ?? []).length, 2, '階高は自階（belowPlanPeek.floorHeightMm は直下階の階高なので使わない）');
  assert.ok(!/belowPlanPeek\.floorHeightMm/.test(block));
  assert.match(block, /^\s*mode\.setStairUnderContext\(ctx\);\s*$/m);
});

test('【配線】App.jsx: 天伏の外部タブ（軒裏）は、直上階 peek（abovePlanPeek）から mode.setAboveRoofContext へ渡す。未解決の間は渡さず、上階なし・別の階の peek・graph なしは null', () => {
  const start = appCode.indexOf("appMode !== 'ceiling' || !mode?.setAboveRoofContext || abovePlanPeek === undefined");
  assert.ok(start >= 0, '天伏の aboveRoofContext の effect が見つからない');
  const end = appCode.indexOf('\n  }, [', start);
  const block = appCode.slice(start, end);
  assert.match(block, /^\s*const ctx = abovePlanPeek\?\.graph && abovePlanPeek\.activePlaneId === active\?\.id\s*$/m, '別の階の peek・上階なし(null)・graph なしは ctx null');
  assert.match(block, /^\s*\? \{ planeId: active\.id, aboveGraph: abovePlanPeek\.graph \}\s*$/m);
  assert.match(block, /^\s*: null;\s*$/m);
  assert.match(block, /^\s*mode\.setAboveRoofContext\(ctx\);\s*$/m);
  assert.ok(appCode.slice(end, end + 120).startsWith('\n  }, [appMode, mode, abovePlanPeek, activeFloorId]);'), 'deps');
});

test('【配線】App.jsx: CeilingPanel は appMode === ceiling && mode のときだけマウントし、graph/mode/project/isLandscape を渡す（階高は渡さない。階段の傾斜の初期値は commitDrag の ctx 側で引く。S12b。project は外部タブの最上階判定・主構造用）', () => {
  assert.match(appCode, /^\s*\{appMode === 'ceiling' && mode && \(\s*$/m);
  assert.match(appCode, /^\s*<CeilingPanel graph=\{graph\} mode=\{mode\} project=\{project\} isLandscape=\{isLandscape\} \/>\s*$/m);
  assert.match(appCode, /^import \{ CeilingPanel \} +from '\.\/ceiling\/CeilingPanel\.jsx';\s*$/m);
});

test('【配線】App.jsx: 天伏は仕上げ表パネルを出さず、modeBoundaries の ceiling: は enter（壁の鮮度判定）だけで exit を持たない（天伏は壁の入力を書かない）', () => {
  const start = appCode.indexOf('const modeBoundaries = {');
  assert.ok(start >= 0, 'const modeBoundaries = { が見つからない');
  const end = appCode.indexOf('\n  };', start);
  assert.ok(end > start, 'modeBoundaries の閉じが見つからない');
  const registry = appCode.slice(start, end);
  const cStart = registry.search(/^\s*ceiling:/m);
  assert.ok(cStart >= 0, 'modeBoundaries に ceiling: が無い');
  const ceilingBlock = registry.slice(cStart).split(/\r?\n/).filter(l => !l.trim().startsWith('//')).join('\n');
  assert.ok(/enter:/.test(ceilingBlock) && !/exit:/.test(ceilingBlock), 'ceiling: は enter だけを持つはず');
  assert.ok(!/finishPanelTabIds|tabIds=/.test(appCode), 'App.jsx に仕上げ表の tabIds 絞り込みが残っている（兼用案）');
  assert.match(appCode, /^\s*\{appMode === 'finish' && mode && !mode\.namingRoomId && \(\s*$/m);
});

test('【配線】CeilingPanel.jsx: タブは mode.setActiveTab、行は ceilingPanelRows、横長は ModePanel・縦長は BottomSheet（title 天伏）', () => {
  const code = stripCommentLines(readSrc('ceiling/CeilingPanel.jsx'));
  assert.match(code, /^\s*onClick=\{\(\) => mode\.setActiveTab\(tab\.id\)\}\s*$/m);
  assert.match(code, /^\s*const stairUnderKeys = mode\.stairUnderKeysOf\(graph\);/m, '階段下の群の判定は mode.stairUnderKeysOf（下階の判定材料は App が渡す）');
  assert.match(code, /^\s*const tree = ceilingPanelTree\(graph, mode\.activeTab, mode\.materialMap, stairUnderKeys\);\s*$/m);
  assert.match(code, /^\s*const lines = ceilingPanelLines\(tree, mode\.expandedPath\);\s*$/m);
  assert.match(code, /^\s*onClick=\{\(\) => mode\.selectNode\(graph, node\.id, line\.path\)\}\s*$/m, '行クリックは群を選ぶ（タブは切り替えない）。開く経路は押された行の祖先（line.path）');
  assert.match(code, /<ModePanel title="天伏" /);
  assert.match(code, /<BottomSheet title="天伏" /);
  // S3 で材選択の部品 MaterialSelect だけは仕上げ表から共用する（旧: FinishTable 全般を禁止）。表本体・State は引かない。
  assert.ok(!/FinishModeState|<FinishTable\b/.test(code), 'CeilingPanel が FinishModeState／仕上げ表本体を引いている');
  const finishTableImports = code.split(/\r?\n/).filter(l => /^import .* from '.*FinishTable/.test(l));
  assert.deepEqual(finishTableImports, ["import { MaterialSelect } from '../finish/FinishTable.jsx';"]);
});

test('【配線】CeilingPanel.jsx（S10）: 行の天井材・仕上げの MaterialSelect 2つ（panel／finish）が setOverride／clearOverride を withFinishUndo で包んで部屋に書く。書込み先は行から ceilingWriteTargetRoom。上段に CeilingMaterialFields は無い', () => {
  const code = stripCommentLines(readSrc('ceiling/CeilingPanel.jsx'));
  assert.match(code, /^\s*\{ key: 'ceilingPanel', {2}label: '天井材', category: 'panel' \},\s*$/m);
  assert.match(code, /^\s*\{ key: 'ceilingFinish', label: '仕上げ', category: 'finish' \},\s*$/m);
  assert.match(code, /^\s*onChange=\{v => \{ withFinishUndo\(graph, \(\) => \(v === '' \? room\.clearOverride\(field\.key\) : room\.setOverride\(field\.key, v\)\)\); markDirty\(\); \}\}\s*$/m);
  assert.match(code, /^\s*<RowMaterialSelect graph=\{graph\} mode=\{mode\} room=\{node\.room\} field=\{f\} \/>\s*$/m, '書込み先はノードの room（階段は対の部屋。木の生成が ceilingWriteTargetRoom で解く）');
  assert.ok(!/CeilingMaterialFields/.test(code), '上段の CeilingMaterialFields が残っている');
  assert.match(code, /^import \{ withFinishUndo \} from '\.\.\/finish\/finishUndo\.js';\s*$/m);
});

test('【配線】CeilingPanel.jsx（S12c）: 三角は行末の最後の <td> に全ノード無条件で出す（行頭に戻さない）。クリックは toggleNode(depth, id) で行の選択へ伝播させない', () => {
  const code = stripCommentLines(readSrc('ceiling/CeilingPanel.jsx'));
  assert.ok(!/hasZones/.test(code), '三角の出し分け（hasZones）が残っている');
  assert.match(code, /^\s*aria-label=\{expanded \? '内訳を閉じる' : '内訳を開く'\}\s*$/m);
  assert.match(code, /^\s*onClick=\{e => \{ e\.stopPropagation\(\); mode\.toggleNode\(depth, node\.id\); \}\}\s*$/m);
  // 三角のボタンは行（NodeRow）の最後の <td> の中。その後ろに <td> が続かない
  const row = code.slice(code.indexOf('const NodeRow'), code.indexOf('const InnerRow'));
  const lastTd = row.lastIndexOf('<td');
  assert.ok(lastTd >= 0 && row.indexOf('<button', lastTd) > lastTd, '三角のボタンが最後の <td> の中にある');
  assert.equal((row.match(/<button/g) ?? []).length, 1, '行に三角のボタンは1つ');
  const firstTd = row.indexOf('<td');
  assert.ok(!row.slice(firstTd, row.indexOf('</td>', firstTd)).includes('<button'), '先頭の <td>（部屋名）に三角を置かない');
  assert.ok(!/toggleExpandedRow|expandedRowId|selectRoom\(/.test(code), '旧の展開 API が残っている');
  assert.match(code, /^\s*\{ key: 'toggle',\s+label: '',\s+width: 28 \},\s*\n\];\s*$/m, '三角の列は COLUMNS の最後');
});

test('【配線】CeilingPanel.jsx（S12c）: 並び替えは持たない（draggable・onDrag* は0件）。パネルは ceilingPanelLines の出力を種類で描くだけで、旧行関数を直接呼ばない', () => {
  const code = stripCommentLines(readSrc('ceiling/CeilingPanel.jsx'));
  assert.equal((code.match(/draggable/g) ?? []).length, 0);
  assert.equal((code.match(/onDrag|onDrop|dataTransfer/g) ?? []).length, 0);
  assert.equal((code.match(/\binteriorRows\(|\bstairRows\(|\browZoneDetail\(|\bselectionGroupInfo\(|\bselectionSummary\(|\bzoneDetailRows\(|\bremainderRow\(|\bstairZoneDetailRows\(/g) ?? []).length, 0, '木の生成は ceilingPanelRows.js の中');
  assert.equal((code.match(/ceilingPanelLines\(/g) ?? []).length, 1);
  assert.equal((code.match(/ceilingPanelTree\(/g) ?? []).length, 1);
  assert.match(code, /^\s*\{lines\.map\(line => \(\s*$/m);
  assert.match(code, /^\s*<PanelLine key=\{line\.key\} graph=\{graph\} mode=\{mode\} line=\{line\} selectedId=\{selectedId\} \/>\s*$/m);
});

test('【配線】CeilingPanel.jsx: 部屋の無い階段（room が null）では天井材・仕上げの select は disabled で「—」の1択', () => {
  const code = stripCommentLines(readSrc('ceiling/CeilingPanel.jsx'));
  assert.match(code, /^\s*<select disabled value="" style=\{\{ width: '100%', minWidth: 0, fontSize: 12 \}\} title="部屋の無い階段には天井材・仕上げを指定できません">\s*$/m);
  assert.match(code, /^\s*<option value="">—<\/option>\s*$/m);
});

test('【配線】FinishTable.jsx: INTERIOR_FIELDS の天井グループは 天井材(panel)・仕上げ(finish)・H・周り縁 の4列で、旧 ceilingMaterial を持たない', () => {
  const code = stripCommentLines(readSrc('finish/FinishTable.jsx'));
  assert.match(code, /^\s*\{ key: 'ceilingPanel',\s+label: '天井材',\s+group: '天井', groupSpan: 4, kind: 'material', category: 'panel',\s+source: 'master' \},\s*$/m);
  assert.match(code, /^\s*\{ key: 'ceilingFinish',\s+label: '仕上げ',\s+group: null,\s+groupSpan: 0, kind: 'material', category: 'finish', source: 'master' \},\s*$/m);
  assert.match(code, /^\s*\{ key: 'ceilingHeight',\s+label: 'H',/m);
  assert.match(code, /^\s*\{ key: 'cornice',\s+label: '周り縁',/m);
  assert.ok(!/ceilingMaterial/.test(code), 'FinishTable.jsx に旧 ceilingMaterial が残っている');
  assert.match(code, /^\s*\['ceilingPanel', 'ceilingFinish'\],\s*$/m);
});

// ---- usePointerInteraction.js: 天伏はガター内パン・ピンチ＋天井セルのドラッグ選択（S2）----
const pointerSrc = readSrc('interaction/usePointerInteraction.js');
const lines = (code) => code.split(/\r?\n/);

// S8b: move・up の天伏分岐は天井芯の移動中（moveState）は汎用の CL 移動へ落とすため、条件に moveState の否定が付く。
const CEILING_IF = "if (appMode === 'ceiling') {";
const CEILING_IF_NOT_MOVING = "if (appMode === 'ceiling' && !modeRef.current?.moveState) {";

/** ハンドラ本体のうち天伏の `if (...) {` ブロック（閉じ括弧まで）の行。header で条件行を指定する。 */
function ceilingBlock(body, header = CEILING_IF) {
  const all = lines(body);
  const i = all.findIndex(l => l.trim() === header);
  assert.ok(i >= 0, `${header} が見つからない`);
  const indent = all[i].match(/^\s*/)[0];
  const j = all.findIndex((l, k) => k > i && l === `${indent}}`);
  assert.ok(j > i, 'ceiling ブロックの閉じ括弧が見つからない');
  return all.slice(i, j + 1).map(l => l.trim());
}

test('【配線】usePointerInteraction: pointerDown の ceiling 分岐はガター内ならパン、moveState があれば moveDownRef を立てて汎用の移動へ、それ以外は「なぞりができる点か」（startDrag の intent）だけ判定して cancelDrag し、ref を立てて updateSnap→longPress.begin（2026-10-19）。findGutterCL( より前で return する', () => {
  const body = extractArrowFunctionBody(pointerSrc, 'const handlePointerDown = (e) => {');
  const block = ceilingBlock(body);
  for (const line of [
    'const inGutter = isInGutter(clientX, clientY, size.width, size.height);',
    'drag.current = { lastX: clientX, lastY: clientY };',
    'setIsPanning(true);',
    'if (modeRef.current?.moveState) {',
    'moveDownRef.current = { x: clientX, y: clientY };',
    'modeRef.current?.startDrag(graph, world.x, world.y);',
    "const canTrace = modeRef.current?.dragState?.intent === 'create';",
    'modeRef.current?.cancelDrag();',
    'ceilingDragDownRef.current = { x: clientX, y: clientY, canTrace, deciding: false };',
    'updateSnap(clientX, clientY); // 長押しメニューの対象（天井芯・端点・空）を押下点で解決する',
    'longPress.begin(clientX, clientY);',
    'return;',
  ]) assert.ok(block.includes(line), `down: ${line} が無い`);
  // 判定だけして dragState はすぐ捨てる（パンのつもりの押下でプレビューを出さない）: startDrag → canTrace → cancelDrag → 記録 の順
  const iStart = block.indexOf('modeRef.current?.startDrag(graph, world.x, world.y);');
  const iCancel = block.indexOf('modeRef.current?.cancelDrag();');
  const iRef = block.indexOf('ceilingDragDownRef.current = { x: clientX, y: clientY, canTrace, deciding: false };');
  assert.ok(iStart < iCancel && iCancel < iRef, 'down: startDrag→cancelDrag→記録 の順でない');
  assert.ok(iRef < block.indexOf('updateSnap(clientX, clientY); // 長押しメニューの対象（天井芯・端点・空）を押下点で解決する'));
  // moveState の分岐が 押下の記録より前（移動中は長押しを始めない）
  assert.ok(block.indexOf('if (modeRef.current?.moveState) {') < iStart);
  // 移動中はガターの押下でもパンにせず moveDownRef を立てる（汎用経路と同じ順序）: moveState 分岐が isInGutter( より前
  assert.ok(block.findIndex(l => l.includes('modeRef.current?.moveState')) < block.findIndex(l => l.includes('isInGutter(')),
    'ceiling の down で moveState の分岐が isInGutter( より後ろにある（移動中のガター押下がパンになる）');
  // 長押しを始めるのは updateSnap の後（メニューの対象を押下点で解決してから）
  assert.ok(block.indexOf('updateSnap(clientX, clientY);') < block.indexOf('longPress.begin(clientX, clientY);'));
  const i = body.indexOf(CEILING_IF);
  assert.ok(i < body.indexOf('findGutterCL('), 'ceiling 分岐が findGutterCL( より後ろにある');
  // 通り芯のガター長押し（gutterLongPress.begin）には入らない
  assert.ok(i < body.indexOf('gutterLongPress.begin('), 'ceiling 分岐が gutterLongPress.begin( より後ろにある');
});

test('【配線】usePointerInteraction: pointerMove の ceiling 分岐は moveState が無いときだけ。パン維持／なぞり中は updateDrag（サンプル間隔 4px）／8px 超で ceilingDragStart（即パン or 判定窓）、窓の中で CEILING_PAN_PX 超ならパン、窓が閉じれば startCeilingTrace。移動中は汎用の CL 移動へ落ちる（S8b・2026-10-19）', () => {
  const body = extractArrowFunctionBody(pointerSrc, 'const handlePointerMove = (e) => {');
  const block = ceilingBlock(body, CEILING_IF_NOT_MOVING);
  for (const line of [
    'if (drag.current) { panTo(clientX, clientY); return; }',
    'const down = ceilingDragDownRef.current;',
    'if (!down) return;',
    'if (modeRef.current?.dragState) {',
    'modeRef.current?.updateDrag(graph, world.x, world.y, CEILING_DRAG_SAMPLE_PX / viewport.scaleX);',
    'const dist = Math.hypot(clientX - down.x, clientY - down.y);',
    'if (!down.deciding) {',
    'if (!longPress.move(clientX, clientY)) return;',
    "if (ceilingDragStart({ canTrace: down.canTrace, dist }) === 'pan') { startPanAt(clientX, clientY); return; }",
    'down.deciding = true;',
    'ceilingDecideTimerRef.current = setTimeout(() => { ceilingDecideTimerRef.current = null; startCeilingTrace(); }, CEILING_DECIDE_MS);',
    'if (dist > CEILING_PAN_PX) {',
    'clearCeilingDecide();',
    'startPanAt(clientX, clientY);',
    'return;',
  ]) assert.ok(block.includes(line), `move: ${line} が無い`);
  assert.ok(block.indexOf('if (modeRef.current?.dragState) {') < block.indexOf('if (!down.deciding) {'), 'なぞり中の判定が見分けより後ろにある');
  assert.match(pointerSrc, /^const CEILING_DRAG_SAMPLE_PX = 4;\s*$/m);
  const i = body.indexOf(CEILING_IF_NOT_MOVING);
  assert.ok(i < body.indexOf('updateSnap('), 'ceiling 分岐が updateSnap( より後ろにある');
  // 汎用の CL 移動（moveState を読んで updateMove する）より前にあり、moveState 中はそこへ落ちる
  assert.ok(i < body.indexOf('const ms = modeRef.current?.moveState;'), 'ceiling 分岐が汎用の CL 移動より後ろにある');
  assert.ok(body.includes('modeRef.current?.updateMove(newVal)'), '汎用の CL 移動（updateMove）が無い');
});

test('【配線】usePointerInteraction: pointerUp の ceiling 分岐は moveState が無いときだけ。判定窓を捨て、dragState（なぞり）があれば commitDrag（tap は isTapDistance）、無ければ releaseGesture が tap かつ 8px 未満のときだけ押下点で startDrag→commitDrag({tap:true}) してから ref を戻し、longPress.abort してパンを解除して return（S8b・2026-10-19）', () => {
  const body = extractArrowFunctionBody(pointerSrc, 'const handlePointerUp = (e) => {');
  const block = ceilingBlock(body, CEILING_IF_NOT_MOVING);
  const clear = block.indexOf('clearCeilingDecide();');
  const commit = block.indexOf('modeRef.current.commitDrag({ tap: isTapDistance(tapDist), ctx: { graph, project } });');
  const gate = block.indexOf("} else if (releaseGesture({ fired: longPress.hasFired(), panned: !!drag.current }) === 'tap' && isTapDistance(tapDist)) {");
  const tapCommit = block.indexOf('modeRef.current?.commitDrag({ tap: true, ctx: { graph, project } });');
  const reset = block.indexOf('ceilingDragDownRef.current = null;');
  assert.ok(clear >= 0 && clear < commit, 'up: 判定窓のタイマーを捨てるのが先頭に無い');
  assert.ok(block.indexOf('if (modeRef.current?.dragState) {') < commit && commit >= 0, 'up: なぞりの確定 commitDrag({ tap: isTapDistance(tapDist), ctx: { graph, project } }) が無い（S12b: 区画の作成に ctx が要る）');
  assert.ok(gate > commit, 'up: クリックの見分け（releaseGesture が tap かつ isTapDistance）が無い');
  assert.ok(tapCommit > gate, 'up: クリックの commitDrag({ tap: true, ctx }) が無い（空白のタップで選択解除）');
  assert.ok(block.indexOf('modeRef.current?.startDrag(graph, world.x, world.y);') < tapCommit, 'up: クリックは commitDrag の前に押下点で startDrag する');
  assert.equal(pointerSrc.split('ctx: { graph, project } })').length - 1, 2, 'ctx 付きの commitDrag は天伏の2箇所だけ（なぞりの確定とクリック。仕上げは ctx なし）');
  assert.ok(reset > tapCommit, 'up: ref を戻すのが commitDrag より前にある（または無い）');
  assert.ok(block.lastIndexOf('longPress.abort();') > reset, 'up: ref を戻した後の longPress.abort() が無い');
  for (const line of ['drag.current = null;', 'setIsPanning(false);', 'return;']) {
    assert.ok(block.includes(line), `up: ${line} が無い`);
  }
  assert.ok(body.indexOf(CEILING_IF_NOT_MOVING) < body.indexOf('commitCLMove('), 'ceiling 分岐が commitCLMove( より後ろにある');
});

test('【配線】usePointerInteraction: pointerLeave の ceiling 分岐は cancelDrag して ref とパンを戻し longPress.abort し、moveState があれば cancelMove して return。resetGestureRefs も ref を戻す', () => {
  const body = extractArrowFunctionBody(pointerSrc, 'const handlePointerLeave = () => {');
  const block = ceilingBlock(body);
  for (const line of [
    'modeRef.current?.cancelDrag();',
    'ceilingDragDownRef.current = null;',
    'longPress.abort();',
    'if (modeRef.current?.moveState) {',
    'moveDownRef.current = null;',
    'modeRef.current?.cancelMove();',
    'drag.current = null;',
    'setIsPanning(false);',
    'return;',
  ]) assert.ok(block.includes(line), `leave: ${line} が無い`);
  assert.ok(block.indexOf('if (modeRef.current?.moveState) {') < block.indexOf('modeRef.current?.cancelMove();'));
  const reset = extractFunctionBody(pointerSrc, 'function resetGestureRefs');
  assert.match(reset, /^\s*ceilingDragDownRef\.current = null;\s*$/m);
});

test('【配線】usePointerInteraction: longPress の onFire は天伏ならメニュー組立の前に（なぞりを始めないとき）cancelDrag して ceilingDragDownRef を捨て、移動の先読み・開始に ctx { graph, project } を渡す（S8b。なぞり／メニューの見分けは holdGesture.test.js）', () => {
  const fire = extractArrowFunctionBody(pointerSrc, 'onFire:   (sx, sy) => {');
  const lines2 = lines(fire).map(l => l.trim());
  const gate = lines2.indexOf("if (appMode === 'ceiling') {");
  assert.ok(gate >= 0, "onFire: if (appMode === 'ceiling') { が無い");
  const cancel = lines2.indexOf('modeRef.current?.cancelDrag();');
  const drop = lines2.indexOf('ceilingDragDownRef.current = null;');
  assert.ok(cancel > gate && drop > gate, 'onFire: cancelDrag／ref の破棄が ceiling ガードの中に無い');
  assert.ok(lines2.indexOf('const state = buildMenuState(appMode, {') > Math.max(cancel, drop), 'onFire: cancelDrag がメニュー組立より後ろにある');
  assert.ok(lines2.includes('if (state.clState?.canMove) modeRef.current.preloadMove(cl, { graph, project });'), 'onFire: preloadMove に ctx が無い');
  assert.match(pointerSrc, /^\s*if \(gutterCLRef\.current\) modeRef\.current\?\.preloadMove\(gutterCLRef\.current, \{ graph, project \}\);\s*$/m);
  assert.match(pointerSrc, /^\s*const err = await modeRef\.current\?\.startMove\(cl, \{ graph, project \}\);\s*$/m);
});

test('【配線】App.jsx: 天伏の天井芯の移動（startMove に ctx）・カーソル grab・追加の nearbyCLs は描画対象（isRenderTarget）で絞る（S8b）', () => {
  assert.match(appCode, /^\s*const err = await modeRef\.current\?\.startMove\(cl, \{ graph, project \}\);\s*$/m);
  assert.match(appCode, /^\s*: appMode === 'ceiling' \? \(isMoving \? 'grab' : 'default'\)\s*$/m);
  assert.match(appCode, /^\s*\)\.filter\(cl => isRenderTarget\(cl, appMode\)\);\s*$/m);
  assert.match(appCode, /^import \{ isRenderTarget \} from '\.\/core\/centerLineKindPolicy\.js';\s*$/m);
  assert.ok(!/isHitTestTarget/.test(appCode), 'App.jsx に isHitTestTarget が残っている');
});

test('【配線】App.jsx: interruptCurrentAction は cancelMove?.() と cancelDrag?.() を呼ぶ（天伏の移動中・セルドラッグ中の中断）', () => {
  const body = extractFunctionBody(readAppSrc(), 'function interruptCurrentAction');
  assert.match(body, /^\s*modeRef\.current\?\.cancelMove\?\.\(\);\s*$/m);
  assert.match(body, /^\s*modeRef\.current\?\.cancelDrag\?\.\(\);/m);
});

test('【配線】AddCLDialog.jsx: KINDS_BY_MODE.ceiling は天井芯の1種だけ（通り芯・中心・補助線を出さない）', () => {
  const code = stripCommentLines(readSrc('ui/AddCLDialog.jsx'));
  assert.match(code, /^const CEILING_KIND = \{ id: 'ceiling', label: '天井芯', hint: '[^']+' \};\s*$/m);
  assert.match(code, /^const KINDS_BY_MODE = \{ structure: \[BEAM_KIND\], ceiling: \[CEILING_KIND\] \};\s*$/m);
});

test('【配線】snap.js resolvePointerTargets: 天伏は交点を解決せず、壁・建具を候補にせず、CENTER 寸法の足は hit 種別で絞る（S8b）', () => {
  const code = stripCommentLines(readSrc('snap.js'));
  assert.match(code, /^\s*const scope = pointerTargetScope\(appMode\);\s*$/m);
  assert.match(code, /^\s*const snap {2}= scope\.intersection\s*$/m);
  assert.match(code, /^\s*const planTargets = scope\.planTargets;\s*$/m);
  assert.match(code, /^\s*const clEndpointLeg = legEndpointForMode\(\s*$/m);
  assert.match(code, /^\s*appMode\);\s*$/m);
});

test('【配線】menuItems.js buildMenuState: 天伏は 天井芯の線上・端点・空 以外の文脈で null を返す（多層防御）', () => {
  const code = stripCommentLines(readSrc('interaction/menuItems.js'));
  assert.match(code, /^\s*if \(appMode === 'ceiling'\s*$/m);
  assert.match(code, /^\s*&& context !== CONTEXT\.CENTER_LINE && context !== CONTEXT\.CENTER_LINE_ENDPOINT && context !== CONTEXT\.EMPTY\) return null;\s*$/m);
});

test('【配線】SceneLayers: CeilingSelectionLayer は ceiling のときだけ、平面の線（ShapesLayer）より下にマウントし、mode の選択とプレビューを渡す', () => {
  const code = stripCommentLines(readSrc('renderer/SceneLayers.jsx'));
  assert.match(code, /^import \{ CeilingSelectionLayer \} from '\.\.\/ceiling\/CeilingSelectionLayer\.jsx';\s*$/m);
  const gate = code.search(/^\s*\{appMode === 'ceiling' && mode && \(\s*$/m);
  assert.ok(gate >= 0, "{appMode === 'ceiling' && mode && ( が無い");
  assert.match(code,
    /^\s*<CeilingSelectionLayer graph=\{graph\} viewport=\{viewport\} selectedCellKeys=\{mode\.selectedCellKeys\} previewCells=\{mode\.previewCells\} \/>\s*$/m);
  assert.ok(gate < code.indexOf('<ShapesLayer'), 'CeilingSelectionLayer が ShapesLayer より後ろにある');
});

test('【配線】CeilingPanel.jsx（S12c）: 行の強調は選択中の群 id とノード id の一致だけ（selectedNodeId。群が今は無い選択は選択なし扱い）', () => {
  const code = stripCommentLines(readSrc('ceiling/CeilingPanel.jsx'));
  assert.match(code, /^\s*const selectedId = selectedNodeId\(graph, mode\.selection, stairUnderKeys\);/m);
  assert.match(code, /^\s*style=\{\{ cursor: 'pointer', background: node\.id === selectedId \? '#eff6ff' : '#fff' \}\}\s*$/m);
  assert.ok(!/selectedRoomId === |=== mode\.selectedRoomId|owner\.rowId === /.test(code), '行 id／所属 rowId での強調判定が残っている');
});
