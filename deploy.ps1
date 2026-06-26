# StradCAD デプロイスクリプト
# app/dist をビルドし、SSH 経由で公開サーバー(strad-cad-deploy)へ転送・展開する
# 接続設定は ~/.ssh/config の Host "strad-cad-deploy" を参照

$ErrorActionPreference = "Stop"

$RemoteHost    = "strad-cad-deploy"
$RemotePath    = "/home/mana-bio/www/strad-cad/public"
$RemoteTmpPath = "/tmp/strad-cad-dist-new"

$root    = Split-Path -Parent $MyInvocation.MyCommand.Path
$appDir  = Join-Path $root "app"
$distDir = Join-Path $appDir "dist"

Push-Location $appDir
try {
    Write-Host "[1/3] ビルド中..."
    npm run build
    if ($LASTEXITCODE -ne 0) { throw "ビルドに失敗しました" }

    Write-Host "[2/3] サーバーへ転送中... ($RemoteHost`:$RemoteTmpPath)"
    ssh $RemoteHost "rm -rf '$RemoteTmpPath'"
    if ($LASTEXITCODE -ne 0) { throw "転送先の準備に失敗しました" }
    scp -r $distDir "${RemoteHost}:${RemoteTmpPath}"
    if ($LASTEXITCODE -ne 0) { throw "転送に失敗しました" }

    Write-Host "[3/3] サーバー上で切り替え中..."
    ssh $RemoteHost "rm -rf '$RemotePath' && mv '$RemoteTmpPath' '$RemotePath'"
    if ($LASTEXITCODE -ne 0) { throw "サーバー上での切り替えに失敗しました" }

    Write-Host "デプロイ完了: https://www.strad-cad.com"
}
finally {
    Pop-Location
}
