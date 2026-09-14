alter table merchants add column phone text;

update merchants
set phone = '04 74 00 00 00'
where id = '22222222-2222-2222-2222-222222222222';

alter table merchants alter column phone set not null;
