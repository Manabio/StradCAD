# 本番デプロイ

公開先: さくらのレンタルサーバー（SSH）。https://www.strad-cad.com 。接続設定は`~/.ssh/config`の`Host strad-cad-deploy`（リポジトリ非管理）。

## 実行方法
リポジトリルートで`.\deploy.ps1`。`app/`をビルドし`dist`を`scp -r`でそのまま転送、リモートの公開ディレクトリを入れ替える。**gitのコミット状態とは無関係**——作業ツリーの現在のファイルをそのまま公開する。

## Windows特有の既知の問題
- 標準`tar.exe`(bsdtar)はGNU tar用`--force-local`を解釈できない → tar化はやめ`scp -r`でフォルダを直接転送する（対応済み、`deploy.ps1`参照）。
- OpenSSHは`~/.ssh/config`・秘密鍵のACLに所有者以外への許可が残っていると接続を拒否する（「Bad permissions」、サーバー側の鍵登録とは無関係）。対処:
  ```powershell
  icacls "$env:USERPROFILE\.ssh\config" /inheritance:r /grant:r "${env:USERNAME}:F"
  ```
  使用する秘密鍵ファイルにも同様に実行する。
