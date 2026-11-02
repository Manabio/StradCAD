// ヘルパー画面の部屋の取り合い（junction）の試し込みと「空気との境目」の印（部分詳細図 S8a）のテスト。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PenDir, DetailLenMode, DetailEdgeMark, DetailCategory, DetailView, DetailSubject, DetailMaterialField, DetailParam } from '../core/constants.js';
import {
  newDraft, applyPen, setClassification, setMoveMode, setMoveEdge, moveRows, entryFromForm, formFromEntry, validation,
  tryFit, junctionSlotOf, fitDimFieldsFor, usesBaseboardHeightParam, defaultFitDimsFor, isElevationFigureForm, setAnchor, addDatum, setDatumField, previewPrimitivesOf,
  DETAIL_HELPER_TEXT, FIT_DIM_FIELDS,
} from './detailHelperForm.js';
import { PREVIEW_AIR_EDGE_WIDTH_PX } from '../detail/detailPreview.js';
import { ERR_DETAIL_DATUM_UNSUPPORTED, DETAIL_TARGET_JUNCTION } from '../error.js';

const idFactory = () => 'abc';
const KEY = { strokeId: 's1', moveIndex: 1 };

function draw(form, steps) {
  let f = form;
  for (const [dir, len] of steps) f = applyPen(f, dir, len).form;
  return f;
}

// 床と壁の取り合いの下書き（分類 junction/section/floorWall）。s の origin＝壁の仕上げ面・t の origin＝FL に変えて、
// 壁の中へ L 固定 5 → L 伸縮（s の end＝壁の反対の面）を描く。
function junctionDraft() {
  let f = newDraft({ idFactory });
  f = setClassification(f, 'category', DetailCategory.JUNCTION);
  assert.equal(f.view, DetailView.SECTION);
  assert.equal(f.subject, DetailSubject.FLOOR_WALL);
  f = draw({ ...f, label: '巾木' }, [[PenDir.LEFT, '5'], [PenDir.LEFT, '50']]);
  f = setMoveMode(f, KEY, DetailLenMode.STRETCH);
  // 既定の基準 role を junction 用へ（s: 壁の仕上げ面・t: FL）。s の end を追加して頂点 2 に載せる
  f = { ...f, datums: f.datums.map(d => (d.axis === 't' ? { ...d, role: 'fl' } : { ...d, role: 'wallFinishFace' })) };
  f = addDatum(f, { axis: 's', kind: 'end', role: 'wallFinishFace' });
  return setAnchor(f, 's1', 'd3', 2);
}

test('junctionSlotOf: junction/section/floorWall・wallCeiling の分類だけ slot を返す。それ以外は null', () => {
  const f = junctionDraft();
  assert.equal(junctionSlotOf(f), 'floorWall');
  assert.equal(junctionSlotOf(setClassification(f, 'subject', DetailSubject.WALL_CEILING)), 'wallCeiling');
  assert.equal(junctionSlotOf(newDraft({ idFactory })), null, '既定（paired）は取り合いでない');
  assert.equal(junctionSlotOf(setClassification(f, 'category', DetailCategory.PART)), null);
  assert.equal(junctionSlotOf(null), null);
});

test('試し込みの欄: 取り合いは壁厚だけ（三方枠は 3 欄・姿図は 3 欄とは別）', () => {
  const f = junctionDraft();
  assert.deepEqual(fitDimFieldsFor(f).map(x => x.field), ['wallThickness']);
  assert.equal(fitDimFieldsFor(newDraft({ idFactory })), FIT_DIM_FIELDS);
  assert.equal(isElevationFigureForm(f), false);
});

test('tryFit: 取り合いは壁厚に合わせる（s の end が −壁厚）。壁厚の文字列も数値も受ける', () => {
  const f = junctionDraft();
  assert.equal(validation(f).ok, true, JSON.stringify(validation(f).errors));
  const fitted = tryFit(f, { wallThickness: '100' });
  assert.equal(fitted.error, undefined);
  assert.deepEqual(fitted.strokes[0].points.map(p => [p.s, p.t]), [[0, 0], [-5, 0], [-100, 0]]);
  assert.deepEqual(tryFit(f, { wallThickness: 100 }).strokes[0].points.map(p => p.s), [0, -5, -100]);
});

test('【失敗系】tryFit(junction): 壁厚が正の数でない・基準の組が供給外・壁厚が固定寸法に足りない・材束縛で材マップ無しは error（黙って代用しない）', () => {
  const f = junctionDraft();
  for (const bad of ['', 'x', '0', '-5', undefined]) {
    assert.equal(tryFit(f, { wallThickness: bad }).error.code, 'badFitDim', String(bad));
  }
  assert.equal(tryFit(f, { wallThickness: '4' }).error.code, 'fixedExceedsTarget');
  // 供給外の基準（建具の開口外面）を足すと UNSUPPORTED_DATUM
  const odd = setDatumField(addDatum(f, { axis: 't', kind: 'end' }), 'd4', 'role', 'openingOuter');
  const r = tryFit(odd, { wallThickness: '100' });
  assert.equal(r.error.code, 'unsupportedDatum');
  assert.equal(r.error.message, ERR_DETAIL_DATUM_UNSUPPORTED('d4', 'openingOuter・t・end', DETAIL_TARGET_JUNCTION));
  // 材束縛: 材マップ無しは未解決、材マップがあれば解ける
  const MAT = '101000000001';
  const matForm = setMoveMode(f, { strokeId: 's1', moveIndex: 0 }, DetailLenMode.MATERIAL, { code: MAT, field: DetailMaterialField.THICKNESS });
  assert.equal(tryFit(matForm, { wallThickness: '100' }).error.code, 'unresolvedMaterial');
  const ok = tryFit(matForm, { wallThickness: '100' }, { materialMap: new Map([[MAT, { thickness: 12, x: 0, y: 0 }]]) });
  assert.deepEqual(ok.strokes[0].points.map(p => p.s), [0, -12, -100]);
});

test('【S8c】巾木高さ param: 使う床と壁の図は試し込みに巾木高さの欄（既定 60）が出る。値に追従し、無ければ param 未解決・0 以下は badFitDim', () => {
  const f = junctionDraft();
  assert.equal(usesBaseboardHeightParam(f), false);
  assert.deepEqual(fitDimFieldsFor(f).map(x => x.field), ['wallThickness'], '使わない図は壁厚だけ');
  const bb = setMoveMode(f, { strokeId: 's1', moveIndex: 0 }, DetailLenMode.PARAM, { param: DetailParam.BASEBOARD_HEIGHT });
  assert.equal(usesBaseboardHeightParam(bb), true);
  assert.deepEqual(fitDimFieldsFor(bb).map(x => x.field), ['wallThickness', 'baseboardHeight']);
  assert.equal(defaultFitDimsFor(bb, 100).baseboardHeight, '60');
  assert.deepEqual(tryFit(bb, { wallThickness: '100', baseboardHeight: '70' }).strokes[0].points.map(p => p.s), [0, -70, -100]);
  assert.deepEqual(tryFit(bb, { wallThickness: '100', baseboardHeight: '90' }).strokes[0].points.map(p => p.s), [0, -90, -100]);
  assert.match(tryFit(bb, { wallThickness: '100' }).error.message, /baseboardHeight/, '欄なし＝param 未解決');
  for (const bad of ['', 'x', '0', '-5']) assert.equal(tryFit(bb, { wallThickness: '100', baseboardHeight: bad }).error.code, 'badFitDim', bad);
});

test('setMoveEdge: 印を付けるとエントリの手に edge:air が載り、外すとキー自体が消える（印なしは byte 不変）。editKey の手だけが変わる', () => {
  const f = junctionDraft();
  const before = JSON.stringify(entryFromForm(f));
  const marked = setMoveEdge(f, KEY, DetailEdgeMark.AIR);
  const entry = entryFromForm(marked);
  assert.equal(entry.strokes[0].moves[1].edge, DetailEdgeMark.AIR);
  assert.equal(Object.hasOwn(entry.strokes[0].moves[0], 'edge'), false, '他の手は変わらない');
  assert.equal(validation(marked).ok, true);
  const cleared = setMoveEdge(marked, KEY, null);
  assert.equal(JSON.stringify(entryFromForm(cleared)), before, '外せば印を付ける前と完全に同じ');
  assert.equal(Object.hasOwn(cleared.strokes[0].moves[1], 'edge'), false);
  // 未知の値は「外す」扱い（キーを残さない）
  assert.equal(Object.hasOwn(setMoveEdge(marked, KEY, 'wet').strokes[0].moves[1], 'edge'), false);
  // 元の form は変えない
  assert.equal(Object.hasOwn(f.strokes[0].moves[1], 'edge'), false);
});

test('moveRows は各手の印（edge）を持ち、往復（entry → form）でも保たれる。斜め（V）の手は raw に付く', () => {
  const marked = setMoveEdge(junctionDraft(), KEY, DetailEdgeMark.AIR);
  const rows = moveRows(marked);
  assert.deepEqual(rows[0].moves.map(m => m.edge), [null, DetailEdgeMark.AIR]);
  assert.deepEqual(moveRows(formFromEntry(entryFromForm(marked)))[0].moves.map(m => m.edge), [null, DetailEdgeMark.AIR]);
  // V の手
  const vee = { ...marked, strokes: [{ ...marked.strokes[0], moves: [{ dir: PenDir.VECTOR, raw: { dir: PenDir.VECTOR, dx: { mm: 5, mode: 'fixed' }, dy: { mm: 5, mode: 'fixed' } } }] }] };
  const veeMarked = setMoveEdge(vee, { strokeId: 's1', moveIndex: 0 }, DetailEdgeMark.AIR);
  assert.equal(veeMarked.strokes[0].moves[0].raw.edge, DetailEdgeMark.AIR);
  assert.equal(entryFromForm(veeMarked).strokes[0].moves[0].edge, DetailEdgeMark.AIR);
  assert.equal(moveRows(veeMarked)[0].moves[0].edge, DetailEdgeMark.AIR);
  assert.equal(Object.hasOwn(setMoveEdge(veeMarked, { strokeId: 's1', moveIndex: 0 }, null).strokes[0].moves[0].raw, 'edge'), false);
  // 【失敗系】存在しない手・ストロークは form を変えない
  assert.equal(setMoveEdge(marked, { strokeId: 's9', moveIndex: 0 }, DetailEdgeMark.AIR), marked);
  assert.equal(setMoveEdge(marked, { strokeId: 's1', moveIndex: 9 }, DetailEdgeMark.AIR), marked);
});

test('プレビュー: 印の辺は下書きでも試し込み後でも PREVIEW_AIR_EDGE_WIDTH_PX の線が重なる。印が無ければ重ならない', () => {
  const f = junctionDraft();
  const hasOverlay = prims => prims.some(p => p.width === PREVIEW_AIR_EDGE_WIDTH_PX);
  assert.equal(hasOverlay(previewPrimitivesOf(f)), false);
  const marked = setMoveEdge(f, KEY, DetailEdgeMark.AIR);
  assert.equal(hasOverlay(previewPrimitivesOf(marked)), true, '下書き');
  const fitted = tryFit(marked, { wallThickness: '100' });
  assert.equal(hasOverlay(previewPrimitivesOf(marked, fitted)), true, '試し込み後');
  assert.equal(hasOverlay(previewPrimitivesOf(f, tryFit(f, { wallThickness: '100' }))), false);
});

test('ボタンの文言と配線: 「空気との境目」トグルが setMoveEdge を呼ぶ（コメントを除いたソースの検査）', () => {
  assert.equal(DETAIL_HELPER_TEXT.airEdge, '空気との境目');
  const src = fs.readFileSync(path.resolve(import.meta.dirname, 'DetailHelperPanel.jsx'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').split(/\r?\n/).filter(l => !l.trim().startsWith('//')).join('\n');
  assert.ok(/setMoveEdge\(f, m\.editKey, m\.edge === DetailEdgeMark\.AIR \? null : DetailEdgeMark\.AIR\)/.test(src), 'トグルが setMoveEdge を呼んでいない');
  assert.ok(/tryFit\(form, fitDims, \{ materialMap \}\)/.test(src), '試し込みに materialMap を渡していない');
});
