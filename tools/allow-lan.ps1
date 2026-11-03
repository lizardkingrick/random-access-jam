<#
  One-time Windows setup so "serve.ps1 -Lan" (or -Public) can be reached from other devices
  on your network (phones, tablets, other PCs, a reverse proxy). Needs administrator rights;
  start.cmd -Lan runs it for you with a UAC prompt the first time.

  It does two things, both limited to one port:
    1. lets your (non-admin) account accept connections on all network interfaces on that port
    2. adds a Windows Firewall rule that lets in devices on your local subnet only (or only the
       addresses given with -RemoteAddress, e.g. your reverse proxy)

  Usage:  powershell -ExecutionPolicy Bypass -File tools\allow-lan.ps1 [-Port 8137]
          ... -RemoteAddress 10.0.0.2           (firewall: only this address or range may connect)
          ... -NoFirewall                       (proxy on this computer: no firewall opening at all)
          ... -Port 8137 -Remove                (undo)
#>
[CmdletBinding(PositionalBinding = $false)]
param(
  [int]$Port = 8137,
  [string]$RemoteAddress = 'LocalSubnet',
  [switch]$NoFirewall,
  [string]$Sid, # account allowed to listen (serve.ps1 passes its own, in case another admin approves)
  [switch]$Remove
)

$principal = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Host 'This needs administrator rights: right-click PowerShell > Run as administrator, or use start.cmd -Lan.' -ForegroundColor Red
  exit 1
}

$url = "http://+:$Port/"
$rule = "Dream Chamber Remixed (TCP $Port, local network)"

# Always clear old entries first, so running it twice is harmless.
netsh http delete urlacl url=$url | Out-Null
Get-NetFirewallRule -DisplayName $rule -ErrorAction SilentlyContinue | Remove-NetFirewallRule

if ($Remove) {
  Write-Host "Removed network access for port $Port." -ForegroundColor Green
  exit 0
}

# 1. URL reservation for one user only (by SID, so domain or local names and spaces don't matter).
if (-not $Sid) { $Sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value }
if ($Sid -notmatch '^S-1-[0-9-]+$') { Write-Host "'$Sid' is not a SID" -ForegroundColor Red; exit 1 }
$out = netsh http add urlacl url=$url "sddl=D:(A;;GX;;;$Sid)"
if ($LASTEXITCODE -ne 0) { Write-Host "Could not reserve $url : $out" -ForegroundColor Red; exit 1 }

# 2. Firewall: TCP on this port, from the local subnet (not the internet) or the given addresses.
if ($NoFirewall) {
  Write-Host "Port $Port reserved; no firewall opening (only this computer can connect). Undo with -Remove." -ForegroundColor Green
  exit 0
}
$remote = @($RemoteAddress -split '[,;\s]+' | Where-Object { $_ })
New-NetFirewallRule -DisplayName $rule -Direction Inbound -Protocol TCP -LocalPort $Port `
  -Action Allow -Profile Any -RemoteAddress $remote | Out-Null

Write-Host "Network access enabled on port $Port (from: $($remote -join ', ')). Undo with -Remove." -ForegroundColor Green
exit 0
