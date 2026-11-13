# 发布

这个包通过 **npm trusted publishing（OIDC）** 发布：CI 用短时令牌换取出权限，仓库里不存任何长期 token。

## 一次性准备（只做一次）

### 1. 先手动发一个占位版本

npm 的 trusted publisher 配置挂在**包的设置页**上，而包不存在就没有设置页，首次 OIDC 发布会 404。所以第一个版本必须手动发。

用 `0.0.0` 占位，并把 `latest` 标签留给正式版：

```bash
# 在任意空目录
echo '{ "name": "dsh-exa-web-search", "version": "0.0.0" }' > package.json
npm publish --tag placeholder
```

**`--tag placeholder` 不能省**。否则 `npm install dsh-exa-web-search` 会装到这个空壳，而不是正式版。

### 2. 配置 trusted publisher

```bash
npm trust github dsh-exa-web-search \
  --file release.yml \
  --repo Windsland52/dsh-exa-web-search \
  --allow-publish
```

也可以在 npmjs.com 的包页面 → Settings → Trusted Publisher 里配。

两个硬约束：

- **`--file` 只写文件名**，不带路径，且必须和仓库里的 `.github/workflows/release.yml` 一致。改动文件名会让这层绑定失效。
- **配置后 2 天内必须完成首次成功发布**，否则配置过期作废，只能删掉重建。所以配完尽快打 tag。

## 日常发布

```bash
# 1. 改版本号（0.1.0 → 0.1.1 或 0.2.0）
npm version patch|minor --no-git-tag-version
#    或者手动改 package.json

# 2. 本地确认
npm test
npm run test:install

# 3. 提交并推送
git add -A
git commit -m "chore: release v0.1.1"
git push origin main

# 4. 打 tag 触发发布
git tag v0.1.1
git push origin v0.1.1
```

**tag 的版本必须和 `package.json` 一致**（`v0.1.1` ↔ `"version": "0.1.1"`）。CI 第一步就校验这个，不匹配直接失败。

## CI 做了什么

`release.yml` 分两个 job：

| job | 内容 |
|---|---|
| `pack` | Node 22 上 `npm ci` → 校验 tag 版本 → `npm test` → `npm run test:install` → `npm pack` → 上传 artifact |
| `publish` | Node 24 上下载 artifact → OIDC 发布 → 带 `--provenance` |

**为什么拆开**：发布的就是测过的那份 tarball，`publish` job 里不 checkout、不安装、不构建，唯一的认证是 OIDC。

**为什么 pack 用 22、publish 用 24**：`pack` 要在最低支持版本上产出产物；`publish` 需要 npm ≥ 11.5.1，而 Node 22 自带 npm 10。

## 几个容易踩的坑

**不要给 `setup-node` 加 `registry-url`。** 它会写一个带占位 token 的 `.npmrc`，遮蔽 OIDC 交换，npm 把结果报成 masked E404（PUT 失败但看不出原因）。这个坑排查起来极费时间。

**`--loglevel verbose` 是有用的，别删。** npm 的 trusted-publishing 交换会吞掉自己的错误，只在 verbose 级别打印原因，否则认证失败只会得到一个光秃秃的 `ENEEDAUTH`。

**版本已存在会自动跳过。** 重跑同一个 tag 的 workflow 是安全的，不会报错。

**action 固定到 commit SHA。** 升级时用 GitHub API 核对 SHA 和 tag 是否对应，不要凭 README 抄。

## 故障排查

| 现象 | 原因 |
|---|---|
| `E404` / `masked E404`，PUT 失败 | 多半是 `registry-url` 或残留的 `_authToken` 干扰了 OIDC |
| `ENEEDAUTH`，没有其他信息 | 加 `--loglevel verbose` 看 OIDC 的具体拒绝原因 |
| `npm error GitHub repository must be specified` | 配 trusted publisher 时缺 `--repo owner/repo` |
| tag 推上去但没触发 workflow | 检查 tag 是否以 `v` 开头，以及仓库守卫 `github.repository ==` 是否匹配 |
| 发布成功但 `latest` 指向 0.0.0 | 占位包发的时候忘了 `--tag placeholder` |
