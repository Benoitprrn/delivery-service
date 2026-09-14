create extension if not exists pgcrypto;

create table zones (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  center_lat double precision not null check (center_lat between -90 and 90),
  center_lng double precision not null check (center_lng between -180 and 180),
  radius_km numeric(5,2) not null check (radius_km > 0),
  created_at timestamptz not null default now()
);

create table merchants (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  zone_id uuid not null references zones(id),
  lat double precision not null check (lat between -90 and 90),
  lng double precision not null check (lng between -180 and 180),
  created_at timestamptz not null default now(),
  unique (id, zone_id)
);

create table drivers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  zone_id uuid not null references zones(id),
  is_available boolean not null default false,
  created_at timestamptz not null default now(),
  unique (id, zone_id)
);

create type order_status as enum (
  'CREATED', 'ASSIGNED', 'COLLECTED', 'IN_TRANSIT', 'AT_DELIVERY',
  'PROOF_COLLECTION', 'PAYMENT_PENDING', 'COMPLETED',
  'CANCELLED', 'DRIVER_CANCELLED_BEFORE_PICKUP', 'RETURNING', 'RETURNED'
);

create table orders (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references merchants(id),
  driver_id uuid references drivers(id),
  zone_id uuid not null references zones(id),
  status order_status not null default 'CREATED',
  version integer not null default 1 check (version >= 1),

  pickup_address text not null,
  pickup_lat double precision not null check (pickup_lat between -90 and 90),
  pickup_lng double precision not null check (pickup_lng between -180 and 180),
  delivery_address text not null,
  delivery_lat double precision not null check (delivery_lat between -90 and 90),
  delivery_lng double precision not null check (delivery_lng between -180 and 180),

  distance_m integer not null check (distance_m >= 0),
  duration_s integer not null check (duration_s >= 0),
  price_cents integer generated always as (
    greatest(
      400::bigint,
      100::bigint + (distance_m::bigint * 37) / 1000 + (duration_s::bigint * 22) / 60
    )::integer
  ) stored,

  assigned_at timestamptz,
  collected_at timestamptz,
  completed_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint orders_merchant_zone_fk foreign key (merchant_id, zone_id) references merchants (id, zone_id),
  constraint orders_driver_zone_fk foreign key (driver_id, zone_id) references drivers (id, zone_id),
  constraint orders_driver_status_check check (
    (status in ('CREATED', 'CANCELLED') and driver_id is null)
    or (
      status in (
        'ASSIGNED', 'COLLECTED', 'IN_TRANSIT', 'AT_DELIVERY',
        'PROOF_COLLECTION', 'PAYMENT_PENDING', 'COMPLETED',
        'DRIVER_CANCELLED_BEFORE_PICKUP', 'RETURNING', 'RETURNED'
      )
      and driver_id is not null
    )
  )
);

create index orders_zone_status_idx on orders (zone_id, status);
create index orders_driver_id_idx on orders (driver_id);
create index orders_merchant_created_idx on orders (merchant_id, created_at desc);

create table order_events (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references orders(id),
  from_status order_status,
  to_status order_status not null,
  actor_type text not null check (actor_type in ('merchant', 'driver', 'system')),
  actor_id uuid,
  correlation_id uuid not null,
  created_at timestamptz not null default now(),
  constraint order_events_real_transition_check check (from_status is distinct from to_status)
);

create index order_events_order_id_idx on order_events (order_id, created_at, id);

create function prevent_order_events_mutation() returns trigger as $$
begin
  raise exception 'order_events is an immutable append-only log';
end;
$$ language plpgsql;

create trigger order_events_no_update
  before update or delete on order_events
  for each row execute function prevent_order_events_mutation();

create trigger order_events_no_truncate
  before truncate on order_events
  for each statement execute function prevent_order_events_mutation();

create table outbox_event (
  id uuid primary key default gen_random_uuid(),
  event_type text not null,
  event_version integer not null default 1 check (event_version >= 1),
  aggregate_type text not null,
  aggregate_id uuid not null,
  aggregate_version integer not null,
  payload jsonb not null,
  correlation_id uuid not null,
  created_at timestamptz not null default now(),
  published_at timestamptz,
  attempts integer not null default 0 check (attempts >= 0),
  last_error text
);

create index outbox_event_unpublished_idx on outbox_event (created_at, id) where published_at is null;
