<#
  Zero-install server for Dream Chamber Remixed (Windows PowerShell 5.1+, no Node/ffmpeg).

  Serves the app, your WAV stems at /Stems/ and optional extras at /Extras/..., and lists
  them at /__local/files so the app builds its song list straight from the folders (no
  `npm run stems` step). By default only this computer can connect (it listens on localhost);
  with -Lan, devices on your local network can too; with -Public, a reverse proxy can publish
  it to the internet.

  Usage:  powershell -ExecutionPolicy Bypass -File tools\serve.ps1 [-Port 8137] [-Stems <dir>] [-Extras <dir>]
                     [-NoBrowser] [-Lan] [-Public [-TrustedProxy <addresses>]]
          (or double-click start.cmd)

  -Stems   folder holding <Song>/<Song> - <Groove|Lead|Texture|All> (<Key> <BPM>).wav
           (default: the first Stems folder found next to the app or up to 3 folders above it)
  -Extras  folder holding "Instrument Guns & Backing Tracks"
           (default: searched the same way; e.g. the unzipped "bonus" folder)
  -Lan     also accept other devices on your local network. Windows needs a one-time
           permission for that (tools\allow-lan.ps1, run for you with a UAC prompt).
  -Public  run behind a reverse proxy (nginx, Caddy, IIS, Cloudflare Tunnel...) that faces the
           internet. Only the proxy may connect; visitors are told apart by the X-Forwarded-For
           header the proxy adds, and no browser is opened.
  -TrustedProxy  addresses or ranges of the reverse proxy, comma-separated without spaces, e.g.
           10.0.0.2 (default: this computer, 127.0.0.1 and ::1).

  Every mode serves only the app's own files (index.html, style.css, stems.json, the web app
  manifest and icons, the scripts and images under js/, and
  covers/ if you've built them) and the media files it lists, sends security headers, streams
  files in parallel, drops clients that stall, and limits how much each visitor can request.
#>
# No positional parameters: a stray value (e.g. "-TrustedProxy a, b") is an error, not silently dropped.
[CmdletBinding(PositionalBinding = $false)]
param(
  [int]$Port = 8137,
  [string]$Stems,
  [string]$Extras,
  [switch]$NoBrowser,
  [switch]$Lan,
  [switch]$Public,
  [string[]]$TrustedProxy = @('127.0.0.1', '::1')
)

$ErrorActionPreference = 'Stop'
$AppRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$StemRe = '^(.*) - (Groove|Lead|Texture|All) \(([A-G][b#]?m?) (\d+(\.\d+)?)\)\.wav$'

# ---------- limits ----------
$Workers        = 24       # files streamed at once; more requests get 503 until one finishes
$MediaWorkers   = 16       # of those, how many may be stems, so the page itself always loads
$PerClientConns = 8        # requests one visitor can have in flight
$PerClientMedia = 4        # stems one visitor can download at once
$MaxClients     = 50000    # visitors tracked; beyond that, newcomers share one set of limits
$ReqBurst       = 300      # requests per visitor: a burst of 300, then 5 a second
$ReqPerSec      = 5
$ByteBurst      = 1GB      # bytes per visitor: a burst of 1 GB (about 90 stems), then 2 MB a second
$BytesPerSec    = 2MB
$MinSendRate    = 32KB     # drop clients that read slower than this many bytes a second
$CatalogTtl     = 30       # seconds before the file list is re-read from disk

# ---------- trusted proxies ----------
# "-File" hands "-TrustedProxy a,b" over as one string, so split it here.
function ConvertTo-Cidr([string]$text) {
  $addr, $len = $text.Split('/', 2)
  $ip = $null
  if (-not [Net.IPAddress]::TryParse($addr, [ref]$ip)) { throw "'$text' is not an IP address or range" }
  if ($ip.IsIPv4MappedToIPv6) { $ip = $ip.MapToIPv4() }
  $bytes = $ip.GetAddressBytes()
  $bits = $bytes.Length * 8
  if ($len) {
    $n = 0
    if (-not [int]::TryParse($len, [ref]$n) -or $n -lt 0 -or $n -gt $bits) { throw "'$text' has an invalid prefix length" }
    $bits = $n
  }
  [pscustomobject]@{ Text = $text; Bytes = $bytes; Bits = $bits; Loopback = [Net.IPAddress]::IsLoopback($ip) }
}
function Test-InCidr([Net.IPAddress]$ip, $cidr) {
  $b = $ip.GetAddressBytes()
  if ($b.Length -ne $cidr.Bytes.Length) { return $false }
  $bits = $cidr.Bits; $i = 0
  while ($bits -ge 8) { if ($b[$i] -ne $cidr.Bytes[$i]) { return $false }; $i++; $bits -= 8 }
  if ($bits -gt 0) {
    $mask = (0xFF -shl (8 - $bits)) -band 0xFF
    if (($b[$i] -band $mask) -ne ($cidr.Bytes[$i] -band $mask)) { return $false }
  }
  return $true
}
$Proxies = @()
if ($Public) {
  try {
    $Proxies = @($TrustedProxy | ForEach-Object { $_ -split '[,;\s]+' } | Where-Object { $_ } | ForEach-Object { ConvertTo-Cidr $_ })
  } catch { Write-Host "-TrustedProxy: $($_.Exception.Message)" -ForegroundColor Red; exit 1 }
  if (-not $Proxies.Count) { Write-Host '-TrustedProxy needs at least one address.' -ForegroundColor Red; exit 1 }
}
$RemoteProxies = @($Proxies | Where-Object { -not $_.Loopback } | ForEach-Object { $_.Text })
function Test-Trusted([Net.IPAddress]$ip) {
  foreach ($c in $Proxies) { if (Test-InCidr $ip $c) { return $true } }
  return $false
}

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

# Extras are optional: a missing folder only means no guns page.
$extraRoots = Get-SearchRoots
if ($Extras) {
  if (Test-Path -LiteralPath $Extras -PathType Container) { $extraRoots = @((Resolve-Path -LiteralPath $Extras).Path) }
  else { Write-Warning "Extras folder '$Extras' not found - carrying on without it"; $extraRoots = @() }
}
$GunsDir = Find-Under $extraRoots @('Instrument Guns & Backing Tracks', 'bonus\Instrument Guns & Backing Tracks')

# URL prefix -> folder on disk, and the file types served from it.
$Mounts = [ordered]@{}
if ($Stems -and (Test-Path -LiteralPath $Stems)) { $Mounts['Stems/'] = @{ Dir = $Stems; Exts = @('.wav', '.ogg', '.flac') } }
if ($GunsDir) { $Mounts['Extras/Guns/'] = @{ Dir = $GunsDir; Exts = @('.wav', '.ogg', '.flac') } }

$Types = @{
  '.html' = 'text/html; charset=utf-8'; '.js' = 'text/javascript; charset=utf-8'
  '.css' = 'text/css; charset=utf-8'; '.json' = 'application/json; charset=utf-8'
  '.wav' = 'audio/wav'; '.ogg' = 'audio/ogg'; '.flac' = 'audio/flac'; '.jpg' = 'image/jpeg'; '.jpeg' = 'image/jpeg'
  '.png' = 'image/png'; '.webmanifest' = 'application/manifest+json'
}

# ---------- the file catalogue ----------
# Requests are looked up in this table; nothing builds a disk path from the URL, so there is
# no way to reach files outside it ("..", 8.3 names, streams, device names, the repo's .git).
# Relative paths are built from the names themselves (not by trimming FullName), so a folder
# given as an 8.3 short path ("LOCALA~1") can't throw the offsets off. Junctions and symlinks
# are skipped (they could publish files from elsewhere on disk, or loop forever).
function Get-Listing([string]$dir, [string[]]$exts, [string]$prefix = '', [int]$depth = 0) {
  if (-not $dir -or $depth -gt 6) { return @() }
  $out = @()
  foreach ($item in Get-ChildItem -LiteralPath $dir -ErrorAction SilentlyContinue | Sort-Object Name) {
    if ($item.Name.StartsWith('.') -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { continue }
    if ($item.PSIsContainer) { foreach ($sub in Get-Listing $item.FullName $exts ($prefix + $item.Name + '/') ($depth + 1)) { $out += $sub } }
    elseif ($exts -contains $item.Extension.ToLowerInvariant()) { $out += [pscustomobject]@{ Rel = $prefix + $item.Name; Full = $item.FullName } }
  }
  $out
}

function Update-Catalog {
  $files = New-Object 'Collections.Generic.Dictionary[string,string]' ([StringComparer]::OrdinalIgnoreCase)
  foreach ($rel in 'index.html', 'style.css', 'stems.json', 'manifest.webmanifest') {
    $p = Join-Path $AppRoot $rel
    if (Test-Path -LiteralPath $p -PathType Leaf) { $files[$rel] = $p }
  }
  # The scripts, and the images and vendored libraries next to them (js/figures, js/vendor).
  foreach ($i in Get-Listing (Join-Path $AppRoot 'js') @('.js', '.png')) { $files['js/' + $i.Rel] = $i.Full }
  # Home-screen icons named by the web app manifest.
  foreach ($i in Get-Listing (Join-Path $AppRoot 'icons') @('.png')) { $files['icons/' + $i.Rel] = $i.Full }
  # Album covers from tools/build-covers.mjs, if built (without them the app draws its own art).
  foreach ($f in Get-ChildItem -LiteralPath (Join-Path $AppRoot 'covers') -File -ErrorAction SilentlyContinue) {
    if ($f.Attributes -band [IO.FileAttributes]::ReparsePoint) { continue }
    if ($f.Name -eq 'covers.json' -or $f.Extension -in '.jpg', '.jpeg') { $files['covers/' + $f.Name] = $f.FullName }
  }
  $lists = @{}
  foreach ($prefix in $Mounts.Keys) {
    $m = $Mounts[$prefix]
    $items = @(Get-Listing $m.Dir $m.Exts)
    foreach ($i in $items) { $files[$prefix + $i.Rel] = $i.Full }
    $lists[$prefix] = @($items | ForEach-Object { $_.Rel })
  }
  $o = [ordered]@{
    server  = 'serve.ps1'
    stems   = @($lists['Stems/'] | Where-Object { $_ })
    guns    = @($lists['Extras/Guns/'] | Where-Object { $_ })
    mounts  = [ordered]@{ stems = 'Stems/'; guns = 'Extras/Guns/' }
  }

  # The page's one inline script (the file:// notice) is allowed by its hash, so the policy
  # follows index.html if that script is edited.
  $hashes = ''
  if ($files.ContainsKey('index.html')) {
    $html = [IO.File]::ReadAllText($files['index.html'])
    $sha = [Security.Cryptography.SHA256]::Create()
    foreach ($m in [regex]::Matches($html, '<script>([\s\S]*?)</script>')) {
      $hashes += " 'sha256-" + [Convert]::ToBase64String($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($m.Groups[1].Value))) + "'"
    }
    $sha.Dispose()
  }
  $csp = "default-src 'self'; script-src 'self'$hashes; style-src 'self' https://fonts.googleapis.com; " +
    "font-src https://fonts.gstatic.com; img-src 'self' data:; media-src 'self' blob:; connect-src 'self'; " +
    "worker-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"

  $script:Files = $files
  $script:ListingJson = [Text.Encoding]::UTF8.GetBytes((ConvertTo-Json -InputObject $o -Depth 5 -Compress))
  $script:Headers = [ordered]@{
    'Content-Security-Policy'      = $csp
    'X-Content-Type-Options'       = 'nosniff'
    'X-Frame-Options'              = 'DENY'
    'Referrer-Policy'              = 'strict-origin-when-cross-origin'
    'Cross-Origin-Opener-Policy'   = 'same-origin'
    'Cross-Origin-Resource-Policy' = 'same-origin'
    'Permissions-Policy'           = 'camera=(), microphone=(), geolocation=(), payment=(), usb=()'
  }
  $script:CatalogAt = $Clock.Elapsed.TotalSeconds
}

# ---------- visitors and rate limits ----------
$Clock = [Diagnostics.Stopwatch]::StartNew()
$Clients = @{}         # visitor key -> token buckets and open requests
$ProxyHinted = New-Object 'System.Collections.Generic.HashSet[string]' # refused addresses already named in a hint
$script:PrunedAt = 0
$script:NoXffWarned = $false
# Names that mean this PC on the local network (for the -Lan Host check).
$LanNames = @($env:COMPUTERNAME, "$env:COMPUTERNAME.local")
try {
  $g = [Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties()
  $LanNames += $g.HostName, "$($g.HostName).local"
  if ($g.DomainName) { $LanNames += "$($g.HostName).$($g.DomainName)" }
} catch { }

function ConvertTo-PlainIp([Net.IPAddress]$ip) {
  if ($ip.IsIPv4MappedToIPv6) { return $ip.MapToIPv4() }
  return $ip
}
# One bucket per IPv4 address, or per /64 for IPv6 (one home or phone usually gets a whole /64).
function Get-ClientKey([Net.IPAddress]$ip) {
  $b = $ip.GetAddressBytes()
  if ($b.Length -eq 16) { return ([BitConverter]::ToString($b, 0, 8).Replace('-', '').ToLowerInvariant() + '::/64') }
  return $ip.ToString()
}

# Returns the visitor's address, or $null when a -Public server is reached around its proxy.
function Resolve-Client($req) {
  $remote = ConvertTo-PlainIp $req.RemoteEndPoint.Address
  if (-not $Public) {
    # A localhost listener still accepts network clients that send "Host: localhost".
    if (-not $script:WideOn -and -not [Net.IPAddress]::IsLoopback($remote)) { return $null }
    # On a reserved port even local mode listens on every interface; insist on a local Host so
    # a web page can't reach this server by pointing its own domain at 127.0.0.1.
    # (IsLoopback rather than a list of names: .NET Framework spells [::1] out in full.)
    if (-not $script:WideOn -and -not $req.Url.IsLoopback) { return $null }
    # With -Lan, devices open it by this PC's address or name; refuse any other name for the same reason.
    if ($script:WideOn -and -not ($req.Url.HostNameType -in 'IPv4', 'IPv6' -or $req.Url.IsLoopback -or $LanNames -contains $req.Url.Host)) { return $null }
    return $remote
  }
  if (-not (Test-Trusted $remote)) { return $null }
  # The proxy appends the address it saw, so read X-Forwarded-For from the right and skip our
  # own proxies; anything further left was written by the visitor and can't be trusted.
  $xff = $req.Headers['X-Forwarded-For'] # several header lines arrive joined with commas
  if (-not $xff) {
    if (-not $script:NoXffWarned) {
      $script:NoXffWarned = $true
      Write-Host "  Note: a request from $remote had no X-Forwarded-For header. If your proxy doesn't add one, all visitors share one set of limits." -ForegroundColor Yellow
    }
    return $remote
  }
  # Only the last few hops can be ours. Cut before anything else, so a visitor who sends a huge
  # header can't make each request slow.
  $parts = $xff.Split(',')
  if ($parts.Count -gt 10) { $parts = $parts[($parts.Count - 10)..($parts.Count - 1)] }
  $hops = @($parts | ForEach-Object { $_.Trim() } | Where-Object { $_ })
  $client = $remote
  for ($i = $hops.Count - 1; $i -ge 0; $i--) {
    $h = $hops[$i]
    if ($h -match '^\[(.+)\](:\d+)?$') { $h = $Matches[1] }                  # [v6]:port
    elseif ($h -match '^(\d{1,3}(\.\d{1,3}){3}):\d+$') { $h = $Matches[1] }   # v4:port
    $ip = $null
    if (-not [Net.IPAddress]::TryParse($h, [ref]$ip)) { break }
    $client = ConvertTo-PlainIp $ip
    if (-not (Test-Trusted $client)) { break }
  }
  return $client
}

function Get-ClientState([string]$key) {
  $now = $Clock.Elapsed.TotalSeconds
  $c = $Clients[$key]
  if (-not $c -and $Clients.Count -ge $MaxClients) { $key = '(overflow)'; $c = $Clients[$key] }
  if (-not $c) {
    $c = @{ Req = [double]$ReqBurst; Bytes = [double]$ByteBurst; At = $now; Conns = 0; Media = 0 }
    $Clients[$key] = $c
    return $c
  }
  $dt = $now - $c.At
  $c.Req = [Math]::Min([double]$ReqBurst, $c.Req + $dt * $ReqPerSec)
  $c.Bytes = [Math]::Min([double]$ByteBurst, $c.Bytes + $dt * $BytesPerSec)
  $c.At = $now
  return $c
}

# Every few seconds, forget visitors with nothing in flight whose buckets have refilled: they
# would start from full again anyway. The table is also capped (see Get-ClientState).
function Limit-Clients {
  $now = $Clock.Elapsed.TotalSeconds
  if ($now - $script:PrunedAt -lt 5) { return }
  $script:PrunedAt = $now
  foreach ($k in @($Clients.Keys)) {
    $c = $Clients[$k]; $dt = $now - $c.At
    if ($c.Conns -le 0 -and $c.Req + $dt * $ReqPerSec -ge $ReqBurst -and $c.Bytes + $dt * $BytesPerSec -ge $ByteBurst) { $Clients.Remove($k) }
  }
}

# ---------- logging ----------
# URLs are attacker-controlled: strip control characters (terminal escape sequences) and cap
# the length, and print at most 20 lines a second.
$script:LogSec = -1; $script:LogCount = 0; $script:LogDropped = 0
function Write-Log([string]$line, [string]$color = 'DarkGray') {
  $sec = [int][Math]::Floor($Clock.Elapsed.TotalSeconds)
  if ($sec -ne $script:LogSec) {
    if ($script:LogDropped) { Write-Host "  ($($script:LogDropped) more log lines skipped)" -ForegroundColor DarkGray }
    $script:LogSec = $sec; $script:LogCount = 0; $script:LogDropped = 0
  }
  if (++$script:LogCount -gt 20) { $script:LogDropped++; return }
  $line = $line -replace '[\x00-\x1f\x7f-\x9f]', '?'
  if ($line.Length -gt 240) { $line = $line.Substring(0, 240) + '...' }
  Write-Host $line -ForegroundColor $color
}

# ---------- HTTP ----------
function Send-Text($res, [int]$code, [string]$text, [string]$type = 'text/plain; charset=utf-8') {
  $bytes = [Text.Encoding]::UTF8.GetBytes($text)
  $res.StatusCode = $code
  $res.ContentType = $type
  $res.Headers['Cache-Control'] = 'no-store'
  $res.ContentLength64 = $bytes.Length
  if ($script:method -ne 'HEAD') { $res.OutputStream.Write($bytes, 0, $bytes.Length) } # HEAD: headers only
}

# Streams one open file to the client on a pool thread, so a big stem or a slow reader doesn't
# hold up everyone else. Runs in another runspace: it can only use what it is handed.
$SendFile = {
  param($res, $fs, [bool]$body)
  try {
    if ($body) { $fs.CopyTo($res.OutputStream, 256KB) }
    $res.Close()
    'ok'
  } catch {
    try { $res.Abort() } catch { }
    'aborted'
  } finally { $fs.Dispose() }
}.ToString()

$Pool = [RunspaceFactory]::CreateRunspacePool(1, $Workers)
$Pool.Open()
$InFlight = New-Object Collections.Generic.List[object]

$script:MediaInFlight = 0
function Start-Send($res, $fs, [bool]$body, $client, [bool]$media, [string]$logLine) {
  $ps = [PowerShell]::Create()
  $ps.RunspacePool = $Pool
  [void]$ps.AddScript($SendFile).AddArgument($res).AddArgument($fs).AddArgument($body)
  $client.Conns++
  if ($media) { $client.Media++; $script:MediaInFlight++ }
  $InFlight.Add([pscustomobject]@{ PS = $ps; Handle = $ps.BeginInvoke(); Client = $client; Media = $media; Log = $logLine; Started = $Clock.ElapsedMilliseconds })
}

function Complete-Sends {
  for ($i = $InFlight.Count - 1; $i -ge 0; $i--) {
    $j = $InFlight[$i]
    if (-not $j.Handle.IsCompleted) { continue }
    $result = 'aborted'
    try { $result = @($j.PS.EndInvoke($j.Handle))[0] } catch { }
    $j.PS.Dispose()
    $InFlight.RemoveAt($i)
    $j.Client.Conns--
    if ($j.Media) { $j.Client.Media--; $script:MediaInFlight-- }
    if ($j.Log) {
      $note = if ($result -eq 'ok') { '' } else { ' - client hung up' }
      Write-Log ('{0} ({1} ms){2}' -f $j.Log, ($Clock.ElapsedMilliseconds - $j.Started), $note)
    }
  }
}

function Invoke-Request($ctx) {
  $req = $ctx.Request; $res = $ctx.Response
  $script:method = $req.HttpMethod
  $handedOff = $false
  $status = 0
  $path = $req.RawUrl
  $who = ''
  try {
    if ($Clock.Elapsed.TotalSeconds - $script:CatalogAt -ge $CatalogTtl) {
      try { Update-Catalog } catch { Write-Log "Could not re-read the files: $($_.Exception.Message)" 'Yellow' }
    }
    foreach ($k in $script:Headers.Keys) { $res.Headers[$k] = $script:Headers[$k] }

    $ip = Resolve-Client $req
    if (-not $ip) {
      $status = 403; $who = " from $($req.RemoteEndPoint.Address)"
      # The usual cause is a proxy on another machine (a cloudflared tunnel, say) that wasn't named.
      # Name each of the first few refused addresses, since a LAN device or a check from this PC
      # may get in first; Write-Host so the log's rate limit can't swallow it.
      $refused = (ConvertTo-PlainIp $req.RemoteEndPoint.Address).ToString() -replace '%.*$', '' # no IPv6 scope id ("%" breaks .cmd files)
      if ($Public -and $ProxyHinted.Count -lt 5 -and $ProxyHinted.Add($refused)) {
        # Suggest the whole list, so following the hint doesn't drop a proxy that's already named.
        $suggest = if ($RemoteProxies.Count) { (@($Proxies | ForEach-Object { $_.Text }) + $refused) -join ',' } else { $refused }
        $proxied = if ($req.Headers['X-Forwarded-For'] -or $req.Headers['Cf-Connecting-Ip']) { ' (it sent proxy headers)' } else { '' }
        Write-Host "  Refused $refused$proxied. If that's your reverse proxy, restart with -TrustedProxy $suggest" -ForegroundColor Yellow
        Write-Host '  (If a launcher .cmd file already passes -TrustedProxy, change it in that file instead.)' -ForegroundColor Yellow
      }
      $msg = if ($Public) { 'This server only answers its reverse proxy.' }
             elseif ($script:WideOn) { "Open this server by the PC's network address, as shown in its window." }
             else { 'This server only answers this computer.' }
      Send-Text $res 403 $msg; return
    }
    if ($Lan -or $Public) { $who = " $ip" }
    $client = Get-ClientState (Get-ClientKey $ip)

    # Clients are told how long to wait; the app retries 429 and 503 by itself.
    if ($client.Req -lt 1) {
      $status = 429; $res.Headers['Retry-After'] = '5'; Send-Text $res 429 'Too many requests - try again in a few seconds'; return
    }
    $client.Req -= 1
    if ($client.Conns -ge $PerClientConns) {
      $status = 429; $res.Headers['Retry-After'] = '1'; Send-Text $res 429 'Too many requests at once'; return
    }
    if ($req.HttpMethod -ne 'GET' -and $req.HttpMethod -ne 'HEAD') {
      $status = 405; $res.Headers['Allow'] = 'GET, HEAD'; Send-Text $res 405 'Method not allowed'; return
    }

    # Decode the raw target exactly once (a '#' or '%' in a file name would otherwise be cut
    # off or decoded twice). Only origin-form targets ("/path") are accepted.
    $raw = $req.RawUrl
    if (-not $raw.StartsWith('/')) { $status = 400; Send-Text $res 400 'Bad request'; return }
    $q = $raw.IndexOf('?'); if ($q -ge 0) { $raw = $raw.Substring(0, $q) }
    try { $path = [Uri]::UnescapeDataString($raw) } catch { $status = 400; Send-Text $res 400 'Bad request'; return }
    $rel = $path.Substring(1)
    if ($rel -eq '') { $rel = 'index.html' }

    if ($rel -eq '__local/files') {
      # Sent from the pool like a file, so a client that never reads it can't stall this thread.
      if ($InFlight.Count -ge $Workers) {
        $status = 503; $res.Headers['Retry-After'] = '2'; Send-Text $res 503 'Busy - try again in a moment'; return
      }
      $status = 200
      $res.StatusCode = 200
      $res.ContentType = 'application/json; charset=utf-8'
      $res.Headers['Cache-Control'] = 'no-store'
      $res.ContentLength64 = $script:ListingJson.Length
      # Update-Catalog makes a new array each time, so the stream can wrap this one.
      Start-Send $res ([IO.MemoryStream]::new($script:ListingJson, $false)) ($req.HttpMethod -eq 'GET') $client $false $null
      $handedOff = $true
      return
    }

    $file = $null
    if (-not $script:Files.TryGetValue($rel, [ref]$file)) { $status = 404; Send-Text $res 404 'Not found'; return }
    $ext = [IO.Path]::GetExtension($file).ToLowerInvariant()
    $media = $ext -match '^\.(wav|ogg|flac)$'

    $fs = $null
    try { $fs = [IO.File]::Open($file, 'Open', 'Read', 'ReadWrite') } catch { $status = 404; Send-Text $res 404 'Not found'; return }
    try {
      $len = $fs.Length
      $mtime = [IO.File]::GetLastWriteTimeUtc($file)
      $etag = '"{0:x}-{1:x}"' -f $len, $mtime.Ticks
      $res.Headers['ETag'] = $etag
      $res.Headers['Last-Modified'] = $mtime.ToString('R')
      $res.Headers['Cache-Control'] = 'no-cache'
      # Revalidation sends no body, so it's answered before the busy checks: a stem the browser
      # already has never waits for a download slot.
      $inm = $req.Headers['If-None-Match']
      if ($inm -and $inm.Length -le 1024) { # a browser sends one tag; a huge list only costs time
        # Weak comparison: a compressing proxy may hand the browser W/"..." versions of our tags.
        $tags = @($inm.Split(',') | ForEach-Object { $_.Trim() -replace '^W/', '' })
        if ($tags -contains $etag -or $tags -contains '*') { $status = 304; $res.StatusCode = 304; return }
      }
      if ($InFlight.Count -ge $Workers -or ($media -and $script:MediaInFlight -ge $MediaWorkers)) {
        $status = 503; $res.Headers['Retry-After'] = '2'
        $res.Headers.Remove('ETag'); $res.Headers.Remove('Last-Modified')
        Send-Text $res 503 'Busy - try again in a moment'; return
      }
      if ($media -and $client.Media -ge $PerClientMedia) {
        $status = 429; $res.Headers['Retry-After'] = '1'
        $res.Headers.Remove('ETag'); $res.Headers.Remove('Last-Modified')
        Send-Text $res 429 'Too many downloads at once'; return
      }
      $body = $req.HttpMethod -eq 'GET'
      if ($body) {
        if ($client.Bytes -lt $len) {
          $status = 429; $res.Headers['Retry-After'] = '30'
          $res.Headers.Remove('ETag'); $res.Headers.Remove('Last-Modified')
          Send-Text $res 429 'Download limit reached - try again in a little while'; return
        }
        $client.Bytes -= $len
      }
      $res.StatusCode = 200
      $res.ContentType = $Types[$ext]
      $res.ContentLength64 = $len
      $logLine = $null
      if ($media) { $logLine = '200 {0} {1}{2}' -f $req.HttpMethod, $path, $who }
      $status = 200
      Start-Send $res $fs $body $client $media $logLine
      $handedOff = $true
    } finally { if (-not $handedOff) { $fs.Dispose() } }
  } catch {
    $status = 500
    Write-Log "500 $($req.HttpMethod) $path$who - $($_.Exception.Message)" 'Yellow'
    # Never send exception text to the client; it can name folders on this computer.
    try { Send-Text $res 500 'Server error' } catch { }
  } finally {
    if (-not $handedOff) {
      try { $res.Close() } catch { try { $res.Abort() } catch { } }
      if ($status -ne 200 -and $status -ne 304) { Write-Log ('{0} {1} {2}{3}' -f $status, $req.HttpMethod, $path, $who) }
    }
  }
}

# ---------- start ----------
Update-Catalog

function Set-Timeouts($l) {
  # http.sys timeouts: drop clients that stall while sending headers, sit idle, or read too slowly.
  try {
    $t = $l.TimeoutManager
    $t.HeaderWait = [TimeSpan]::FromSeconds(15)
    $t.IdleConnection = [TimeSpan]::FromSeconds(60)
    $t.EntityBody = [TimeSpan]::FromSeconds(10)
    $t.DrainEntityBody = [TimeSpan]::FromSeconds(10)
    $t.RequestQueue = [TimeSpan]::FromSeconds(30)
    $t.MinSendBytesPerSecond = $MinSendRate
  } catch { Write-Warning "Could not set connection timeouts: $($_.Exception.Message)" }
}
function Start-Listener([string]$prefix) {
  $l = New-Object Net.HttpListener
  $l.Prefixes.Add($prefix)
  $l.Start()
  Set-Timeouts $l
  return $l
}

# A public server stays on its port: if it moved, the proxy would keep sending visitors to
# whatever else holds the old one.
# Windows lets this account open "http://+:port/" only on a port reserved by allow-lan.ps1, and
# "http://localhost:port/" only on one that isn't, so try both; if neither opens, it's in use.
$wanted = $Port
$lastPort = if ($Public) { $Port } else { $Port + 9 }
$listener = $null
$script:AllIfaces = $false # listening on every interface (WideOn decides who gets answered)
for ($p = $Port; $p -le $lastPort; $p++) {
  try { $listener = Start-Listener "http://+:$p/"; $script:AllIfaces = $true; $Port = $p; break } catch { }
  try { $listener = Start-Listener "http://localhost:$p/"; $Port = $p; break } catch { }
}
if (-not $listener) {
  if ($Public) {
    Write-Host "Port $Port is in use (another copy of this server?). Stop it or pass -Port." -ForegroundColor Red
    Write-Host '(If a launcher .cmd file already passes -Port, change it in that file, and point the proxy at the new port.)' -ForegroundColor Red
  }
  else { Write-Host "Could not open a port between $Port and $lastPort." -ForegroundColor Red }
  exit 1
}

# LAN and public modes listen on every interface (a proxy may send any Host header, which a
# localhost listener refuses). Windows only allows that for a reserved URL, so the first time
# we ask for the one-time setup (UAC prompt); if that's declined we stay local-only.
$script:WideOn = $false
if (($Lan -or $Public) -and $script:AllIfaces) { $script:WideOn = $true }
elseif ($Lan -or $Public) {
  $listener.Stop(); $listener.Close() # free the port for the all-interfaces listener
  try { $listener = Start-Listener "http://+:$Port/"; $script:WideOn = $true } catch {
    Write-Host ''
    Write-Host "  Listening beyond this computer needs a one-time Windows permission for port $Port." -ForegroundColor Yellow
    # Reserve the port for this account even if an administrator account approves the prompt.
    $setupArgs = @('-Port', $Port, '-Sid', [Security.Principal.WindowsIdentity]::GetCurrent().User.Value)
    if ($Public) {
      # Only the proxy needs in: no firewall rule for a proxy on this computer, otherwise one for its addresses.
      if ($RemoteProxies.Count) { $setupArgs += @('-RemoteAddress', ($RemoteProxies -join ',')) } else { $setupArgs += '-NoFirewall' }
      Write-Host '  Approve the administrator prompt to let your reverse proxy connect.' -ForegroundColor Yellow
    } else {
      Write-Host '  Approve the administrator prompt to allow devices on your local network (only) to connect.' -ForegroundColor Yellow
    }
    try {
      $setup = Join-Path $PSScriptRoot 'allow-lan.ps1'
      Start-Process powershell -Verb RunAs -Wait -ArgumentList (@('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$setup`"") + $setupArgs)
    } catch { } # prompt declined
    try { $listener = Start-Listener "http://+:$Port/"; $script:WideOn = $true } catch { }
  }
  if (-not $script:WideOn) {
    if ($Public) {
      Write-Host '  Not set up - listening on localhost only. Your proxy must then send "Host: localhost".' -ForegroundColor Yellow
    } else {
      Write-Host '  LAN access is not set up - running for this computer only.' -ForegroundColor Yellow
    }
    $listener = Start-Listener "http://localhost:$Port/"
  }
}

$url = "http://localhost:$Port/"
Write-Host ''
Write-Host '  Dream Chamber Remixed - server' -ForegroundColor Cyan
Write-Host "  App:     $AppRoot"
if ($Mounts['Stems/']) {
  Write-Host "  Stems:   $($Mounts['Stems/'].Dir)"
} else {
  Write-Host '  Stems:   NOT FOUND - pass -Stems <folder> (expects <Song>\<Song> - Groove (Gbm 116).wav)' -ForegroundColor Yellow
}
if ($GunsDir) { Write-Host "  Guns:    $GunsDir" }
Write-Host ''
if ($Public -and -not @($Proxies | Where-Object { $_.Loopback }).Count) {
  # Only the remote proxy is answered, so a browser on this computer would just get a 403.
  Write-Host '  Running. Ctrl+C or close this window to stop.' -ForegroundColor Green
  Write-Host "  Open the site through your proxy; http://localhost:$Port/ is refused here (only the proxy is trusted)." -ForegroundColor DarkGray
} else {
  Write-Host "  Open $url  (Ctrl+C or close this window to stop)" -ForegroundColor Green
}
if ($Port -ne $wanted) { Write-Host "  (port $wanted was busy, so this copy uses $Port)" -ForegroundColor Yellow }
if ($Public -and -not $RemoteProxies.Count) {
  Write-Host "  Proxy target: http://localhost:$Port/   (the proxy runs on this computer)" -ForegroundColor Green
} elseif ($script:WideOn) {
  # Other devices use this computer's network address. VPN adapters are listed too; use the
  # address on the same network as the device (or proxy) connecting.
  $addrs = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' -and $_.AddressState -eq 'Preferred' })
  $label = if ($Public) { 'Proxy target' } else { 'On your network' }
  foreach ($a in $addrs) { Write-Host ("  {0}: http://{1}:{2}/   ({3})" -f $label, $a.IPAddress, $Port, $a.InterfaceAlias) -ForegroundColor Green }
  # Browsers only run AudioWorklet on HTTPS or localhost, so a plain-HTTP network address gets the
  # compressor fallback instead of the true-peak limiter.
  if (-not $Public) { Write-Host '  Note: over the network address the mix uses the fallback compressor, not the limiter (that needs HTTPS or localhost).' -ForegroundColor Yellow }
}
if ($Public) {
  Write-Host ("  Public mode: only answers {0}; visitors are told apart by X-Forwarded-For." -f (($Proxies | ForEach-Object { $_.Text }) -join ', ')) -ForegroundColor Cyan
  Write-Host '  Let the proxy handle HTTPS (and HSTS); this server speaks plain HTTP.' -ForegroundColor Cyan
  if ($RemoteProxies.Count -and $script:WideOn) {
    # The firewall rule may predate -TrustedProxy (e.g. from -Lan). Only the proxy is answered
    # either way, but say so if it doesn't let the proxy in or lets in more than it.
    $from = $null
    try {
      $from = @(Get-NetFirewallRule -DisplayName "Dream Chamber Remixed (TCP $Port, local network)" -ErrorAction Stop |
        Get-NetFirewallAddressFilter | ForEach-Object { $_.RemoteAddress })
    } catch { }
    if (($from -join ',') -ne ($RemoteProxies -join ',')) {
      $now = if ($from) { "lets in: $($from -join ', ')" } else { 'is missing' }
      Write-Host "  Firewall rule for port $Port $now. To admit only the proxy, run as administrator:" -ForegroundColor Yellow
      Write-Host "    powershell -ExecutionPolicy Bypass -File `"$PSScriptRoot\allow-lan.ps1`" -Port $Port -RemoteAddress $($RemoteProxies -join ',')" -ForegroundColor Yellow
    }
  }
  # Selecting text in a console window pauses its output, and with it this single-threaded
  # server; turn QuickEdit off so a stray click in the window can't freeze the site.
  try {
    Add-Type -Namespace DreamChamber -Name Console -MemberDefinition @'
[DllImport("kernel32.dll")] public static extern IntPtr GetStdHandle(int h);
[DllImport("kernel32.dll")] public static extern bool GetConsoleMode(IntPtr h, out uint m);
[DllImport("kernel32.dll")] public static extern bool SetConsoleMode(IntPtr h, uint m);
'@
    $h = [DreamChamber.Console]::GetStdHandle(-10); [uint32]$m = 0
    if ([DreamChamber.Console]::GetConsoleMode($h, [ref]$m)) {
      [void][DreamChamber.Console]::SetConsoleMode($h, [uint32](([long]$m -band (-bnot [long]0x40)) -bor 0x80))
    }
  } catch { }
}
Write-Host ''
if (-not $NoBrowser -and -not $Public) { Start-Process $url }

try {
  $pending = $null
  while ($listener.IsListening) {
    if (-not $pending) { $pending = $listener.BeginGetContext($null, $null) }
    # Wake up regularly so Ctrl+C can stop the server and finished downloads are counted.
    if ($pending.AsyncWaitHandle.WaitOne(100)) {
      $ctx = $null
      try { $ctx = $listener.EndGetContext($pending) } catch { }
      $pending = $null
      if ($ctx) { Invoke-Request $ctx }
    }
    Complete-Sends
    Limit-Clients
  }
} finally {
  $listener.Stop()
  $listener.Close()
  $Pool.Close()
  $Pool.Dispose()
}
