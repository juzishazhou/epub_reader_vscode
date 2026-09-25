# 发版流程

## 一次性准备

### 1. 创建 Marketplace 发布者

1. 打开 <https://marketplace.visualstudio.com/manage>，用 Microsoft 或 GitHub 账号登录；
2. **Create publisher**，ID 必须与 `package.json` 里的 `publisher` 完全一致：`ssfg`；
3. 记下发布者 ID，之后改 `package.json` 时不要再改。

### 2. 创建 Personal Access Token (PAT)

1. 打开 <https://dev.azure.com>，右上角 User settings → **Personal access tokens** → New Token；
2. Organization 选 **All accessible organizations**；
3. Scopes 选 **Custom defined**，展开 **Marketplace** 勾选 **Manage**；
4. 生成后立刻复制（只显示一次）。

本地登录（token 存进系统凭据管理器，之后不用再输）：

```powershell
npx --yes @vscode/vsce login ssfg
```

CI 用的话，把它存成 GitHub 仓库的 secret：**Settings → Secrets and variables → Actions → New repository secret**，
名字 `VSCE_PAT`。

### 3. GitHub 仓库

仓库已初始化并配好 remote，首次推送：

```powershell
git push -u origin main
```

## 发版

### 自动（推荐）

```powershell
npm version patch    # 或 minor / major；会改 package.json 并提交 + 打 tag
git push --follow-tags
```

推送 tag 后 `.github/workflows/release.yml` 会：编译 → 跑测试 → `vsce publish` → 用同一个 `.vsix`
创建 GitHub Release。**前提是已经配好 `VSCE_PAT` secret**，否则只有 Release，Marketplace 那步会失败。

### 手动

```powershell
npm run verify                       # 编译 + 契约检查 + 全部测试
npm run vsix                         # 生成 epub-reader-x.y.z.vsix
npx --yes @vscode/vsce publish --no-dependencies   # 需要 VSCE_PAT 或已 vsce login
```

只想发个测试包、不进 Marketplace：

```powershell
npx --yes @vscode/vsce package --no-dependencies --allow-missing-repository -o epub-reader-0.1.0.vsix
code --install-extension epub-reader-0.1.0.vsix --force
```

## 首版检查清单

- [ ] `package.json` 的 `publisher` 与 Marketplace 上的 ID 一致（`ssfg`）
- [ ] `version` 与 `CHANGELOG.md` 里的条目对应
- [ ] `media/icon.png` 是 128×128 PNG（`npm run icon` 可重新生成）
- [ ] README 里的相对图片路径能被 vsce 改写成 GitHub raw 链接（依赖 `repository` 字段与默认分支名）
- [ ] `npm run verify` 全绿
- [ ] `npx --yes @vscode/vsce ls` 看一眼打包内容，确认没有多余的测试与脚本
- [ ] 截图是最新的（`npm run screenshot`）

## 打包规则备忘

`.vscodeignore` 决定哪些文件进 `.vsix`：

- **进包**：`out/**`（编译产物）、`media/**`、`docs/**`（README 截图，本地扩展详情页要用）、
  `README.md`、`CHANGELOG.md`、`LICENSE`、`DEVELOPMENT.md`、`RELEASING.md`、`package.json`
- **不进包**：`src/**`、`scripts/**`、`preview/**`、`out/src/test/**`、`node_modules/**`、
  各种配置与锁文件

改版本后本地的扩展不会自动更新：重新 `code --install-extension ... --force` 然后
`Developer: Reload Window`。
