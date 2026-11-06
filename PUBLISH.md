# 发布手册 · dsh-big-fish-speak

三条分发路线，可任选、可组合。三条的产物都指向同一份源码：`C:\Users\Chaowei\.dsh\big-fish-speak\`。

## 0. 共同前置：改包名与作者信息

发布到任何 registry 之前，先决定包名。公开 npm 上 `dsh-big-fish-speak` 若已被占用，改带 scope 的形式：

```json
"name": "@你的scope/dsh-big-fish-speak"
```

`package.json` 需要补的字段（`files` / `exports` / `dsh` / `engines` 已有，不用动）：

```json
"author": "Chaowei",
"repository": { "type": "git", "url": "git+https://github.com/<用户名>/dsh-big-fish-speak.git" },
"homepage": "https://github.com/<用户名>/dsh-big-fish-speak#readme",
"bugs": { "url": "https://github.com/<用户名>/dsh-big-fish-speak/issues" }
```

`files` 已经限定为 `index.js` / `cordis.patch.yml` / `README.md` / `icon.svg`，`LICENSE` 由 npm 自动附带，`settings.json` 和 tgz 不会进包。

---

## 路线 A：GitHub 仓库（成本最低，DSH 直接填 Git 地址装）

### A1. 装 Git（本机当前没有）

```powershell
winget install --id Git.Git -e --accept-source-agreements --accept-package-agreements
```

装完**新开一个终端**，确认 `git --version` 有输出。

### A2. 首次提交并推送

```powershell
cd C:\Users\Chaowei\.dsh\big-fish-speak
git init -b main
git config user.name  "Chaowei"
git config user.email "你的邮箱"
git add .
git commit -m "feat: 0.7.1 桌宠音色播报"
git remote add origin https://github.com/<用户名>/dsh-big-fish-speak.git
git push -u origin main
```

仓库先在 GitHub 网页上建（空仓库、不要勾 README），地址才能用。

### A3. 在 DSH 里用它

「+ 添加插件」填：

```
https://github.com/<用户名>/dsh-big-fish-speak.git
```

DSH 会让 pnpm 从 git 拉一份拷进 `node_modules`——**是真拷贝，本地目录删了也不影响运行**。改代码后 `git push` + 在 DSH 里重装（或升级版本号）即可。

### A4. 以后发版

```powershell
git tag v0.7.2
git push origin v0.7.2
```

DSH 若填带 tag 的地址（`https://github.com/<用户名>/dsh-big-fish-speak.git#v0.7.2`）可锁定版本。

---

## 路线 B：自己的私有 registry（Verdaccio，只在自己/局域网内流通）

适合不想公开、但要"填包名就能装"的场景。

### B1. 装 Verdaccio（一次性）

```powershell
npm install -g verdaccio
verdaccio
```

默认监听 `http://localhost:4873`，配置文件在 `%APPDATA%\verdaccio\config.yaml`。

### B2. 建账号并发布

```powershell
npm adduser --registry http://localhost:4873
npm publish --registry http://localhost:4873
```

### B3. 让 DSH 认这个 registry

在 `C:\Users\Chaowei\.dsh\profiles\desktop\pnpm-workspace.yaml` 同目录建 `.npmrc`：

```
registry=http://localhost:4873/
```

然后「+ 添加插件」填包名 `dsh-big-fish-speak@0.7.1` 即可（DSH 会用配置里的 registry 去拉）。

> 注意：Verdaccio 必须常驻运行，DSH 装插件时它不在线就会失败。DSH 升级/重装依赖时也一样。

---

## 路线 C：公开 npm（一次发布，任何机器填包名就装回）

### C1. 登录

```powershell
npm adduser --registry https://registry.npmjs.org/
npm whoami
```

### C2. 发布前自检（不真正上传）

```powershell
cd C:\Users\Chaowei\.dsh\big-fish-speak
npm pack --dry-run
```

确认列表里**只有** `index.js` / `cordis.patch.yml` / `README.md` / `icon.svg` / `LICENSE` / `package.json`，没有 `settings.json`、没有 tgz、没有 `index.js.bak`。

### C3. 发布

```powershell
npm publish --registry https://registry.npmjs.org/
```

带 scope 的包默认是私有，公开要加：

```powershell
npm publish --access public --registry https://registry.npmjs.org/
```

### C4. 国内下载慢的解法

DSH 侧不用配镜像；如果你自己用 npm CLI 装，可：

```powershell
npm config set registry https://registry.npmmirror.com/
```

npmmirror 会同步 npm 公开包（有几分钟延迟），私有 scope 不会同步。

### C5. 以后发版

```powershell
npm version patch   # 或 minor / major
npm publish --registry https://registry.npmjs.org/
```

`0.7.1` → `0.7.2` 这种补丁级即可，DSH 里填 `dsh-big-fish-speak@0.7.2` 锁定。

---

## 三条路线对比

| | 路线 A（GitHub） | 路线 B（Verdaccio） | 路线 C（公开 npm） |
|---|---|---|---|
| 装一次要多久 | 装 git + 建仓库，10 分钟 | 装 verdaccio + 起服务，10 分钟 | 注册 + 发布，5 分钟 |
| 换机器重装 | 填同一个 Git 地址 | 填包名（且 registry 可达） | 填包名 |
| 需要常驻服务 | 否 | **是** | 否 |
| 别人能用吗 | 仓库公开就能 | 只有你能（除非开端口） | 任何人 |
| 改代码后怎么生效 | push + 重装 | publish + 重装 | publish + 重装 |
| 风险 | 无 | 服务挂了装不上 | 包名被占、公开后不可撤回（只能 deprecate） |

## 建议顺序

先走 **A（GitHub）**：一次 push 就有异地备份 + 可重装地址，还能顺手当版本管理。
再走 **C（公开 npm）**：真正"一条包名装回"，但要先定 scope、确认 `npm pack --dry-run` 干净。
**B 只在你有"局域网多机部署"需求时才值得**，因为它要求 verdaccio 一直开着。

## 已经准备好的东西

- `LICENSE`（MIT）、`.gitignore`（排除 settings.json / tgz / 备份文件）
- `package.json` 的 `files`、`exports`、`dsh.bundle.patch`、`engines` 已齐
- 本手册

## 还缺的（需要你提供）

1. GitHub 用户名（决定 `repository` / `homepage` / `bugs` 三个 URL）
2. npm 账号（已有还是要新注册）、以及是否要带 scope
3. 是否允许我在这台机器上 `winget install Git`
