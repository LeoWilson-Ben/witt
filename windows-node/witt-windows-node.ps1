# Compatible with built-in Windows PowerShell 5.1. Run once with -Pair to enroll, then rerun without -Pair.
[CmdletBinding()]
param(
  [switch]$Pair,
  [string]$WorkDir = $PSScriptRoot,
  [string]$ServerUrl = 'https://16-208-77-185.sslip.io/vault-api',
  [string]$Label = $env:COMPUTERNAME,
  [string]$ConfigPath = "$env:LOCALAPPDATA\Witt\node.json",
  [int]$PollSeconds = 3
)
$ErrorActionPreference='Stop'
if(!(Test-Path -LiteralPath $WorkDir -PathType Container)){throw 'Working directory does not exist'}
Set-Location -LiteralPath $WorkDir
function Save-Config($Value){ New-Item -ItemType Directory -Force (Split-Path $ConfigPath) | Out-Null; $Value | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $ConfigPath -Encoding utf8; & "$env:SystemRoot\System32\icacls.exe" $ConfigPath /inheritance:r /grant:r "$($env:USERDOMAIN)\$($env:USERNAME):(R,W)" | Out-Null; if($LASTEXITCODE -ne 0){throw 'Unable to restrict node configuration permissions'} }
function Api($Base,$Path,$Headers,$Body=$null){ $args=@{Method='Post';Uri=($Base.TrimEnd('/')+$Path);Headers=$Headers;UseBasicParsing=$true;TimeoutSec=30};if($null -ne $Body){$args.ContentType='application/json';$args.Body=($Body|ConvertTo-Json -Compress -Depth 8)};try{$r=Invoke-WebRequest @args;if(!$r.Content){return $null};return $r.Content|ConvertFrom-Json}catch{if($_.Exception.Response -and [int]$_.Exception.Response.StatusCode -eq 204){return $null};throw} }
function Unseal($Payload,$Password){
  if($Payload.version -ne 1){throw 'Unsupported encrypted configuration version'}
  $keys=[Security.Cryptography.SHA512]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($Password))
  $iv=[Convert]::FromBase64String($Payload.iv);$ciphertext=[Convert]::FromBase64String($Payload.data);$expected=[Convert]::FromBase64String($Payload.mac)
  $mac=New-Object Security.Cryptography.HMACSHA256;$mac.Key=[byte[]]$keys[32..63];$combined=New-Object byte[] ($iv.Length+$ciphertext.Length);[Array]::Copy($iv,0,$combined,0,$iv.Length);[Array]::Copy($ciphertext,0,$combined,$iv.Length,$ciphertext.Length);$actual=$mac.ComputeHash($combined);$valid=($actual.Length -eq $expected.Length)
  for($index=0;$index -lt $actual.Length;$index++){if($actual[$index] -ne $expected[$index]){$valid=$false}}
  if(!$valid){throw 'Node configuration integrity check failed'}
  $aes=New-Object Security.Cryptography.AesManaged;$aes.Key=[byte[]]$keys[0..31];$aes.IV=$iv;$aes.Mode=[Security.Cryptography.CipherMode]::CBC;$aes.Padding=[Security.Cryptography.PaddingMode]::PKCS7
  $decryptor=$aes.CreateDecryptor();$plain=$decryptor.TransformFinalBlock($ciphertext,0,$ciphertext.Length);$decryptor.Dispose();$aes.Dispose();[Text.Encoding]::UTF8.GetString($plain)
}
function Get-WgExe { $paths=@("$env:ProgramFiles\WireGuard\wg.exe","$env:ProgramFiles\WireGuard\wg.exe"); foreach($item in $paths){if(Test-Path $item){return $item}};throw 'WireGuard for Windows was not found. Install it first.' }
function Pair-Node {
  $wg=Get-WgExe; $pairingToken=Read-Host 'Paste the one-time pairing key from the Witt phone page';$pairingToken=$pairingToken.Trim(); if(!$pairingToken){throw 'Pairing key cannot be empty'}
  $private=& $wg genkey; $public=$private | & $wg pubkey
  $response=Api $ServerUrl '/windows-nodes/claim' @{} @{pairingToken=$pairingToken;wireguardPublicKey=$public.Trim()}
  $node=$response.node; $vpn=$response.wireguard
  $config="[Interface]`nPrivateKey = $($private.Trim())`nAddress = $($vpn.address)`n`n[Peer]`nPublicKey = $($vpn.serverPublicKey)`nAllowedIPs = 10.88.0.0/24`nEndpoint = $($vpn.endpoint)`nPersistentKeepalive = 25`n"
  $tunnel="Witt-$($node.id)"; $conf=Join-Path $env:TEMP "$tunnel.conf";Set-Content -LiteralPath $conf -Value $config -Encoding ascii
  try {
    & "$env:ProgramFiles\WireGuard\wireguard.exe" /installtunnelservice $conf
    if($LASTEXITCODE -ne 0){throw 'WireGuard tunnel installation failed. Run as Administrator.'}
  } finally {Remove-Item -Force $conf}
  $result=@{nodeId=$node.id;token=$pairingToken;privateApi='http://10.88.0.1:3004';serverUrl=$ServerUrl;label=$node.label;stellarbit=$null}; Save-Config $result
  $headers=@{Authorization="Bearer $pairingToken";'X-Witt-Node-Id'=$node.id};$boot=$null
  Write-Host 'Waiting for the WireGuard private connection...'
  for($attempt=0;$attempt -lt 30;$attempt++){
    try {$boot=Api $result.privateApi '/windows-nodes/agent/bootstrap' $headers;break} catch {Start-Sleep 2}
  }
  if(!$boot){throw 'Private connection failed. Configuration was saved. Check WireGuard, then start the script again.'}
  $result.stellarbit=Unseal $boot.stellarbit $pairingToken;Save-Config $result
  Write-Host "Windows node paired: $($node.label). Run codex login and agy login if needed."
}
function Run-Task($Task,$Config){
  if($Task.provider -eq 'stellarbit'){$s=$Config.stellarbit|ConvertFrom-Json;$body=@{model=($Task.model -replace '^stellarbit:','');messages=@(@{role='user';content=$Task.prompt})};$response=Invoke-RestMethod -Method Post -Uri $s.apiUrl -Headers @{Authorization="Bearer $($s.apiKey)"} -ContentType 'application/json' -Body ($body|ConvertTo-Json -Compress);return [string]$response.choices[0].message.content}
  if($Task.provider -eq 'codex'){ $args=@('exec','--json','--full-auto');if($Task.model){$args+=@('--model',$Task.model)};$args+=$Task.prompt;$output=(& codex @args 2>&1 | Out-String);if($LASTEXITCODE -ne 0){throw 'Codex failed. Check local installation, login and working directory.'};return $output }
  if($Task.provider -eq 'antigravity'){ $args=@('--input-format','stream-json','--output-format','stream-json','--log-file','NUL');if($Task.model){$args+=@('--model',$Task.model)};$event=@{event='user';message=@{content=$Task.prompt}}|ConvertTo-Json -Compress;$output=($event | & agy @args 2>&1 | Out-String);if($LASTEXITCODE -ne 0){throw 'Antigravity failed. Check local installation and login.'};return $output }
  throw 'Unknown model provider'
}
if($Pair){Pair-Node;exit}
if(!(Test-Path $ConfigPath)){throw 'Not paired. Create a pairing key in Witt, then run this script with -Pair.'}
$config=Get-Content -Raw $ConfigPath|ConvertFrom-Json;$headers=@{Authorization="Bearer $config.token";'X-Witt-Node-Id'=$config.nodeId};
if(!$config.stellarbit){
  $boot=Api $config.privateApi '/windows-nodes/agent/bootstrap' $headers
  $config.stellarbit=Unseal $boot.stellarbit $config.token;Save-Config $config
}
Write-Host "Witt Windows node started: $($config.label)"

while($true){try{$next=Api $config.privateApi '/windows-nodes/agent/next' $headers;if(!$next){Start-Sleep $PollSeconds;continue};$task=$next.task;try{$text=Run-Task $task $config;Api $config.privateApi "/windows-nodes/agent/tasks/$($task.id)" $headers @{text=$text}|Out-Null}catch{Api $config.privateApi "/windows-nodes/agent/tasks/$($task.id)" $headers @{error=$_.Exception.Message}|Out-Null}}catch{Write-Warning 'Node communication failed. Check WireGuard and server availability. Retrying...';Start-Sleep ([Math]::Max(3,$PollSeconds))}}
