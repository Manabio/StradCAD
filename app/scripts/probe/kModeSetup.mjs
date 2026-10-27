// 【S0 専用】case1/case2 は k1 前のコミット d0d8fa8 のコードにだけ当たる（k1 以後は K_MODE=current のみ動く。kModeHooks.mjs 冒頭参照）。
// kModeHooks.mjs を登録するブートストラップ（--import で testSetup.mjs の後に渡す）。
//   K_MODE=case1 node --import ./scripts/testSetup.mjs --import ./scripts/probe/kModeSetup.mjs scripts/probe/kOpeningBeamProbe.mjs ...
import { registerHooks } from 'node:module';
import { load } from './kModeHooks.mjs';

registerHooks({ load });
