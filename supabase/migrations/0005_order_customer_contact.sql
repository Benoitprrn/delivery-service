alter table orders add column customer_name text;
alter table orders add column customer_phone text;
alter table orders add column customer_email text;

update orders
set customer_name = 'Client', customer_phone = '0000000000'
where customer_name is null or customer_phone is null;

alter table orders alter column customer_name set not null;
alter table orders alter column customer_phone set not null;
