param(
  [int]$Port = 9222,
  [string]$ProfileDirectory = "",
  [string]$CdpUrlFile = ""
)

function Get-CdpUrlFile {
  if ($CdpUrlFile) { return $CdpUrlFile }
  return Join-Path $env:TEMP "mcodex-cdp-url"
}

function Test-CdpUrl([string]$Url) {
  if (-not $Url) { return $false }
  try {
    $response = Invoke-WebRequest -Uri "$Url/json/version" -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop
    return ($response.StatusCode -ge 200 -and $response.StatusCode -lt 500)
  } catch {
    return $false
  }
}

function Find-CdpUrlFromProcesses {
  if ($env:CODEX_CDP_URL -and (Test-CdpUrl $env:CODEX_CDP_URL)) { return $env:CODEX_CDP_URL }

  try {
    $chatgpt = Get-CimInstance Win32_Process -Filter "Name = 'ChatGPT.exe'" -ErrorAction Stop
    $ports = @($chatgpt | ForEach-Object {
      if ($_.CommandLine -match '--remote-debugging-port=(\d+)') { [int]$Matches[1] }
    } | Sort-Object -Unique)

    foreach ($port in $ports) {
      $url = "http://127.0.0.1:$port"
      if (Test-CdpUrl $url) { return $url }
    }
  } catch {}

  $defaultUrl = "http://127.0.0.1:$Port"
  if (Test-CdpUrl $defaultUrl) { return $defaultUrl }
  return $null
}

function Write-CdpUrl([string]$Url) {
  try {
    Set-Content -LiteralPath (Get-CdpUrlFile) -Value $Url -Encoding ascii
  } catch {}
}

function Get-CodexPlusPlusPaths {
  $root = Join-Path $env:LOCALAPPDATA "Programs\Codex++"
  [pscustomobject]@{
    Manager = Join-Path $root "codex-plus-plus-manager.exe"
    Helper = Join-Path $root "codex-plus-plus.exe"
  }
}

$cdpUrl = Find-CdpUrlFromProcesses
if ($cdpUrl) {
  Write-CdpUrl $cdpUrl
  Write-Host "Codex 控制通道已在线：$cdpUrl"
  exit 0
}

$codexPlusPlus = Get-CodexPlusPlusPaths
if ((Test-Path -LiteralPath $codexPlusPlus.Manager) -or (Test-Path -LiteralPath $codexPlusPlus.Helper)) {
  Write-Host "检测到 Codex++，正在启动增强版 Codex Desktop..." -ForegroundColor Yellow

  if (Test-Path -LiteralPath $codexPlusPlus.Manager) {
    if (-not (Get-Process codex-plus-plus-manager -ErrorAction SilentlyContinue)) {
      Start-Process -FilePath $codexPlusPlus.Manager -WindowStyle Normal | Out-Null
    }
  } elseif (Test-Path -LiteralPath $codexPlusPlus.Helper) {
    if (-not (Get-Process codex-plus-plus -ErrorAction SilentlyContinue)) {
      Start-Process -FilePath $codexPlusPlus.Helper -ArgumentList '--debug-port', '9229', '--helper-port', '57321' -WindowStyle Normal | Out-Null
    }
  }

  $deadline = (Get-Date).AddSeconds(120)
  while ((Get-Date) -lt $deadline) {
    $cdpUrl = Find-CdpUrlFromProcesses
    if ($cdpUrl) {
      Write-CdpUrl $cdpUrl
      Write-Host "Codex++ 控制通道已就绪：$cdpUrl"
      exit 0
    }
    Start-Sleep -Seconds 1
  }

  Write-Error "Codex++ 控制通道在 120 秒内没有就绪。请确认 Codex++ 已登录并重新运行。"
  exit 1
}

$running = Get-Process ChatGPT -ErrorAction SilentlyContinue
if ($running) {
  Write-Host "检测到 Codex Desktop 正在运行，但尚未开启控制通道。" -ForegroundColor Yellow
  Write-Host "请完全退出 Codex Desktop，然后按 Enter 继续。"
  [void](Read-Host "按 Enter 继续")
  $deadline = (Get-Date).AddSeconds(30)
  while ((Get-Process ChatGPT -ErrorAction SilentlyContinue) -and (Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 500
  }
  if (Get-Process ChatGPT -ErrorAction SilentlyContinue) {
    Write-Error "Codex 仍在运行。请完全退出后再启动。"
    exit 1
  }
}

$package = Get-AppxPackage -Name 'OpenAI.Codex'
if (-not $package) {
  Write-Error "没有找到微软商店版 Codex（OpenAI.Codex），也没有找到 Codex++。"
  exit 1
}

$executable = Join-Path $package.InstallLocation 'app\ChatGPT.exe'
$arguments = @(
  '--remote-debugging-address=127.0.0.1',
  "--remote-debugging-port=$Port"
)

if ([string]::IsNullOrWhiteSpace($ProfileDirectory)) {
  $ProfileDirectory = Join-Path $env:LOCALAPPDATA 'OpenAI\Codex\RemoteBridgeProfile'
}
New-Item -ItemType Directory -Path $ProfileDirectory -Force | Out-Null
$arguments += "--user-data-dir=$ProfileDirectory"

Start-Process -FilePath $executable -ArgumentList $arguments -WindowStyle Normal

Write-Host "Codex 已启动，正在等待控制通道就绪..."

$defaultUrl = "http://127.0.0.1:$Port"
$deadline = (Get-Date).AddSeconds(120)
while ((Get-Date) -lt $deadline) {
  if (Test-CdpUrl $defaultUrl) {
    Write-CdpUrl $defaultUrl
    Write-Host "Codex 控制通道已就绪：$defaultUrl"
    exit 0
  }
  Start-Sleep -Seconds 1
}

Write-Error "Codex 控制通道在 120 秒内没有就绪。"
exit 1
