$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root
$python = "E:\WorkSpace\Project_04_专门学习\Project_02_六级\模拟卷\scripts\.venv\Scripts\python.exe"

Write-Host "第一步：构建网站数据与音频..."
& $python (Join-Path $root "scripts\build_site.py")
if ($LASTEXITCODE -ne 0) {
    Write-Host "构建失败，未发布。"
    exit 1
}

Write-Host "第二步：提交并推送..."
git add -A
$staged = git diff --cached --name-only
if (-not $staged) {
    Write-Host "没有变更，无需发布。"
    exit 0
}
git commit -m "更新影子跟读网站"

$proxies = @(
    "http://127.0.0.1:7897",
    "http://127.0.0.1:7890",
    "http://127.0.0.1:7891",
    "http://127.0.0.1:10809",
    "http://127.0.0.1:10808",
    "http://127.0.0.1:1080"
)
$tryList = @($null) + $proxies
$pushed = $false
foreach ($proxy in $tryList) {
    if ($proxy) {
        $port = [int]($proxy.Split(":")[-1])
        $listening = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
            Where-Object { $_.LocalPort -eq $port }
        if (-not $listening) { continue }
        $env:HTTPS_PROXY = $proxy
        $env:HTTP_PROXY = $proxy
    } else {
        $env:HTTPS_PROXY = $null
        $env:HTTP_PROXY = $null
    }
    git push origin main
    if ($LASTEXITCODE -eq 0) { $pushed = $true; break }
    git -c http.version=HTTP/1.1 push origin main
    if ($LASTEXITCODE -eq 0) { $pushed = $true; break }
    Write-Host "推送失败，尝试下一种网络方式..."
}
$env:HTTPS_PROXY = $null
$env:HTTP_PROXY = $null
if (-not $pushed) {
    Write-Host "推送失败：请确认 VPN/代理已开启后重试（或双击本脚本）。"
    exit 1
}
Write-Host "已发布：https://tobeatian.github.io/shadow-reading/"
