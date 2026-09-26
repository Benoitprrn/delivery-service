-- Brouillon distinct du profil légal publiable : une sauvegarde partielle ne
-- doit jamais alimenter `driver_legal_information` ni les flux de facturation.
create table public.driver_company_profile_drafts (
  driver_id uuid primary key references public.drivers(id),
  first_name text,
  last_name text,
  phone text,
  legal_form text,
  professional_name text,
  siret text,
  legal_address_line1 text,
  legal_address_postal_code text,
  legal_address_city text,
  vat_number text,
  vat_regime text check (vat_regime in ('assujetti', 'franchise_en_base', 'exonere')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.driver_company_profile_drafts enable row level security;
revoke all privileges on table public.driver_company_profile_drafts from anon, authenticated;

-- Les comptes existants restent fonctionnels après le déploiement : leur état
-- publié devient leur brouillon initial, sans toucher aux données légales.
insert into public.driver_company_profile_drafts (
  driver_id, first_name, last_name, phone, legal_form, professional_name, siret,
  legal_address_line1, legal_address_postal_code, legal_address_city, vat_number, vat_regime
)
select d.id, d.first_name, d.last_name, d.phone, li.legal_form, li.professional_name, li.siret,
       li.legal_address_line1, li.legal_address_postal_code, li.legal_address_city, li.vat_number, li.vat_regime
from public.drivers d
left join public.driver_legal_information li on li.driver_id = d.id
on conflict (driver_id) do nothing;
