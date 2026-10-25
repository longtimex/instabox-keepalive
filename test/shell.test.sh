#!/bin/sh
# keepalive.sh 的可重复测试：起一个假 API，不碰真实账号、不装任何服务。
#   sh test/shell.test.sh
# 需要 node（起假 API）和 curl（脚本本身也依赖它）。
set -u

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
SCRIPT=$ROOT/keepalive.sh
PORT=${IBK_TEST_PORT:-$((18100 + ($$ % 700)))}
TMP=$(mktemp -d 2>/dev/null || true)
# Git Bash 的 mktemp 会返回 C:\... 这种带盘符的路径，塞进 PATH 会被冒号切断，退回 /tmp
case "$TMP" in
	""|*:*|*\\*)
		TMP=/tmp/ibk-test.$$
		mkdir -p "$TMP"
		;;
esac
PASS=0
FAIL=0
SRV_PID=
WPID=

ok() { PASS=$((PASS + 1)); printf '  \342\234\223 %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf '  \342\234\227 %s\n' "$1"; }

cleanup() {
	[ -n "${WPID:-}" ] && kill "$WPID" 2>/dev/null
	[ -n "$SRV_PID" ] && kill "$SRV_PID" 2>/dev/null
	rm -rf "$TMP"
}
trap cleanup EXIT INT TERM

command -v node >/dev/null 2>&1 || { echo "需要 node 才能起假 API"; exit 1; }

node "$ROOT/test/fake-api.mjs" "$PORT" >"$TMP/srv.log" 2>&1 &
SRV_PID=$!

i=0
while [ "$i" -lt 40 ]; do
	curl -s -o /dev/null "http://127.0.0.1:$PORT/v1/machines" && break
	i=$((i + 1))
	sleep 0.2 2>/dev/null || sleep 1
done

if ! kill -0 "$SRV_PID" 2>/dev/null; then
	echo "假 API 起不来（端口 $PORT 被占用？换一个：IBK_TEST_PORT=18123 sh test/shell.test.sh）"
	cat "$TMP/srv.log" 2>/dev/null
	exit 1
fi

write_env() { # write_env <file> <key> <machine> <lease>
	printf 'INSTABOX_API_KEY=%s\nINSTABOX_MACHINE=%s\nINSTABOX_LEASE=%s\nINSTABOX_LEASE_TTL=300\nINSTABOX_API_URL=http://127.0.0.1:%s\n' \
		"$2" "$3" "$4" "$PORT" >"$1"
}

echo "== keepalive.sh =="

if sh -n "$SCRIPT"; then ok "语法检查"; else bad "语法检查"; fi

# 1) .env 解析（不是 source）
write_env "$TMP/ok.env" ibk_good "" keepalive
if INSTABOX_ENV_FILE="$TMP/ok.env" sh "$SCRIPT" --once >"$TMP/out1" 2>&1; then
	ok ".env 逐行解析后能正常续租"
else
	bad ".env 解析失败：$(head -n 1 "$TMP/out1")"
fi

# 2) 注入：值里带命令替换，不能被执行
write_env "$TMP/evil.env" ibk_good '$(touch '"$TMP"'/PWNED)' keepalive
INSTABOX_ENV_FILE="$TMP/evil.env" sh "$SCRIPT" --once >"$TMP/out2" 2>&1
if [ -f "$TMP/PWNED" ]; then
	bad ".env 里的命令替换被执行了"
else
	ok ".env 里的命令替换不会执行"
fi
if INSTABOX_ENV_FILE="$TMP/evil.env" sh "$SCRIPT" --once >/dev/null 2>&1; then
	bad "非法 machine 应该被拒"
else
	ok "非法 machine 被白名单拦下"
fi

# 3) 非法租约名
write_env "$TMP/lease.env" ibk_good "" "../../etc/x"
if INSTABOX_ENV_FILE="$TMP/lease.env" sh "$SCRIPT" --once >/dev/null 2>&1; then
	bad "非法 lease 应该被拒"
else
	ok "非法 lease 被白名单拦下"
fi

# 4) jget 能解析多行 JSON（--status 打的是 jget 结果）
if INSTABOX_ENV_FILE="$TMP/ok.env" sh "$SCRIPT" --status 2>&1 | grep -q "state=running"; then
	ok "jget 能解析 pretty JSON"
else
	bad "jget 解析 pretty JSON 失败"
fi

# 5) 卸载路径守卫（这些在 root 检查之前就该拦下）
for d in / /etc /usr/lib /var/lib; do
	if sh "$SCRIPT" uninstall --dir="$d" 2>&1 | grep -q "拒绝卸载"; then
		ok "卸载拒绝 $d"
	else
		bad "卸载应拒绝 $d"
	fi
done
if sh "$SCRIPT" uninstall --dir=relative/path 2>&1 | grep -q "拒绝卸载"; then
	ok "卸载拒绝相对路径"
else
	bad "卸载应拒绝相对路径"
fi
if sh "$SCRIPT" uninstall --dir=/root/x --service='../../etc/passwd' 2>&1 | grep -q "服务名不合法"; then
	ok "卸载拒绝非法服务名"
else
	bad "卸载应拒绝非法服务名"
fi
if sh "$SCRIPT" uninstall --dir='/root/../etc/x' 2>&1 | grep -q "拒绝卸载"; then
	ok "卸载拒绝 .. 绕行"
else
	bad "卸载应拒绝 .. 绕行"
fi

# 6) 安装也用同一套路径检查（非 root 也能先拦下写错的目录）
if sh "$SCRIPT" install --dir=/etc key=ibk_good 2>&1 | grep -q "拒绝安装"; then
	ok "安装拒绝 /etc"
else
	bad "安装应拒绝 /etc"
fi
if sh "$SCRIPT" install --dir='/root/a b' key=ibk_good 2>&1 | grep -q "拒绝安装"; then
	ok "安装拒绝带空格的路径"
else
	bad "安装应拒绝带空格的路径"
fi
if sh "$SCRIPT" install --dir=/root/instabox-keepalive key=ibk_good 2>&1 | grep -q "需要 root"; then
	ok "路径合法时才提示需要 root"
else
	bad "合法路径应走到 root 检查"
fi

# 7) 告警：只有真实 2xx 才更新 .alert 状态
# 用假 curl 精确控制「API 返回码」和「webhook 返回码」，不依赖网络，CI 和本机都能稳定跑
stub_dir="$TMP/stub"
mkdir -p "$stub_dir"
cat >"$stub_dir/curl" <<'STUB'
#!/bin/sh
# API 一律返回 STUB_API（默认 500，让这一轮失败），webhook 返回 STUB_HOOK
case "$*" in
	*"/hook"*) printf '\n%s' "${STUB_HOOK:-200}" ;;
	*) printf '\n%s' "${STUB_API:-500}" ;;
esac
exit 0
STUB
chmod +x "$stub_dir/curl"

write_env_alert() { # write_env_alert <file> <webhook> <key>
	printf 'INSTABOX_API_KEY=%s\nINSTABOX_MACHINE=\nINSTABOX_LEASE=keepalive\nINSTABOX_LEASE_TTL=300\nINSTABOX_API_URL=http://127.0.0.1:%s\nINSTABOX_ALERT_WEBHOOK=%s\n' \
		"$3" "$PORT" "$2" >"$1"
}

rm -f "$TMP/.alert"
write_env_alert "$TMP/alert.env" "http://127.0.0.1:$PORT/hook" ibk_bad

PATH="$stub_dir:$PATH" STUB_API=500 STUB_HOOK=500 INSTABOX_ENV_FILE="$TMP/alert.env" \
	sh "$SCRIPT" --once >"$TMP/alert500.log" 2>&1
if [ -f "$TMP/.alert" ]; then
	bad "webhook 返回 500 时不该记成已发送"
else
	ok "webhook 返回 500 时不更新告警状态"
fi

PATH="$stub_dir:$PATH" STUB_API=500 STUB_HOOK=200 INSTABOX_ENV_FILE="$TMP/alert.env" \
	sh "$SCRIPT" --once >"$TMP/alertok.log" 2>&1
if [ -f "$TMP/.alert" ] && grep -q '^fail|' "$TMP/.alert"; then
	ok "webhook 返回 200 时记录失败状态"
	# 运行期 umask 077 + 显式 chmod：状态文件不该给别人看。
	# 先探一下本机文件系统是否体现 chmod（Windows/Git Bash 恒为 644）
	permprobe="$TMP/.permprobe"
	: >"$permprobe"
	chmod 600 "$permprobe" 2>/dev/null
	if [ "$(ls -l "$permprobe" 2>/dev/null | cut -c1-10)" != "-rw-------" ]; then
		echo "  （跳过权限检查：本机文件系统不体现 chmod）"
	else
		perm=$(ls -l "$TMP/.alert" 2>/dev/null | cut -c1-10)
		case "$perm" in
			-rw-------) ok ".alert 权限是 600" ;;
			*) bad ".alert 权限是 $perm（应为 600）" ;;
		esac
	fi
else
	bad "webhook 返回 200 时应记录失败状态"
fi

# 8) 临时文件用完就清（key 只存在于 0600 的临时文件里）
mkdir -p "$TMP/tmpdir"
probe="$TMP/tmpdir/.probe"
: >"$probe"
rm -f "$probe" 2>/dev/null
if [ -e "$probe" ]; then
	echo "  （跳过临时文件检查：本机 rm 被拦截，清不掉）"
else
	TMPDIR="$TMP/tmpdir" INSTABOX_ENV_FILE="$TMP/ok.env" sh "$SCRIPT" --once >/dev/null 2>&1
	left=$(ls -A "$TMP/tmpdir" 2>/dev/null | wc -l | tr -d ' ')
	if [ "$left" -eq 0 ]; then
		ok "临时文件已清理"
	else
		bad "临时目录残留 $left 个文件"
	fi
fi

# 9) 环境变量优先于 .env（脚本头注释承诺的语义）
# .env 里是 machine=""（全部）+ ttl=300；环境变量给 machine=m_1 + ttl=600。
# 用假 curl 记录实际请求：应该只 PUT m_1 且 ttlSeconds=600。
logstub="$TMP/logstub"
mkdir -p "$logstub"
cat >"$logstub/curl" <<'STUB'
#!/bin/sh
printf '%s\n' "$*" >>"$IBK_TEST_CURL_LOG"
case "$*" in
	*activity-leases*) printf '\n200' ;;
	*"/v1/machines") printf '{"machines":[{"id":"m_1","name":"qqq"},{"id":"m_2","name":"box2"}]}\n200' ;;
	*) printf '\n200' ;;
esac
STUB
chmod +x "$logstub/curl"
: >"$TMP/curl.log"
PATH="$logstub:$PATH" IBK_TEST_CURL_LOG="$TMP/curl.log" \
	INSTABOX_ENV_FILE="$TMP/ok.env" INSTABOX_MACHINE=m_1 INSTABOX_LEASE_TTL=600 \
	sh "$SCRIPT" --once >"$TMP/envprec.log" 2>&1
if grep -q 'ttlSeconds":600' "$TMP/curl.log" && grep -q '/m_1/activity-leases' "$TMP/curl.log" && ! grep -q 'm_2' "$TMP/curl.log"; then
	ok "环境变量优先于 .env（machine / ttl）"
else
	bad "环境变量没有覆盖 .env：$(head -n 1 "$TMP/envprec.log")"
fi

# 10) 数值配置非法时要给明确错误，而不是算术报错后退出
check_bad_num() { # check_bad_num <变量> <值>
	out=$(env "$1=$2" INSTABOX_ENV_FILE="$TMP/ok.env" sh "$SCRIPT" --once 2>&1)
	code=$?
	if [ "$code" -eq 0 ]; then
		bad "$1=$2 应该被拒绝"
	elif ! printf '%s' "$out" | grep -q "$1"; then
		bad "$1=$2 的错误信息没提到变量名：$(printf '%s' "$out" | head -n 1)"
	elif printf '%s' "$out" | grep -q 'unbound variable'; then
		bad "$1=$2 走到了算术报错：$(printf '%s' "$out" | head -n 1)"
	else
		ok "$1=$2 被明确拒绝"
	fi
}

check_bad_num INSTABOX_LEASE_TTL abc
check_bad_num INSTABOX_RENEW_EVERY abc
check_bad_num INSTABOX_WAKE_TRIES 08

# 11) 数值越界不报错退出，收敛到边界并告警（升级前的极端配置不能变成「服务起不来」）
out=$(env INSTABOX_WAKE_GAP=9999 INSTABOX_ENV_FILE="$TMP/ok.env" sh "$SCRIPT" --once 2>&1)
code=$?
if [ "$code" -eq 0 ] && printf '%s' "$out" | grep -q '超过上限 60'; then
	ok "越界的 WAKE_GAP 收敛到 60 并告警"
else
	bad "越界 WAKE_GAP 没有收敛（exit=$code）：$(printf '%s' "$out" | head -n 1)"
fi

# 12) 老配置里的 0 仍然可用：WAKE_TRIES=0 = 不轮询
if env INSTABOX_WAKE_TRIES=0 INSTABOX_ENV_FILE="$TMP/ok.env" sh "$SCRIPT" --once >"$TMP/wake0.log" 2>&1; then
	ok "WAKE_TRIES=0 仍然能正常跑（不轮询）"
else
	bad "WAKE_TRIES=0 被拒绝了：$(head -n 1 "$TMP/wake0.log")"
fi

# 13) --watch 收到 TERM 要立刻退出：systemd stop 不该等到超时 SIGKILL
INSTABOX_ENV_FILE="$TMP/ok.env" INSTABOX_MACHINE=m_1 INSTABOX_RENEW_EVERY=600 \
	sh "$SCRIPT" --watch >"$TMP/watch.log" 2>&1 &
WPID=$!
sleep 1
kill -TERM "$WPID" 2>/dev/null
i=0
while kill -0 "$WPID" 2>/dev/null && [ "$i" -lt 40 ]; do
	i=$((i + 1))
	sleep 0.1 2>/dev/null || sleep 1
done
if kill -0 "$WPID" 2>/dev/null; then
	bad "watch 收到 TERM 后仍在运行"
	kill -9 "$WPID" 2>/dev/null
else
	ok "watch 收到 TERM 立即退出"
fi
wait "$WPID" 2>/dev/null
WPID=

echo
if [ "$FAIL" -eq 0 ]; then
	echo "$PASS 项通过"
	exit 0
fi
echo "$PASS 项通过，$FAIL 项失败"
exit 1
