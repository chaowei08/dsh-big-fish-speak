# ============================================================
#  dsh-big-fish-speak 发布上手：本地提交 → GitHub → 公开 npm
#  用法（在终端里跑，或右键用 PowerShell 运行）：
#     .\发布上手.ps1 -GitHubUser 你的GitHub用户名 -Email 你的邮箱
#  跳过 GitHub 只发 npm：加 -SkipGitHub
# ============================================================
param(
  [string]$GitHubUser = '',
  [string]$Email = '',
  [switch]$SkipGitHub
)

$ErrorActionPreference = 'Stop'
$GIT  = 'C:\Program Files\Git\cmd\git.exe'
$DIR  = 'C:\Users\Chaowei\.dsh\big-fish-speak'
$REPO = if ($GitHubUser) { "https://github.com/$GitHubUser/dsh-big-fish-speak.git" } else { '' }

function Say($m) { Write-Host $m -ForegroundColor Cyan }
function Ok($m)  { Write-Host "  [OK] $m" -ForegroundColor Green }
function Warn($m){ Write-Host "  [!]  $m" -ForegroundColor Yellow }

if (-not (Test-Path -LiteralPath $GIT)) { Warn '找不到 git.exe，请先确认 C:\Program Files\Git\cmd\git.exe 存在'; exit 1 }
Set-Location -LiteralPath $DIR

if (-not $SkipGitHub) {
  if (-not $GitHubUser) { $GitHubUser = (Read-Host '你的 GitHub 用户名').Trim() }
  if (-not $Email)      { $Email      = (Read-Host '提交用的邮箱（可与 GitHub 账号一致）').Trim() }
  if (-not $GitHubUser) { Warn '用户名不能为空'; exit 1 }
  $REPO = "https://github.com/$GitHubUser/dsh-big-fish-speak.git"
}

Say ''
Say '========  1/4 本地提交  ========'
& $GIT config --local user.name  "Chaowei"
if ($Email) { & $GIT config --local user.email $Email }
& $GIT add -A
$status = (& $GIT status --porcelain) | Out-String
if ($status.Trim()) {
  & $GIT commit -m "feat: 0.7.1 桌宠音色播报（标点切句 / 按语速衔接 / 逐段校验 / 预热下一段）"
  Ok '已提交'
} else {
  Ok '没有新变更，跳过提交'
}

if (-not $SkipGitHub) {
  Say ''
  Say '========  2/4 关联并推送到 GitHub  ========'
  Say ('仓库地址：' + $REPO)
  Say '（先在 GitHub 网页建一个空仓库，名字必须是 dsh-big-fish-speak，不要勾 README/License）'
  Read-Host '建好后按回车继续'
  $remotes = (& $GIT remote) | Out-String
  if ($remotes -match 'origin') {
    & $GIT remote set-url origin $REPO
    Ok 'origin 已更新'
  } else {
    & $GIT remote add origin $REPO
    Ok 'origin 已添加'
  }
  & $GIT push -u origin main
  Ok '已推送，仓库地址：' + $REPO
}

Say ''
Say '========  3/4 检查 npm 登录  ========'
$who = ''
try { $who = ((& npm whoami --registry https://registry.npmjs.org/ 2>&1) | Out-String).Trim() } catch { $who = '' }
if ($who -and $who -notmatch 'error') {
  Ok ('已登录：' + $who)
} else {
  Warn '尚未登录 npm，现在执行 npm adduser（会打开浏览器或提示输入用户名/密码/OTP）'
  & npm adduser --registry https://registry.npmjs.org/
  $who = ((& npm whoami --registry https://registry.npmjs.org/ 2>&1) | Out-String).Trim()
  Ok ('登录后身份：' + $who)
}

Say ''
Say '========  4/4 发布到 npm  ========'
Say '先自检会发布哪些文件：'
& npm pack --dry-run
$ans = Read-Host '上面列表没问题就输入 y 回车发布'
if ($ans -ne 'y') { Warn '已取消发布'; exit 0 }
& npm publish --registry https://registry.npmjs.org/
Ok '发布完成'

Say ''
Say '========  校验  ========'
Say '在任意机器上：'
Say '  npm view dsh-big-fish-speak version --registry https://registry.npmjs.org/'
Say ''
Say '在 DSH「+ 添加插件」里填：'
Say '  包名：      dsh-big-fish-speak@0.7.1'
Say '  Git 地址：  ' + $(if ($REPO) { $REPO } else { 'https://github.com/<用户名>/dsh-big-fish-speak.git' })
Say ''
Read-Host '按回车关闭'
