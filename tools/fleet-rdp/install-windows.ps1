<#
  Windows: registers the fleet-rdp:// link handler for the current user, so the
  dashboard's RDP button opens Remote Desktop (mstsc) with dynamic resolution,
  and asks once for the user name and password used on every domain controller.

  From a copy of the repository:
      powershell -ExecutionPolicy Bypass -File tools\fleet-rdp\install-windows.ps1
  Or from the fleet server (Settings -> Remote desktop shows this line):
      powershell -ExecutionPolicy Bypass -Command "$env:FLEET_SERVER='https://fleet.red1.uz'; irm https://fleet.red1.uz/tools/fleet-rdp/install-windows.ps1 | iex"
#>
$ErrorActionPreference = 'Stop'
$Server = if ($env:FLEET_SERVER) { $env:FLEET_SERVER.TrimEnd('/') } else { 'https://fleet.red1.uz' }
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
  $p = 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\CredentialsDelegation'
  New-Item -Path "$p\AllowSavedCredentialsWhenNTLMOnly" -Force | Out-Null
  New-ItemProperty -Path $p -Name 'AllowSavedCredentialsWhenNTLMOnly' -Value 1 -PropertyType DWord -Force | Out-Null
  New-ItemProperty -Path $p -Name 'ConcatenateDefaults_AllowSavedNTLMOnly' -Value 1 -PropertyType DWord -Force | Out-Null
  New-ItemProperty -Path "$p\AllowSavedCredentialsWhenNTLMOnly" -Name '1' -Value 'TERMSRV/*' -PropertyType String -Force | Out-Null
} else {
  Write-Host 'If Remote Desktop still asks for the password, run this installer once as administrator.'
}
Write-Host 'Done. Press RDP next to a company in the dashboard; the browser asks once to allow it.'
