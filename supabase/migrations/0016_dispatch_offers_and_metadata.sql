alter table orders add column metadata jsonb not null default '{"dispatch_attempts": [], "dispatch_radius_km": null, "dispatch_failed": false}'::jsonb;

create table dispatch_offers (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references orders(id),
  driver_id uuid not null references drivers(id),
  round smallint not null,
  radius_km numeric(4,2),
  status text not null default 'ACTIVE' check (status in ('ACTIVE', 'ACCEPTED', 'REJECTED', 'EXPIRED')),
  version integer not null default 1,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  responded_at timestamptz
);

create unique index dispatch_offers_one_active_per_driver on dispatch_offers (driver_id) where status = 'ACTIVE';
create index dispatch_offers_order_idx on dispatch_offers (order_id, created_at);
