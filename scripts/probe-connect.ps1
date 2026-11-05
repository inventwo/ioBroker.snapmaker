$ErrorActionPreference = 'Continue'
$base = 'http://192.168.150.150:8080/api/v1'

Write-Host 'Waiting 8s for pending connect slot to clear...'
Start-Sleep -Seconds 8

Write-Host '=== POST connect (no body) ==='
$r1 = curl.exe -s -w "`nHTTP:%{http_code}" -X POST "$base/connect" -H 'Content-Type: application/x-www-form-urlencoded'
Write-Host $r1

$token = $null
if ($r1 -match '"token"\s*:\s*"([^"]+)"') {
	$token = $Matches[1]
	Write-Host "TOKEN=$token"
}

if (-not $token) {
	Write-Host 'No token yet, waiting 8s and retry...'
	Start-Sleep -Seconds 8
	$r1 = curl.exe -s -w "`nHTTP:%{http_code}" -X POST "$base/connect" -H 'Content-Type: application/x-www-form-urlencoded'
	Write-Host $r1
	if ($r1 -match '"token"\s*:\s*"([^"]+)"') {
		$token = $Matches[1]
		Write-Host "TOKEN=$token"
	}
}

if (-not $token) {
	Write-Host 'FAILED: no token'
	exit 1
}

Write-Host '=== POST connect with token ==='
$r2 = curl.exe -s -w "`nHTTP:%{http_code}" -X POST "$base/connect" -H 'Content-Type: application/x-www-form-urlencoded' --data-raw "token=$token"
Write-Host $r2

for ($i = 1; $i -le 8; $i++) {
	Write-Host "=== GET status try $i ==="
	$ts = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
	$rs = curl.exe -s -w "`nHTTP:%{http_code}" "$base/status?token=$token&$ts"
	Write-Host $rs
	if ($rs -match 'HTTP:200' -and $rs -match '\{') {
		$rs | Out-File -FilePath 'scripts\last-status.json' -Encoding utf8
		Write-Host 'Saved scripts/last-status.json'
		break
	}
	Start-Sleep -Seconds 2
}
