# Fixed Referral Swap

独立固定 Swap 页面：只支持 `USDT -> 0x6cBf442EaA9539Ff93ba2dd7726933bB7b66FeeD` 买入，以及卖出该代币换回 USDT。后台可以创建独立推荐链接，并按推荐码统计买入钱包、买入 USDT 总额、买入次数、1% 佣金和结算记录。卖出不参与推广统计和佣金结算。

## 运行

```bash
npm install
npm run build
npm start
```

默认服务地址：

- 前台：`http://127.0.0.1:8787/?ref=你的推荐码`
- 后台：`http://127.0.0.1:8787/admin`

如果 `8787` 被占用：

```bash
$env:PORT="8791"
npm start
```

## 后台

后台接口强制要求管理员密码。没有设置 `ADMIN_PASSWORD` 时，不能创建推荐链接，也不能读取后台统计。

```bash
$env:ADMIN_PASSWORD="your-password"
npm start
```

设置后，`/admin` 页面填入这个密码再刷新或创建链接。普通用户只能通过管理员创建好的 `/?ref=推荐码` 链接进入前台，不能自己创建专属链接。

## Coolify 部署

仓库包含 `Dockerfile`，Coolify 选择 Dockerfile 部署即可。

必须设置环境变量：

```bash
ADMIN_PASSWORD=your-admin-password
PORT=8787
```

可选环境变量：

```bash
CHAIN_ID=56
CHAIN_NAME=BNB Smart Chain
RPC_URL=https://bsc-dataseed.binance.org
ROUTER_ADDRESS=0x10ED43C718714eb63d5aA57B78B54704E256024E
USDT_ADDRESS=0x55d398326f99059fF775485246999027B3197955
TARGET_TOKEN_ADDRESS=0x6cBf442EaA9539Ff93ba2dd7726933bB7b66FeeD
TARGET_TOKEN_DISPLAY=0x6cBf442EaA9539Ff93ba2dd7726933bB7b66FeeD
COMMISSION_RATE=0.01
```

统计数据写入容器内 `/app/data/stats.json`。生产环境建议在 Coolify 给 `/app/data` 挂载持久化存储，否则重新部署容器可能丢失统计数据。

## 链上配置

默认配置为 BNB Smart Chain：

- `CHAIN_ID=56`
- `ROUTER_ADDRESS=0x10ED43C718714eb63d5aA57B78B54704E256024E`
- `USDT_ADDRESS=0x55d398326f99059fF775485246999027B3197955`
- `TARGET_TOKEN_ADDRESS=0x6cBf442EaA9539Ff93ba2dd7726933bB7b66FeeD`

可以用环境变量覆盖：

```bash
$env:RPC_URL="https://bsc-dataseed.binance.org"
$env:TARGET_TOKEN_ADDRESS="0x6cBf442EaA9539Ff93ba2dd7726933bB7b66FeeD"
$env:TARGET_TOKEN_DISPLAY="0x6cBf442EaA9539Ff93ba2dd7726933bB7b66FeeD"
npm start
```

## 统计说明

统计数据保存在 `data/stats.json`。前台通过推荐链接进入后会保存 `ref`，钱包连接后绑定钱包；买入交易确认后记录 `txHash`、钱包、USDT 数量和代币数量。卖出交易不会进入推广统计。

当前版本是前台交易完成后的应用内统计，不是全链上索引器。如果有人绕过这个页面直接去 PancakeSwap 买卖，不会自动进入统计。
