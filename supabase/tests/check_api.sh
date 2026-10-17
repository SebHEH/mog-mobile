#!/usr/bin/env bash
# Checks the PUBLIC side of the MOG schema: what anyone holding the
# publishable key can and can't do. Every request here is one that MUST be
# refused, so it needs no PIN, token, or sync key. Run after schema.sql (and
# again after any schema change).
#
# usage: bash supabase/tests/check_api.sh <project_url> <publishable_key>
set -u
URL="${1%/}"; KEY="$2"
pass=0; fail=0

# check <name> <expected HTTP status> <expected body substring> <curl args...>
check() {
  local name="$1" want_code="$2" want_body="$3"; shift 3
  local body code
  body=$(curl -s --max-time 30 -w $'\n%{http_code}' -H "apikey: $KEY" "$@")
  code="${body##*$'\n'}"; body="${body%$'\n'*}"
  if [ "$code" = "$want_code" ] && [[ "$body" == *"$want_body"* ]]; then
    echo "PASS  $name"; pass=$((pass+1))
  else
    echo "FAIL  $name  (got HTTP $code: ${body:0:200})"; fail=$((fail+1))
  fi
}

rpc() { echo "$URL/rest/v1/rpc/$1"; }
J=(-H 'Content-Type: application/json')

check "tables: not reachable in public"           404 ''   "$URL/rest/v1/stores"
check "tables: private schema not exposed"        406 ''   -H 'Accept-Profile: mog' "$URL/rest/v1/counts"
check "provision_store: not callable over API"    406 ''   -X POST "${J[@]}" -H 'Content-Profile: mog' -d '{"p_slug":"x"}' "$(rpc provision_store)"
check "helpers: not exposed"                      404 ''   -X POST "${J[@]}" -d '{"p":"x"}' "$(rpc sha256_hex)"
check "speedtest table: dropped"                  404 ''   "$URL/rest/v1/speedtest"
check "login: unknown store refused"              200 'Unknown store'   -X POST "${J[@]}" -d '{"p_slug":"nosuchstore","p_pin":"0"}' "$(rpc mog_login)"
check "snapshot: bad token refused"               200 'SESSION_EXPIRED' -X POST "${J[@]}" -d '{"p_token":"bogus"}' "$(rpc mog_snapshot)"
check "save: bad token refused"                   200 'SESSION_EXPIRED' -X POST "${J[@]}" -d '{"p_token":"bogus","p_cycle_date":"2026-10-15","p_vendor":"V","p_items":[]}' "$(rpc mog_save_counts)"
check "sync: bad key refused"                     200 'BAD_SYNC_KEY'    -X POST "${J[@]}" -d '{"p_slug":"rprfo","p_key":"bogus"}' "$(rpc mog_sync_get_cycle)"
check "sync: bad key can't push a catalog"        200 'BAD_SYNC_KEY'    -X POST "${J[@]}" -d '{"p_slug":"rprfo","p_key":"bogus","p_version":1,"p_payload":{}}' "$(rpc mog_sync_push_catalog)"
# schema v2
check "v2 order_log table: not reachable"         404 ''   "$URL/rest/v1/order_log"
check "v2 sync: bad key can't read a snapshot"    200 'BAD_SYNC_KEY'    -X POST "${J[@]}" -d '{"p_slug":"rprfo","p_key":"bogus"}' "$(rpc mog_sync_get_snapshot)"
check "v2 sync: bad key can't close a cycle"      200 'BAD_SYNC_KEY'    -X POST "${J[@]}" -d '{"p_slug":"rprfo","p_key":"bogus","p_closing":"2026-10-15","p_new_cycle":"2026-10-16","p_new_dow":"Fri","p_rows":[],"p_todays_log":[]}' "$(rpc mog_sync_close_cycle)"
check "v2 sync: bad key can't read the order log" 200 'BAD_SYNC_KEY'    -X POST "${J[@]}" -d '{"p_slug":"rprfo","p_key":"bogus","p_date":"2026-10-15"}' "$(rpc mog_sync_get_log)"
check "v2 sync: bad key can't set the override"   200 'BAD_SYNC_KEY'    -X POST "${J[@]}" -d '{"p_slug":"rprfo","p_key":"bogus","p_on":true}' "$(rpc mog_sync_set_override)"

# schema v3
check "v3 sync: bad key can't set phone_direct"   200 'BAD_SYNC_KEY'    -X POST "${J[@]}" -d '{"p_slug":"rprfo","p_key":"bogus","p_on":true}' "$(rpc mog_sync_set_phone_direct)"
check "v3 helper: phone_direct_on not exposed"    404 ''   -X POST "${J[@]}" -d '{"p_slug":"rprfo"}' "$(rpc phone_direct_on)"

# schema v4
check "v4 catalog tables: not reachable"          404 ''   "$URL/rest/v1/items"
check "v4 catalog tables: private schema"         406 ''   -H 'Accept-Profile: mog' "$URL/rest/v1/pick_rows"
check "v4 sync: bad key can't seed the catalog"   200 'BAD_SYNC_KEY'    -X POST "${J[@]}" -d '{"p_slug":"rprfo","p_key":"bogus","p_tables":{}}' "$(rpc mog_sync_seed_catalog)"
check "v4 sync: bad key can't read the status"    200 'BAD_SYNC_KEY'    -X POST "${J[@]}" -d '{"p_slug":"rprfo","p_key":"bogus"}' "$(rpc mog_sync_get_status)"
check "v4 helper: catalog_from_tables not exposed" 404 ''  -X POST "${J[@]}" -d '{"p_slug":"rprfo"}' "$(rpc catalog_from_tables)"
check "v4 helper: copy_store_catalog not exposed" 404 ''   -X POST "${J[@]}" -d '{"p_from":"rprfo","p_to":"x"}' "$(rpc copy_store_catalog)"

echo "---"
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
