// core/room.js のステップ7b: 内装マスターのregistry合成（doc overlay）が
// getFinishInfo()に反映されることの確認。setOverlay/clearOverlaysで catalogRegistry.js の
// モジュールスコープ状態を変えるため、汚染を避けて core/room.test.js とは別ファイルにする
// （catalogRegistry.overlay.test.js の方針。node:test はファイル単位で別プロセス）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Room } from './room.js';
import { CatalogKind, kindDef, interiorMasterBuiltinList } from '../catalog/catalogKinds.js';
import { setOverlay, clearOverlays, composeCatalog } from '../catalog/catalogRegistry.js';
import { INTERIOR_MASTERS } from '../finish/materials/interiorMasters.js';
import * as interiorMastersMod from '../finish/materials/interiorMasters.js';

test.afterEach(() => clearOverlays());

test('doc overlayで内装マスターを立てると、templateKeyがそれを指す部屋のgetFinishInfo()に反映される（keyは除去、labelは残る）', () => {
  const docEntry = {
    key: 'LIVING_ROOM',
    label: '居室（文書同梱で上書き）',
    wallMaterial: '999999999999',
    wallFinish: '999999999998',
    ceilingHeight: 3000,
  };
  setOverlay(CatalogKind.INTERIOR_MASTER, { doc: [docEntry] });

  const room = new Room('r1', '居間', new Set(), new Set(), undefined, 'LIVING_ROOM');
  const info = room.getFinishInfo();
  assert.equal(info.wallMaterial, '999999999999', 'doc overlayの値がgetFinishInfo()に反映されていない');
  assert.equal(info.wallFinish, '999999999998');
  assert.equal(info.ceilingHeight, 3000);
  assert.equal('key' in info, false, 'doc overlay経由でもkeyは除去される');
  // 2026-09-23 QA指摘Major-1: labelはmasterのフィールドとして残る（旧INTERIOR_MASTERS[key]
  // 直参照でもlabelは返っていたため、doc overlayでもkeyだけ除去してlabelは反転せず残す）。
  assert.equal(info.label, '居室（文書同梱で上書き）', 'doc overlayのlabelがgetFinishInfo()に反映されていない');
});

test('doc overlayが無ければbuiltin（INTERIOR_MASTERS）どおりの値になる（overlayFor既定値の確認）', () => {
  const room = new Room('r1', '居間', new Set(), new Set(), undefined, 'LIVING_ROOM');
  const info = room.getFinishInfo();
  assert.equal(info.wallMaterial, INTERIOR_MASTERS.LIVING_ROOM.wallMaterial);
});

test('clearOverlays後はdoc overlayが外れ、builtinの値に戻る', () => {
  setOverlay(CatalogKind.INTERIOR_MASTER, {
    doc: [{ key: 'LIVING_ROOM', label: 'x', wallMaterial: '999999999999', wallFinish: '999999999998', ceilingHeight: 3000 }],
  });
  clearOverlays();
  const room = new Room('r1', '居間', new Set(), new Set(), undefined, 'LIVING_ROOM');
  assert.equal(room.getFinishInfo().wallMaterial, INTERIOR_MASTERS.LIVING_ROOM.wallMaterial);
});

// room.js内部のbuiltinList（interiorMasterBuiltinList経由）が、実際の本番読み出し口
// catalogKinds.js の loadBuiltin（動的import）が返す配列と完全に同じであることを確認する
// （2026-09-23 QA指摘Minor-1: 「同じ形」を手で再現した式との比較ではなく、本物の
// loadBuiltin()の戻り値とdeepStrictEqualで固定する）。
test('room.js内部のbuiltinList（interiorMasterBuiltinList）はcatalogKinds.js loadBuiltinの戻り値と完全に一致する', async () => {
  const viaHelper = interiorMasterBuiltinList(interiorMastersMod);
  const viaLoadBuiltin = await kindDef(CatalogKind.INTERIOR_MASTER).loadBuiltin();
  assert.deepStrictEqual(viaHelper, viaLoadBuiltin);

  const map = composeCatalog(CatalogKind.INTERIOR_MASTER, viaHelper);
  const room = new Room('r1', '便所', new Set(), new Set(), undefined, 'RESTROOM');
  const info = room.getFinishInfo();
  assert.equal(info.wallMaterial, map.get('RESTROOM').wallMaterial);
  assert.equal(info.ceilingHeight, map.get('RESTROOM').ceilingHeight);
});

// ---- 実行時（罠）: templateKey===nullならcomposeCatalogを一切呼ばないことを、
// ソーステキスト検査（room.test.jsの不変条件）ではなく実際の例外発火で固定する
// （2026-09-23 QA指摘Minor-3）。
//
// 経緯: 当初案（doc に同キーを2件立てて compose 時に例外にする）は空振りだった——
// 実際に確認したところ、setOverlayは同キー重複を拒否せず（validateはエントリ単位のみ）、
// composeCatalog側もinteriorMasterのdedupeFieldsがnullのため「内容重複」の検出をしない
// （R17のassertNoDuplicatesInMergedはdedupeFields前提）。そのため別の罠にした:
//
// setOverlayのvalidate()はentry.keyを（requireFields内・明示チェックの計2回）読むが、
// その時点ではまだ「非armed」で安全な文字列を返すgetterを仕込む。setOverlayが成功したあと
// テスト側でarmed=trueにする——以降このgetterを読むと例外を投げる。
// composeCatalogのresolveCatalogはdoc配列の全エントリに対してdef.keyOf(entry)を呼ぶ
// （要求されたキーが何であれ、docに入っている全エントリのkeyを読む）ため、
// composeCatalogが実際に呼ばれた場合は必ずこの罠に触れて例外になる。
// templateKey===nullで短絡が効いていればcomposeCatalogは一切呼ばれず、罠にも触れない。
function makeArmedTrapEntry(armRef) {
  return {
    label: '罠エントリ', wallMaterial: '1', wallFinish: '2', ceilingHeight: 1,
    get key() {
      if (armRef.armed) {
        throw new Error('罠発火: composeCatalog(INTERIOR_MASTER)がdocエントリのkeyへアクセスした（呼ばれた証跡）');
      }
      return 'TRAP_KEY_NEVER_REQUESTED';
    },
  };
}

test('実行時（罠）: templateKeyがnullならcomposeCatalogを呼ばない（呼べば即発火する罠を仕込んでも例外が起きない）。templateKeyが非nullなら罠が発火する', () => {
  const armRef = { armed: false };
  setOverlay(CatalogKind.INTERIOR_MASTER, { doc: [makeArmedTrapEntry(armRef)] }); // armed=false中に安全に検証を通す
  armRef.armed = true; // ここから先、composeCatalogが罠エントリのkeyを読むと即例外

  const nullRoom = new Room('r1', '未指定', new Set(), new Set()); // templateKey===null
  assert.doesNotThrow(
    () => nullRoom.getFinishInfo(),
    'templateKeyがnullなのに罠が発火した（composeCatalogが呼ばれている＝短絡が効いていない）',
  );

  const namedRoom = new Room('r2', '居間', new Set(), new Set(), undefined, 'LIVING_ROOM'); // templateKey!==null
  assert.throws(
    () => namedRoom.getFinishInfo(),
    /罠発火/,
    'templateKeyが非nullなのに罠が発火しなかった（composeCatalogが呼ばれていない疑い）',
  );
});
