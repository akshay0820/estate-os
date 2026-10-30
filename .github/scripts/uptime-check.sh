#!/usr/bin/env bash
# External uptime check, run by .github/workflows/uptime.yml (and runnable locally).
# Checks each URL; a URL is down only after ATTEMPTS failed tries RETRY_DELAY seconds apart, so one slow response does not
# page anyone. HTTP 200 is up; anything else (the health endpoint answers 503 when degraded or down) is down.
# Env: HEALTH_URL, SITE_URL, ATTEMPTS (3), RETRY_DELAY (20), SIMULATE_FAILURE (true to test the alert path).
# Exit 0 when everything is up, 1 otherwise. Writes `summary` to $GITHUB_OUTPUT when set.
set -u

attempts=${ATTEMPTS:-3}
delay=${RETRY_DELAY:-20}
summary=""
failed=0

check() {
  local name=$1 url=$2 code="" i
  for ((i = 1; i <= attempts; i++)); do
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 -H 'Cache-Control: no-cache' "$url" || true)
    [ "$code" = "200" ] && break
    [ "$i" -lt "$attempts" ] && sleep "$delay"
  done
  if [ "$code" = "200" ]; then
    summary+="- ✅ $name: HTTP 200"$'\n'
  else
    summary+="- ❌ $name: HTTP ${code:-000} after $attempts attempts ($url)"$'\n'
    failed=1
  fi
}

if [ "${SIMULATE_FAILURE:-false}" = "true" ]; then
  summary="- ❌ Simulated failure (manual test of the alert; nothing is actually down)"$'\n'
  failed=1
else
  check "Health endpoint" "${HEALTH_URL:?HEALTH_URL is required}"
  check "Web app" "${SITE_URL:?SITE_URL is required}"
fi

printf '%s' "$summary"
if [ -n "${GITHUB_OUTPUT:-}" ]; then
  { echo 'summary<<UPTIME_EOF'; printf '%s' "$summary"; echo 'UPTIME_EOF'; } >> "$GITHUB_OUTPUT"
fi
exit "$failed"
