$ErrorActionPreference = "Stop"

$baseUrl = $env:WITT_CLI_BASE_URL
if ([string]::IsNullOrWhiteSpace($baseUrl)) {
  $baseUrl = "https://13-208-127-58.sslip.io/vault/cli"
}
$baseUrl = $baseUrl.TrimEnd("/")

$installDir = Join-Path $env:LOCALAPPDATA "Witt\bin"
New-Item -ItemType Directory -Force -Path $installDir | Out-Null

$exePath = Join-Path $installDir "chloe.exe"
$legacyPath = Join-Path $installDir "witt-cli.exe"
$tmpExe = "$exePath.download"
$sumsUrl = "$baseUrl/SHA256SUMS.txt"
$exeUrl = "$baseUrl/chloe.exe"

Write-Host "正在下载 Chloe Remote CLI..." -ForegroundColor Cyan
try {
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 -bor [Net.SecurityProtocolType]::SecurityProtocol
} catch {}

Invoke-WebRequest -UseBasicParsing -Uri $exeUrl -OutFile $tmpExe

$expectedHash = $null
try {
  $sumsContent = (Invoke-WebRequest -UseBasicParsing -Uri $sumsUrl).Content
  foreach ($line in ($sumsContent -split "`r?`n")) {
    if ($line -match "^([A-Fa-f0-9]{64})\s+\*?chloe\.exe$") {
      $expectedHash = $Matches[1].ToLowerInvariant()
      break
    }
  }
} catch {
  Write-Warning "未能获取 SHA256SUMS.txt，跳过校验"
}

if ($expectedHash) {
  $actualHash = (Get-FileHash -Algorithm SHA256 -Path $tmpExe).Hash.ToLowerInvariant()
  if ($actualHash -ne $expectedHash) {
    Remove-Item -Force $tmpExe -ErrorAction SilentlyContinue
    throw "SHA-256 校验失败: 期望 $expectedHash，实际 $actualHash"
  }
  Write-Host "SHA-256 校验通过: $actualHash" -ForegroundColor Green
}

Move-Item -Force $tmpExe $exePath
if (Test-Path $legacyPath) {
  Remove-Item -Force $legacyPath -ErrorAction SilentlyContinue
}

$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
$parts = @()
if ($userPath) { $parts = $userPath -split ";" | Where-Object { $_ -and ($_.Trim() -ne "") } }
if ($parts -notcontains $installDir) {
  $newUserPath = (@($parts) + $installDir) -join ";"
  [Environment]::SetEnvironmentVariable("Path", $newUserPath, "User")
}
if (($env:Path -split ";") -notcontains $installDir) {
  $env:Path = "$installDir;$env:Path"
}

Write-Host ""
Write-Host "安装完成: $exePath" -ForegroundColor Green
Write-Host "已自动配置用户级 PATH，无需手动设置环境变量。" -ForegroundColor Green
Write-Host "现在直接输入 chloe 即可打开，按提示输入协助码即可连接（若其他已打开的终端提示找不到命令，重开该终端即可生效）。" -ForegroundColor Yellow
