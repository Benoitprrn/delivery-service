alter table orders
  add column pickup_scheduled_at timestamptz null,
  add column order_details text null,
  add column delivery_instructions text null,
  add column delivery_address_complement text null;
