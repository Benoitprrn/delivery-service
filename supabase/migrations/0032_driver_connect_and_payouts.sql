create table public.driver_connect_accounts (
  driver_id uuid primary key references public.drivers(id),
  stripe_account_id text not null unique,
  entity_type text not null check (entity_type in ('individual','company')),
  dashboard text not null default 'express' check (dashboard = 'express'),
  transfers_status text not null default 'inactive' check (transfers_status in ('inactive','pending','active','restricted','unknown')),
  payouts_status text not null default 'inactive' check (payouts_status in ('inactive','pending','active','restricted','unknown')),
  requirements_state text not null default 'none' check (requirements_state in ('none','eventually_due','currently_due','past_due','disabled')),
  restricted_at timestamptz null, last_synced_at timestamptz null, livemode boolean not null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (driver_id, stripe_account_id)
);

create table public.driver_payout_observations (
  id uuid primary key default gen_random_uuid(),
  driver_id uuid not null references public.drivers(id),
  stripe_account_id text not null,
  stripe_payout_id text not null unique,
  amount_cents bigint not null check (amount_cents >= 0),
  status text not null,
  automatic boolean not null,
  arrival_date date null, observed_at timestamptz not null default now(), livemode boolean not null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  constraint driver_payout_observations_account_fk foreign key (driver_id, stripe_account_id) references public.driver_connect_accounts(driver_id, stripe_account_id)
);
create index driver_payout_observations_driver_arrival_idx on public.driver_payout_observations(driver_id, arrival_date);

alter table public.driver_connect_accounts enable row level security;
alter table public.driver_payout_observations enable row level security;
revoke all privileges on table public.driver_connect_accounts, public.driver_payout_observations from anon, authenticated;
