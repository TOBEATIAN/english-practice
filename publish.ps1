$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root
$python = "E:\WorkSpace\Project_04_专门学习\Project_02_六级\模拟卷\scripts\.venv\Scripts\python.exe"

Write-Host "第一步：构建跟读站数据与音频..."
& $python (Join-Path $root "scripts\build_site.py")
if ($LASTEXITCODE -ne 0) {
    Write-Host "构建失败，未发布。"
    exit 1
}

# 顺序说明（2026-09-25 修）：音标库的输入是刚生成的 web\vocab.json，
# 所以必须先出卡 → 补音标 → 再出一次卡把音标写进去。反过来跑会漏掉当天的新词。
Write-Host "第二步：生成生词复习库（第一遍：先出卡，允许暂时缺音标）..."
& node (Join-Path $root "scripts\build_vocab_deck.js") "--ipa-min=0"
if ($LASTEXITCODE -ne 0) {
    Write-Host "生词库构建失败，未发布（先看上面 [FAIL] 的具体原因）。"
    exit 1
}

Write-Host "第三步：补新词音标（读刚生成的词库，已有的不覆盖）..."
& $python (Join-Path $root "scripts\build_ipa.py")
if ($LASTEXITCODE -ne 0) {
    Write-Host "音标库构建失败，未发布（缺 eng_to_ipa 时装一下：模拟卷\scripts\.venv\Scripts\python.exe -m pip install eng_to_ipa）。"
    exit 1
}

Write-Host "第四步：重建生词复习库（第二遍：把音标写进卡里）..."
& node (Join-Path $root "scripts\build_vocab_deck.js")
if ($LASTEXITCODE -ne 0) {
    Write-Host "生词库构建失败，未发布（音标覆盖率低于门槛时会卡在这里，按上面提示补 docs\生词_音标库.json）。"
    exit 1
}

Write-Host "第五步：提交并推送..."
git add -A
$staged = git diff --cached --name-only
if (-not $staged) {
    Write-Host "没有变更，无需发布。"
    exit 0
}
git commit -m "更新英语练习台网站"

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
Write-Host "已发布：https://tobeatian.github.io/english-practice/"
