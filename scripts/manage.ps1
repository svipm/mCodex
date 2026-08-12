[CmdletBinding()]
param(
  [string]$Command = ""
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $Root

$BridgePort = 3210
$CdpPort = 9222
$LogDir = Join-Path $Root ".run-logs"
$BridgePidFile = Join-Path $LogDir "bridge.pid"
$BridgeOut = Join-Path $LogDir "bridge.out.log"
$BridgeErr = Join-Path $LogDir "bridge.err.log"
$PackagedNode = Join-Path $Root "node.exe"
$PackagedServer = Join-Path $Root "app\server.cjs"

$requestedLocale = [string]$env:MCODEX_LOCALE
if ($requestedLocale -match '^en(?:-|$)') {
  $script:Locale = "en-US"
} elseif ($requestedLocale -match '^zh(?:-|$)') {
  $script:Locale = "zh-CN"
} elseif ([Globalization.CultureInfo]::CurrentUICulture.TwoLetterISOLanguageName -eq "en") {
  $script:Locale = "en-US"
} else {
  $script:Locale = "zh-CN"
}

function T([string]$Chinese, [string]$English) {
  if ($script:Locale -eq "en-US") { return $English }
  return $Chinese
}

$script:NodeExe = $null
$script:NpmCmd = $null
$script:WingetCmd = $null
$script:CdpUrl = $null

function Write-Step([string]$Message) {
  Write-Host ""
  Write-Host "==> $Message" -ForegroundColor Cyan
}

function Fail([string]$Message) {
  throw $Message
}

function Refresh-Path {
  $machinePath = [Environment]::GetEnvironmentVariable("Path", "Machine")
  $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
  $env:Path = "$machinePath;$userPath"
}

function Resolve-Winget {
  $command = Get-Command winget.exe -ErrorAction SilentlyContinue
  if ($command) {
    $script:WingetCmd = $command.Source
    return $true
  }
  return $false
}

function Ensure-Winget {
  if (Resolve-Winget) { return }

  Write-Step "Windows App Installer (winget) is required"
  Write-Host "Opening the official Microsoft Store page. Install App Installer, then return here."
  Start-Process "ms-windows-store://pdp/?productid=9NBLGGH4NNS1" | Out-Null
  Read-Host "Press Enter after App Installer has finished installing"
  Refresh-Path
  if (-not (Resolve-Winget)) {
    Fail "winget is still unavailable. Install Microsoft App Installer and run manage.bat again."
  }
}

function Get-NodePath {
  if (Test-Path -LiteralPath $PackagedNode) { return $PackagedNode }

  $command = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($command) { return $command.Source }

  $candidates = @(
    (Join-Path ${env:ProgramFiles} "nodejs\node.exe"),
    (Join-Path ${env:ProgramFiles(x86)} "nodejs\node.exe")
  )
  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path -LiteralPath $candidate)) { return $candidate }
  }
  return $null
}

function Test-SupportedNodeVersion([string]$Version) {
  $match = [regex]::Match($Version, "^(?:v)?(\d+)\.(\d+)\.(\d+)")
  if (-not $match.Success) { return $false }
  $major = [int]$match.Groups[1].Value
  $minor = [int]$match.Groups[2].Value
  return (($major -eq 20 -and $minor -ge 19) -or ($major -eq 22 -and $minor -ge 12) -or ($major -gt 22))
}

function Resolve-Node {
  $path = Get-NodePath
  if (-not $path) { return $false }

  $version = (& $path --version 2>$null).Trim()
  if (-not (Test-SupportedNodeVersion $version)) {
    Write-Host "Found Node.js $version, but this project needs 20.19+ or 22.12+." -ForegroundColor Yellow
    return $false
  }

  $script:NodeExe = $path
  $nodeDir = Split-Path -Parent $path
  $env:Path = "$nodeDir;$env:Path"
  $npmCandidate = Join-Path $nodeDir "npm.cmd"
  if (Test-Path -LiteralPath $npmCandidate) {
    $script:NpmCmd = $npmCandidate
  } else {
    $npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
    if ($npm) { $script:NpmCmd = $npm.Source }
  }
  return [bool]$script:NpmCmd
}

function Ensure-Node {
  if (Resolve-Node) {
    Write-Host "Node.js is ready: $((& $script:NodeExe --version).Trim())" -ForegroundColor Green
    Write-Host "npm is ready: $((& $script:NpmCmd --version).Trim())" -ForegroundColor Green
    return
  }

  Ensure-Winget
  Write-Step "Installing a supported Node.js LTS release"
  & $script:WingetCmd install --id OpenJS.NodeJS.LTS --exact --source winget --force --silent --accept-package-agreements --accept-source-agreements
  if ($LASTEXITCODE -ne 0) {
    Write-Host "winget could not install Node.js automatically." -ForegroundColor Yellow
    Start-Process "https://nodejs.org/en/download" | Out-Null
    Read-Host "Install Node.js 20.19+ or 22.12+, then press Enter"
  }
  Refresh-Path
  if (-not (Resolve-Node)) {
    Fail "A supported Node.js/npm installation was not found. Run manage.bat again after installing it."
  }
  Write-Host "Node.js is ready: $((& $script:NodeExe --version).Trim())" -ForegroundColor Green
}

function Get-CodexPlusPlusPath {
  $candidates = @(
    (Join-Path $env:LOCALAPPDATA "Programs\Codex++\codex-plus-plus-manager.exe"),
    (Join-Path ${env:ProgramFiles} "Codex++\codex-plus-plus-manager.exe"),
    (Join-Path ${env:ProgramFiles(x86)} "Codex++\codex-plus-plus-manager.exe")
  )
  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path -LiteralPath $candidate)) { return $candidate }
  }
  return $null
}

function Test-CodexInstalled {
  if (Get-AppxPackage -Name "OpenAI.Codex" -ErrorAction SilentlyContinue) { return $true }
  return [bool](Get-CodexPlusPlusPath)
}

function Ensure-Codex {
  $codexPlusPlus = Get-CodexPlusPlusPath
  if ($codexPlusPlus) {
    Write-Host "Codex++ (增强版 Codex Desktop) 已安装。" -ForegroundColor Green
    return
  }
  if (Test-CodexInstalled) {
    Write-Host "Codex Desktop is installed." -ForegroundColor Green
    return
  }
  Fail "Codex Desktop (ChatGPT) or Codex++ was not found. Install one first, then run manage.bat again."
}

function Invoke-Npm([string[]]$Arguments) {
  & $script:NpmCmd @Arguments
  if ($LASTEXITCODE -ne 0) { Fail "npm command failed: npm $($Arguments -join ' ')" }
}

function Ensure-Dependencies {
  if (Test-Path -LiteralPath $PackagedServer) {
    Write-Host "Bundled runtime dependencies are ready." -ForegroundColor Green
    return
  }

  $packageLock = Join-Path $Root "package-lock.json"
  $modules = Join-Path $Root "node_modules"
  $needsInstall = -not (Test-Path -LiteralPath $modules)
  if (-not $needsInstall -and (Test-Path -LiteralPath $packageLock)) {
    $needsInstall = (Get-Item -LiteralPath $packageLock).LastWriteTimeUtc -gt (Get-Item -LiteralPath $modules).LastWriteTimeUtc
  }
  if (-not $needsInstall) {
    Write-Host "npm dependencies are ready." -ForegroundColor Green
    return
  }

  Write-Step "Installing project dependencies"
  Invoke-Npm @("ci")
  Write-Host "Dependencies are ready." -ForegroundColor Green
}

function Ensure-Build {
  if (Test-Path -LiteralPath $PackagedServer) {
    Write-Host "Packaged production build is ready." -ForegroundColor Green
    return
  }

  $output = Join-Path $Root "dist\server\index.js"
  $needsBuild = -not (Test-Path -LiteralPath $output)
  if (-not $needsBuild) {
    $outputTime = (Get-Item -LiteralPath $output).LastWriteTimeUtc
    $sourceFiles = Get-ChildItem -LiteralPath (Join-Path $Root "src"), (Join-Path $Root "web"), (Join-Path $Root "vite.config.ts"), (Join-Path $Root "tsconfig.server.json") -Recurse -File -ErrorAction SilentlyContinue
    $needsBuild = [bool]($sourceFiles | Where-Object { $_.LastWriteTimeUtc -gt $outputTime } | Select-Object -First 1)
  }
  if (-not $needsBuild) {
    Write-Host "Production build is ready." -ForegroundColor Green
    return
  }

  Write-Step "Building the server and mobile web app"
  Invoke-Npm @("run", "build")
  Write-Host "Production build is ready." -ForegroundColor Green
}

function Test-Http([string]$Url) {
  try {
    $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop
    return ($response.StatusCode -ge 200 -and $response.StatusCode -lt 500)
  } catch {
    return $false
  }
}

function Wait-Http([string]$Url, [int]$Seconds = 30, [string]$Label = "服务") {
  $started = Get-Date
  $deadline = $started.AddSeconds($Seconds)
  $nextUpdate = $started.AddSeconds(10)
  while ((Get-Date) -lt $deadline) {
    if (Test-Http $Url) { return $true }
    if ((Get-Date) -ge $nextUpdate) {
      $elapsed = [int]((Get-Date) - $started).TotalSeconds
      Write-Host (T "$Label 仍在启动（已等待 $elapsed 秒）..." "$Label is still starting (waited $elapsed seconds)...") -ForegroundColor Yellow
      $nextUpdate = $nextUpdate.AddSeconds(10)
    }
    Start-Sleep -Seconds 1
  }
  return $false
}

function Test-CdpUrl([string]$Url) {
  if (-not $Url) { return $false }
  return (Test-Http "$Url/json/version")
}

function Find-CodexCdpUrl {
  if ($script:CdpUrl -and (Test-CdpUrl $script:CdpUrl)) { return $script:CdpUrl }
  if ($env:CODEX_CDP_URL -and (Test-CdpUrl $env:CODEX_CDP_URL)) { return $env:CODEX_CDP_URL }
  try {
    $chatgpt = Get-CimInstance Win32_Process -Filter "Name = 'ChatGPT.exe'" -ErrorAction Stop
    foreach ($process in $chatgpt) {
      if ($process.CommandLine -match '--remote-debugging-port=(\d+)') {
        $url = "http://127.0.0.1:$([int]$Matches[1])"
        if (Test-CdpUrl $url) { return $url }
      }
    }
  } catch {}
  $defaultUrl = "http://127.0.0.1:$CdpPort"
  if (Test-CdpUrl $defaultUrl) { return $defaultUrl }
  return $null
}

function Test-Cdp {
  return [bool](Find-CodexCdpUrl)
}

function Wait-Cdp([int]$Seconds = 120) {
  $started = Get-Date
  $deadline = $started.AddSeconds($Seconds)
  $nextUpdate = $started.AddSeconds(15)
  while ((Get-Date) -lt $deadline) {
    if (Test-Cdp) { return $true }
    if ((Get-Date) -ge $nextUpdate) {
      $elapsed = [int]((Get-Date) - $started).TotalSeconds
      Write-Host "Codex is still initializing ($elapsed seconds)..." -ForegroundColor Yellow
      $nextUpdate = $nextUpdate.AddSeconds(15)
    }
    Start-Sleep -Seconds 1
  }
  return $false
}

function Stop-BridgeServices {
  $ids = @()
  foreach ($file in @($BridgePidFile)) {
    if (Test-Path -LiteralPath $file) {
      $value = (Get-Content -LiteralPath $file -ErrorAction SilentlyContinue | Select-Object -First 1)
      if ($value -match '^\d+$') { $ids += [int]$value }
      Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue
    }
  }
  $connections = Get-NetTCPConnection -LocalPort $BridgePort -State Listen -ErrorAction SilentlyContinue
  $ids += @($connections | Select-Object -ExpandProperty OwningProcess)
  foreach ($id in ($ids | Select-Object -Unique)) {
    try { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue } catch {}
  }
}

function Start-CodexControl {
  if (Test-Cdp) {
    $script:CdpUrl = Find-CodexCdpUrl
    Write-Host (T "Codex 控制通道已在线：$script:CdpUrl" "Codex control channel is already online: $script:CdpUrl") -ForegroundColor Green
    return
  }
  Write-Step (T "启动 Codex Desktop（本地控制通道）" "Starting Codex Desktop (local control channel)")
  Write-Host (T "正在打开 Codex/Codex++。首次启动或首次创建配置时可能需要等待一两分钟。" "Opening Codex/Codex++. First launch or first-time setup may take a minute or two.") -ForegroundColor Yellow
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Root "scripts\start-codex-cdp.ps1")
  if ($LASTEXITCODE -ne 0 -or -not (Wait-Cdp 120)) {
    Fail (T "Codex 控制通道在 120 秒内没有就绪。请确认 Codex Desktop 或 Codex++ 已登录后重新运行 manage.bat。" "Codex control channel did not become ready within 120 seconds. Make sure Codex Desktop or Codex++ is signed in and run manage.bat again.")
  }
  $script:CdpUrl = Find-CodexCdpUrl
  Write-Host (T "Codex 控制通道已在线：$script:CdpUrl" "Codex control channel is online: $script:CdpUrl") -ForegroundColor Green
}

function Get-LanAddresses {
  try {
    return @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop |
      Where-Object { $_.IPAddress -notlike "127.*" -and $_.IPAddress -notlike "169.254.*" } |
      Select-Object -ExpandProperty IPAddress)
  } catch {
    return @()
  }
}

function Show-PairingInfo {
  $pairingCode = $null
  try {
    $info = Invoke-RestMethod -Uri "http://127.0.0.1:$BridgePort/api/pairing-info" -TimeoutSec 3
    if ($info.available -and $info.pairingCode -match '^[A-Z0-9]{8}$') {
      $pairingCode = $info.pairingCode
    }
  } catch {}

  if (-not $pairingCode -and (Test-Path -LiteralPath $BridgeOut)) {
    $text = Get-Content -LiteralPath $BridgeOut -Raw -Encoding UTF8 -ErrorAction SilentlyContinue
    $match = [regex]::Match($text, "(?:Pairing code[^:]*:|手机配对码[^：:]*[：:])\s*([A-Z0-9]{8})")
    if ($match.Success) {
      $pairingCode = $match.Groups[1].Value
    }
  }

  if ($pairingCode) {
    Write-Host (T "手机配对码：$pairingCode（有效期 10 分钟）" "Phone pairing code: $pairingCode (valid for 10 minutes)") -ForegroundColor Yellow
  } else {
    Write-Host (T "暂未读取到配对码，请在电脑端页面查看。日志：$BridgeOut" "Pairing code is not available yet. Check the computer page. Log: $BridgeOut") -ForegroundColor Yellow
  }
}

function Start-Bridge([string]$HostAddress = "0.0.0.0", [bool]$RequireCdp = $true) {
  Ensure-Dependencies
  Ensure-Build
  Stop-BridgeServices
  if (-not (Test-Path -LiteralPath $LogDir)) { New-Item -ItemType Directory -Path $LogDir | Out-Null }

  if (-not $env:CODEX_CDP_URL) {
    $script:CdpUrl = Find-CodexCdpUrl
    if ($script:CdpUrl) { $env:CODEX_CDP_URL = $script:CdpUrl }
  }
  $env:BRIDGE_HOST = $HostAddress
  $env:BRIDGE_PORT = "$BridgePort"
  $serverEntry = if (Test-Path -LiteralPath $PackagedServer) { "app/server.cjs" } else { "dist/server/index.js" }
  $process = Start-Process -FilePath $script:NodeExe -ArgumentList $serverEntry -WorkingDirectory $Root -RedirectStandardOutput $BridgeOut -RedirectStandardError $BridgeErr -WindowStyle Hidden -PassThru
  Set-Content -LiteralPath $BridgePidFile -Value $process.Id -Encoding ascii

  Write-Host (T "正在等待 Bridge 服务：http://127.0.0.1:$BridgePort ..." "Waiting for Bridge service: http://127.0.0.1:$BridgePort ...")
  if (-not (Wait-Http "http://127.0.0.1:$BridgePort/api/health" 30 (T "Bridge 服务" "Bridge service"))) {
    Write-Host (T "Bridge 启动失败，请查看：$BridgeErr" "Bridge failed to start. Check: $BridgeErr") -ForegroundColor Red
    Fail (T "Bridge 服务没有在 30 秒内就绪。" "Bridge did not become ready within 30 seconds.")
  }
  if ($RequireCdp -and -not (Test-Cdp)) {
    Stop-BridgeServices
    Fail (T "Bridge 已启动，但 Codex 控制通道离线。" "Bridge started, but the Codex control channel is offline.")
  }

  Write-Host ""
  Write-Host (T "Codex 远程桥接已启动。" "Codex remote bridge is running.") -ForegroundColor Green
  Write-Host (T "电脑端页面：http://127.0.0.1:$BridgePort/" "Computer page: http://127.0.0.1:$BridgePort/")
  if ($HostAddress -ne "127.0.0.1") {
    foreach ($address in (Get-LanAddresses | Select-Object -Unique)) {
      Write-Host (T "手机访问地址：http://$address`:$BridgePort/" "Phone URL: http://$address`:$BridgePort/")
    }
    Write-Host (T "请在电脑端页面查看二维码，用手机扫描后连接。" "Open the computer page and scan its QR code with your phone.") -ForegroundColor Yellow
    Show-PairingInfo
  }
  Start-Process "http://127.0.0.1:$BridgePort/" | Out-Null
}

function Install-DependenciesOnly {
  Ensure-Node
  Ensure-Dependencies
}

function Build-Only {
  Ensure-Node
  Ensure-Dependencies
  Ensure-Build
}

function Show-Status {
  Write-Host ""
  Write-Host "===== mCodex Status ====="
  if (Get-NetTCPConnection -LocalPort $BridgePort -State Listen -ErrorAction SilentlyContinue) {
    Write-Host "  [ONLINE]  Bridge :$BridgePort" -ForegroundColor Green
  } else {
    Write-Host "  [OFFLINE] Bridge :$BridgePort" -ForegroundColor Yellow
  }
  $cdpUrl = Find-CodexCdpUrl
  if ($cdpUrl) {
    Write-Host "  [ONLINE]  Codex control ($cdpUrl)" -ForegroundColor Green
  } else {
    Write-Host "  [OFFLINE] Codex control" -ForegroundColor Yellow
  }
  Write-Host "Logs: $LogDir"
}

function Show-Logs {
  Write-Host "===== Bridge output ====="
  if (Test-Path -LiteralPath $BridgeOut) { Get-Content -LiteralPath $BridgeOut -Tail 40 }
  Write-Host ""
  Write-Host "===== Bridge errors ====="
  if (Test-Path -LiteralPath $BridgeErr) { Get-Content -LiteralPath $BridgeErr -Tail 40 }
}

try {
  $interactive = [string]::IsNullOrWhiteSpace($Command)
  if ($interactive) { $Command = "start" }

  switch ($Command.ToLowerInvariant()) {
    "start" {
      Write-Host "mCodex setup" -ForegroundColor Cyan
      Ensure-Node
      Ensure-Codex
      Ensure-Dependencies
      Ensure-Build
      Start-CodexControl
      Start-Bridge "0.0.0.0" $true
    }
    "restart" { Ensure-Node; Ensure-Codex; Start-CodexControl; Start-Bridge "0.0.0.0" $true }
    "install" { Install-DependenciesOnly }
    "build" { Build-Only }
    "cdp" { Ensure-Node; Ensure-Codex; Start-CodexControl }
    "lan" { Ensure-Node; Start-Bridge "0.0.0.0" $false }
    "stop" { Stop-BridgeServices; Write-Host (T "Bridge 服务已停止。" "Bridge service stopped.") }
    "status" { Show-Status }
    "logs" { Show-Logs }
    "open" { Start-Process "http://127.0.0.1:$BridgePort/" | Out-Null }
    default {
      Write-Host (T "用法：manage.bat [start|restart|stop|status|install|build|cdp|lan|logs|open]" "Usage: manage.bat [start|restart|stop|status|install|build|cdp|lan|logs|open]")
      exit 2
    }
  }
  if ($interactive) {
    Write-Host ""
    Write-Host (T "启动完成。关闭此窗口后，服务仍会在后台运行。" "Startup complete. The service continues running after this window closes.")
    Read-Host (T "请记下上方配对码，按 Enter 关闭窗口" "Note the pairing code above, then press Enter to close this window")
  }
} catch {
  Write-Host ""
  Write-Host (T "错误：$($_.Exception.Message)" "Error: $($_.Exception.Message)") -ForegroundColor Red
  exit 1
}
