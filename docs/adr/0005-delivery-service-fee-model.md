# ADR 0005 — Modèle économique livraison / frais de service (additif)

Statut : validé — 2026-09-22

Remplace, sur le seul point du calcul des frais : ADR 0002 (§ « merchant_price_cents et
driver_earning_cents reçoivent la même valeur ») et ADR 0004 (§ « Frais Locadely : 20 % du
gain de CHAQUE course »). Le reste de ces deux ADR (formule horokilométrique, cycle
hebdomadaire, Separate Charges and Transfers, paiement groupé, impayé restaurant, reversals,
comptes livreurs) reste en vigueur, inchangé.

## Contexte

Le modèle implémenté en Phase 1 traitait les « frais Locadely » comme une commission
prélevée SUR le gain du livreur : `fee_cents = floor(driver_earning_cents × 20 / 100)`,
`net_cents = driver_earning_cents - fee_cents` transféré au livreur, restaurant débité du
seul prix de livraison. Analyse (Claude + Codex, indépendantes, convergentes,
2026-09-22) confirmant ce comportement dans le code et le désignant comme économiquement
inversé par rapport au modèle réel. Détail et plan de correction :
`docs/work/pricing-service-fee-plan.md`.

## Décision

Deux prestations économiquement distinctes par commande :

1. **Livraison** — prestation du livreur. Relation économique : Livreur → Restaurant.
   Montant : `delivery_cents`, appartient à 100 % au livreur.
2. **Service Locadely** — mise en relation / plateforme. Relation économique :
   Locadely → Restaurant. Montant : `service_fee_cents`, appartient à 100 % à Locadely.

```
delivery_cents = max(minimum_delivery_cents, pickup_fee_cents
  + floor(distance_m × km_rate_cents / 1000)
  + floor(duration_s × minute_rate_cents / 60))

service_fee_cents = floor(delivery_cents × service_fee_rate_bps / 10_000)

restaurant_total_cents = delivery_cents + service_fee_cents
```

- `service_fee_cents` est ADDITIF : ajouté au montant dû par le restaurant, JAMAIS
  soustrait au livreur. Le calcul `delivery - service = net au livreur` est explicitement
  FAUX et ne doit plus apparaître dans le code.
- `floor()` par composante distance et par composante durée séparément (règle héritée ADR
  0002, inchangée). Minimum appliqué APRÈS somme des composantes, AVANT calcul du service fee.
- Paramètres (collecte, €/km, €/min, minimum, taux de service par défaut) configurables via
  `pricing_settings`, table append-only versionnée (`rule_version`) : changer un tarif =
  insérer une nouvelle version, jamais modifier une version existante — aucune commande déjà
  créée n'est recalculée.
- Taux de service : 20 % (2000 bps) par défaut, globalement configurable. Override possible
  par restaurant (`merchants.service_fee_rate_bps_override`, nullable). Taux effectif =
  override ?? défaut, RÉSOLU ET FIGÉ sur la commande à sa création.
- `orders.price_cents` sort du mécanisme de colonne générée SQL (une colonne générée ne peut
  pas lire une table de config mutable) ; calculé et figé une seule fois, à l'insertion, par
  trigger PostgreSQL lisant `pricing_settings`. `orders.pricing_rule_version` fige la version
  utilisée. `orders.delivery_cents` / `orders.service_fee_cents` : nouvelles colonnes du
  modèle cible, verrouillées après une transition unique NULL → valeur (même régime que
  `driver_earning_cents`).
- Mécanisme Stripe (Separate Charges and Transfers, `source_transaction`) inchangé — seul le
  montant transporté par le Transfer devient le plein `delivery_cents` au lieu d'un montant
  net d'une soustraction.

## Ce que cette décision ne couvre pas (hors périmètre, chantiers séparés)

- Groupage tarifaire avancé (trajet client1→client2) et retour (RETURN) : non conçus ici. Le
  design ne les empêche pas structurellement, mais AUCUNE promesse n'est faite qu'ils
  s'implémenteront sans nouveau changement de schéma — voir
  `docs/work/pricing-service-fee-plan.md` §3.
- TVA, facturation (F10) : hors périmètre. Le modèle laisse la porte ouverte (montants HT
  distincts et traçables par commande) sans rien construire.
- Interface admin de gestion des taux : pas nécessaire à cette étape, le schéma le permet.

## Conséquences

- Toute évolution ultérieure des paramètres tarifaires ou du taux de service passe par une
  nouvelle ligne `pricing_settings`, jamais par une modification d'une ligne existante.
- Le règlement (`settlements`, R10→R90) doit lire `delivery_cents`/`service_fee_cents` figés
  sur la commande plutôt que de recalculer un pourcentage à la clôture — chantier séparé
  (étapes SF6+ de `docs/work/pricing-service-fee-plan.md`), non couvert par cet ADR seul.
