alter table merchants alter column zone_id drop not null;
alter table merchants alter column address drop not null;
alter table merchants alter column lat drop not null;
alter table merchants alter column lng drop not null;

alter table merchants drop constraint merchants_contact_phone_check;

alter table merchants add column onboarding_completed boolean not null default false;

update merchants
set onboarding_completed = true
where zone_id is not null
  and address is not null
  and lat is not null
  and lng is not null
  and (phone_landline is not null or phone_mobile is not null);

alter table merchants add constraint merchants_onboarding_completed_check check (
  not onboarding_completed or (
    zone_id is not null
    and address is not null
    and lat is not null
    and lng is not null
    and (phone_landline is not null or phone_mobile is not null)
  )
);
