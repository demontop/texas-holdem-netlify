# 网页版德州扑克

可部署到 Cloudflare 的多人联网德州扑克。前端放在 `public/`，账号、牌桌、机器人、下注和结算状态由 Cloudflare Worker + Durable Object 统一处理，前端始终请求同源 `/api/*`。

## 功能

- 账号注册与登录，密码使用 Web Crypto PBKDF2 哈希存储。
- 第一个注册用户自动成为管理员，也可用 `ADMIN_INVITE_CODE` 作为管理员邀请码。
- 大厅创建牌桌、加入牌桌、离桌、解散空桌或本人创建的牌桌。
- 开桌只支持 3/5/7/9 人奇数桌，主视角左右座位成对对齐。
- 一名玩家同一时间只能坐在一张牌桌。
- 支持翻前、翻牌、转牌、河牌、弃牌、看牌、跟注、加注、全下、结算。
- 牌桌状态通过 Cloudflare Durable Object WebSocket Hibernation 实时广播，断线时自动降级到 HTTP 兜底轮询。
- 管理员后台可给玩家充值或扣减筹码，也可给牌桌添加机器人陪玩。
- 管理员后台可配置 BGM、玩家动作音效和每条快捷语的独立音效；玩家可在牌桌内自行静音或开启 BGM。
- 牌桌无人时会自动解散。

## 本地运行

安装依赖：

```bash
npm install
```

Cloudflare 本地运行：

```bash
npm run cf:dev
```

打开 Wrangler 输出的本地地址，通常是：

```text
http://localhost:8787
```

旧的 Node/Netlify 本地开发入口仍保留：

```bash
npm run dev
```

## Cloudflare 部署

1. 登录 Cloudflare：

```bash
npx wrangler login
```

2. 可先做一次部署检查：

```bash
npm run cf:dry-run
```

3. 部署：

```bash
npm run cf:deploy
```

部署完成后，Cloudflare 会同时发布静态前端和 Worker API。前端继续使用 `/api`，不需要额外配置接口域名。

## 管理员

- 第一个注册账号会自动成为管理员。
- 如需邀请码，在 Cloudflare Worker 的变量里添加 `ADMIN_INVITE_CODE`。
- 管理员入口在页面右上角，可充值、扣筹码、查看审计记录、添加机器人。

## Unity WebGL 迁移

如果后续改成 Unity WebGL，直接把 Unity WebGL 构建产物放进 `public/` 或 `public/game/`，在 Unity 里继续请求同源 `/api/*` 即可复用这套账号和牌桌后端。

## 说明

Cloudflare Durable Object 里的数据和之前 Netlify Blobs 数据不是同一个存储，迁移到 Cloudflare 后会从新库开始。当前版本适合演示、私密小局和继续商业化前的产品验证；如果要做公开大规模竞技或真钱场景，还需要继续补充风控、防作弊、审计和合规能力。
