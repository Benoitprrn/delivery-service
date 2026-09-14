alter table orders add column driver_earning_cents integer;

update orders
set driver_earning_cents = price_cents
where driver_earning_cents is null;

alter table orders
  alter column driver_earning_cents set not null,
  add constraint orders_driver_earning_cents_nonnegative_check check (driver_earning_cents >= 0);
