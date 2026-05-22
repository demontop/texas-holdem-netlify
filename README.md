# 网页版德州扑克

一个可部署到 Netlify 的多人联网德州扑克 MVP，包含账号注册、登录、多人牌桌、管理员筹码充值后台和拟真筹码/牌桌 UI。

## 功能

- 账号注册与登录，密码使用 salt + scrypt 哈希存储。
- 第一个注册用户自动成为管理员。
- 大厅创建牌桌、加入牌桌、开始手牌。
- 支持翻前、翻牌、转牌、河牌、弃牌、看牌、跟注、加注、全下。
- 支持多人轮询联网对战，Netlify 部署后使用 Netlify Blobs 持久化数据。
- 管理员后台可给用户充值或扣减筹码，并保留审计记录。

## 本地运行

当前项目不依赖前端打包器，直接用 Node 即可运行：

```bash
node scripts/dev-server.mjs
```

然后打开：

```text
http://localhost:8888
```

如果你的环境有 npm，也可以运行：

```bash
npm run dev
```

本地数据会保存在 `.data/poker-db.json`，该目录已加入 `.gitignore`。

## Netlify 部署

1. 将仓库推送到 GitHub。
2. 在 Netlify 新建站点并连接该 GitHub 仓库。
3. Build command 使用 `npm run build`。
4. Publish directory 使用 `public`。
5. Functions directory 使用 `netlify/functions`。

部署后，Netlify Functions 会通过 `@netlify/blobs` 保存账号、牌桌和审计数据。

## 管理员

- 第一个注册账号会自动成为管理员。
- 管理员入口在页面右上角。
- 充值金额为正数时增加钱包筹码，为负数时扣减钱包筹码。

## 说明

这是一个适合演示、私密小局和继续二次开发的 MVP。若要做真钱、公开大规模竞技或强监管场景，还需要补充更严格的事务一致性、防作弊、限流、日志和合规能力。
