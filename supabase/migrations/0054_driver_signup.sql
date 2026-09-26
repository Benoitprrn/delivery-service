-- Driver self-signup.  The backfill is intentionally fail-loud: this registry
-- is the cross-role identity authority, so accepting an unparseable legacy
-- number or arbitrarily choosing one duplicate would make its uniqueness claim
-- false.  The normalizer accepts exactly the same French 0X/+33X forms as the
-- HTTP endpoint (spaces, dots and hyphens are presentation only).
create table public.account_phone_registry (
  account_id uuid primary key,
  role text not null check (role in ('driver', 'merchant')),
  phone_e164 text not null unique,
  created_at timestamptz not null default now()
);

create table public.driver_terms_acceptances (
  id uuid primary key default gen_random_uuid(),
  driver_id uuid not null references public.drivers(id),
  version text not null,
  content_hash text not null,
  accepted_at timestamptz not null default now()
);

create function public.normalize_signup_french_phone(value text) returns text
language plpgsql immutable set search_path = '' as $$
declare compact text;
begin
  compact := regexp_replace(btrim(value), '[[:space:].-]', '', 'g');
  if compact ~ '^0[1-9][0-9]{8}$' then return '+33' || substr(compact, 2); end if;
  if compact ~ '^\+33[1-9][0-9]{8}$' then return compact; end if;
  return null;
end;
$$;

do $$
declare bad text;
begin
  select phone into bad from public.merchant_account_contact where public.normalize_signup_french_phone(phone) is null limit 1;
  if bad is not null then raise exception 'Cannot backfill account_phone_registry: unparseable merchant account phone'; end if;
  select phone into bad from public.drivers where phone is not null and public.normalize_signup_french_phone(phone) is null limit 1;
  if bad is not null then raise exception 'Cannot backfill account_phone_registry: unparseable driver phone'; end if;
end;
$$;

insert into public.account_phone_registry (account_id, role, phone_e164)
select merchant_id, 'merchant', public.normalize_signup_french_phone(phone)
from public.merchant_account_contact;
insert into public.account_phone_registry (account_id, role, phone_e164)
select id, 'driver', public.normalize_signup_french_phone(phone)
from public.drivers where phone is not null;

-- Signup checkbox evidence is append-only; it is deliberately unrelated to
-- the SEPA mandate, partnership contract, or e-invoicing mandate tables.
create function public.prevent_driver_terms_acceptance_mutation() returns trigger
language plpgsql set search_path = '' as $$ begin raise exception 'driver terms acceptances are append-only'; end; $$;
create trigger driver_terms_acceptances_no_mutation before update or delete on public.driver_terms_acceptances
for each row execute function public.prevent_driver_terms_acceptance_mutation();

alter table public.account_phone_registry enable row level security;
revoke all privileges on table public.account_phone_registry from anon, authenticated;
alter table public.driver_terms_acceptances enable row level security;
revoke all privileges on table public.driver_terms_acceptances from anon, authenticated;
-- Defence in depth for the intentionally locked-down Data API (same posture
-- as 0026): these helper functions are internal migration implementation.
revoke execute on function public.normalize_signup_french_phone(text) from anon, authenticated, public;
revoke execute on function public.prevent_driver_terms_acceptance_mutation() from anon, authenticated, public;
