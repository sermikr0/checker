<#
  fleet-rdp.ps1 — opens the dashboard's RDP links on Windows with Remote Desktop (mstsc).

      fleet-rdp://connect?host=10.242.0.10[&user=Administrator&pass=...]

  saves the user name and password for that host in Windows Credential Manager
  (TERMSRV/<host>) and starts mstsc with dynamic resolution, without prompts.

  When the company has a password saved in the dashboard, the RDP button puts it
  in the link. Otherwise the user name and password kept on this computer are
  used: %APPDATA%\fleet-rdp\credential.xml, encrypted with Windows DPAPI for
  the current user. Set or change them with:

      powershell -ExecutionPolicy Bypass -File fleet-rdp.ps1 -Setup

  Links are checked: strict host pattern and private (RFC 1918) addresses only.
#>
param(
  [Parameter(Position = 0)][string]$Link,
  [switch]$Setup
)
$ErrorActionPreference = 'Stop'
$Dir = Join-Path $env:APPDATA 'fleet-rdp'
$CredFile = Join-Path $Dir 'credential.xml'

function Show-Message([string]$Text) {
  Add-Type -AssemblyName PresentationFramework
  [void][System.Windows.MessageBox]::Show($Text, 'Fleet RDP')
}

function Save-FleetCredential {
  New-Item -ItemType Directory -Force -Path $Dir | Out-Null
  $c = Get-Credential -UserName 'Administrator' -Message 'Fleet RDP: user name and password for every domain controller'
  if (-not $c) { exit 1 }
  $c | Export-Clixml -Path $CredFile   # DPAPI: only this Windows user can decrypt it
}

function Test-PrivateIPv4([System.Net.IPAddress]$Ip) {
  if ($Ip.AddressFamily -ne [System.Net.Sockets.AddressFamily]::InterNetwork) { return $false }
  $b = $Ip.GetAddressBytes()
  return ($b[0] -eq 10) -or ($b[0] -eq 172 -and $b[1] -ge 16 -and $b[1] -le 31) -or ($b[0] -eq 192 -and $b[1] -eq 168)
}

if ($Setup) { Save-FleetCredential; exit 0 }

try {
  $uri = [System.Uri]$Link
  if ($uri.Scheme -ne 'fleet-rdp') { throw 'not a fleet-rdp link' }
  $query = @{}
  foreach ($pair in $uri.Query.TrimStart('?').Split('&')) {
    if (-not $pair) { continue }
    $kv = $pair.Split('=', 2)
    $name = [System.Uri]::UnescapeDataString($kv[0].Replace('+', ' '))
    $query[$name] = if ($kv.Count -gt 1) { [System.Uri]::UnescapeDataString($kv[1].Replace('+', ' ')) } else { '' }
  }
  foreach ($k in $query.Keys) { if ($k -notin @('host', 'domain', 'user', 'pass')) { throw 'unexpected parameter' } }
  $target = [string]$query['host']
  if ($target -notmatch '^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$') { throw 'invalid host' }
  $addrs = [System.Net.Dns]::GetHostAddresses($target)
  if (-not $addrs -or ($addrs | Where-Object { -not (Test-PrivateIPv4 $_) })) { throw "only private addresses are allowed: $target" }
} catch {
  Show-Message "Fleet RDP: $($_.Exception.Message)"
  exit 1
}

$linkPass = [string]$query['pass']
if ($linkPass) {
  # Password saved for this company in the dashboard
  $user = if ($query['user']) { [string]$query['user'] } else { 'Administrator' }
  $pass = $linkPass
  if ($user -notmatch '^[A-Za-z0-9._@\\][A-Za-z0-9 ._@\\-]{0,103}$' -or $pass.Length -gt 256 -or $pass -match '[\x00-\x1f\x7f]') {
    Show-Message 'Fleet RDP: invalid user name or password in the link'
    exit 1
  }
} else {
  if (-not (Test-Path $CredFile)) { Save-FleetCredential }
  $cred = Import-Clixml -Path $CredFile
  $user = $cred.UserName
  $pass = $cred.GetNetworkCredential().Password
}

# Saved credential for this host, used by mstsc without asking.
& cmdkey.exe "/generic:TERMSRV/$target" "/user:$user" "/pass:$pass" | Out-Null

$rdp = Join-Path $env:TEMP ("fleet-rdp-" + $target + ".rdp")
@(
  "full address:s:$target",
  "username:s:$user",
  'prompt for credentials:i:0',
  'dynamic resolution:i:1',
  'screen mode id:i:1',
  'redirectclipboard:i:1',
  'authentication level:i:2'
) | Set-Content -Path $rdp -Encoding ASCII
Start-Process -FilePath "$env:WINDIR\System32\mstsc.exe" -ArgumentList "`"$rdp`""
