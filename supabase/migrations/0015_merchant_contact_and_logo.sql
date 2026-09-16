alter table merchants rename column phone to phone_landline;
alter table merchants alter column phone_landline drop not null;
alter table merchants add column phone_mobile text null;
alter table merchants add column logo_url text null;
alter table merchants add constraint merchants_contact_phone_check check (
  phone_landline is not null or phone_mobile is not null
);

do $$
begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('merchant-logos', 'merchant-logos', true, 2097152, array['image/jpeg', 'image/png'])
    on conflict (id) do update
    set public = excluded.public,
        file_size_limit = excluded.file_size_limit,
        allowed_mime_types = excluded.allowed_mime_types;
  end if;
end $$;
