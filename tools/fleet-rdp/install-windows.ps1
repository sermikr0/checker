<#
  Windows: registers the fleet-rdp:// link handler for the current user, so the
  dashboard's RDP button opens Remote Desktop (mstsc) with dynamic resolution,
  and asks once for a fallback user name and password (companies without a
  password saved in the dashboard).

  From a copy of the repository:
      powershell -ExecutionPolicy Bypass -File tools\fleet-rdp\install-windows.ps1 -Server https://fleet.red1.uz
  From the fleet server (Settings -> Remote desktop shows this line; works in cmd and PowerShell):
      powershell -ExecutionPolicy Bypass -Command "& ([scriptblock]::Create((irm https://fleet.red1.uz/tools/fleet-rdp/install-windows.ps1))) -Server https://fleet.red1.uz"
#>
param([string]$Server = $(if ($env:FLEET_SERVER) { $env:FLEET_SERVER } else { 'https://fleet.red1.uz' }))
$ErrorActionPreference = 'Stop'
$Server = $Server.TrimEnd('/')
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch {}
$Dir = Join-Path $env:LOCALAPPDATA 'fleet-rdp'
$Script = Join-Path $Dir 'fleet-rdp.ps1'
New-Item -ItemType Directory -Force -Path $Dir | Out-Null

$local = if ($PSScriptRoot) { Join-Path $PSScriptRoot 'fleet-rdp.ps1' } else { '' }
if ($local -and (Test-Path $local)) {
  Copy-Item -Path $local -Destination $Script -Force
} else {
  Invoke-WebRequest -UseBasicParsing -Uri "$Server/tools/fleet-rdp/fleet-rdp.ps1" -OutFile $Script
}

# fleet-rdp:// protocol for this user (no administrator rights needed)
$key = 'HKCU:\Software\Classes\fleet-rdp'
New-Item -Path $key -Force | Out-Null
Set-Item -Path $key -Value 'URL:Fleet RDP'
New-ItemProperty -Path $key -Name 'URL Protocol' -Value '' -PropertyType String -Force | Out-Null
New-Item -Path "$key\shell\open\command" -Force | Out-Null
Set-Item -Path "$key\shell\open\command" -Value ("powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$Script`" `"%1`"")

# Fallback user name + password for companies without a password saved in the
# dashboard, stored only on this computer (DPAPI). Cancel the window to skip.
Write-Host 'Companies with a password in the dashboard need nothing more. For the others, enter a user name and password (or cancel).'
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $Script -Setup

# Saved credentials for RDP to an IP address use NTLM; Windows only accepts
# them when this policy allows TERMSRV/*. It needs administrator rights.
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if ($isAdmin) {
  # Keep entries that are already there (New-Item -Force would delete the key tree).
  $p = 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\CredentialsDelegation'
  $list = "$p\AllowSavedCredentialsWhenNTLMOnly"
  if (-not (Test-Path $list)) { New-Item -Path $list -Force | Out-Null }
  New-ItemProperty -Path $p -Name 'AllowSavedCredentialsWhenNTLMOnly' -Value 1 -PropertyType DWord -Force | Out-Null
  New-ItemProperty -Path $p -Name 'ConcatenateDefaults_AllowSavedNTLMOnly' -Value 1 -PropertyType DWord -Force | Out-Null
  $item = Get-Item -Path $list
  $values = @($item.GetValueNames() | ForEach-Object { [string]$item.GetValue($_) })
  if ($values -notcontains 'TERMSRV/*') {
    $n = 1
    while ($item.GetValueNames() -contains [string]$n) { $n++ }
    New-ItemProperty -Path $list -Name ([string]$n) -Value 'TERMSRV/*' -PropertyType String | Out-Null
  }
} else {
  Write-Host 'If Remote Desktop still asks for the password, run this installer once as administrator.'
}
Write-Host 'Done. Press RDP next to a company in the dashboard; the browser asks once to allow it.'
