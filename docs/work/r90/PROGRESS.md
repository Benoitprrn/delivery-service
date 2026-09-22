# R90 — suivi d'exécution détaillé (scénario par scénario)

Gate finale Sandbox/dev (D-Q, D-R). Aucun Stripe Live, aucun argent réel, aucune publication. **R90 est TERMINÉ et VALIDÉ (2026-09-22).** Verdict classé : `docs/work/r90/BILAN-final.md`. Ce fichier reste comme journal technique détaillé (preuves scénario par scénario, complément du bilan qui résume à plus haut niveau). Environnement R90 nettoyé (base jetable supprimée, comptes Auth R90 supprimés, clients repointés sur l'API de dev) — voir mémoire `driver-settlement-progress.md`.

## Si un futur chantier (R91/live) doit réutiliser ce harnais
Base : `source docs/work/r90-testdb.sh reset && source docs/work/r90-testdb.sh go-live` (recrée `settlements_r90` depuis zéro). API R90 : `SETTLEMENT_WEBHOOK_WORKER_ENABLED=true bash docs/work/r90-api.sh` (port 3100 ; jamais `pkill -f`, tuer par PID). L'API de dev (port 3000) ne doit jamais être touchée. Scripts réutilisables : `docs/work/r90/*.mts` (nouveau run = nouveau `R90_RUN_ID` à exporter avant chaque script). Calendrier simulé DANS LE PASSÉ RÉEL obligatoire (les gardes PostgreSQL lisent `now()` réel) ; aucune garde/trigger contourné.

## Tableau des scénarios
| Étape | Contenu | État | Preuve / point de checklist |
|---|---|---|---|
| ENV | base jetable, 0001→0039, go_live_at posé, API 3100, smoke Auth/API | FAIT 2026-09-22 | TST-12, DAT-01, DAT-11 ; evidence `smoke-auth-api` |
| WORLD | 10 restaurants (SEPA) + 5 livreurs (Connect) + 27 commandes + 1 pré-go-live | FAIT | evidence `world` |
| A1 | clôture R40 + 10 pré-notifications (e-mails simulés) | FAIT OK | evidence `A-close` |
| A2/B/F | débits SEPA réels : 8 réussis, 2 échoués ; 2 workers ; crash après création PI | FAIT OK | evidence `A/B/F-debit` |
| A3/D/F | pay-run : 16 statements payés (Σ Transfers = Σ payé, Stripe = DB), D5 restreint retenu puis drip, R8 (litige avant pay-run) sans Transfer | FAIT OK | evidence `A/F-payout`, `D-restricted-driver`, `D-regularized-drip` |
| C | litige SEPA (R8, lost 9,23 €) : webhooks signés via la vraie route API 3100 (doublon dédupliqué, hors ordre sans effet, signature invalide 400, type inconnu ignoré), incident + créance restaurant, 0 reversal, 18 statements payés inchangés | FAIT OK (variante « litige AVANT pay-run ») | evidence `C-dispute-webhooks` + `C-dispute-webhooks-CORRECTION` (KO initial = seuil de test erroné) |
| C2 | litige APRÈS paiement livreur (semaine 2 : clôture 07/09, débit 09/09, payrun 18/09) : R11 réussi puis pay-run immédiat (2 Transferts 4,15 € + 4,36 €), litige Stripe arrivé 43 s après la charge, webhook signé -> 2ᵉ incident + 2ᵉ créance restaurant, reversals inchangés, statements `paid`, 0 créance livreur | FAIT OK | evidence `C2-dispute-after-payment` |
| B-retry | relance manuelle R9/R10 via l'API admin : refus 403/409/409/400, doublon 409 `open_retry_request`, 0 débit sans nouvelle pré-notification, tentative 2 (clé `…:attempt:2`, mandat cité), succès réel, drip D1 ; 20 Transferts, 0 surpayé, R8 (litige) reste `unpaid_restaurant` | FAIT OK | evidence `B-retry` |
| E | reversals B/C par l'API admin réelle, 2 admins distincts : refus 422/409/401, auto-approbation 409, doublon idempotent, B partielle 200 c + C totale 554 c exécutées chez Stripe (solde pending 5989→5235), statements restent `paid`, 0 créance ; PAS testé : compartiment `available`/solde négatif (SP4 + domaine, Live = REV-05) | FAIT OK (partiel : bucket pending seulement) | evidence `E-reversals` + `E-reversals-CORRECTION` (KO initial = critères de test erronés) |
| F-web | webhooks : doublon, hors ordre, signature invalide, événement inconnu | FAIT OK (avec C) ; reprise après crash du worker webhook : à faire | evidence `C-dispute-webhooks` |
| REC | réconciliation réelle : 1 constat `restaurant` (litige après succès) ; 38 constats `locadely_technical` `stripe_transfer_orphan` = Transferts des spikes SP du 21/09 (autres environnements du Sandbox partagé), AUCUN lié à R90 | FAIT (constat de conception : bruit Sandbox, voir ci-dessous) | evidence `REC-reconciliation`, `REC-orphans-classification` |
| F2 | reprise après crash : reversal Stripe créée puis crash avant écriture DB → reprise sans doublon (1 seule reversal Stripe) ; événement webhook `processing` à bail expiré → repris par le worker API (attempt 2) ; crash débit fait en F ; crash PAYOUT non rejouable (voir limites) | FAIT OK (sauf payout) | evidence `F2-reversal-crash-resume`, `F2-webhook-lease-resume-2` (le 1er essai `F2-webhook-lease-resume` = INFO, worker trop rapide) |
| CFG-03 | 2 PROCESSUS distincts sur le worker de reversals (5 demandes : 3+2 réclamées, 5 identifiants Stripe distincts, 1 reversal/Transfert) ; débits/pay-run en 2 processus non refaits | FAIT OK (reversals) | evidence `CFG-03-two-processes-CORRECTION` (KO initial = seuil de test) |
| H-api | vues livreur/restaurant/admin lues via l'API R90 sur les données de la campagne ; aucune identité légale ni clé interdite | FAIT OK | evidence `H-api-readmodel-CORRECTION`, `H-api-driver-identity-check` |
| G/run4 | restes R31 (lien hébergé, company, pages de retour, Express v2 du Pixel payé par un pay-run) — nouvelle base `settlements_r90` (les périodes du run 3 étaient closes/immuables), 2 vrais comptes livreur `individual`+`company` onboardés dans l'app AVANT les commandes, cycle règlement rejoué, Transfer Stripe réel vérifié = DB au centime (17,30 € individual, 17,98 € company) | FAIT OK (2026-09-22) | evidence `run4-world`, `run4-settle`, `MOB-15-found-and-fixed` |
| H | vérification visuelle sur données R90 (H1 livreur Pixel, H2 restaurant web, H3 admin web) | FAIT OK (2026-09-22), validé entièrement par l'utilisateur | |
| FIN | rapport classé (`docs/work/r90/BILAN-final.md`) ; `drop database` + suppression des comptes Auth R90 (`r90.*`, `livreur3@gmail.com`) ; `admin.dev`/`admin2.dev` conservés (comptes permanents) ; clients web/mobile repointés sur l'API de dev ; base de dev vérifiée propre (`go_live_at` NULL, 0 ligne R90) | FAIT (2026-09-22) | |

## Constats de conception à consigner en checklist (fin de R90)
- WHK-03 : la réconciliation liste TOUS les Transferts Stripe de la plateforme ; un Sandbox partagé entre plusieurs bases produit du bruit (38 orphelins non-R90). Prévoir un marqueur d'environnement en métadonnée des Transferts + filtre, ou limiter la fenêtre ; en production (compte Live dédié) à revérifier.
- Les objets Stripe R90 sont identifiables par leurs COMPTES tagués `run_id` (restaurants = `customer_account`, livreurs = destination) ; les PaymentIntents/Transfers créés par le code applicatif ne portent pas `run_id` (TST-11 à compléter).
- Les identifiants de checklist des lignes `evidence` sont provisoires : correction lors de la consolidation finale.

## Contrôle base de dev (après les scénarios)
Instantané avant/après (`dbsnap`, 36 tables public + pg-boss) : AUCUNE table de commandes/marchands/règlement modifiée, `go_live_at` NULL, 0 ligne R90. Seuls écarts : maintenance pg-boss de l'API de dev, `driver_locations` (GPS de l'app) et `driver_connect_accounts` (cache de synchro du livreur 3333, `last_synced_at` 2026-09-21 22:45:54Z, écrit par l'API de dev / l'app, pas par R90 : le harnais force `settlements_r90` et refuse toute autre base).

## Limites de R90 (à consigner en checklist)
- Crash/reprise du PAYOUT (Transfer créé puis crash avant DB) non rejoué en Sandbox : le calendrier simulé doit rester dans le passé réel et plus aucune période exigible n'a un `payrun_at` passé ; couvert par `driver-payouts.integration.test.ts` (fake). À rejouer avec une base R90 dont go_live_at est plus ancien (ou quand des dates réelles seront écoulées).
- Restriction Stripe réelle du livreur non simulable en Sandbox : état posé en base comme la relecture le ferait.
- E-mails de pré-notification simulés (aucun envoi Resend réel).
- Webhooks livrés par Stripe (destination réelle) non testés : événements signés localement vers la vraie route.

## Constats de méthode (aucun n'est un défaut produit)
- Run 1 abandonné : fixture (gain livreur ≠ price_cents). Run 2 abandonné : calendrier simulé dans le futur réel (gardes PostgreSQL sur `now()` réel).
- `settlement_periods.closed_at` = `now()` réel, pas l'horloge injectée (sans effet sur la simulation).
- Un litige détecté avant le pay-run est journalisé au niveau ERROR (« Debit charge is disputed or refunded… ») : comportement correct, niveau de log à revoir (bruit).
