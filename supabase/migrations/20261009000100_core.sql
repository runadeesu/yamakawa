-- ============================================================================
-- やまかわてるきゲーム Online: core (players / auth guard / rate limits)
--
-- 設計方針
--   * クライアントはテーブルを直接書き換えない。書き込みはすべて SECURITY DEFINER の RPC 経由。
--   * テーブルは RLS 有効。SELECT は必要最小限のポリシーのみ。
--   * 内部用のテーブル・関数は app_private スキーマ (PostgREST に公開されない)。
--   * 認証は Supabase Auth。ユーザーに見せない内部メールアドレス (推測不能) を割り当て、
--     メール入力・メール認証は一切ない。サインアップ/ログインは Edge Function `account` 経由。
-- ============================================================================

create schema if not exists app_private;
revoke all on schema app_private from public;
grant usage on schema app_private to authenticated, service_role;

-- ---------------------------------------------------------------- errors ----
-- クライアントは error.message をエラーコードとして扱う (例: 'rate_limited')
create or replace function app_private.fail(p_code text) returns void
language plpgsql set search_path = '' as $$
begin
  raise exception using errcode = 'P0001', message = p_code;
end $$;

-- ---------------------------------------------------------- rate limiting ----
create table app_private.rate_limits (
  key          text primary key,
  window_start timestamptz not null,
  hits         int not null
);
alter table app_private.rate_limits enable row level security;

-- 固定ウィンドウ方式。ウィンドウが切れていたらリセット。上限超過で rate_limited。
create or replace function app_private.rate_hit(p_key text, p_max int, p_window_secs int) returns void
language plpgsql security definer set search_path = '' as $$
declare v_hits int;
begin
  insert into app_private.rate_limits as r (key, window_start, hits)
  values (p_key, clock_timestamp(), 1)
  on conflict (key) do update set
    window_start = case when r.window_start < clock_timestamp() - make_interval(secs => p_window_secs)
                        then clock_timestamp() else r.window_start end,
    hits = case when r.window_start < clock_timestamp() - make_interval(secs => p_window_secs)
                then 1 else r.hits + 1 end
  returning hits into v_hits;
  if v_hits > p_max then
    perform app_private.fail('rate_limited');
  end if;
end $$;

-- ----------------------------------------------------------------- players ----
create table public.players (
  id         uuid primary key references auth.users(id) on delete cascade,
  name       text not null,
  name_key   text not null,
  code       text not null,
  created_at timestamptz not null default now(),
  matches    int not null default 0,
  wins       int not null default 0,
  losses     int not null default 0,
  draws      int not null default 0,
  constraint players_name_len check (char_length(name) between 2 and 16),
  constraint players_name_key_unique unique (name_key),
  constraint players_code_unique unique (code),
  constraint players_stats_sane check (matches = wins + losses + draws and wins >= 0 and losses >= 0 and draws >= 0)
);
alter table public.players enable row level security;

-- ログイン用の内部メール (推測不能)。Edge Function (service_role) だけが読む
create table app_private.player_secrets (
  player_id  uuid primary key references public.players(id) on delete cascade,
  auth_email text not null unique
);
alter table app_private.player_secrets enable row level security;

create table app_private.presence (
  player_id uuid primary key references public.players(id) on delete cascade,
  last_seen timestamptz not null default now()
);
alter table app_private.presence enable row level security;

-- ------------------------------------------------------------- auth guard ----
-- 公開サインアップ (anon の /auth/v1/signup) で作られたユーザーを拒否する。
-- Edge Function が admin API で作るユーザーだけ app_metadata.teruki = '1' を持つ。
-- GoTrue の admin 作成は「INSERT → 同じトランザクション内で app_metadata を UPDATE」なので、
-- コミット時に検査する遅延制約トリガーにする (INSERT 時点ではまだフラグが無い)。
create or replace function app_private.guard_auth_users_commit() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from auth.users u where u.id = new.id and coalesce(u.raw_app_meta_data ->> 'teruki', '') = '1') then
    raise exception using errcode = 'P0001', message = 'signup_disabled';
  end if;
  return null;
end $$;

create constraint trigger teruki_guard_auth_users_commit
  after insert on auth.users
  deferrable initially deferred
  for each row execute function app_private.guard_auth_users_commit();

-- ----------------------------------------------------------------- helpers ----
create or replace function app_private.me() returns uuid
language plpgsql stable security definer set search_path = '' as $$
declare v uuid := auth.uid();
begin
  if v is null then perform app_private.fail('unauthenticated'); end if;
  if not exists (select 1 from public.players where id = v) then perform app_private.fail('no_player'); end if;
  return v;
end $$;

create or replace function app_private.is_online(p_player uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select last_seen > clock_timestamp() - interval '75 seconds'
                   from app_private.presence where player_id = p_player), false);
$$;

create or replace function app_private.gen_code() returns text
language plpgsql set search_path = '' as $$
declare
  alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  c text;
  i int;
begin
  loop
    c := '';
    for i in 1..8 loop
      c := c || substr(alphabet, 1 + floor(random() * 32)::int, 1);
    end loop;
    exit when not exists (select 1 from public.players where code = c);
  end loop;
  return c;
end $$;

-- ------------------------------------------- service-role only (Edge Function) --
create or replace function public.svc_name_available(p_name_key text) returns boolean
language sql stable security definer set search_path = '' as $$
  select not exists (select 1 from public.players where name_key = p_name_key);
$$;

create or replace function public.svc_create_player(p_user_id uuid, p_name text, p_name_key text, p_auth_email text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_code text;
begin
  v_code := app_private.gen_code();
  begin
    insert into public.players (id, name, name_key, code) values (p_user_id, p_name, p_name_key, v_code);
  exception when unique_violation then
    perform app_private.fail('name_taken');
  end;
  insert into app_private.player_secrets (player_id, auth_email) values (p_user_id, p_auth_email);
  insert into app_private.presence (player_id) values (p_user_id);
  return jsonb_build_object('id', p_user_id, 'name', p_name, 'code', v_code);
end $$;

create or replace function public.svc_login_lookup(p_name_key text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('player_id', p.id, 'auth_email', s.auth_email, 'name', p.name, 'code', p.code)
  from public.players p join app_private.player_secrets s on s.player_id = p.id
  where p.name_key = p_name_key;
$$;

-- ログイン試行の制限。peek は加算せず確認だけ、hit は失敗時に加算、reset は成功時
create or replace function public.svc_rate_peek(p_key text, p_max int, p_window_secs int) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r app_private.rate_limits%rowtype;
begin
  select * into r from app_private.rate_limits where key = p_key;
  if not found or r.window_start < clock_timestamp() - make_interval(secs => p_window_secs) or r.hits < p_max then
    return jsonb_build_object('allowed', true, 'retry_after', 0);
  end if;
  return jsonb_build_object('allowed', false,
    'retry_after', greatest(1, ceil(extract(epoch from (r.window_start + make_interval(secs => p_window_secs) - clock_timestamp())))::int));
end $$;

create or replace function public.svc_rate_hit(p_key text, p_window_secs int) returns void
language plpgsql security definer set search_path = '' as $$
begin
  insert into app_private.rate_limits as r (key, window_start, hits)
  values (p_key, clock_timestamp(), 1)
  on conflict (key) do update set
    window_start = case when r.window_start < clock_timestamp() - make_interval(secs => p_window_secs)
                        then clock_timestamp() else r.window_start end,
    hits = case when r.window_start < clock_timestamp() - make_interval(secs => p_window_secs)
                then 1 else r.hits + 1 end;
end $$;

create or replace function public.svc_rate_reset(p_key text) returns void
language sql security definer set search_path = '' as $$
  delete from app_private.rate_limits where key = p_key;
$$;

-- ------------------------------------------------------------- client RPCs ----
create or replace function public.heartbeat() returns timestamptz
language plpgsql security definer set search_path = '' as $$
declare v_me uuid := app_private.me();
begin
  insert into app_private.presence as p (player_id, last_seen) values (v_me, clock_timestamp())
  on conflict (player_id) do update set last_seen = clock_timestamp();
  if random() < 0.002 then
    perform app_private.purge_old_data();   -- pg_cron が無くても、ときどき古いデータを掃除する
  end if;
  return clock_timestamp();
end $$;

create or replace function public.server_time() returns timestamptz
language sql stable security definer set search_path = '' as $$
  select clock_timestamp();
$$;

-- RLS: 自分の行だけ直接読める (他人は RPC 経由で必要な項目のみ)
create policy players_select_self on public.players for select to authenticated
  using (id = auth.uid());
