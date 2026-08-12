[CmdletBinding()]
param(
  [ValidateSet("all", "source", "portable", "sea")]
  [string]$Target = "all"
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$ReleaseRoot = Join-Path $Root "release"
$StageRoot = Join-Path $ReleaseRoot ".stage"
$Package = Get-Content -LiteralPath (Join-Path $Root "package.json") -Raw | ConvertFrom-Json
$Version = [string]$Package.version
$ProductName = "mCodex"

function Invoke-Checked([string]$FilePath, [string[]]$Arguments) {
  & $FilePath @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "Command failed ($LASTEXITCODE): $FilePath $($Arguments -join ' ')"
  }
}

function Reset-Directory([string]$Path) {
  $resolvedRoot = [IO.Path]::GetFullPath($ReleaseRoot)
  $resolvedPath = [IO.Path]::GetFullPath($Path)
  if (-not $resolvedPath.StartsWith($resolvedRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to reset a directory outside the release root: $resolvedPath"
  }
  if (Test-Path -LiteralPath $resolvedPath) {
    Remove-Item -LiteralPath $resolvedPath -Recurse -Force
  }
  New-Item -ItemType Directory -Path $resolvedPath -Force | Out-Null
}

function Compress-Directory([string]$Directory, [string]$Destination) {
  if (Test-Path -LiteralPath $Destination) { Remove-Item -LiteralPath $Destination -Force }
  Compress-Archive -Path (Join-Path $Directory "*") -DestinationPath $Destination -CompressionLevel Optimal
}

function Write-Utf8NoBom([string]$Path, [string]$Content) {
  $encoding = New-Object System.Text.UTF8Encoding($false)
  [IO.File]::WriteAllText($Path, $Content, $encoding)
}

function Get-Sha256([string]$Path) {
  $sha = [Security.Cryptography.SHA256]::Create()
  try {
    return ([BitConverter]::ToString($sha.ComputeHash([IO.File]::ReadAllBytes($Path)))).Replace('-', '').ToLowerInvariant()
  } finally {
    $sha.Dispose()
  }
}

function Ensure-ApplicationBuild {
  $npm = (Get-Command npm.cmd -ErrorAction Stop).Source
  Invoke-Checked $npm @("run", "build")
}

function Build-Bundle([string]$EntryPoint, [string]$OutputFile) {
  $esbuild = Join-Path $Root "node_modules\.bin\esbuild.cmd"
  if (-not (Test-Path -LiteralPath $esbuild)) {
    throw "esbuild was not found. Run npm install first."
  }
  $arguments = @(
    $EntryPoint,
    "--bundle",
    "--platform=node",
    "--format=cjs",
    "--target=node22",
    "--external:chromium-bidi",
    "--outfile=$OutputFile",
    "--log-level=warning"
  )
  Invoke-Checked $esbuild $arguments
}

function Build-SourceRelease {
  $name = "$ProductName-$Version-source"
  $stage = Join-Path $StageRoot $name
  Reset-Directory $stage

  foreach ($file in @(
    ".env.example", ".gitattributes", ".gitignore", "CHANGELOG.md", "CODE_OF_CONDUCT.md",
    "LICENSE", "README.md", "README_ZH.md", "SECURITY.md", "manage.bat",
    "package.json", "package-lock.json", "tsconfig.json", "tsconfig.server.json",
    "vite.config.ts", "vitest.config.ts"
  )) {
    Copy-Item -LiteralPath (Join-Path $Root $file) -Destination $stage
  }
  foreach ($directory in @(".github", "docs", "readme", "scripts", "src", "web")) {
    Copy-Item -LiteralPath (Join-Path $Root $directory) -Destination $stage -Recurse
  }

  $zip = Join-Path $ReleaseRoot "$name.zip"
  Compress-Directory $stage $zip
  Write-Host "Source release: $zip" -ForegroundColor Green
}

function Build-PortableRelease {
  Ensure-ApplicationBuild
  $name = "$ProductName-$Version-win-x64-portable"
  $stage = Join-Path $StageRoot $name
  Reset-Directory $stage
  New-Item -ItemType Directory -Path (Join-Path $stage "app"), (Join-Path $stage "scripts") | Out-Null

  Build-Bundle (Join-Path $Root "src\index.ts") (Join-Path $stage "app\server.cjs")
  Copy-Item -LiteralPath (Join-Path $Root "dist\web") -Destination (Join-Path $stage "web") -Recurse
  Copy-Item -LiteralPath (Join-Path $Root "scripts\manage.ps1") -Destination (Join-Path $stage "scripts\manage.ps1")
  Copy-Item -LiteralPath (Join-Path $Root "scripts\start-codex-cdp.ps1") -Destination (Join-Path $stage "scripts\start-codex-cdp.ps1")
  Copy-Item -LiteralPath (Join-Path $Root "manage.bat") -Destination (Join-Path $stage "manage.bat")
  Copy-Item -LiteralPath (Join-Path $Root "manage.bat") -Destination (Join-Path $stage "start.bat")
  Copy-Item -LiteralPath (Join-Path $Root "LICENSE") -Destination $stage
  Copy-Item -LiteralPath (Join-Path $Root "README.md") -Destination $stage
  Copy-Item -LiteralPath (Join-Path $Root "README_ZH.md") -Destination $stage
  Copy-Item -LiteralPath (Join-Path $Root "SECURITY.md") -Destination $stage
  Copy-Item -LiteralPath (Join-Path $Root "node_modules\playwright-core\package.json") -Destination (Join-Path $stage "package.json")
  Copy-Item -LiteralPath (Join-Path $Root "node_modules\playwright-core\browsers.json") -Destination (Join-Path $stage "browsers.json")

  $node = (Get-Command node.exe -ErrorAction Stop).Source
  Copy-Item -LiteralPath $node -Destination (Join-Path $stage "node.exe")

  @"
mCodex $Version - Windows 便携版

1. 第一次启动前，请完全退出 Codex Desktop。
2. 双击 start.bat。
3. 启动窗口会显示配对码；关闭窗口后，服务仍会在后台运行。
4. 电脑端页面会显示二维码，请用手机扫描使用。

此版本已内置 Node.js，不需要执行 npm install 或 npm run build。
"@ | Set-Content -LiteralPath (Join-Path $stage "PORTABLE-README.txt") -Encoding utf8

  $zip = Join-Path $ReleaseRoot "$name.zip"
  Compress-Directory $stage $zip
  Write-Host "Portable release: $zip" -ForegroundColor Green
}

function Build-SeaRelease {
  Ensure-ApplicationBuild
  $name = "$ProductName-$Version-win-x64"
  $stage = Join-Path $StageRoot "$name-sea"
  Reset-Directory $stage

  $entry = Join-Path $stage "sea-entry.cjs"
  $manifestPath = Join-Path $stage "release-manifest.json"
  $configPath = Join-Path $stage "sea-config.json"
  $blobPath = Join-Path $stage "sea-prep.blob"
  $exePath = Join-Path $ReleaseRoot "$name.exe"
  $node = (Get-Command node.exe -ErrorAction Stop).Source

  Build-Bundle (Join-Path $Root "scripts\sea-bootstrap.ts") $entry

  $webRoot = Join-Path $Root "dist\web"
  $webRootUri = [Uri]((Get-Item -LiteralPath $webRoot).FullName.TrimEnd('\') + '\')
  $webFiles = @(Get-ChildItem -LiteralPath $webRoot -Recurse -File | ForEach-Object {
    $relativeUri = $webRootUri.MakeRelativeUri([Uri]$_.FullName)
    [Uri]::UnescapeDataString($relativeUri.ToString()).Replace('\', '/')
  })
  $manifestJson = @{ version = $Version; webFiles = $webFiles } | ConvertTo-Json -Depth 4
  Write-Utf8NoBom $manifestPath $manifestJson

  $assets = [ordered]@{
    "release-manifest.json" = $manifestPath
    "package.json" = Join-Path $Root "node_modules\playwright-core\package.json"
    "browsers.json" = Join-Path $Root "node_modules\playwright-core\browsers.json"
    "start-codex-cdp.ps1" = Join-Path $Root "scripts\start-codex-cdp.ps1"
  }
  foreach ($relativePath in $webFiles) {
    $assets["web/$relativePath"] = Join-Path $webRoot ($relativePath.Replace('/', '\'))
  }
  [ordered]@{
    main = $entry
    output = $blobPath
    disableExperimentalSEAWarning = $true
    useSnapshot = $false
    useCodeCache = $false
    assets = $assets
  } | ConvertTo-Json -Depth 8 | ForEach-Object { Write-Utf8NoBom $configPath $_ }

  Invoke-Checked $node @("--experimental-sea-config", $configPath)
  Copy-Item -LiteralPath $node -Destination $exePath -Force

  $signtool = Get-Command signtool.exe -ErrorAction SilentlyContinue
  if ($signtool) {
    & $signtool.Source remove /s $exePath | Out-Null
  }

  $postject = Join-Path $Root "node_modules\.bin\postject.cmd"
  if (-not (Test-Path -LiteralPath $postject)) {
    throw "postject was not found. Run npm install first."
  }
  Invoke-Checked $postject @(
    $exePath,
    "NODE_SEA_BLOB",
    $blobPath,
    "--sentinel-fuse",
    "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
    "--overwrite"
  )

  & $exePath --self-test
  if ($LASTEXITCODE -ne 0) {
    throw "SEA self-test failed with exit code $LASTEXITCODE"
  }

  $hash = Get-Sha256 $exePath
  "$hash  $([IO.Path]::GetFileName($exePath))" |
    Set-Content -LiteralPath "$exePath.sha256" -Encoding ascii
  Write-Host "SEA executable: $exePath" -ForegroundColor Green
}

New-Item -ItemType Directory -Path $ReleaseRoot, $StageRoot -Force | Out-Null

switch ($Target) {
  "source" { Build-SourceRelease }
  "portable" { Build-PortableRelease }
  "sea" { Build-SeaRelease }
  "all" {
    Build-SourceRelease
    Build-PortableRelease
    Build-SeaRelease
  }
}
