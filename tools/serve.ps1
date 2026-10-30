<#
  Zero-install local server for Dream Chamber Remixed (Windows PowerShell 5.1+, no Node/ffmpeg).

  Serves the app, your WAV stems at /Stems/ and optional extras at /Extras/..., and lists
  them at /__local/files so the app builds its song list straight from the folders (no
  `npm run stems` step). By default only this computer can connect (it listens on localhost);
  with -Lan, devices on your local network can too.

  Usage:  powershell -ExecutionPolicy Bypass -File tools\serve.ps1 [-Port 8137] [-Stems <dir>] [-Extras <dir>] [-NoBrowser] [-Lan]
          (or double-click start.cmd)

  -Stems   folder holding <Song>/<Song> - <Groove|Lead|Texture|All> (<Key> <BPM>).wav
           (default: the first Stems folder found next to the app or up to 3 folders above it)
  -Extras  folder holding "Instrument Guns & Backing Tracks" and/or "Bonus/3D Helmets"
           (default: searched the same way; e.g. the unzipped "bonus" folder)
  -Lan     also accept other devices on your local network. Windows needs a one-time
           permission for that (tools\allow-lan.ps1, run for you with a UAC prompt).
#>
param(
  [int]$Port = 8137,
  [string]$Stems,
  [string]$Extras,
  [switch]$NoBrowser,
  [switch]$Lan
)

$ErrorActionPreference = 'Stop'
$AppRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$StemRe = '^(.*) - (Groove|Lead|Texture|All) \(([A-G][b#]?m?) (\d+(\.\d+)?)\)\.wav$'

# ---------- find the media folders ----------
function Get-SearchRoots {
  $roots = @()
  $d = Get-Item -LiteralPath $AppRoot
  for ($i = 0; $i -le 3 -and $d; $i++) { $roots += $d.FullName; $d = $d.Parent }
  $roots
}

function Test-StemsDir([string]$dir) {
  if (-not $dir -or -not (Test-Path -LiteralPath $dir -PathType Container)) { return $false }
  foreach ($song in Get-ChildItem -LiteralPath $dir -Directory -ErrorAction SilentlyContinue) {
    foreach ($f in Get-ChildItem -LiteralPath $song.FullName -File -Filter *.wav -ErrorAction SilentlyContinue) {
      if ($f.Name -match $StemRe) { return $true }
    }
  }
  return $false
}

function Find-StemsDir {
  foreach ($r in Get-SearchRoots) {
    foreach ($rel in 'Stems\Stems', 'Stems', 'bonus\Stems', 'Bonus\Stems') {
      $p = Join-Path $r $rel
      if (Test-StemsDir $p) { return (Resolve-Path -LiteralPath $p).Path }
    }
  }
  return $null
}

# Returns the first existing "<root>\<rel>" for the given relative names.
function Find-Under([string[]]$roots, [string[]]$rels) {
  foreach ($r in $roots) {
    foreach ($rel in $rels) {
      $p = Join-Path $r $rel
      if (Test-Path -LiteralPath $p -PathType Container) { return (Resolve-Path -LiteralPath $p).Path }
    }
  }
  return $null
}

if ($Stems) {
  # Accept the folder above, too: rips often unzip as Stems\Stems\<Song>.
  $nested = Join-Path $Stems 'Stems'
  if (Test-StemsDir $Stems) { $Stems = (Resolve-Path -LiteralPath $Stems).Path }
  elseif (Test-StemsDir $nested) { $Stems = (Resolve-Path -LiteralPath $nested).Path }
  else { Write-Warning "No stems found in '$Stems' - expected <Song>\<Song> - Groove (Gbm 116).wav"; $Stems = $null }
} else { $Stems = Find-StemsDir }

# Extras are optional: a missing folder only means no guns page and no helmets.
$extraRoots = Get-SearchRoots
if ($Extras) {
  if (Test-Path -LiteralPath $Extras -PathType Container) { $extraRoots = @((Resolve-Path -LiteralPath $Extras).Path) }
  else { Write-Warning "Extras folder '$Extras' not found - carrying on without it" }
}
$GunsDir    = Find-Under $extraRoots @('Instrument Guns & Backing Tracks', 'bonus\Instrument Guns & Backing Tracks')
$HelmetsDir = Find-Under $extraRoots @('Bonus\3D Helmets', 'bonus\Bonus\3D Helmets', '3D Helmets')

# URL prefix -> folder on disk. The app itself is served from "/".
$Mounts = [ordered]@{}
if ($Stems -and (Test-Path -LiteralPath $Stems)) { $Mounts['/Stems/'] = $Stems }
if ($GunsDir)    { $Mounts['/Extras/Guns/'] = $GunsDir }
if ($HelmetsDir) { $Mounts['/Extras/Helmets/'] = $HelmetsDir }

# Relative paths are built from the names themselves (not by trimming FullName), so a folder
# given as an 8.3 short path ("LOCALA~1") can't throw the offsets off.
function Get-Listing([string]$dir, [string[]]$exts, [string]$prefix = '') {
  if (-not $dir) { return @() }
  $out = @()
  foreach ($item in Get-ChildItem -LiteralPath $dir -ErrorAction SilentlyContinue | Sort-Object Name) {
    if ($item.PSIsContainer) { foreach ($sub in Get-Listing $item.FullName $exts ($prefix + $item.Name + '/')) { $out += $sub } }
    elseif ($exts -contains $item.Extension.ToLowerInvariant()) { $out += $prefix + $item.Name }
  }
  $out
}

function Get-LocalFilesJson {
  $o = [ordered]@{
    server  = 'serve.ps1'
    stems   = @(Get-Listing $Mounts['/Stems/'] @('.wav', '.ogg', '.flac'))
    guns    = @(Get-Listing $Mounts['/Extras/Guns/'] @('.wav', '.ogg', '.flac'))
    helmets = @(Get-Listing $Mounts['/Extras/Helmets/'] @('.obj'))
    mounts  = [ordered]@{ stems = 'Stems/'; guns = 'Extras/Guns/'; helmets = 'Extras/Helmets/' }
  }
  ConvertTo-Json -InputObject $o -Depth 5 -Compress
}

# ---------- HTTP ----------
$Types = @{
  '.html' = 'text/html; charset=utf-8'; '.js' = 'text/javascript; charset=utf-8'; '.mjs' = 'text/javascript; charset=utf-8'
  '.css' = 'text/css; charset=utf-8'; '.json' = 'application/json; charset=utf-8'; '.svg' = 'image/svg+xml'
  '.png' = 'image/png'; '.jpg' = 'image/jpeg'; '.jpeg' = 'image/jpeg'; '.ico' = 'image/x-icon'; '.webmanifest' = 'application/manifest+json'
  '.wav' = 'audio/wav'; '.ogg' = 'audio/ogg'; '.flac' = 'audio/flac'; '.mp3' = 'audio/mpeg'
  '.obj' = 'text/plain; charset=utf-8'; '.md' = 'text/plain; charset=utf-8'; '.txt' = 'text/plain; charset=utf-8'
}

function Send-Bytes($res, [int]$code, [string]$type, [byte[]]$bytes) {
  $res.StatusCode = $code
  $res.ContentType = $type
  $res.Headers['Cache-Control'] = 'no-cache'
  $res.ContentLength64 = $bytes.Length
  if ($script:method -ne 'HEAD') { $res.OutputStream.Write($bytes, 0, $bytes.Length) } # HEAD: headers only
}
function Send-Text($res, [int]$code, [string]$text, [string]$type = 'text/plain; charset=utf-8') {
  Send-Bytes $res $code $type ([Text.Encoding]::UTF8.GetBytes($text))
}

# Maps a URL path to a file, refusing anything that escapes its folder.
function Resolve-RequestPath([string]$urlPath) {
  $root = $AppRoot; $rel = $urlPath.TrimStart('/')
  foreach ($prefix in $Mounts.Keys) {
    if ($urlPath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { $root = $Mounts[$prefix]; $rel = $urlPath.Substring($prefix.Length); break }
  }
  if ($rel -eq '' -or $rel.EndsWith('/')) { $rel += 'index.html' }
  # '~' would allow 8.3 short names (GIT~1 = .git) past the checks below; no real file needs it.
  if ($rel.Contains('~')) { return $null }
  $full = [IO.Path]::GetFullPath((Join-Path $root ($rel.Replace('/', '\'))))
  $rootFull = [IO.Path]::GetFullPath($root).TrimEnd('\') + '\'
  if (-not $full.StartsWith($rootFull, [StringComparison]::OrdinalIgnoreCase)) { return $null }
  # Never serve the repo's private bits (checked on the resolved path, segment by segment).
  if ($root -eq $AppRoot) {
    foreach ($seg in $full.Substring($rootFull.Length).Split('\')) {
      if ($seg.TrimEnd('.', ' ') -match '^(\.git|node_modules|\.claude|\.wrangler)$') { return $null }
    }
  }
  return $full
}

function Invoke-Request($ctx) {
  $req = $ctx.Request; $res = $ctx.Response
  $script:method = $req.HttpMethod
  # Decode the raw target exactly once: Url.AbsolutePath is already decoded (a '#' or '%' in a
  # file name would be cut off or decoded twice).
  $path = [Uri]::UnescapeDataString($req.RawUrl.Split('?')[0])
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $status = 200
  try {
    if ($req.HttpMethod -ne 'GET' -and $req.HttpMethod -ne 'HEAD') { $status = 405; Send-Text $res 405 'method not allowed'; return }
    if ($path -eq '/__local/files') { Send-Text $res 200 (Get-LocalFilesJson) 'application/json; charset=utf-8'; return }
    $file = Resolve-RequestPath $path
    if (-not $file) { $status = 403; Send-Text $res 403 'forbidden'; return }
    if (Test-Path -LiteralPath $file -PathType Container) {
      $status = 302; $res.StatusCode = 302; $res.RedirectLocation = $path.TrimEnd('/') + '/'; return
    }
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { $status = 404; Send-Text $res 404 "not found: $path"; return }
    $ext = [IO.Path]::GetExtension($file).ToLowerInvariant()
    $type = $Types[$ext]; if (-not $type) { $type = 'application/octet-stream' }
    $fs = [IO.File]::Open($file, 'Open', 'Read', 'ReadWrite')
    try {
      $res.StatusCode = 200
      $res.ContentType = $type
      $res.Headers['Cache-Control'] = 'no-cache'
      $res.ContentLength64 = $fs.Length
      if ($req.HttpMethod -eq 'GET') { $fs.CopyTo($res.OutputStream, 1MB) }
    } finally { $fs.Dispose() }
  } catch {
    $status = 500
    # The browser may hang up mid-file (e.g. a reload); that's fine.
    try { Send-Text $res 500 $_.Exception.Message } catch { }
  } finally {
    try { $res.Close() } catch { }
    if ($status -ne 200 -or $path -match '\.(wav|ogg|flac|obj)$' -or $path -eq '/__local/files') {
      Write-Host ('{0} {1} {2} ({3} ms)' -f $status, $req.HttpMethod, $path, $sw.ElapsedMilliseconds) -ForegroundColor DarkGray
    }
  }
}

# ---------- start ----------
$listener = $null
for ($p = $Port; $p -lt $Port + 10; $p++) {
  try {
    $l = New-Object Net.HttpListener
    $l.Prefixes.Add("http://localhost:$p/")
    $l.Start()
    $listener = $l; $Port = $p; break
  } catch { }
}
if (-not $listener) { Write-Host "Could not open a port between $Port and $($Port + 9)." -ForegroundColor Red; exit 1 }

# LAN mode: listen on every interface. Windows only allows that for a reserved URL, so the first
# time we ask for the one-time setup (UAC prompt); if that's declined we stay local-only.
function Start-LanListener([int]$p) {
  $l = New-Object Net.HttpListener
  $l.Prefixes.Add("http://+:$p/")
  $l.Start()
  return $l
}
$lanOn = $false
if ($Lan) {
  $listener.Stop(); $listener.Close() # free the port for the all-interfaces listener
  try { $listener = Start-LanListener $Port; $lanOn = $true } catch {
    Write-Host ''
    Write-Host "  LAN access needs a one-time Windows permission for port $Port." -ForegroundColor Yellow
    Write-Host '  Approve the administrator prompt to allow devices on your local network (only) to connect.' -ForegroundColor Yellow
    try {
      $setup = Join-Path $PSScriptRoot 'allow-lan.ps1'
      Start-Process powershell -Verb RunAs -Wait -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$setup`"", '-Port', $Port)
    } catch { } # prompt declined
    try { $listener = Start-LanListener $Port; $lanOn = $true } catch { }
  }
  if (-not $lanOn) {
    Write-Host '  LAN access is not set up - running for this computer only.' -ForegroundColor Yellow
    $listener = New-Object Net.HttpListener
    $listener.Prefixes.Add("http://localhost:$Port/")
    $listener.Start()
  }
}

$url = "http://localhost:$Port/"
Write-Host ''
Write-Host '  Dream Chamber Remixed - local server' -ForegroundColor Cyan
Write-Host "  App:     $AppRoot"
if ($Mounts['/Stems/']) {
  Write-Host "  Stems:   $($Mounts['/Stems/'])"
} else {
  Write-Host '  Stems:   NOT FOUND - pass -Stems <folder> (expects <Song>\<Song> - Groove (Gbm 116).wav)' -ForegroundColor Yellow
}
if ($GunsDir)    { Write-Host "  Guns:    $GunsDir" }
if ($HelmetsDir) { Write-Host "  Helmets: $HelmetsDir" }
Write-Host ''
Write-Host "  Open $url  (Ctrl+C or close this window to stop)" -ForegroundColor Green
if ($lanOn) {
  # Other devices use this computer's network address. VPN adapters are listed too; use the
  # address on the same network as the phone or PC you're connecting from.
  $addrs = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' -and $_.AddressState -eq 'Preferred' })
  foreach ($a in $addrs) { Write-Host ("  On your network: http://{0}:{1}/   ({2})" -f $a.IPAddress, $Port, $a.InterfaceAlias) -ForegroundColor Green }
}
Write-Host ''
if (-not $NoBrowser) { Start-Process $url }

try {
  while ($listener.IsListening) {
    $pending = $listener.BeginGetContext($null, $null)
    # Wake up regularly so Ctrl+C can stop the server.
    while (-not $pending.AsyncWaitHandle.WaitOne(250)) { }
    $ctx = $null
    try { $ctx = $listener.EndGetContext($pending) } catch { continue }
    Invoke-Request $ctx
  }
} finally {
  $listener.Stop()
  $listener.Close()
}
