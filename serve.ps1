param([int]$Port = 8000)

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$Port/")
try {
  $listener.Start()
} catch {
  Write-Host "Failed to bind to http://localhost:$Port/ — $($_.Exception.Message)"
  exit 1
}
Write-Host "Serving $root on http://localhost:$Port/"

$mime = @{
  ".html" = "text/html; charset=utf-8"
  ".htm"  = "text/html; charset=utf-8"
  ".css"  = "text/css; charset=utf-8"
  ".js"   = "application/javascript; charset=utf-8"
  ".mjs"  = "application/javascript; charset=utf-8"
  ".json" = "application/json; charset=utf-8"
  ".svg"  = "image/svg+xml"
  ".png"  = "image/png"
  ".jpg"  = "image/jpeg"
  ".jpeg" = "image/jpeg"
  ".gif"  = "image/gif"
  ".ico"  = "image/x-icon"
  ".webp" = "image/webp"
  ".woff" = "font/woff"
  ".woff2" = "font/woff2"
  ".map"  = "application/json"
}

while ($listener.IsListening) {
  try {
    $ctx = $listener.GetContext()
  } catch {
    break
  }
  $req = $ctx.Request
  $res = $ctx.Response
  try {
    $path = [System.Uri]::UnescapeDataString($req.Url.AbsolutePath)
    if ($path -eq "/" -or $path.EndsWith("/")) { $path = $path + "index.html" }
    $relative = $path.TrimStart("/").Replace("/", "\")
    $file = Join-Path $root $relative

    $fullRoot = [System.IO.Path]::GetFullPath($root)
    $fullFile = [System.IO.Path]::GetFullPath($file)
    if (-not $fullFile.StartsWith($fullRoot)) {
      $res.StatusCode = 403
      $res.Close()
      continue
    }

    if (Test-Path $file -PathType Leaf) {
      $ext = [System.IO.Path]::GetExtension($file).ToLower()
      if ($mime.ContainsKey($ext)) {
        $res.ContentType = $mime[$ext]
      } else {
        $res.ContentType = "application/octet-stream"
      }
      $bytes = [System.IO.File]::ReadAllBytes($file)
      $res.ContentLength64 = $bytes.Length
      $res.OutputStream.Write($bytes, 0, $bytes.Length)
      Write-Host "$([DateTime]::Now.ToString('HH:mm:ss')) 200 $path"
    } else {
      $res.StatusCode = 404
      $msg = [System.Text.Encoding]::UTF8.GetBytes("404 Not Found: $path")
      $res.OutputStream.Write($msg, 0, $msg.Length)
      Write-Host "$([DateTime]::Now.ToString('HH:mm:ss')) 404 $path"
    }
  } catch {
    try {
      $res.StatusCode = 500
      $msg = [System.Text.Encoding]::UTF8.GetBytes("500: $($_.Exception.Message)")
      $res.OutputStream.Write($msg, 0, $msg.Length)
    } catch {}
  } finally {
    try { $res.Close() } catch {}
  }
}
