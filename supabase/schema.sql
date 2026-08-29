-- Key-value store backing the Prem Predictor app.
-- Run this once in the Supabase SQL editor (Dashboard -> SQL Editor -> New query).

create table if not exists public.kv (
  key    text    not null,
  shared boolean not null default true,
  value  text    not null,
  updated_at timestamptz not null default now(),
  primary key (key, shared)
);

-- Keep updated_at fresh on every write.
create or replace function public.kv_touch()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists kv_touch on public.kv;
create trigger kv_touch before update on public.kv
  for each row execute function public.kv_touch();

-- Row Level Security.
-- This app has no Supabase Auth login (players sign in with a name + PIN stored
-- inside the data itself), so the browser uses the publishable/anon key for all
-- reads and writes. To let that work, allow the `anon` role full access to `kv`.
--
-- NOTE: this makes the whole store readable/writable by anyone with the URL and
-- publishable key. That matches the original artifact behaviour (all league data
-- was already shared), and the README warns not to put anything private here.
alter table public.kv enable row level security;

drop policy if exists kv_anon_all on public.kv;
create policy kv_anon_all on public.kv
  for all
  to anon, authenticated
  using (true)
  with check (true);
