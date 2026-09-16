alter table orders add column tracking_token uuid not null default gen_random_uuid();
alter table orders add constraint orders_tracking_token_key unique (tracking_token);
create index orders_tracking_token_idx on orders (tracking_token);
