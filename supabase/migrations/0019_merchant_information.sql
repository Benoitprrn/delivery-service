alter table merchants rename column phone_landline to phone_primary;
alter table merchants rename column phone_mobile to phone_secondary;

alter table merchants drop constraint merchants_onboarding_completed_check;

alter table merchants add constraint merchants_onboarding_completed_check check (
  not onboarding_completed or (
    zone_id is not null
    and address is not null
    and lat is not null
    and lng is not null
    and phone_primary is not null
  )
);
