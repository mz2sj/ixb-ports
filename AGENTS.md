# ixb-ports

本仓库把用户提供的 Clash 订阅拆成多个本机 SOCKS5 端口，供 ixBrowser 粘贴。克隆后按下面做就能用，不要再改协议或去动用户原来的上网配置。

## 启动

1. 确认本机有 Node.js 18+ 和 mihomo。没有 mihomo 时，macOS 用 `brew install mihomo`。二进制不在默认路径时设置 `MIHOMO_BIN`。
2. 在仓库根目录执行 `npm install`，然后 `npm start`。
3. 页面在 http://127.0.0.1:8787 。向用户要 Clash 订阅链接，让用户自己贴上，或由用户明确同意后调用 `POST /api/subscribe`，JSON 体为 `{ "url": "..." }`。
4. 订阅必须是 Clash YAML（可被 base64 包住）。`ss://`、`vmess://` 这类分享链接不能用。

服务要保持运行。用户的 ixBrowser 依赖这些端口。

## 交给 ixBrowser 的文本

复制 `127.0.0.1:42001`。不要复制 `socks5://127.0.0.1:42001`。

ixBrowser 添加框：

- 代理类型选 SOCKS5
- 主机 `127.0.0.1`，端口为该节点的本地端口
- 账号和密码留空
- 「使用系统代理」选「不使用」

`GET /api/state` 的每个节点里，`socks` 字段已经是 `127.0.0.1:端口`。

## 不要做的事

- 不要修改系统代理，不要打开 TUN，不要改用户原来的 Clash / mihomo（常见端口 `7890`、`7892`、`9090`）。
- 不要杀掉命令行里不包含本仓库 `data/runtime.yaml` 的 mihomo。本程序只管理自己拉起的那一个进程。
- 不要提交或粘贴 `data/`。里面有订阅链接、节点密码和 `runtime.yaml`。
- 不要把端口从 `42001` 重新编号。`data/ports.json` 保证同一节点刷新后仍用原端口。

## 本程序占用的端口

只监听 `127.0.0.1`：

- `8787`：页面（`IXB_PORT`）
- `19091`：这份 mihomo 的控制接口
- `42001` 起，每个节点一个 SOCKS5

`IXB_DATA` 可改数据目录，默认是仓库下的 `data/`。
