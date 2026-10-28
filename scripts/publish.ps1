<#
.SYNOPSIS
    把「小手机」发布到 GitHub。

.DESCRIPTION
    三种认证方式，任选一种：

    1) Personal Access Token（最通用）
       .\scripts\publish.ps1 -Token ghp_xxxxxxxx

       生成地址：https://github.com/settings/tokens
       勾选权限：repo（classic）或 Contents: Read and write（fine-grained）

    2) 已装 gh CLI
       .\scripts\publish.ps1 -Gh
       （如果还没登录，先跑 gh auth login）

    3) SSH key
       .\scripts\publish.ps1 -Ssh
       （先把 ~/.ssh/id_ed25519.pub 加到 https://github.com/settings/keys）

.EXAMPLE
    .\scripts\publish.ps1 -Token $env:GITHUB_TOKEN

.EXAMPLE
    .\scripts\publish.ps1 -Gh -Private
#>
[CmdletBinding()]
param(
    [string]$Token = $env:GITHUB_TOKEN,
    [string]$User = 'GGGFFF-Create',
    [string]$Repo = 'mini-phone',
    [string]$Description = '给酒馆装一部小手机：角色在正文里发消息，手机上真的收到',
    [switch]$Private,
    [switch]$Gh,
    [switch]$Ssh
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Push-Location $root
try {
    # ---------------------------------------------------------- 前置检查
    if (-not (Test-Path '.git')) { throw "这个目录还不是 git 仓库。先跑 git init -b main" }

    $dirty = git status --porcelain
    if ($dirty) {
        Write-Host "有未提交的改动：" -ForegroundColor Yellow
        $dirty | ForEach-Object { Write-Host "  $_" }
        $ans = Read-Host '先提交再发布吗？(y/n)'
        if ($ans -eq 'y') {
            $m = Read-Host '提交信息'
            if (-not $m) { $m = 'chore: 更新' }
            git add -A
            git commit -q -m $m
        } else {
            throw '先提交再发布'
        }
    }

    $branch = (git rev-parse --abbrev-ref HEAD).Trim()
    if ($branch -ne 'main') {
        Write-Host "当前分支是 $branch，切到 main" -ForegroundColor Yellow
        git branch -M main
        $branch = 'main'
    }

    $remote = git remote get-url origin 2>$null
    $exists = $false
    if ($remote) {
        Write-Host "已有 origin: $remote" -ForegroundColor DarkGray
        $exists = $true
    }

    $visibility = if ($Private) { 'private' } else { 'public' }
    $repoUrl = "https://github.com/$User/$Repo"

    # ---------------------------------------------------------- 方式一：gh CLI
    if ($Gh) {
        $gh = Get-Command gh -ErrorAction SilentlyContinue
        if (-not $gh) { throw 'gh CLI 没装。用 -Token 方式，或者先装 gh：winget install GitHub.cli' }

        $status = gh auth status 2>&1 | Out-String
        if ($status -match 'not logged') { throw 'gh 还没登录。先跑：gh auth login' }

        if (-not $exists) {
            Write-Host "用 gh 创建仓库 $User/$Repo（$visibility）…" -ForegroundColor Cyan
            gh repo create "$User/$Repo" "--$visibility" --source . --remote origin --description $Description --push
            Write-Host "`n✓ 已发布：$repoUrl" -ForegroundColor Green
            return
        }
    }

    # ---------------------------------------------------------- 方式二：SSH
    if ($Ssh) {
        $key = Get-ChildItem "$env:USERPROFILE\.ssh\id_*.pub" -ErrorAction SilentlyContinue | Select-Object -First 1
        if (-not $key) {
            Write-Host '没有 SSH key，正在生成…' -ForegroundColor Cyan
            New-Item -ItemType Directory -Force -Path "$env:USERPROFILE\.ssh" | Out-Null
            ssh-keygen -t ed25519 -C "miniPhone@local" -f "$env:USERPROFILE\.ssh\id_ed25519" -N '""'
            $key = Get-Item "$env:USERPROFILE\.ssh\id_ed25519.pub"
        }
        Write-Host "`n把下面这行加到 https://github.com/settings/keys ：`n" -ForegroundColor Yellow
        Get-Content $key.FullName
        Write-Host ''
        Read-Host '加好之后按回车继续'

        if (-not $exists) {
            Write-Host 'SSH 方式需要先在网页上创建仓库，然后回来推：' -ForegroundColor Yellow
            Write-Host "  $repoUrl/new  →  名字填 $Repo  →  不要勾任何初始化选项"
            Read-Host '建好之后按回车继续'
            git remote add origin "git@github.com:$User/$Repo.git"
        } else {
            git remote set-url origin "git@github.com:$User/$Repo.git"
        }

        git push -u origin main
        Write-Host "`n✓ 已发布：$repoUrl" -ForegroundColor Green
        return
    }

    # ---------------------------------------------------------- 方式三：Token
    if (-not $Token) {
        Write-Host ''
        Write-Host '需要 GitHub 认证才能推送（这是唯一需要你亲自做的一步）。' -ForegroundColor Yellow
        Write-Host ''
        Write-Host '三步：' -ForegroundColor Cyan
        Write-Host '  1. 打开 https://github.com/settings/tokens'
        Write-Host '  2. Generate new token (classic) → 勾上 repo → 拉到底点 Generate'
        Write-Host '  3. 把生成的那串（ghp_ 开头）粘到下面'
        Write-Host ''
        Write-Host '粘进来的 token 只在这次推送里用，不会存到任何文件。' -ForegroundColor DarkGray
        Write-Host ''

        # -AsSecureString 让输入不回显
        $secure = Read-Host 'Token' -AsSecureString
        if (-not $secure -or $secure.Length -eq 0) { throw '没有输入 token' }

        $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
        try { $Token = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) }
        finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }

        $Token = "$Token".Trim()
        if (-not $Token) { throw 'token 是空的' }
    }

    $headers = @{
        Authorization          = "token $Token"
        Accept                 = 'application/vnd.github+json'
        'User-Agent'           = 'mini-phone-publish'
        'X-GitHub-Api-Version' = '2022-11-28'
    }

    # 验证 token
    Write-Host '验证 token…' -ForegroundColor Cyan
    try {
        $me = Invoke-RestMethod -Uri 'https://api.github.com/user' -Headers $headers -TimeoutSec 20
        Write-Host "  已登录为 $($me.login)" -ForegroundColor DarkGray
    } catch {
        throw "token 无效或网络不通：$($_.Exception.Message)"
    }

    # 仓库不存在才创建
    if (-not $exists) {
        Write-Host "创建仓库 $User/$Repo（$visibility）…" -ForegroundColor Cyan
        $body = @{
            name        = $Repo
            description = $Description
            private     = [bool]$Private
            auto_init   = $false
        } | ConvertTo-Json

        try {
            Invoke-RestMethod -Uri 'https://api.github.com/user/repos' -Method Post -Headers $headers -Body $body -ContentType 'application/json' -TimeoutSec 30 | Out-Null
            Write-Host '  仓库已创建' -ForegroundColor DarkGray
        } catch {
            $detail = $_.ErrorDetails.Message
            if ($detail -match 'already exists') {
                Write-Host '  仓库已存在，直接推送' -ForegroundColor DarkGray
            } else {
                throw "创建仓库失败：$detail"
            }
        }

        git remote remove origin 2>$null
        git remote add origin "https://github.com/$User/$Repo.git"
    }

    # 推送时把 token 塞进 URL，但不写进配置文件
    Write-Host '推送…' -ForegroundColor Cyan
    # ${User} 明确变量边界 —— 不用反引号，省得被当续行符
    $pushUrl = "https://${User}:${Token}@github.com/$User/$Repo.git"
    git push $pushUrl "main:main" --force-with-lease 2>&1 | ForEach-Object { Write-Host "  $_" -ForegroundColor DarkGray }

    if ($LASTEXITCODE -ne 0) {
        Write-Host 'push 失败，试一次不带 lease 的：' -ForegroundColor Yellow
        git push $pushUrl "main:main"
    }

    Write-Host "`n✓ 已发布：$repoUrl" -ForegroundColor Green
    Write-Host "  提交：$(git log --oneline -1)" -ForegroundColor DarkGray
    Write-Host "`n下一步：在仓库页面 Settings → 确认默认分支是 main" -ForegroundColor Cyan
}
finally {
    Pop-Location
}
