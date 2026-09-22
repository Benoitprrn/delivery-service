# ADR 0004 — Règlement des livreurs : Stripe Connect, paiement groupé, impayé restaurant

Statut : validé — 2026-09-21 (G1 validé ; canary live G3 encore ouvert)

## Contexte

Les livreurs sont indépendants et travaillent pour plusieurs restaurants. Locadely
prélève chaque restaurant par SEPA, puis verse aux livreurs ce qui a réellement été
encaissé, après déduction de ses frais. Le plan complet et les résultats des essais
Stripe Sandbox (SP1–SP7) sont dans `docs/work/driver-settlement-plan.md`.

## Décision

- **Frais Locadely** : 20 % du gain de CHAQUE course, en entiers :
  `fee_cents = floor(driver_earning_cents × 20 / 100)` (401 → 80, 475 → 95,
  909 → 181), jamais calculé sur le total. Le taux (2000 bps) et la version de règle
  sont figés sur la ligne. Le gain vient de `orders.driver_earning_cents` (ADR 0002),
  jamais recalculé ; une course `RETURNED` est rémunérée comme une course
  `COMPLETED` ; `RETURNING` et `CANCELLED` ne sont jamais réglées.
- **Cycle** : lundi = clôture de la période (bornes lundi 00:00 Europe/Paris → UTC) et
  pré-notification du restaurant ; mercredi (avant 10:30 CET) = un PaymentIntent SEPA
  par restaurant sur la plateforme ; le succès Stripe arrive à T+6 jours ouvrés ;
  `payrun_at` = 7ᵉ jour ouvré après le débit.
- **Separate Charges and Transfers** : un Transfer `source_transaction` par statement
  (livreur × restaurant × période), créé UNIQUEMENT si la charge a été relue et est
  `succeeded` + `paid` + `balance_transaction` présent, et dans la limite du brut de
  la charge. Jamais depuis une charge `processing` ou `failed` : Stripe accepte
  pourtant ces Transfers (essais SP1/SP2), le domaine est donc la seule garde.
- **Paiement groupé** : rien n'est payé avant `payrun_at` ; à `payrun_at`, un lot par
  livreur envoie tout ce qui est `succeeded` ; les statements `processing` ou `failed`
  attendent sans bloquer les autres ; les régularisations sont ensuite versées au
  compte-gouttes, pour le seul reliquat (`dû − déjà transféré`), sans jamais rejouer
  un Transfer effectué.
- **Impayé restaurant** : pas de paiement du restaurant = pas de versement du livreur.
  Locadely n'avance rien (`platform_advance` abandonné, testé en SP3 et conservé
  comme connaissance). La dette reste rattachée au restaurant et au livreur ; le
  livreur voit le restaurant débiteur et le montant. Relance et recouvrement Locadely
  = chantier ultérieur ; mise en demeure par le livreur, modalités RGPD/contrat à
  valider avant production.
- **Retour ou litige SEPA après encaissement et paiement du livreur** : Locadely
  assume ; aucun reversal contre le livreur pour une défaillance du restaurant.
- **Reversals** : uniquement B (responsabilité du livreur, après décision motivée et
  approuvée) et C (erreur Locadely). Stripe n'empêche pas une reversal sur un livreur
  déjà payé (solde négatif, puis compensation par les Transfers suivants) : le domaine
  calcule le recouvrable avant l'appel. Compensation sur gains futurs : à valider
  juridiquement avant production.
- **Comptes livreurs** : Account v2 `recipient` (`stripe_balance.stripe_transfers`),
  `dashboard=express`, `fees_collector=application`, `losses_collector=application`
  (seules valeurs acceptées) ; Stripe collecte le KYC. `individual` (dont
  micro-entrepreneur) et `company` (SASU, EURL…) sont tous deux supportés. Compte
  restreint plus tard : aucune nouvelle course, gains dus mais bloqués puis versés à
  la régularisation ; le lot vérifie `stripe_transfers: active` avant chaque Transfer.
- **Frontière de mise en production** : `settlement_settings.go_live_at` immuable ;
  seules les commandes créées à partir de cette date entrent dans une période.
- **Promesse livreur** : paiement sous 15 jours ouvrés après la clôture, sous réserve
  du règlement du restaurant ; mesurée à l'envoi du Transfer.

## Conséquences

- Aucun appel Stripe dans une transaction PostgreSQL ; ligne d'essai committée AVANT
  l'appel ; clé d'idempotence `stmt:<statement_id>:charge:<charge_id>:try:<n>` (même
  clé si le résultat est inconnu, `n+1` après une erreur 4xx définitive) ; reprise par
  recherche Stripe (`transfer_group` hérité de la charge + `metadata.statement_id`).
- Ledger append-only ; les corrections passent par un ajustement approuvé de la période
  suivante ; `unique(order_id)` sur les lignes, un Transfer par statement et par charge.
- Le paiement livreur arrive après le succès SEPA : le pay-run tombe environ au 9ᵉ jour
  ouvré après la clôture, la promesse court jusqu'au 15ᵉ.

## Alternatives rejetées

- Locadely avance les impayés par `platform_advance` : trésorerie et garantie de
  paiement abandonnées (coût, buffer, solde minimum de plateforme).
- Transfer `source_transaction` pendant `processing` : aucun gain de trésorerie pour le
  livreur (fonds disponibles à `available_on`) et un échec tardif débite la plateforme.
- Débit SEPA le lundi : abandonné au profit du mercredi (pré-notification de 2 jours).
