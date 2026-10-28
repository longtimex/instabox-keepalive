#!/bin/sh
# InstaBox keepalive — 续租 activity lease，机器就不会因为空闲被自动挂起。
#
# 一个文件搞定安装 / 续租 / 卸载，纯 POSIX sh（Alpine/BusyBox、Debian、OpenWrt）。
# 外部命令只用系统自带的基础工具：curl + awk/sed/grep/cut/tr（都不需要 jq、python）。
#
#   安装（key 只写进本机 0600 的 .env，绝不落仓库、不进进程列表）
#     key=ibk_xxx bash <(curl -Ls https://raw.githubusercontent.com/pingmike2/instabox-keepalive/main/keepalive.sh)
#     machine=qqq 只保一台；machine= 留空 / all = 保活这把 key 名下全部机器
#
#   卸载
#     sh keepalive.sh uninstall                 （--keep-files 保留目录 / --keep-lease 不动租约）
#
#   手动用
#     sh keepalive.sh --once       续租一次，退出码 0/1（cron 用这个）
#     sh keepalive.sh --watch      前台常驻（systemd / OpenRC 用这个）
#     sh keepalive.sh --status     机器状态
#     sh keepalive.sh --release    释放租约，恢复正常空闲挂起
#
#   安装参数（也能写成环境变量）
#     key= / KEY= / INSTABOX_API_KEY=  API key（必填）
#     machine= / INSTABOX_MACHINE=     机器名或 m_... id；留空 / all = 全部
#     --lease NAME     租约名                    （默认 keepalive）
#     --ttl SECONDS    租约秒数 30-3600          （默认 300）
#     --dir PATH       安装目录                  （默认 /root/instabox-keepalive）
#     --service NAME   服务名                    （默认 instabox-keepalive）
#     --raw URL        raw 前缀，脚本自更新用     （默认本仓库 main）
#     --no-start       只装不启
#     --cron           强制走 cron（不用 systemd / OpenRC）
#
#   运行期变量（.env 或环境变量；环境变量优先）
#     INSTABOX_ENV_FILE      .env 路径（默认脚本同目录）
#     INSTABOX_RENEW_EVERY   两次续租的间隔秒数（默认租约的 3/5）
#     INSTABOX_AUTO_RESUME   1（默认）：机器被挂起/停掉时先 resume（stopped 用 start 兜底）再续租；0=只报错不唤醒
#     INSTABOX_WAKE_TRIES    唤醒后等 running 的轮询次数（默认 6，每次 WAKE_GAP 秒）
#     INSTABOX_WAKE_GAP      上面每次轮询的间隔秒数（默认 5）
#     INSTABOX_ALERT_WEBHOOK 失败告警地址：续租失败/恢复时 POST 一条过去（不填就只写日志）
#     INSTABOX_ALERT_FORMAT  告警 body 格式：text（默认）/ feishu / dingtalk / wecom / discord
#     INSTABOX_ALERT_MIN_INTERVAL  同一故障最多多久发一次告警（默认 1800 秒）
#     INSTABOX_API_URL       API 地址（默认 https://api.instabox.sh）
#
#   多账号：key=ibk_aaa,ibk_bbb,ibk_cc3（逗号分隔，无限叠加；单把也行）
#     每把 key 名下的机器各自保活；加 key 就往变量里续一段,ibk_xxx 再重装一次
#
# 机器被挂起后机器内部的定时器也会冻结，所以续租必须从机器外面打进来。
set -u
# 脚本会写 .env / 临时文件：默认就把新建文件的权限收紧，别指望每个分支都记得 chmod
umask 077

RAW=${RAW_BASE:-https://raw.githubusercontent.com/pingmike2/instabox-keepalive/main}
DEF_DIR=${INSTALL_DIR:-/root/instabox-keepalive}
DIR=$DEF_DIR
SERVICE=${SERVICE_NAME:-instabox-keepalive}
LEASE=${INSTABOX_LEASE:-keepalive}
TTL=${INSTABOX_LEASE_TTL:-300}
NAME=${machine:-${INSTABOX_MACHINE:-}}
API_KEY=${key:-${KEY:-${IBK:-${INSTABOX_API_KEY:-}}}}
API=${INSTABOX_API_URL:-${api:-https://api.instabox.sh}}
ALERT_WEBHOOK=${INSTABOX_ALERT_WEBHOOK:-}
ALERT_FORMAT=${INSTABOX_ALERT_FORMAT:-text}
ALERT_EVERY=${INSTABOX_ALERT_MIN_INTERVAL:-1800}
WAKE_TRIES=${INSTABOX_WAKE_TRIES:-6}
WAKE_GAP=${INSTABOX_WAKE_GAP:-5}
IDEM_SEQ=0
WANT_START=1
FORCE_CRON=0

SELF_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" 2>/dev/null && pwd || echo /nonexistent)

log() { printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }
say() { printf '  %s\n' "$*"; }
die() { printf '错误: %s\n' "$*" >&2; exit 1; }

# 短 key 也打码：宁可看不出前几位，也别把整串打到终端/日志里
mask() {
	v=$1
	n=${#v}
	if [ "$n" -le 8 ]; then
		printf '****'
	else
		printf '%s……%s' "$(printf %s "$v" | cut -c1-4)" "$(printf %s "$v" | cut -c$((n - 3))-$n)"
	fi
}

# 打印 webhook 时只留协议+域名，path/query 里通常是 token
mask_url() {
	printf '%s' "$1" | sed -e 's#^\([A-Za-z][A-Za-z0-9+.-]*://[^/]*\).*#\1/…#'
}

# 白名单校验：只放行预期的字符集，顺带挡掉换行（换行是 .env 注入的入口）
chk() { # chk <值> <ERE>；0=通过
	[ -n "$1" ] || return 1
	case "$1" in
		*"
"*) return 1 ;;
	esac
	printf '%s' "$1" | grep -Eq "$2"
}

# 数值格式：只接受十进制整数，挡掉 abc / 空串 / 前导零 / 超过 9 位的数字。
# 这些值会直接参与 $(( )) 和 [ -lt ]，非法值在 set -u 下会报 "unbound variable"，
# 在 systemd/--watch 下表现为启动即退出、反复重启；前导零还会被当成八进制。
num_ok() { # num_ok <值>；0=是合法的十进制整数
	[ -n "$1" ] || return 1
	case "$1" in
		*[!0-9]*) return 1 ;;
		0) : ;;
		0*) return 1 ;;
	esac
	[ "${#1}" -le 9 ]
}

# 格式不对没法解释，直接报错（老版本会在这里算术崩溃）
need_num() { # need_num <变量名> <值>
	num_ok "$2" && return 0
	die "$1 必须是十进制整数（当前：${2:-空}）"
}

# 有硬性范围的（TTL 是 API 约束，老版本也是越界即报错）直接报错
check_num() { # check_num <变量名> <值> <最小值> <最大值>；不合格直接 die
	need_num "$1" "$2"
	[ "$2" -ge "$3" ] && [ "$2" -le "$4" ] && return 0
	die "$1 必须是 $3-$4 之间的整数（当前：$2）"
}

# 运行期调参没有硬性范围：数值越界就收敛到边界并告警，别让升级后的服务起不来。
# （老版本任何数字都能跑，0 也有确定行为：WAKE_TRIES=0 不轮询、WAKE_GAP=0 立即轮询）
clamp_num() { # clamp_num <变量名> <值> <最小值> <最大值> -> stdout 输出收敛后的值
	v=$2
	if [ "$v" -lt "$3" ]; then
		v=$3
		printf '警告: %s=%s 小于下限 %s，按 %s 运行\n' "$1" "$2" "$3" "$v" >&2
	fi
	if [ "$v" -gt "$4" ]; then
		v=$4
		printf '警告: %s=%s 超过上限 %s，按 %s 运行\n' "$1" "$2" "$4" "$v" >&2
	fi
	printf '%s' "$v"
}

# ---- 路径：安装和卸载共用一套检查 ---------------------------------------------
norm_dir() { # 目录存在就取真实路径（挡 /x/../.. 这类绕法），不存在就原样返回
	if [ -d "$1" ]; then
		(CDPATH= cd -- "$1" 2>/dev/null && pwd -P) || printf '%s' "$1"
	else
		printf '%s' "$1"
	fi
}

check_dir_safe() { # check_dir_safe <dir> <动作名>；不合格直接 die
	d=$1
	what=${2:-操作}
	[ -n "$d" ] || die "拒绝$what：目录不能为空"
	[ "$d" = "/" ] && die "拒绝$what：不能是根目录"
	case "$d" in
		*' '*|*'	'*) die "拒绝$what：路径里不能有空格或制表符（$d）" ;;
		*"
"*) die "拒绝$what：路径里不能有换行（$d）" ;;
	esac
	case "$d" in
		//*) die "拒绝$what：路径不能以 // 开头（$d）" ;;
		*//*) die "拒绝$what：路径里不能有连续斜杠（$d）" ;;
	esac
	case "/$d/" in
		*/../*) die "拒绝$what：路径里不能有 ..（$d）" ;;
	esac
	case "$d" in
		/etc|/etc/*|/usr|/usr/*|/var|/var/*|/boot|/boot/*|/bin|/bin/*|/sbin|/sbin/*|/lib|/lib/*|/lib64|/lib64/*|/proc|/proc/*|/sys|/sys/*|/dev|/dev/*|/root|/home|/tmp|/opt)
			die "拒绝$what：$d 是系统目录或其子目录" ;;
		/*) : ;;
		*) die "拒绝$what：必须是绝对路径（$d）" ;;
	esac
	return 0
}

# 安装标记：卸载时不仅看文件在不在，还要看内容对不对
INSTALL_MAGIC=instabox-keepalive
is_installed_dir() {
	[ -f "$1/.installed" ] || return 1
	head -n 1 "$1/.installed" 2>/dev/null | grep -qx "$INSTALL_MAGIC"
}

# ---- 运行时：读 .env、调 API、续租 ------------------------------------------
# 只认白名单里的 KEY=VALUE，绝不 source —— .env 被改脏了也只是取不到值，不会执行代码
ENV_KEYS="INSTABOX_API_KEY INSTABOX_MACHINE INSTABOX_LEASE INSTABOX_LEASE_TTL INSTABOX_RENEW_EVERY INSTABOX_AUTO_RESUME INSTABOX_WAKE_TRIES INSTABOX_WAKE_GAP INSTABOX_ALERT_WEBHOOK INSTABOX_ALERT_FORMAT INSTABOX_ALERT_MIN_INTERVAL INSTABOX_API_URL"

env_get() { # env_get <file> <KEY> -> 值（去掉一层引号）
	sed -n "s/^[[:space:]]*$2=//p" "$1" 2>/dev/null | head -n 1 |
		sed -e "s/^'//" -e "s/'\$//" -e 's/^"//' -e 's/"$//'
}

# 环境变量是否显式设过（空值也算：INSTABOX_MACHINE="" 表示全部机器，
# 不该被 .env 里留着的旧机器名顶回去）。POSIX sh 没有 ${!name}，用固定 case。
env_set() {
	case "$1" in
		INSTABOX_API_KEY) [ "${INSTABOX_API_KEY+x}" = x ] ;;
		INSTABOX_MACHINE) [ "${INSTABOX_MACHINE+x}" = x ] ;;
		INSTABOX_LEASE) [ "${INSTABOX_LEASE+x}" = x ] ;;
		INSTABOX_LEASE_TTL) [ "${INSTABOX_LEASE_TTL+x}" = x ] ;;
		INSTABOX_RENEW_EVERY) [ "${INSTABOX_RENEW_EVERY+x}" = x ] ;;
		INSTABOX_AUTO_RESUME) [ "${INSTABOX_AUTO_RESUME+x}" = x ] ;;
		INSTABOX_WAKE_TRIES) [ "${INSTABOX_WAKE_TRIES+x}" = x ] ;;
		INSTABOX_WAKE_GAP) [ "${INSTABOX_WAKE_GAP+x}" = x ] ;;
		INSTABOX_ALERT_WEBHOOK) [ "${INSTABOX_ALERT_WEBHOOK+x}" = x ] ;;
		INSTABOX_ALERT_FORMAT) [ "${INSTABOX_ALERT_FORMAT+x}" = x ] ;;
		INSTABOX_ALERT_MIN_INTERVAL) [ "${INSTABOX_ALERT_MIN_INTERVAL+x}" = x ] ;;
		INSTABOX_API_URL) [ "${INSTABOX_API_URL+x}" = x ] ;;
		*) return 1 ;;
	esac
}

load_env() { # load_env [题目录]
	d=$1
	ENV_FILE=${INSTABOX_ENV_FILE:-$d/.env}
	[ -f "$ENV_FILE" ] || return 0
	for k in $ENV_KEYS; do
		# 环境变量优先（脚本头注释承诺的语义）：显式设过的键不再被 .env 覆盖
		env_set "$k" && continue
		v=$(env_get "$ENV_FILE" "$k")
		# export "K=V" 传的是字面量，不会再做命令替换
		[ -n "$v" ] && export "$k=$v"
	done
	return 0
}

# 读当前生效的同名变量（给重装时保留旧配置用）。固定列表，不用 eval。
getvar() {
	case "$1" in
		INSTABOX_RENEW_EVERY) printf '%s' "${INSTABOX_RENEW_EVERY:-}" ;;
		INSTABOX_AUTO_RESUME) printf '%s' "${INSTABOX_AUTO_RESUME:-}" ;;
		INSTABOX_WAKE_TRIES) printf '%s' "${INSTABOX_WAKE_TRIES:-}" ;;
		INSTABOX_WAKE_GAP) printf '%s' "${INSTABOX_WAKE_GAP:-}" ;;
		INSTABOX_ALERT_WEBHOOK) printf '%s' "${INSTABOX_ALERT_WEBHOOK:-}" ;;
		INSTABOX_ALERT_FORMAT) printf '%s' "${INSTABOX_ALERT_FORMAT:-}" ;;
		INSTABOX_ALERT_MIN_INTERVAL) printf '%s' "${INSTABOX_ALERT_MIN_INTERVAL:-}" ;;
		INSTABOX_API_URL) printf '%s' "${INSTABOX_API_URL:-}" ;;
	esac
}

reload_runtime() { # .env / 环境变量里的值最终生效一次
	API=${INSTABOX_API_URL:-${api:-$API}}
	KEY=${INSTABOX_API_KEY:-${key:-${KEY:-${IBK:-${KEY:-}}}}}
	MACHINE=${INSTABOX_MACHINE:-${machine:-$NAME}}
	LEASE=${INSTABOX_LEASE:-$LEASE}
	TTL=${INSTABOX_LEASE_TTL:-$TTL}
	# TTL 是 API 的硬约束：非法/越界直接报错，别带着坏值去续租
	check_num INSTABOX_LEASE_TTL "$TTL" 30 3600
	RENEW=${INSTABOX_RENEW_EVERY:-$((TTL * 3 / 5))}
	need_num INSTABOX_RENEW_EVERY "$RENEW"
	RENEW=$(clamp_num INSTABOX_RENEW_EVERY "$RENEW" 0 86400)
	AUTO_RESUME=${INSTABOX_AUTO_RESUME:-1}
	WAKE_TRIES=${INSTABOX_WAKE_TRIES:-6}
	need_num INSTABOX_WAKE_TRIES "$WAKE_TRIES"
	WAKE_TRIES=$(clamp_num INSTABOX_WAKE_TRIES "$WAKE_TRIES" 0 60)
	WAKE_GAP=${INSTABOX_WAKE_GAP:-5}
	need_num INSTABOX_WAKE_GAP "$WAKE_GAP"
	WAKE_GAP=$(clamp_num INSTABOX_WAKE_GAP "$WAKE_GAP" 0 60)
	ALERT_WEBHOOK=${INSTABOX_ALERT_WEBHOOK:-}
	ALERT_FORMAT=${INSTABOX_ALERT_FORMAT:-text}
	ALERT_EVERY=${INSTABOX_ALERT_MIN_INTERVAL:-1800}
	need_num INSTABOX_ALERT_MIN_INTERVAL "$ALERT_EVERY"
	ALERT_EVERY=$(clamp_num INSTABOX_ALERT_MIN_INTERVAL "$ALERT_EVERY" 0 86400)
	ALL=0
	case "$MACHINE" in ""|all|ALL|All|'*') ALL=1 ;; esac
	return 0
}

HTTP_BODY=
HTTP_CODE=


# jget <json> <key> -> "key":… 里最左边那个值，去引号
# 先压成一行：API 返回的可能是 pretty JSON，逐行匹配会漏掉跨行的值
jget() {
	printf '%s' "$1" | tr -d '\n\r' | awk -v k="$2" '
		match($0, "\"" k "\":[^,}]*") {
			v = substr($0, RSTART + length(k) + 3, RLENGTH - length(k) - 3)
			gsub(/^[ 	]+|[ 	]+$/, "", v)
			gsub(/^"|"$/, "", v)
			gsub(/^[ 	]+|[ 	]+$/, "", v)
			print v
			exit
		}'
}

# ---- 临时文件：一律 mktemp（0600），退出时清掉 ---------------------------------
TMP_FILES=
TMP_CFG=
TMP_KEYS=
TMP_NEW=
CFG_KEY=

tmp_new() { # 设置 TMP_NEW 为新的 0600 临时文件；不用 $(...) 调用，否则登记会丢在子 shell 里
	TMP_NEW=$(mktemp "${TMPDIR:-/tmp}/ibk.XXXXXX" 2>/dev/null) || die "mktemp 失败（TMPDIR 不可写？）"
	chmod 600 "$TMP_NEW" 2>/dev/null || true
	TMP_FILES="$TMP_FILES $TMP_NEW"
}

cleanup_tmp() {
	for f in $TMP_FILES; do
		[ -n "$f" ] && rm -f "$f" 2>/dev/null
	done
	TMP_FILES=
}

# 信号必须真的退出：老写法 `trap cleanup_tmp EXIT INT TERM HUP` 只清了临时文件，
# 信号被吃掉后 --watch 继续跑，systemctl stop 只能等到超时 SIGKILL。
# sleep 也放后台再 wait：否则 trap 得等前台 sleep 跑完（最长一个 RENEW 周期）才执行。
SLEEP_PID=
nap() { # nap <秒>；可被 INT/TERM/HUP 打断
	sleep "$1" &
	SLEEP_PID=$!
	wait "$SLEEP_PID" 2>/dev/null
	SLEEP_PID=
}
on_signal() { # on_signal <退出码>
	[ -n "$SLEEP_PID" ] && kill "$SLEEP_PID" 2>/dev/null
	exit "$1"
}
trap cleanup_tmp EXIT
trap 'on_signal 130' INT
trap 'on_signal 143' TERM
trap 'on_signal 129' HUP

# 把 X-API-Key 放进 curl 配置文件（-K），而不是命令行参数：
# 命令行参数在 `ps` 里对同机所有用户可见，配置文件是 0600。
ensure_cfg() {
	[ -n "$TMP_CFG" ] && [ "$CFG_KEY" = "$KEY" ] && return 0
	if [ -z "$TMP_CFG" ]; then
		tmp_new
		TMP_CFG=$TMP_NEW
	fi
	printf 'header = "X-API-Key: %s"\n' "$KEY" >"$TMP_CFG" || die "写 curl 配置失败"
	CFG_KEY=$KEY
}

# 平台把「另一个操作正在跑」也回 409（operation_conflict / machine_cooldown），
# 这是暂时的、等一两秒再试就好；machine_not_running 才是需要唤醒的那种。
# 以前只认 not_running，这两种会直接被记成续租失败 —— 这是「偶发失败」的常见来源。
is_transient_409() {
	[ "$HTTP_CODE" = "409" ] || return 1
	printf '%s' "$HTTP_BODY" | grep -Eqi 'operation_conflict|machine_cooldown'
}

# http <METHOD> <PATH> [JSON_BODY] -> HTTP_CODE + HTTP_BODY
# curl 自带重试：超时 / 连接失败 / 408 / 429 / 5xx 会再试两次（续租是幂等的，重试安全）。
# 暂时性 409 由外层再补两次，间隔 2s / 4s —— curl 不认识这个错误码。
# -m 30 是整个操作的上限（含重试），不会把一轮拖太久。
http() {
	method=$1
	path=$2
	data=${3:-}
	ensure_cfg
	tries=0
	while :; do
		if [ -n "$data" ]; then
			resp=$(curl -sS -m 30 --retry 2 --retry-delay 1 --retry-connrefused -X "$method" "$API$path" \
				-K "$TMP_CFG" -H 'Content-Type: application/json' \
				-d "$data" -w '\n%{http_code}' 2>&1) || { HTTP_CODE=0; HTTP_BODY=$resp; return 1; }
		else
			resp=$(curl -sS -m 30 --retry 2 --retry-delay 1 --retry-connrefused -X "$method" "$API$path" \
				-K "$TMP_CFG" -w '\n%{http_code}' 2>&1) || { HTTP_CODE=0; HTTP_BODY=$resp; return 1; }
		fi
		HTTP_CODE=$(printf '%s' "$resp" | tail -n 1)
		HTTP_BODY=$(printf '%s' "$resp" | sed '$d')
		if [ "$HTTP_CODE" = "200" ] || [ "$HTTP_CODE" = "204" ]; then
			return 0
		fi
		tries=$((tries + 1))
		if [ "$tries" -gt 2 ] || ! is_transient_409; then
			return 1
		fi
		# 2s、4s：给平台把那个操作跑完的时间，又不至于把一轮拖长。
		# 用 nap 而不是 sleep：--watch 收到 TERM 时能立刻退出，不用等这几秒。
		nap $((tries * 2))
	done
}

# 租约接口只认机器 id（传名字会 400），所以名字要先换成 id；`all` 就是把这把 key
# 能看到的机器全列出来。jq / python3 有就用，都没有就走 awk——按花括号深度扫，
# 裸 BusyBox 也能跑。
#
# 三个解析器是逐级降级的关系，不是三选一：jq 装了但版本/表达式不兼容、python3 是
# Windows 商店的空壳别名、API 改了结构 —— 任一情况都要往下试。否则上层会把
# 「解析器挂了」误报成「这把 key 名下没有机器」，而且下一轮还是同样的空转。
machines_list() { # -> 每行 "id<TAB>name"
	if command -v jq >/dev/null 2>&1; then
		_ml=$(printf '%s' "$HTTP_BODY" | jq -r '.machines[]? | "\(.id)\t\(.name)"' 2>/dev/null)
		if [ -n "$_ml" ]; then printf '%s\n' "$_ml"; return 0; fi
	fi
	if command -v python3 >/dev/null 2>&1; then
		_ml=$(printf '%s' "$HTTP_BODY" | python3 -c '
import json, sys
d = json.load(sys.stdin)
for m in d.get("machines") or []:
    print("%s\t%s" % (m.get("id", ""), m.get("name", "")))' 2>/dev/null)
		if [ -n "$_ml" ]; then printf '%s\n' "$_ml"; return 0; fi
	fi
	# 兜底：多行（pretty print）的 JSON 先压成一行，awk 是按行处理的，不压就只能解出单行响应
	printf '%s' "$HTTP_BODY" | tr -d '\n\r' | awk '
			function getv(o, k,   s, r) {
				# 冒号后带/不带空格都要吃："k":"v" 和 "k": "v"
				s = index(o, "\"" k "\": \"")
				if (s == 0) {
					s = index(o, "\"" k "\":\"")
					if (s == 0) { return "" }
					r = substr(o, s + length(k) + 4)
				} else {
					r = substr(o, s + length(k) + 5)
				}
				return substr(r, 1, index(r, "\"") - 1)
			}
			function emit(o,   id, nm) {
				id = getv(o, "id")
				nm = getv(o, "name")
				if (id != "") { print id "\t" nm }
			}
			{
				line = $0
				# "machines":[ 或 "machines": [（冒号后带不带空格两种 API 形态都吃）；
				# busybox awk 不把 match() 当 pattern，用 if
				if (match(line, /"machines"[ 	]*:[ 	]*\[/)) {
					line = substr(line, RSTART + RLENGTH)
				} else {
					line = ""
				}
				depth = 0; buf = ""; started = 0
				for (p = 1; p <= length(line); p++) {
					c = substr(line, p, 1)
					if (c == "]") { if (depth == 0 && started == 1) { break } }
					if (c == "{") {
						depth++
						if (depth == 1) { buf = "{"; started = 1 } else { buf = buf c }
					} else {
						if (c == "}") {
							if (depth == 1) { emit(buf "}"); buf = "" } else { if (depth > 1) { buf = buf c } }
							depth--
						} else {
							if (depth >= 1) { buf = buf c }
						}
					}
				}
			}'
}

resolve() {
	[ "$ALL" -eq 1 ] && return 0
	case "$MACHINE" in
		m_*) MID=$MACHINE; LABEL=$MACHINE; return 0 ;;
	esac
	http GET "/v1/machines/$MACHINE" || { log "找不到机器 $MACHINE（HTTP $HTTP_CODE）: $HTTP_BODY"; return 1; }
	MID=$(jget "$HTTP_BODY" id)
	[ -n "$MID" ] || { log "没解析出机器 id: $HTTP_BODY"; return 1; }
	LABEL="$MACHINE（$MID）"
	return 0
}

# 机器被平台挂起（suspended）或停掉了：续租一律 409 machine_not_running，光续租是空转，
# 得先唤醒。wake_action 用带 Idempotency-Key 的 POST（换状态的接口缺这个头会 400）。
is_not_running() {
	[ "$HTTP_CODE" = "409" ] || return 1
	printf '%s' "$HTTP_BODY" | grep -Eqi 'not_running|suspended|stopped'
}

wake_action() { # wake_action <id> <resume|start> -> 打印 HTTP 码
	# Idempotency-Key 里带一个自增序号：同一秒内重试也不会撞到上一次的 key
	# （撞了会拿到缓存的旧响应，看起来像成功了，其实状态没变）
	IDEM_SEQ=$((IDEM_SEQ + 1))
	ensure_cfg
	wc=$(curl -sS -m 30 --retry 2 --retry-delay 1 -X POST "$API/v1/machines/$1/$2" \
		-K "$TMP_CFG" -H "Idempotency-Key: ka-$2-$1-$$-$(date +%s)-$IDEM_SEQ" \
		-o /dev/null -w '%{http_code}' 2>/dev/null) || wc=0
	printf '%s' "$wc"
}

wake_one() { # wake_one <id> <label>；0=已经 running
	c1=$(wake_action "$1" resume)
	if [ "$c1" = "202" ] || [ "$c1" = "200" ]; then
		log "唤醒 $2: resume HTTP $c1"
	else
		c2=$(wake_action "$1" start)
		log "唤醒 $2: resume HTTP $c1 → start HTTP $c2"
	fi
	i=0
	# 默认等 6×5s=30s：机器启动慢的时候别急着判失败，下一轮要等好几分钟
	while [ "$i" -lt "${WAKE_TRIES:-6}" ]; do
		nap "${WAKE_GAP:-5}"
		if http GET "/v1/machines/$1" && [ "$(jget "$HTTP_BODY" state)" = "running" ]; then
			return 0
		fi
		i=$((i + 1))
	done
	return 1
}

renew_one() { # renew_one <id> <label>
	if http PUT "/v1/machines/$1/activity-leases/$LEASE" "{\"ttlSeconds\":$TTL}"; then
		log "续租 ok $2/$LEASE 到期 $(jget "$HTTP_BODY" expiresAt)"
		return 0
	fi
	if [ "$AUTO_RESUME" = "1" ] && is_not_running; then
		if wake_one "$1" "$2" && http PUT "/v1/machines/$1/activity-leases/$LEASE" "{\"ttlSeconds\":$TTL}"; then
			log "续租 ok（唤醒后）$2/$LEASE 到期 $(jget "$HTTP_BODY" expiresAt)"
			return 0
		fi
	fi
	log "续租失败 $2/$LEASE HTTP $HTTP_CODE: $HTTP_BODY"
	return 1
}

release_one() { # release_one <id> <label>
	if http DELETE "/v1/machines/$1/activity-leases/$LEASE"; then
		log "已释放租约 $2/$LEASE"
		return 0
	fi
	if [ "$HTTP_CODE" = "404" ]; then
		log "租约本来就不存在 $2/$LEASE"
		return 0
	fi
	log "释放失败 $2/$LEASE HTTP $HTTP_CODE: $HTTP_BODY"
	return 1
}

status_one() { # status_one <id> <label>
	if ! http GET "/v1/machines/$1"; then
		log "读机器失败 $2 HTTP $HTTP_CODE: $HTTP_BODY"
		return 1
	fi
	log "$2 state=$(jget "$HTTP_BODY" state) \
autoSuspendAfterSeconds=$(jget "$HTTP_BODY" autoSuspendAfterSeconds) \
autoSuspendedAt=$(jget "$HTTP_BODY" autoSuspendedAt)"
	return 0
}

each_machine() { # each_machine <fn> —— 对选中的机器逐台执行
	fn=$1
	if [ "$ALL" -eq 0 ]; then
		"$fn" "$MID" "$LABEL"
		return $?
	fi
	if ! http GET "/v1/machines"; then
		log "列机器失败 HTTP $HTTP_CODE: $HTTP_BODY"
		return 1
	fi
	list=$(machines_list) || { log "解析机器列表失败"; return 1; }
	count=$(printf '%s\n' "$list" | grep -c . || true)
	if [ "${count:-0}" -eq 0 ]; then
		# 要区分两件事，否则会把正常情况报成故障：
		#   {"machines":[]}      → 合法响应，这把 key 名下确实没有机器
		#   {"machines":[{...}]} → 有数据但解析器（jq/python3/awk）没吃下，才需要提示装工具
		# 判据用压缩空白后的形态，API 的 pretty JSON 也能对上。
		compact=$(printf '%s' "$HTTP_BODY" | tr -d '[:space:]')
		case "$compact" in
			*'"machines":[]'*) log "这把 key 名下没有机器" ;;
			*'"machines"'*) log "机器列表解析失败：响应里有 machines 但没解出来，装个 jq 或 python3 再跑" ;;
			*) log "这把 key 名下没有机器" ;;
		esac
		return 1
	fi
	fail=${TMPDIR:-/tmp}/instabox-keepalive-fail.$$
	: > "$fail"
	printf '%s\n' "$list" | while IFS='	' read -r id name; do
		[ -n "$id" ] || continue
		"$fn" "$id" "${name:-$id}" || echo x >> "$fail"
	done
	bad=$(wc -l < "$fail" | tr -d ' ')
	rm -f "$fail"
	if [ "$bad" != "0" ]; then
		log "$bad/$count 台失败"
		return 1
	fi
	return 0
}

# 逗号分隔的 key 列表 -> 逐把执行（空段/重复跳过）
# KEY 第 1 把 = 主 key（空 KEY 报错在 preflight），后面每把都当独立账号跑一轮
each_key() { # each_key <fn> —— 对每把 key 执行一轮（fn 全局变量 kfn，避免与 each_machine 的 fn 踩踏）
	kfn=$1
	# 没给 key 的时候直接报错退出：以前这里会静默跑完 0 个账号、退码 0，
	# 定时任务看着"成功"，其实一次都没续
	[ -n "$(printf '%s' "$KEY" | tr -d ' 	\n')" ] || die "未设置 INSTABOX_API_KEY（或 key=…）"
	all_keys=$KEY
	# 复用同一个 mktemp 文件：watch 模式下每轮都建新文件会堆一堆
	if [ -z "$TMP_KEYS" ]; then
		tmp_new
		TMP_KEYS=$TMP_NEW
	fi
	printf '%s\n' "$all_keys" | tr ',' '\n' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' |
		grep -v '^$' | awk '!seen[$0]++' >"$TMP_KEYS"
	total=$(wc -l <"$TMP_KEYS" | tr -d ' ')
	n=0
	bad=0
	while IFS= read -r k; do
		n=$((n + 1))
		KEY=$k
		if [ "$total" -gt 1 ]; then
			log "== 账号 $n/$total（key $(mask "$k")）=="
		fi
		if ! "$kfn"; then
			bad=$((bad + 1))
		fi
	done <"$TMP_KEYS"
	# 还原成完整列表：否则下一轮 each_key 只认得最后一把 key（多账号 watch 会少续）
	KEY=$all_keys
	# 任何一把失败就返回 1：--once 的退出码、安装时的冒烟测试、cron 的成败判断都靠这个
	[ "$bad" -eq 0 ] || return 1
	return 0
}

renew() { each_key renew_round; }

renew_round() { # 每把 key 一轮：校验 → 机器筛选 → 逐台续租
	preflight_nocall && resolve && each_machine renew_one
}

# 参数校验（不发请求）。多把 key 时 KEY 是逗号串，逐把 resolve 交给 each_key 做，
# 校验和解析必须分开：否则 watch 模式会拿 "k1,k2" 当 key 去请求，必然 401 然后反复重启。
preflight_nocall() {
	command -v curl >/dev/null 2>&1 || die "缺 curl（Alpine: apk add curl / Debian: apt-get install -y curl）"
	[ -n "$KEY" ] || die "未设置 INSTABOX_API_KEY（或 key=…）"
	# 这些值会被拼进 URL 和 .env，先按白名单过一遍（也挡掉换行注入）
	chk "$KEY" '^[A-Za-z0-9_,.-]+$' || die "INSTABOX_API_KEY 含非法字符（只允许字母数字和 _ , . -）"
	chk "$LEASE" '^[A-Za-z0-9_.-]{1,64}$' || die "INSTABOX_LEASE 只能是字母数字和 _ . -（1-64 位）"
	if [ "$ALL" -eq 0 ]; then
		[ -n "$MACHINE" ] || die "未设置 INSTABOX_MACHINE（填名字、填 all、或留空表示全部）"
		chk "$MACHINE" '^[A-Za-z0-9_.-]{1,128}$' || die "INSTABOX_MACHINE 只能是机器名或 m_ 开头的 id"
	fi
	if [ -n "${ALERT_WEBHOOK:-}" ]; then
		chk "$ALERT_WEBHOOK" '^https?://[^[:space:]]+$' || die "INSTABOX_ALERT_WEBHOOK 必须是 http(s) 地址"
	fi
	check_num INSTABOX_LEASE_TTL "$TTL" 30 3600
	return 0
}
release() { each_key release_round; }
status() { each_key status_round; }

release_round() { preflight_nocall && resolve && each_machine release_one; }
status_round() { preflight_nocall && resolve && each_machine status_one; }

# ---- 失败告警（可选） ---------------------------------------------------------
# 保活这东西最怕「悄悄失败」：机器睡了没人知道。配了 INSTABOX_ALERT_WEBHOOK 之后，
# 一轮失败就 POST 一条过去，恢复时再补一条；同一故障 ALERT_EVERY 秒内只发一次。
# 状态存在 .env 旁边的 .alert 文件里（一行 "ok|时间戳" / "fail|时间戳"）。
alert_file() { printf '%s' "$(dirname -- "${ENV_FILE:-$SELF_DIR/.env}")/.alert"; }

alert_send() { # alert_send <text>；0=发出去了
	[ -n "${ALERT_WEBHOOK:-}" ] || return 0
	esc=$(printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g')
	case "${ALERT_FORMAT:-text}" in
		feishu) body="{\"msg_type\":\"text\",\"content\":{\"text\":\"$esc\"}}" ;;
		dingtalk|wecom|wechat) body="{\"msgtype\":\"text\",\"text\":{\"content\":\"$esc\"}}" ;;
		discord) body="{\"content\":\"$esc\"}" ;;
		*) body="{\"text\":\"$esc\"}" ;;
	esac
	# 只有真的 2xx 才算发出去：webhook 返回 500/502 时 curl 的退出码仍是 0，
	# 光看退出码会把「没送达」记成「已通知」，下一次就被限频吞掉了
	code=$(curl -sS -m 15 --retry 1 -X POST "$ALERT_WEBHOOK" -H 'Content-Type: application/json' \
		-d "$body" -o /dev/null -w '%{http_code}' 2>/dev/null) || code=000
	# 只留数字：某些代理/网关会在状态码前后带空白
	code=$(printf '%s' "$code" | tr -cd '0-9')
	case "$code" in
		2??) return 0 ;;
	esac
	log "告警发送失败（HTTP $code），下一轮会重试"
	return 1
}

alert_after_round() { # alert_after_round <0=成功 1=失败>
	[ -n "${ALERT_WEBHOOK:-}" ] || return 0
	f=$(alert_file)
	st=ok
	at=0
	if [ -f "$f" ]; then
		st=$(cut -d'|' -f1 "$f" 2>/dev/null || echo ok)
		at=$(cut -d'|' -f2 "$f" 2>/dev/null || echo 0)
	fi
	now=$(date +%s)
	if [ "$1" -eq 0 ]; then
		[ "$st" = "fail" ] || return 0
		# 发不出去就保持 fail 状态，下一轮继续补，别把「已通知」记早了
		alert_send "[InstaBox 保活恢复] $(date '+%F %T') 续租恢复正常" &&
			{ printf 'ok|%s\n' "$now" > "$f" && chmod 600 "$f"; } 2>/dev/null
	else
		if [ "$st" = "fail" ] && [ $((now - at)) -lt "${ALERT_EVERY:-1800}" ]; then
			return 0
		fi
		alert_send "[InstaBox 保活失败] $(date '+%F %T') 续租失败：检查 key 权限 / 机器状态 / 网络（日志见上）" &&
			{ printf 'fail|%s\n' "$now" > "$f" && chmod 600 "$f"; } 2>/dev/null
	fi
	return 0
}

run_once() { # 一次续租（cron / 冒烟测试用）
	load_env "$SELF_DIR"
	reload_runtime
	if renew; then
		alert_after_round 0
		return 0
	fi
	alert_after_round 1
	return 1
}
run_watch() { # 常驻（systemd / OpenRC 用）
	load_env "$SELF_DIR"
	reload_runtime
	# 这里不能走 resolve：KEY 可能是逗号拼的多把，逐把解析留给每轮 renew 自己去做
	preflight_nocall
	if [ "$ALL" -eq 1 ]; then TARGET="全部机器（按 key 自动发现）"; else TARGET=$MACHINE; fi
	nkeys=$(printf '%s\n' "$KEY" | tr ',' '\n' | grep -c . || true)
	log "watch: 每 ${RENEW}s 续租 $TARGET/$LEASE（ttl ${TTL}s，${nkeys:-1} 把 key），API $API"
	while :; do
		# 按「起点 + 间隔」睡，而不是「干完再睡」：机器多、curl 慢的时候节奏不会越拖越长
		start=$(date +%s)
		if renew; then
			alert_after_round 0
		else
			log "这一轮有失败，下一轮再试"
			alert_after_round 1
		fi
		gap=$((RENEW - ($(date +%s) - start)))
		[ "$gap" -lt 5 ] && gap=5
		nap "$gap"
	done
}

# ---- 安装 --------------------------------------------------------------------
# 切换 supervisor 时清理另一种，避免两套调度同时跑
remove_cron_entry() {
	command -v crontab >/dev/null 2>&1 || return 0
	before=$(crontab -l 2>/dev/null || true)
	[ -n "$before" ] || return 0
	after=$(printf '%s\n' "$before" | grep -vF "$DIR/keepalive.sh" | grep -v '^$' || true)
	[ "$after" = "$before" ] && return 0
	printf '%s\n' "$after" | crontab - 2>/dev/null || return 0
	say "已清掉旧的 cron 条目（避免两套调度同时跑）"
}

remove_other_units() {
	u=/etc/systemd/system/$SERVICE.service
	if [ -f "$u" ] && grep -qF "$DIR/keepalive.sh" "$u"; then
		systemctl disable --now "$SERVICE.service" >/dev/null 2>&1 || true
		rm -f "$u"
		systemctl daemon-reload >/dev/null 2>&1 || true
		say "已停用旧的 systemd 服务 $SERVICE"
	fi
	i=/etc/init.d/$SERVICE
	if [ -f "$i" ] && grep -qF "$DIR/keepalive.sh" "$i"; then
		rc-service "$SERVICE" stop >/dev/null 2>&1 || true
		rc-update del "$SERVICE" default >/dev/null 2>&1 || true
		rm -f "$i"
		say "已停用旧的 OpenRC 服务 $SERVICE"
	fi
}

do_install() {
	orig_args=$*
	# 先解析参数、校验路径：写错目录这种事不用等 root 才告诉他
	while [ "$#" -gt 0 ]; do
		a=$1
		shift
		case "$a" in
			key=*|KEY=*|INSTABOX_API_KEY=*) API_KEY=${a#*=} ;;
			machine=*|INSTABOX_MACHINE=*) NAME=${a#*=} ;;
			--lease=*) LEASE=${a#*=}; LEASE_SET=1 ;;
			--lease) LEASE=${1:-}; LEASE_SET=1; [ "$#" -gt 0 ] && shift ;;
			--ttl=*) TTL=${a#*=}; TTL_SET=1 ;;
			--ttl) TTL=${1:-}; TTL_SET=1; [ "$#" -gt 0 ] && shift ;;
			--dir=*) DIR=${a#*=} ;;
			--dir) DIR=${1:-}; [ "$#" -gt 0 ] && shift ;;
			--service=*) SERVICE=${a#*=} ;;
			--service) SERVICE=${1:-}; [ "$#" -gt 0 ] && shift ;;
			--raw=*) RAW=${a#*=} ;;
			--raw) RAW=${1:-}; [ "$#" -gt 0 ] && shift ;;
			--api=*) API=${a#*=}; API_SET=1 ;;
			--api) API=${1:-}; API_SET=1; [ "$#" -gt 0 ] && shift ;;
			--no-start) WANT_START=0 ;;
			--cron) FORCE_CRON=1 ;;
			install) : ;;
			-h|--help) usage; exit 0 ;;
			*) die "未知安装参数: $a（看 --help）" ;;
		esac
	done

	# --api 显式给了才写进 .env，否则沿用旧值
	[ "${API_SET:-0}" -eq 1 ] && INSTABOX_API_URL=$API

	# 服务名会拼进 /etc/systemd/system/$SERVICE.service，必须严格白名单
	chk "$SERVICE" '^[A-Za-z0-9_.@-]{1,64}$' || die "服务名不合法：$SERVICE（只允许字母数字和 _ . @ -）"
	# 安装目录和卸载用同一套检查（规范化 + 系统目录 + 空白/换行 + ..）
	DIR=$(norm_dir "$DIR")
	check_dir_safe "$DIR" "安装"

	# 路径都合法了才要 root
	if [ "$(id -u)" -ne 0 ]; then
		if command -v sudo >/dev/null 2>&1 && [ -f "$0" ]; then
			log "需要 root，sudo 重跑一次"
			# shellcheck disable=SC2086
			exec sudo -E sh "$0" install $orig_args
		fi
		die "需要 root。非 root 机器： curl -Ls $RAW/keepalive.sh | sudo -E env key=你的KEY sh"
	fi

	# 没显式给 key 就沿用这台机器上已经装好的那份配置（重装/升级不会弄丢 key 和参数）
	if [ -f "$DIR/.env" ]; then
		[ -n "$API_KEY" ] || API_KEY=$(env_get "$DIR/.env" INSTABOX_API_KEY)
		[ -n "$NAME" ] || NAME=$(env_get "$DIR/.env" INSTABOX_MACHINE)
		if [ "${LEASE_SET:-0}" -eq 0 ]; then
			v=$(env_get "$DIR/.env" INSTABOX_LEASE)
			[ -n "$v" ] && LEASE=$v
		fi
		if [ "${TTL_SET:-0}" -eq 0 ]; then
			v=$(env_get "$DIR/.env" INSTABOX_LEASE_TTL)
			[ -n "$v" ] && TTL=$v
		fi
	fi
	[ -n "$API_KEY" ] || die "缺 key。用法： key=你的KEY bash <(curl -Ls $RAW/keepalive.sh)"

	chk "$API_KEY" '^[A-Za-z0-9_,.-]+$' || die "key 含非法字符（只允许字母数字和 _ , . -）"
	chk "$LEASE" '^[A-Za-z0-9_.-]{1,64}$' || die "租约名只能是字母数字和 _ . -（1-64 位）"
	if [ -n "$NAME" ] && [ "$NAME" != "all" ]; then
		chk "$NAME" '^[A-Za-z0-9_.-]{1,128}$' || die "machine 只能是机器名或 m_ 开头的 id"
	fi
	if [ -n "${INSTABOX_ALERT_WEBHOOK:-}" ]; then
		chk "$INSTABOX_ALERT_WEBHOOK" '^https?://[^[:space:]]+$' || die "INSTABOX_ALERT_WEBHOOK 必须是 http(s) 地址"
	fi

	check_num INSTABOX_LEASE_TTL "$TTL" 30 3600

	log "安装参数：key=$(mask "$API_KEY") machine=${NAME:-全部} lease=$LEASE ttl=${TTL}s dir=$DIR"

	if ! command -v curl >/dev/null 2>&1; then
		log "装 curl"
		if command -v apk >/dev/null 2>&1; then apk add --no-cache curl
		elif command -v apt-get >/dev/null 2>&1; then apt-get update -qq && apt-get install -y -qq curl
		elif command -v dnf >/dev/null 2>&1; then dnf install -y -q curl
		elif command -v yum >/dev/null 2>&1; then yum install -y -q curl
		elif command -v opkg >/dev/null 2>&1; then opkg update && opkg install curl
		fi
	fi
	command -v curl >/dev/null 2>&1 || die "curl 装不上，请手动装好再跑"

	mkdir -p "$DIR" || die "建不了目录 $DIR"
	# 目录里放的是 key：只给 root 进
	chmod 700 "$DIR" 2>/dev/null || true

	# 只有 $0 不是这份文件的真身时才需要搬；搬用 rename，避免正在跑的自己被写坏
	if [ "$SELF_DIR" = "$DIR" ] && [ -f "$DIR/keepalive.sh" ]; then
		say "脚本已在 $DIR/keepalive.sh，跳过复制"
	else
		tmp=$DIR/.keepalive.sh.new
		if [ -f "$0" ] && [ -r "$0" ] && [ "$SELF_DIR" != "/dev/fd" ]; then
			cp -f "$0" "$tmp" || die "复制脚本失败"
		else
			curl -fsSL -m 60 -o "$tmp" "$RAW/keepalive.sh" || die "下载 $RAW/keepalive.sh 失败"
		fi
		chmod 755 "$tmp"
		mv -f "$tmp" "$DIR/keepalive.sh" || die "落地 $DIR/keepalive.sh 失败"
		say "脚本已落地 $DIR/keepalive.sh"
	fi

	umask 077
	# 先把旧 .env 里的其余参数取出来：下面重写会先清空文件，边写边读会读空
	carry=
	for k in INSTABOX_RENEW_EVERY INSTABOX_AUTO_RESUME INSTABOX_WAKE_TRIES INSTABOX_WAKE_GAP \
		INSTABOX_ALERT_WEBHOOK INSTABOX_ALERT_FORMAT INSTABOX_ALERT_MIN_INTERVAL INSTABOX_API_URL; do
		v=$(getvar "$k")
		[ -n "$v" ] || v=$(env_get "$DIR/.env" "$k")
		[ -n "$v" ] && carry="$carry$k=$v
"
	done
	{
		printf 'INSTABOX_API_KEY=%s\n' "$API_KEY"
		printf 'INSTABOX_MACHINE=%s\n' "$NAME"
		printf 'INSTABOX_LEASE=%s\n' "$LEASE"
		printf 'INSTABOX_LEASE_TTL=%s\n' "$TTL"
		# 命令行/环境里给了就用新的，否则沿用旧值，重装不会把它们抹掉
		printf '%s' "$carry"
	} > "$DIR/.env" || die "写 $DIR/.env 失败"
	chmod 600 "$DIR/.env"
	printf '%s\n' '.env' 'install.conf' '.installed' '.alert' > "$DIR/.gitignore"
	{
		printf 'INSTABOX_SERVICE=%s\n' "$SERVICE"
		printf 'INSTABOX_DIR=%s\n' "$DIR"
		printf 'INSTABOX_RAW=%s\n' "$RAW"
	} > "$DIR/install.conf"
	# 安装标记：卸载时靠它确认这个目录确实是本脚本装的，才敢 rm -rf
	printf 'instabox-keepalive\n%s\n' "$(date '+%Y-%m-%d %H:%M:%S')" > "$DIR/.installed"
	chmod 600 "$DIR/install.conf" "$DIR/.installed" 2>/dev/null || true
	say "$DIR/.env 已写（目录 700 / 文件 600，key 只在这里）"

	log "冒烟测试：先手动续租一次"
	if ! INSTABOX_ENV_FILE=$DIR/.env sh "$DIR/keepalive.sh" --once; then
		die "续租测试没过，先解决上面的报错再装服务（key、machine 名字最容易错）"
	fi
	say "续租成功"

	interval_min=$((TTL * 3 / 5 / 60))
	[ "$interval_min" -lt 1 ] && interval_min=1
	suite=
	if [ "$FORCE_CRON" -eq 0 ]; then
		if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
			suite=systemd
		elif command -v rc-update >/dev/null 2>&1 && [ -x /sbin/openrc-run ]; then
			suite=openrc
		fi
	fi
	[ -n "$suite" ] || suite=cron

	case "$suite" in
		systemd)
			# 切回 systemd 时把旧的 cron 条目摘掉，避免两套调度同时续租
			remove_cron_entry
			cat > "/etc/systemd/system/$SERVICE.service" <<EOF_UNIT
[Unit]
Description=InstaBox keepalive (activity lease renewer)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$DIR
Environment=INSTABOX_ENV_FILE=$DIR/.env
ExecStart=/bin/sh $DIR/keepalive.sh --watch
Restart=always
RestartSec=10
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF_UNIT
			was_active=0
			systemctl is-active --quiet "$SERVICE" 2>/dev/null && was_active=1
			systemctl daemon-reload
			if [ "$WANT_START" -eq 1 ]; then
				systemctl enable "$SERVICE.service" >/dev/null 2>&1
				# 升级时服务已经在跑：enable --now 不会重启，得显式 restart 才会加载新脚本
				if [ "$was_active" -eq 1 ]; then
					systemctl restart "$SERVICE.service" >/dev/null 2>&1
					say "systemd 服务 $SERVICE 已重启（加载新版本）"
				else
					systemctl start "$SERVICE.service" >/dev/null 2>&1
					say "systemd 服务 $SERVICE 已启动"
				fi
			fi
			say "日志： journalctl -u $SERVICE -f"
			;;
		openrc)
			remove_cron_entry
			was_active=0
			rc-service "$SERVICE" status >/dev/null 2>&1 && was_active=1
			cat > "/etc/init.d/$SERVICE" <<EOF_INIT
#!/sbin/openrc-run
name="instabox keepalive"
command="/bin/sh"
command_args="$DIR/keepalive.sh --watch"
command_background=true
pidfile="/run/$SERVICE.pid"
output_log="/var/log/$SERVICE.log"
error_log="/var/log/$SERVICE.log"
export INSTABOX_ENV_FILE="$DIR/.env"
EOF_INIT
			chmod 755 "/etc/init.d/$SERVICE"
			rc-update add "$SERVICE" default >/dev/null 2>&1
			if [ "$WANT_START" -eq 1 ]; then
				if [ "$was_active" -eq 1 ]; then rc-service "$SERVICE" restart >/dev/null 2>&1
				else rc-service "$SERVICE" start >/dev/null 2>&1; fi
			fi
			say "OpenRC 服务 $SERVICE 已装（日志： /var/log/$SERVICE.log）"
			;;
		cron)
			# 切到 cron 时把旧的 systemd/openrc 服务停掉，避免两套调度
			remove_other_units
			case "$interval_min" in
				1) schedule='* * * * *' ;;
				*) schedule="*/$interval_min * * * *" ;;
			esac
			line="$schedule INSTABOX_ENV_FILE=$DIR/.env /bin/sh $DIR/keepalive.sh --once >/dev/null 2>&1"
			if [ "$WANT_START" -eq 1 ]; then
				( crontab -l 2>/dev/null | grep -vF "$DIR/keepalive.sh"; printf '%s\n' "$line" ) | crontab - || die "写 crontab 失败"
				say "cron 已装：$schedule（每 $interval_min 分钟一次）"
			else
				# --no-start 就该真的不启动：只打印命令，不写 crontab
				say "cron 未安装（--no-start）。要启用就加这条："
				say "  $line"
			fi
			;;
	esac

	echo
	if [ "$WANT_START" -eq 1 ]; then
		log "装好了。机器 ${NAME:-全部（按 key 自动发现）} 会被持续续租，就不会空闲挂起。"
	else
		log "装好了（--no-start，没启动）。启动： systemctl enable --now $SERVICE  或  rc-service $SERVICE start"
	fi
	say "看状态： sh $DIR/keepalive.sh --status"
	if [ -n "${INSTABOX_ALERT_WEBHOOK:-}" ]; then
		# webhook 地址里常带 token，只打域名
		say "失败告警： 已开（${ALERT_FORMAT:-text} → $(mask_url "$INSTABOX_ALERT_WEBHOOK")）"
	else
		say "失败告警： 未开（想开就设 INSTABOX_ALERT_WEBHOOK，见 README《提高保活成功率》）"
	fi
	say "卸载：   sh $DIR/keepalive.sh uninstall"
	say "手动续租一次： sh $DIR/keepalive.sh --once"
}

# ---- 卸载 --------------------------------------------------------------------
do_uninstall() {
	KEEP_FILES=0
	KEEP_LEASE=0
	DIR_GIVEN=0
	# 直接在安装目录里跑这份脚本（最常见）：落点就是它自己，别猜
	if [ -f "$SELF_DIR/install.conf" ]; then DIR=$SELF_DIR; fi
	while [ "$#" -gt 0 ]; do
		a=$1
		shift
		case "$a" in
			--keep-files) KEEP_FILES=1 ;;
			--keep-lease) KEEP_LEASE=1 ;;
			-h|--help) usage; exit 0 ;;
			--dir=*) DIR=${a#*=}; DIR_GIVEN=1 ;;
			--dir) DIR=${1:-}; DIR_GIVEN=1; [ "$#" -gt 0 ] && shift ;;
			--service=*) SERVICE=${a#*=} ;;
			--service) SERVICE=${1:-}; [ "$#" -gt 0 ] && shift ;;
			*) die "未知参数: $a（看 --help）" ;;
		esac
	done

	# 装的时候把落点写进 install.conf，这里照它找人，不靠猜。从 /dev/fd 跑（curl | sh）
	# 或者别人把脚本拷到别处跑，就退回默认目录。
	if [ "$DIR_GIVEN" -eq 0 ] && [ ! -f "$DIR/install.conf" ] && [ -f "$DEF_DIR/install.conf" ]; then DIR=$DEF_DIR; fi
	if [ -f "$DIR/install.conf" ]; then
		v=$(sed -n 's/^INSTABOX_SERVICE=//p' "$DIR/install.conf" | head -n 1)
		[ -n "$v" ] && SERVICE=$v
		v=$(sed -n 's/^INSTABOX_RAW=//p' "$DIR/install.conf" | head -n 1)
		[ -n "$v" ] && RAW=$v
	fi

	# 路径和安装用同一套检查：规范化 + 拒绝系统目录/空白/换行/..
	DIR=$(norm_dir "$DIR")
	check_dir_safe "$DIR" "卸载"

	# 服务名会拼进 /etc/systemd/system/$SERVICE.service，白名单外一律拒绝
	chk "$SERVICE" '^[A-Za-z0-9_.@-]{1,64}$' || die "服务名不合法：$SERVICE"

	# 路径和服务名都过了才要求 root：写错的路径先在本地就被拦下，不用等 sudo
	[ "$(id -u)" -eq 0 ] || die "需要 root（curl -Ls $RAW/keepalive.sh | sudo -E sh -s uninstall）"

	# 1) 监督者。unit 只有确实指向这个目录才删——卸载绝不能顺手带走同名的别人的服务。
	UNIT=/etc/systemd/system/$SERVICE.service
	if [ -f "$UNIT" ]; then
		if grep -qF "$DIR/keepalive.sh" "$UNIT"; then
			systemctl disable --now "$SERVICE.service" >/dev/null 2>&1 || true
			rm -f "$UNIT"
			systemctl daemon-reload >/dev/null 2>&1 || true
			say "已停止并删除 systemd 服务 $SERVICE"
		else
			say "跳过 systemd 服务 $SERVICE：它不指向 $DIR"
		fi
	fi
	INIT=/etc/init.d/$SERVICE
	if [ -f "$INIT" ]; then
		if grep -qF "$DIR/keepalive.sh" "$INIT"; then
			rc-service "$SERVICE" stop >/dev/null 2>&1 || true
			rc-update del "$SERVICE" default >/dev/null 2>&1 || true
			rm -f "$INIT"
			say "已停止并删除 OpenRC 服务 $SERVICE"
		else
			say "跳过 OpenRC 服务 $SERVICE：它不指向 $DIR"
		fi
	fi
	if command -v crontab >/dev/null 2>&1; then
		BEFORE=$(crontab -l 2>/dev/null || true)
		AFTER=$(printf '%s\n' "$BEFORE" | grep -vF "$DIR/keepalive.sh" | grep -v '^$' || true)
		if [ "$AFTER" != "$BEFORE" ]; then
			printf '%s\n' "$AFTER" | crontab - 2>/dev/null || true
			say "已删掉 cron 条目"
		fi
	fi

	# 2) 租约：主动放掉，机器立刻恢复“空闲 30 分钟自动挂起”的正常行为
	if [ "$KEEP_LEASE" -eq 0 ] && [ -f "$DIR/keepalive.sh" ] && [ -f "$DIR/.env" ]; then
		INSTABOX_ENV_FILE=$DIR/.env sh "$DIR/keepalive.sh" --release || true
	fi

	# 3) 文件：只有确认这个目录是本脚本装的（.installed 内容对得上）才删
	if [ "$KEEP_FILES" -eq 0 ]; then
		if is_installed_dir "$DIR"; then
			rm -rf "$DIR"
			say "已删除 $DIR"
		else
			say "跳过删除 $DIR：没有有效的安装标记 .installed（不是本脚本装的目录，不删）"
		fi
	else
		say "保留 $DIR（--keep-files）"
	fi
	log "卸载完了。"
}

usage() {
	sed -n '2,/^set -u$/p' "$0" | sed -e 's/^# \?//' -e '$d'
}

case "${1:-}" in
	install)
		shift
		do_install "$@"
		;;
	uninstall|--uninstall|-U)
		shift
		do_uninstall "$@"
		;;
	--watch|-w) run_watch ;;
	--once|-1) run_once ;;
	--status|-s)
		load_env "$SELF_DIR"
		reload_runtime
		status
		;;
	--release|-r)
		load_env "$SELF_DIR"
		reload_runtime
		release
		;;
	-h|--help|help) usage ;;
	key=*|KEY=*|machine=*|INSTABOX_*=*|--lease*|--ttl*|--dir*|--service*|--raw*|--api*|--no-start|--cron)
		do_install "$@"
		;;
	'')
		# 不带参数 = 安装（`key=… bash <(curl …/keepalive.sh)` 的用法）
		# 已经装过的机器上再跑一次 = 按现有 .env 重装/升级
		do_install
		;;
	*)
		printf '未知参数: %s\n\n' "$1" >&2
		usage >&2
		exit 2
		;;
esac
