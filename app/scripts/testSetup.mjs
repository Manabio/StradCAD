// `npm test`（package.json: "test": "node --import ./scripts/testSetup.mjs --test"）が
// 最初に読み込むブートストラップ。coreAliasHooks.mjs（'@core' エイリアスの解決フック）を登録する。
// module.register()（別スレッドの非同期フック）は Node 26 で実行時非推奨（DEP0205）になったため、
// 同期・同スレッドの module.registerHooks() を使う（Node 24 でも利用可）。フックは同期関数で書く。
import { registerHooks } from 'node:module';
import { resolve } from './coreAliasHooks.mjs';

registerHooks({ resolve });
