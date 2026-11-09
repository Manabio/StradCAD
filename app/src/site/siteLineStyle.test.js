// siteLineStyle.js（敷地図の線の描画規則・唯一の供給源）のテスト。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SiteLineKind } from '../core/constants.js';
import {
  SITE_LINE_COLOR, SITE_BOUNDARY_DASH, SITE_CORNER_MARK_RADIUS_PX, SITE_CORNER_MARK_WEIGHT,
  siteLineWeightKey, siteLineKindLabel, lineHitWidth, HIT_PX_MAX,
} from './siteLineStyle.js';

test('lineHitWidth: 線長・倍率に依らず固定の画面px（12）を返す。実寸（/ scaleX）へ直さない', () => {
  assert.equal(HIT_PX_MAX, 12);
  assert.equal(lineHitWidth(), 12);
  // 引数（旧 API の line・viewport）が渡っても結果は変わらない
  assert.equal(lineHitWidth({ length: 10 }, { scaleX: 0.08 }), 12);
  assert.equal(lineHitWidth({ length: 100000 }, { scaleX: 5 }), 12);
});

test('定数: 黒・一点鎖線[40,4,2,4]・角の丸 半径6px/thin', () => {
  assert.equal(SITE_LINE_COLOR, '#000000');
  assert.deepEqual([...SITE_BOUNDARY_DASH], [40, 4, 2, 4]);
  assert.equal(SITE_CORNER_MARK_RADIUS_PX, 6);
  assert.equal(SITE_CORNER_MARK_WEIGHT, 'thin');
});

test('siteLineWeightKey: 外周=medium（選択thick）・内側=thin（選択medium）', () => {
  assert.equal(siteLineWeightKey(true, false), 'medium');
  assert.equal(siteLineWeightKey(true, true), 'thick');
  assert.equal(siteLineWeightKey(false, false), 'thin');
  assert.equal(siteLineWeightKey(false, true), 'medium');
});

test('siteLineKindLabel: 外周∧ROAD=道路・外周∧無指定/BOUNDARY=隣地・内側=-（種別を問わず）', () => {
  assert.equal(siteLineKindLabel(true, SiteLineKind.ROAD), '道路');
  assert.equal(siteLineKindLabel(true, SiteLineKind.SURVEY), '隣地');
  assert.equal(siteLineKindLabel(true, SiteLineKind.BOUNDARY), '隣地');
  assert.equal(siteLineKindLabel(false, SiteLineKind.ROAD), '-');
  assert.equal(siteLineKindLabel(false, SiteLineKind.SURVEY), '-');
});
