// store.js は react/IDB を静的に引くため node:test から import できない。切断高（Plane.planCutHeightMm）の
// 素通し配線をソース走査で固定する（コメント行は除いて照合。uiBusySourceScan.js の作法）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { stripCommentLines, extractFunctionBody } from './uiBusySourceScan.js';

const storeSrc = stripCommentLines(fs.readFileSync(path.resolve(import.meta.dirname, 'store.js'), 'utf8'));

test('【配線】store.js restorePlanesFromIDB: toAdd は addPlane の末尾に m.planCutHeightMm、toUpdate は p.planCutHeightMm = m.planCutHeightMm', () => {
  const body = extractFunctionBody(storeSrc, 'async function restorePlanesFromIDB');
  assert.match(body, /^\s*m\.planCutHeightMm, m\.ceilingCutHeightMm,\s*$/m, 'addPlane の引数に m.planCutHeightMm が行の形で無い');
  assert.match(body, /^\s*p\.planCutHeightMm = m\.planCutHeightMm;\s*$/m, 'toUpdate の p.planCutHeightMm = m.planCutHeightMm; が無い');
});

test('【配線】store.js restorePlanesFromIDB: 天伏の切断高も同型（toAdd は addPlane の末尾に m.ceilingCutHeightMm、toUpdate は p.ceilingCutHeightMm = m.ceilingCutHeightMm）', () => {
  const body = extractFunctionBody(storeSrc, 'async function restorePlanesFromIDB');
  assert.match(body, /^\s*m\.planCutHeightMm, m\.ceilingCutHeightMm,\s*$/m, 'addPlane の引数に m.ceilingCutHeightMm が行の形で無い');
  assert.match(body, /^\s*p\.ceilingCutHeightMm = m\.ceilingCutHeightMm;\s*$/m, 'toUpdate の p.ceilingCutHeightMm = m.ceilingCutHeightMm; が無い');
});

test('【配線】store.js addFloor: planCutHeightMm 引数を project.addPlane の第11引数へ素通しする', () => {
  const body = extractFunctionBody(storeSrc, 'export function addFloor');
  assert.match(body, /project\.addPlane\(elevation, name, planeId, startFloor, stories,\s*false, null, 0, false, null, planCutHeightMm, ceilingCutHeightMm\);/,
    'addFloor が planCutHeightMm・ceilingCutHeightMm を addPlane の第11・12引数へ渡していない');
  assert.match(storeSrc, /export function addFloor\(.*planCutHeightMm = undefined, ceilingCutHeightMm = undefined\) \{/, 'addFloor のシグネチャに planCutHeightMm・ceilingCutHeightMm が無い');
});

test('【配線】store.js addAlternativeFloor: 切断高は複製元（sourcePlane）、省略時は親採用（refPlane）から渡す', () => {
  const body = extractFunctionBody(storeSrc, 'export function addAlternativeFloor');
  assert.match(body, /false, null, \(sourcePlane \?\? refPlane\)\.planCutHeightMm,/,
    'addAlternativeFloor が (sourcePlane ?? refPlane).planCutHeightMm を addPlane へ渡していない');
  assert.match(body, /^\s*\(sourcePlane \?\? refPlane\)\.ceilingCutHeightMm,\s*$/m,
    'addAlternativeFloor が (sourcePlane ?? refPlane).ceilingCutHeightMm を addPlane へ渡していない');
  assert.match(storeSrc, /export function addAlternativeFloor\(referenceId, name, sourcePlane = undefined\)/);
});
