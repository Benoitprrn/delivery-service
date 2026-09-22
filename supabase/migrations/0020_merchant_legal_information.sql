create table merchant_legal_information (
  merchant_id uuid primary key references merchants(id) on delete cascade,
  siret char(14) not null check (siret ~ '^[0-9]{14}$'),
  siren char(9) not null check (siren ~ '^[0-9]{9}$' and siren = left(siret, 9)),
  legal_name text not null check (btrim(legal_name) <> ''),
  legal_address_line1 text not null check (btrim(legal_address_line1) <> ''),
  legal_address_line2 text,
  legal_address_postal_code text not null check (btrim(legal_address_postal_code) <> ''),
  legal_address_city text not null check (btrim(legal_address_city) <> ''),
  legal_address_country_code char(2) not null default 'FR',
  legal_address_commune_code text,
  billing_address_line1 text,
  billing_address_line2 text,
  billing_address_postal_code text,
  billing_address_city text,
  billing_address_country_code char(2),
  billing_address_commune_code text,
  vat_number text,
  sirene_verification_status text not null check (sirene_verification_status in ('verified', 'unavailable', 'restricted', 'unverified')),
  sirene_verified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (billing_address_line1 is null and billing_address_line2 is null and billing_address_postal_code is null and billing_address_city is null and billing_address_country_code is null and billing_address_commune_code is null)
    or (billing_address_line1 is not null and billing_address_postal_code is not null and billing_address_city is not null and billing_address_country_code is not null)
  ),
  check ((sirene_verification_status = 'verified') = (sirene_verified_at is not null))
);
