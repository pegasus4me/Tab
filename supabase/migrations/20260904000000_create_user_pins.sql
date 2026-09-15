create table if not exists public.user_pins (
  user_id text primary key,
  salt text not null,
  hash text not null,
  failed_attempts smallint not null default 0 check (failed_attempts between 0 and 4),
  locked_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.user_pins enable row level security;
revoke all on table public.user_pins from anon, authenticated;
create policy "deny direct user_pins access"
on public.user_pins
as restrictive
for all
to anon, authenticated
using (false)
with check (false);

create or replace function public.set_user_pins_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_user_pins_updated_at on public.user_pins;
create trigger set_user_pins_updated_at
before update on public.user_pins
for each row execute procedure public.set_user_pins_updated_at();

revoke execute on function public.set_user_pins_updated_at() from public, anon, authenticated;
