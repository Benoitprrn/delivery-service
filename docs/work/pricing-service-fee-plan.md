# Plan — Correction modèle économique livraison / frais de service (SF)

Statut 2026-09-22 : plan VALIDÉ par l'utilisateur (analyse Claude + analyse Codex indépendante, deux passes, convergentes, aucune contradiction non résolue). Aucun code, aucune migration exécutée. Ce fichier est le seul document de reprise du chantier ; toute nouvelle session (Claude Code ou Codex) doit pouvoir repartir d'ici sans relire de conversation.

Sources : analyse indépendante Claude (lecture directe ADR/migrations/code) + analyse indépendante Codex (task-mud0bxye-wsop41, task-mud277bq-s2d0ne, task-mud35wia-jc1dhj, sessions Codex `01a0ca60-3f6b-7081-ac34-ea7e86084027` / `01a0ca90-29ab-7941-a5a6-4e68f8c42b47` / `01a0caa8-dabc-75b2-a6a8-4377517b948a`), confrontées, aucun désaccord factuel — un seul désaccord de scope (résolu, voir §3 retour).

## Maintenance de ce document (obligatoire)

Ce fichier est la SOURCE DE VÉRITÉ du chantier SF, à partir de maintenant.

- Codex et Claude Code suivent ce plan pendant toute l'implémentation.
- Si une étape change après vérification du code réel, le plan est mis à jour — jamais laissé à décrire une architecture qui n'est plus celle réellement implémentée.
- Si un choix technique diffère de ce qui était prévu ici, la décision est documentée dans ce fichier (raison, à quelle étape, ce qui change).
- Chaque étape SFn du tableau §5 porte son état réel dans la colonne `st` : `todo` | `doing` | `review` | `done` | `blocked`. Une étape partiellement terminée ou bloquée le précise en une ligne sous le tableau (pas seulement `st`), avec la raison.
- Codex peut signaler ce qui doit être mis à jour dans ce plan. **Claude Code reste seul responsable de la mise à jour finale du fichier `.md`.**

Après CHAQUE modification de code significative liée à ce chantier, dans cet ordre :
1. Vérifier si `docs/work/pricing-service-fee-plan.md` doit être mis à jour (état d'une étape, décision technique, architecture réellement implémentée).
2. Mettre à jour le(s) `CLAUDE.md` concerné(s).
3. Seulement ensuite considérer la tranche comme terminée.

## 0. Vérité métier (définitive)

- Modèle actuel (FAUX, à corriger) : `merchant_price = driver_earning`, `fee = driver_earning × 20%` retenu SUR le livreur, `net = driver_earning - fee` transféré au livreur. Restaurant débité = prix livraison seul.
- Modèle cible (VALIDÉ) : `delivery_cents` appartient à 100% au livreur, `service_fee_cents` appartient à 100% à Locadely, ADDITIF (jamais soustrait au livreur), `restaurant_total = delivery_cents + service_fee_cents`.
- Exemple de référence : livraison 6,00€ HT + service 20% = 1,20€ HT → restaurant doit 7,20€ HT → livreur reçoit 6,00€ → Locadely garde 1,20€.
- Le calcul `"6,00 - 1,20 = 4,80 au livreur"` est EXPLICITEMENT FAUX et ne doit plus jamais apparaître dans le code.
- Mécanisme Stripe (Separate Charges and Transfers, `source_transaction`) est déjà correct — seul le montant transporté est faux. Ne pas changer le mécanisme.
- Principe d'intermédiation (Locadely encaisse le total, reverse la part livreur, garde la sienne) : validé métier, non rediscutable dans ce chantier.

## 1. Périmètre

**Dans le périmètre de cette vague :**
- séparation `delivery_cents` / `service_fee_cents`
- frais de service additifs au prix restaurant (jamais soustractifs au livreur)
- livreur payé sur 100% du montant de livraison
- configuration des paramètres tarifaires (collecte, €/km, €/min, taux de service)
- taux de service par défaut 20%, configurable globalement
- schéma prêt pour un futur override du taux par restaurant (pas d'UI admin obligatoire)
- adaptation ledger/settlements R10→R90
- adaptation débit restaurant (R50)
- adaptation Transfer Stripe livreur (R60) vers le plein montant
- vérification reversals/receivables/reconciliation (R61/R70)
- UI web commerçant + app mobile livreur
- tests, fixtures, scripts R90, ADR, documentation

**Hors périmètre (chantiers séparés, ne pas concevoir ni coder ici) :**
- F10 facturation (numérotation, PDF, avoirs)
- TVA opérationnelle
- groupage tarifaire avancé (trajet client1→client2)
- retour (RETURN)
- interface admin complète de gestion des taux
- R91 / mise en Live (`go_live_at`)

## 2. Règles métier à implémenter

### Livraison standard
```
delivery_cents = max(400, pickup_fee_cents + floor(distance_m × km_rate / 1000) + floor(duration_s × min_rate / 60))
```
- `pickup_fee_cents` = 100 (1€/collecte), `km_rate` = 37, `min_rate` = 22 actuellement — DOIVENT devenir des paramètres configurables, pas des littéraux.
- `floor()` par composante distance et par composante durée séparément, jamais sur le total, jamais avant conversion (règle héritée ADR 0002, inchangée).
- Minimum 400 cents appliqué APRÈS somme des composantes, AVANT calcul du service fee.

### Frais de service
```
service_fee_cents = floor(delivery_cents × service_fee_rate_bps / 10_000)
restaurant_total_cents = delivery_cents + service_fee_cents
```
- Calculé sur `delivery_cents` APRÈS application du minimum 400.
- Jamais retiré du montant livreur — additif uniquement.
- Taux par défaut : 2000 bps (20%), configurable globalement.
- Taux effectif = override restaurant (futur, nullable) ?? taux par défaut global.
- Taux effectif RÉSOLU ET FIGÉ sur la commande à sa création — jamais recalculé rétroactivement si le taux change.

### Exemple de vérification obligatoire (test unitaire)
```
calcul brut = 340 cents
delivery_cents final = max(400, 340) = 400
service_fee_cents = floor(400 × 2000 / 10000) = 80
restaurant_total_cents = 480
livreur = 400, Locadely = 80
```

### Affichage prix
- Restaurant voit d'abord le total HT.
- Détail (livraison / frais de service) disponible à la demande, jamais forcé.
- Livreur voit toujours son montant plein (`delivery_cents`), jamais un net après commission.

### Groupage (HORS PÉRIMÈTRE — contraintes à respecter pour ne pas fermer la porte)
- Concerne uniquement plusieurs commandes du MÊME restaurant.
- 1€ de collecte PAR COMMANDE collectée, même prises ensemble (jamais de collecte partagée/répartie — question fermée définitivement).
- Future 2e livraison potentiellement calculée sur trajet client1→client2 au lieu de restaurant→client2.
- Règle du minimum 4€ spécifique au groupage : à définir dans le futur chantier, pas ici.
- Le mécanisme de transition unique verrouillée (§4, étape SF5) est déjà suffisant pour laisser un futur chantier choisir SON moment de calcul — aucun changement de schéma requis pour ça spécifiquement.

### Retour (HORS PÉRIMÈTRE — orientation retenue, contraintes à respecter)
- Un retour sera une COMMANDE DISTINCTE, liée à la commande d'origine (lien à construire dans le futur chantier).
- Commande retour : origine = client, destination = restaurant, collecte = 0, frais de service = 0, tarif = km+temps uniquement, type = `RETURN`.
- Conséquence : PAS besoin de plusieurs lignes de settlement pour un même `order_id` — chaque commande (initiale + retour) garde sa propre ligne. La contrainte actuelle `settlement_lines.order_id UNIQUE` (`supabase/migrations/0030_settlement_core.sql:105`, `unique (id, period_id, driver_id, merchant_id)` + `order_id uuid not null unique`) N'EST DONC PAS un obstacle pour cette orientation — à confirmer au moment de concevoir le retour, mais aucune promesse de zéro-changement de schéma n'est faite ici (voir §3).

## 3. Architecture à préserver (obligatoire dans cette vague)

- Ne PAS supposer structurellement "1 commande = toujours restaurant→client, 1 seule formule". Le montant final `delivery_cents` doit pouvoir être figé quelle que soit l'origine de son calcul (standard, futur groupage, futur retour en tant que commande liée).
- Les paramètres tarifaires utilisés doivent être FIGÉS/VERSIONNÉS sur chaque commande — aucune commande existante n'est jamais recalculée si les paramètres globaux changent plus tard.
- Montant dû au livreur = conceptuellement une somme de composantes de rémunération. Cette vague n'implémente qu'une seule composante (`delivery_cents`). `service_fee_cents` reste indépendant de cette somme et n'est jamais impacté par une future composante additionnelle.
- **Ne pas promettre** que le futur chantier retour ou groupage se fera sans AUCUN changement de schéma/code — c'est faux et vérifié faux (voir preuves ci-dessous). Documenter seulement que le design actuel ne les empêche pas.
- Preuve vérifiée (Codex, task-mud35wia-jc1dhj) que certains éléments DEVRONT changer pour un futur `driver_due` multi-composantes (à ne PAS construire maintenant, juste à savoir) :
  - `settlement_lines` : formules `fee_cents`/`net_cents` actuelles référencent une seule colonne `driver_earning_cents` (`0030_settlement_core.sql:109-114`)
  - `guard_settlement_line` ne lit/fige que `price_cents`/`driver_earning_cents` (`0030_settlement_core.sql:127-131`)
  - l'assertion différée du ledger somme `driver_earning_cents` seul (`0030_settlement_core.sql:141-147`)
  - `settlement_statements.due_cents = gross_cents - fee_cents` (CHECK, `0030_settlement_core.sql:79`) devra être revu pour la nouvelle sémantique additive
  - `period-ledger.ts`/`fees.ts` : types et accumulation actuels ne portent qu'un seul `driverEarningCents`
- Ce qui reste déjà assez générique pour ne PAS changer : le mécanisme de trigger différé (indifférent à la formule, valide des totaux en fin de transaction), et le pattern « transition unique verrouillée » de `0034_order_pricing_immutability.sql` (indifférent au moment où la transition se produit — réutilisable tel quel pour `delivery_cents`/`service_fee_cents`).

## 4. État actuel vérifié (faits, avec citations — base de départ pour l'implémentation)

- ~~`orders.price_cents` = colonne SQL **générée**~~ **CORRIGÉ par SF4 (2026-09-22)** : n'est plus une colonne générée. Calculée et figée une seule fois à l'insertion par le trigger `public.compute_order_price_cents()` (`supabase/migrations/0042_order_pricing_model.sql`), qui lit `pricing_settings` (version la plus récente) au lieu de littéraux en dur. Formule elle-même inchangée (même sortie qu'avant, vérifié : 3000m/720s → 475, cas ADR 0002). La duplication TypeScript dans `apps/api/src/modules/pricing/domain/compute-price-cents.ts:5-10` reste en l'état (littéraux 37/22/100/400) — pas encore branchée sur `pricing_settings` côté application, prévu SF5.
- `orders.driver_earning_cents` forcé égal à `price_cents` : backfill `0010_driver_earnings.sql`, écriture applicative `apps/api/src/modules/orders/infrastructure/postgres-order-repository.ts:374` (`update orders set driver_earning_cents = $1` juste après l'insert, même requête — citation corrigée, précédemment `:336` par erreur), verrouillé par `supabase/migrations/0034_order_pricing_immutability.sql`, étendu par `0042_order_pricing_model.sql` (trigger `before update`, transition unique autorisée `old=0 → new=old.price_cents`, indifférent au moment où elle se produit ; même régime désormais appliqué à `delivery_cents`/`service_fee_cents`, transition `NULL → valeur`).
- `orders.pricing_settings` : nouvelle table append-only versionnée (`supabase/migrations/0040_pricing_settings.sql`), seedée avec les valeurs actuelles en `rule_version=1` (`rule_version=3` sur la base de dev après une correction d'une insertion de test involontaire le 2026-09-22 — voir note SF4 ci-dessous, valeurs identiques à `rule_version=1`). `merchants.service_fee_rate_bps_override` (`0041_merchant_service_fee_override.sql`) : colonne nullable, non résolue par l'application à ce stade.
- `orders.delivery_cents` / `orders.service_fee_cents` / `orders.pricing_rule_version` : nouvelles colonnes (`0042_order_pricing_model.sql`), `delivery_cents`/`service_fee_cents` NULL pour toute commande tant que SF5 ne les alimente pas ; `pricing_rule_version` alimenté dès maintenant par le trigger.
- `merchants` (`0001_init.sql:12-20`) n'a AUCUNE colonne tarifaire aujourd'hui (`id, name, zone_id, lat, lng, created_at`). Le seul `fee_rate` existant dans tout le dépôt est le singleton global `settlement_settings.fee_rate_bps` (`0030_settlement_core.sql:1-10`), utilisé aujourd'hui pour le mauvais calcul (commission soustraite au livreur).
- `settlements/domain/fees.ts:8-13` : `feeCents = floor(earningCents × feeRateBps / 10000)`, `netCents = earningCents - feeCents` — logique SOUSTRACTIVE à inverser.
- `settlements/domain/period-ledger.ts:65-90` : lit `order.merchantPriceCents`/`order.driverEarningCents` (même valeur), appelle `computeLineFee`, accumule `netCents` dans `dueCents`.
- `settlement_lines`/`settlement_statements`/`merchant_settlements` (`0030_settlement_core.sql:60-180`) : CHECK constraints encodent en dur la formule actuelle (`fee_cents = driver_earning_cents * fee_rate_bps / 10000`, `due_cents = gross_cents - fee_cents`), append-only, triggers différés de cohérence des totaux.
- Transfer Stripe livreur : montant = `statement.dueCents` (net), `apps/api/src/modules/settlements/infrastructure/stripe-driver-transfer-provider.ts:12-21` (`source_transaction` = charge SEPA restaurant — mécanisme correct, montant faux). Source dans `run-driver-payouts.ts`.
- `merchant_settlements.amount_cents` = Σ `merchant_amount_cents` = Σ prix livraison seul (`0030_settlement_core.sql:60-67`, trigger `assert_merchant_settlement_ledger`). C'est ce montant qui est débité par SEPA (R50, `run-sepa-debits.ts`).
- `current-week-estimate.ts:19` reproduit indépendamment le même calcul soustractif pour l'estimation livreur de la semaine en cours — à corriger en même temps que `fees.ts`.
- Dispatch : `GROUPAGE_WINDOW_MINUTES = 30` (`orders/domain/dispatch.ts:1`), priorise un livreur ayant déjà une course active du MÊME restaurant (`dispatch/application/start-dispatch.ts:43`, filtré par `merchantId`). Ne touche jamais au prix — le prix est calculé une seule fois à la création, avant tout dispatch (`orders/application/create-order.ts`, `estimate-order.ts`).
- Retour : `orders/application/return-order.ts` ne fait que transitionner le statut, aucun calcul de prix, aucune colonne de distance/durée de retour n'existe sur `orders`. `guard_settlement_line` relit le même `price_cents`/`driver_earning_cents` pour `COMPLETED` et `RETURNED` — confirmé aucune tarification dédiée aujourd'hui.
- Incohérence UI préexistante (indépendante de ce chantier, à corriger au passage à l'étape SF11) : écran mobile gains vs wallet affichent des montants différents (brut vs net) pour la même donnée ; `apps/web/lib/orders.ts:110-113` masque le prix pour `RETURNED` alors que le règlement le facture bien.
- Fichiers additionnels identifiés (Codex) exposant `priceCents` comme figure unique côté commerçant/livreur : `apps/web/components/order-modal.tsx:133-143`, `apps/web/components/price-card.tsx:41-44`, `apps/api/src/modules/notifications/application/send-new-order-pushes.ts:16`, `apps/mobile/app/order/[id]/index.tsx:292`.

## 5. Étapes (ordre d'exécution)

Numérotation `SF` (Service Fee), indépendante de `R` (règlement livreurs) et `F` (facturation future). Statut initial de toutes les étapes : `todo`.

| # | Étape | Responsable | Fichiers/modules principaux | st |
|---|---|---|---|---|
| SF1 | ADR : amender 0002 et 0004, retirer "merchant_price=driver_earning" et "fee=20% du gain livreur", documenter le modèle additif + formulation §3 sur les promesses retour/groupage | Claude Code | `docs/adr/0005-delivery-service-fee-model.md` (nouveau), `docs/adr/0002-pricing-formula.md`, `docs/adr/0004-driver-settlement.md` (amendés) | done |
| SF2 | Table de réglages tarifaires configurables (collecte, €/km, €/min, minimum, taux service par défaut), append-only versionnée | Claude Code (SQL) | `supabase/migrations/0040_pricing_settings.sql` | done |
| SF3 | Schéma d'override futur du taux par restaurant (colonne nullable), PAS de résolution applicative ni d'UI admin cette vague | Claude Code (SQL) | `supabase/migrations/0041_merchant_service_fee_override.sql` | done |
| SF4 | Sortir `orders.price_cents` du mécanisme de colonne générée, le brancher sur `pricing_settings` (décision : fait dès SF4, pas différé à SF5 — voir note sous le tableau), ajouter `delivery_cents`/`service_fee_cents`/`pricing_rule_version` (non alimentées), étendre l'immuabilité `0034` | Claude Code (SQL) | `supabase/migrations/0042_order_pricing_model.sql` | done |
| SF5 | Calcul applicatif figé de `delivery_cents` + `service_fee_cents` à la création de commande, écrit une fois | Codex (backend) puis revue Claude Code | voir détail sous le tableau | done |
| SF6 | Réécriture formules ledger/settlements : lignes copient `delivery_cents`+`service_fee_cents` figés (jamais recalculés), `due_cents` = somme des livraisons du livreur, `merchant_settlements.amount_cents = driver_amount_cents + service_fee_cents` | Claude Code (SQL) puis Codex (backend) puis revue Claude Code | voir détail sous le tableau | done |
| SF7 | Débit restaurant (R50) : vérification que le débit reste correct sous le nouveau modèle additif | Claude Code (revue, aucun code modifié) | `run-sepa-debits.ts`, `stripe-sepa-debit-provider.ts`, `postgres-sepa-debit-repository.ts`, `resend-email-sender.ts`/`pre-notification.ts` (R41) | done |
| SF8 | Transfer Stripe livreur : vérification que le montant reste correct (plein `delivery_cents`, hérité de `due_cents` depuis SF6) sous le nouveau modèle | Claude Code (revue, aucun code modifié) | `run-driver-payouts.ts`, `payout-decision.ts`, `postgres-driver-payout-repository.ts`, `stripe-driver-transfer-provider.ts`, reversals (`reversal-decision.ts`, `postgres-driver-reversal-repository.ts`) | done |
| SF9 | Reversals/receivables/reconciliation : vérification que tout reste correct sous le modèle additif, sans élargir le périmètre des reversals | Claude Code (revue, aucun code modifié) | `reversal-decision.ts`, `charge-incident.ts`, `reconciliation.ts`, `postgres-debit-ops-repository.ts`, `postgres-reconciliation-repository.ts` | done |
| SF10 | UI web commerçant : total HT en premier, détail livraison/service à la demande | Claude Code | voir détail sous le tableau | done |
| SF11 | UI app mobile livreur : montant plein affiché, jamais net après commission ; corriger l'incohérence gains vs wallet (§4) | Codex (mobile) | `apps/mobile/lib/settlements-types.ts`, `apps/mobile/lib/earnings.ts`, `apps/mobile/components/earning-row.tsx`, `apps/mobile/app/(tabs)/compte/*`, `apps/mobile/app/order/[id]/index.tsx` | done |
| SF12 | Fixtures/scripts/tests R90 encore sur l'ancien modèle soustractif — corriger uniquement les valeurs/requêtes cassées par le schéma additif | Claude Code (SQL/scripts, rien à corriger côté Codex — `apps/api/test/` déjà propre) | `docs/work/r90/world.mts`, `run4-world.mts`, `week2-dispute-after-payment.mts`, `week1-close.mts` | done |
| SF13 | Clôture : relecture complète SF1-SF12, vérification code↔plan↔docs, aucune logique soustractive résiduelle, aucun nouveau scope | Claude Code | `CLAUDE.md`, `apps/api/CLAUDE.md`, `docs/adr/0004-driver-settlement.md` | done |

Ne pas suivre cet ordre aveuglément si l'état réel du dépôt au moment de l'implémentation impose une dépendance différente — SF4/SF5 sont un préalable dur à SF6+, SF2/SF3 sont un préalable dur à SF5, le reste peut se paralléliser partiellement selon le workflow §7.

**SF1-SF4 : terminé le 2026-09-22 (Claude Code, SQL/ADR uniquement — aucun backend TypeScript nécessaire pour cette tranche, donc Codex non engagé).**

Décisions techniques prises pendant SF4, différentes de ce qui était juste esquissé dans le plan initial :
- `orders.price_cents` est branché sur `pricing_settings` DÈS SF4 (trigger `before insert`), pas laissé en littéraux en dur en attendant SF5. Raison : c'est justement ce qui motivait de sortir du mode "colonne générée" — autant le faire en une fois. `delivery_cents`/`service_fee_cents` restent NULL et non alimentées, conformément au périmètre (calcul applicatif = SF5).
- `pricing_settings` conçue append-only et versionnée (comme suggéré, pas juste un singleton mutable façon `settlement_settings`) : changer un tarif = insérer une nouvelle `rule_version`, jamais modifier une ligne existante. Chaque commande fige la version active au moment de sa création via `orders.pricing_rule_version`.
- `merchants.service_fee_rate_bps_override` : colonne simple, pas de table séparée (inutile pour une relation 1:1 scalaire).

Vérifications effectuées avant de clore la tranche (base de dev locale, `127.0.0.1:54322`) :
- 3 migrations appliquées sans erreur (`npx supabase migration up --local`).
- Insertion d'une commande de test (merchant `22222222-...`, 3000m/720s) → `price_cents=475`, conforme à l'exemple ADR 0002 ; `delivery_cents`/`service_fee_cents` bien NULL.
- Immuabilité vérifiée sur `price_cents`, `pricing_rule_version`, `driver_earning_cents` (transition unique), `delivery_cents`/`service_fee_cents` (transition unique NULL→valeur), `distance_m` — chaque tentative illégale lève l'exception attendue.
- `pricing_settings` : `UPDATE`/`DELETE` refusés (append-only confirmé), `INSERT` d'une nouvelle version accepté.
- `merchants.service_fee_rate_bps_override` : contrainte 0-10000 bps vérifiée (valeur 20000 refusée).
- Suites existantes non régressées : `pricing.integration.test.ts`, `driver-earnings.integration.test.ts`, `order-lifecycle.test.ts` → 20/20 tests passés après application des migrations.
- Commande(s) de test supprimée(s) après vérification (règle mémoire de nettoyage).

**Incident mineur corrigé pendant SF4** : une tentative de nettoyage d'une ligne de test insérée par erreur dans `pricing_settings` (table volontairement append-only) a échoué comme prévu par le trigger — la ligne (`rule_version=2`, `km_rate_cents=40` erroné) est restée en base et serait devenue la règle « active » pour toute nouvelle commande. Corrigé en une opération : insertion d'une ligne correctrice `rule_version=3` restaurant les valeurs exactes de `rule_version=1` (100/37/22/400/2000). Aucun trigger désactivé, aucune donnée réécrite — la base de dev contient donc `rule_version` 1, 2 (test, valeurs fausses, jamais active) et 3 (active, valeurs correctes) ; comportement final vérifié correct (nouvelle commande de test → `price_cents=475`, `pricing_rule_version=3`). Aucun impact sur des commandes réelles (fenêtre de quelques secondes, aucune commande créée entre-temps).

**SF5 : terminé le 2026-09-22.** Backend implémenté par Codex, relu et vérifié par Claude Code. Aucun fichier SQL/migration/web/mobile/settlements touché (conforme au périmètre).

Fichiers créés/modifiés par Codex (backend uniquement) :
- `apps/api/src/modules/pricing/ports/pricing-settings-reader.ts` (nouveau) — port `findActive()` / `findByRuleVersion(ruleVersion)`.
- `apps/api/src/modules/pricing/infrastructure/postgres-pricing-settings-reader.ts` (nouveau) — implémentation SQL, `findActive` = `order by rule_version desc limit 1` (vérifié correct).
- `apps/api/src/modules/pricing/domain/compute-price-cents.ts` — accepte désormais des `PricingSettings` en paramètre (défaut de compatibilité conservé pour les appelants non migrés) ; ajout de `computeServiceFeeCents(deliveryCents, rateBps)`.
- `apps/api/src/modules/pricing/public.ts` — exporte le nouveau port/types + `createPricingSettingsReader(pool)`.
- `apps/api/src/modules/merchants/domain/merchant.ts` + `infrastructure/postgres-merchant-repository.ts` — `serviceFeeRateBpsOverride` lu et exposé sur `Merchant`.
- `apps/api/src/modules/orders/application/create-order.ts` — passe `merchant.serviceFeeRateBpsOverride` au repository (`merchantServiceFeeRateBpsOverride`).
- `apps/api/src/modules/orders/application/estimate-order.ts` — retourne désormais `deliveryCents`/`serviceFeeCents` en plus de `priceCents` (conservé, `priceCents === deliveryCents`), en lisant la règle active + l'override marchand.
- `apps/api/src/modules/orders/infrastructure/postgres-order-repository.ts` — après l'insert, lit `row.pricing_rule_version` (jamais une règle "active" fraîche), résout le taux via `findByRuleVersion`, puis UNE `UPDATE` fige `driver_earning_cents`, `delivery_cents` (= `price_cents`) et `service_fee_cents` ensemble.
- `apps/api/src/modules/orders/ports/order-repository.ts`, `orders/public.ts` — types/wiring (`createOrdersModule` construit et injecte `PostgresPricingSettingsReader` lui-même ; **aucune modification d'`app.ts` nécessaire**).
- Tests ajoutés : `test/pricing/compute-price-cents.test.ts`, `test/pricing/pricing.integration.test.ts` (étendu), `test/orders/create-order.test.ts`, `test/orders/estimate-order.test.ts`.

Vérifications effectuées par Claude Code (revue + exécution réelle, Codex n'a pas pu atteindre Postgres dans son bac à sable) :
- Relecture complète de tous les fichiers listés ci-dessus, ligne par ligne.
- Confirmé : sélection `pricing_settings` toujours par `rule_version` maximal (jamais figée en dur), y compris avec la ligne de test `rule_version=2` (valeurs fausses) toujours présente en base — testé et vérifié correct.
- Confirmé : le taux de service utilisé à la création vient de la règle FIGÉE sur la commande (`findByRuleVersion(row.pricing_rule_version)`), jamais d'une nouvelle résolution "active" — protège contre un changement de tarif entre l'insert et le calcul du service fee.
- Confirmé : `driver_earning_cents = delivery_cents = price_cents` toujours vrai pour une commande standard (aucune soustraction nulle part) ; `service_fee_cents` toujours additif.
- `npm run typecheck -w apps/api` : propre. `npm run check:boundaries` : aucune violation (frontières `public.ts` respectées, orders ne lit jamais `merchants` directement).
- Tests ciblés SF5 exécutés pour de vrai (dev DB) : `pricing/`, `orders/create-order.test.ts`, `orders/estimate-order.test.ts`, `orders/driver-earnings.integration.test.ts`, `orders/order-lifecycle.test.ts` → **34/34 passés**, incluant les 3 cas d'intégration réels (600/120/720 ; 400/80/480 minimum ; 600/150/750 override restaurant) et le nettoyage automatique des commandes de test (`deleteTestOrders`).
- Suite complète `apps/api` exécutée : **850 passés / 5 échecs**. Les 5 échecs (`cod-reconciliation.integration.test.ts`, `postgres-repositories.integration.test.ts` [COD/Connect cache], `merchants.http.test.ts`) sont dans des fichiers **jamais touchés par SF1-5** (aucun rapport avec pricing/orders/merchants-override). Cause probable, non liée à ce chantier : un serveur de dev live (`tsx watch src/server.ts`, en cours d'exécution sur la même base pendant les tests) fait courir ses workers en parallèle des tests d'intégration (race de claim probable sur le cas COD) ; le cas `merchants.http.test.ts` attend un merchant nommé "Restaurant Le Terminus" mais reçoit les données du merchant `22222222-...` ("American Wings") — dérive de données de seed préexistante dans la base de dev partagée, antérieure à ce chantier. Non corrigé (hors périmètre SF5) ; à signaler séparément.

## 5bis. Tests minimaux requis (liste fermée — pas de couverture exhaustive)

Objectif : sécuriser uniquement ce que cette vague modifie ou pourrait casser de façon critique. PAS de couverture exhaustive des incidents/cas limites R10→R90 déjà couverts par les suites existantes (celles-ci restent en place, on ne les étend pas ici sauf si un cas ci-dessous les touche directement).

| # | Cas à tester | Vérifie | Responsable |
|---|---|---|---|
| T1 | Pricing standard, cas au-dessus du minimum (ex. 3000m/720s comme ADR 0002) | `delivery_cents` correct, formule collecte+km+temps inchangée | Codex (unit) |
| T2 | Pricing avec minimum à 4€ (ex. calcul brut 340 cents → 400) | Le plancher s'applique avant le calcul du service fee, jamais après | Codex (unit) |
| T3 | Frais de service 20% ajoutés au prix de livraison (ex. 400 → service 80) | `service_fee_cents = floor(delivery_cents × taux / 10000)`, ADDITIF | Codex (unit) |
| T4 | Restaurant doit `delivery + service` | `merchant_settlements.amount_cents = delivery_cents + service_fee_cents` au débit SEPA | Claude Code (intégration DB) |
| T5 | Livreur reçoit 100% de `delivery` | Montant du Transfer Stripe = `delivery_cents` plein, jamais net d'une soustraction | Codex (intégration backend) |
| T6 | `service` appartient à Locadely | Aucun mouvement d'argent ne transfère `service_fee_cents` au livreur ; reste sur le compte plateforme après le Transfer | Codex (intégration backend) |
| T7 | Immutabilité des montants figés | Un `UPDATE`/`DELETE` sur une ligne de règlement déjà écrite échoue (trigger append-only), `delivery_cents`/`service_fee_cents` verrouillés après leur transition unique sur `orders` | Claude Code (SQL/intégration DB, base isolée) |
| T8 | Scénario Stripe Sandbox complet : débit restaurant réussi puis Transfer livreur | Chaîne bout en bout produit les bons montants (delivery au livreur, service retenu) sur un vrai appel Stripe Sandbox | Codex (intégration backend, Stripe simulé/Sandbox selon convention existante des suites `*.integration.test.ts`) |
| T9 | Retry simple ne crée pas de double débit ni double Transfer | Rejouer la même opération (même clé d'idempotence) ne produit pas de second mouvement d'argent | Codex (intégration backend) |
| T10 | Aucun Transfer livreur avant paiement restaurant réussi | Un Transfer tenté sans débit `succeeded` correspondant est refusé (garde déjà existante — vérifier qu'elle tient toujours avec les nouveaux montants) | Claude Code (SQL/intégration DB) |

Règles d'exécution : mêmes conventions que l'existant — bases isolées (`settlements_r10`/`payments_test`/équivalent selon D-R), jamais la base de dev partagée, jamais de garde PostgreSQL affaiblie ou désactivée pour faire passer un test. Claude Code relit systématiquement les tests écrits par Codex (T1, T2, T3, T5, T6, T8, T9) avant de les considérer acquis.

**SF6 : terminé le 2026-09-22.** Périmètre : bascule du ledger R10→R40 du modèle soustractif au modèle additif. SEPA (R50), Transfer Stripe (R60), reversals/reconciliation (R61/R70) : contrats de colonnes inchangés, non touchés (revue dédiée SF7/SF8/SF9).

**SQL (Claude Code)** : `supabase/migrations/0043_settlement_ledger_additive_model.sql`. `settlement_lines` : retire `driver_earning_cents`/`fee_cents`/`fee_rate_bps`/`net_cents`, renomme `fee_rule_version`→`pricing_rule_version`, ajoute `delivery_cents`/`service_fee_cents`, `merchant_amount_cents` redevient une colonne GÉNÉRÉE (`delivery_cents + service_fee_cents`, jamais insérée directement — même régime que `orders.price_cents`). `settlement_statements` : retire `gross_cents`/`fee_cents`, `due_cents` devient le plein montant dû (`>= 0` seul, plus de dérivation `gross-fee`). `merchant_settlements` : ajoute `driver_amount_cents`/`service_fee_cents`, CHECK `amount_cents = driver_amount_cents + service_fee_cents`. Triggers réécrits : `guard_settlement_line` (compare désormais `orders.delivery_cents`/`service_fee_cents`/`pricing_rule_version`, refuse explicitement toute commande sans ces montants figés — pré-SF5, ne devrait jamais arriver en pratique), `guard_settlement_statement` (immuabilité sans `gross_cents`/`fee_cents`), `assert_settlement_ledger_values`/`assert_merchant_settlement_ledger` (vérifient la somme des composantes). Tables vides sur toute base réelle (`go_live_at` jamais posé) : aucune migration de données historiques.

**Vérification SQL avant handoff à Codex** (base jetable `sf6_ledger_test`, fresh install des 43 migrations, droppée après usage) : exemple 600/120 → merchant 720/driver 600/service 120 conforme ; agrégation 2 commandes (600+400/120+80) → statement due=1000, règlement 1200/1000/200 conforme ; rejets confirmés (valeur fausse type ancien calcul 480, ligne ne correspondant pas à la commande, commande sans montants SF5) ; immuabilité confirmée (`UPDATE`/`DELETE` refusés sur lignes ET statements). **Un bug trouvé et corrigé avant handoff** : `guard_settlement_statement` référençait encore `gross_cents`/`fee_cents` supprimées — corrigé dans le fichier de migration avant toute remise à Codex.

**Backend (Codex)** : `settlements/domain/fees.ts` supprimé (plus rien à calculer à la clôture — le taux est déjà appliqué une fois pour toutes à la création, SF5). `period-ledger.ts` réécrit : `buildPeriodLedger` ne prend plus de taux, copie/agrège `deliveryCents`/`serviceFeeCents`/`pricingRuleVersion`. `ports/settlement-close.ts` : `SettlementSettings`/`ClosePeriodInput` n'exposent plus `feeRateBps`/`feeRuleVersion` (colonnes SQL laissées en base, inutilisées, pas supprimées — décision délibérée pour limiter le risque). `postgres-settlement-close-repository.ts` : INSERT réécrits pour les 3 tables, `merchant_amount_cents` jamais inséré (généré). `orders/domain/settleable-order.ts` + `listSettleableOrders` : exposent `deliveryCents`/`serviceFeeCents`/`pricingRuleVersion` au lieu de `driverEarningCents`/`merchantPriceCents`. `current-week-estimate.ts` : `estimatedNetCents` (nom de champ API conservé) devient la somme des `deliveryCents`, sans soustraction.

**Revue et corrections Claude Code** : relecture complète de tous les fichiers backend, cohérence confirmée avec le schéma SQL réel (pas seulement avec la description du plan). `typecheck`/`lint`/`check:boundaries` propres. Suite ciblée exécutée pour de vrai sur `settlements_r10` (base isolée, `docs/work/r10-testdb.sh reset`) : **2 bugs de fixture trouvés et corrigés par Claude Code** dans `settlement-schema.integration.test.ts` (paramétrage SQL incorrect passant une expression `now() - interval...` comme valeur littérale au lieu d'un timestamp calculé ; colonne `driver_earning_cents` omise d'un INSERT malgré sa contrainte `NOT NULL`) — bugs mécaniques dans les tests, pas des erreurs de logique métier. **10 échecs supplémentaires trouvés** dans 4 suites hors périmètre direct de Codex (R60/R61/R70/R80 : `settlement-ops`, `driver-reversals`, `settlement-read.integration`, `driver-payouts`) — valeurs attendues codées en dur sous l'ancien modèle soustractif, cassées par la correction légitime du calcul réel. Renvoyées à Codex (reprise de session) qui a recalculé et corrigé les 10 valeurs (aucune logique de production touchée). Suite finale `settlements/`+`orders/` sur base isolée : **409/409 passés**. Suite complète `apps/api` (dev DB) : échecs restants confinés à `cash-on-delivery`/`payments`/`http/merchants` — confirmés à nouveau pré-existants et non liés à SF6 (voir note SF5 ; ensemble variable d'une exécution à l'autre, jamais dans `settlements`/`orders`/`pricing`).

**SF7 : terminé le 2026-09-22, AUCUN CODE MODIFIÉ.** Vérification (Claude Code) que le débit SEPA restaurant (R50) reste correct sous le nouveau modèle additif — retracé le flux réel de la valeur, pas seulement relu la description du plan :
- `postgres-sepa-debit-repository.ts:61` : `debit_attempts.amount_cents` copié directement de `ms.amount_cents` (`merchant_settlements.amount_cents`) — colonne inchangée de nom, correcte depuis SF6 (`driver_amount_cents + service_fee_cents`).
- `stripe-sepa-debit-provider.ts` : `PaymentIntent.amount = input.amountCents` — aucune transformation, aucune application_fee/transfer_data (Separate Charges and Transfers inchangé, l'argent reste sur la plateforme).
- `resend-email-sender.ts`/`pre-notification.ts` (R41) : le contenu de l'e-mail affiche « Montant prélevé : X € » de façon neutre — jamais présenté comme "le prix de la livraison", aucun changement de libellé nécessaire.
- Preuve par un test déjà vert (confirmé pendant la revue SF6) : `sepa-debit.integration.test.ts:118,121` — `expect(call.amountCents).toBe(settlement.amount)` et `[[merchant1, 1660], [merchant2, 481]]`, des totaux additifs réels (ex. merchant1 = 475+95 + 909+181 = 1660), débités tels quels.

**SF8 : terminé le 2026-09-22, AUCUN CODE MODIFIÉ.** Vérification (Claude Code) que le Transfer Stripe livreur (R60) et les reversals (R61) restent corrects sous le modèle additif :
- `payout-decision.ts` (`decideStatementPayout`) : `amountCents = min(remaining, chargeAmountCents - alreadyTransferredFromChargeCents)` où `remaining = dueCents - paidCents` — aucun calcul de taux, aucune soustraction d'un frais de service ; `dueCents` vient de `settlement_statements.due_cents`, plein montant livreur depuis SF6.
- `postgres-driver-payout-repository.ts:64,87-88` : `dueCents`/`paidCents` lus directement de `st.due_cents`/`st.paid_cents` — colonnes inchangées, correctes depuis SF6.
- `stripe-driver-transfer-provider.ts` : `source_transaction` inchangé, montant transmis tel quel.
- `grep` exhaustif de `net_cents`/`fee_cents`/`gross_cents`/`driver_earning_cents` dans R60 (`run-driver-payouts.ts`, `payout-decision.ts`, `postgres-driver-payout-repository.ts`, `stripe-driver-transfer-provider.ts`, `driver-payout.ts`, `ports/driver-payout.ts`) et R61 (`reversal.ts`, `reversal-decision.ts`, `postgres-driver-reversal-repository.ts`, `stripe-driver-reversal-provider.ts`) : **zéro résultat** — aucun reste de l'ancien modèle.
- `Σ Transfers ≤ charge capturée` (migration `0031`, `guard_driver_transfer`) : ne référence que `due_cents` — inchangé, vérifié dans le fichier de migration. Mécanisme intéressant confirmé : la charge Stripe capturée vaut désormais 1200 (le total additif) mais seul `due_cents`=1000 est transférable — les 200 de service restent structurellement sur la plateforme, sans code dédié pour les y garder.
- Reversals (R61) : raisonnent uniquement sur le solde du Transfer déjà envoyé côté Stripe (`transfer.amountCents`), jamais sur sa composition — aucun changement de comportement possible ni nécessaire.
- Tests ciblés réexécutés pour de vrai (base isolée `settlements_r10`) : `driver-payouts.integration.test.ts` + `driver-reversals.integration.test.ts` → **14/14 passés**, y compris le cas "1 driver × 10 restaurants" qui transfère 475 (plein montant) par statement.

SF7 et SF8 n'existaient que parce que R50 et R60 dépendaient déjà — par construction dès SF4/SF6 — de colonnes uniques (`amount_cents`, `due_cents`) dont la correction est entièrement héritée : c'est la preuve que le découpage en étapes a limité le risque comme prévu.

**SF9 : terminé le 2026-09-22, AUCUN CODE MODIFIÉ.** Vérification (Claude Code) que reversals (R61), receivables et réconciliation (R70) restent corrects sous le modèle additif :
- `charge-incident.ts` (`assessChargeIncidents`) : `restaurantOwedCents` plafonné à `chargeAmountCents` — la charge SEPA capturée dans son intégralité (désormais 1200, le total additif), jamais une part isolée. C'est correct : un litige/remboursement porte sur le prélèvement du RESTAURANT dans son ensemble, pas sur une décomposition livraison/service.
- `postgres-debit-ops-repository.ts` (`upsertIncident`) : `merchant_receivables.amount_cents = incident.amountCents` (montant réel du litige/remboursement Stripe) — créance explicitement documentée comme « jamais une reversal livreur » (commentaire déjà présent dans le code). Ne touche jamais `service_fee_cents` ni les Transfers livreur.
- `reconciliation.ts` (`compareDebitAttempt`/`compareTransfer`) : compare uniquement `amountCents` DB ↔ Stripe, montant à montant, sans aucun calcul de taux ni de décomposition.
- « Encaissement = transfert livreur + part Locadely » : garanti à la couche la PLUS FORTE possible — le `CHECK amount_cents = driver_amount_cents + service_fee_cents` (migration `0043`) rend cette identité impossible à violer en base ; R70 vérifie en plus que le montant débité et le montant transféré correspondent chacun à ce que Stripe a réellement fait. Les deux garanties combinées donnent transitivement la même identité côté Stripe.
- Catégories de reversal (B `driver_fault` / C `locadely_error` uniquement) : `validateReversalRequest` inchangé, aucun motif lié à `service_fee_cents` ou à une réclamation restaurant n'existe dans la liste énumérée — **aucune règle métier ajoutée**, conforme à la consigne.
- Grep exhaustif module entier (`net_cents`/`fee_cents`/`gross_cents`/`driver_earning_cents`/`merchant_price_cents`) : uniquement des colonnes légitimes du nouveau modèle (`service_fee_cents`, `driver_amount_cents`) ou l'usage toujours correct de `driver_earning_cents` sur `orders` (backfill de `delivery_cents`, inchangé depuis SF5) — aucun reste de logique soustractive.
- Test ciblé réexécuté pour de vrai (base isolée) : `settlement-ops.integration.test.ts` (R70, litiges/remboursements/réconciliation) → **9/9 passés**.

## 5ter. SF9.5 — remboursement service Locadely proportionnel (analyse, pas encore construit)

Chantier séparé exploré après SF9, sur demande explicite : étendre les reversals `driver_fault` pour que Locadely rembourse
proportionnellement son frais de service au restaurant quand une part de la livraison est reversée. Analyse Claude + Codex
indépendantes (convergentes, aucune contradiction) : voir conversation. Résumé retenu :

- **Comportement actuel** : un reversal `driver_fault` (`stripe.transfers.createReversal`) ramène l'argent du livreur vers le
  solde PLATEFORME, jamais vers le restaurant. Aucun `refunds.create` n'existe nulle part dans le dépôt (grep exhaustif à
  blanc) — le restaurant ne reçoit aujourd'hui rien automatiquement.
- **Option retenue** : objet/workflow séparé (nouvelle table liée 1:1 à un `driver_transfer_reversal` `succeeded`), jamais une
  extension de `driver_transfer_reversals` ni un détournement de `merchant_receivables`/`debit_incidents` (sémantiquement une
  dette DU restaurant, jamais l'inverse).
- **Formule retenue** (cumulative, pour éviter la dérive d'arrondi sur plusieurs reversals partiels du même ordre) :
  `nouveau_remboursement = floor((récupéré_précédent + récupéré_actuel) × service_fee / delivery) − floor(récupéré_précédent × service_fee / delivery)`.
- **Périmètre** : `driver_fault` uniquement, jamais `locadely_error` (distinction B/C de l'ADR 0004 — une erreur Locadely ne dit
  rien sur la qualité de la livraison reçue par le restaurant).
- **Question ouverte non résolue par le code** : un reversal `fraud`/`other_validated_decision` peut ne porter sur aucune
  commande précise (`order_id` nullable) — aucune proportion calculable sans décision métier complémentaire.

### Vérification Stripe Sandbox (2026-09-23, Claude Code) — AVANT toute implémentation

Objectif : valider le comportement réel d'un remboursement partiel sur une charge finançant plusieurs Transfers vers
plusieurs comptes connectés (Separate Charges and Transfers). Scénario exécuté avec des scripts Node/Stripe SDK jetables,
**jamais commités** (supprimés après usage, comme les essais Stripe Sandbox précédents du projet) : aucun fichier Locadely
modifié.

**Scénario** : PaymentIntent plateforme 1200¢ (carte test, succeeded) → deux Transfers `source_transaction` sur la même
charge, vers deux comptes connectés distincts (700¢ → compte A, 300¢ → compte B, laissant 200¢ non transférés — l'équivalent
du frais de service) → deux `refunds.create` successifs sur la charge d'origine (150¢ puis 100¢, total 250¢ — **dépassant
volontairement** les 200¢ théoriquement non transférés) → relecture de tout.

**Observations réelles, chacune vérifiée par appel API réel (pas une supposition documentaire)** :

| Question | Résultat observé |
|---|---|
| Les Transfers existants restent-ils inchangés ? | **Oui.** `amount_reversed: 0`, `reversed: false` sur les deux Transfers, avant ET après les deux remboursements. |
| Les soldes des comptes connectés restent-ils inchangés ? | **Oui.** `pending` du compte A et du compte B strictement identiques avant/après (vérifié par lecture directe du solde Stripe des deux comptes). |
| Quel solde est débité ? | **Le solde PLATEFORME uniquement.** `pending` plateforme diminue exactement du montant total remboursé (−250), les comptes livreurs à zéro impact. |
| Le refund peut-il réussir malgré des Transfers déjà réalisés ? | **Oui, sans restriction liée aux Transfers.** Le second remboursement (100¢) a réussi alors que le total remboursé (250¢) dépassait largement ce qui restait « non transféré » sur la charge (200¢) — Stripe ne plafonne pas le refund au solde non-transféré de CETTE charge, il puise dans le solde plateforme global. **Risque théorique identifié : si le solde plateforme global devient insuffisant, un refund échouerait avec une erreur d'insuffisance de solde — jamais en annulant un Transfer déjà fait.** Confirmé également : idempotence testée (même clé rejouée → même objet refund, `amount_refunded` inchangé, pas de doublon). |
| Objets pour rapprocher proprement ? | `refund.balance_transaction` (`type: 'refund'`, montant négatif, impact exact sur le solde plateforme) ; `charge.refunds` (liste tous les refunds d'une charge, avec leur `balance_transaction`) ; `transfers.list({transfer_group})` (retrouve tous les Transfers liés à la même charge). Les trois combinés suffisent à expliquer par période/charge : encaissé, transféré, remboursé, conservé. |

**Conclusion de la vérification** : le risque identifié en analyse (« un remboursement pourrait-il bloquer/affecter les
Transfers des autres livreurs sur la même charge restaurant ? ») est **levé** — confirmé négatif par test réel, pas seulement
par lecture de documentation. Le mécanisme envisagé (Option 2, refund séparé sur la charge d'origine) est **viable côté
Stripe** sans risque d'interférence entre livreurs d'un même restaurant/période. Seul risque résiduel documenté : solde
plateforme insuffisant en cas de remboursements cumulés importants — à surveiller opérationnellement, pas un obstacle
architectural.

**Non fait à cette étape (hors périmètre de cette vérification)** : réplication exacte du flux SEPA réel (Account v2
`customer_account` du restaurant) — l'expérience utilise une PaymentIntent carte plateforme simple, suffisante pour valider
la mécanique générique Separate Charges and Transfers (refund vs Transfers déjà créés), qui ne dépend pas du moyen de
paiement d'origine. Reste à faire avant implémentation réelle : test spécifique sur le flux SEPA exact si un doute subsiste
sur le délai de disponibilité (`available_on`) propre au SEPA.

### Règles métier verrouillées (2026-09-23, validées)

1. Remboursement proportionnel du service **uniquement** pour `driver_fault`.
2. `locadely_error` : **jamais** de remboursement service automatique.
3. `driver_fault` **sans** `order_id` (`fraud`/`other_validated_decision` sans commande précise) : **jamais** de remboursement automatique — aucune base pour calculer une proportion.
4. Avec `order_id` : calcul sur le montant **réellement récupéré chez Stripe** (`reversed_cents`, jamais le montant demandé), formule cumulative pour éviter la dérive d'arrondi sur plusieurs reversals partiels du même ordre. Exemple validé : delivery=1000, service=200, récupéré=500 → remboursement service=100.
5. Mouvement **strictement séparé** du reversal du Transfer livreur — jamais fusionné.

Test Stripe Sandbox jugé suffisant pour valider l'architecture générale (§ ci-dessus). Test SEPA spécifique : plus tard, non bloquant.

### Plan d'implémentation SF9.5 (rédigé, PAS ENCORE CODÉ)

**Répartition** : SQL/PostgreSQL = Claude Code ; backend TypeScript = Codex ; revue/correction = Claude Code (même répartition que SF1-SF9).

**Point de conception le plus délicat, à traiter dans la MÊME tranche, jamais séparément** : `charge-incident.ts` (`assessChargeIncidents`) traite aujourd'hui **tout** remboursement observé sur une charge (`amountRefundedCents > 0`) comme un incident RESTAURANT (crée une `merchant_receivable`, marque `chargeUsable: false`, peut bloquer les Transfers livreurs restants de cette charge). Le jour où Locadely commence à émettre ses propres remboursements de service via `refunds.create`, ce code existant les classerait à tort comme des impayés restaurant. **Il faut donc, dans la même livraison** : construire le mécanisme de remboursement ET apprendre à `assessChargeIncidents`/`compareDebitAttempt` à soustraire les remboursements déjà connus/tracés (nos propres `driver_reversal_service_refunds` réussis pour cette charge) avant d'évaluer s'il reste un montant remboursé « inexpliqué » relevant d'un vrai incident restaurant. Ne jamais livrer l'un sans l'autre.

**Étapes** :

1. **SQL (Claude Code)** — nouvelle migration : table `driver_reversal_service_refunds` (une ligne par reversal `driver_fault` éligible) :
   - `driver_transfer_reversal_id` (unique, FK `driver_transfer_reversals`), `order_id` (FK `orders`, not null), `merchant_id`, `debit_attempt_id` (la charge SEPA succeeded à rembourser).
   - Snapshots figés à l'insertion : `delivery_cents`/`service_fee_cents` (copiés de `orders`), `previously_recovered_cents` (somme des `reversed_cents` des reversals `driver_fault` succeeded antérieurs sur le MÊME `order_id`, lue au moment de l'insertion — même patron que `ledger_reversed` déjà utilisé dans `postgres-driver-reversal-repository.ts`), `reversed_cents` (copié du reversal parent, déjà figé), `refund_cents` (résultat de la formule cumulative, figé une fois pour toutes).
   - États : `pending → executing → succeeded|failed`, bail/`claim_token`, `attempt_count`, `idempotency_key` unique.
   - Trigger d'immuabilité : identité + tous les montants figés dès l'insertion (rien à « décider » en deux temps ici, contrairement à `driver_transfer_reversals` — tout est déjà connu puisque le reversal parent est déjà `succeeded` au moment de la création de la ligne) ; seuls statut/résultat Stripe évoluent, état terminal = terminal.
   - CHECK garantissant `refund_cents <= service_fee_cents` et cohérence de la formule (vérifiable en base à l'insertion puisque toutes les entrées sont déjà connues).

2. **Backend (Codex)** :
   - Domaine pur : fonction de calcul cumulatif (formule validée point 4), fonction d'éligibilité (`driver_fault` + `order_id` non nul + `reversed_cents > 0`).
   - Extension du point de complétion d'un reversal (`PostgresDriverReversalRepository.complete()` ou équivalent) : dans la MÊME transaction qui marque le reversal `succeeded`, insertion conditionnelle et automatique d'une ligne `driver_reversal_service_refunds` `pending` si éligible — aucune approbation humaine séparée requise (le reversal parent a déjà été approuvé ; ce remboursement en est une conséquence automatique et déterministe, pas une nouvelle décision).
   - Nouveau port + provider Stripe (`MerchantServiceRefundProvider.createRefund`) : `stripe.refunds.create({charge, amount, metadata}, {idempotencyKey})` — même patron DB-avant-Stripe que R50/R60/R61 (écriture `executing` committée avant l'appel).
   - Nouveau worker (`RunServiceRefundsUseCase`) : bail, retry/backoff, reprise par recherche Stripe (liste des refunds de la charge) avant tout renvoi — même patron que R60/R61.
   - **Modification de `assessChargeIncidents`/`compareDebitAttempt`** : exclure les montants déjà couverts par des `driver_reversal_service_refunds` réussis de cette charge avant de qualifier un « incident restaurant ».
   - Wiring `app.ts`/`settlements/public.ts`, variable d'activation dédiée (`SETTLEMENT_SERVICE_REFUND_WORKER_ENABLED`, faux par défaut, même convention que tous les workers R41-R70).

3. **Revue Claude Code** : cohérence SQL↔backend, vérification que R70 ne classe plus un remboursement de service connu comme incident restaurant, non-régression R60/R61/R70 complète.

4. **Tests ciblés** (pas de campagne exhaustive) :
   - Exemple validé exact : delivery=1000/service=200/récupéré=500 → refund=100.
   - Deux reversals partiels successifs du même ordre → pas de dérive d'arrondi (formule cumulative).
   - `driver_fault` sans `order_id` → aucune ligne créée.
   - `locadely_error` → aucune ligne créée, quel que soit `order_id`.
   - Retry/crash après appel Stripe → pas de double remboursement (idempotence).
   - **R70 ne crée plus de `merchant_receivable` ni ne bloque les Transfers restants** pour un remboursement de service déjà tracé (test de non-régression du point de conception délicat ci-dessus).
   - Non-interférence multi-livreurs sur une même charge (déjà prouvé en Sandbox réel — un test DB reproduisant le même scénario reste utile en garde de non-régression).

**Invariants à revérifier à chaque étape** : centimes entiers, aucune avance Locadely avant paiement restaurant, idempotence complète, aucun appel Stripe en transaction, reversals livreur toujours limités aux catégories actuelles (ce mécanisme n'en ajoute aucune), aucune réécriture de période close, cohérence DB↔Stripe.

### SF9.5 : implémenté et vérifié le 2026-09-23

**SQL (Claude Code)** : `supabase/migrations/0044_driver_reversal_service_refunds.sql` — table dédiée, formule cumulative vérifiée par CHECK, garde d'éligibilité (driver_fault + succeeded + order_id exact), immuabilité, `merchant_id` dérivé par trigger. Vérifié avant handoff sur base jetable : reversal totale (1000/1000→200 exact), deux reversals partielles cumulatives sur le même ordre (500 puis 400 sur delivery=1000/service=201 → 100 puis 80, cumul 180/201 sans dérive), formule fausse rejetée, `locadely_error` rejeté, `driver_fault` sans `order_id` rejeté, immuabilité et unicité confirmées.

**Backend (Codex)** — fichiers créés : `domain/service-refund.ts` (formule cumulative en `BigInt`, éligibilité, plafonnement par commande), `ports/service-refund.ts`, `infrastructure/postgres-service-refund-repository.ts` + `stripe-merchant-service-refund-provider.ts`, `application/run-service-refunds.ts`, `infrastructure/service-refund-worker.ts`. Point de déclenchement : `PostgresDriverReversalRepository.complete()` insère automatiquement la ligne `pending` dans la MÊME transaction que la clôture du reversal (aucune nouvelle approbation), `previously_recovered_cents` recalculé en direct par sous-requête (même style que `ledger_reversed` déjà existant), `debit_attempt_id`/`stripe_charge_id` lus directement sur `driver_transfers`. `SETTLEMENT_SERVICE_REFUND_WORKER_ENABLED` (faux par défaut), même câblage que les autres workers R41-R70.

**Exclusion R70 (point obligatoire, livré dans la même tranche)** : `assessChargeIncidents` et `compareDebitAttempt` acceptent désormais `knownServiceRefundCents` (somme des `driver_reversal_service_refunds` `succeeded` pour la charge, calculée par une nouvelle méthode repository) et ne qualifient plus d'incident restaurant que le montant remboursé **non expliqué** (`amountRefundedCents − knownServiceRefundCents`). Un nouveau comparateur `compareServiceRefund` (toujours `locadely_technical`, jamais une dette restaurant) vérifie la cohérence DB↔Stripe des remboursements de service eux-mêmes.

**Revue Claude Code** : relecture complète ligne par ligne de tous les fichiers backend, cohérence confirmée avec le schéma SQL réel. `typecheck`/`lint`/`check:boundaries` propres. Tests ciblés exécutés pour de vrai sur base isolée (`settlements_r10`, 44 migrations + seed) : `domain/service-refund.test.ts`, `domain/charge-incident.test.ts` (dont *« excludes succeeded Locadely service refunds but retains an untracked refund remainder »*), `domain/reconciliation.test.ts`, `driver-reversals.integration.test.ts`, `settlement-ops.integration.test.ts` → **40/40 passés**. Suite complète `settlements/`+`orders/` → **414/414 passés** (409 de SF6 + 5 nouveaux), aucune régression.

### SF10 : implémenté et vérifié le 2026-09-23 (Claude Code, frontend web + petit backend additif signalé)

**Décision prise en cours de route** : le devis (`/merchant/new`) avait déjà `deliveryCents`/`serviceFeeCents` depuis SF5 (zéro backend à toucher), mais le détail d'une commande créée (`order-modal.tsx`) et le détail par course des règlements (`/merchant/settlements`) ne montraient que le total (déjà correct) — l'API ne renvoyait pas encore la décomposition pour ces deux vues. **Signalé avant d'élargir** (`AskUserQuestion`) : le propriétaire a validé l'ajout. Ajout strictement additif (aucune logique nouvelle, colonnes déjà calculées) :
- `orders/domain/order.ts` + `postgres-order-repository.ts` (`mapOrder`) : exposent désormais `deliveryCents`/`serviceFeeCents` (déjà présents sur `OrderRow`, simplement pas mappés).
- `settlements/ports/settlement-read.ts` + `postgres-settlement-read-repository.ts` + `domain/settlement-views.ts` + `application/settlement-read.ts` : `MerchantSettlementView`/`MerchantSettlementLineView` exposent `deliveryCents`/`serviceFeeCents` (période et par ligne), lus depuis `merchant_settlements.driver_amount_cents`/`service_fee_cents` et `settlement_lines.delivery_cents`/`service_fee_cents` (déjà figés depuis SF6).
- Deux tests existants (`settlement-read.test.ts`, `settlement-read.integration.test.ts`) affirmaient explicitement « le restaurant ne voit jamais... de frais » — vrai sous l'ANCIEN modèle (frais = commission cachée sur le livreur), plus vrai sous le modèle corrigé (le frais de service est SA propre facture). Regex et liste de clés corrigées pour continuer à interdire `driverId`/`driverName`/`earning`/identifiants Stripe, mais plus `fee` en général.

**Frontend** :
- `apps/web/lib/orders.ts` : `Order` expose `deliveryCents`/`serviceFeeCents` ; nouvelle fonction `orderTotalCents()` (delivery+service, repli sur `priceCents`) ; **`hasChargeablePrice` corrigé** — seule `CANCELLED` n'a donné lieu à aucun paiement, `RETURNED` reste facturé (incohérence §4 du plan, maintenant corrigée).
- `apps/web/components/price-card.tsx` (devis) : total HT en premier, bouton « Détail » dépliant livraison/service.
- `apps/web/components/order-modal.tsx` (détail commande) : même total + même toggle « Détail ».
- `apps/web/components/order-card.tsx` (liste des commandes) : total correct (delivery+service) affiché, pas de toggle dans la vue compacte (le détail est dans la modale).
- `apps/web/app/merchant/settlements/page.tsx` : décomposition livraison/service/total affichée dans le détail déjà dépliable de chaque période, et sous chaque course.
- Jamais un montant présenté comme une soustraction au livreur nulle part — vérifié par relecture.

**Vérification** : `typecheck`/`lint` propres (`apps/api` et `apps/web`). Suite backend affectée réexécutée pour de vrai (base isolée) : `settlement-read.integration.test.ts`, `settlement-read.test.ts`, `domain/settlement-display.test.ts`, `settlement-display.test.ts`, `notify-next-candidate.test.ts` → **36/36 passés**. **Aucun framework de test frontend dans ce dépôt** (`apps/web` n'a aucun fichier `*.test.ts*`) : vérifié par relecture complète + démarrage du serveur de dev existant + contrôle que les pages modifiées répondent sans erreur serveur. Pas de clic-à-clic authentifié effectué par moi dans ce tour — à confirmer visuellement par vous à l'occasion.

**SF10 — bug post-livraison signalé et clos** : le propriétaire a rapporté carte/scroll disparus sur `/merchant/new` après SF10 ; relecture complète du diff (`page.tsx`, `price-card.tsx`) ne montre aucune classe de layout touchée (seul `<p>`→`<div>` dans `PriceCard`, typage `priceCents`→`deliveryCents`/`serviceFeeCents`, `useRef`→`useMemo` sans rapport). Serveur de dev confirmé à jour (port 4000, bon `cwd`). Cause probablement locale (compte sans adresse opérationnelle → carte masquée par design, ou artefact HMR) — validé visuellement par le propriétaire ensuite, considéré clos.

### SF11 : investigation préalable (2026-09-23, Claude Code) — AVANT implémentation Codex

Relecture de `apps/mobile` (grep `fee|net|gross|commission|priceCents` + lecture ciblée) avant délégation. Constats vérifiés :

- **Backend déjà correct** : `GET /api/v1/orders/driver/earnings` (`get-driver-earnings.ts` → `postgres-order-repository.ts:752-784`) lit `driver_earning_cents`, qui **égale déjà `delivery_cents`** depuis SF5 (`postgres-order-repository.ts:394`, `set driver_earning_cents = $1, delivery_cents = $1, ...`). `current-week-estimate.ts:20` (`estimatedNetCents`) somme déjà `order.deliveryCents` — valeur correcte, seul le **nom** du champ (`estimatedNetCents`) porte encore la terminologie soustractive. Les vues règlement livreur (`DriverStatementView`/`DriverPeriodView`) n'exposent `serviceFeeCents` nulle part — pas de fuite à corriger.
- **Vraie incohérence §4 identifiée** : `app/(tabs)/compte/index.tsx` (carte « Wallet » de l'accueil) calcule « cette semaine » via `api.getMyEarnings()` + `lib/earnings.ts` (`getWeeklyEarnings`, borne Europe/Paris locale, **aucun filtre `go_live_at`**). `app/(tabs)/compte/wallet.tsx` (écran détaillé) affiche `currentWeek.estimatedNetCents` via `api.getMySettlements()` → `current-week-estimate.ts`, **filtré par `settings.goLiveAt`** (`null` en dev ⇒ `currentWeek` vaut `null`, bloc masqué). Résultat : les deux écrans peuvent légitimement diverger (l'un affiche un montant réel, l'autre rien) pour la « même » semaine — ce n'est pas un problème brut/net, c'est deux sources de données différentes pour le même concept.
- `components/earning-row.tsx` n'est rendu **nulle part** dans l'app (grep confirmé) — code mort. `lib/wallet-types.ts` (`CompletedOrderEarning`/`DriverEarnings`) et `lib/earnings.ts` ne servent qu'à ce seul calcul de carte d'accueil.
- **Vrai bug d'affichage livreur** : `app/order/[id]/index.tsx:294` et `components/order-card.tsx:99` affichent `order.priceCents` (total restaurant = livraison + service) sur l'écran du livreur — pas son gain réel. `lib/orders-types.ts` (mobile) n'a que `priceCents`, n'a pas encore `deliveryCents`/`serviceFeeCents` (déjà présents côté backend sur l'objet `Order` depuis SF10, jamais mappés côté mobile). Le bloc paiement à la livraison (COD, `order.cashOnDelivery.amountCents`, Stripe Terminal Direct Charge) est un flux séparé (encaissement client, hors chantier SF, ADR 0003) — ne pas toucher.

Décision : fixes ci-dessus scopés **mobile uniquement**, zéro nouveau backend (le seul renommage `estimatedNetCents` touche un champ déjà correct en valeur, pur renommage sans changement de calcul). Brief détaillé envoyé à Codex ci-dessous.

### SF11 : implémenté et vérifié le 2026-09-23 (Codex mobile, revue Claude Code)

Codex a livré exactement le périmètre du brief, relu diff par diff par Claude Code (rien de plus large que demandé) :
- `apps/mobile/app/order/[id]/index.tsx:294`, `apps/mobile/components/order-card.tsx:99` : `order.priceCents` → `order.deliveryCents ?? order.priceCents` (repli commandes pré-SF5). Bloc `cashOnDelivery.amountCents` (paiement client, ADR 0003) non touché — vérifié.
- `apps/mobile/lib/orders-types.ts` : `Order` gagne `deliveryCents`/`serviceFeeCents` (nullable), miroir du backend déjà émetteur depuis SF10 — `serviceFeeCents` ajouté au type par cohérence mais jamais lu ni affiché côté livreur (vérifié par grep, aucune occurrence de rendu).
- `apps/mobile/app/(tabs)/compte/index.tsx` : la carte Wallet de l'accueil n'appelle plus `api.getMyEarnings()`/`lib/earnings.ts` (calcul local, sans filtre `go_live_at`) ; elle lit désormais `api.getMySettlements().currentWeek.estimatedAmountCents`, **même source** que `wallet.tsx` → les deux écrans ne peuvent plus diverger. `currentWeek === null` affiche `—` au lieu d'un montant potentiellement incohérent.
- Renommage pur (zéro changement de calcul, confirmé par lecture) : `estimatedNetCents` → `estimatedAmountCents` dans `apps/api/src/modules/settlements/domain/settlement-views.ts`, `application/current-week-estimate.ts` (toujours `Σ order.deliveryCents`), `apps/mobile/lib/settlements-types.ts`, et les deux usages mobile. Test `settlement-read.test.ts` mis à jour en cohérence.
- Code mort supprimé (plus aucun appelant après l'unification, vérifié par grep sur tout `apps/mobile`) : `apps/mobile/components/earning-row.tsx` (jamais rendu), `apps/mobile/lib/earnings.ts`, `apps/mobile/lib/wallet-types.ts`, `api.getMyEarnings()`. L'endpoint backend `GET /api/v1/orders/driver/earnings` n'a volontairement pas été touché (hors périmètre, plus appelé par le mobile mais toujours fonctionnel).
- Balayage indépendant (Codex + re-grep Claude Code) : aucune occurrence restante de `fee`/`net`/`gross`/`commission`/calcul soustractif sur un montant livreur dans `apps/mobile`.

**Vérification indépendante (Claude Code, pas seulement le rapport Codex)** : `npm run typecheck -w apps/mobile` propre, `npm run lint -w apps/mobile` propre, `apps/api` `settlement-read.test.ts` réexécuté → **5/5 passés**. `apps/api/CLAUDE.md` (édité par Codex en cours de route pour documenter le renommage) relu et jugé exact. `apps/mobile/CLAUDE.md` mis à jour par Claude Code (nouvelle section dédiée).

**Exemple concret vu par le livreur maintenant** : commande livraison 6,00 € + frais de service Locadely 1,20 € (total restaurant 7,20 €, inchangé côté restaurant depuis SF10) → l'écran détail de course et la carte de la liste affichent **6,00 €** au livreur (jamais 7,20 €, jamais un « net » après une commission fictive). La carte Wallet de l'accueil et l'écran « Mes paiements » affichent désormais le **même** montant pour « cette semaine ».

### SF12 : implémenté et vérifié le 2026-09-23 (Claude Code — SQL/scripts, rien à déléguer à Codex)

**Recherche préalable** : grep exhaustif (`driver_earning_cents|net_cents|gross_cents|fee_cents|feeRateBps|computeLineFee`) sur tout le dépôt.
- `apps/api/test/settlements/*.integration.test.ts` (`settleable-orders`, `sepa-debit`, `settlement-close`, `settlement-schema`) : déjà propres — chaque hit est soit `orders.driver_earning_cents` (colonne toujours existante, jamais droppée), soit déjà suivi d'un `update orders set delivery_cents=$2, service_fee_cents=$3` correct. **Rien à corriger côté Codex** — confirmé, pas de tâche envoyée pour éviter un aller-retour à vide.
- `docs/work/r90/*.mts` (20 scripts Sandbox, exécutés une seule fois le 2026-09-22, **avant** que les migrations SF4/SF6 (même jour) ne réécrivent le schéma) : 4 fichiers cassés par le schéma additif, trouvés et corrigés :
  - `world.mts` (2 sites) et `run4-world.mts` (1 site) et `week2-dispute-after-payment.mts` (1 site) : les commandes fixtures posaient `driver_earning_cents = price_cents` mais ne posaient jamais `delivery_cents`/`service_fee_cents` — resteraient `NULL`, et `guard_settlement_line` (SF6, `0043_settlement_ledger_additive_model.sql`) **refuse explicitement** toute ligne de règlement sur une commande sans ces montants figés (« commande antérieure au modèle SF5 »). Corrigé : même `UPDATE` étendu à `delivery_cents = price_cents, service_fee_cents = floor(price_cents * 2000 / 10000)` (taux 2000 bps = défaut réel de `pricing_settings`, même valeur que le pattern déjà utilisé dans les tests d'intégration `apps/api/test/settlements/*`). `pricing_rule_version` n'avait pas besoin de fix : posé automatiquement par le trigger `orders_compute_price` (SF4) dès l'`INSERT`, jamais par ces scripts.
  - `week1-close.mts:11` : requête directe `sum(driver_earning_cents)`/`sum(fee_cents) from settlement_lines` — ces DEUX colonnes sont **droppées** par `0043` (`drop column driver_earning_cents`, `drop column fee_cents`). Aurait échoué avec « column does not exist » si rejoué. Corrigé : `sum(delivery_cents)`/`sum(service_fee_cents)`.
  - Les 16 autres scripts `.mts` (dont `uc.mts`, qui assemble les VRAIS cas d'usage backend via `apps/api/src/modules/settlements/public.ts` — zéro logique dupliquée, donc automatiquement à jour) : aucun hit, déjà corrects.
- Recherche explicite finale demandée (« `delivery - fee` ») sur tout le dépôt (`.ts`/`.mts`/`.tsx`/`.sql`) : **zéro réintroduction** — seul résultat, un commentaire dans `apps/web/lib/settlements.ts` qui INTERDIT explicitement ce calcul (négation, pas une occurrence).

**Non exécuté (hors périmètre « tests ciblés »)** : pas de replay complet de la campagne R90 sur base jetable + vrai Stripe Sandbox (aurait pris des dizaines de minutes, contraire à « tests ciblés, pas de couverture exhaustive » pour cette tranche). Les corrections sont des changements de requête SQL mécaniques, raisonnées contre le schéma réel (`0042`/`0043` relus intégralement), pas rejouées de bout en bout.

**Caveat à noter pour la suite (signalé, pas corrigé ici — hors périmètre SF12)** : `docs/work/r90/{BILAN-final,CHECKLIST-production}.md` documentent une validation du **mécanisme** de règlement (clôture/débit/payout/reversal/webhook/réconciliation — inchangé) réalisée AVANT le basculement au modèle additif le même jour. Les montants d'exemple qu'ils citent peuvent donc refléter l'ancienne formule. Avant la mise en production (le gate `CHECKLIST-production.md` existe pour ça), un rejeu au moins partiel de R90 sous le schéma actuel serait prudent — décision non prise ici, à trancher séparément.

### SF13 : clôture du chantier, vérifié le 2026-09-23 (Claude Code)

Relecture complète du plan SF1-SF12 (§0-§9 + toutes les sections de détail), puis vérification indépendante de l'état RÉEL du dépôt (pas seulement de la prose du plan) :

- **Grep final sur tout le dépôt applicatif** (`apps/api/src`, `apps/web`, `apps/mobile`, `supabase/migrations`) pour `feeRateBps`/`computeLineFee`/`net_cents`/`gross_cents`/`fee_cents`/calcul `earning - fee` : **zéro résultat en code vivant**. Les seuls hits restants sont dans `supabase/migrations/0030_settlement_core.sql` (migration historique, jamais réécrite — règle du dépôt) et dans les `DROP COLUMN` de `0043` (mentionne nécessairement les anciens noms pour les supprimer). `serviceFeeRateBps`/`service_fee_rate_bps` (modèle actuel, additif) exclus de la recherche.
- **Schéma live confirmé** (dev DB, `psql` direct) : `settlement_lines.delivery_cents`/`service_fee_cents` + `merchant_amount_cents` généré (`delivery_cents + service_fee_cents`) ; `settlement_statements.due_cents` sans dérivation `gross-fee` ; `merchant_settlements.amount_cents`/`driver_amount_cents`/`service_fee_cents` + `CHECK amount_cents = driver_amount_cents + service_fee_cents`. Les 44 migrations sont toutes appliquées (`npx supabase migration list --local`, local=remote sur toute la liste).
- **Suite de tests ciblée réexécutée pour de vrai**, une dernière fois, sur base isolée fraîchement recréée (`docs/work/r10-testdb.sh reset`, 44 migrations + seed) : `test/settlements` + `test/orders` + `test/pricing` → **344 passés / 80 skipped (Stripe réel non configuré, comportement attendu) / 0 échec**.
- **Typecheck final** `apps/api`/`apps/web`/`apps/mobile` : les trois propres.
- **SF9.5 (refund service) re-confirmé structurellement séparé** : `PostgresDriverReversalRepository.complete()` insère dans `driver_reversal_service_refunds` (table dédiée) en plus de mettre à jour `driver_transfer_reversals` — deux tables, deux flux d'argent, jamais fusionnés (relu dans le code, pas seulement dans le plan).
- **ADR relus, deux corrections mineures de documentation trouvées et faites** (pas de code) :
  - `docs/adr/0004-driver-settlement.md` §Contexte disait encore « verse aux livreurs ce qui a réellement été encaissé, après déduction de ses frais » — formulation narrative non barrée qui décrivait encore le modèle soustractif ; corrigée pour décrire le flux additif réel (débit `delivery+service`, Transfer 100% `delivery`, `service_fee_cents` gardé par Locadely).
  - Même ADR, note d'amendement en tête, disait « correction en cours... pas encore fait, voir SF6/SF8 » — obsolète depuis la fin de SF6/SF8 le 2026-09-22 ; mise à jour pour refléter la clôture SF13.
  - `docs/adr/0002-pricing-formula.md` : déjà correct (clause fausse déjà barrée avec renvoi vers ADR 0005), rien à changer.
- **Fichier `apps/api/src/modules/notifications/application/send-new-order-pushes.ts`** (identifié §4 du plan comme exposant `priceCents`) : vérifié — PAS un bug. C'est la notification push au livreur candidat, avant prise de la course ; `priceCents` y vaut toujours `delivery_cents` (même trigger/update depuis SF4/SF5), donc affiche exactement le gain potentiel du livreur, jamais un total restaurant. Aucune correction nécessaire.
- **CLAUDE.md relus et mis à jour** : `CLAUDE.md` racine (SF1-SF12→SF1-SF13, statut « EN COURS »→« CLOS », chantiers dérivés hors périmètre explicités) ; `apps/api/CLAUDE.md` (référence « SF1-SF6 terminés » obsolète→« SF1-SF13, clos »). `apps/web/CLAUDE.md`/`apps/mobile/CLAUDE.md` : déjà à jour depuis SF10/SF11 respectivement, aucune correction nécessaire.
- **Aucun code applicatif modifié dans cette première passe de clôture** — conforme à la consigne « pas une nouvelle vague de fonctionnalités » : seules deux phrases de documentation ADR corrigées. (Un vrai bug backend a ensuite été trouvé et corrigé par le replay Sandbox décrit ci-dessous — voir cette sous-section pour le détail.)

**Points restés hors périmètre, confirmés toujours hors périmètre (aucune dérive de scope)** : F10 facturation, TVA opérationnelle, groupage tarifaire avancé, retour (RETURN), interface admin complète de gestion des taux, R91/mise en Live (`go_live_at`). Le plan §3 documente déjà honnêtement que ces chantiers futurs NE sont PAS garantis à zéro changement de schéma — seulement que le design actuel ne les empêche pas.

**Dette/limite signalée pour la suite, non résolue ici (hors périmètre SF13)** :
1. ~~Replay au moins partiel de `docs/work/r90/*`...~~ **FAIT** (voir sous-section replay ci-dessous) — un scénario minimal a été rejoué en Stripe Sandbox réel, avec succès (et un vrai bug trouvé + corrigé). Le replay COMPLET de la campagne R90 historique (10 restaurants × 5 livreurs, tous les scénarios A-F) reste non fait — hors périmètre demandé, seulement recommandé « au moins partiellement » avant production, désormais satisfait par ce scénario minimal.
2. `merchants.service_fee_rate_bps_override` : colonne schema-ready mais non résolue applicativement pour aucun restaurant réel (résolution déjà branchée dans `create-order.ts`/`estimate-order.ts` — juste aucune UI admin pour la positionner, hors périmètre voulu dès SF3).
3. `docs/work/r90/{BILAN-final,CHECKLIST-production}.md` décrivent des montants d'exemple potentiellement issus de l'ancien modèle (validation faite avant le basculement additif le même jour) — non réécrits ici (hors périmètre demandé), à garder en tête en les relisant.
4. Incohérences pré-existantes déjà corrigées au passage (pas des dettes restantes, mentionné pour mémoire) : `hasChargeablePrice`/`RETURNED` (SF10), écran gains vs wallet mobile (SF11).

### SF13 — replay Sandbox minimal post-clôture (2026-09-23, Claude Code + Codex pour un fixture de test)

Sur demande explicite, après la clôture SF13 ci-dessus : un scénario end-to-end minimal (1 restaurant, 1 livreur, 1 commande) rejoué en Stripe Sandbox réel sur la base jetable `settlements_r90` (`docs/work/r90-testdb.sh reset` + `go-live` — `go_live_at` de TEST posé UNIQUEMENT sur cette base jetable, jamais la base de dev ni une base Live, conformément à la consigne). Script jetable (`docs/work/r90/replay-sf13.mts`, patron `world.mts`+`week1-close/debit/payout/incidents/reversals`, réutilisant intégralement les vrais use cases exposés par `settlements/public.ts` — aucune nouvelle logique métier), supprimé après usage, jamais commité.

**Résultat (montants réels produits par le système, non forcés)** : commande 6000 m / 760 s sous `pricing_settings rule_version=1` (100+37/km+22/min, 20% service — valeurs seedées par défaut) → `delivery_cents=600`, `service_fee_cents=120`, total restaurant 720 (exactement l'exemple de référence du plan §0). Clôture → débit SEPA restaurant **720 succeeded** → Transfer livreur **600 succeeded** → réconciliation AVANT reversal : **0 finding restaurant**, 69 `stripe_transfer_orphan` technical (bruit préexistant du compte Sandbox partagé, vérifié individuellement : aucun n'appartient à ce replay ni à son livreur — même phénomène que `check-orphans.mts` lors de la campagne R90 originale). Reversal `driver_fault`/`order_stolen` de 200 sur les 600 → **200 reversés chez Stripe**, 0 créance (solde livreur suffisant). Refund service SF9.5 auto-déclenché → **40 remboursés** (`floor(200×120/600)=40`, formule cumulative exacte). Réconciliation APRÈS : **0 finding restaurant, 0 `merchant_receivable`** — le remboursement de service n'a PAS été classé à tort comme incident restaurant (exclusion `knownServiceRefundCents` vérifiée en conditions réelles, pas seulement en test unitaire). Aucun comportement Stripe inattendu en dehors du bug ci-dessous.

**Bug réel trouvé et corrigé (pas masqué)** : le premier essai a révélé que `PostgresServiceRefundRepository.retryLater()` (`apps/api/src/modules/settlements/infrastructure/postgres-service-refund-repository.ts`) levait une vraie erreur PostgreSQL (`column "next_attempt_at" is of type timestamp with time zone but expression is of type interval`) dès qu'un remboursement de service devait réellement être retenté — chemin jamais exercé par aucun test existant (`domain/service-refund.test.ts` utilise un repository entièrement fake). Cause : `next_attempt_at = $5 + make_interval(secs => $4)` sans caster `$5` en `::timestamptz`, contrairement à TOUTES les requêtes sœurs du module (`postgres-driver-reversal-repository.ts:195` fait exactement la même chose, correctement, sur une autre table) — confirmé par reproduction directe via `pg` (hors psql, où le texte littéral masque le problème) avant toute correction. **Corrigé** (ajout du cast, une ligne). **Nouveau test de non-régression** : `apps/api/test/settlements/service-refund-repository.integration.test.ts` (base isolée, vrai `PostgresServiceRefundRepository`, provider Stripe fake qui échoue une fois puis réussit — force le chemin réel de `retryLater()`) : construit un fixture de test invalide au premier essai (Codex, `codex:codex-rescue` — repris de la même pattern qu'un test sœur déjà existant), corrigé par Claude Code après 2 itérations (`chargeAvailableOn`/`available_on` non posé → mauvais compartiment de solde ; fenêtre de retry trop courte par rapport au pas de vérification du test) — **1/1 passé**. Suite `settlements`+`orders`+`pricing` réexécutée en entier après le fix : **425/425 passés, 0 échec**. `typecheck` `apps/api` propre.

**Nettoyage** : script + fichiers de preuve jetables supprimés (`docs/work/r90/replay-sf13.mts`, `evidence/state-r90-replay-sf13.json`), base `settlements_r90` droppée (`docs/work/r90-testdb.sh drop`) — rien de jetable laissé dans le dépôt.

## 6. Invariants obligatoires (à vérifier à CHAQUE étape touchant l'argent)

- Argent en centimes entiers, jamais de float.
- Timestamps UTC (`timestamptz`).
- Lignes financières figées / append-only (`settlement_lines` : aucun UPDATE/DELETE, mécanisme inchangé).
- Aucune réécriture des périodes déjà closes.
- Aucune avance Locadely avant paiement restaurant réussi.
- `Σ Transfers ≤ montant réellement encaissé/capturé disponible de la charge`.
- Aucun appel Stripe dans une transaction PostgreSQL.
- Idempotence complète : débits, Transfers, retries, traitement webhook, workers, reversals, reconciliation.
- Aucun double débit / double Transfer en cas de retry ou crash.
- Reversals strictement limités faute-livreur / erreur-Locadely — ce chantier n'élargit jamais ce périmètre.
- Cohérence PostgreSQL ↔ Stripe (relecture avant chaque action sensible, comme aujourd'hui).
- Compatibilité multi-merchant, multi-driver.
- Comptes Connect restreints, retries, incidents, disputes, remboursements, reconciliation : comportements R70/R61 existants non régressés.
- Aucune migration ne réécrit une migration déjà appliquée — toujours une nouvelle migration.
- Tests financiers destructifs/E2E : base jetable uniquement (règle D-R), jamais la base de dev partagée, jamais `go_live_at` touché.

## 7. Répartition des responsabilités

**Codex :**
- backend TypeScript (use cases, repositories, services, workers, intégration Stripe côté backend)
- tests backend
- frontend de l'application mobile

Codex NE modifie PAS le frontend web. Codex NE modifie PAS directement les migrations SQL/PostgreSQL sauf instruction explicite de Claude Code.

**Claude Code :**
- frontend web
- SQL, PostgreSQL, migrations, contraintes, triggers, protections DB
- revue du backend produit par Codex
- vérification du respect de l'architecture (frontières `public.ts`, pas de logique métier en route HTTP, etc.)
- correction du backend si nécessaire après revue
- validation de la cohérence finale backend ↔ DB ↔ web ↔ app

Codex implémente le backend. Claude Code contrôle ensuite ce backend et corrige si nécessaire. Éviter que Claude Code et Codex modifient simultanément les mêmes fichiers backend.

## 8. Workflow par tranche

Pour chaque étape SFn touchant le backend :
1. Claude Code prépare/valide la partie SQL si nécessaire.
2. Codex réalise le backend correspondant.
3. Claude Code relit le backend.
4. Claude Code corrige si nécessaire.
5. Codex réalise la partie app mobile liée à cette tranche (si applicable).
6. Claude Code réalise la partie frontend web liée à cette tranche (si applicable).
7. Claude Code lance les vérifications globales (typecheck, tests, lint).
8. Ne pas passer à la tranche suivante avant validation de la précédente.

Adapter cet ordre si une dépendance réelle du dépôt l'impose.

## 9. Contraintes projet transverses (rappel, déjà en vigueur dans tout le dépôt)

- Logique métier jamais dans les routes HTTP — routes appellent des use cases uniquement.
- Communication inter-modules uniquement via `public.ts`.
- Zod pour toute validation d'entrée API.
- Money en integer cents partout, jamais de float.
- UTC partout, conversion Europe/Paris côté client uniquement.
- Idempotence financière systématique.
- Aucun appel externe dans une transaction DB.
- Protections PostgreSQL existantes non affaiblies, jamais désactivées pour faciliter un test.

**Après chaque modification de code issue de ce plan : mettre à jour le(s) `CLAUDE.md` concerné(s) pour refléter ce qui a changé** (règle déjà en vigueur dans ce dépôt, rappelée ici car SF13 en dépend).
