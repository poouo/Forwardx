<div align="center">

# ForwardX

**Linux 绔彛杞彂闆嗕腑绠＄悊闈㈡澘**

杞婚噺銆佺幇浠ｃ€佸紑绠卞嵆鐢ㄧ殑绔彛杞彂绠＄悊鏂规锛屾敮鎸?iptables / realm / socat 涓夌杞彂寮曟搸锛?
閫氳繃 Agent 瀹炵幇澶氫富鏈虹粺涓€绠℃帶銆?

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-22+-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7+-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Docker](https://img.shields.io/badge/Docker-Ready-2496ED?logo=docker&logoColor=white)](https://www.docker.com/)

[English](#english) 路 [鍔熻兘鐗规€(#鍔熻兘鐗规€? 路 [蹇€熷紑濮媇(#蹇€熷紑濮? 路 [浣跨敤鎸囧崡](#浣跨敤鎸囧崡) 路 [椤圭洰鏋舵瀯](#椤圭洰鏋舵瀯) 路 [璐＄尞鎸囧崡](CONTRIBUTING.md)

</div>

---

## 鍔熻兘鐗规€?

### 澶氬紩鎿庤浆鍙?

ForwardX 鏀寔涓夌涓绘祦绔彛杞彂宸ュ叿锛屽彲鏍规嵁鍦烘櫙鐏垫椿閫夋嫨锛?

| 杞彂寮曟搸 | 鍗忚鏀寔 | 鐗圭偣 |
|---------|---------|------|
| **iptables** | TCP / UDP / Both | 鍐呮牳绾?DNAT 杞彂锛屾€ц兘鏈€浼橈紝闆堕澶栦緷璧?|
| **realm** | TCP / UDP / Both | 鐢ㄦ埛鎬侀珮鎬ц兘浠ｇ悊锛屾敮鎸侀浂鎷疯礉锛孉gent 鑷姩涓嬭浇瀹夎 |
| **socat** | TCP / UDP / Both | 閫氱敤缃戠粶鐟炲＋鍐涘垁锛屽吋瀹规€ф渶骞?|

### 鏍稿績鑳藉姏

| 鍔熻兘妯″潡 | 璇存槑 |
|---------|------|
| **浠〃鐩?* | 鍏抽敭鎸囨爣鎬昏銆佷富鏈哄湪绾跨巼/瑙勫垯娲昏穬鐜囩幆褰㈠浘銆佹渶杩戜富鏈轰笌瑙勫垯鍒楄〃 |
| **澶氫富鏈虹鐞?* | 閫氳繃 Agent 缁熶竴绠℃帶澶氬彴 Linux 鏈嶅姟鍣紝鏀寔涓绘帶鏈?琚帶鏈鸿鑹?|
| **杞彂瑙勫垯** | 鍙鍖栧垱寤?缂栬緫/鍚仠杞彂瑙勫垯锛屾敮鎸佷笁绉嶅紩鎿庡拰 TCP/UDP/Both 鍗忚 |
| **瀹炴椂鐩戞帶** | Agent 鍛ㄦ湡鎬т笂鎶?CPU銆佸唴瀛樸€佺綉缁溿€佺鐩樼瓑涓绘満鎸囨爣 |
| **娴侀噺缁熻** | 鍩轰簬 iptables 璁℃暟閾剧簿纭粺璁℃瘡鏉¤鍒欑殑鍏ュ悜/鍑哄悜娴侀噺锛屾敮鎸佽秼鍔垮浘琛?|
| **娴侀噺绠＄悊** | 鏀寔鐢ㄦ埛娴侀噺棰濆害闄愬埗銆佸埌鏈熸椂闂磋缃€佹祦閲忚嚜鍔?鎵嬪姩閲嶇疆 |
| **杩為€氭€ф娴?* | 涓€閿嚜娴嬭浆鍙戦摼璺紝妫€娴嬬洰鏍囩鍙?TCP 鍙揪鎬у拰 tcping 寤惰繜 |
| **澶氱敤鎴锋潈闄?* | 绠＄悊鍛?鏅€氱敤鎴疯鑹插垎绂伙紝鏀寔寮€鏀炬敞鍐屻€佺粏绮掑害鏉冮檺鎺у埗銆佺敤鎴疯鍒欐潯鏁?绔彛鏁伴檺鍒?|
| **Agent 鏉冮檺** | 鏀寔绠＄悊鍛樹负姣忎釜鐢ㄦ埛鍒嗛厤鍙娇鐢ㄧ殑 Agent 涓绘満鏉冮檺锛屽疄鐜拌祫婧愰殧绂?|
| **绔彛绠＄悊** | 鏀寔涓绘満绔彛鍖洪棿闄愬埗锛屾坊鍔犺鍒欐椂鑷姩妫€娴嬬鍙ｅ崰鐢ㄥ苟鏀寔闅忔満鍒嗛厤 |
| **绉诲姩绔€傞厤** | 鍏ㄥ眬鍝嶅簲寮忓竷灞€锛屽畬缇庨€傞厤鎵嬫満绔祻瑙堝櫒鎿嶄綔 |
| **閰嶇疆瀵煎叆瀵煎嚭** | 鏀寔 JSON 鏍煎紡鐨勮鍒欏拰涓绘満閰嶇疆澶囦唤涓庢仮澶?|
| **鏆楄壊涓婚** | 鍐呯疆浜壊/鏆楄壊涓婚鍒囨崲锛岃窡闅忕郴缁熷亸濂?|

### Agent 鏋舵瀯

ForwardX 閲囩敤 **Agent 杞鏋舵瀯**锛屾棤闇€鍦ㄩ潰鏉挎湇鍔″櫒涓婇厤缃?SSH 瀵嗛挜锛?

```
鈹屸攢鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹?   蹇冭烦/涓婃姤     鈹屸攢鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹?
鈹? Agent 涓绘満  鈹?鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈫?鈹? ForwardX    鈹?
鈹? (Go Agent)  鈹?鈫愨攢鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€ 鈹? 闈㈡澘鏈嶅姟鍣?  鈹?鈹斺攢鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹?  瑙勫垯涓嬪彂/鍝嶅簲   鈹斺攢鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹?
                                       鈹?
                                  SQLite 瀛樺偍
                                       鈹?
                                 鈹屸攢鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹?
                                 鈹? Web 娴忚鍣? 鈹?
                                 鈹? (React SPA) 鈹?
                                 鈹斺攢鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹?
```

1. 闈㈡澘鐢熸垚 Agent Token锛岄€氳繃涓€閿畨瑁呰剼鏈儴缃插埌鐩爣涓绘満
2. Go Agent 浠?systemd 鏈嶅姟杩愯锛屾瘡 30 绉掑悜闈㈡澘蹇冭烦涓婃姤鐘舵€?3. 闈㈡澘閫氳繃蹇冭烦鍝嶅簲涓嬪彂杞彂瑙勫垯鍙樻洿锛孉gent 鏈湴鎵ц
4. 娴侀噺鏁版嵁銆佷富鏈烘寚鏍囥€佽嚜娴嬬粨鏋滃潎閫氳繃 Agent 涓诲姩涓婃姤

## 鎶€鏈爤

| 灞傜骇 | 鎶€鏈?|
|------|------|
| **鍓嶇** | React 19 + TypeScript + Tailwind CSS 4 + shadcn/ui + Recharts |
| **鍚庣** | Node.js 22 + Express + tRPC 11 |
| **鏁版嵁搴?* | SQLite (better-sqlite3) + Drizzle ORM |
| **鏋勫缓** | Vite 6 (鍓嶇) + esbuild (鍚庣) |
| **閮ㄧ讲** | Docker + Docker Compose |
| **Agent** | Go 甯搁┗绋嬪簭 + Shell 瀹夎/鍗囩骇鍣?|

## 快速开始

ForwardX 面板提供两种部署方式：

- **本地部署**：面板运行在宿主机 systemd 中，适合希望后台直接执行一键升级的场景。
- **Docker 部署**：面板运行在 Docker Compose 中，升级脚本需要在宿主机执行，会覆盖旧容器并以同名容器重新启动。

### 本地部署（一键脚本）

安装：

```bash
curl -fsSL https://raw.githubusercontent.com/poouo/Forwardx/main/scripts/install-panel-local.sh | sudo bash -s -- install
```

升级：

```bash
curl -fsSL https://raw.githubusercontent.com/poouo/Forwardx/main/scripts/install-panel-local.sh | sudo bash -s -- upgrade
```

卸载：

```bash
curl -fsSL https://raw.githubusercontent.com/poouo/Forwardx/main/scripts/install-panel-local.sh | sudo bash -s -- uninstall
```

本地部署默认安装到 `/opt/forwardx-panel`，创建 `forwardx-panel.service`，数据库位于 `/opt/forwardx-panel/data/forwardx.db`。脚本会写入 `FORWARDX_UPGRADE_COMMAND`，因此后台「版本升级」可以直接执行一键升级并重启面板服务。

### Docker 部署（一键脚本）

安装：

```bash
curl -fsSL https://raw.githubusercontent.com/poouo/Forwardx/main/scripts/install-panel-docker.sh | sudo bash -s -- install
```

升级：

```bash
curl -fsSL https://raw.githubusercontent.com/poouo/Forwardx/main/scripts/install-panel-docker.sh | sudo bash -s -- upgrade
```

卸载：

```bash
curl -fsSL https://raw.githubusercontent.com/poouo/Forwardx/main/scripts/install-panel-docker.sh | sudo bash -s -- uninstall
```

Docker 部署默认安装到 `/opt/forwardx-docker`，使用 Compose 项目名 `forwardx` 和容器名 `forwardx-panel`。升级脚本会拉取最新 tag，执行 `docker rm -f forwardx-panel`，然后 `docker compose -p forwardx up -d --build --remove-orphans forwardx`，从而覆盖旧容器并重新启动；默认不会删除 `forwardx-data` 数据卷。

面板默认运行在 `http://your-server-ip:3000`，默认管理员账号：

| 字段 | 值 |
|------|-----|
| 用户名 | `admin` |
| 密码 | `admin123` |

> **安全提示**：首次登录后请立即修改管理员密码，或安装前通过环境变量 `ADMIN_PASSWORD` 自定义默认密码；生产环境也建议设置 `JWT_SECRET`。

### 从源码构建

```bash
# 安装依赖
pnpm install

# 开发模式
pnpm dev

# 构建生产版本
pnpm build

# 启动生产服务
pnpm start
```

### 鏋勫缓 Agent 鍙戝竷浜岃繘鍒?
Agent 鏄?Go 甯搁┗绋嬪簭銆傚彂甯冩柊鐗堟湰鍓嶅彲浠ユ湰鍦版瀯寤?Linux x86_64 / ARM64 浜岃繘鍒讹細

```bash
bash scripts/build-agent-release.sh v2.1.13
```

浜х墿浣嶄簬锛?
```text
dist/agent/forwardx-agent-linux-amd64
dist/agent/forwardx-agent-linux-arm64
dist/agent/SHA256SUMS
```

浠撳簱宸插寘鍚?GitHub Actions 宸ヤ綔娴侊細鎺ㄩ€?`v*.*.*` tag 鏃讹紝浼氳嚜鍔ㄦ瀯寤轰笂杩颁袱涓?Linux 甯歌鍙戣鐗堜簩杩涘埗骞朵笂浼犲埌瀵瑰簲 GitHub Release銆傝鎺ф満瀹夎/鍗囩骇鑴氭湰浼氭寜鏈哄櫒鏋舵瀯浼樺厛涓嬭浇锛?
- `forwardx-agent-linux-amd64`
- `forwardx-agent-linux-arm64`

濡傛灉 Release 涓病鏈夊搴斾簩杩涘埗锛屽畨瑁呰剼鏈細灏濊瘯鍦ㄨ鎺ф満涓婁复鏃跺畨瑁?Go 骞朵粠婧愮爜鏋勫缓锛涗粛澶辫触鏃舵墠鍥為€€鍒版棫 Shell Agent銆?
### 鐜鍙橀噺

| 鍙橀噺 | 榛樿鍊?| 璇存槑 |
|------|--------|------|
| `PORT` | `3000` | 闈㈡澘鐩戝惉绔彛 |
| `SQLITE_PATH` | `/data/forwardx.db` | SQLite 鏁版嵁搴撴枃浠惰矾寰?|
| `JWT_SECRET` | `change-me-to-a-random-string` | JWT 绛惧悕瀵嗛挜锛?*鐢熶骇鐜蹇呴』淇敼**锛?|
| `ADMIN_PASSWORD` | `admin123` | 绠＄悊鍛橀粯璁ゅ瘑鐮侊紙姣忔鍚姩鑷姩閲嶇疆锛?|
| `NODE_ENV` | `production` | 杩愯鐜 |

## 浣跨敤鎸囧崡

### 1. 閮ㄧ讲 Agent

鍦ㄩ潰鏉跨殑 **璁剧疆 鈫?Agent Token** 椤甸潰鐢熸垚 Token锛岀劧鍚庡湪鐩爣涓绘満涓婃墽琛屼竴閿畨瑁呭懡浠わ細

```bash
# 瀹夎 Agent锛圙itHub 浼樺厛锛屼笉鍙揪鏃跺彲鐩存帴浣跨敤闈㈡澘鍦板潃锛?curl -fsSL https://raw.githubusercontent.com/poouo/Forwardx/main/scripts/install-agent.sh | \
  PANEL_URL="http://your-panel:3000" bash -s -- install YOUR_AGENT_TOKEN
```

瀹夎鑴氭湰浼氳嚜鍔ㄥ畬鎴愪互涓嬫搷浣滐細

- 瀹夎渚濊禆锛坈url銆乯q銆乮ptables銆乮proute2锛?
- 涓嬭浇骞跺畨瑁?realm 杞彂宸ュ叿
- 瀹夎 Go Agent 绋嬪簭骞堕厤缃?systemd 鏈嶅姟锛坄forwardx-agent.service`锛?- 娉ㄥ唽鍒伴潰鏉垮苟寮€濮嬪績璺充笂鎶?

```bash
# 鍗囩骇 Agent锛堝鐢ㄥ凡瀹夎 Agent 涓殑闈㈡澘鍦板潃鍜?Token锛?curl -fsSL https://raw.githubusercontent.com/poouo/Forwardx/main/scripts/install-agent.sh | bash -s -- upgrade

# 濡傛灉闇€瑕佹墜鍔ㄦ寚瀹氶潰鏉垮湴鍧€鎴?Token
curl -fsSL https://raw.githubusercontent.com/poouo/Forwardx/main/scripts/install-agent.sh | \
  PANEL_URL="http://your-panel:3000" bash -s -- upgrade YOUR_AGENT_TOKEN

# 鍗歌浇 Agent
curl -fsSL http://your-panel:3000/api/agent/install.sh | bash -s -- uninstall

# 浜や簰妯″紡锛堜笉甯﹀弬鏁帮紝鍙€夋嫨瀹夎銆佸崌绾ф垨鍗歌浇锛?curl -fsSL http://your-panel:3000/api/agent/install.sh | bash
```

鍗囩骇涓嶄細鍒犻櫎闈㈡澘涓殑涓绘満銆佽鍒欐垨 Token銆傝剼鏈細閲嶆柊浠庨潰鏉挎媺鍙栦笌褰撳墠闈㈡澘鐗堟湰鍖归厤鐨勫畬鏁?Agent 瀹夎鍖咃紝鏇存柊 `/usr/local/bin/forwardx-agent`銆佸埛鏂?`/etc/forwardx-agent/config.json` 骞堕噸鍚?`forwardx-agent` 鏈嶅姟銆傚凡鏈夎浆鍙戣鍒欎細鍦ㄤ笅涓€娆″績璺充腑閲嶆柊鍚屾銆?
### 2. 鍒涘缓杞彂瑙勫垯

1. 杩涘叆 **杞彂瑙勫垯** 椤甸潰锛岀偣鍑?**娣诲姞瑙勫垯**
2. 閫夋嫨鐩爣涓绘満銆佽浆鍙戝伐鍏凤紙iptables / realm / socat锛?
3. 閰嶇疆婧愮鍙ｃ€佺洰鏍?IP銆佺洰鏍囩鍙ｃ€佸崗璁被鍨?
4. 榛樿闅忔満鍒嗛厤婧愮鍙ｏ紝涔熷彲鎵嬪姩鎸囧畾锛堜細鑷姩妫€娴嬬鍙ｅ崰鐢級
5. 淇濆瓨鍚庤鍒欏皢鍦ㄤ笅娆?Agent 蹇冭烦鏃惰嚜鍔ㄤ笅鍙戞墽琛?

### 3. 娴侀噺涓庢潈闄愮鐞?

绠＄悊鍛樺彲鍦?**鐢ㄦ埛绠＄悊** 椤甸潰瀵圭敤鎴疯繘琛岃缁嗛厤缃細

- **娴侀噺闄愰** 鈥?鏀寔 GB/TB 绾у埆璁剧疆锛岃秴棰濆悗鑷姩绂佺敤璇ョ敤鎴风殑鎵€鏈夎鍒?
- **鍒版湡鏃堕棿** 鈥?鍒版湡鍚庤嚜鍔ㄧ鐢ㄨ鍒?
- **鑷姩閲嶇疆** 鈥?鍙缃瘡鏈堟寚瀹氭棩鏈熻嚜鍔ㄦ竻闆跺凡鐢ㄦ祦閲?
- **鏉冮檺鎺у埗** 鈥?鍙崟鐙帶鍒剁敤鎴锋槸鍚﹀厑璁告坊鍔犳柊瑙勫垯

### 4. 杩為€氭€ф娴?

鍦ㄨ鍒欏垪琛ㄤ腑鐐瑰嚮鑷祴鎸夐挳锛孉gent 浼氭墽琛屼互涓嬫娴嬶細

- **鏈湴鐩戝惉妫€娴?*锛堜粎渚涘弬鑰冿級鈥?妫€鏌ョ鍙ｆ槸鍚﹀湪鐩戝惉
- **鐩爣鍙揪** 鈥?妫€娴嬬洰鏍?IP:Port 鏄惁鍙揪锛屼綔涓鸿繛閫氭€у垽瀹氫緷鎹?
- **鐩爣寤惰繜** 鈥?ping 鐩爣 IP 鐨勫钩鍧囧欢杩燂紙ms锛夛紝鎸夊欢杩熺潃鑹叉樉绀?

### 5. 鐢ㄦ埛绠＄悊

- 绠＄悊鍛樺彲鍦?**鐢ㄦ埛绠＄悊** 椤甸潰鍒涘缓鏂扮敤鎴凤紝鎴栨彁鍗?闄嶇骇鐢ㄦ埛瑙掕壊
- 鏅€氱敤鎴峰彧鑳界鐞嗚嚜宸卞垱寤虹殑涓绘満鍜岃鍒?
- 绠＄悊鍛樺彲鏌ョ湅鍜岀鐞嗘墍鏈夎祫婧?

## Agent 閫氫俊鍗忚

| 鎺ュ彛 | 鏂规硶 | 璇存槑 |
|------|------|------|
| `/api/agent/register` | POST | Agent 娉ㄥ唽锛屼笂鎶ヤ富鏈轰俊鎭?|
| `/api/agent/heartbeat` | POST | 蹇冭烦涓婃姤锛岃幏鍙栧緟鎵ц鍛戒护 |
| `/api/agent/rule-status` | POST | 瑙勫垯鎵ц鐘舵€佸洖璋?|
| `/api/agent/traffic` | POST | 娴侀噺鏁版嵁鍛ㄦ湡涓婃姤 |
| `/api/agent/selftest-result` | POST | 鑷祴缁撴灉涓婃姤 |
| `/api/agent/install.sh` | GET | 瀹夎/鍗歌浇寮曞鑴氭湰涓嬭浇 |

## Agent 绠＄悊鍛戒护

```bash
# 鏌ョ湅 Agent 鐘舵€?
systemctl status forwardx-agent

# 鏌ョ湅 Agent 鏃ュ織
journalctl -u forwardx-agent -f

# 閲嶅惎 Agent
systemctl restart forwardx-agent

# 鍋滄 Agent
systemctl stop forwardx-agent
```

## 鏁版嵁搴?

椤圭洰浣跨敤 Drizzle ORM 绠＄悊 SQLite 鏁版嵁搴?Schema锛?

```bash
# 鐢熸垚杩佺Щ鏂囦欢
pnpm db:generate

# 搴旂敤杩佺Щ
pnpm db:migrate
```

| 琛ㄥ悕 | 璇存槑 |
|------|------|
| `users` | 鐢ㄦ埛淇℃伅锛屽惈瑙掕壊鏉冮檺 |
| `hosts` | 涓绘満淇℃伅锛屽惈杩炴帴鏂瑰紡鍜屽湪绾跨姸鎬?|
| `forward_rules` | 杞彂瑙勫垯锛屽惈杩愯鐘舵€?|
| `host_metrics` | 涓绘満鐩戞帶鎸囨爣鏃跺簭鏁版嵁 |
| `traffic_stats` | 杞彂瑙勫垯娴侀噺缁熻 |
| `agent_tokens` | Agent 璁よ瘉浠ょ墝 |
| `forward_tests` | 杞彂鑷祴浠诲姟涓庣粨鏋?|

## 椤圭洰缁撴瀯

```
forwardx/
鈹溾攢鈹€ client/                  # 鍓嶇婧愮爜
鈹?  鈹斺攢鈹€ src/
鈹?      鈹溾攢鈹€ components/      # UI 缁勪欢锛坰hadcn/ui锛?
鈹?      鈹?  鈹斺攢鈹€ ui/          # 鍩虹 UI 缁勪欢搴?
鈹?      鈹溾攢鈹€ pages/           # 椤甸潰缁勪欢
鈹?      鈹?  鈹溾攢鈹€ Home.tsx     #   浠〃鐩?
鈹?      鈹?  鈹溾攢鈹€ Hosts.tsx    #   涓绘満绠＄悊
鈹?      鈹?  鈹溾攢鈹€ Rules.tsx    #   杞彂瑙勫垯绠＄悊
鈹?      鈹?  鈹溾攢鈹€ Users.tsx    #   鐢ㄦ埛绠＄悊
鈹?      鈹?  鈹溾攢鈹€ Settings.tsx #   绯荤粺璁剧疆
鈹?      鈹?  鈹斺攢鈹€ Login.tsx    #   鐧诲綍椤?
鈹?      鈹溾攢鈹€ contexts/        # React Context锛堜富棰樼瓑锛?
鈹?      鈹溾攢鈹€ hooks/           # 鑷畾涔?Hooks
鈹?      鈹斺攢鈹€ lib/             # 宸ュ叿鍑芥暟锛坱RPC 瀹㈡埛绔瓑锛?
鈹溾攢鈹€ server/                  # 鍚庣婧愮爜
鈹?  鈹溾攢鈹€ index.ts             # 鍏ュ彛鏂囦欢锛圗xpress + tRPC锛?
鈹?  鈹溾攢鈹€ routers.ts           # tRPC 璺敱瀹氫箟
鈹?  鈹溾攢鈹€ agentRoutes.ts       # Agent HTTP API + 鑴氭湰鐢熸垚
鈹?  鈹溾攢鈹€ db.ts                # SQLite 鏁版嵁璁块棶灞?
鈹?  鈹斺攢鈹€ env.ts               # 鐜鍙橀噺瑙ｆ瀽
鈹溾攢鈹€ drizzle/                 # 鏁版嵁搴?
鈹?  鈹斺攢鈹€ schema.ts            # Drizzle ORM Schema 瀹氫箟
鈹溾攢鈹€ shared/                  # 鍓嶅悗绔叡浜唬鐮?
鈹?  鈹斺攢鈹€ const.ts             # 鍏变韩甯搁噺
鈹溾攢鈹€ Dockerfile               # 澶氶樁娈?Docker 鏋勫缓
鈹溾攢鈹€ docker-compose.yml       # Docker Compose 缂栨帓
鈹溾攢鈹€ .env.example             # 鐜鍙橀噺妯℃澘
鈹斺攢鈹€ package.json
```

## 绯荤粺瑕佹眰

**闈㈡澘鏈嶅姟鍣細**

- Docker 20+ 鎴?Node.js 22+
- 鏈€浣?512MB 鍐呭瓨

**Agent 鐩爣涓绘満锛?*

- Linux (Debian / Ubuntu / CentOS / Alpine 绛?
- 闇€瑕?`curl`銆乣jq`銆乣iptables` 鍛戒护
- 浣跨敤 realm 寮曟搸鏃?Agent 鑷姩涓嬭浇瀹夎 realm 浜岃繘鍒?
- 浣跨敤 socat 寮曟搸鏃堕渶棰勮 `socat`


## 甯歌闂

**Q: Agent 娴侀噺缁熻鏄剧ず涓?0锛?*

纭繚 Agent 鐗堟湰涓烘渶鏂般€傛棫鐗堟湰涓?realm/socat 杞彂鐨勬祦閲忚鏁伴摼鎸傝浇浣嶇疆鏈夎锛屽鑷寸敤鎴锋€佷唬鐞嗙殑娴侀噺鏃犳硶缁熻銆傛洿鏂?Agent 鍚庨渶閲嶆柊搴旂敤瑙勫垯浠ラ噸寤鸿鏁伴摼銆?

**Q: 濡備綍鏇存柊 Agent锛?*

鍦ㄧ洰鏍囦富鏈轰笂鎵ц `upgrade` 鍛戒护鍗冲彲锛孉gent 浼氳嚜鍔ㄨ鐩栨洿鏂般€傜鐞嗗憳涔熷彲浠ュ湪涓绘満绠＄悊椤电偣鍑烩€滃崌绾?Agent鈥濓紝闈㈡澘浼氬湪璇ヤ富鏈轰笅娆″績璺虫椂涓嬪彂鑷崌绾т换鍔°€?
**Q: 鏀寔 IPv6 鍚楋紵**

鐩墠浠呮敮鎸?IPv4 杞彂銆侷Pv6 鏀寔璁″垝鍦ㄥ悗缁増鏈腑鍔犲叆銆?

**Q: 鏁版嵁搴撳浣曞浠斤紵**

SQLite 鏁版嵁搴撴枃浠堕粯璁や綅浜?Docker Volume 涓殑 `/data/forwardx.db`锛屽彲鐩存帴澶嶅埗璇ユ枃浠惰繘琛屽浠姐€傞潰鏉夸篃鏀寔閫氳繃璁剧疆椤甸潰瀵煎嚭/瀵煎叆閰嶇疆銆?

## 璁稿彲璇?

鏈」鐩熀浜?[MIT License](LICENSE) 寮€婧愩€?

## 璐＄尞

娆㈣繋鎻愪氦 Issue 鍜?Pull Request锛佽闃呰 [璐＄尞鎸囧崡](CONTRIBUTING.md) 浜嗚В璇︽儏銆?

---

<a id="english"></a>

<div align="center">

## English

</div>

### What is ForwardX?

ForwardX is a lightweight, modern, and self-hosted **Linux port forwarding management panel**. It provides a beautiful web UI to centrally manage port forwarding rules across multiple Linux servers through an Agent-based architecture.

### Key Features

- **Multi-engine support** 鈥?iptables (kernel-level DNAT), realm (high-performance userspace proxy), and socat (universal network tool)
- **Multi-host management** 鈥?Manage forwarding rules on multiple servers through a unified dashboard
- **Real-time monitoring** 鈥?CPU, memory, network metrics and per-rule traffic statistics with trend charts
- **Traffic management** 鈥?User traffic quotas, expiration dates, and auto/manual traffic reset
- **Port management** 鈥?Host port range limits, automatic port conflict detection, and random port assignment
- **Connectivity testing** 鈥?One-click link testing with target reachability and ping latency detection
- **Multi-user RBAC** 鈥?Admin and regular user roles with resource isolation
- **Config backup** 鈥?JSON-based import/export for rules and host configurations
- **Docker-ready** 鈥?One-command deployment with Docker Compose
- **Agent-based** 鈥?No SSH keys needed; Go agent with a lightweight shell installer

### Quick Start

```bash
git clone https://github.com/your-username/forwardx.git
cd forwardx
docker compose up -d
```

Default login: `admin` / `admin123`

Visit `http://your-server-ip:3000` to access the panel.

### Deploy Agent

Generate an Agent Token in **Settings 鈫?Agent Token**, then run on the target host:

```bash
curl -fsSL https://raw.githubusercontent.com/poouo/Forwardx/main/scripts/install-agent.sh | \
  PANEL_URL="http://your-panel:3000" bash -s -- install YOUR_AGENT_TOKEN
```

Upgrade an installed Agent:

```bash
curl -fsSL https://raw.githubusercontent.com/poouo/Forwardx/main/scripts/install-agent.sh | bash -s -- upgrade
```

### Tech Stack

| Layer | Technology |
|-------|-----------|
| **Frontend** | React 19 + TypeScript + Tailwind CSS 4 + shadcn/ui + Recharts |
| **Backend** | Node.js 22 + Express + tRPC 11 |
| **Database** | SQLite (better-sqlite3) + Drizzle ORM |
| **Build** | Vite 6 (frontend) + esbuild (backend) |
| **Deploy** | Docker + Docker Compose |
| **Agent** | Go daemon + shell installer/upgrader |

### License

[MIT](LICENSE)
