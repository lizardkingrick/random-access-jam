<#
  One-time Windows setup so "serve.ps1 -Lan" can be reached from other devices on your network
  (phones, tablets, other PCs). Needs administrator rights; start.cmd -Lan runs it for you with
  a UAC prompt the first time.

  It does two things, both limited to one port:
    1. lets your (non-admin) account accept connections on all network interfaces on that port
    2. adds a Windows Firewall rule that lets in devices on your local subnet only

  Usage:  powershell -ExecutionPolicy Bypass -File tools\allow-lan.ps1 [-Port 8137]
          powershell -ExecutionPolicy Bypass -File tools\allow-lan.ps1 -Port 8137 -Remove   (undo)
#>
param(
  [int]$Port = 8137,
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
  Write-Host "Removed LAN access for port $Port." -ForegroundColor Green
  exit 0
}

# 1. URL reservation for this user only (by SID, so domain or local names and spaces don't matter).
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$out = netsh http add urlacl url=$url "sddl=D:(A;;GX;;;$sid)"
if ($LASTEXITCODE -ne 0) { Write-Host "Could not reserve $url : $out" -ForegroundColor Red; exit 1 }

# 2. Firewall: TCP on this port, from addresses on the same subnet only (not the internet).
New-NetFirewallRule -DisplayName $rule -Direction Inbound -Protocol TCP -LocalPort $Port `
  -Action Allow -Profile Any -RemoteAddress LocalSubnet | Out-Null

Write-Host "LAN access enabled on port $Port (local network only). Undo with -Remove." -ForegroundColor Green
exit 0
