-- SF3 (docs/work/pricing-service-fee-plan.md) : schéma d'override futur du taux de service
-- par restaurant. Colonne nullable seule ; aucune interface admin ni logique de résolution
-- applicative construite à cette étape (prévu SF5). Résolution attendue plus tard :
-- taux effectif = coalesce(merchants.service_fee_rate_bps_override, pricing_settings courant).
alter table public.merchants
  add column service_fee_rate_bps_override integer null
    check (service_fee_rate_bps_override is null or service_fee_rate_bps_override between 0 and 10000);
