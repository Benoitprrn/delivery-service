alter table merchants add column address text;

update merchants
set address = 'Place de la Grenette, 01000 Bourg-en-Bresse'
where id = '22222222-2222-2222-2222-222222222222';

alter table merchants alter column address set not null;
