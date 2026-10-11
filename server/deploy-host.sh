#!/usr/bin/env bash
# Invoked over verified SSH. Never enable shell tracing.
set -euo pipefail
umask 077

action=${1:?action required}
export CCGC_HOST=${2:?hostname required}
[[ "$CCGC_HOST" =~ ^[a-z][a-z0-9-]+\.swedencentral\.cloudapp\.azure\.com$ ]] || exit 2
cd /opt/ccgc
compose=(docker compose -f server/compose.yaml)

case "$action" in
  prepare)
    "${compose[@]}" build --quiet setup
    docker run --rm --network none --read-only --tmpfs /tmp:mode=1777,size=128m \
      -v /opt/ccgc/server:/checks:ro --entrypoint /opt/venv/bin/python \
      ccgc-runtime:0.2.0-alpha.1 -m unittest discover -s /checks -p test_bootstrap.py
    docker run --rm --network none --read-only --tmpfs /tmp:mode=1777,size=128m \
      -v /opt/ccgc/server:/checks:ro --entrypoint /opt/venv/bin/python \
      ccgc-runtime:0.2.0-alpha.1 -m unittest discover -s /checks -p integration_litellm.py
    ;;
  status|verify|owner-key)
    "${compose[@]}" run --rm -T setup "$action" </dev/null
    ;;
  catalog-preview)
    "${compose[@]}" run --rm -T setup catalog --accept-unofficial </dev/null
    ;;
  catalog-apply)
    "${compose[@]}" stop ingress gateway litellm
    "${compose[@]}" run --rm -T setup catalog --accept-unofficial --apply </dev/null
    ;;
  inspect)
    docker inspect ccgc-gateway-1 ccgc-litellm-1 --format '{{.Image}}' | \
      python3 -c 'import json,sys; ids=sys.stdin.read().splitlines(); assert len(ids)==2 and ids[0]==ids[1]; print(json.dumps({"imageId":ids[0]}))'
    ;;
  authorize)
    "${compose[@]}" run --rm -T setup authorize --accept-unofficial </dev/null
    ;;
  init)
    "${compose[@]}" run --rm -T setup init --accept-unofficial \
      --public-url "https://$CCGC_HOST" --expected-login "${3:?login required}" \
      --expected-account-id "${4:?account ID required}" --model "${5:?model required}" </dev/null
    ;;
  activate)
    "${compose[@]}" run --rm -T setup verify </dev/null
    "${compose[@]}" up -d --wait --wait-timeout 180 litellm gateway ingress
    ;;
  *)
    printf 'HOST_ACTION_BLOCKED: unknown action\n' >&2
    exit 2
    ;;
esac
