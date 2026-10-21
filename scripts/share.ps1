# Serve web/ locally and expose it through a Cloudflare quick tunnel.
# The public https://....trycloudflare.com link is printed in the tunnel output (it changes each run).
# The local port never needs to be reachable from the network; the tunnel only makes outbound HTTPS (443).
param([int]$Port = 0)

if ($Port -eq 0) {
    # Ask the OS for a free port so nothing else on the machine collides with us
    $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
    $listener.Start(); $Port = $listener.LocalEndpoint.Port; $listener.Stop()
}

$root = Join-Path $PSScriptRoot "..\web"
$server = Start-Process python -ArgumentList "-m", "http.server", $Port, "--bind", "127.0.0.1" `
    -WorkingDirectory $root -PassThru -WindowStyle Hidden
Write-Host "Local:  http://localhost:$Port"
try {
    $cloudflared = (Get-Command cloudflared -ErrorAction SilentlyContinue).Source
    if (-not $cloudflared) { $cloudflared = "C:\Program Files (x86)\cloudflared\cloudflared.exe" }
    # http2 runs over TCP 443, which venue/corporate networks allow; the default QUIC uses UDP 7844
    & $cloudflared tunnel --protocol http2 --url "http://localhost:$Port"
} finally {
    Stop-Process -Id $server.Id -ErrorAction SilentlyContinue
}
