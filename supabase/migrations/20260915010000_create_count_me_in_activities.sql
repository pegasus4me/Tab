create table if not exists public.count_me_in_activities (
  id uuid primary key,
  share_code text not null unique check (length(share_code) = 16),
  organizer_user_id text not null,
  organizer_name text not null,
  organizer_address text not null,
  title text not null,
  location text not null,
  starts_at timestamptz not null,
  funding_deadline timestamptz not null,
  replacement_cutoff timestamptz not null,
  capacity integer not null check (capacity between 2 and 1000),
  contribution numeric(30, 6) not null check (contribution > 0),
  currency text not null default 'EUR' check (currency = 'EUR'),
  recipient_name text not null,
  recipient_address text not null,
  description text,
  confirmed_count integer not null default 0 check (confirmed_count >= 0 and confirmed_count <= capacity),
  status text not null check (status in ('deployment_pending', 'collecting', 'ready', 'funded', 'failed', 'cancelled')),
  terms_hash text not null,
  escrow_address text unique,
  deployment_transaction_hash text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (funding_deadline < starts_at),
  check (replacement_cutoff <= starts_at)
);

create index if not exists count_me_in_activities_organizer_created_idx
  on public.count_me_in_activities (organizer_user_id, created_at desc);
create index if not exists count_me_in_activities_active_deadline_idx
  on public.count_me_in_activities (funding_deadline)
  where status in ('collecting', 'ready');

alter table public.count_me_in_activities enable row level security;
revoke all on table public.count_me_in_activities from anon, authenticated;

create or replace function public.set_count_me_in_activities_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_count_me_in_activities_updated_at on public.count_me_in_activities;
create trigger set_count_me_in_activities_updated_at
before update on public.count_me_in_activities
for each row execute procedure public.set_count_me_in_activities_updated_at();

revoke execute on function public.set_count_me_in_activities_updated_at() from public, anon, authenticated;
