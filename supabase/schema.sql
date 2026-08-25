create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  role text not null default 'viewer' check (role in ('admin', 'viewer')),
  created_at timestamptz not null default now()
);

create table if not exists public.vehicles (
  id uuid primary key default gen_random_uuid(),
  vehicle_code text not null unique check (char_length(btrim(vehicle_code)) > 0),
  vin text,
  source_header text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.vehicle_component_versions (
  id uuid primary key default gen_random_uuid(),
  vehicle_id uuid not null references public.vehicles(id) on delete cascade,
  component_name text not null check (char_length(btrim(component_name)) > 0),
  component_category text,
  version_label text not null check (char_length(btrim(version_label)) > 0),
  version_value text,
  note text,
  source_row integer,
  source_column text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (vehicle_id, component_name, version_label)
);

create index if not exists vehicle_component_versions_vehicle_id_idx
  on public.vehicle_component_versions(vehicle_id);

create index if not exists vehicle_component_versions_component_name_idx
  on public.vehicle_component_versions(component_name);

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.profiles
    where id = auth.uid() and role = 'admin'
  );
$$;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email)
  values (new.id, new.email)
  on conflict (id) do update set email = excluded.email;
  return new;
end;
$$;

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute procedure public.handle_new_user();

drop trigger if exists touch_vehicles_updated_at on public.vehicles;
create trigger touch_vehicles_updated_at
before update on public.vehicles
for each row execute procedure public.touch_updated_at();

drop trigger if exists touch_vehicle_component_versions_updated_at on public.vehicle_component_versions;
create trigger touch_vehicle_component_versions_updated_at
before update on public.vehicle_component_versions
for each row execute procedure public.touch_updated_at();

alter table public.profiles enable row level security;
alter table public.vehicles enable row level security;
alter table public.vehicle_component_versions enable row level security;

drop policy if exists "profiles own read" on public.profiles;
create policy "profiles own read"
on public.profiles
for select
to authenticated
using (id = auth.uid());

drop policy if exists "authenticated read vehicles" on public.vehicles;
drop policy if exists "public read vehicles" on public.vehicles;
create policy "public read vehicles"
on public.vehicles
for select
to anon, authenticated
using (true);

drop policy if exists "admins insert vehicles" on public.vehicles;
create policy "admins insert vehicles"
on public.vehicles
for insert
to authenticated
with check (public.is_admin());

drop policy if exists "admins update vehicles" on public.vehicles;
create policy "admins update vehicles"
on public.vehicles
for update
to authenticated
using (public.is_admin())
with check (public.is_admin());

drop policy if exists "admins delete vehicles" on public.vehicles;
create policy "admins delete vehicles"
on public.vehicles
for delete
to authenticated
using (public.is_admin());

drop policy if exists "authenticated read vehicle component versions" on public.vehicle_component_versions;
drop policy if exists "public read vehicle component versions" on public.vehicle_component_versions;
create policy "public read vehicle component versions"
on public.vehicle_component_versions
for select
to anon, authenticated
using (true);

drop policy if exists "admins insert vehicle component versions" on public.vehicle_component_versions;
create policy "admins insert vehicle component versions"
on public.vehicle_component_versions
for insert
to authenticated
with check (public.is_admin());

drop policy if exists "admins update vehicle component versions" on public.vehicle_component_versions;
create policy "admins update vehicle component versions"
on public.vehicle_component_versions
for update
to authenticated
using (public.is_admin())
with check (public.is_admin());

drop policy if exists "admins delete vehicle component versions" on public.vehicle_component_versions;
create policy "admins delete vehicle component versions"
on public.vehicle_component_versions
for delete
to authenticated
using (public.is_admin());

do $$
begin
  if to_regclass('public.sheet_configs') is not null then
    alter table public.sheet_configs enable row level security;
    drop policy if exists "public read sheet configs" on public.sheet_configs;
  end if;
  if to_regclass('public.sheet_rows') is not null then
    alter table public.sheet_rows enable row level security;
    drop policy if exists "public read sheet rows" on public.sheet_rows;
  end if;
end;
$$;
