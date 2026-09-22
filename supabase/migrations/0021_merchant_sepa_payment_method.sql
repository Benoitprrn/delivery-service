-- Le Customer Stripe est stable et distinct des tentatives / moyens SEPA.
-- Une tentative de remplacement peut ainsi coexister avec le moyen actif.
create table if not exists merchant_payment_profiles (
  merchant_id uuid primary key references merchants(id) on delete cascade,
  stripe_customer_id text not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists merchant_payment_methods (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references merchants(id) on delete cascade,
  stripe_setup_intent_id text not null unique,
  stripe_payment_method_id text unique,
  stripe_mandate_id text unique,
  status text not null check (status in ('setup_pending', 'active', 'invalid', 'detach_pending', 'detached')),
  bank_name text,
  last4 text,
  country text,
  mandate_reference text,
  activated_at timestamptz,
  invalidated_at timestamptz,
  detached_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Au plus un moyen actif, mais une tentative setup_pending peut coexister.
create unique index if not exists merchant_payment_methods_one_active_idx
  on merchant_payment_methods (merchant_id) where status = 'active';
create index if not exists merchant_payment_methods_merchant_idx
  on merchant_payment_methods (merchant_id);
create index if not exists merchant_payment_methods_mandate_idx
  on merchant_payment_methods (stripe_mandate_id);

create table if not exists stripe_webhook_events (
  event_id text primary key,
  received_at timestamptz not null default now(),
  status text not null default 'processing' check (status in ('processing', 'processed', 'failed')),
  processing_started_at timestamptz,
  processing_token uuid,
  processed_at timestamptz,
  last_error text
);
