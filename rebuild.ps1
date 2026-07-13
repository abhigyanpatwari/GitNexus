<#
.SYNOPSIS
  重建源码版 gitnexus（install + 激活 native binding + build + 验证）
.DESCRIPTION
  fresh checkout 或升级上游后重建。处理 3 个已知坑：
  1. gitnexus-shared 先 install typescript（build.js 依赖它跑 shared 的 tsc）
  2. @ladybugdb/core 的 native binding 手动激活（--ignore-scripts 跳过了 install.js）
  3. tree-sitter prebuilds 在 git vendor/ 里，不用编译

  4 处改动（索引化 + Option A 守卫 + emit 打点 + phase2/3 打点）在 src/，
  rebuild 后用特征字符串验证都在 dist/。若特征缺失（上游大改），参考
  rebuild-notes.md 的思路手动重做。
  脚本应放在 monorepo 根目录（和 gitnexus/、gitnexus-shared/ 平级）。
.PARAMETER SkipInstall
  跳过 npm install（已装过，只重新激活+build+验证）。改了 src 后用这个。
.EXAMPLE
  .\rebuild.ps1              # 全新重建（升级上游后）
  .\rebuild.ps1 -SkipInstall # 只重新 build（改了 src 后）
#>
param(
    [switch]$SkipInstall
)
$ErrorActionPreference = 'Stop'
$Root = $PSScriptRoot
$gitnexus = Join-Path $Root 'gitnexus'
$shared = Join-Path $Root 'gitnexus-shared'

if (-not (Test-Path $gitnexus)) { throw "gitnexus 目录不存在: $gitnexus（脚本应在 monorepo 根目录）" }

# 1. gitnexus-shared install（装 typescript，build.js 要跑 shared 的 tsc）
if (-not $SkipInstall) {
    Write-Host "=== 1. install gitnexus-shared (typescript) ===" -ForegroundColor Cyan
    Push-Location $shared
    try { npm install; if ($LASTEXITCODE -ne 0) { throw "gitnexus-shared install 失败" } }
    finally { Pop-Location }
}

# 2. gitnexus install（--ignore-scripts 加速，跳过 tree-sitter postinstall）
if (-not $SkipInstall) {
    Write-Host "`n=== 2. install gitnexus (--ignore-scripts) ===" -ForegroundColor Cyan
    Push-Location $gitnexus
    try { npm install --ignore-scripts; if ($LASTEXITCODE -ne 0) { throw "gitnexus install 失败" } }
    finally { Pop-Location }
}

# 3. 激活 @ladybugdb/core native binding（--ignore-scripts 跳过了 install.js）
#    从 core-win32-x64/lbugjs.node 复制到 @ladybugdb/core/ 根目录，否则 analyze 报 native binding 错
Write-Host "`n=== 3. 激活 @ladybugdb/core native binding ===" -ForegroundColor Cyan
Push-Location $gitnexus
try {
    $installJs = 'node_modules\@ladybugdb\core\install.js'
    if (Test-Path $installJs) {
        node $installJs
        if ($LASTEXITCODE -ne 0) { throw "@ladybugdb/core install.js 失败" }
    } else {
        Write-Host "  $installJs 不存在，可能已激活或上游改了路径，跳过" -ForegroundColor Yellow
    }
} finally { Pop-Location }

# 4. build（build.js: shared tsc + gitnexus tsc + copy _shared + rewrite imports + web UI）
Write-Host "`n=== 4. build ===" -ForegroundColor Cyan
Push-Location $gitnexus
try {
    $env:GITNEXUS_BUILD_TIMEOUT_MS = '600000'
    node scripts/build.js
    if ($LASTEXITCODE -ne 0) { throw "build 失败" }
} finally { Pop-Location }

# 5. 验证（dist 4 处改动特征 + gitnexus --version）
Write-Host "`n=== 5. 验证 4 处改动特征 ===" -ForegroundColor Cyan
$features = [ordered]@{
    'dist\core\ingestion\languages\cpp\inline-namespaces.js'  = 'buildNamespaceIndex'
    'dist\core\ingestion\scope-resolution\pipeline\run.js'   = 'sr-emit-receiver-pre'
    'dist\core\run-analyze.js'                                 = 'phase2-lbug-load-pre'
    'dist\_shared\scope-resolution\finalize-algorithm.js'     = 'names === null'
}
$allOk = $true
foreach ($f in $features.Keys) {
    $p = Join-Path $gitnexus $f
    $has = if (Test-Path $p) { Select-String -Path $p -Pattern $features[$f] -SimpleMatch -Quiet } else { $false }
    if (-not $has) { $allOk = $false }
    $status = if ($has) { 'OK' } else { '!!! 缺失' }
    Write-Host ("  {0,-50} {1}" -f (Split-Path $f -Leaf), $status)
}
$ver = & gitnexus --version 2>&1 | Select-Object -First 1
Write-Host "  gitnexus --version: $ver"

if ($allOk) {
    Write-Host "`n完成：源码版 gitnexus 已重建，4 处改动在位。" -ForegroundColor Green
} else {
    Write-Host "`n!!! 部分改动缺失，上游可能大改了，参考 rebuild-notes.md 手动重做。" -ForegroundColor Red
    exit 1
}
