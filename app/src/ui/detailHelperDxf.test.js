// ヘルパー画面の DXF 読込み（S7a）の純ロジック（ui/detailHelperForm.js）のテスト。
// 読込み→成分の選択→新規下書きへ写す→検証・出所。実ファイルは使わず、テスト内の小さな DXF 文字列を読む。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import {
  loadDxf, setDxfUnit, toggleDxfComponent, setDxfProvenanceField, dxfComponentRows, dxfUnitHint, dxfWarningTexts,
  dxfPreviewPrimitives, draftFromDxf, draftDocOf, provenanceNoticeOf, describeDxfWarning, describeDxfReject,
  validation, saveBlockers, entryFromForm, isDraftDirty, DETAIL_HELPER_MESSAGES, setProvenanceField,
  toggleDxfLayer, setDxfLayers, dxfLayerRows, DETAIL_HELPER_TEXT,
} from './detailHelperForm.js';
import { setPickRect, activePickRect } from './detailHelperPick.js';
import { sha256HexWith } from '../detail/dxf/dxfProvenance.js';
import { formatDetailProvenance } from '../catalog/catalogMaintenance.js';
import { isImportedFigure } from '../catalog/usedEntries.js';
import {
  ERR_DXF_BINARY, ERR_DXF_TRUNCATED, MSG_IMPORTED_NOT_IN_FILE, WARN_DXF_LICENSE_UNKNOWN, WARN_DXF_UNIT_UNKNOWN, WARN_DXF_NO_DIGEST, ERR_DXF_NOT_BYTES,
} from '../error.js';
import { DxfWarning, DxfReject, PenDir, DetailProvenanceSource, DXF_PROVENANCE_FIELDS } from '../core/constants.js';

const text = arr => `${arr.map(([c, v]) => `${c}\n${v}`).join('\n')}\n`;
const section = (name, body) => [[0, 'SECTION'], [2, name], ...body, [0, 'ENDSEC']];
const line = (x1, y1, x2, y2) => [[0, 'LINE'], [8, '0'], [10, x1], [20, y1], [11, x2], [21, y2]];
const sampleBytes = ({ units = 4, slot = false } = {}) => new TextEncoder().encode(text([
  ...(units === null ? [] : section('HEADER', [[9, '$INSUNITS'], [70, units]])),
  ...section('ENTITIES', [
    ...line(0, 0, 100, 0), ...line(100, 0, 100, 50), ...line(100, 50, 0, 50), ...line(0, 50, 0, 0), // 矩形
    ...line(200, 0, 260, 0), ...line(260, 0, 230, 40),                                                   // 開いた折れ線（斜めあり）
    ...(slot ? [[0, 'LWPOLYLINE'], [8, '0'], [70, 1], [10, 300], [20, 0], [10, 340], [20, 0], [42, 1], [10, 340], [20, 20], [10, 300], [20, 20], [42, 1]] : []),
  ]),
  [0, 'EOF'],
]));
const digest = sha256HexWith(webcrypto.subtle);
const ids = () => 'fixed-id';

async function load(opts, fileName = 'sample.dxf') {
  const r = await loadDxf({ bytes: sampleBytes(opts), fileName, digest });
  assert.equal(r.ok, true, r.message);
  return r.dxf;
}

test('loadDxf: 成分の一覧（頂点数・閉/開・警告）・ファイル名・sha256（注入した digest）・復号した文字コード', async () => {
  const dxf = await load();
  assert.equal(dxf.fileName, 'sample.dxf');
  assert.equal(dxf.sha256, await digest(sampleBytes()));
  assert.equal(dxf.encoding, 'utf-8');
  const rows = dxfComponentRows(dxf);
  assert.deepEqual(rows.map(r => r.detail), ['4 頂点・閉', '3 頂点・開']);
  assert.deepEqual(rows[0].warnings, []);
  assert.deepEqual(rows[1].warnings, [describeDxfWarning({ code: DxfWarning.CONTOUR_OPEN })]);
  assert.equal(dxfUnitHint(dxf), '読み取り値: 1');
});

test('【失敗系】loadDxf: バイナリ DXF・途中で切れた DXF は ok:false と理由の文言（例外にしない）。digest の失敗も握る', async () => {
  const bin = await loadDxf({ bytes: Uint8Array.from([...'AutoCAD Binary DXF\r\n'].map(c => c.charCodeAt(0))), fileName: 'b.dxf', digest });
  assert.deepEqual(bin, { ok: false, message: ERR_DXF_BINARY });
  const cut = await loadDxf({ bytes: new TextEncoder().encode('0\nSECTION\n2\nENTITIES\n0\nLINE\n'), fileName: 'c.dxf', digest });
  assert.deepEqual(cut, { ok: false, message: ERR_DXF_TRUNCATED });
  assert.equal(describeDxfReject({ code: DxfReject.BINARY }), ERR_DXF_BINARY);
});

test('loadDxf: digest が reject しても読込みは止めない（ok:true・sha256 は空・NO_DIGEST の警告）。出所の sha256 も空のまま下書きになる', async () => {
  const r = await loadDxf({ bytes: sampleBytes(), fileName: 'd.dxf', digest: async () => { throw new Error('subtle なし'); } });
  assert.equal(r.ok, true);
  assert.equal(r.dxf.sha256, '');
  assert.ok(dxfWarningTexts(r.dxf).includes(WARN_DXF_NO_DIGEST));
  const { form } = draftFromDxf({ dxf: toggleDxfComponent(r.dxf, 0), idFactory: ids });
  assert.equal(entryFromForm(form).provenance.sha256, '');
});

test('loadDxf: digest が undefined を resolve する／digest 自体が未定義でも ok:true・sha256 は空・NO_DIGEST の警告', async () => {
  for (const d of [async () => undefined, undefined]) {
    const r = await loadDxf({ bytes: sampleBytes(), fileName: 'e.dxf', digest: d });
    assert.equal(r.ok, true);
    assert.equal(r.dxf.sha256, '');
    assert.ok(dxfWarningTexts(r.dxf).includes(WARN_DXF_NO_DIGEST));
  }
});

test('describeDxfReject: バイト列でない入力（NOT_BYTES）の文言は error.js 側', () => {
  assert.equal(describeDxfReject({ code: DxfReject.NOT_BYTES }), ERR_DXF_NOT_BYTES);
});

test('setProvenanceField: 下書きへ写した後も出所（メーカー・シリーズ・ライセンス注記）を直せ、保存形では trim される。DXF 由来でない下書きは変えない', async () => {
  const { form } = draftFromDxf({ dxf: toggleDxfComponent(await load(), 0), idFactory: ids });
  const edited = setProvenanceField(setProvenanceField(form, DXF_PROVENANCE_FIELDS.MAKER, '  ACME '), DXF_PROVENANCE_FIELDS.LICENSE_NOTE, '条件');
  assert.equal(edited.extra.provenance.maker, '  ACME ', '編集中は生の入力');
  const p = entryFromForm(edited).provenance;
  assert.equal(p.maker, 'ACME');
  assert.equal(p.licenseNote, '条件');
  assert.equal(p.sha256, form.extra.provenance.sha256, 'ファイル名・sha256 は変えない');
  assert.equal(setProvenanceField(form, 'sha256', 'x'), form, '未知の項目は無視');
  const manual = { extra: { provenance: { source: DetailProvenanceSource.MANUAL } } };
  assert.equal(setProvenanceField(manual, DXF_PROVENANCE_FIELDS.MAKER, 'x'), manual);
});

test('成分の警告: 閉じていない成分（CONTOUR_OPEN）の行だけ red', async () => {
  const rows = dxfComponentRows(await load());
  assert.deepEqual(rows[0].warningItems, []);
  assert.deepEqual(rows[1].warningItems, [{ text: describeDxfWarning({ code: DxfWarning.CONTOUR_OPEN }), red: true }]);
});

test('警告の表示: 単位不明（$INSUNITS 無し）とライセンス未記入が並び、注記を書くとライセンスの警告が消える', async () => {
  const dxf = await load({ units: null });
  assert.deepEqual(dxfWarningTexts(dxf), [WARN_DXF_UNIT_UNKNOWN, WARN_DXF_LICENSE_UNKNOWN]);
  const noted = setDxfProvenanceField(dxf, 'licenseNote', '配布条件に従う');
  assert.deepEqual(dxfWarningTexts(noted), [WARN_DXF_UNIT_UNKNOWN]);
  assert.equal(setDxfProvenanceField(dxf, 'unknown', 'x'), dxf, '未知の項目は無視');
});

test('setDxfUnit: 係数を指定し直すと成分が mm 換算で作り直される。空は自動へ戻り、不正値は dxf を変えず理由を返す', async () => {
  const dxf = await load();
  const scaled = setDxfUnit(dxf, '25.4');
  assert.equal(scaled.error, null);
  assert.equal(scaled.dxf.scene.unitFactor, 25.4);
  assert.equal(scaled.dxf.scene.components[0].strokes[0].moves[0].len.mm, 2540);
  assert.deepEqual(scaled.dxf.selected, [], '選択は解除する');
  const auto = setDxfUnit(scaled.dxf, '');
  assert.equal(auto.dxf.scene.unitFactor, 1);
  const bad = setDxfUnit(dxf, '-3');
  assert.equal(bad.error, DETAIL_HELPER_MESSAGES.dxfUnitInvalid);
  assert.equal(bad.dxf, dxf);
  assert.equal(setDxfUnit(dxf, 'abc').error, DETAIL_HELPER_MESSAGES.dxfUnitInvalid);
});

// ---- レイヤ（S7d-0a） ----
const layered = (extra = []) => new TextEncoder().encode(text([
  ...section('HEADER', [[9, '$INSUNITS'], [70, 4]]),
  ...section('ENTITIES', [
    [0, 'LINE'], [8, 'WALL'], [10, 0], [20, 0], [11, 100], [21, 0],
    [0, 'LINE'], [8, 'DIM'], [10, 200], [20, 0], [11, 300], [21, 0],
    [0, 'LINE'], [8, 'DIM'], [10, 300], [20, 0], [11, 300], [21, 50],
    ...extra,
  ]),
  [0, 'EOF'],
]));
const loadLayered = async () => {
  const r = await loadDxf({ bytes: layered(), fileName: 'l.dxf', digest });
  assert.equal(r.ok, true, r.message);
  return r.dxf;
};

test('loadDxf: scene.layers が入る。dxfLayerRows は名前昇順で全部 visible', async () => {
  const dxf = await loadLayered();
  assert.deepEqual(dxf.scene.layers, [{ name: 'DIM', segmentCount: 2 }, { name: 'WALL', segmentCount: 1 }]);
  assert.deepEqual(dxfLayerRows(dxf), [
    { name: 'DIM', segmentCount: 2, visible: true }, { name: 'WALL', segmentCount: 1, visible: true },
  ]);
  assert.equal(DETAIL_HELPER_TEXT.layers, 'レイヤ');
  assert.equal(DETAIL_HELPER_TEXT.layersAllOn, '全部 on');
});

test('toggleDxfLayer: off で成分が作り直される（scene は新しく selected は解除）。もう一度で on に戻る', async () => {
  let dxf = toggleDxfComponent(await loadLayered(), 0);
  assert.deepEqual(dxf.selected, [0]);
  const before = dxf.scene;
  const off = toggleDxfLayer(dxf, 'DIM');
  assert.equal(off.error, null);
  assert.notEqual(off.dxf.scene, before);
  assert.deepEqual(off.dxf.selected, []);
  assert.equal(off.dxf.scene.components.length, 1);
  assert.deepEqual(dxfLayerRows(off.dxf).map(r => r.visible), [false, true]);
  const on = toggleDxfLayer(off.dxf, 'DIM');
  assert.equal(on.dxf.scene.components.length, 2);
  assert.deepEqual(on.dxf.scene.hiddenLayers, []);
});

test('toggleDxfLayer: S7c の矩形は scene が変わるので無効になる。単位の指定は保つ', async () => {
  let dxf = (await loadLayered());
  dxf = { ...dxf, pick: null };
  dxf = setPickRect(dxf, { x: -10, y: -10, w: 500, h: 500 });
  assert.notEqual(activePickRect(dxf), null);
  const unit = setDxfUnit(dxf, '2').dxf;
  const picked = setPickRect(unit, { x: -10, y: -10, w: 900, h: 900 });
  const off = toggleDxfLayer(picked, 'WALL').dxf;
  assert.equal(activePickRect(off), null);
  assert.equal(off.scene.unitFactor, 2);
  assert.equal(off.unitText, '2');
});

test('setDxfUnit: 単位を変えるとレイヤは全部 on に戻る（hiddenLayers を引き継がない）', async () => {
  const off = toggleDxfLayer(await loadLayered(), 'DIM').dxf;
  assert.deepEqual(off.scene.hiddenLayers, ['DIM']);
  const re = setDxfUnit(off, '2').dxf;
  assert.deepEqual(re.scene.hiddenLayers, []);
  assert.equal(re.scene.components.length, 2);
});

test('dxfLayerRows: レイヤが 1 つ以下なら []（切り替える意味がない）', async () => {
  const one = await load();
  assert.equal(one.scene.layers.length, 1);
  assert.deepEqual(dxfLayerRows(one), []);
});

test('【失敗系】dxfLayerRows: PDF の状態（scene null／layers なし）では []・例外なし', () => {
  assert.deepEqual(dxfLayerRows({ scene: null }), []);
  assert.deepEqual(dxfLayerRows({ scene: { components: [] } }), []);
  assert.deepEqual(dxfLayerRows(null), []);
});

test('【失敗系】setDxfLayers: 存在しないレイヤ名は無視して全部 on と同じ。全部 off は成分 0', async () => {
  const dxf = await loadLayered();
  assert.deepEqual(setDxfLayers(dxf, ['NOPE']).dxf.scene.hiddenLayers, []);
  const none = setDxfLayers(dxf, ['DIM', 'WALL']).dxf;
  assert.deepEqual(none.scene.components, []);
  assert.deepEqual(dxfLayerRows(none).map(r => r.visible), [false, false]);
});

test('draftFromDxf: 矩形の成分 → R100/U50/L100・closed の 1 ストロークの新規下書き。検証が通り、出所（DXF・sha256・メーカー等）が entry に載る', async () => {
  let dxf = await load();
  dxf = setDxfProvenanceField(setDxfProvenanceField(dxf, 'maker', ' ACME '), 'series', 'S-1');
  dxf = toggleDxfComponent(dxf, 0);
  const { form, error } = draftFromDxf({ dxf, idFactory: ids });
  assert.equal(error, undefined);
  assert.equal(form.key, 'df-fixed-id');
  assert.equal(form.label, 'sample');
  assert.equal(form.strokes.length, 1);
  assert.equal(form.strokes[0].closed, true);
  assert.deepEqual(form.strokes[0].moves.map(m => [m.dir, m.mode, m.len]), [[PenDir.RIGHT, 'fixed', '100'], [PenDir.UP, 'fixed', '50'], [PenDir.LEFT, 'fixed', '100']]);
  assert.equal(form.anchors.length, 2, '各ストロークの頂点 0 を 2 つの origin 基準に載せる');
  assert.ok(form.anchors.every(a => a.strokeId === form.strokes[0].id && a.vertexIndex === 0));
  const result = validation(form);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.deepEqual(saveBlockers(form, result), []);
  const entry = entryFromForm(form);
  assert.deepEqual(entry.provenance, {
    source: DetailProvenanceSource.DXF, fileName: 'sample.dxf', sha256: dxf.sha256, maker: 'ACME', series: 'S-1', licenseNote: '',
  });
  assert.equal(isImportedFigure(entry), true, '保存した図は文書の同梱から外れる');
  assert.ok(provenanceNoticeOf(form).includes(MSG_IMPORTED_NOT_IN_FILE));
});

test('draftFromDxf: 斜めの成分は V（raw 保持）で検証が通る。複数の成分を選ぶと成分ごとにストロークが増える（id は s1, s2）', async () => {
  let dxf = await load({ slot: true });
  dxf = toggleDxfComponent(toggleDxfComponent(toggleDxfComponent(dxf, 2), 1), 0);
  assert.deepEqual(dxf.selected, [0, 1, 2], '選択は昇順');
  const { form } = draftFromDxf({ dxf, idFactory: ids });
  assert.deepEqual(form.strokes.map(s => s.id), ['s1', 's2', 's3']);
  assert.ok(form.strokes[1].moves.some(m => m.dir === PenDir.VECTOR), '斜めの手');
  const result = validation(form);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(form.anchors.length, 6);
});

test('【失敗系】draftFromDxf: 何も選んでいない／写せる線が無いときは error（下書きを作らない）', async () => {
  const dxf = await load();
  assert.deepEqual(draftFromDxf({ dxf, idFactory: ids }), { error: DETAIL_HELPER_MESSAGES.dxfNothingSelected });
  const empty = { ...dxf, selected: [0], scene: { ...dxf.scene, components: [{ ...dxf.scene.components[0], strokes: [] }] } };
  assert.deepEqual(draftFromDxf({ dxf: empty, idFactory: ids }), { error: DETAIL_HELPER_MESSAGES.dxfNothingToCopy });
});

test('draftDocOf: 保存前の下書きなので baseline なし＝常に未保存（閉じる・新規の前に破棄の確認が出る）', async () => {
  const dxf = toggleDxfComponent(await load(), 0);
  const { form } = draftFromDxf({ dxf, idFactory: ids });
  const doc = draftDocOf(form);
  assert.equal(doc.prevEntry, null);
  assert.equal(isDraftDirty(doc.form, doc.baseline), true);
});

test('dxfPreviewPrimitives: 全成分を淡色、選んだ成分を強調（後ろに重ねる）。閉じた成分は始点を足して閉じ辺も描く', async () => {
  const none = dxfPreviewPrimitives(await load());
  assert.equal(none.length, 2);
  assert.ok(none.every(p => p.stroke === '#cbd5e1'));
  const sel = dxfPreviewPrimitives(toggleDxfComponent(await load(), 0));
  assert.equal(sel.length, 2);
  assert.equal(sel[1].stroke, '#2563eb');
  assert.equal(sel[1].points.length, 5, '矩形 4 頂点＋始点');
  assert.deepEqual(sel[1].points[0], sel[1].points[4]);
  assert.equal(sel[0].points.length, 3, '開いた折れ線は足さない');
});

test('出所の表示: 保守パネル・ヘルパー共通の文。DXF は ファイル・メーカー・シリーズ・ライセンス注記と「保存ファイルに入りません」。手描き・null は「手描き」', () => {
  assert.equal(formatDetailProvenance(null), '手描き');
  assert.equal(formatDetailProvenance({ source: DetailProvenanceSource.MANUAL }), '手描き');
  const s = formatDetailProvenance({ source: DetailProvenanceSource.DXF, fileName: 'a.dxf', sha256: 'x', maker: 'ACME', series: '', licenseNote: '条件あり' });
  assert.equal(s, `DXF・ファイル: a.dxf・メーカー: ACME・シリーズ: （未記入）・ライセンス注記: 条件あり・${MSG_IMPORTED_NOT_IN_FILE}`);
  assert.equal(provenanceNoticeOf({ extra: { provenance: { source: DetailProvenanceSource.MANUAL } } }), null);
});
