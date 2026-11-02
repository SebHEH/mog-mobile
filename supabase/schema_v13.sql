-- =====================================================================
-- MOG on Supabase — schema v13   (run AFTER schema.sql and v2 to v12)
-- =====================================================================
-- Happy Supply, the warehouse, phase W1 (docs/MOG_Warehouse_Spec.md §2,
-- "Design: W1, with W2's data", approved 2026-11-02): what HEH stocks in
-- its own storage (king crab, shrimp) at each location, vendor orders in,
-- transfers between locations, counts, and every change kept with who,
-- when and why. Chef Dan works it on HQ's Happy Supply pages (hq/) with a
-- warehouse role; HQ's catalog pages stay with the hq role. Store orders
-- (W2) and chargebacks (W3) come later, and their tables with them.
--
-- Unlike the catalog, the rules live HERE, not in the page: the handling
-- fee must never reach a store, a price will lock on the server (W2), and
-- two tabs acting at once must not take the same stock twice. The page
-- shows and sends. Every write is one function and one transaction, with
-- the products it touches locked (in id order, so two writes never wait on
-- each other in a circle).
--
-- Adds:
--   * mog.hq_users.roles: hq, warehouse or both. Everyone invited before
--     this file gets both, once (a re-run never widens anyone).
--     mog.hq_invite(name, roles) and mog.hq_set_roles(name, roles), SQL
--     Editor only. mog.hq_session, which HQ's catalog functions
--     (mog_hq_data, mog_hq_apply) call first, now answers only for the hq
--     role: a warehouse sign-in can't read or change a store's catalog.
--     Signing in also returns the person's roles.
--   * Tables: mog.wh_locations, wh_suppliers, wh_products (pack, par,
--     average cost and handling fee per case, the stores it's limited to),
--     wh_stock (a product's cases at a location, never below 0), wh_moves
--     (every change to stock, never edited), wh_pos / wh_po_lines (vendor
--     orders in, PO-0001), wh_transfers / wh_transfer_lines (TR-0001, in
--     transit between send and receive), wh_settings (markup % and the
--     delivery fee per order, both 0).
--   * mog_wh_data, mog_wh_history, mog_wh_save (a product, a location, a
--     supplier or the settings), mog_wh_po_save, mog_wh_po_cancel,
--     mog_wh_po_receive, mog_wh_transfer_send, mog_wh_transfer_receive,
--     mog_wh_count. Each takes an HQ token with the warehouse role, and
--     each write answers with the whole warehouse, as mog_wh_data does.
--
-- The average cost covers every location and what's in transit: receiving
-- c cases at cost k makes it (owned x average + c x k) / (owned + c),
-- kept to 4 decimals (mog.wh_avg_after; the page's preview is the same
-- sum, pinned by tests/warehouse.test.js and smoke_v13.sql).
--
-- Re-running is safe (IF NOT EXISTS / CREATE OR REPLACE).
-- =====================================================================

do $$
begin
  if to_regprocedure('mog.library_put(text, jsonb)') is null then
    raise exception 'Run schema_v12.sql first: mog.library_put is missing.';
  end if;
end;
$$;


-- ---------------------------------------------------------------------
-- Roles
-- ---------------------------------------------------------------------

-- Added once. Everyone already invited is a maintainer and gets both.
do $$
begin
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'mog' and table_name = 'hq_users' and column_name = 'roles') then
    alter table mog.hq_users add column roles text[] not null default '{hq}';
    update mog.hq_users set roles = '{hq,warehouse}';
  end if;
end;
$$;
alter table mog.hq_users drop constraint if exists hq_users_roles_check;
alter table mog.hq_users add constraint hq_users_roles_check
  check (cardinality(roles) between 1 and 2 and roles <@ array['hq', 'warehouse']::text[]);

-- hq, warehouse or both, sorted; anything else is refused.
create or replace function mog.hq_roles_clean(p_roles text[])
returns text[]
language plpgsql immutable
set search_path = ''
as $$
declare
  v text[];
begin
  select coalesce(array_agg(distinct lower(btrim(r)) order by lower(btrim(r))), '{}') into v
    from unnest(coalesce(p_roles, '{}'::text[])) r where btrim(coalesce(r, '')) <> '';
  if cardinality(v) = 0 or not (v <@ array['hq', 'warehouse']::text[]) then
    raise exception 'Roles are hq, warehouse or both, for example ''{warehouse}''.';
  end if;
  return v;
end;
$$;

-- An invite with roles (SQL Editor only): select mog.hq_invite('Dan', '{warehouse}');
-- The one-argument form keeps an existing person's roles and gives a new
-- person hq.
create or replace function mog.hq_invite(p_name text, p_roles text[])
returns text
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_roles text[] := mog.hq_roles_clean(p_roles);
  v_msg   text := mog.hq_invite(p_name);
begin
  update mog.hq_users set roles = v_roles where lower(name) = lower(btrim(coalesce(p_name, '')));
  return v_msg || '  roles: ' || array_to_string(v_roles, ', ');
end;
$$;

-- Change someone's roles without a new invite (SQL Editor only). Takes
-- effect on their next call.
create or replace function mog.hq_set_roles(p_name text, p_roles text[])
returns text
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_roles text[] := mog.hq_roles_clean(p_roles);
  v_name  text;
begin
  update mog.hq_users set roles = v_roles where lower(name) = lower(btrim(coalesce(p_name, '')))
  returning name into v_name;
  if v_name is null then
    return 'No HQ user called ' || coalesce(p_name, '');
  end if;
  return v_name || ' now has: ' || array_to_string(v_roles, ', ');
end;
$$;

-- Whoever this token belongs to, whatever their roles, or null.
create or replace function mog.hq_any_session(p_token text)
returns text
language sql stable security definer
set search_path = ''
as $$
  select s.name from mog.hq_sessions s
   where s.token_hash = mog.sha256_hex(coalesce(p_token, '')) and s.expires_at > now();
$$;

-- HQ's catalog functions (v11, v12) call this first: it now answers only
-- for the hq role.
create or replace function mog.hq_session(p_token text)
returns text
language sql stable security definer
set search_path = ''
as $$
  select s.name from mog.hq_sessions s join mog.hq_users u on u.name = s.name
   where s.token_hash = mog.sha256_hex(coalesce(p_token, '')) and s.expires_at > now()
     and 'hq' = any (u.roles);
$$;

-- The warehouse functions call this first.
create or replace function mog.wh_session(p_token text)
returns text
language sql stable security definer
set search_path = ''
as $$
  select s.name from mog.hq_sessions s join mog.hq_users u on u.name = s.name
   where s.token_hash = mog.sha256_hex(coalesce(p_token, '')) and s.expires_at > now()
     and 'warehouse' = any (u.roles);
$$;

-- v11's sign-in, plus the person's roles.
create or replace function mog.hq_new_session(p_name text)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_token text := encode(extensions.gen_random_bytes(32), 'hex');
begin
  update mog.hq_users set fail_count = 0, locked_until = null where name = p_name;
  insert into mog.hq_sessions (token_hash, name, expires_at) values (mog.sha256_hex(v_token), p_name, now() + interval '12 hours');
  delete from mog.hq_sessions where expires_at < now() - interval '1 day';
  return jsonb_build_object('ok', true, 'data',
    jsonb_build_object('token', v_token, 'name', p_name, 'expiresAt', now() + interval '12 hours',
                       'roles', (select to_jsonb(u.roles) from mog.hq_users u where u.name = p_name)));
end;
$$;


-- ---------------------------------------------------------------------
-- Warehouse tables
-- ---------------------------------------------------------------------

create table if not exists mog.wh_locations (
  id     bigint generated always as identity primary key,
  name   text not null check (name = btrim(name) and name <> '' and length(name) <= 60),
  ord    integer not null default 0,
  active boolean not null default true
);
create unique index if not exists wh_locations_name_ci on mog.wh_locations (lower(name));

create table if not exists mog.wh_suppliers (
  id     bigint generated always as identity primary key,
  name   text not null check (name = btrim(name) and name <> '' and length(name) <= 60),
  active boolean not null default true
);
create unique index if not exists wh_suppliers_name_ci on mog.wh_suppliers (lower(name));

create table if not exists mog.wh_products (
  id           bigint generated always as identity primary key,
  name         text not null check (name = btrim(name) and name <> '' and length(name) <= 120),
  pack         text not null default '' check (length(pack) <= 60),
  par          numeric not null default 0 check (par >= 0),            -- cases, over every location
  avg_cost     numeric not null default 0 check (avg_cost >= 0),       -- per case, from deliveries only
  handling_fee numeric not null default 0 check (handling_fee >= 0),   -- per case; never shown to a store
  stores       text[] not null default '{}',                           -- slugs; none = every store
  active       boolean not null default true,
  version      bigint not null default 1,
  updated_at   timestamptz not null default now(),
  updated_by   text
);
create unique index if not exists wh_products_name_ci on mog.wh_products (lower(name));

create table if not exists mog.wh_stock (
  product_id  bigint not null references mog.wh_products (id),
  location_id bigint not null references mog.wh_locations (id),
  cases       numeric not null check (cases >= 0),
  primary key (product_id, location_id)
);

-- Every change to stock. cases is + in, - out; cases_after is the
-- location's cases after it, avg_after the product's average cost after it.
-- shipped is W2's (a store order leaving), here so this table never changes.
create table if not exists mog.wh_moves (
  id          bigint generated always as identity primary key,
  at          timestamptz not null default now(),
  by_name     text not null,
  product_id  bigint not null references mog.wh_products (id),
  location_id bigint not null references mog.wh_locations (id),
  cases       numeric not null,
  kind        text not null check (kind in ('received', 'transfer_out', 'transfer_in', 'count', 'shipped')),
  ref         text,                       -- PO-0007, TR-0003 (HS-0001 in W2)
  unit_cost   numeric,                    -- on a receipt
  reason      text,                       -- on a count
  cases_after numeric not null,
  avg_after   numeric not null
);
create index if not exists wh_moves_product_idx on mog.wh_moves (product_id, id desc);
create index if not exists wh_moves_location_idx on mog.wh_moves (location_id, id desc);

create table if not exists mog.wh_pos (
  id          bigint generated always as identity primary key,
  number      text not null unique,                 -- PO-0001
  supplier_id bigint not null references mog.wh_suppliers (id),
  location_id bigint not null references mog.wh_locations (id),
  status      text not null default 'ordered' check (status in ('ordered', 'received', 'cancelled')),
  note        text not null default '' check (length(note) <= 300),
  created_at  timestamptz not null default now(),
  created_by  text not null,
  closed_at   timestamptz,                          -- received or cancelled
  closed_by   text,
  version     bigint not null default 1
);

create table if not exists mog.wh_po_lines (
  po_id          bigint not null references mog.wh_pos (id) on delete cascade,
  ord            integer not null,
  product_id     bigint not null references mog.wh_products (id),
  cases          numeric not null check (cases > 0),
  cost           numeric check (cost >= 0),          -- expected, optional
  cases_received numeric check (cases_received >= 0),
  cost_received  numeric check (cost_received >= 0),
  primary key (po_id, ord)
);

create table if not exists mog.wh_transfers (
  id               bigint generated always as identity primary key,
  number           text not null unique,            -- TR-0001
  from_location_id bigint not null references mog.wh_locations (id),
  to_location_id   bigint not null references mog.wh_locations (id),
  status           text not null default 'in_transit' check (status in ('in_transit', 'received')),
  note             text not null default '' check (length(note) <= 300),
  sent_at          timestamptz not null default now(),
  sent_by          text not null,
  closed_at        timestamptz,
  closed_by        text,
  check (from_location_id <> to_location_id)
);

create table if not exists mog.wh_transfer_lines (
  transfer_id bigint not null references mog.wh_transfers (id) on delete cascade,
  ord         integer not null,
  product_id  bigint not null references mog.wh_products (id),
  cases       numeric not null check (cases > 0),
  primary key (transfer_id, ord)
);

create table if not exists mog.wh_settings (
  id           boolean primary key default true check (id),
  markup_pct   numeric not null default 0 check (markup_pct >= 0 and markup_pct <= 100),
  delivery_fee numeric not null default 0 check (delivery_fee >= 0),
  version      bigint not null default 1,
  updated_at   timestamptz,
  updated_by   text
);
insert into mog.wh_settings (id) values (true) on conflict do nothing;

alter table mog.wh_locations      enable row level security;
alter table mog.wh_suppliers      enable row level security;
alter table mog.wh_products       enable row level security;
alter table mog.wh_stock          enable row level security;
alter table mog.wh_moves          enable row level security;
alter table mog.wh_pos            enable row level security;
alter table mog.wh_po_lines       enable row level security;
alter table mog.wh_transfers      enable row level security;
alter table mog.wh_transfer_lines enable row level security;
alter table mog.wh_settings       enable row level security;


-- ---------------------------------------------------------------------
-- Internal: reading the page's values
-- ---------------------------------------------------------------------

-- A number from the page, or REJECTED naming what it was for.
create or replace function mog.wh_num(p jsonb, p_what text)
returns numeric
language plpgsql immutable
set search_path = ''
as $$
begin
  if jsonb_typeof(p) is distinct from 'number' then
    raise exception 'REJECTED: % needs a number', p_what;
  end if;
  return (p #>> '{}')::numeric;
end;
$$;

-- Cases, to 2 decimals: 0 or more when p_zero, else more than 0.
create or replace function mog.wh_cases(p jsonb, p_what text, p_zero boolean)
returns numeric
language plpgsql immutable
set search_path = ''
as $$
declare
  v numeric := round(mog.wh_num(p, p_what), 2);
begin
  if v < 0 or (v = 0 and not p_zero) then
    raise exception 'REJECTED: % needs % cases', p_what, case when p_zero then '0 or more' else 'more than 0' end;
  end if;
  if v > 100000 then
    raise exception 'REJECTED: % is more than 100,000 cases', p_what;
  end if;
  return v;
end;
$$;

-- Dollars, to the cent, from 0 to 1,000,000.
create or replace function mog.wh_money(p jsonb, p_what text)
returns numeric
language plpgsql immutable
set search_path = ''
as $$
declare
  v numeric := round(mog.wh_num(p, p_what), 2);
begin
  if v < 0 or v > 1000000 then
    raise exception 'REJECTED: % needs an amount from $0 to $1,000,000', p_what;
  end if;
  return v;
end;
$$;

create or replace function mog.wh_id(p jsonb, p_what text)
returns bigint
language plpgsql immutable
set search_path = ''
as $$
begin
  if jsonb_typeof(p) is distinct from 'number' or (p #>> '{}')::numeric <> trunc((p #>> '{}')::numeric) then
    raise exception 'REJECTED: % is missing', p_what;
  end if;
  return (p #>> '{}')::bigint;
end;
$$;

-- A name, trimmed, 1 to p_max characters.
create or replace function mog.wh_name(p jsonb, p_what text, p_max integer)
returns text
language plpgsql immutable
set search_path = ''
as $$
declare
  v text := mog.js_trim(case when jsonb_typeof(p) = 'string' then p #>> '{}' else '' end);
begin
  if v = '' then
    raise exception 'REJECTED: % needs a name', p_what;
  end if;
  if length(v) > p_max then
    raise exception 'REJECTED: "%" is longer than % characters', left(v, 40), p_max;
  end if;
  return v;
end;
$$;

-- Optional text (a note, a reason), trimmed, at most p_max characters.
create or replace function mog.wh_text(p jsonb, p_what text, p_max integer)
returns text
language plpgsql immutable
set search_path = ''
as $$
declare
  v text := mog.js_trim(case when jsonb_typeof(p) = 'string' then p #>> '{}' else '' end);
begin
  if length(v) > p_max then
    raise exception 'REJECTED: % is longer than % characters', p_what, p_max;
  end if;
  return v;
end;
$$;

-- true/false, or the default when it's left out.
create or replace function mog.wh_bool(p jsonb, p_what text, p_default boolean)
returns boolean
language plpgsql immutable
set search_path = ''
as $$
begin
  if p is null or jsonb_typeof(p) = 'null' then
    return p_default;
  end if;
  if jsonb_typeof(p) <> 'boolean' then
    raise exception 'REJECTED: % is yes or no', p_what;
  end if;
  return (p #>> '{}')::boolean;
end;
$$;

-- "1 case", "2.5 cases".
create or replace function mog.wh_cs(p numeric)
returns text
language sql immutable
set search_path = ''
as $$
  select trim_scale(p)::text || case when p = 1 then ' case' else ' cases' end;
$$;

-- A list from the page: an array of 1 to p_max objects.
create or replace function mog.wh_lines(p jsonb, p_what text, p_max integer)
returns jsonb
language plpgsql immutable
set search_path = ''
as $$
begin
  if jsonb_typeof(p) is distinct from 'array' or jsonb_array_length(p) = 0 then
    raise exception 'REJECTED: % needs at least one product', p_what;
  end if;
  if jsonb_array_length(p) > p_max then
    raise exception 'REJECTED: % has more than % lines', p_what, p_max;
  end if;
  if exists (select 1 from jsonb_array_elements(p) x where jsonb_typeof(x) <> 'object') then
    raise exception 'REJECTED: % has a line that isn''t a line', p_what;
  end if;
  return p;
end;
$$;


-- ---------------------------------------------------------------------
-- Internal: stock and its cost
-- ---------------------------------------------------------------------

create or replace function mog.wh_in_transit(p_product bigint)
returns numeric
language sql stable
set search_path = ''
as $$
  select coalesce(sum(l.cases), 0)
    from mog.wh_transfer_lines l join mog.wh_transfers t on t.id = l.transfer_id
   where l.product_id = p_product and t.status = 'in_transit';
$$;

-- What HEH owns of a product: every location plus what's in transit.
create or replace function mog.wh_owned(p_product bigint)
returns numeric
language sql stable
set search_path = ''
as $$
  select coalesce((select sum(s.cases) from mog.wh_stock s where s.product_id = p_product), 0)
         + mog.wh_in_transit(p_product);
$$;

-- The average cost after c cases come in at cost k, with o owned before at
-- average a. The page's preview is the same sum (hq/warehouse.js avgAfter).
create or replace function mog.wh_avg_after(p_owned numeric, p_avg numeric, p_cases numeric, p_cost numeric)
returns numeric
language sql immutable
set search_path = ''
as $$
  select case when p_cases <= 0 then p_avg
              when p_owned <= 0 then round(p_cost, 4)
              else round((p_owned * p_avg + p_cases * p_cost) / (p_owned + p_cases), 4) end;
$$;

-- Locks these products in id order; REJECTED when one doesn't exist.
create or replace function mog.wh_lock_products(p_ids bigint[])
returns void
language plpgsql volatile
set search_path = ''
as $$
declare
  v_n integer;
begin
  select count(*) into v_n from (select 1 from mog.wh_products p where p.id = any (p_ids) order by p.id for update) x;
  if v_n <> (select count(distinct i) from unnest(p_ids) i) then
    raise exception 'REJECTED: a product here isn''t in the warehouse any more';
  end if;
end;
$$;

-- One change to a product's stock at a location, logged. The caller has
-- locked the product. REJECTED when the location would go below 0; a
-- receipt moves the average cost.
create or replace function mog.wh_move(p_by text, p_product bigint, p_location bigint, p_cases numeric,
                                       p_kind text, p_ref text, p_cost numeric, p_reason text)
returns void
language plpgsql volatile
set search_path = ''
as $$
declare
  v_have  numeric;
  v_after numeric;
  v_avg   numeric;
begin
  insert into mog.wh_stock (product_id, location_id, cases) values (p_product, p_location, 0) on conflict do nothing;
  select s.cases into v_have from mog.wh_stock s
   where s.product_id = p_product and s.location_id = p_location for update;
  v_after := v_have + p_cases;
  if v_after < 0 then
    raise exception 'REJECTED: % has % of %',
      (select l.name from mog.wh_locations l where l.id = p_location), mog.wh_cs(v_have),
      (select p.name from mog.wh_products p where p.id = p_product);
  end if;
  select p.avg_cost into v_avg from mog.wh_products p where p.id = p_product;
  if p_kind = 'received' then
    v_avg := mog.wh_avg_after(mog.wh_owned(p_product), v_avg, p_cases, p_cost);
    update mog.wh_products set avg_cost = v_avg where id = p_product;
  end if;
  update mog.wh_stock set cases = v_after where product_id = p_product and location_id = p_location;
  insert into mog.wh_moves (by_name, product_id, location_id, cases, kind, ref, unit_cost, reason, cases_after, avg_after)
  values (p_by, p_product, p_location, p_cases, p_kind, p_ref, p_cost, nullif(p_reason, ''), v_after, v_avg);
end;
$$;

-- The next PO-0001 or TR-0001, one at a time. Numbers come from what's
-- there, so nothing is used up by a save that's refused (or by a smoke test
-- that cleans up after itself).
create or replace function mog.wh_next_number(p_prefix text)
returns text
language plpgsql volatile
set search_path = ''
as $$
declare
  v integer;
begin
  perform 1 from mog.wh_settings where id for update;
  if p_prefix = 'PO' then
    select coalesce(max(substr(number, 4)::integer), 0) + 1 into v from mog.wh_pos;
  else
    select coalesce(max(substr(number, 4)::integer), 0) + 1 into v from mog.wh_transfers;
  end if;
  return p_prefix || '-' || lpad(v::text, greatest(4, length(v::text)), '0');
end;
$$;


-- ---------------------------------------------------------------------
-- Internal: the warehouse as the page reads it
-- ---------------------------------------------------------------------

create or replace function mog.wh_po_json(p_id bigint)
returns jsonb
language sql stable
set search_path = ''
as $$
  select jsonb_build_object(
    'id', p.id, 'number', p.number, 'supplierId', p.supplier_id, 'supplier', s.name,
    'locationId', p.location_id, 'location', l.name, 'status', p.status, 'note', p.note,
    'createdAt', p.created_at, 'createdBy', p.created_by, 'closedAt', p.closed_at, 'closedBy', p.closed_by,
    'version', p.version,
    'lines', coalesce((
      select jsonb_agg(jsonb_build_object('ord', x.ord, 'productId', x.product_id, 'product', pr.name, 'pack', pr.pack,
                                          'cases', x.cases, 'cost', x.cost,
                                          'casesReceived', x.cases_received, 'costReceived', x.cost_received) order by x.ord)
        from mog.wh_po_lines x join mog.wh_products pr on pr.id = x.product_id where x.po_id = p.id), '[]'::jsonb))
    from mog.wh_pos p
    join mog.wh_suppliers s on s.id = p.supplier_id
    join mog.wh_locations l on l.id = p.location_id
   where p.id = p_id;
$$;

create or replace function mog.wh_transfer_json(p_id bigint)
returns jsonb
language sql stable
set search_path = ''
as $$
  select jsonb_build_object(
    'id', t.id, 'number', t.number, 'fromId', t.from_location_id, 'from', f.name,
    'toId', t.to_location_id, 'to', o.name, 'status', t.status, 'note', t.note,
    'sentAt', t.sent_at, 'sentBy', t.sent_by, 'closedAt', t.closed_at, 'closedBy', t.closed_by,
    'lines', coalesce((
      select jsonb_agg(jsonb_build_object('ord', x.ord, 'productId', x.product_id, 'product', pr.name, 'cases', x.cases) order by x.ord)
        from mog.wh_transfer_lines x join mog.wh_products pr on pr.id = x.product_id where x.transfer_id = t.id), '[]'::jsonb))
    from mog.wh_transfers t
    join mog.wh_locations f on f.id = t.from_location_id
    join mog.wh_locations o on o.id = t.to_location_id
   where t.id = p_id;
$$;

-- Everything the Happy Supply pages show: open orders and transfers plus
-- the last 30 closed ones, every product with its stock per location.
create or replace function mog.wh_state(p_name text)
returns jsonb
language sql stable
set search_path = ''
as $$
  select jsonb_build_object(
    'name', p_name,
    'roles', (select to_jsonb(u.roles) from mog.hq_users u where u.name = p_name),
    'settings', (select jsonb_build_object('markupPct', w.markup_pct, 'deliveryFee', w.delivery_fee, 'version', w.version,
                                           'updatedAt', w.updated_at, 'updatedBy', w.updated_by)
                   from mog.wh_settings w where w.id),
    'locations', coalesce((select jsonb_agg(jsonb_build_object('id', l.id, 'name', l.name, 'ord', l.ord, 'active', l.active)
                                            order by l.ord, lower(l.name))
                             from mog.wh_locations l), '[]'::jsonb),
    'suppliers', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name, 'active', s.active) order by lower(s.name))
                             from mog.wh_suppliers s), '[]'::jsonb),
    'products', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', p.id, 'name', p.name, 'pack', p.pack, 'par', p.par, 'avgCost', p.avg_cost,
               'handlingFee', p.handling_fee, 'stores', to_jsonb(p.stores), 'active', p.active, 'version', p.version,
               'updatedAt', p.updated_at, 'updatedBy', p.updated_by,
               'stock', coalesce((select jsonb_object_agg(s.location_id::text, s.cases)
                                    from mog.wh_stock s where s.product_id = p.id and s.cases <> 0), '{}'::jsonb),
               'inTransit', mog.wh_in_transit(p.id),
               'lastReceipt', (select jsonb_build_object('ref', m.ref, 'at', m.at) from mog.wh_moves m
                                where m.product_id = p.id and m.kind = 'received' order by m.id desc limit 1))
             order by lower(p.name))
        from mog.wh_products p), '[]'::jsonb),
    'pos', coalesce((
      select jsonb_agg(mog.wh_po_json(x.id) order by x.id desc)
        from (select id from mog.wh_pos where status = 'ordered'
              union all
              (select id from mog.wh_pos where status <> 'ordered' order by id desc limit 30)) x), '[]'::jsonb),
    'transfers', coalesce((
      select jsonb_agg(mog.wh_transfer_json(x.id) order by x.id desc)
        from (select id from mog.wh_transfers where status = 'in_transit'
              union all
              (select id from mog.wh_transfers where status <> 'in_transit' order by id desc limit 30)) x), '[]'::jsonb),
    'stores', coalesce((
      select jsonb_agg(jsonb_build_object('slug', s.slug, 'location', s.location, 'concept', coalesce(s.concept, ''),
                                          'side', s.side, 'isTest', s.is_test)
                       order by coalesce(s.concept, ''), s.is_test, s.location, s.slug)
        from mog.stores s), '[]'::jsonb));
$$;

create or replace function mog.wh_refusal(p_token text)
returns jsonb
language sql stable
set search_path = ''
as $$
  select jsonb_build_object('ok', false, 'error',
    case when mog.hq_any_session(p_token) is null then 'SESSION_EXPIRED' else 'NOT_ALLOWED' end);
$$;

create or replace function mog.wh_error(p_msg text)
returns jsonb
language sql immutable
set search_path = ''
as $$
  select case when p_msg like 'CONFLICT: %' then jsonb_build_object('ok', false, 'error', 'CONFLICT', 'detail', substr(p_msg, 11))
              when p_msg like 'REJECTED: %' then jsonb_build_object('ok', false, 'error', p_msg)
              else jsonb_build_object('ok', false, 'error', 'REJECTED: ' || p_msg) end;
$$;

create or replace function mog.wh_answer(p_name text, p_done jsonb)
returns jsonb
language sql stable
set search_path = ''
as $$
  select jsonb_build_object('ok', true, 'data', mog.wh_state(p_name) || jsonb_build_object('done', p_done));
$$;


-- ---------------------------------------------------------------------
-- Internal: each write (raises REJECTED: / CONFLICT:)
-- ---------------------------------------------------------------------

-- A product, a location, a supplier, or the settings. id null = a new one.
--   product:  { id?, version?, name, pack, par, handlingFee, stores: [slug], active }
--   location: { id?, name, ord?, active }
--   supplier: { id?, name, active }
--   settings: { version, markupPct, deliveryFee }
create or replace function mog.wh_do_save(p_by text, p_kind text, p_row jsonb)
returns jsonb
language plpgsql volatile
set search_path = ''
as $$
declare
  v_id     bigint;
  v_name   text;
  v_pack   text;
  v_par    numeric;
  v_fee    numeric;
  v_pct    numeric;
  v_active boolean;
  v_stores text[];
  v_have   bigint;
  v_last   text;
  v_ord    integer;
  v_held   numeric;
begin
  if jsonb_typeof(p_row) is distinct from 'object' then
    raise exception 'REJECTED: nothing to save';
  end if;
  v_id := case when p_row -> 'id' is null or jsonb_typeof(p_row -> 'id') = 'null' then null else mog.wh_id(p_row -> 'id', 'The id') end;

  if p_kind = 'product' then
    v_name := mog.wh_name(p_row -> 'name', 'The product', 120);
    v_pack := mog.wh_text(p_row -> 'pack', 'The pack', 60);
    v_par := mog.wh_cases(p_row -> 'par', 'The par', true);
    v_fee := mog.wh_money(p_row -> 'handlingFee', 'The handling fee');
    v_active := mog.wh_bool(p_row -> 'active', 'Active', true);
    if p_row -> 'stores' is not null and jsonb_typeof(p_row -> 'stores') <> 'array' then
      raise exception 'REJECTED: the stores are a list';
    end if;
    select coalesce(array_agg(distinct x order by x), '{}') into v_stores
      from jsonb_array_elements_text(coalesce(p_row -> 'stores', '[]'::jsonb)) x;
    if exists (select 1 from unnest(v_stores) x where not exists (select 1 from mog.stores s where s.slug = x)) then
      raise exception 'REJECTED: no store called %',
        (select x from unnest(v_stores) x where not exists (select 1 from mog.stores s where s.slug = x) limit 1);
    end if;
    if exists (select 1 from mog.wh_products p where lower(p.name) = lower(v_name) and p.id is distinct from v_id) then
      raise exception 'REJECTED: there''s already a product called "%"', v_name;
    end if;
    if v_id is null then
      insert into mog.wh_products (name, pack, par, handling_fee, stores, active, updated_by)
      values (v_name, v_pack, v_par, v_fee, v_stores, v_active, p_by) returning id into v_id;
    else
      select p.version, p.updated_by into v_have, v_last from mog.wh_products p where p.id = v_id for update;
      if v_have is null then
        raise exception 'REJECTED: that product isn''t in the warehouse any more';
      end if;
      if v_have <> mog.wh_num(p_row -> 'version', 'The version') then
        raise exception 'CONFLICT: % was changed since you opened it (by %)', v_name, coalesce(v_last, 'someone');
      end if;
      update mog.wh_products
         set name = v_name, pack = v_pack, par = v_par, handling_fee = v_fee, stores = v_stores, active = v_active,
             version = version + 1, updated_at = now(), updated_by = p_by
       where id = v_id;
    end if;
    return jsonb_build_object('kind', 'product', 'id', v_id, 'name', v_name);
  end if;

  if p_kind = 'location' or p_kind = 'supplier' then
    v_name := mog.wh_name(p_row -> 'name', case when p_kind = 'location' then 'The location' else 'The supplier' end, 60);
    v_active := mog.wh_bool(p_row -> 'active', 'Active', true);
  end if;

  if p_kind = 'location' then
    if exists (select 1 from mog.wh_locations l where lower(l.name) = lower(v_name) and l.id is distinct from v_id) then
      raise exception 'REJECTED: there''s already a location called "%"', v_name;
    end if;
    if p_row -> 'ord' is not null and jsonb_typeof(p_row -> 'ord') <> 'null' then
      v_ord := mog.wh_num(p_row -> 'ord', 'The order')::integer;
    end if;
    if v_id is null then
      insert into mog.wh_locations (name, ord, active)
      values (v_name, coalesce(v_ord, (select coalesce(max(l.ord), 0) + 10 from mog.wh_locations l)), v_active)
      returning id into v_id;
    else
      perform 1 from mog.wh_locations l where l.id = v_id for update;
      if not found then
        raise exception 'REJECTED: that location isn''t in the warehouse any more';
      end if;
      if not v_active then
        select coalesce(sum(s.cases), 0) into v_held from mog.wh_stock s where s.location_id = v_id;
        if v_held > 0 then
          raise exception 'REJECTED: % still holds %: move it or count it to 0 first', v_name, mog.wh_cs(v_held);
        end if;
      end if;
      update mog.wh_locations set name = v_name, ord = coalesce(v_ord, ord), active = v_active where id = v_id;
    end if;
    return jsonb_build_object('kind', 'location', 'id', v_id, 'name', v_name);
  end if;

  if p_kind = 'supplier' then
    if exists (select 1 from mog.wh_suppliers s where lower(s.name) = lower(v_name) and s.id is distinct from v_id) then
      raise exception 'REJECTED: there''s already a supplier called "%"', v_name;
    end if;
    if v_id is null then
      insert into mog.wh_suppliers (name, active) values (v_name, v_active) returning id into v_id;
    else
      update mog.wh_suppliers set name = v_name, active = v_active where id = v_id;
      if not found then
        raise exception 'REJECTED: that supplier isn''t in the warehouse any more';
      end if;
    end if;
    return jsonb_build_object('kind', 'supplier', 'id', v_id, 'name', v_name);
  end if;

  if p_kind = 'settings' then
    v_pct := round(mog.wh_num(p_row -> 'markupPct', 'The markup'), 2);
    if v_pct < 0 or v_pct > 100 then
      raise exception 'REJECTED: the markup is from 0 to 100%%';
    end if;
    v_fee := mog.wh_money(p_row -> 'deliveryFee', 'The delivery fee');
    select w.version, w.updated_by into v_have, v_last from mog.wh_settings w where w.id for update;
    if v_have <> mog.wh_num(p_row -> 'version', 'The version') then
      raise exception 'CONFLICT: the settings were changed since you opened them (by %)', coalesce(v_last, 'someone');
    end if;
    update mog.wh_settings set markup_pct = v_pct, delivery_fee = v_fee, version = version + 1, updated_at = now(), updated_by = p_by
     where id;
    return jsonb_build_object('kind', 'settings');
  end if;

  raise exception 'REJECTED: nothing called % to save', coalesce(p_kind, '(none)');
end;
$$;

-- A vendor order in, new or edited while it's still ordered:
--   { id?, version?, supplierId, locationId, note, lines: [{ productId, cases, cost? }] }
create or replace function mog.wh_do_po_save(p_by text, p_po jsonb)
returns jsonb
language plpgsql volatile
set search_path = ''
as $$
declare
  v_id       bigint;
  v_supplier bigint;
  v_location bigint;
  v_note     text;
  v_lines    jsonb;
  v_number   text;
  v_status   text;
  v_version  bigint;
  v_n        integer := 0;
  x          jsonb;
  v_product  bigint;
  v_pname    text;
  v_seen     bigint[] := '{}';
begin
  if jsonb_typeof(p_po) is distinct from 'object' then
    raise exception 'REJECTED: nothing to save';
  end if;
  v_id := case when p_po -> 'id' is null or jsonb_typeof(p_po -> 'id') = 'null' then null else mog.wh_id(p_po -> 'id', 'The order') end;
  v_supplier := mog.wh_id(p_po -> 'supplierId', 'The supplier');
  v_location := mog.wh_id(p_po -> 'locationId', 'Where it goes');
  v_note := mog.wh_text(p_po -> 'note', 'The note', 300);
  v_lines := mog.wh_lines(p_po -> 'lines', 'A vendor order', 100);
  if not exists (select 1 from mog.wh_suppliers s where s.id = v_supplier and s.active) then
    raise exception 'REJECTED: pick a supplier from the list';
  end if;
  if not exists (select 1 from mog.wh_locations l where l.id = v_location and l.active) then
    raise exception 'REJECTED: pick where it goes from the list';
  end if;

  if v_id is null then
    v_number := mog.wh_next_number('PO');
    insert into mog.wh_pos (number, supplier_id, location_id, note, created_by)
    values (v_number, v_supplier, v_location, v_note, p_by) returning id into v_id;
  else
    select p.number, p.status, p.version into v_number, v_status, v_version from mog.wh_pos p where p.id = v_id for update;
    if v_number is null then
      raise exception 'REJECTED: that order isn''t there any more';
    end if;
    if v_status <> 'ordered' then
      raise exception 'REJECTED: % was already %', v_number, v_status;
    end if;
    if v_version <> mog.wh_num(p_po -> 'version', 'The version') then
      raise exception 'CONFLICT: % was changed since you opened it', v_number;
    end if;
    update mog.wh_pos set supplier_id = v_supplier, location_id = v_location, note = v_note, version = version + 1 where id = v_id;
    delete from mog.wh_po_lines where po_id = v_id;
  end if;

  for x in select y from jsonb_array_elements(v_lines) y loop
    v_n := v_n + 1;
    v_product := mog.wh_id(x -> 'productId', 'Line ' || v_n || '''s product');
    select p.name into v_pname from mog.wh_products p where p.id = v_product and p.active;
    if v_pname is null then
      raise exception 'REJECTED: line % needs a product from the list', v_n;
    end if;
    if v_product = any (v_seen) then
      raise exception 'REJECTED: % is on the order twice', v_pname;
    end if;
    v_seen := v_seen || v_product;
    insert into mog.wh_po_lines (po_id, ord, product_id, cases, cost)
    values (v_id, v_n, v_product, mog.wh_cases(x -> 'cases', v_pname, false),
            case when x -> 'cost' is null or jsonb_typeof(x -> 'cost') = 'null' then null
                 else mog.wh_money(x -> 'cost', 'The cost of ' || v_pname) end);
  end loop;
  return jsonb_build_object('kind', 'po', 'id', v_id, 'number', v_number);
end;
$$;

create or replace function mog.wh_do_po_cancel(p_by text, p_id bigint, p_version bigint)
returns jsonb
language plpgsql volatile
set search_path = ''
as $$
declare
  v_number  text;
  v_status  text;
  v_version bigint;
begin
  select p.number, p.status, p.version into v_number, v_status, v_version from mog.wh_pos p where p.id = p_id for update;
  if v_number is null then
    raise exception 'REJECTED: that order isn''t there any more';
  end if;
  if v_status <> 'ordered' then
    raise exception 'REJECTED: % was already %', v_number, v_status;
  end if;
  if v_version is distinct from p_version then
    raise exception 'CONFLICT: % was changed since you opened it', v_number;
  end if;
  update mog.wh_pos set status = 'cancelled', closed_at = now(), closed_by = p_by, version = version + 1 where id = p_id;
  return jsonb_build_object('kind', 'po', 'id', p_id, 'number', v_number);
end;
$$;

-- What came in on a vendor order: { id, version, lines: [{ ord, cases, cost }] },
-- every line of the order once. 0 cases = none of it came (no cost needed).
-- The stock rises at the order's location and the average cost moves. The
-- order closes as received.
create or replace function mog.wh_do_po_receive(p_by text, p_r jsonb)
returns jsonb
language plpgsql volatile
set search_path = ''
as $$
declare
  v_id       bigint;
  v_number   text;
  v_status   text;
  v_version  bigint;
  v_location bigint;
  v_lines    jsonb;
  ln         record;
  x          jsonb;
  v_cases    numeric;
  v_cost     numeric;
  v_got      integer := 0;
begin
  if jsonb_typeof(p_r) is distinct from 'object' then
    raise exception 'REJECTED: nothing to receive';
  end if;
  v_id := mog.wh_id(p_r -> 'id', 'The order');
  v_lines := mog.wh_lines(p_r -> 'lines', 'What came in', 100);
  select p.number, p.status, p.version, p.location_id into v_number, v_status, v_version, v_location
    from mog.wh_pos p where p.id = v_id for update;
  if v_number is null then
    raise exception 'REJECTED: that order isn''t there any more';
  end if;
  if v_status <> 'ordered' then
    raise exception 'REJECTED: % was already %', v_number, v_status;
  end if;
  if v_version <> mog.wh_num(p_r -> 'version', 'The version') then
    raise exception 'CONFLICT: % was changed since you opened it', v_number;
  end if;
  perform mog.wh_lock_products(array(select l.product_id from mog.wh_po_lines l where l.po_id = v_id));

  for ln in select l.ord, l.product_id, pr.name from mog.wh_po_lines l join mog.wh_products pr on pr.id = l.product_id
             where l.po_id = v_id order by l.ord loop
    x := null;
    select y into x from jsonb_array_elements(v_lines) y
     where jsonb_typeof(y -> 'ord') = 'number' and (y ->> 'ord')::numeric = ln.ord limit 1;
    if x is null then
      raise exception 'REJECTED: say what came in of %', ln.name;
    end if;
    v_cases := mog.wh_cases(x -> 'cases', ln.name, true);
    v_cost := null;
    if v_cases > 0 then
      v_cost := mog.wh_money(x -> 'cost', 'The cost of ' || ln.name);
      perform mog.wh_move(p_by, ln.product_id, v_location, v_cases, 'received', v_number, v_cost, null);
      v_got := v_got + 1;
    end if;
    update mog.wh_po_lines set cases_received = v_cases, cost_received = v_cost where po_id = v_id and ord = ln.ord;
  end loop;
  if v_got = 0 then
    raise exception 'REJECTED: nothing came in on %: cancel it instead', v_number;
  end if;
  update mog.wh_pos set status = 'received', closed_at = now(), closed_by = p_by, version = version + 1 where id = v_id;
  return jsonb_build_object('kind', 'po', 'id', v_id, 'number', v_number, 'lines', v_got);
end;
$$;

-- A transfer leaves: { fromId, toId, note, lines: [{ productId, cases }] }.
-- The cases leave the from-location now (refused when it hasn't got them)
-- and stay in transit until it's received.
create or replace function mog.wh_do_transfer_send(p_by text, p_t jsonb)
returns jsonb
language plpgsql volatile
set search_path = ''
as $$
declare
  v_from    bigint;
  v_to      bigint;
  v_note    text;
  v_lines   jsonb;
  v_number  text;
  v_id      bigint;
  v_n       integer := 0;
  x         jsonb;
  v_product bigint;
  v_pname   text;
  v_cases   numeric;
  v_seen    bigint[] := '{}';
begin
  if jsonb_typeof(p_t) is distinct from 'object' then
    raise exception 'REJECTED: nothing to send';
  end if;
  v_from := mog.wh_id(p_t -> 'fromId', 'Where it comes from');
  v_to := mog.wh_id(p_t -> 'toId', 'Where it goes');
  v_note := mog.wh_text(p_t -> 'note', 'The note', 300);
  v_lines := mog.wh_lines(p_t -> 'lines', 'A transfer', 100);
  if v_from = v_to then
    raise exception 'REJECTED: a transfer goes to another location';
  end if;
  if not exists (select 1 from mog.wh_locations l where l.id = v_from and l.active)
     or not exists (select 1 from mog.wh_locations l where l.id = v_to and l.active) then
    raise exception 'REJECTED: pick both locations from the list';
  end if;
  perform mog.wh_lock_products(array(
    select mog.wh_id(y -> 'productId', 'A line''s product') from jsonb_array_elements(v_lines) y));
  v_number := mog.wh_next_number('TR');
  insert into mog.wh_transfers (number, from_location_id, to_location_id, note, sent_by)
  values (v_number, v_from, v_to, v_note, p_by) returning id into v_id;
  for x in select y from jsonb_array_elements(v_lines) y loop
    v_n := v_n + 1;
    v_product := mog.wh_id(x -> 'productId', 'Line ' || v_n || '''s product');
    select p.name into v_pname from mog.wh_products p where p.id = v_product;
    if v_product = any (v_seen) then
      raise exception 'REJECTED: % is on the transfer twice', v_pname;
    end if;
    v_seen := v_seen || v_product;
    v_cases := mog.wh_cases(x -> 'cases', v_pname, false);
    insert into mog.wh_transfer_lines (transfer_id, ord, product_id, cases) values (v_id, v_n, v_product, v_cases);
    perform mog.wh_move(p_by, v_product, v_from, -v_cases, 'transfer_out', v_number, null, null);
  end loop;
  return jsonb_build_object('kind', 'transfer', 'id', v_id, 'number', v_number);
end;
$$;

create or replace function mog.wh_do_transfer_receive(p_by text, p_id bigint)
returns jsonb
language plpgsql volatile
set search_path = ''
as $$
declare
  v_number text;
  v_status text;
  v_to     bigint;
  ln       record;
begin
  select t.number, t.status, t.to_location_id into v_number, v_status, v_to from mog.wh_transfers t where t.id = p_id for update;
  if v_number is null then
    raise exception 'REJECTED: that transfer isn''t there any more';
  end if;
  if v_status <> 'in_transit' then
    raise exception 'REJECTED: % was already received', v_number;
  end if;
  perform mog.wh_lock_products(array(select l.product_id from mog.wh_transfer_lines l where l.transfer_id = p_id));
  for ln in select l.product_id, l.cases from mog.wh_transfer_lines l where l.transfer_id = p_id order by l.ord loop
    perform mog.wh_move(p_by, ln.product_id, v_to, ln.cases, 'transfer_in', v_number, null, null);
  end loop;
  update mog.wh_transfers set status = 'received', closed_at = now(), closed_by = p_by where id = p_id;
  return jsonb_build_object('kind', 'transfer', 'id', p_id, 'number', v_number);
end;
$$;

-- A count at one location: { locationId, lines: [{ productId, cases, reason }] }.
-- A product left out keeps its number. A difference needs a reason and is
-- kept as a count move; a count that matches changes nothing.
create or replace function mog.wh_do_count(p_by text, p_c jsonb)
returns jsonb
language plpgsql volatile
set search_path = ''
as $$
declare
  v_location bigint;
  v_lname    text;
  v_lines    jsonb;
  v_n        integer := 0;
  v_changed  integer := 0;
  x          jsonb;
  v_product  bigint;
  v_pname    text;
  v_cases    numeric;
  v_have     numeric;
  v_reason   text;
  v_seen     bigint[] := '{}';
begin
  if jsonb_typeof(p_c) is distinct from 'object' then
    raise exception 'REJECTED: nothing to count';
  end if;
  v_location := mog.wh_id(p_c -> 'locationId', 'The location');
  select l.name into v_lname from mog.wh_locations l where l.id = v_location;
  if v_lname is null then
    raise exception 'REJECTED: pick a location from the list';
  end if;
  v_lines := mog.wh_lines(p_c -> 'lines', 'A count', 500);
  perform mog.wh_lock_products(array(
    select mog.wh_id(y -> 'productId', 'A line''s product') from jsonb_array_elements(v_lines) y));
  for x in select y from jsonb_array_elements(v_lines) y loop
    v_n := v_n + 1;
    v_product := mog.wh_id(x -> 'productId', 'Line ' || v_n || '''s product');
    select p.name into v_pname from mog.wh_products p where p.id = v_product;
    if v_product = any (v_seen) then
      raise exception 'REJECTED: % is in the count twice', v_pname;
    end if;
    v_seen := v_seen || v_product;
    v_cases := mog.wh_cases(x -> 'cases', v_pname, true);
    v_have := coalesce((select s.cases from mog.wh_stock s where s.product_id = v_product and s.location_id = v_location), 0);
    if v_cases = v_have then
      continue;
    end if;
    v_reason := mog.wh_text(x -> 'reason', 'The reason for ' || v_pname, 200);
    if v_reason = '' then
      raise exception 'REJECTED: % differs from the record (% counted, % on record): say why', v_pname, trim_scale(v_cases), trim_scale(v_have);
    end if;
    perform mog.wh_move(p_by, v_product, v_location, v_cases - v_have, 'count', null, null, v_reason);
    v_changed := v_changed + 1;
  end loop;
  return jsonb_build_object('kind', 'count', 'location', v_lname, 'changed', v_changed);
end;
$$;


-- ---------------------------------------------------------------------
-- The page's calls (an HQ token with the warehouse role)
-- ---------------------------------------------------------------------

create or replace function public.mog_wh_data(p_token text)
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_name text := mog.wh_session(p_token);
begin
  if v_name is null then
    return mog.wh_refusal(p_token);
  end if;
  return jsonb_build_object('ok', true, 'data', mog.wh_state(v_name));
end;
$$;

-- Stock history, newest first, 200 at a time: one product, one location,
-- or both (null = any); p_before_id pages back.
create or replace function public.mog_wh_history(p_token text, p_product_id bigint, p_location_id bigint, p_before_id bigint)
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_name text := mog.wh_session(p_token);
begin
  if v_name is null then
    return mog.wh_refusal(p_token);
  end if;
  return jsonb_build_object('ok', true, 'data', jsonb_build_object('moves', coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', m.id, 'at', m.at, 'by', m.by_name, 'productId', m.product_id, 'product', p.name,
             'locationId', m.location_id, 'location', l.name, 'cases', m.cases, 'kind', m.kind, 'ref', m.ref,
             'unitCost', m.unit_cost, 'reason', m.reason, 'casesAfter', m.cases_after, 'avgAfter', m.avg_after)
           order by m.id desc)
      from (select * from mog.wh_moves x
             where (p_product_id is null or x.product_id = p_product_id)
               and (p_location_id is null or x.location_id = p_location_id)
               and (p_before_id is null or x.id < p_before_id)
             order by x.id desc limit 200) m
      join mog.wh_products p on p.id = m.product_id
      join mog.wh_locations l on l.id = m.location_id), '[]'::jsonb)));
end;
$$;

create or replace function public.mog_wh_save(p_token text, p_kind text, p_row jsonb)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_name text := mog.wh_session(p_token);
  v_done jsonb;
begin
  if v_name is null then
    return mog.wh_refusal(p_token);
  end if;
  begin
    v_done := mog.wh_do_save(v_name, p_kind, p_row);
  exception when others then
    return mog.wh_error(sqlerrm);
  end;
  return mog.wh_answer(v_name, v_done);
end;
$$;

create or replace function public.mog_wh_po_save(p_token text, p_po jsonb)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_name text := mog.wh_session(p_token);
  v_done jsonb;
begin
  if v_name is null then
    return mog.wh_refusal(p_token);
  end if;
  begin
    v_done := mog.wh_do_po_save(v_name, p_po);
  exception when others then
    return mog.wh_error(sqlerrm);
  end;
  return mog.wh_answer(v_name, v_done);
end;
$$;

create or replace function public.mog_wh_po_cancel(p_token text, p_id bigint, p_version bigint)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_name text := mog.wh_session(p_token);
  v_done jsonb;
begin
  if v_name is null then
    return mog.wh_refusal(p_token);
  end if;
  begin
    v_done := mog.wh_do_po_cancel(v_name, p_id, p_version);
  exception when others then
    return mog.wh_error(sqlerrm);
  end;
  return mog.wh_answer(v_name, v_done);
end;
$$;

create or replace function public.mog_wh_po_receive(p_token text, p_receipt jsonb)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_name text := mog.wh_session(p_token);
  v_done jsonb;
begin
  if v_name is null then
    return mog.wh_refusal(p_token);
  end if;
  begin
    v_done := mog.wh_do_po_receive(v_name, p_receipt);
  exception when others then
    return mog.wh_error(sqlerrm);
  end;
  return mog.wh_answer(v_name, v_done);
end;
$$;

create or replace function public.mog_wh_transfer_send(p_token text, p_transfer jsonb)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_name text := mog.wh_session(p_token);
  v_done jsonb;
begin
  if v_name is null then
    return mog.wh_refusal(p_token);
  end if;
  begin
    v_done := mog.wh_do_transfer_send(v_name, p_transfer);
  exception when others then
    return mog.wh_error(sqlerrm);
  end;
  return mog.wh_answer(v_name, v_done);
end;
$$;

create or replace function public.mog_wh_transfer_receive(p_token text, p_id bigint)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_name text := mog.wh_session(p_token);
  v_done jsonb;
begin
  if v_name is null then
    return mog.wh_refusal(p_token);
  end if;
  begin
    v_done := mog.wh_do_transfer_receive(v_name, p_id);
  exception when others then
    return mog.wh_error(sqlerrm);
  end;
  return mog.wh_answer(v_name, v_done);
end;
$$;

create or replace function public.mog_wh_count(p_token text, p_count jsonb)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_name text := mog.wh_session(p_token);
  v_done jsonb;
begin
  if v_name is null then
    return mog.wh_refusal(p_token);
  end if;
  begin
    v_done := mog.wh_do_count(v_name, p_count);
  exception when others then
    return mog.wh_error(sqlerrm);
  end;
  return mog.wh_answer(v_name, v_done);
end;
$$;


-- ---------------------------------------------------------------------
-- Privileges: lock the new tables and internals, open exactly the
-- entry points.
-- ---------------------------------------------------------------------

revoke all on all tables    in schema mog from public, anon, authenticated;
revoke all on all functions in schema mog from public, anon, authenticated;

do $$
declare
  f text;
begin
  foreach f in array array[
    'public.mog_wh_data(text)',
    'public.mog_wh_history(text, bigint, bigint, bigint)',
    'public.mog_wh_save(text, text, jsonb)',
    'public.mog_wh_po_save(text, jsonb)',
    'public.mog_wh_po_cancel(text, bigint, bigint)',
    'public.mog_wh_po_receive(text, jsonb)',
    'public.mog_wh_transfer_send(text, jsonb)',
    'public.mog_wh_transfer_receive(text, bigint)',
    'public.mog_wh_count(text, jsonb)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to anon, authenticated', f);
  end loop;
end;
$$;

notify pgrst, 'reload schema';
