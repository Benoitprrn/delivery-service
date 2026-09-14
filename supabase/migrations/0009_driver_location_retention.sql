alter table driver_locations add column expires_at timestamptz;

update driver_locations
set expires_at = recorded_at + interval '7 days'
where expires_at is null;

alter table driver_locations alter column expires_at set not null;

create index driver_locations_expires_idx on driver_locations (expires_at);
