import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONTEXT, buildMenuState } from './menuItems.js';

// ---- buildMenuState（長押しメニューの context 判定＋items 生成） ----

test('buildMenuState: 建具モード（appMode=opening）で壁・開口以外（中心線）の長押しは null', () => {
  const cl = { id: 'cl1', centerLineType: 'X' };
  const state = buildMenuState('opening', { snap: null, cl, clEndpoint: null, opening: null, wall: null, canMove: true });
  assert.equal(state, null);
});

test('buildMenuState: 建具モードでも壁上の長押しは null にならず items が非空', () => {
  const wall = { id: 'w1' };
  const state = buildMenuState('opening', {
    snap: null, cl: null, clEndpoint: null, opening: null, wall, wallEligible: true,
  });
  assert.notEqual(state, null);
  assert.equal(state.context, CONTEXT.WALL);
  assert.ok(state.items.length > 0, '壁上メニューは常に建具・窓の項目を持つ');
});

test('buildMenuState: 建具モードでも開口上の長押しは null にならない', () => {
  const opening = { id: 'o1' };
  const state = buildMenuState('opening', { snap: null, cl: null, clEndpoint: null, opening, wall: null });
  assert.notEqual(state, null);
  assert.equal(state.context, CONTEXT.OPENING);
});

test('buildMenuState: 非建具モードの中心線上は null にならず、canMove/hasInteriorWall を反映する', () => {
  const cl = { id: 'cl1', centerLineType: 'Y' };
  const state = buildMenuState('floorplan', {
    snap: null, cl, clEndpoint: null, opening: null, wall: null, canMove: true, hasInteriorWall: true,
  });
  assert.equal(state.context, CONTEXT.CENTER_LINE);
  assert.equal(state.clState.isVertical, false); // 'Y' = CenterLineType.HORIZONTAL
  assert.ok(state.items.some(i => i.id === 'cl-ecc'), 'hasInteriorWall=true なら偏芯項目が出る');
});

// ---- 中心⇔通り芯の入替え（平面モード限定） ----

test('buildMenuState: canToGrid=true なら CL端点メニューに「通り芯に」が出る', () => {
  const clEndpoint = { cl: { id: 'cl1', centerLineType: 'X' }, side: 'lo' };
  const state = buildMenuState('floorplan', {
    snap: null, cl: null, clEndpoint, opening: null, wall: null,
    canExtend: true, canShorten: true, canToGrid: true,
  });
  assert.equal(state.context, CONTEXT.CENTER_LINE_ENDPOINT);
  assert.ok(state.items.some(i => i.id === 'cl-to-grid'), 'canToGrid=true なら通り芯化項目が出る');
});

test('buildMenuState: canToGrid=false なら CL端点メニューに「通り芯に」が出ない', () => {
  const clEndpoint = { cl: { id: 'cl1', centerLineType: 'X' }, side: 'lo' };
  const state = buildMenuState('floorplan', {
    snap: null, cl: null, clEndpoint, opening: null, wall: null,
    canExtend: true, canShorten: true, canToGrid: false,
  });
  assert.equal(state.items.some(i => i.id === 'cl-to-grid'), false);
});

test('buildMenuState: canToCenter=true なら中心線上メニューに「中心に」が出る', () => {
  const cl = { id: 'cl1', centerLineType: 'X' };
  const state = buildMenuState('floorplan', {
    snap: null, cl, clEndpoint: null, opening: null, wall: null, canMove: true, canToCenter: true,
  });
  assert.equal(state.context, CONTEXT.CENTER_LINE);
  assert.ok(state.items.some(i => i.id === 'cl-to-center'), 'canToCenter=true なら中心化項目が出る');
});

test('buildMenuState: canToCenter=false なら中心線上メニューに「中心に」が出ない（既存項目は維持）', () => {
  const cl = { id: 'cl1', centerLineType: 'X' };
  const state = buildMenuState('floorplan', {
    snap: null, cl, clEndpoint: null, opening: null, wall: null, canMove: true, canToCenter: false,
  });
  assert.equal(state.items.some(i => i.id === 'cl-to-center'), false);
  assert.ok(state.items.some(i => i.id === 'cl-move'));
  assert.ok(state.items.some(i => i.id === 'cl-del'));
});
