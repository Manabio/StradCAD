// `npm test`（package.json: "test": "node --import ./scripts/testSetup.mjs --test"）が
// 最初に読み込むブートストラップ。coreAliasHooks.mjs（'@core' エイリアスの解決フック）を登録する。
import { register } from 'node:module';

register('./coreAliasHooks.mjs', import.meta.url);
