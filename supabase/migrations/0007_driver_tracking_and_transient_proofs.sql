create table driver_locations (
  id uuid primary key default gen_random_uuid(),
  driver_id uuid not null references drivers(id),
  lat double precision not null check (lat between -90 and 90),
  lng double precision not null check (lng between -180 and 180),
  recorded_at timestamptz not null,
  received_at timestamptz not null default now()
);

create index driver_locations_driver_recorded_idx on driver_locations (driver_id, recorded_at desc);

-- This table is deliberately transient: the application deletes rows once their
-- seven-day dispute window has elapsed. It is not part of the domain event log.
create table order_proof_photos (
  order_id uuid primary key references orders(id) on delete cascade,
  content bytea not null check (octet_length(content) > 0 and octet_length(content) <= 512000),
  content_type text not null check (content_type = 'image/jpeg'),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create index order_proof_photos_expires_idx on order_proof_photos (expires_at);
