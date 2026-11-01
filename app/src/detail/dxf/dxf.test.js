// DXF 読込み（部分詳細図 S7a）の純モジュールのテスト: 字句分解・復号・構文解析・単位・弦分割・連結成分→ストローク・出所。
// fixture はテスト内の小さな DXF 文字列。期待値は手計算の定数。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { dxfTokenize } from './dxfTokenize.js';
import { dxfDecode } from './dxfDecode.js';
import { dxfParse } from './dxfParse.js';
import { dxfEntities } from './dxfEntities.js';
import { dxfToComponents, contourToStrokes } from './dxfToStrokes.js';
import { buildDxfProvenance, sha256HexWith, baseNameOf } from './dxfProvenance.js';
import { readDxf, buildDxfScene } from './dxfImport.js';
import { DxfWarning, DxfReject, PenDir, DetailLenMode, DetailProvenanceSource } from '../../core/constants.js';

// ---- fixture の組み立て ----
const text = arr => `${arr.map(([c, v]) => `${c}\n${v}`).join('\n')}\n`;
const section = (name, body) => [[0, 'SECTION'], [2, name], ...body, [0, 'ENDSEC']];
const headerSec = units => section('HEADER', units === undefined ? [] : [[9, '$INSUNITS'], [70, units]]);
const entitiesSec = body => section('ENTITIES', body.flat());
const blocksSec = blocks => section('BLOCKS', blocks.flat());
const block = (name, body, base = [0, 0]) => [[0, 'BLOCK'], [8, '0'], [2, name], [70, 0], [10, base[0]], [20, base[1]], ...body.flat(), [0, 'ENDBLK']];
const line = (x1, y1, x2, y2, layer = '0') => [[0, 'LINE'], [8, layer], [10, x1], [20, y1], [11, x2], [21, y2]];
const circle = (x, y, r) => [[0, 'CIRCLE'], [8, '0'], [10, x], [20, y], [40, r]];
const insert = (name, x, y, { sx = 1, sy = 1, rot = 0 } = {}) => [[0, 'INSERT'], [8, '0'], [2, name], [10, x], [20, y], [41, sx], [42, sy], [50, rot]];
const lwpoly = (verts, closed = false) => [[0, 'LWPOLYLINE'], [8, '0'], [70, closed ? 1 : 0], ...verts.flatMap(([x, y, b]) => [[10, x], [20, y], ...(b ? [[42, b]] : [])])];
const doc = (...secs) => text([...secs.flat(), [0, 'EOF']]);
const parseText = (t, opts) => {
  const tk = dxfTokenize(t);
  assert.ok(tk.pairs, JSON.stringify(tk));
  return dxfParse(tk.pairs, opts);
};
const approx = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);

// ================================================================
// tokenize
// ================================================================
test('tokenize: group code と値の対に分ける（CRLF・BOM・末尾の空行を許す）', () => {
  const r = dxfTokenize('\uFEFF  0\r\nSECTION\r\n  2\r\nENTITIES\r\n0\r\nEOF\r\n\r\n');
  assert.deepEqual(r.pairs, [{ code: 0, value: 'SECTION' }, { code: 2, value: 'ENTITIES' }, { code: 0, value: 'EOF' }]);
});

test('【失敗系】tokenize: group code が整数でなければ badGroupCode（行番号つき）', () => {
  const r = dxfTokenize('0\nSECTION\nabc\nENTITIES\n0\nEOF\n');
  assert.deepEqual(r.error, { code: DxfReject.BAD_GROUP_CODE, line: 3, text: 'abc' });
});

test('【失敗系】tokenize: 対の片割れが無い（奇数行）／EOF で終わらないファイルは truncated', () => {
  assert.equal(dxfTokenize('0\nSECTION\n2\n').error.code, DxfReject.TRUNCATED);
  assert.equal(dxfTokenize('0\nSECTION\n2\nENTITIES\n').error.code, DxfReject.TRUNCATED);
  assert.equal(dxfTokenize('').error.code, DxfReject.TRUNCATED);
});

// ================================================================
// decode
// ================================================================
test('decode: UTF-8 のバイト列は utf-8 として読む', () => {
  const r = dxfDecode(new TextEncoder().encode('8\nレイヤ\n'));
  assert.deepEqual(r, { text: '8\nレイヤ\n', encoding: 'utf-8' });
});

test('decode: Shift_JIS のレイヤ名（レイヤ＝83 8C 83 43 83 84）は置換文字の少ない shift_jis を採る', () => {
  const bytes = Uint8Array.from([0x38, 0x0A, 0x83, 0x8C, 0x83, 0x43, 0x83, 0x84, 0x0A]);
  const r = dxfDecode(bytes);
  assert.equal(r.encoding, 'shift_jis');
  assert.equal(r.text, '8\nレイヤ\n');
});

test('【失敗系】decode: 先頭が "AutoCAD Binary DXF" のバイナリ DXF は拒否する。バイト列でない入力も例外にしない', () => {
  const bin = Uint8Array.from([...'AutoCAD Binary DXF\r\n\x1a\0'].map(c => c.charCodeAt(0)));
  assert.deepEqual(dxfDecode(bin), { error: { code: DxfReject.BINARY } });
  assert.equal(dxfDecode('文字列').error.code, DxfReject.NOT_BYTES);
  assert.equal(readDxf(bin).error.code, DxfReject.BINARY);
});

// ================================================================
// parse
// ================================================================
test('parse: LINE 4 本の矩形 → line 4 本・警告なし・$INSUNITS を読む', () => {
  const p = parseText(doc(headerSec(4), entitiesSec([line(0, 0, 100, 0), line(100, 0, 100, 50), line(100, 50, 0, 50), line(0, 50, 0, 0)])));
  assert.equal(p.entities.length, 4);
  assert.deepEqual(p.entities[1], { kind: 'line', a: { x: 100, y: 0 }, b: { x: 100, y: 50 } });
  assert.equal(p.header.insUnits, 4);
  assert.deepEqual(p.warnings, []);
});

test('parse: LWPOLYLINE の bulge=1（半円）は arc になる（中心 (50,0)・半径 50・掃引 π）。閉じた折れ線は最後→最初の区間も足す', () => {
  const p = parseText(doc(headerSec(4), entitiesSec([lwpoly([[0, 0, 1], [100, 0]])])));
  assert.equal(p.entities.length, 1);
  const a = p.entities[0];
  assert.equal(a.kind, 'arc');
  approx(a.c.x, 50); approx(a.c.y, 0);
  approx(a.u.x, 50); approx(a.v.y, 50);
  approx(a.t1 - a.t0, Math.PI);
  const closed = parseText(doc(headerSec(4), entitiesSec([lwpoly([[0, 0], [100, 0], [100, 50]], true)])));
  assert.equal(closed.entities.length, 3);
});

test('parse: bulge の符号（負＝時計回り）は反対側へ膨らむ。半円の弧の中点は y=-50 側（正）／y=+50 側（負）', () => {
  const pos = parseText(doc(entitiesSec([lwpoly([[0, 0, 1], [100, 0]])]))).entities[0];
  const neg = parseText(doc(entitiesSec([lwpoly([[0, 0, -1], [100, 0]])]))).entities[0];
  const mid = a => { const th = (a.t0 + a.t1) / 2; return a.c.y + a.u.y * Math.cos(th) + a.v.y * Math.sin(th); };
  approx(mid(pos), -50);
  approx(mid(neg), 50);
});

test('parse: POLYLINE／VERTEX／SEQEND（最小）と ARC・CIRCLE を読む', () => {
  const poly = [[0, 'POLYLINE'], [8, '0'], [66, 1], [70, 0], [0, 'VERTEX'], [10, 0], [20, 0], [0, 'VERTEX'], [10, 10], [20, 0], [0, 'VERTEX'], [10, 10], [20, 10], [0, 'SEQEND']];
  const arc = [[0, 'ARC'], [10, 0], [20, 0], [40, 10], [50, 90], [51, 0]]; // 90°→0°（反時計回りに 270°）
  const p = parseText(doc(entitiesSec([poly, arc, circle(5, 5, 2)])));
  assert.equal(p.entities.filter(e => e.kind === 'line').length, 2);
  const arcs = p.entities.filter(e => e.kind === 'arc');
  assert.equal(arcs.length, 2);
  approx(arcs[0].t1 - arcs[0].t0, Math.PI * 1.5);
  approx(arcs[1].t1 - arcs[1].t0, Math.PI * 2);
});

test('parse: INSERT 1 段 — スケール 2・回転 90°・挿入点 (100,100) で (10,0) が (100,120) へ。ミラー（sx=-1）は x 反転', () => {
  const blocks = blocksSec([block('B', [line(0, 0, 10, 0)])]);
  const rot = parseText(doc(blocks, entitiesSec([insert('B', 100, 100, { sx: 2, sy: 2, rot: 90 })])));
  approx(rot.entities[0].a.x, 100); approx(rot.entities[0].a.y, 100);
  approx(rot.entities[0].b.x, 100); approx(rot.entities[0].b.y, 120);
  const mir = parseText(doc(blocks, entitiesSec([insert('B', 5, 5, { sx: -1 })])));
  approx(mir.entities[0].a.x, 5); approx(mir.entities[0].b.x, -5); approx(mir.entities[0].b.y, 5);
  assert.deepEqual(mir.warnings, []);
});

test('parse: ブロックの基点（BLOCK の 10/20）は挿入点へ写る', () => {
  const blocks = blocksSec([block('B', [line(10, 10, 20, 10)], [10, 10])]);
  const p = parseText(doc(blocks, entitiesSec([insert('B', 0, 0)])));
  approx(p.entities[0].a.x, 0); approx(p.entities[0].b.x, 10);
});

test('parse: INSERT の循環（A→B→A）は INSERT_CYCLE で打ち切り、ブロックの外の図形は残る', () => {
  const blocks = blocksSec([block('A', [line(0, 0, 1, 0), insert('B', 0, 0)]), block('B', [line(0, 0, 0, 1), insert('A', 0, 0)])]);
  const p = parseText(doc(blocks, entitiesSec([insert('A', 0, 0)])));
  assert.ok(p.warnings.some(w => w.code === DxfWarning.INSERT_CYCLE));
  assert.equal(p.entities.length, 2, 'A の線と B の線の 2 本で止まる');
});

test('parse: INSERT の入れ子が 9 段目で INSERT_DEPTH（8 段までは展開、8 段目のブロックの線は残る）', () => {
  const blks = [];
  for (let i = 0; i < 10; i++) blks.push(block(`B${i}`, [line(i, 0, i + 1, 0), ...(i < 9 ? [insert(`B${i + 1}`, 0, 0)] : [])]));
  const p = parseText(doc(blocksSec(blks), entitiesSec([insert('B0', 0, 0)])));
  assert.ok(p.warnings.some(w => w.code === DxfWarning.INSERT_DEPTH));
  assert.equal(p.entities.length, 8, 'B0〜B7 の 8 本（B8 以降は展開しない）');
});

test('parse: 未対応のエンティティは無視して種類ごとの件数を UNSUPPORTED_ENTITY で警告する', () => {
  const txt = [[0, 'TEXT'], [10, 0], [20, 0], [1, 'abc']];
  const hatch = [[0, 'HATCH'], [10, 0], [20, 0]];
  const p = parseText(doc(entitiesSec([line(0, 0, 1, 0), txt, txt, hatch])));
  assert.equal(p.entities.length, 1);
  assert.deepEqual(p.warnings, [
    { code: DxfWarning.UNSUPPORTED_ENTITY, type: 'TEXT', count: 2 },
    { code: DxfWarning.UNSUPPORTED_ENTITY, type: 'HATCH', count: 1 },
  ]);
});

test('【失敗系】parse: 件数上限を超えたら打ち切って ENTITY_LIMIT。値が数値でないエンティティは不正として警告（例外にしない）', () => {
  const five = [0, 1, 2, 3, 4].map(i => line(i, 0, i + 1, 0));
  const p = parseText(doc(entitiesSec(five)), { maxEntities: 3 });
  assert.equal(p.entities.length, 3);
  assert.deepEqual(p.warnings, [{ code: DxfWarning.ENTITY_LIMIT, limit: 3 }]);
  const bad = parseText(doc(entitiesSec([line('x', 0, 1, 0)])));
  assert.deepEqual(bad.entities, []);
  assert.deepEqual(bad.warnings, [{ code: DxfWarning.UNSUPPORTED_ENTITY, type: 'LINE（不正）', count: 1 }]);
});

test('parse: 非一様スケールの INSERT 内の円は NONUNIFORM_SCALE を警告し、楕円弧（u=(2r,0)）になる', () => {
  const blocks = blocksSec([block('C', [circle(0, 0, 10)])]);
  const p = parseText(doc(blocks, entitiesSec([insert('C', 0, 0, { sx: 2, sy: 1 })])));
  assert.deepEqual(p.warnings, [{ code: DxfWarning.NONUNIFORM_SCALE, block: 'C' }]);
  approx(p.entities[0].u.x, 20); approx(p.entities[0].v.y, 10);
});

// ================================================================
// entities（単位・弦分割）
// ================================================================
test('単位: $INSUNITS が無い／未知（0）→ UNIT_UNKNOWN で係数 1。1(inch)→25.4・4(mm)→1・5(cm)→10・6(m)→1000', () => {
  const at = u => dxfEntities(parseText(doc(headerSec(u), entitiesSec([line(0, 0, 100, 0)]))));
  const none = at(undefined);
  assert.equal(none.unitFactor, 1);
  assert.deepEqual(none.warnings, [{ code: DxfWarning.UNIT_UNKNOWN }]);
  assert.equal(at(0).unitFactor, 1);
  const cases = [[1, 25.4], [4, 1], [5, 10], [6, 1000]];
  for (const [u, f] of cases) {
    const r = at(u);
    assert.equal(r.unitFactor, f, `INSUNITS=${u}`);
    assert.equal(r.segments[0].b.s, 100 * f, `INSUNITS=${u} の長さ`);
    assert.deepEqual(r.warnings, []);
  }
  assert.equal(dxfEntities(parseText(doc(entitiesSec([line(0, 0, 100, 0)]))), { unitFactor: 2 }).segments[0].b.s, 200, 'ユーザー指定の係数が優先');
});

test('座標系: DXF の y 上向きは図の t 下向きへ反転する（-0 を作らない）', () => {
  const r = dxfEntities(parseText(doc(headerSec(4), entitiesSec([line(0, 0, 0, 30)]))));
  assert.deepEqual(r.segments, [{ a: { s: 0, t: 0 }, b: { s: 0, t: -30 } }]);
});

test('弦分割: 半円(R=50)は弦公差 0.05 で 36 分割・0.5 で 12 分割。全弦の弧からのずれは公差以下で、端点は元の頂点に一致', () => {
  const p = parseText(doc(headerSec(4), entitiesSec([lwpoly([[0, 0, 1], [100, 0]])])));
  const fine = dxfEntities(p);
  assert.equal(fine.segments.length, 36);
  const coarse = dxfEntities(p, { chordTol: 0.5 });
  assert.equal(coarse.segments.length, 12);
  for (const seg of fine.segments) {
    const mid = { s: (seg.a.s + seg.b.s) / 2, t: (seg.a.t + seg.b.t) / 2 };
    const sag = 50 - Math.hypot(mid.s - 50, mid.t);
    assert.ok(sag >= -1e-9 && sag <= 0.05, `sag ${sag}`);
  }
  approx(fine.segments[0].a.s, 0, 1e-9);
  approx(fine.segments[35].b.s, 100, 1e-9);
});

test('弦分割: 円(R=50)は 71 角形で最後の点は最初の点と同じ座標（始点は角度 0＝(cx+r, cy)）', () => {
  const r = dxfEntities(parseText(doc(headerSec(4), entitiesSec([circle(0, 0, 50)]))));
  assert.equal(r.segments.length, 71);
  assert.deepEqual(r.segments[0].a, { s: 50, t: 0 });
  assert.deepEqual(r.segments[70].b, r.segments[0].a);
});

test('【失敗系】弦分割: 線分数の上限を超えたら打ち切って ENTITY_LIMIT', () => {
  const r = dxfEntities(parseText(doc(headerSec(4), entitiesSec([circle(0, 0, 50)]))), { maxSegments: 10 });
  assert.equal(r.segments.length, 10);
  assert.ok(r.warnings.some(w => w.code === DxfWarning.ENTITY_LIMIT));
});

// ================================================================
// toStrokes
// ================================================================
const seg = (s1, t1, s2, t2) => ({ a: { s: s1, t: t1 }, b: { s: s2, t: t2 } });
const lenOf = m => m.len.mm;

test('toStrokes: 矩形 4 線分 → 閉じた成分 1・R100/D50/L100 の 3 手＋closed（始点へ戻る手は書かない）', () => {
  const { components } = dxfToComponents([seg(0, 0, 100, 0), seg(100, 0, 100, 50), seg(100, 50, 0, 50), seg(0, 50, 0, 0)]);
  assert.equal(components.length, 1);
  const c = components[0];
  assert.equal(c.closed, true);
  assert.equal(c.vertexCount, 4);
  assert.deepEqual(c.warnings, []);
  assert.equal(c.strokes.length, 1);
  assert.equal(c.strokes[0].closed, true);
  assert.deepEqual(c.strokes[0].moves.map(m => m.dir), [PenDir.RIGHT, PenDir.DOWN, PenDir.LEFT]);
  assert.deepEqual(c.strokes[0].moves.map(lenOf), [100, 50, 100]);
  assert.ok(c.strokes[0].moves.every(m => m.len.mode === DetailLenMode.FIXED));
});

test('toStrokes: 斜め区間は V（dx・dy は正の大きさ、向きは ss・st）。(100,0)→(60,50) は ss=-1・st=+1、(0,0)→(30,-40) は ss=+1・st=-1', () => {
  const trap = dxfToComponents([seg(0, 0, 100, 0), seg(100, 0, 60, 50), seg(60, 50, 0, 50), seg(0, 50, 0, 0)]).components[0];
  assert.deepEqual(trap.strokes[0].moves[1], { dir: PenDir.VECTOR, dx: { mm: 40, mode: 'fixed' }, dy: { mm: 50, mode: 'fixed' }, ss: -1, st: 1 });
  const up = contourToStrokes([{ s: 0, t: 0 }, { s: 30, t: -40 }]);
  assert.deepEqual(up.moves[0], { dir: PenDir.VECTOR, dx: { mm: 30, mode: 'fixed' }, dy: { mm: 40, mode: 'fixed' }, ss: 1, st: -1 });
  assert.equal(up.closed, false);
});

test('toStrokes: 共線の間引き — 底辺を 2 本に割った矩形でも頂点は 4・手は 3（間引き前は 5 頂点）', () => {
  const { components } = dxfToComponents([seg(0, 0, 50, 0), seg(50, 0, 100, 0), seg(100, 0, 100, 50), seg(100, 50, 0, 50), seg(0, 50, 0, 0)]);
  assert.equal(components[0].vertexCount, 4);
  assert.deepEqual(components[0].strokes[0].moves.map(lenOf), [100, 50, 100]);
});

test('toStrokes: 開いた成分は CONTOUR_OPEN・closed:false（折れ線の全手を書く）', () => {
  const { components } = dxfToComponents([seg(0, 0, 10, 0), seg(10, 0, 10, 10), seg(10, 10, 30, 10)]);
  const c = components[0];
  assert.equal(c.closed, false);
  assert.deepEqual(c.warnings, [{ code: DxfWarning.CONTOUR_OPEN }]);
  assert.equal(c.strokes[0].closed, false);
  assert.deepEqual(c.strokes[0].moves.map(m => m.dir), [PenDir.RIGHT, PenDir.DOWN, PenDir.RIGHT]);
});

test('toStrokes: 分岐（T 字）の成分は 2 本の一筆書きに分かれ CONTOUR_OPEN。線分は 1 本も落ちない', () => {
  const { components } = dxfToComponents([seg(0, 0, 50, 0), seg(50, 0, 100, 0), seg(50, 0, 50, 50)]);
  assert.equal(components.length, 1);
  assert.equal(components[0].trails.length, 2);
  assert.equal(components[0].segmentCount, 3);
  assert.deepEqual(components[0].warnings, [{ code: DxfWarning.CONTOUR_OPEN }]);
});

test('toStrokes: 自己交差（蝶ネクタイ）は SELF_INTERSECT。交差しない矩形には出ない', () => {
  const bow = dxfToComponents([seg(0, 0, 100, 100), seg(100, 100, 100, 0), seg(100, 0, 0, 100), seg(0, 100, 0, 0)]).components[0];
  assert.ok(bow.warnings.some(w => w.code === DxfWarning.SELF_INTERSECT));
  assert.equal(bow.closed, true);
  const rect = dxfToComponents([seg(0, 0, 100, 0), seg(100, 0, 100, 50), seg(100, 50, 0, 50), seg(0, 50, 0, 0)]).components[0];
  assert.ok(!rect.warnings.some(w => w.code === DxfWarning.SELF_INTERSECT));
});

test('toStrokes: 端点スナップ — 0.005 離れた端点は結合して 1 成分・0.015 離れると別成分（許容 0.01）', () => {
  assert.equal(dxfToComponents([seg(0, 0, 10, 0), seg(10.005, 0, 20, 0)]).components.length, 1);
  assert.equal(dxfToComponents([seg(0, 0, 10, 0), seg(10.015, 0, 20, 0)]).components.length, 2);
});

test('toStrokes: 長さ 0 の線分・同じ節点対の重複線分は捨てる。成分は最初の線分の現れ順', () => {
  const r = dxfToComponents([seg(100, 100, 110, 100), seg(0, 0, 0, 0), seg(0, 0, 10, 0), seg(10, 0, 0, 0)]);
  assert.equal(r.components.length, 2);
  assert.equal(r.components[0].segmentCount, 1);
  assert.deepEqual(r.components[0].trails[0].points[0], { s: 100, t: 100 });
  assert.equal(r.components[1].segmentCount, 1, '重複線分は 1 本に畳む');
});

test('toStrokes: 空の入力は成分なし', () => {
  assert.deepEqual(dxfToComponents([]).components, []);
});

// ================================================================
// provenance
// ================================================================
test('provenance: ライセンス注記が空なら LICENSE_UNKNOWN（保存を止めない警告）。あれば警告なし。値は trim する', () => {
  const none = buildDxfProvenance({ fileName: 'C:\\dl\\sash.dxf', sha256: 'abc', maker: ' YKK ', series: 'APW', licenseNote: '  ' });
  assert.deepEqual(none.warnings, [{ code: DxfWarning.LICENSE_UNKNOWN }]);
  assert.deepEqual(none.provenance, { source: DetailProvenanceSource.DXF, fileName: 'sash.dxf', sha256: 'abc', maker: 'YKK', series: 'APW', licenseNote: '' });
  const ok = buildDxfProvenance({ fileName: 'a.dxf', sha256: 'x', licenseNote: '配布条件に従う' });
  assert.deepEqual(ok.warnings, []);
  assert.equal(ok.provenance.maker, '');
  assert.equal(baseNameOf('/a/b/c.dxf'), 'c.dxf');
});

test('provenance: sha256 は注入した digest の結果（webcrypto で "abc" の既知ハッシュ）', async () => {
  const digest = sha256HexWith(webcrypto.subtle);
  assert.equal(await digest(new TextEncoder().encode('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

// ================================================================
// 通し（readDxf → buildDxfScene）
// ================================================================
// ================================================================
// 外部入力の堅牢性（膨張・桁あふれ・計算量）
// ================================================================
const TIME_LIMIT_MS = 3000;
const timed = fn => { const t0 = performance.now(); const r = fn(); return { r, ms: performance.now() - t0 }; };

test('【堅牢性】空ブロックを 10×7 段に入れ子にした INSERT は展開回数の上限で ENTITY_LIMIT（妥当な時間で返る）', () => {
  const blks = [];
  for (let i = 0; i < 7; i++) blks.push(block(`B${i}`, Array.from({ length: 10 }, () => insert(`B${i + 1}`, 0, 0))));
  blks.push(block('B7', []));
  const { r: p, ms } = timed(() => parseText(doc(blocksSec(blks), entitiesSec([insert('B0', 0, 0)]))));
  assert.ok(p.warnings.some(w => w.code === DxfWarning.ENTITY_LIMIT && w.limit === 20000), JSON.stringify(p.warnings));
  assert.ok(ms < TIME_LIMIT_MS, `${ms}ms`);
});

test('【堅牢性】大きな未使用ブロックがあっても ENTITIES の矩形は読める（ブロックは使われたときに読む）', () => {
  const big = block('BIG', Array.from({ length: 25000 }, (_, i) => line(i, 0, i + 1, 0)));
  const p = parseText(doc(blocksSec([big]), entitiesSec([line(0, 0, 100, 0), line(100, 0, 100, 50), line(100, 50, 0, 50), line(0, 50, 0, 0)])));
  assert.equal(p.entities.length, 4);
  assert.deepEqual(p.warnings, []);
});

test('【堅牢性】極小 bulge(1e-17) の閉じた矩形は 4 線分・閉（弧に膨らませない）', () => {
  const p = parseText(doc(headerSec(4), entitiesSec([lwpoly([[0, 0, 1e-17], [100, 0, 1e-17], [100, 50, 1e-17], [0, 50, 1e-17]], true)])));
  assert.equal(p.entities.length, 4);
  assert.ok(p.entities.every(e => e.kind === 'line'));
  const scene = buildDxfScene({ ...p, warnings: p.warnings });
  assert.equal(scene.segments.length, 4);
  assert.equal(scene.components.length, 1);
  assert.equal(scene.components[0].closed, true);
});

test('【堅牢性】極大 bulge(1e200) は黙って消えず、不正な LWPOLYLINE として警告する', () => {
  const p = parseText(doc(headerSec(4), entitiesSec([lwpoly([[0, 0, 1e200], [100, 0]])])));
  assert.deepEqual(p.entities, []);
  assert.deepEqual(p.warnings, [{ code: DxfWarning.UNSUPPORTED_ENTITY, type: 'LWPOLYLINE（不正）', count: 1 }]);
});

test('【堅牢性】単位換算で座標が有限でなくなる図形（1e308 × 1000）は捨てて件数を警告する（ENTITY_LIMIT とは別）', () => {
  const r = dxfEntities(parseText(doc(headerSec(6), entitiesSec([line(1e308, 0, 0, 0), line(0, 0, 1, 0)]))));
  assert.equal(r.segments.length, 1);
  assert.deepEqual(r.warnings, [{ code: DxfWarning.UNSUPPORTED_ENTITY, type: '座標が有限でない図形', count: 1 }]);
});

const zigzag = n => Array.from({ length: n }, (_, i) => seg(i * 10, (i % 2) * 10, (i + 1) * 10, ((i + 1) % 2) * 10));

test('【堅牢性】ジグザグ 10000 線分の 1 成分は時間内に終わり、自己交差なし・開（格子で候補を絞る）', () => {
  const { r, ms } = timed(() => dxfToComponents(zigzag(10000)));
  assert.equal(r.components.length, 1);
  assert.deepEqual(r.components[0].warnings, [{ code: DxfWarning.CONTOUR_OPEN }]);
  assert.ok(ms < TIME_LIMIT_MS, `${ms}ms`);
});

test('【堅牢性】星形 20000 本（放射状）の 1 成分は時間内に終わる。候補の対が上限を超えるので自己交差は「調べていない」と警告する', () => {
  const spokes = Array.from({ length: 20000 }, (_, i) => seg(0, 0, 100 * Math.cos(i * 2 * Math.PI / 20000), 100 * Math.sin(i * 2 * Math.PI / 20000)));
  const { r, ms } = timed(() => dxfToComponents(spokes));
  assert.equal(r.components.length, 1);
  assert.ok(r.components[0].warnings.some(w => w.code === DxfWarning.SELF_INTERSECT_UNCHECKED));
  assert.ok(ms < TIME_LIMIT_MS, `${ms}ms`);
});

test('自己交差の判定は線分数が上限（20000）を超えたら省いて SELF_INTERSECT_UNCHECKED。上限内なら判定する', () => {
  const over = dxfToComponents(zigzag(20001)).components[0];
  assert.ok(over.warnings.some(w => w.code === DxfWarning.SELF_INTERSECT_UNCHECKED));
  assert.ok(!over.warnings.some(w => w.code === DxfWarning.SELF_INTERSECT));
  const under = dxfToComponents(zigzag(20000)).components[0];
  assert.ok(!under.warnings.some(w => w.code === DxfWarning.SELF_INTERSECT_UNCHECKED));
});

test('【堅牢性】長い線分 1 本（1e7）＋長さ 1 の短線 1 万本の 1 成分が 3000ms 以内に返る（格子の登録数が上限を超えるので判定を省く）', () => {
  const segs = [seg(0, 0, 1e7, 0)];
  let s = 1e7;
  let t = 0;
  for (let i = 0; i < 10000; i++) {
    if (i % 2 === 0) { segs.push(seg(s, t, s + 1, t)); s += 1; } else { segs.push(seg(s, t, s, t + 1)); t += 1; }
  }
  const { r, ms } = timed(() => dxfToComponents(segs));
  assert.equal(r.components.length, 1);
  assert.ok(r.components[0].warnings.some(w => w.code === DxfWarning.SELF_INTERSECT_UNCHECKED), JSON.stringify(r.components[0].warnings));
  assert.ok(ms < TIME_LIMIT_MS, `${ms}ms`);
});

// 長い斜め線 (0,0)→(1000,1000) に、長さ 1 の短い手の鎖を (1000,1000)→(1000,500)→(lastX,500) と続ける。
function diagonalChain(lastX) {
  const segs = [seg(0, 0, 1000, 1000)];
  for (let y = 1000; y > 500; y--) segs.push(seg(1000, y, 1000, y - 1));
  for (let x = 1000; x > lastX; x--) segs.push(seg(x, 500, x - 1, 500));
  return segs;
}

test('格子の取りこぼし: 長い斜め線と交わる短い線分（鎖が (500,500) で斜め線に触れる）は SELF_INTERSECT。(501,500) で止めた対照は出ない', () => {
  const crossing = dxfToComponents(diagonalChain(499)).components[0];
  assert.ok(crossing.warnings.some(w => w.code === DxfWarning.SELF_INTERSECT), JSON.stringify(crossing.warnings));
  const control = dxfToComponents(diagonalChain(501)).components[0];
  assert.ok(!control.warnings.some(w => w.code === DxfWarning.SELF_INTERSECT));
  assert.ok(!control.warnings.some(w => w.code === DxfWarning.SELF_INTERSECT_UNCHECKED), '判定は省かれていない');
});

test('toStrokes: T 字の接合点は通り抜けのストロークの頂点として残る（共線でも間引かない）', () => {
  const { components } = dxfToComponents([seg(0, 0, 50, 0), seg(50, 0, 100, 0), seg(50, 0, 50, 50)]);
  const through = components[0].trails[0];
  assert.equal(through.points.length, 3);
  assert.deepEqual(components[0].strokes[0].moves.map(lenOf), [50, 50]);
  assert.deepEqual(components[0].strokes[0].moves.map(m => m.dir), [PenDir.RIGHT, PenDir.RIGHT]);
});

test('通し: 矩形＋bulge の円弧＋INSERT 1 段（$INSUNITS=4）→ 成分 3 つ・単位 mm・警告なし', () => {
  const t = doc(headerSec(4),
    blocksSec([block('TAG', [line(0, 0, 10, 0), line(10, 0, 10, 10), line(10, 10, 0, 10), line(0, 10, 0, 0)])]),
    entitiesSec([line(0, 0, 100, 0), line(100, 0, 100, 50), line(100, 50, 0, 50), line(0, 50, 0, 0), lwpoly([[200, 0, 1], [300, 0]]), insert('TAG', 400, 0)]));
  const r = readDxf(new TextEncoder().encode(t));
  assert.equal(r.ok, true);
  const scene = buildDxfScene(r.parsed);
  assert.equal(scene.ok, true);
  assert.equal(scene.unitFactor, 1);
  assert.deepEqual(scene.warnings, []);
  assert.equal(scene.components.length, 3);
  assert.equal(scene.components[0].closed, true);
  assert.equal(scene.components[1].closed, false, '半円の弧は開いている');
  assert.equal(scene.components[2].closed, true);
});

test('【失敗系】通し: 途中で切れた DXF・不正な group code は ok:false。想定外の入力でも例外を投げない', () => {
  const cut = readDxf(new TextEncoder().encode('0\nSECTION\n2\nENTITIES\n0\nLINE\n'));
  assert.equal(cut.ok, false);
  assert.equal(cut.error.code, DxfReject.TRUNCATED);
  assert.equal(readDxf(new TextEncoder().encode('zz\nSECTION\n')).error.code, DxfReject.BAD_GROUP_CODE);
  assert.equal(buildDxfScene(null).error.code, DxfReject.UNEXPECTED);
});
