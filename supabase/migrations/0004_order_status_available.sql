alter table orders drop constraint orders_driver_status_check;
alter table orders alter column status drop default;

create type order_status_new as enum (
  'CREATED',
  'AVAILABLE',
  'ASSIGNED',
  'COLLECTED',
  'COMPLETED',
  'CANCELLED',
  'RETURNING',
  'RETURNED'
);

alter table orders
  alter column status type order_status_new using status::text::order_status_new;

alter table order_events
  alter column from_status type order_status_new using from_status::text::order_status_new,
  alter column to_status type order_status_new using to_status::text::order_status_new;

drop type order_status;
alter type order_status_new rename to order_status;

alter table orders
  alter column status set default 'AVAILABLE'::order_status,
  add constraint orders_driver_status_check check (
    (status in ('CREATED', 'AVAILABLE', 'CANCELLED') and driver_id is null)
    or (
      status in ('ASSIGNED', 'COLLECTED', 'COMPLETED', 'RETURNING', 'RETURNED')
      and driver_id is not null
    )
  );
