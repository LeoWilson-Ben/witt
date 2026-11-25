$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$agentDir = Join-Path $repoRoot "agent\windows"
$outDir = Join-Path $repoRoot "web\cli"
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

$outExe = Join-Path $outDir "chloe.exe"
$legacyExe = Join-Path $outDir "witt-cli.exe"
$sumsFile = Join-Path $outDir "SHA256SUMS.txt"

if (Test-Path $legacyExe) {
  Remove-Item -Force $legacyExe -ErrorAction SilentlyContinue
}

Push-Location $agentDir
try {
  $env:GOOS = "windows"
  $env:GOARCH = "amd64"
  $env:CGO_ENABLED = "0"
  Write-Host "Building chloe.exe..."
  & go build -trimpath -ldflags="-s -w" -o $outExe .
  if ($LASTEXITCODE -ne 0) { throw "go build failed" }
} finally {
  Pop-Location
}

$hash = (Get-FileHash -Algorithm SHA256 -Path $outExe).Hash.ToLowerInvariant()
"$hash  chloe.exe" | Set-Content -LiteralPath $sumsFile -Encoding ascii

Write-Host "Built: $outExe"
Write-Host "SHA256: $hash"
