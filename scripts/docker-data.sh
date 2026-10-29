#!/bin/sh
set -eu
umask 077

fail() {
  printf '%s\n' "$*" >&2
  exit 1
}

root=$(CDPATH= cd "$(dirname "$0")/.." && pwd)
environment_file=$root/.env.docker
project_name=haulpath
temporary=
trap 'test -z "$temporary" || rm -f "$temporary"' 0
trap 'exit 1' HUP INT TERM

compose() {
  docker compose --project-directory "$root" --file "$root/compose.yaml" \
    --env-file "$environment_file" --project-name "$project_name" "$@"
}

deployment() {
  command -v docker >/dev/null 2>&1 || fail '需要可用的 Docker 和 Compose'
  test -f "$environment_file" && test -r "$environment_file" || fail "环境文件不存在或不可读：$environment_file"
  environment_directory=$(CDPATH= cd "$(dirname "$environment_file")" && pwd -P)
  environment_file=$environment_directory/$(basename "$environment_file")
  application=$(compose ps --all --quiet app)
  if test -z "$application"; then
    compose create --no-build --no-recreate app >&2
    application=$(compose ps --all --quiet app)
  fi
  case "$application" in
    ''|*'
'*) fail '维护要求恰好一个应用容器' ;;
  esac
  data_volume=$(docker inspect --format '{{range .Mounts}}{{if and (eq .Destination "/app/data") (eq .Type "volume")}}{{.Name}}{{end}}{{end}}' "$application")
  test -n "$data_volume" || fail '无法识别应用实际使用的数据卷'
  image=$(docker inspect --format '{{.Image}}' "$application")
}

data() {
  docker run --rm --interactive --network none --no-healthcheck \
    --mount "type=volume,source=$data_volume,target=/app/data" \
    --entrypoint node "$image" scripts/docker/data.mjs "$@"
}

require_stopped_volume() {
  for container in $(docker ps --quiet --filter "volume=$data_volume"); do
    mounted=$(docker inspect --format '{{range .Mounts}}{{if eq .Name "'"$data_volume"'"}}used{{end}}{{end}}' "$container")
    test -z "$mounted" || fail "数据卷仍被运行容器占用：${container}；请先停止相关应用后重试"
  done
}

quote() {
  printf "'"
  printf '%s' "$1" | sed "s/'/'\\\\''/g"
  printf "'"
}

startup() {
  printf '应用保持停止。核对后执行：\n' >&2
  {
    printf 'docker compose --project-directory '
    quote "$root"
    printf ' --file '
    quote "$root/compose.yaml"
    printf ' --env-file '
    quote "$environment_file"
    printf ' --project-name '
    quote "$project_name"
    printf ' up --detach --no-build --wait app\n'
  } >&2
}
while test "$#" -gt 0; do
  case "$1" in
    --env-file)
      test "$#" -ge 2 || fail '--env-file 需要文件参数'
      environment_file=$2
      shift 2
      ;;
    --project-name)
      test "$#" -ge 2 || fail '--project-name 需要名称参数'
      project_name=$2
      shift 2
      ;;
    --) shift; break ;;
    -*) fail "不支持的选项：$1" ;;
    *) break ;;
  esac
done
test "$#" -eq 2 || fail '用法：docker-data.sh [--env-file 文件] [--project-name 名称] backup|restore|migrate <宿主文件>'
operation=$1
host_path=$2
case "$project_name" in
  ''|*[!a-z0-9_-]*|[-_]*) fail 'Compose 项目名必须以小写字母或数字开始，且仅含小写字母、数字、连字符或下划线' ;;
esac

case "$operation" in
  backup)
    if test -e "$host_path" || test -L "$host_path"; then
      fail "备份目标已存在：$host_path"
    fi
    host_directory=$(dirname "$host_path")
    test -d "$host_directory" && test -w "$host_directory" || fail "备份目标目录不存在或不可写：$host_directory"
    deployment
    temporary=$(mktemp "$host_directory/.haulpath-backup.XXXXXX")
    data backup > "$temporary" || fail '备份失败；未发布目标文件'
    if test -e "$host_path" || test -L "$host_path"; then
      fail "备份目标已存在：$host_path"
    fi
    ln "$temporary" "$host_path" || fail '无法无覆盖保存备份目标'
    rm -f "$temporary"
    temporary=
    printf '备份完成：%s\n' "$host_path" >&2
    ;;
  restore)
    test -f "$host_path" && test -r "$host_path" || fail "恢复输入不存在或不可读：$host_path"
    deployment
    compose stop app >&2
    require_stopped_volume
    data restore < "$host_path" || fail '恢复失败；应用保持停止，请保留旧资料与归档并检查错误'
    startup
    ;;
  migrate)
    test -f "$host_path" && test -r "$host_path" || fail "迁入源不存在或不可读：$host_path"
    deployment
    require_stopped_volume
    source_directory=$(CDPATH= cd "$(dirname "$host_path")" && pwd -P)
    source_name=$(basename "$host_path")
    source_csv=$(printf '%s' "$source_directory" | sed 's/"/""/g')
    temporary=$(mktemp "${TMPDIR:-/tmp}/haulpath-migrate.XXXXXX")
    printf '请确认原应用服务已停止；正在只读生成源数据库一致快照。\n' >&2
    docker run --rm --network none --no-healthcheck --user "$(id -u):$(id -g)" \
      --mount "type=bind,\"source=$source_csv\",target=/source,readonly" \
      --entrypoint node "$image" scripts/docker/data.mjs source "/source/$source_name" \
      > "$temporary" || fail '迁入源快照失败；未安装目标数据库'
    data migrate < "$temporary" || fail '迁入失败；未覆盖已有目标资料，请保持应用停止并检查错误'
    rm -f "$temporary"
    temporary=
    printf '迁入完成；原目录保持不变。\n' >&2
    startup
    ;;
  *) fail "不支持的维护操作：$operation" ;;
esac
