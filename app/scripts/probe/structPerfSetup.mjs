// structPerfHooks.mjs（storage/db.js のIDBをメモリ化し、FloorSwapManager.peek・
// recomputeStructuralForGraph に計測を仕込むロードフック）を登録するだけの薄いブートストラップ。
// 使い方（app/ で。node --import は複数指定できる）:
//   node --import ./scripts/testSetup.mjs --import ./scripts/probe/structPerfSetup.mjs \
//     scripts/probe/structPerfEntry.mjs [引数...]
// testSetup.mjs（'@core' エイリアス解決）を先に import すること——構造モードの依存モジュールの
// 一部は '@core' でsrc/core.jsを参照するため、それが無いと解決エラーになる。
import { register } from 'node:module';

register('./structPerfHooks.mjs', import.meta.url);
