-- IS4PR 关联件工作台：Supabase 数据库结构
create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  role text not null default 'viewer' check (role in ('admin', 'viewer')),
  created_at timestamptz not null default now()
);

create table if not exists public.sheet_configs (
  key text primary key,
  name text not null,
  columns jsonb not null default '[]'::jsonb,
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists public.sheet_rows (
  id uuid primary key default gen_random_uuid(),
  sheet_key text not null references public.sheet_configs(key) on delete cascade,
  row_index integer not null,
  cells jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(sheet_key, row_index)
);

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
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
  insert into public.profiles (id, email) values (new.id, new.email)
  on conflict (id) do update set email = excluded.email;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute procedure public.handle_new_user();

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists touch_sheet_rows_updated_at on public.sheet_rows;
create trigger touch_sheet_rows_updated_at
before update on public.sheet_rows
for each row execute procedure public.touch_updated_at();

alter table public.profiles enable row level security;
alter table public.sheet_configs enable row level security;
alter table public.sheet_rows enable row level security;

drop policy if exists "profiles own read" on public.profiles;
create policy "profiles own read" on public.profiles for select to authenticated using (id = auth.uid());

drop policy if exists "public read sheet configs" on public.sheet_configs;
create policy "public read sheet configs" on public.sheet_configs for select to anon, authenticated using (true);

drop policy if exists "public read sheet rows" on public.sheet_rows;
create policy "public read sheet rows" on public.sheet_rows for select to anon, authenticated using (true);

drop policy if exists "admins insert sheet configs" on public.sheet_configs;
create policy "admins insert sheet configs" on public.sheet_configs for insert to authenticated with check (public.is_admin());
drop policy if exists "admins update sheet configs" on public.sheet_configs;
create policy "admins update sheet configs" on public.sheet_configs for update to authenticated using (public.is_admin()) with check (public.is_admin());
drop policy if exists "admins delete sheet configs" on public.sheet_configs;
create policy "admins delete sheet configs" on public.sheet_configs for delete to authenticated using (public.is_admin());

drop policy if exists "admins insert sheet rows" on public.sheet_rows;
create policy "admins insert sheet rows" on public.sheet_rows for insert to authenticated with check (public.is_admin());
drop policy if exists "admins update sheet rows" on public.sheet_rows;
create policy "admins update sheet rows" on public.sheet_rows for update to authenticated using (public.is_admin()) with check (public.is_admin());
drop policy if exists "admins delete sheet rows" on public.sheet_rows;
create policy "admins delete sheet rows" on public.sheet_rows for delete to authenticated using (public.is_admin());

-- 第一次登录后，在 Supabase SQL Editor 执行下面两句把指定账号设为管理员：
-- update public.profiles set role = 'admin' where email = 'your-admin@example.com';
-- select id, email, role from public.profiles;
