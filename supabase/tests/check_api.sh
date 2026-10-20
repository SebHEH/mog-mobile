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

# schema v5
check "v5 tables: presence not reachable"         404 ''   "$URL/rest/v1/presence"
check "v5 tables: names not reachable"            404 ''   "$URL/rest/v1/store_people"
check "v5 snapshot2: bad token refused"           200 'SESSION_EXPIRED' -X POST "${J[@]}" -d '{"p_token":"bogus","p_device":"deviceXXXX0000","p_name":"x","p_vendor":"y"}' "$(rpc mog_snapshot2)"
check "v5 save_counts2: bad token refused"        200 'SESSION_EXPIRED' -X POST "${J[@]}" -d '{"p_token":"bogus","p_cycle_date":"2026-10-18","p_vendor":"V","p_items":[],"p_by":"x"}' "$(rpc mog_save_counts2)"
check "v5 helper: touch_presence not exposed"     404 ''   -X POST "${J[@]}" -d '{"p_slug":"rprfo","p_device":"deviceXXXX0000","p_name":"x","p_vendor":"y"}' "$(rpc touch_presence)"
check "v5 helper: live_json not exposed"          404 ''   -X POST "${J[@]}" -d '{"p_slug":"rprfo","p_device":"x"}' "$(rpc live_json)"

# schema v6. Never send a PIN to a real store: a wrong one counts against the
# lockout its phones share. (This probe sent PIN 0 to rprfo while its editor was
# in the Sheet; once every store moved, 2026-10-19, it became a real wrong PIN.
# smoke_v6.sql covers the EDITOR_NOT_DIRECT refusal on a throwaway store.)
check "v6 tables: change log not reachable"       404 ''   "$URL/rest/v1/change_log"
check "v6 editor_login: unknown store refused"    200 'Unknown store'     -X POST "${J[@]}" -d '{"p_slug":"nosuchstore","p_pin":"0"}' "$(rpc mog_editor_login)"
check "v6 editor_get: bad token refused"          200 'SESSION_EXPIRED' -X POST "${J[@]}" -d '{"p_token":"bogus"}' "$(rpc mog_editor_get)"
check "v6 editor_apply: bad token refused"        200 'SESSION_EXPIRED' -X POST "${J[@]}" -d '{"p_token":"bogus","p_label":"x","p_by":"x","p_ops":[]}' "$(rpc mog_editor_apply)"
check "v6 editor_undo: bad token refused"         200 'SESSION_EXPIRED' -X POST "${J[@]}" -d '{"p_token":"bogus","p_change_id":1,"p_by":"x"}' "$(rpc mog_editor_undo)"
check "v6 helper: editor_apply_ops not exposed"   404 ''   -X POST "${J[@]}" -d '{"p_slug":"rprfo","p_ops":[]}' "$(rpc editor_apply_ops)"
check "v6 helper: tables_json not exposed"        404 ''   -X POST "${J[@]}" -d '{"p_slug":"rprfo"}' "$(rpc tables_json)"

# schema v7
check "v7 tables: quick edits not reachable"      404 ''   "$URL/rest/v1/quick_edits"
check "v7 quick_edit: bad token refused"          200 'SESSION_EXPIRED' -X POST "${J[@]}" -d '{"p_token":"bogus","p_cycle_date":"2026-10-18","p_kind":"par_today","p_vendor":"V","p_item_id":"X","p_par":1}' "$(rpc mog_quick_edit)"
check "v7 set_par: bad token refused"             200 'SESSION_EXPIRED' -X POST "${J[@]}" -d '{"p_token":"bogus","p_item_id":"X","p_par_before":1,"p_par":2}' "$(rpc mog_set_par)"
check "v7 editor_review: bad token refused"       200 'SESSION_EXPIRED' -X POST "${J[@]}" -d '{"p_token":"bogus","p_id":1,"p_status":"dismissed"}' "$(rpc mog_editor_review)"
check "v7 helper: prepare_test_store not exposed" 404 ''   -X POST "${J[@]}" -d '{"p_slug":"rprfotest"}' "$(rpc prepare_test_store)"
check "v7 helper: today_edits_json not exposed"   404 ''   -X POST "${J[@]}" -d '{"p_slug":"rprfo","p_cycle":"2026-10-18"}' "$(rpc today_edits_json)"

# schema v8
check "v8 sync: bad key can't switch the editor"  200 'BAD_SYNC_KEY'    -X POST "${J[@]}" -d '{"p_slug":"rprfo","p_key":"bogus","p_start_empty":true}' "$(rpc mog_sync_switch_editor)"

# schema v9
check "v9 tables: recipients not reachable"       404 ''   "$URL/rest/v1/recipients"
check "v9 history: bad token refused"             200 'SESSION_EXPIRED' -X POST "${J[@]}" -d '{"p_token":"bogus","p_from":null,"p_to":null}' "$(rpc mog_history)"
check "v9 recipients_get: bad token refused"      200 'SESSION_EXPIRED' -X POST "${J[@]}" -d '{"p_token":"bogus"}' "$(rpc mog_recipients_get)"
check "v9 recipients_save: bad token refused"     200 'SESSION_EXPIRED' -X POST "${J[@]}" -d '{"p_token":"bogus","p_recipients":[],"p_gm_edit":true}' "$(rpc mog_recipients_save)"
check "v9 people_list: bad token refused"         200 'SESSION_EXPIRED' -X POST "${J[@]}" -d '{"p_token":"bogus"}' "$(rpc mog_people_list)"
check "v9 people_rename: bad token refused"       200 'SESSION_EXPIRED' -X POST "${J[@]}" -d '{"p_token":"bogus","p_from":"a","p_to":"b"}' "$(rpc mog_people_rename)"
check "v9 people_remove: bad token refused"       200 'SESSION_EXPIRED' -X POST "${J[@]}" -d '{"p_token":"bogus","p_name":"a"}' "$(rpc mog_people_remove)"
check "v9 people_join: bad token refused"         200 'SESSION_EXPIRED' -X POST "${J[@]}" -d '{"p_token":"bogus","p_name":"a"}' "$(rpc mog_people_join)"
check "v9 editor_status: bad token refused"       200 'SESSION_EXPIRED' -X POST "${J[@]}" -d '{"p_token":"bogus"}' "$(rpc mog_editor_status)"
check "v9 clear_lockout: bad token refused"       200 'SESSION_EXPIRED' -X POST "${J[@]}" -d '{"p_token":"bogus"}' "$(rpc mog_editor_clear_lockout)"
check "v9 sync: bad key can't copy a log in"      200 'BAD_SYNC_KEY'    -X POST "${J[@]}" -d '{"p_slug":"rprfo","p_key":"bogus","p_rows":[]}' "$(rpc mog_sync_backfill_log)"
check "v9 sync: bad key can't read recipients"    200 'BAD_SYNC_KEY'    -X POST "${J[@]}" -d '{"p_slug":"rprfo","p_key":"bogus"}' "$(rpc mog_sync_get_recipients)"
check "v9 sync: bad key can't seed recipients"    200 'BAD_SYNC_KEY'    -X POST "${J[@]}" -d '{"p_slug":"rprfo","p_key":"bogus","p_recipients":[]}' "$(rpc mog_sync_seed_recipients)"
check "v9 helper: recipients_check not exposed"   404 ''   -X POST "${J[@]}" -d '{"p_slug":"rprfo","p_list":[],"p_gm_edit":true}' "$(rpc recipients_check)"
check "v9 helper: person_now not exposed"         404 ''   -X POST "${J[@]}" -d '{"p_slug":"rprfo","p_name":"x"}' "$(rpc person_now)"

echo "---"
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
