-- MVP Profilo Utente + Tracce + Classifica
-- Esegui questo script nello SQL Editor di Supabase.

create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null check (char_length(display_name) >= 2),
  avatar_url text,
  created_at timestamptz not null default now()
);

create table if not exists public.tracks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  started_at timestamptz not null,
  ended_at timestamptz not null,
  distance_km numeric(8, 2) not null check (distance_km >= 0),
  duration_sec integer not null check (duration_sec >= 0),
  avg_speed_kmh numeric(8, 2) not null check (avg_speed_kmh >= 0),
  elevation_gain_m integer not null default 0 check (elevation_gain_m >= 0),
  created_at timestamptz not null default now()
);

create index if not exists tracks_user_id_idx on public.tracks(user_id);
create index if not exists tracks_created_at_idx on public.tracks(created_at desc);
alter table public.tracks add column if not exists elevation_gain_m integer not null default 0 check (elevation_gain_m >= 0);

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, display_name)
  values (
    new.id,
    coalesce(
      nullif(new.raw_user_meta_data ->> 'display_name', ''),
      split_part(new.email, '@', 1)
    )
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

alter table public.profiles enable row level security;
alter table public.tracks enable row level security;

drop policy if exists "profiles_select_own" on public.profiles;
create policy "profiles_select_own"
  on public.profiles for select
  to authenticated
  using (auth.uid() = id);

drop policy if exists "profiles_insert_own" on public.profiles;
create policy "profiles_insert_own"
  on public.profiles for insert
  to authenticated
  with check (auth.uid() = id);

drop policy if exists "profiles_update_own" on public.profiles;
create policy "profiles_update_own"
  on public.profiles for update
  to authenticated
  using (auth.uid() = id)
  with check (auth.uid() = id);

drop policy if exists "tracks_select_own" on public.tracks;
create policy "tracks_select_own"
  on public.tracks for select
  to authenticated
  using (auth.uid() = user_id);

drop policy if exists "tracks_insert_own" on public.tracks;
create policy "tracks_insert_own"
  on public.tracks for insert
  to authenticated
  with check (auth.uid() = user_id);

drop policy if exists "tracks_update_own" on public.tracks;
create policy "tracks_update_own"
  on public.tracks for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "tracks_delete_own" on public.tracks;
create policy "tracks_delete_own"
  on public.tracks for delete
  to authenticated
  using (auth.uid() = user_id);

drop view if exists public.leaderboard_km;
create view public.leaderboard_km as
select
  p.id as user_id,
  p.display_name,
  coalesce(sum(t.distance_km), 0)::numeric(10, 2) as total_km,
  coalesce(sum(t.elevation_gain_m), 0)::int as total_elevation_m,
  count(t.id)::int as total_tracks
from public.profiles p
left join public.tracks t on t.user_id = p.id
group by p.id, p.display_name;

grant select on public.leaderboard_km to authenticated;
