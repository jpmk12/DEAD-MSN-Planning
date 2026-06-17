<#
.SYNOPSIS
  Capture live responses from the data sources the DEAD Planning app uses, into a
  zip (manifest.json + bodies/) — the same shape as the earlier DAIP capture — so
  the response shapes can be reviewed/ingested.

.WHY
  Some sources are unreachable from the build sandbox (DoD PKI + network policy),
  so the request shapes are known but the live bodies aren't. This script grabs
  them on a machine that CAN reach them.

.REQUIREMENTS
  - PUBLIC rows (NAT, AWC G-AIRMET/SIGMET) work on ANY internet-connected machine.
  - DAIP rows (www.daip.jcs.mil) require a machine whose trust store has the DoD
    PKI CAs (i.e. a typical .mil/CAC workstation). If DAIP shows TLS errors, run on
    such a machine, or pass -SkipCertCheck (PS 7 / .NET 4.7.1+) to bypass server
    cert validation (use only if you understand the risk).
  - Works in Windows PowerShell 5.1 and PowerShell 7.

.USAGE
  pwsh ./capture-sources.ps1                 # all rows -> capture-<timestamp>.zip
  powershell -ExecutionPolicy Bypass -File .\capture-sources.ps1
  ./capture-sources.ps1 -SkipCertCheck       # bypass cert validation (non-DoD box)
  ./capture-sources.ps1 -Only DAIP           # DAIP rows only (or: -Only PUBLIC)

  Then send the produced .zip back.
#>

[CmdletBinding()]
param(
  [switch]$SkipCertCheck,
  [ValidateSet('ALL','DAIP','PUBLIC')] [string]$Only = 'ALL',
  [int]$TimeoutSec = 30
)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 -bor [Net.SecurityProtocolType]::Tls11

# --- HttpClient (captures non-2xx bodies; honors OS/DoD trust store) -----------
Add-Type -AssemblyName System.Net.Http -ErrorAction SilentlyContinue
$handler = [System.Net.Http.HttpClientHandler]::new()
if ($SkipCertCheck) {
  try { $handler.ServerCertificateCustomValidationCallback = { param($m,$c,$ch,$e) $true } }
  catch { Write-Warning "SkipCertCheck not supported on this runtime; relying on the machine trust store." }
}
$client = [System.Net.Http.HttpClient]::new($handler)
$client.Timeout = [TimeSpan]::FromSeconds($TimeoutSec)
$ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
$client.DefaultRequestHeaders.TryAddWithoutValidation('User-Agent', $ua) | Out-Null
$client.DefaultRequestHeaders.TryAddWithoutValidation('Accept', 'application/json, text/plain, text/html, */*') | Out-Null

$DAIP  = 'https://www.daip.jcs.mil/daip/mobile/query'
$DAIPR = 'https://www.daip.jcs.mil/daip/mobile/result'

# Full DAIP query envelope (some types are picky); merge per-type overrides.
function DaipBody([hashtable]$extra) {
  $base = [ordered]@{
    locs=''; poa=''; pod=''; alternates=''; route=''; radius='10'; runwayLength='';
    runwayWidth=''; airportType=''; type=''; notamId=''; acode=''; artcc=''; tfrsOnly='';
    orgLoc=''; lat1=''; lat2=''; lng1=''; lng2=''; latdir=''; longdir='';
    includeRegulatoryNotices=''; briefing=''; scheduleDate=''; sendTime=''; active='';
    sunday=''; monday=''; tuesday=''; wednesday=''; thursday=''; friday=''; saturday=''; sort='Criticality'
  }
  foreach ($k in $extra.Keys) { $base[$k] = $extra[$k] }
  ($base | ConvertTo-Json -Compress)
}

# --- Request list. group=PUBLIC|DAIP ------------------------------------------
$requests = @(
  # Public — confirm live shapes (work anywhere)
  @{ group='PUBLIC'; name='nat_faa';        method='GET';  url='https://nms.aim.faa.gov/nat' }
  @{ group='PUBLIC'; name='gairmet_awc';    method='GET';  url='https://aviationweather.gov/api/data/gairmet?format=json' }
  @{ group='PUBLIC'; name='airsigmet_awc';  method='GET';  url='https://aviationweather.gov/api/data/airsigmet?format=json' }

  # DAIP — the probe-live priorities (ROUTE_OF_FLIGHT, BIRDTAM) + shape confirms
  @{ group='DAIP'; name='location';          method='POST'; url=$DAIP;  body=(DaipBody @{ type='LOCATION'; locs='KADW KCHS' }) }
  @{ group='DAIP'; name='pacots';            method='POST'; url=$DAIP;  body=(DaipBody @{ type='PACIFIC_TRACKS' }) }
  @{ group='DAIP'; name='gps_waas';          method='POST'; url=$DAIP;  body=(DaipBody @{ type='GPS_WAAS' }) }
  @{ group='DAIP'; name='fuel_notams';       method='POST'; url=$DAIP;  body=(DaipBody @{ type='FUEL_NOTAMS' }) }
  @{ group='DAIP'; name='artcc_tfrs';        method='POST'; url=$DAIP;  body=(DaipBody @{ type='ARTCC_TFRS' }) }
  @{ group='DAIP'; name='moa';               method='POST'; url=$DAIP;  body=(DaipBody @{ type='MOA' }) }
  @{ group='DAIP'; name='area_briefing';     method='POST'; url=$DAIP;  body=(DaipBody @{ type='AREA_BRIEFING'; lat1='34'; lat2='37'; lng1='35'; lng2='39'; latdir='N'; longdir='E'; radius='50' }) }

  # ROUTE_OF_FLIGHT — 404'd before; try several shapes/endpoints to find the live one
  @{ group='DAIP'; name='route_query_min';   method='POST'; url=$DAIP;  body=(DaipBody @{ type='ROUTE_OF_FLIGHT'; poa='KADW'; pod='ETAR'; alternates='EDDF'; airportType='B'; radius='10' }) }
  @{ group='DAIP'; name='route_query_locs';  method='POST'; url=$DAIP;  body=(DaipBody @{ type='ROUTE_OF_FLIGHT'; poa='KADW'; pod='ETAR'; alternates='EDDF'; airportType='B'; radius='10'; route='KADW ETAR'; locs='KADW ETAR' }) }
  @{ group='DAIP'; name='route_result';      method='POST'; url=$DAIPR; body=(DaipBody @{ type='ROUTE_OF_FLIGHT'; poa='KADW'; pod='ETAR'; alternates='EDDF'; airportType='B'; radius='10' }) }
  @{ group='DAIP'; name='route_nfir';        method='GET';  url='https://www.daip.jcs.mil/daip/mobile/nfir?type=ROUTE_OF_FLIGHT&poa=KADW&pod=ETAR&alternates=EDDF&airportType=B&radius=10' }

  # BIRDTAM — 404'd before; try variants
  @{ group='DAIP'; name='birdtam_do';        method='GET';  url='https://www.daip.jcs.mil/daip/birdtam.do' }
  @{ group='DAIP'; name='birdtam_mobile';    method='GET';  url='https://www.daip.jcs.mil/daip/mobile/birdtam' }
  @{ group='DAIP'; name='birdtam_query';     method='POST'; url=$DAIP;  body=(DaipBody @{ type='BIRDTAM' }) }
  @{ group='DAIP'; name='birdtam_index';     method='GET';  url='https://www.daip.jcs.mil/daip/mobile/index?type=BIRDTAM' }
)

# --- Run ----------------------------------------------------------------------
$stamp   = Get-Date -Format 'yyyyMMddHHmmss'
$outDir  = Join-Path (Get-Location) "capture-$stamp"
$bodyDir = Join-Path $outDir 'bodies'
New-Item -ItemType Directory -Force -Path $bodyDir | Out-Null
$manifest = New-Object System.Collections.ArrayList
$n = 0

foreach ($r in $requests) {
  if ($Only -ne 'ALL' -and $r.group -ne $Only) { continue }
  $n++
  $entry = [ordered]@{ n=$n; name=$r.name; group=$r.group; method=$r.method; url=$r.url;
                       requestBody=($r.body); status=$null; contentType=$null; length=0;
                       looksJson=$false; bodyFile=$null; error=$null; preview=$null }
  Write-Host ("[{0,2}] {1,-22} {2,-4} {3}" -f $n, $r.name, $r.method, $r.url)
  try {
    if ($r.method -eq 'POST') {
      $content = [System.Net.Http.StringContent]::new([string]$r.body, [System.Text.Encoding]::UTF8, 'application/json')
      $resp = $client.PostAsync($r.url, $content).GetAwaiter().GetResult()
    } else {
      $resp = $client.GetAsync($r.url).GetAwaiter().GetResult()
    }
    $bodyText = $resp.Content.ReadAsStringAsync().GetAwaiter().GetResult()
    $entry.status = [int]$resp.StatusCode
    $entry.contentType = if ($resp.Content.Headers.ContentType) { $resp.Content.Headers.ContentType.ToString() } else { '' }
    $entry.length = $bodyText.Length
    $t = $bodyText.TrimStart()
    $entry.looksJson = ($entry.contentType -match 'json') -or $t.StartsWith('{') -or $t.StartsWith('[')
    $entry.preview = $bodyText.Substring(0, [Math]::Min(400, $bodyText.Length))
    $ext = if ($entry.looksJson) { 'json' } elseif ($entry.contentType -match 'html') { 'html' } else { 'txt' }
    $fname = ('{0:000}-{1}.{2}' -f $n, $r.name, $ext)
    $entry.bodyFile = "bodies/$fname"
    Set-Content -Path (Join-Path $bodyDir $fname) -Value $bodyText -Encoding UTF8
    Write-Host ("      -> {0}  {1}  {2} bytes" -f $entry.status, $entry.contentType, $entry.length)
  } catch {
    $entry.error = $_.Exception.Message
    Write-Warning ("      !! {0}" -f $entry.error)
  }
  [void]$manifest.Add($entry)
}

# --- Write manifest + zip ------------------------------------------------------
$manifest | ConvertTo-Json -Depth 6 | Set-Content -Path (Join-Path $outDir 'manifest.json') -Encoding UTF8
$zip = "$outDir.zip"
if (Test-Path $zip) { Remove-Item $zip -Force }
Compress-Archive -Path (Join-Path $outDir '*') -DestinationPath $zip
Write-Host ""
Write-Host ("Done. {0} requests captured." -f $manifest.Count) -ForegroundColor Green
Write-Host ("Zip:  {0}" -f $zip) -ForegroundColor Green
Write-Host "Send that .zip back for review." -ForegroundColor Green
