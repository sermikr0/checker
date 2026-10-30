<#
  URL Fleet AD agent: runs on a company's domain controller.

  Every 5 minutes it sends the fleet server the domain's enabled computers:
  name, local IPv4 (from AD DNS), OS, and whether the computer answers right
  now (ping, or TCP 445/3389/135). New computers joined to the domain show up
  in the dashboard on their own. The agent only sends data: it never downloads
  or runs anything from the server.

  Install: PowerShell as administrator on the domain controller. The dashboard
  (company -> Computers -> "Set up AD agent") shows this line with the token:

    [Net.ServicePointManager]::SecurityProtocol='Tls12'; & ([scriptblock]::Create((irm https://fleet.red1.uz/tools/ad/fleet-ad.ps1))) -Install -Server https://fleet.red1.uz -Token fa_...

  -Install also sets up the "URL Fleet - Chrome" group policy for the domain:
    * the extension is force-installed with the fleet update URL, so every new
      version uploaded in the dashboard reaches all browsers on its own;
    * the extension gets the Windows computer name (computerName policy).
  Add -NoGpo to skip that. -Uninstall removes the task and the files.

  Files: C:\ProgramData\URLFleet (agent.json with the token, agent.log),
  readable by SYSTEM and Administrators only.
#>
param(
  [switch]$Install,
  [switch]$Uninstall,
  [switch]$NoGpo,
  [string]$Server,
  [string]$Token
)

$ErrorActionPreference = 'Stop'
$AgentVersion = '1.0'
$AppId = 'lddmakdihlenfbmdpggpahjooglgigoi'
$Dir = Join-Path $env:ProgramData 'URLFleet'
$ScriptPath = Join-Path $Dir 'fleet-ad.ps1'
$ConfigPath = Join-Path $Dir 'agent.json'
$LogPath = Join-Path $Dir 'agent.log'
$TaskName = 'URL Fleet AD agent'
$GpoName = 'URL Fleet - Chrome'

try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch {}

function Write-Log([string]$Text) {
  $line = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss') + '  ' + $Text
  try {
    $old = @()
    if (Test-Path $LogPath) { $old = @(Get-Content -Path $LogPath -Tail 300) }
    Set-Content -Path $LogPath -Value ($old + $line) -Encoding UTF8
  } catch {}
  Write-Host $line
}

# Which IPs answer right now: ping first, then TCP 445 / 3389 / 135 for the rest
# (Windows Firewall often drops ping). Everything runs in parallel.
function Test-Reachable([string[]]$Ips) {
  $up = @{}
  if (-not $Ips) { return $up }
  $pings = @{}
  foreach ($ip in $Ips) {
    try { $pings[$ip] = (New-Object System.Net.NetworkInformation.Ping).SendPingAsync($ip, 1000) } catch {}
  }
  if ($pings.Count) {
    try { [void][System.Threading.Tasks.Task]::WaitAll([System.Threading.Tasks.Task[]]@($pings.Values), 4000) } catch {}
    foreach ($ip in @($pings.Keys)) {
      $t = $pings[$ip]
      if ($t.Status -eq 'RanToCompletion' -and $t.Result.Status -eq 'Success') { $up[$ip] = $true }
    }
  }
  # TCP for the rest, 200 hosts (600 sockets) at a time
  $rest = @($Ips | Where-Object { -not $up.ContainsKey($_) } | Select-Object -Unique)
  for ($i = 0; $i -lt $rest.Count; $i += 200) {
    $conns = @()
    foreach ($ip in $rest[$i..([Math]::Min($i + 199, $rest.Count - 1))]) {
      foreach ($port in 445, 3389, 135) {
        try {
          $client = New-Object System.Net.Sockets.TcpClient
          $conns += , @($ip, $client, $client.ConnectAsync($ip, $port))
        } catch {}
      }
    }
    if ($conns.Count) {
      try { [void][System.Threading.Tasks.Task]::WaitAll([System.Threading.Tasks.Task[]]@($conns | ForEach-Object { $_[2] }), 3000) } catch {}
      foreach ($x in $conns) {
        if ($x[2].Status -eq 'RanToCompletion' -and $x[1].Connected) { $up[$x[0]] = $true }
        try { $x[1].Close() } catch {}
      }
    }
  }
  return $up
}

function Send-Report($Config, $Body) {
  $json = $Body | ConvertTo-Json -Depth 5 -Compress
  Invoke-RestMethod -Method Post -Uri ($Config.server.TrimEnd('/') + '/api/agent/report') `
    -Headers @{ Authorization = 'Bearer ' + $Config.token } -ContentType 'application/json; charset=utf-8' `
    -Body ([Text.Encoding]::UTF8.GetBytes($json)) -TimeoutSec 60
}

function Invoke-Report {
  if (-not (Test-Path $ConfigPath)) { throw "the agent is not installed ($ConfigPath is missing)" }
  $cfg = Get-Content -Path $ConfigPath -Raw | ConvertFrom-Json
  $body = @{ version = $AgentVersion; dc = $env:COMPUTERNAME }
  try {
    Import-Module ActiveDirectory -ErrorAction Stop
    $body.domain = (Get-ADDomain).DNSRoot
    $pcs = @(Get-ADComputer -Filter 'Enabled -eq $true' -Properties DNSHostName, IPv4Address, OperatingSystem, LastLogonDate)
    $up = Test-Reachable @($pcs | Where-Object { $_.IPv4Address } | ForEach-Object { [string]$_.IPv4Address })
    $body.computers = @($pcs | ForEach-Object {
        $ip = [string]$_.IPv4Address
        @{
          name      = [string]$_.Name
          ip        = $ip
          os        = [string]$_.OperatingSystem
          reachable = [bool]($ip -and $up.ContainsKey($ip))
          lastLogon = $(if ($_.LastLogonDate) { $_.LastLogonDate.ToUniversalTime().ToString('s') + 'Z' } else { '' })
        }
      })
  } catch {
    $body.error = 'AD query failed: ' + $_.Exception.Message
  }
  [void](Send-Report $cfg $body)
  if ($body.error) {
    Write-Log $body.error
  } else {
    Write-Log ('sent {0} computers, {1} answering' -f $body.computers.Count, @($body.computers | Where-Object { $_.reachable }).Count)
  }
}

# Group policy for the domain: force-install with the fleet update URL + computerName.
function Set-FleetGpo([string]$ServerUrl) {
  Import-Module GroupPolicy -ErrorAction Stop
  $domain = Get-ADDomain
  $gpo = Get-GPO -All | Where-Object { $_.DisplayName -eq $GpoName } | Select-Object -First 1
  if (-not $gpo) {
    $gpo = New-GPO -Name $GpoName -Comment 'URL Safety Checker extension: force-install from the fleet server, computerName policy.'
  }
  $linked = @((Get-GPInheritance -Target $domain.DistinguishedName).GpoLinks | Where-Object { $_.DisplayName -eq $GpoName })
  if (-not $linked) { New-GPLink -Guid $gpo.Id -Target $domain.DistinguishedName -LinkEnabled Yes | Out-Null }

  # 1) Force-install entry. A GPO that sets this list through the Chrome ADMX
  #    template replaces the whole list (lists do not merge across GPOs), so the
  #    entry goes into our GPO AND into every GPO that already sets the list;
  #    existing entries for this extension are pointed at the fleet update URL.
  $key = 'HKLM\Software\Policies\Google\Chrome\ExtensionInstallForcelist'
  $entry = "$AppId;$ServerUrl/update_manifest.xml"
  $used = @{}
  $lists = @{}          # GPO id -> @{ Gpo; Entries = @(@{ Name; Value }) }
  foreach ($g in Get-GPO -All) {
    $vals = @()
    try { $vals = @(Get-GPRegistryValue -Guid $g.Id -Key $key -ErrorAction Stop) } catch {}
    foreach ($v in $vals) {
      if (-not $v.ValueName) { continue }
      $used[[string]$v.ValueName] = $true
      if (-not $lists.ContainsKey($g.Id)) { $lists[$g.Id] = @{ Gpo = $g; Entries = @() } }
      $lists[$g.Id].Entries += , @{ Name = [string]$v.ValueName; Value = [string]$v.Value }
    }
  }
  if (-not $lists.ContainsKey($gpo.Id)) { $lists[$gpo.Id] = @{ Gpo = $gpo; Entries = @() } }
  $free = 1
  while ($used.ContainsKey([string]$free)) { $free++ }
  foreach ($l in $lists.Values) {
    $mine = @($l.Entries | Where-Object { $_.Value -like "$AppId;*" })
    if (-not $mine) {
      Set-GPRegistryValue -Guid $l.Gpo.Id -Key $key -ValueName ([string]$free) -Type String -Value $entry | Out-Null
      Write-Log ("force-install entry added to '{0}': {1}" -f $l.Gpo.DisplayName, $entry)
    }
    foreach ($m in $mine) {
      if ($m.Value -ne $entry) {
        Set-GPRegistryValue -Guid $l.Gpo.Id -Key $key -ValueName $m.Name -Type String -Value $entry | Out-Null
        Write-Log ("force-install entry in '{0}' now points to {1}" -f $l.Gpo.DisplayName, $entry)
      }
    }
  }

  # 2) The extension's computerName policy; Group Policy Preferences put each PC's own name in.
  $pkey = "HKLM\Software\Policies\Google\Chrome\3rdparty\extensions\$AppId\policy"
  try { Remove-GPPrefRegistryValue -Guid $gpo.Id -Context Computer -Key $pkey -ValueName 'computerName' -ErrorAction Stop | Out-Null } catch {}
  Set-GPPrefRegistryValue -Guid $gpo.Id -Context Computer -Action Update -Key $pkey -ValueName 'computerName' -Value '%ComputerName%' -Type String | Out-Null
  Write-Log ("group policy '{0}' is linked to {1}; computers apply it within about 90 minutes (gpupdate /force on a PC applies it now)" -f $GpoName, $domain.DNSRoot)
}

function Install-Agent {
  $me = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
  if (-not $me.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Run PowerShell as administrator.' }
  if ($Server -notmatch '^https://[A-Za-z0-9.-]+(:\d+)?/?$') { throw '-Server must look like https://fleet.example.com' }
  if ($Token -notmatch '^fa_[A-Za-z0-9_-]{20,80}$') { throw 'The token is missing or wrong: copy the command from the dashboard again.' }
  $url = $Server.TrimEnd('/')
  Import-Module ActiveDirectory -ErrorAction Stop

  New-Item -ItemType Directory -Force -Path $Dir | Out-Null
  & icacls.exe $Dir /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
  if ($PSCommandPath -and (Test-Path $PSCommandPath)) {
    if ($PSCommandPath -ne $ScriptPath) { Copy-Item -Path $PSCommandPath -Destination $ScriptPath -Force }
  } else {
    Invoke-WebRequest -UseBasicParsing -Uri "$url/tools/ad/fleet-ad.ps1" -OutFile $ScriptPath
  }
  @{ server = $url; token = $Token } | ConvertTo-Json | Set-Content -Path $ConfigPath -Encoding UTF8

  $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}"' -f $ScriptPath)
  $every5 = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration (New-TimeSpan -Days 3650)
  $boot = New-ScheduledTaskTrigger -AtStartup
  $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
  $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 4) -MultipleInstances IgnoreNew -StartWhenAvailable
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger @($every5, $boot) -Principal $principal -Settings $settings -Force | Out-Null
  Write-Log "scheduled task '$TaskName' runs every 5 minutes as SYSTEM"

  Invoke-Report
  if (-not $NoGpo) {
    try { Set-FleetGpo $url } catch { Write-Log ('group policy was not changed: ' + $_.Exception.Message) }
  }
  Write-Host ''
  Write-Host 'Done. The computers appear in the dashboard now; the list refreshes every 5 minutes.'
}

function Uninstall-Agent {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  Remove-Item -Recurse -Force -Path $Dir -ErrorAction SilentlyContinue
  Write-Host "Removed the task and $Dir. The '$GpoName' group policy stays; delete it in Group Policy Management if needed."
}

try {
  if ($Uninstall) { Uninstall-Agent }
  elseif ($Install) { Install-Agent }
  else { Invoke-Report }
} catch {
  Write-Log ('error: ' + $_.Exception.Message)
  if ($Install) { throw }
}
