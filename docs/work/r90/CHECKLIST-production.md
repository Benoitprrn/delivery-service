# R90 — Checklist obligatoire avant production

Extraite le 2026-09-22 de la mémoire projet (`driver-settlement-progress.md`) lors du nettoyage post-R90,
pour la rendre versionnée et durable. Contexte complet : [driver-settlement-plan.md](../driver-settlement-plan.md),
[docs/adr/0004-driver-settlement.md](../../adr/0004-driver-settlement.md), [BILAN-final.md](r90/BILAN-final.md).
Règles de tenue de cette checklist : voir la section "Règles" ci-dessous — jamais de suppression de point,
seulement des mises à jour de statut/preuve.

## Checklist obligatoire avant production

**Section PERMANENTE** (créée le 2026-09-21, à partir de la relecture complète du plan, de la mémoire, de l'ADR 0004, de SP1–SP7 et de R00–R70). Elle recense tout ce qui est INCONNU, validé seulement en Sandbox, simulé, reporté, non testé (Pixel, `company`, vrais délais bancaires), désactivé par configuration, à configurer (Stripe/Resend), à confirmer juridiquement/comptablement, intermittent, en dette technique ou manquant. **R90 = validation finale ACTUELLE (Sandbox / données de test, app de dev sur le Pixel) ; R91 et le passage en production sont REPORTÉS (D-Q), mais cette checklist reste la référence d'un futur passage live.**

**Règles (à ne jamais enfreindre)** :
- Ne JAMAIS supprimer un point, même si une étape ultérieure (R80, R90…) est terminée. Un point ne passe à `TERMINÉ` qu'avec la PREUVE décrite dans « Terminé quand » (capture, sortie de test, log, avis écrit, référence de commit), consignée dans la ligne « Preuve » du point ET dans le journal ci-dessous.
- Le contenu d'un point peut être précisé, jamais effacé : si une hypothèse change, garder l'ancien texte sous « Historique » du point ou dans le journal.
- Ajouter tout nouveau point découvert (nouvel identifiant à la suite de la catégorie). Un point `REPORTÉ` reste dans la liste avec sa raison.
- États : `À TESTER LIVE` (jamais vérifié en live) · `À RETESTER` (validé partiellement ou avant un changement) · `À TESTER` (jamais exercé) · `À CONFIGURER` · `À ACTIVER` (worker/flag) · `À DÉVELOPPER` · `À DÉCIDER` · `À CONFIRMER STRIPE` · `À VALIDER JURIDIQUEMENT` / `COMPTABLEMENT` · `À NETTOYER` · `À CORRIGER` · `À FAIRE` · `À SURVEILLER` · `À CONSERVER` (règle permanente) · `REPORTÉ` · `TERMINÉ` (avec preuve). `[CRITIQUE]` = empêche aujourd'hui un passage en production.

**Tableau de bord (2026-09-22, R90 en cours) : 144 points au total dont 5 TERMINÉ (REV-06 dev/Sandbox ; MOB-15 corrigé ; MOB-03, MOB-02, MOB-04 dev/Sandbox) ; 139 ouverts, 56 critiques ouverts.**

| Catégorie | Points ouverts | dont critiques |
|---|---|---|
| Stripe / Connect (`STR`) | 20 | 8 |
| SEPA restaurants (`SEPA`) | 17 | 9 |
| Paiements et payouts livreurs (`PAY`) | 13 | 4 |
| Reversals (`REV`) | 8 | 4 |
| Webhooks et réconciliation (`WHK`) | 9 | 2 |
| Application mobile (livreur) (`MOB`) | 11 | 3 |
| Application restaurant / admin (web) (`WEB`) | 9 | 3 |
| Workers / configuration / secrets (`CFG`) | 12 | 4 |
| Tests et validation (`TST`) | 14 | 4 |
| Juridique / comptabilité / RGPD (`LEG`) | 15 | 9 |
| Données et passage Sandbox → Live (`DAT`) | 11 | 6 |
| **Total** | **139** | **56** |

### Stripe / Connect (`STR`)

- **STR-01 [CRITIQUE] · À TESTER LIVE** — *Origine :* SP5, D-G, D-H, R30.
  - *À faire / vérifier :* Comptes livreurs Accounts v2 `recipient` Express (`dashboard=express`, fees/losses `application`) : activation Connect + Accounts v2 en mode LIVE pour la plateforme, création d'un vrai compte livreur, onboarding complet, `stripe_transfers` = `active`. Tout a été validé en Sandbox uniquement.
  - *Terminé quand (preuve requise) :* Un compte livreur LIVE réel atteint `transfers_status = active` (relu chez Stripe) et reçoit un Transfer réel ; capture/logs conservés.
  - *Statut :* OUVERT · *Preuve :* aucune · *Historique :* créé le 2026-09-21.
- **STR-02 [CRITIQUE] · À TESTER LIVE + À CONFIRMER STRIPE** — *Origine :* SP1(2), R50 (`DEBIT_START_LOCAL_HOUR = 8`), plan §6.
  - *À faire / vérifier :* Délai LIVE entre la création du PaymentIntent SEPA et la soumission bancaire (création du `balance_transaction`) ; cut-off 10:30 CET (fuseau exact non confirmé). Vérifier qu'un débit créé à 08:00 Paris part bien le jour annoncé ; sinon décaler l'heure de démarrage.
  - *Terminé quand (preuve requise) :* Confirmation écrite Stripe du cut-off + un débit live créé à 08:00 dont la soumission est constatée le jour annoncé ; constante ajustée si besoin.
  - *Statut :* OUVERT · *Preuve :* aucune · *Historique :* créé le 2026-09-21.
- **STR-03 [CRITIQUE] · À TESTER LIVE** — *Origine :* SP1(4), D-N, R40 (`payrun_delay_business_days = 7`).
  - *À faire / vérifier :* Vrais délais SEPA : succès à T+6 jours ouvrés (00:00 UTC), fenêtre de refus 5 jours ouvrés, `available_on` réel des fonds. Sandbox : succès en 20 s–6 min et `available_on` ≈ +7 jours calendaires, donc NON représentatif. Mesurer T+n réel et confirmer que `payrun_at` (7ᵉ jour ouvré après le débit) tombe APRÈS le succès ; ajuster le paramètre sinon.
  - *Terminé quand (preuve requise) :* Tableau mesuré (soumission, succès, `available_on`, arrivée bancaire) sur au moins un débit live ; `payrun_at` validé ou ajusté ; promesse 15 jours ouvrés confirmée.
  - *Statut :* OUVERT · *Preuve :* aucune · *Historique :* créé le 2026-09-21.
- **STR-04 · À TESTER LIVE** — *Origine :* SP1(4), SP3(1).
  - *À faire / vérifier :* `source_type` des fonds SEPA en live (Sandbox : `card`). Sans effet tant qu'aucune avance n'existe (D-M), mais à constater.
  - *Terminé quand (preuve requise) :* Solde live observé et consigné (`source_type` des fonds SEPA).
  - *Statut :* OUVERT · *Preuve :* aucune · *Historique :* créé le 2026-09-21.
- **STR-05 · À TESTER LIVE** — *Origine :* SP1(1).
  - *À faire / vérifier :* Comportement live après `succeeded` : la charge a toujours un `balance_transaction` ; l'erreur 400 « null balance_transaction » ne doit jamais apparaître ; R60 laisse le statement en attente (`debit_recheck_processing`) si le bt manque.
  - *Terminé quand (preuve requise) :* Aucune occurrence en live sur les débits réussis, ou occurrence traitée sans perte.
  - *Statut :* OUVERT · *Preuve :* aucune · *Historique :* créé le 2026-09-21.
- **STR-06 [CRITIQUE] · À CONFIRMER STRIPE + À CONFIGURER** — *Origine :* SP2, SP3(6), SP4(5), plan §6.
  - *À faire / vérifier :* Solde plateforme négatif : échec SEPA = −montant −3,50 € ; litige = −montant −15 € ; `debit_negative_balances: true` observé sur le compte plateforme = Stripe débite le compte bancaire de la plateforme. Confirmer par écrit, provisionner la trésorerie, vérifier le compte bancaire de débit.
  - *Terminé quand (preuve requise) :* Confirmation écrite Stripe + trésorerie/compte bancaire dimensionnés + décision comptable de provision.
  - *Statut :* OUVERT · *Preuve :* aucune · *Historique :* créé le 2026-09-21.
- **STR-07 · À DÉCIDER + À CONFIGURER** — *Origine :* SP3(6), D-M.
  - *À faire / vérifier :* Paramètres de payouts de la plateforme (payouts automatiques hebdomadaires le lundi, `delay_days 7`, aucun solde minimum) : depuis D-M aucun buffer n'est requis, mais choisir explicitement le réglage live (versement automatique de la trésorerie ou non).
  - *Terminé quand (preuve requise) :* Réglages live relevés dans le Dashboard, décision consignée.
  - *Statut :* OUVERT · *Preuve :* aucune · *Historique :* créé le 2026-09-21.
- **STR-08 [CRITIQUE] · À CONFIRMER STRIPE + À DÉVELOPPER** — *Origine :* plan §6 (plafond SEPA).
  - *À faire / vérifier :* Plafond SEPA Direct Debit ≈ 10 000 €/semaine (à confirmer) : aucune garde en code. Un règlement restaurant au-dessus du plafond serait rejeté/limité par Stripe (erreur technique). Ajouter contrôle/alerte avant création du PaymentIntent si le plafond est confirmé.
  - *Terminé quand (preuve requise) :* Plafond confirmé par écrit + garde ou alerte codée et testée (règlement > plafond).
  - *Statut :* OUVERT · *Preuve :* aucune · *Historique :* créé le 2026-09-21.
- **STR-09 · À CONFIRMER STRIPE** — *Origine :* SP2(5), plan §6.
  - *À faire / vérifier :* Tarification réelle : frais SEPA (0,35 € observé), échec 3,50 €, litige 15 €, Express/Connect (≈ 2 €/compte actif/mois + 0,25 % + 0,10 €/payout, indicatif). Vérifier le contrat live.
  - *Terminé quand (preuve requise) :* Grille tarifaire confirmée et reportée dans le modèle de coût/comptabilité.
  - *Statut :* OUVERT · *Preuve :* aucune · *Historique :* créé le 2026-09-21.
- **STR-10 [CRITIQUE] · À CONFIGURER** — *Origine :* R41, CLAUDE.md (créancier), SP6.
  - *À faire / vérifier :* Activer SEPA Direct Debit en LIVE (peut exiger l'approbation de Stripe) ; choisir le nom visible sur le relevé bancaire du restaurant / descripteur de la plateforme ; vérifier que l'identifiant créancier affiché est celui de Stripe et n'est jamais présenté comme celui de Locadely.
  - *Terminé quand (preuve requise) :* Un débit live montre le nom/descripteur attendu sur un vrai relevé ; SEPA live activé.
  - *Statut :* OUVERT · *Preuve :* aucune · *Historique :* créé le 2026-09-21.
- **STR-11 [CRITIQUE] · À CONFIGURER** — *Origine :* R41, R70 (webhooks), SP7.
  - *À faire / vérifier :* Destinations d'événements Stripe : (a) plateforme `/api/v1/webhooks/stripe` doit s'abonner à `payment_intent.processing|succeeded|payment_failed|canceled|requires_action`, `charge.pending|succeeded|failed|updated|refunded`, `charge.dispute.created|updated|closed|funds_withdrawn|funds_reinstated`, `transfer.created|updated|reversed` (+ les événements SEPA/mandat existants) ; (b) Connect/v2 (« Votre compte / Léger ») pour `v2.core.account[...]`. Secrets distincts test/live, plusieurs secrets séparés par des virgules dans `STRIPE_CONNECT_WEBHOOK_SECRET`.
  - *Terminé quand (preuve requise) :* Livraison réelle d'au moins un événement de chaque famille, signature validée, événement `processed` dans `settlement_stripe_events` / `stripe_connect_webhook_events`.
  - *Statut :* OUVERT · *Preuve :* aucune · *Historique :* créé le 2026-09-21.
- **STR-12 · À TESTER** — *Origine :* SP5(4)(c), R60 (annotation).
  - *À faire / vérifier :* Affichage, dans le Dashboard Express du livreur, de la description/métadonnées de chaque paiement de destination (annotation `charges.update`). Vérifié côté API seulement.
  - *Terminé quand (preuve requise) :* Capture du Dashboard Express montrant la description « Locadely — livraisons du … ».
  - *Statut :* OUVERT · *Preuve :* aucune · *Historique :* créé le 2026-09-21.
- **STR-13 [CRITIQUE] · À TESTER LIVE** — *Origine :* SP5 (a), D-F, R60.
  - *À faire / vérifier :* Express live : `identity.individual.documents.primary_verification` restait `eventually_due` en Sandbox ; en live la pièce d'identité sera réclamée et le compte peut passer `restricted`. Vérifier bout en bout : livreur restreint → aucune course, gains dus mais bloqués (`blocked_driver_account`), versés après régularisation.
  - *Terminé quand (preuve requise) :* Restriction live réelle (ou forcée par Stripe en test) observée, statement bloqué puis payé après régularisation, preuve DB + Stripe.
  - *Statut :* OUVERT · *Preuve :* aucune · *Historique :* créé le 2026-09-21.
- **STR-14 · À RETESTER** — *Origine :* SP5(d), R31.
  - *À faire / vérifier :* Composants embarqués RN Connect (onboarding, Payouts, Payments) : statut bêta/bugs connus du SDK `@stripe/stripe-react-native` 0.77.0 ; surveiller mises à jour.
  - *Terminé quand (preuve requise) :* Versions figées et re-test sur Pixel après toute mise à jour du SDK.
  - *Statut :* OUVERT · *Preuve :* aucune · *Historique :* créé le 2026-09-21.
- **STR-15 · À TESTER LIVE + À CONFIRMER STRIPE** — *Origine :* SP5(5).
  - *À faire / vérifier :* `settlement_timing.delay_days` des comptes livreurs (7 jours minimum Sandbox) : impact live sur le délai payout (attendu ≈ J+1 après `available_on`). `debit_negative_balances: true` par défaut sur Express v2 = Stripe pourrait débiter la banque du livreur (cf. REV-05).
  - *Terminé quand (preuve requise) :* Délai constaté (Transfer → arrivée bancaire) sur un livreur live + réponse Stripe consignée.
  - *Statut :* OUVERT · *Preuve :* aucune · *Historique :* créé le 2026-09-21.
- **STR-16 · À DÉCIDER** — *Origine :* SP5, plan §3 (payout observations).
  - *À faire / vérifier :* Mapping payout ↔ Transfer : non prouvé ; seules des observations de payouts au niveau du compte livreur existent. Décider si « versé sur votre compte bancaire » est affiché à partir du niveau compte (`arrival_date`) ou d'un mapping.
  - *Terminé quand (preuve requise) :* Décision consignée + affichage conforme (R80) validé sur données réelles.
  - *Statut :* OUVERT · *Preuve :* aucune · *Historique :* créé le 2026-09-21.
- **STR-17 · REPORTÉ** — *Origine :* SP3, D-M.
  - *À faire / vérifier :* Top-up EUR France (bêta privée UE), solde minimum plateforme, `platform_advance` : NON requis depuis D-M ; mécanisme exceptionnel non implémenté. À réévaluer seulement si une avance est décidée.
  - *Terminé quand (preuve requise) :* Décision explicite de non-besoin conservée ; réouverture uniquement si une avance est décidée.
  - *Statut :* OUVERT · *Preuve :* aucune · *Historique :* créé le 2026-09-21.
- **STR-18 · À RETESTER** — *Origine :* R50 (cast `customer_account`).
  - *À faire / vérifier :* Le SDK `stripe` n'a pas `customer_account` dans les types de `PaymentIntentCreateParams` : cast documenté. Vérifier après chaque montée de version et retirer le cast quand possible.
  - *Terminé quand (preuve requise) :* Cast supprimé ou justifié par version ; tests R50 verts.
  - *Statut :* OUVERT · *Preuve :* aucune · *Historique :* créé le 2026-09-21.
- **STR-19 · À TESTER LIVE** — *Origine :* R50/R60 (détection `livemode`).
  - *À faire / vérifier :* `livemode` est déduit du préfixe de clé (`sk_live_`/`rk_live_`) ; contrôle de cohérence objets ↔ clé dans le domaine et en base. Vérifier avec les clés live réelles (y compris clés restreintes).
  - *Terminé quand (preuve requise) :* Un run live complet sans divergence `livemode` ; garde testée avec une clé restreinte.
  - *Statut :* OUVERT · *Preuve :* aucune · *Historique :* créé le 2026-09-21.
- **STR-20 · À TESTER** — *Origine :* R70 (réconciliation), Stripe rate limits.
  - *À faire / vérifier :* Volumétrie : la réconciliation lit jusqu'à 500 débits + 500 Transferts + 1000 Transferts Stripe récents + soldes/payouts par livreur ; vérifier limites de débit Stripe et durée à l'échelle réelle.
  - *Terminé quand (preuve requise) :* Run de réconciliation sur un volume représentatif sans erreur de limite ni dépassement de fenêtre.
  - *Statut :* OUVERT · *Preuve :* aucune · *Historique :* créé le 2026-09-21.

### SEPA restaurants (`SEPA`)

- **SEPA-01 [CRITIQUE] · À TESTER LIVE + À CONFIRMER STRIPE** — *Origine :* SP6, R41.
  - *À faire / vérifier :* Pré-notification : Stripe enverra son propre e-mail à la création du PaymentIntent (mercredi) EN PLUS du nôtre (lundi) : doublon possible. Confirmer ce que Stripe envoie, à qui (destinataire des e-mails SEPA), quand, avec quel contenu ; décider si on désactive/accepte le doublon.
  - *Terminé quand (preuve requise) :* Réponse écrite Stripe + observation d'un cycle live complet (e-mails reçus) + décision consignée.
  - *Statut :* OUVERT · *Preuve :* aucune · *Historique :* créé le 2026-09-21.
- **SEPA-02 [CRITIQUE] · À VALIDER JURIDIQUEMENT** — *Origine :* R41, SP6, plan §6.
  - *À faire / vérifier :* Délai et forme de la pré-notification : Locadely applique 2 jours calendaires (≥ 2 jours avant, date annoncée) ; la règle SEPA par défaut est plus longue sauf accord (le mandat Stripe annonce « jusqu'à 2 jours »). Faire valider le délai, le contenu et le canal.
  - *Terminé quand (preuve requise) :* Avis juridique écrit ; texte de l'e-mail et délai finalisés.
  - *Statut :* OUVERT · *Preuve :* aucune · *Historique :* créé le 2026-09-21.
- **SEPA-03 [CRITIQUE] · À CONFIGURER** — *Origine :* R41, CLAUDE.md.
  - *À faire / vérifier :* `SEPA_CREDITOR_ID` : obtenir l'identifiant créancier SEPA live fourni par Stripe et le renseigner ; s'assurer qu'il est présenté comme identifiant du prestataire de paiement, jamais comme celui de Locadely. Le worker de pré-notification refuse de démarrer sans lui.
  - *Terminé quand (preuve requise) :* Variable renseignée en live ; e-mail live contenant la bonne valeur ; validation croisée avec Stripe.
  - *Statut :* OUVERT · *Preuve :* aucune · *Historique :* créé le 2026-09-21.
- **SEPA-04 [CRITIQUE] · À TESTER + À CONFIGURER** — *Origine :* R41.
  - *À faire / vérifier :* Resend réel jamais exercé (tests avec faux expéditeur / `fetch` simulé) : créer/vérifier le domaine d'envoi (SPF/DKIM), `RESEND_API_KEY`, `RESEND_FROM_EMAIL`, `SETTLEMENT_SUPPORT_EMAIL` ; envoyer une vraie pré-notification ; vérifier délivrabilité, clé d'idempotence (`Idempotency-Key`), gestion d'échec.
  - *Terminé quand (preuve requise) :* E-mail réel reçu (boîte de test puis réelle), en-têtes/DKIM valides, aucun doublon sur retry.
  - *Statut :* OUVERT · *Preuve :* aucune · *Historique :* créé le 2026-09-21.
- **SEPA-05 · À TESTER** — *Origine :* R41 (Supabase Auth admin `getUserEmail`).
  - *À faire / vérifier :* L'e-mail du restaurant est lu via l'API admin Supabase Auth (`/auth/v1/admin/users/{id}`), jamais testé contre un vrai Supabase (typé seulement).
  - *Terminé quand (preuve requise) :* Lecture réelle de l'e-mail d'un restaurant de test réussie dans un cycle de pré-notification.
  - *Statut :* OUVERT · *Preuve :* aucune · *Historique :* créé le 2026-09-21. ; 2026-09-22 (R90) : R90 a utilisé un lecteur de destinataire simulé et un e-mail simulé : la lecture réelle Supabase Auth admin `getUserEmail` n'a pas été exercée → reste ouvert
- **SEPA-06 [CRITIQUE] · À VALIDER JURIDIQUEMENT + À DÉVELOPPER** — *Origine :* R41, plan §6.
  - *À faire / vérifier :* Le texte de l'e-mail ne mentionne pas le droit de contestation/remboursement SEPA (délais 8 semaines / 13 mois) ; le contenu minimal (4 derniers caractères IBAN, référence de mandat, montant, identifiant créancier, date, contact) est en place. Faire valider et compléter.
  - *Terminé quand (preuve requise) :* Texte validé juridiquement, tests de contenu mis à jour, e-mail live relu.
  - *Statut :* OUVERT · *Preuve :* aucune · *Historique :* créé le 2026-09-21.
- **SEPA-07 · À DÉVELOPPER** — *Origine :* R70 (relance).
  - *À faire / vérifier :* L'e-mail de pré-notification d'une relance est identique à celui d'une première tentative (aucune mention « nouvelle présentation »).
  - *Terminé quand (preuve requise) :* Objet/texte adapté à la tentative N>1, testé.
  - *Statut :* OUVERT · *Preuve :* aucune · *Historique :* créé le 2026-09-21.
- **SEPA-08 [CRITIQUE] · À DÉVELOPPER + À DÉCIDER** — *Origine :* D-K, D-D, R20.
  - *À faire / vérifier :* Blocage manuel d'un restaurant en impayé NON construit : la garde D-D n'exige que mandat SEPA actif + informations complètes ; un restaurant dont le débit a échoué ou qui a un litige ouvert peut continuer à commander. Décider la règle (blocage manuel/automatique) et fournir l'outil.
  - *Terminé quand (preuve requise) :* Règle décidée, outil admin livré, garde testée (commande refusée pour un restaurant bloqué).
  - *Statut :* OUVERT · *Preuve :* aucune · *Historique :* créé le 2026-09-21.
- **SEPA-09 · REPORTÉ** — *Origine :* D-O, ADR 0004.
  - *À faire / vérifier :* Relance/recouvrement/mise en demeure par Locadely d'un restaurant impayé : hors périmètre (le livreur engage lui-même la mise en demeure). Seules les données/états sont conservés.
  - *Terminé quand (preuve requise) :* Chantier ultérieur ouvert et livré, ou décision de ne jamais le faire consignée.
  - *Statut :* OUVERT · *Preuve :* aucune · *Historique :* créé le 2026-09-21.
- **SEPA-10 [CRITIQUE] · À DÉVELOPPER** — *Origine :* SP2(5), plan §3, R70.
  - *À faire / vérifier :* Frais Stripe d'échec SEPA (3,50 €) et de litige (15 €) supportés par Locadely NON enregistrés en `merchant_receivables` (seul le principal contesté/remboursé l'est).
  - *Terminé quand (preuve requise) :* Créances de frais créées à partir des balance transactions, testées Sandbox puis observées en live.
  - *Statut :* OUVERT · *Preuve :* aucune · *Historique :* créé le 2026-09-21.
- **SEPA-11 [CRITIQUE] · À VALIDER + À DÉVELOPPER** — *Origine :* R70 (réconciliation 60 jours), SEPA.
  - *À faire / vérifier :* Fenêtre de contestation SEPA jusqu'à 13 mois (débit non autorisé) : les webhooks couvrent tout litige futur, mais la réconciliation ne regarde que 60 jours ; les incidents tardifs après paiement du livreur restent à la charge de Locadely (D-O).
  - *Terminé quand (preuve requise) :* Fenêtre de réconciliation/alerte décidée et implémentée ; provision comptable arbitrée.
  - *Statut :* OUVERT · *Preuve :* aucune · *Historique :* créé le 2026-09-21.
- **SEPA-12 [CRITIQUE] · À DÉVELOPPER** — *Origine :* R50, R70.
  - *À faire / vérifier :* `debit_blocked_reason` (`mandate_changed`, `no_active_sepa_method`, `debit_guard_refused`), tentatives `technical_error` et règlements `technical_hold` n'ont AUCUNE alerte ni écran : ils ne sont visibles qu'en base/logs. Résolution = relance manuelle uniquement.
  - *Terminé quand (preuve requise) :* Liste/alerte admin de ces états + procédure de résolution testée.
  - *Statut :* OUVERT · *Preuve :* aucune · *Historique :* créé le 2026-09-21.
- **SEPA-13 · À TESTER LIVE** — *Origine :* R50.
  - *À faire / vérifier :* Un débit créé après le cut-off part le jour ouvré suivant : la date réelle peut dépasser la date annoncée dans la pré-notification (jamais avant). Vérifier l'écart en live.
  - *Terminé quand (preuve requise) :* Écart mesuré/accepté ; texte de pré-notification adapté si nécessaire.
  - *Statut :* OUVERT · *Preuve :* aucune · *Historique :* créé le 2026-09-21.
- **SEPA-14 · À TESTER** — *Origine :* R50.
  - *À faire / vérifier :* Montant minimal Stripe (EUR 0,50 € pour les paiements, à confirmer pour SEPA) : un règlement restaurant inférieur serait probablement refusé par Stripe (erreur technique `technical_error`). Décider du traitement (cumul sur la semaine suivante, seuil).
  - *Terminé quand (preuve requise) :* Règle décidée + test Sandbox d'un règlement < 0,50 €.
  - *Statut :* OUVERT · *Preuve :* aucune · *Historique :* créé le 2026-09-21.
- **SEPA-15 · À TESTER LIVE** — *Origine :* R50.
  - *À faire / vérifier :* Échecs réels de banque (codes retour SEPA, fonds insuffisants, compte clos, refus tardif après plusieurs jours) : Sandbox n'expose que des échecs simulés (`incorrect_account_holder_name`).
  - *Terminé quand (preuve requise) :* Au moins un échec live observé avec son code, correctement classé `failed`.
  - *Statut :* OUVERT · *Preuve :* aucune · *Historique :* créé le 2026-09-21.
- **SEPA-16 · À RETESTER** — *Origine :* R50, R70, paiements SEPA existants.
  - *À faire / vérifier :* Changement de mandat/moyen de paiement du restaurant (détachement différé `detach_pending`) entre pré-notification et débit : Sandbox validé côté serveur (script) ; à rejouer via l'UI web « Moyen de paiement » avec un débit programmé.
  - *Terminé quand (preuve requise) :* Scénario complet UI web (changement de mandat → blocage → relance → nouveau mandat cité → débit) observé.
  - *Statut :* OUVERT · *Preuve :* aucune · *Historique :* créé le 2026-09-21.
- **SEPA-17 · À TESTER** — *Origine :* R41.
  - *À faire / vérifier :* Date annoncée reportée en cas d'envoi tardif (`announcedDebitDate`, jours fériés FR ∪ TARGET) : validé en unitaire ; à observer sur un vrai retard/retry de Resend.
  - *Terminé quand (preuve requise) :* Pré-notification tardive réelle avec date décalée correcte.
  - *Statut :* OUVERT · *Preuve :* aucune · *Historique :* créé le 2026-09-21.

### Paiements et payouts livreurs (`PAY`)

- **PAY-01 [CRITIQUE] · À RETESTER** — *Origine :* R60, SP5.
  - *À faire / vérifier :* R60 n'a été exercé en Sandbox qu'avec des comptes livreurs Custom v1 jetables (mécanique d'argent identique). Rejouer avec un vrai compte Express v2 `recipient` onboardé (celui du Pixel) : Transfer `source_transaction`, relecture d'état par `ProviderDriverAccountLiveReader` (API v2), annotation.
  - *Terminé quand (preuve requise) :* Pay-run groupé + drip payés sur le compte Express v2 du Pixel, visible dans son Dashboard.
  - *Statut :* OUVERT · *Preuve :* aucune · *Historique :* créé le 2026-09-21. ; 2026-09-22 (R90) : R90 = comptes livreurs Custom v1 (mécanique d'argent identique) : 20 Transferts `source_transaction` + annotation ; Express v2 `recipient` du Pixel NON rejoué → reste ouvert (scénario G)
- **PAY-02 [CRITIQUE] · À TESTER** — *Origine :* D-P, R30, R31.
  - *À faire / vérifier :* Parcours `company` (SASU/EURL) JAMAIS testé : onboarding (KYB), capacités, Transfers, payouts, gestion `entity_type` verrouillé après choix.
  - *Terminé quand (preuve requise) :* Un compte `company` de test onboardé (Pixel), payé par un pay-run, état lu correctement.
  - *Statut :* OUVERT · *Preuve :* aucune · *Historique :* créé le 2026-09-21. ; 2026-09-22 (R90) : parcours `company` non rejoué en R90 (scénario G, utilisateur) → reste ouvert
- **PAY-03 · À TESTER LIVE** — *Origine :* SP5, R60.
  - *À faire / vérifier :* Délais bancaires réels des payouts (`delay_days`, `arrival_date`, payout quotidien), payouts bloqués si `available` < 0.
  - *Terminé quand (preuve requise) :* Délai Transfer → banque mesuré sur un livreur live.
  - *Statut :* OUVERT · *Preuve :* aucune · *Historique :* créé le 2026-09-21.
- **PAY-04 · À DÉCIDER + À DÉVELOPPER** — *Origine :* R70, SP5.
  - *À faire / vérifier :* Payouts observés uniquement par polling quotidien (`payouts.list`) : pas de webhook Connect `payout.*` ; « versé » côté livreur dépend de ce polling.
  - *Terminé quand (preuve requise) :* Décision (polling suffisant ou webhook) + affichage validé.
  - *Statut :* OUVERT · *Preuve :* aucune · *Historique :* créé le 2026-09-21.
- **PAY-05 [CRITIQUE] · À DÉVELOPPER** — *Origine :* R60.
  - *À faire / vérifier :* Transfer refusé 20 fois → `payout_next_attempt_at = infinity`, `payout_hold_reason = transfer_retries_exhausted` : aucun outil pour relancer ; de même `transfer_mismatch`, `transfer_refused_by_guards`, `debit_recheck_*` (visibles seulement en base/logs).
  - *Terminé quand (preuve requise) :* Vue admin de ces blocages + action de reprise testée.
  - *Statut :* OUVERT · *Preuve :* aucune · *Historique :* créé le 2026-09-21. ; 2026-09-22 (R90) : vue admin des statements bloqués présente (`blockedStatements`, R80) et exercée (D5 `blocked_driver_account`, R8 `debit_incident`) ; aucune ACTION de reprise → reste ouvert
- **PAY-06 [CRITIQUE] · À DÉVELOPPER** — *Origine :* plan §3 (append-only).
  - *À faire / vérifier :* Corrections du ledger : « ajustement approuvé dans la période suivante » NON construit ; un Transfer trop FAIBLE (erreur Locadely) n'a pas de chemin de correction (une reversal ne suffit pas).
  - *Terminé quand (preuve requise) :* Mécanisme d'ajustement/complément spécifié, développé et testé.
  - *Statut :* OUVERT · *Preuve :* aucune · *Historique :* créé le 2026-09-21.
- **PAY-07 · À DÉVELOPPER** — *Origine :* D-N, plan §2.
  - *À faire / vérifier :* Promesse « 15 jours ouvrés après la clôture » : aucune supervision ni alerte de dépassement d'échéance (`promise_deadline`).
  - *Terminé quand (preuve requise) :* Alerte/rapport des statements encaissés non payés après l'échéance, testé.
  - *Statut :* OUVERT · *Preuve :* aucune · *Historique :* créé le 2026-09-21.
- **PAY-08 · À TESTER** — *Origine :* R60.
  - *À faire / vérifier :* Livreur restreint réellement par Stripe en cours de cycle : Sandbox simulé en modifiant l'état local/live-reader ; à provoquer réellement (exigence past_due) et vérifier le blocage puis la reprise.
  - *Terminé quand (preuve requise) :* Blocage puis versement après régularisation observés avec un vrai compte.
  - *Statut :* OUVERT · *Preuve :* aucune · *Historique :* créé le 2026-09-21.
- **PAY-09 · À TESTER** — *Origine :* R60.
  - *À faire / vérifier :* Résultat inconnu d'un Transfer (>23 h) et reprise par recherche `transfer_group` + `metadata.driver_transfer_id` : simulé seulement ; `transfers.list` limité à 100 par groupe.
  - *Terminé quand (preuve requise) :* Reprise réelle après coupure (kill -9) sans doublon.
  - *Statut :* OUVERT · *Preuve :* aucune · *Historique :* créé le 2026-09-21.
- **PAY-10 · À VALIDER** — *Origine :* R11, R40.
  - *À faire / vérifier :* Calendrier des jours ouvrés (FR ∪ TARGET) codé en dur : vérifier contre le calendrier TARGET/Banque de France, années suivantes, passages heure d'été/hiver.
  - *Terminé quand (preuve requise) :* Comparaison avec calendrier officiel sur 2 ans + tests DST autour des changements d'heure.
  - *Statut :* OUVERT · *Preuve :* aucune · *Historique :* créé le 2026-09-21.
- **PAY-11 · À NETTOYER + À DOCUMENTER** — *Origine :* R20, D-F.
  - *À faire / vérifier :* Depuis R20, un livreur sans compte de paiement Stripe prêt ne voit AUCUNE course : les livreurs de test existants doivent configurer leur compte.
  - *Terminé quand (preuve requise) :* Liste des livreurs de test à jour, procédure d'initialisation documentée.
  - *Statut :* OUVERT · *Preuve :* aucune · *Historique :* créé le 2026-09-21.
- **PAY-12 · À TESTER** — *Origine :* R60, R90.
  - *À faire / vérifier :* Passage à l'échelle : 5 livreurs × plusieurs restaurants, 2 workers en parallèle réels (processus distincts), crash/reprise réels.
  - *Terminé quand (preuve requise) :* Scénarios R90 verts avec processus distincts.
  - *Statut :* OUVERT · *Preuve :* aucune · *Historique :* créé le 2026-09-21.
- **PAY-13 · À DÉVELOPPER** — *Origine :* R80.
  - *À faire / vérifier :* L'estimation de la semaine en cours lit `listSettleableOrders` pour TOUS les livreurs puis filtre : à remplacer par une lecture par livreur avant tout volume réel.
  - *Terminé quand (preuve requise) :* Requête par livreur livrée, mesure de performance.
  - *Statut :* OUVERT · *Preuve :* aucune · *Historique :* créé le 2026-09-21 (R80).

### Reversals (`REV`)

- **REV-01 [CRITIQUE] · À TESTER LIVE** — *Origine :* SP4, R61.
  - *À faire / vérifier :* Cas « livreur déjà payé » (fonds `available` déjà versés en banque) jamais exercé réellement : Sandbox ne peut pas créer de fonds disponibles via `source_transaction` (available_on ≈ +7 j). Validé par domaine + PostgreSQL + comportement Stripe connu (SP4) seulement.
  - *Terminé quand (preuve requise) :* Reversal live sur fonds déjà versés : reversé = 0, créance = montant, aucun solde négatif provoqué.
  - *Statut :* OUVERT · *Preuve :* aucune · *Historique :* créé le 2026-09-21. ; 2026-09-22 (R90) : compartiment `pending` seulement (Sandbox ne crée pas de fonds `available`) : reversals B partielle et C totale exécutées, crash+reprise sans doublon ; cas « livreur déjà payé / solde négatif » NON exercé → reste ouvert
- **REV-02 · À TESTER LIVE** — *Origine :* R61 (`fundsBucket`).
  - *À faire / vérifier :* Le compartiment pending/available est déduit de `debit_attempts.available_on` (approximation). Vérifier contre les soldes réels du livreur en live (pending vs available).
  - *Terminé quand (preuve requise) :* Cas réels où l'hypothèse tient, ou règle corrigée.
  - *Statut :* OUVERT · *Preuve :* aucune · *Historique :* créé le 2026-09-21. ; 2026-09-22 (R90) : `funds_bucket = pending` cohérent avec le solde Stripe réel (pending 5989 → 5235 c après 754 c reversés, available 0) ; hypothèse `available` non testable en Sandbox
- **REV-03 [CRITIQUE] · À VALIDER JURIDIQUEMENT** — *Origine :* SP4(5), plan §3.
  - *À faire / vérifier :* Compensation automatique de Stripe : un solde négatif du livreur est repris sur ses futurs Transfers (contradiction avec « pas de compensation auto »). Décider si acceptable ; sinon éviter tout solde négatif (déjà le cas côté Locadely : `allowNegativeBalance` jamais activé).
  - *Terminé quand (preuve requise) :* Avis juridique écrit + configuration `debit_negative_balances` décidée.
  - *Statut :* OUVERT · *Preuve :* aucune · *Historique :* créé le 2026-09-21.
- **REV-04 [CRITIQUE] · À DÉVELOPPER + À DÉCIDER** — *Origine :* R61.
  - *À faire / vérifier :* Recouvrement des `driver_receivables` : aucun outil (recouvrement, abandon, compensation) ; les créances restent `open`.
  - *Terminé quand (preuve requise) :* Procédure et outil (ou décision de gestion manuelle) livrés et testés.
  - *Statut :* OUVERT · *Preuve :* aucune · *Historique :* créé le 2026-09-21.
- **REV-05 [CRITIQUE] · À TESTER LIVE + À VALIDER** — *Origine :* SP5(5), R61.
  - *À faire / vérifier :* Express v2 : `debit_negative_balances: true` par défaut = Stripe peut débiter le compte bancaire du livreur en cas de solde négatif. Vérifier l'effet réel et l'information/consentement du livreur.
  - *Terminé quand (preuve requise) :* Comportement live observé + information contractuelle validée.
  - *Statut :* OUVERT · *Preuve :* aucune · *Historique :* créé le 2026-09-21.
- **REV-06 [CRITIQUE] · TERMINÉ EN DEV/SANDBOX** — *Origine :* R61, R70.
  - *À faire / vérifier :* Aucune API/UI admin pour demander, approuver, rejeter une reversal ni consulter les créances ; cas d'usage prêts, aucun compte `admin` créé ; les identifiants demandeur/approbateur sont de simples UUID.
  - *Terminé quand (preuve requise) :* Endpoints/écran admin livrés, comptes admin distincts, double approbation testée avec JWT réels.
  - *Statut :* TERMINÉ EN DEV/SANDBOX (2026-09-22) — API admin + double approbation prouvées avec 2 JWT admin réels ; écran admin à voir en H ; comptes admin de production = WEB-09 · *Preuve :* evidence `E-reversals` (+ CORRECTION) : refus 422/409/401, auto-approbation 409 SameApprover, approbation par un 2ᵉ admin, rejet, exécution Stripe réelle · *Historique :* créé le 2026-09-21.
- **REV-07 · À DÉCIDER** — *Origine :* plan §3, D-O.
  - *À faire / vérifier :* Règles de décision des reversals B (faute livreur : vol, perte, dommage, fraude) : preuves attendues, barème, qui décide, délai — « chantier ultérieur ».
  - *Terminé quand (preuve requise) :* Politique écrite validée (produit + juridique).
  - *Statut :* OUVERT · *Preuve :* aucune · *Historique :* créé le 2026-09-21.
- **REV-08 · À ACTIVER** — *Origine :* R61.
  - *À faire / vérifier :* Worker de reversals désactivé par défaut (`SETTLEMENT_REVERSAL_WORKER_ENABLED`).
  - *Terminé quand (preuve requise) :* Activé dans l'environnement cible, run observé.
  - *Statut :* OUVERT · *Preuve :* aucune · *Historique :* créé le 2026-09-21.
- **REV-09 · À DÉCIDER** — *Origine :* R61.
  - *À faire / vérifier :* Reversal après remboursement du livreur / interaction avec l'affichage livreur (le statement reste `paid`) : définir ce que voit le livreur après une reversal (R80).
  - *Terminé quand (preuve requise) :* Affichage décidé et testé.
  - *Statut :* OUVERT · *Preuve :* aucune · *Historique :* créé le 2026-09-21.

### Webhooks et réconciliation (`WHK`)

- **WHK-01 [CRITIQUE] · À TESTER** — *Origine :* R70.
  - *À faire / vérifier :* Livraison RÉELLE de webhooks non exercée : les tests R70 (PG + Sandbox) injectent des événements simulés ; la chaîne complète Stripe → signature → rawBody → `eventSink` → journal → traitement n'a jamais reçu un vrai événement de règlement.
  - *Terminé quand (preuve requise) :* Événements réels de chaque famille reçus (URL publique/tunnel) et traités jusqu'à `processed`.
  - *Statut :* OUVERT · *Preuve :* aucune · *Historique :* créé le 2026-09-21. ; 2026-09-22 (R90) : événements SIGNÉS localement (secret webhook réel, jamais affiché) envoyés à la VRAIE route de l'API R90 : signature invalide 400, type inconnu ignoré, doublon dédupliqué, hors ordre sans effet, objet inconnu en retry, bail expiré repris, journal sans payload ; livraison par Stripe (destination réelle/tunnel) NON testée → reste ouvert
- **WHK-02 [CRITIQUE] · À DÉVELOPPER** — *Origine :* R70.
  - *À faire / vérifier :* Aucune alerte/écran pour les événements `dead_letter`, les constats de réconciliation techniques (`locadely_technical`), les incidents restaurant et les erreurs de workers : seuls des logs `errorClass`. Prévoir canal d'alerte (e-mail/Slack/Sentry) et écran admin minimal.
  - *Terminé quand (preuve requise) :* Une alerte réelle déclenchée et reçue pour chacun de ces cas ; écran de consultation.
  - *Statut :* OUVERT · *Preuve :* aucune · *Historique :* créé le 2026-09-21. ; 2026-09-22 (R90) : constaté : un litige/incident restaurant n'émet qu'un log niveau ERROR (« Debit charge is disputed or refunded… ») et un constat technique un log ERROR — aucune alerte ; niveau de log à revoir (bruit) ; écran admin `/admin/settlements` liste incidents/constats/dead letters (R80)
- **WHK-03 · À NETTOYER + À DÉCIDER** — *Origine :* R70 (Sandbox).
  - *À faire / vérifier :* Bruit de réconciliation : 35 constats `stripe_transfer_orphan` sur le compte Sandbox (Transferts historiques de mes essais sans ligne locale). Décider aussi si un Transfer Stripe sans métadonnée `driver_transfer_id` (créé hors système) doit être signalé.
  - *Terminé quand (preuve requise) :* Règle décidée ; run de réconciliation propre sur un environnement de test neuf ou filtré.
  - *Statut :* OUVERT · *Preuve :* aucune · *Historique :* créé le 2026-09-21. ; 2026-09-22 (R90) : 38 `stripe_transfer_orphan` observés = Transferts des spikes SP du 21/09 (métadonnées `spike`/`run`), aucun lié aux objets R90 (vérifié un à un : destination et base) ; bruit du Sandbox partagé → décider un marqueur d'environnement en métadonnée des Transferts + filtre de réconciliation
- **WHK-04 · À AJUSTER** — *Origine :* R70.
  - *À faire / vérifier :* Périmètre de la réconciliation : 500 débits/Transferts des 60 derniers jours, Transferts Stripe des 7 derniers jours, 1 passage/jour ≥ 03:00 Paris. Adapter fenêtre/volumétrie (cf. SEPA-11) et vérifier qu'un run raté est relancé.
  - *Terminé quand (preuve requise) :* Paramètres validés sur volume réel ; run manqué rattrapé.
  - *Statut :* OUVERT · *Preuve :* aucune · *Historique :* créé le 2026-09-21.
- **WHK-05 · À DÉCIDER** — *Origine :* R70, plan §3.
  - *À faire / vérifier :* Réconciliation du solde plateforme Stripe avec le ledger total (bilan comptable à l'euro fait en SP2 mais pas automatisé) : décider s'il faut un contrôle agrégé.
  - *Terminé quand (preuve requise) :* Contrôle agrégé livré ou décision de ne pas l'avoir.
  - *Statut :* OUVERT · *Preuve :* aucune · *Historique :* créé le 2026-09-21.
- **WHK-06 · À TESTER** — *Origine :* R70.
  - *À faire / vérifier :* Événements en double ou hors ordre RÉELS (Stripe rejoue, réordonne) : traités par relecture d'état ; simulé seulement.
  - *Terminé quand (preuve requise) :* Doublons/désordre réels observés sans effet.
  - *Statut :* OUVERT · *Preuve :* aucune · *Historique :* créé le 2026-09-21.
- **WHK-07 · À DÉVELOPPER** — *Origine :* R70.
  - *À faire / vérifier :* Rétention/purge de `settlement_stripe_events` et des constats résolus non prévue.
  - *Terminé quand (preuve requise) :* Politique de rétention codée ou décision consignée.
  - *Statut :* OUVERT · *Preuve :* aucune · *Historique :* créé le 2026-09-21.
- **WHK-08 · À DÉCIDER** — *Origine :* R70.
  - *À faire / vérifier :* Webhook Connect `payout.*` non implémenté (voir PAY-04).
  - *Terminé quand (preuve requise) :* Cf. PAY-04.
  - *Statut :* OUVERT · *Preuve :* aucune · *Historique :* créé le 2026-09-21.
- **WHK-09 · À ACTIVER** — *Origine :* R70.
  - *À faire / vérifier :* Workers `SETTLEMENT_WEBHOOK_WORKER_ENABLED` et `SETTLEMENT_RECONCILIATION_WORKER_ENABLED` désactivés par défaut ; la route admin de relance est toujours enregistrée.
  - *Terminé quand (preuve requise) :* Activés dans l'environnement cible et observés.
  - *Statut :* OUVERT · *Preuve :* aucune · *Historique :* créé le 2026-09-21.

### Application mobile (livreur) (`MOB`)

- **MOB-01 [CRITIQUE] · À DÉVELOPPER** — *Origine :* R80, plan §2.
  - *À faire / vérifier :* Écran « Mes paiements » : total de période, envoyé, en attente, statement par restaurant avec états lisibles, restaurant débiteur et montant restant dû, `payrun_at` ; remplace le wallet provisoire (COMPLETED seulement). NON commencé.
  - *Terminé quand (preuve requise) :* Écrans livrés, testés sur le Pixel avec des données couvrant tous les états.
  - *Statut :* OUVERT · *Preuve :* aucune · *Historique :* créé le 2026-09-21.
- **MOB-02 · TERMINÉ EN DEV/SANDBOX (ouverture confirmée, parcours KYC complet non joué)** — *Origine :* R31.
  - *À faire / vérifier :* Repli « lien hébergé » (navigateur système) de l'onboarding.
  - *Terminé quand (preuve requise) :* Onboarding terminé via le lien hébergé sur le Pixel.
  - *Statut :* TERMINÉ EN DEV/SANDBOX (2026-09-22, R90 run4, 3ᵉ livreur `livreur3@gmail.com`) : bouton « Ouvrir dans le navigateur » confirmé — redirection réelle vers une page Stripe dans le navigateur système du Pixel (pas de WebView) ; le KYC n'a volontairement pas été complété jusqu'au bout, mais l'utilisateur a quand même quitté la session Stripe (annulation) → redirection RÉELLE observée vers `/driver/payout-account/return` (MOB-04), ce qui a directement révélé le bug corrigé dans MOB-04 (Stripe appelle `return_url` sur toute sortie de session, pas seulement un succès). Parcours complet effectivement exercé sur l'appareil. *Historique :* créé le 2026-09-21.
- **MOB-03 · TERMINÉ EN DEV/SANDBOX** — *Origine :* R31, D-P.
  - *À faire / vérifier :* Parcours `company` dans l'app (choix verrouillé « J'ai une société »).
  - *Terminé quand (preuve requise) :* Cf. PAY-02 côté écran.
  - *Statut :* TERMINÉ EN DEV/SANDBOX (2026-09-22, R90 run4) · *Preuve :* choix « J'ai une société » confirmé (alerte définitive) sur `r90.driver.company@locadely.test`, onboarding intégré complété par l'utilisateur, compte Express v2 `acct_1UITqqFNXbmcyPQI` `ready:true`/`transfers:active`, a reçu 2 Transfers réels (17,98 €) lors du cycle règlement run4, Wallet vérifié par l'utilisateur sur Pixel · *Historique :* créé le 2026-09-21.
- **MOB-04 · TERMINÉ EN DEV/SANDBOX** — *Origine :* R30, R31.
  - *À faire / vérifier :* Pages web de retour `WEB_APP_URL/driver/payout-account/return` et `/refresh` (retours Account Link hébergé) inexistantes dans `apps/web`.
  - *Terminé quand (preuve requise) :* Pages créées, redirection testée depuis le lien hébergé.
  - *Statut :* TERMINÉ EN DEV/SANDBOX (2026-09-22, R90 run4) — pages créées (`apps/web/app/driver/payout-account/{return,refresh}/page.tsx`, statiques, aucun appel API/DB : aucune session driver n'est disponible dans ce navigateur, le message renvoie vers l'app) ; `npm run typecheck --workspace=apps/web` OK ; redirection réelle observée EN DIRECT sur le Pixel (voir MOB-02). Bug annexe corrigé au passage : `WEB_APP_URL` par défaut de l'API (`http://localhost:3001`) ne correspondait à aucun service réel (web tourne sur :4000) — API R90 relancée avec `WEB_APP_URL=http://localhost:4000` + `adb reverse tcp:4000 tcp:4000` pour que le navigateur système du Pixel puisse l'atteindre (même contournement que [[crostini-adb-reverse-metro]]).
  - **Bug trouvé ET corrigé (2026-09-22, en test live)** : Stripe appelle `return_url` dès que l'utilisateur QUITTE la session hébergée (annulation comprise), pas seulement au succès ; l'utilisateur a annulé sans rien soumettre et est arrivé sur une page affirmant « Informations envoyées » (faux) sans aucune action possible (impasse). Corrigé par Claude (pas Codex, changement confirmé suffisant par l'utilisateur) : texte neutre (« Retour à Locadely », ne prétend plus un succès) + bouton « Ouvrir l'application » (deep link `deliveryservicedriver://`) sur les deux pages pour sortir de l'impasse. Revérifié : typecheck OK, pages 200. *Historique :* créé le 2026-09-21.
- **MOB-05 · À CONFIRMER** — *Origine :* R31.
  - *À faire / vérifier :* Confirmation utilisateur non obtenue : disparition du bandeau « Carte » et réapparition des courses pour un livreur dont le compte est prêt.
  - *Terminé quand (preuve requise) :* Confirmation explicite sur le Pixel.
  - *Statut :* OUVERT · *Preuve :* aucune · *Historique :* créé le 2026-09-21.
- **MOB-06 · À RETESTER** — *Origine :* R31.
  - *À faire / vérifier :* Pixel 4a juste en mémoire : un rendu WebView tué par le lowmemorykiller pendant l'onboarding intégré ; tester un autre appareil.
  - *Terminé quand (preuve requise) :* Onboarding réussi sur au moins un second appareil.
  - *Statut :* OUVERT · *Preuve :* aucune · *Historique :* créé le 2026-09-21.
- **MOB-07 · À TESTER** — *Origine :* R31.
  - *À faire / vérifier :* iOS jamais testé (uniquement Android Pixel 4a, dev build EAS).
  - *Terminé quand (preuve requise) :* Parcours livreur complet sur un appareil iOS, ou décision de ne pas supporter iOS.
  - *Statut :* OUVERT · *Preuve :* aucune · *Historique :* créé le 2026-09-21.
- **MOB-08 [CRITIQUE] · À TESTER** — *Origine :* R31.
  - *À faire / vérifier :* Stripe imprime le secret de session Connect dans les logs WebView (debug, Sandbox) : vérifier qu'un build de production n'écrit aucun secret dans les logs.
  - *Terminé quand (preuve requise) :* Logs d'un build production inspectés : aucun `accs_secret_`.
  - *Statut :* OUVERT · *Preuve :* aucune · *Historique :* créé le 2026-09-21.
- **MOB-09 [CRITIQUE] · À CONFIGURER** — *Origine :* R31, mobile CLAUDE.md.
  - *À faire / vérifier :* Build de développement EAS uniquement, API via tunnel ngrok (`EXPO_PUBLIC_*`) : préparer build de production, signature, stores, URL d'API stable, suppression des tunnels.
  - *Terminé quand (preuve requise) :* Build production installable, pointant l'API de production, publié.
  - *Statut :* OUVERT · *Preuve :* aucune · *Historique :* créé le 2026-09-21.
- **MOB-10 · À DÉCIDER** — *Origine :* R80.
  - *À faire / vérifier :* Notifications push d'événements de paiement (statement encaissé, envoyé, impayé) : non prévues.
  - *Terminé quand (preuve requise) :* Décision consignée ; si oui, développées et testées.
  - *Statut :* OUVERT · *Preuve :* aucune · *Historique :* créé le 2026-09-21.
- **MOB-11 · À DÉVELOPPER** — *Origine :* D-F, R80.
  - *À faire / vérifier :* États livreur « compte à régulariser / gains bloqués », erreurs réseau/hors ligne de l'écran paiements.
  - *Terminé quand (preuve requise) :* États présents dans R80 et testés.
  - *Statut :* OUVERT · *Preuve :* aucune · *Historique :* créé le 2026-09-21.
- **MOB-12 · À RETESTER** — *Origine :* R31.
  - *À faire / vérifier :* Étape d'authentification Stripe dans un Chrome Custom Tab (obligatoire Express) et relecture d'état ≈ 12 s en fin d'onboarding : à rejouer après toute modification.
  - *Terminé quand (preuve requise) :* Parcours complet rejoué sans message périmé.
  - *Statut :* OUVERT · *Preuve :* aucune · *Historique :* créé le 2026-09-21.
- **MOB-13 · À TESTER** — *Origine :* R80 (écran implémenté par Codex, vérifié par typecheck/lint seulement).
  - *À faire / vérifier :* Écran « Mes paiements » (Wallet) et détail de période sur le Pixel : lisibilité, débordement des montants/dates, textes ≥ 16 px (14 px informatif), cibles ≥ 52 px, pull-to-refresh, états chargement/erreur/vide, navigation retour, bloc « Restaurant concerné » (flag), tous les états d'affichage.
  - *Terminé quand (preuve requise) :* Captures Pixel de chaque état d'affichage + navigation validée.
  - *Statut :* OUVERT · *Preuve :* aucune · *Historique :* créé le 2026-09-21 (R80) ; 2026-09-22 : contrôle visuel utilisateur sur base vide, « pas de problème apparent », aucune capture des états (pas de données) → reste ouvert jusqu'à R90-H. ; 2026-09-22 (R90) : R90 : réponse API livreur vérifiée sur données réelles (D1 : 2 périodes, 75,70 € dont 68,31 € envoyés, 1 statement `restaurant_incident`) ; rendu Pixel avec ces données NON encore vu (H, utilisateur)
- **MOB-14 · À DÉVELOPPER** — *Origine :* R80.
  - *À faire / vérifier :* Le détail d'une période relit la liste complète (`getMySettlements`) : pas d'endpoint par période ; à revoir si le volume grandit.
  - *Terminé quand (preuve requise) :* Endpoint/pagination ou décision consignée.
  - *Statut :* OUVERT · *Preuve :* aucune · *Historique :* créé le 2026-09-21 (R80).
- **MOB-15 [BUG TROUVÉ ET CORRIGÉ, non critique] · TERMINÉ** — *Origine :* R90 run4 (2026-09-22), vérification affichage final avec un vrai livreur `individual` onboardé (Express v2 `acct_1UITZnJuqKzWHSLL`).
  - *À faire / vérifier :* Une fois le compte de paiement `ready`, `/paiements` (hub « Mes paiements », qui porte le bouton « Mon espace Stripe complet » → `openStripeDashboard()`) devenait INATTEIGNABLE depuis l'app : son seul point d'entrée était `PayoutBanner` (`apps/mobile/components/PayoutBanner.tsx`), qui retourne `null` dès que `ui.ready` est vrai (comportement voulu, conservé) ; le Wallet (`app/(tabs)/compte/wallet.tsx`) ne liait que vers `/paiements/versements` (composants embarqués Payouts/Payments), jamais vers `/paiements` lui-même ni vers le Dashboard.
  - *Correction (Codex, 2026-09-22)* : bouton secondaire permanent « Mon espace Stripe complet » ajouté dans le Wallet (section « Compte de paiement », sous « Versements et transactions »), visible uniquement quand `derivePayoutUi(account).ready` est vrai, appelle `openStripeDashboard()` existant (navigateur système, inchangé). Diff minimal (1 bouton + 1 import), reste du fichier déjà modifié hors R90 (R80) non touché. `npm run typecheck --workspace=apps/mobile` OK.
  - *Terminé quand (preuve requise) :* Un lien permanent vers `/paiements` (ou directement vers `openStripeDashboard()`) ajouté quelque part d'atteignable après onboarding (ex. Wallet ou Compte), testé sur Pixel.
  - *Statut :* TERMINÉ · *Preuve :* code lu avant/après (`apps/mobile/components/PayoutBanner.tsx`, `apps/mobile/app/(tabs)/compte/wallet.tsx`, `apps/mobile/app/paiements/index.tsx`) ; diff Codex relu par Claude ; typecheck vert ; testé sur Pixel par l'utilisateur (livreur individual `ready`) — bouton visible, ouverture réelle vers la connexion Stripe confirmée par l'utilisateur (« je le vois, ça me redirige vers stripe et me demande de me connecter. ça marche ») · *Historique :* créé le 2026-09-22 (R90 run4), corrigé et vérifié le 2026-09-22.

### Application restaurant / admin (web) (`WEB`)

- **WEB-01 [CRITIQUE] · À DÉVELOPPER** — *Origine :* R80.
  - *À faire / vérifier :* Page « Règlements » du restaurant (semaines, montant, pré-notification, tentatives, incidents/créances, détail des courses) : n'existe pas.
  - *Terminé quand (preuve requise) :* Page livrée et testée sur données couvrant succès, échec, litige, relance.
  - *Statut :* OUVERT · *Preuve :* aucune · *Historique :* créé le 2026-09-21.
- **WEB-02 [CRITIQUE] · À DÉVELOPPER** — *Origine :* R70, R80.
  - *À faire / vérifier :* Admin minimal : aucun compte Supabase `admin` créé ; seule la relance de débit existe (`POST /api/v1/admin/settlements/:id/debit-retry`, testée avec auth simulée). Manquent : liste des règlements/états, incidents, créances, constats, reversals, blocages.
  - *Terminé quand (preuve requise) :* Compte admin réel + page/API listant et agissant, testée avec JWT admin réel.
  - *Statut :* OUVERT · *Preuve :* aucune · *Historique :* créé le 2026-09-21.
- **WEB-03 · À RETESTER** — *Origine :* SEPA restaurants existants, R70.
  - *À faire / vérifier :* UI « Moyen de paiement » (Stripe Payment Element) : parcours de remplacement de mandat avec un règlement en cours (voir SEPA-16).
  - *Terminé quand (preuve requise) :* Scénario observé via l'UI.
  - *Statut :* OUVERT · *Preuve :* aucune · *Historique :* créé le 2026-09-21.
- **WEB-04 · REPORTÉ + À VALIDER** — *Origine :* ADR 0004 (« auto-facture »).
  - *À faire / vérifier :* Auto-facturation / factures : le statement est l'ancre d'une future auto-facture ; aucune facture (restaurant ni livreur) n'est générée.
  - *Terminé quand (preuve requise) :* Chantier facturation livré ou décision juridique de ne pas facturer via la plateforme.
  - *Statut :* OUVERT · *Preuve :* aucune · *Historique :* créé le 2026-09-21.
- **WEB-05 · À CONFIGURER** — *Origine :* R30.
  - *À faire / vérifier :* `WEB_APP_URL` (défaut `http://localhost:3001`) pour les retours Account Link, liens e-mails et pages web.
  - *Terminé quand (preuve requise) :* URL de production configurée et testée.
  - *Statut :* OUVERT · *Preuve :* aucune · *Historique :* créé le 2026-09-21.
- **WEB-06 · À DÉCIDER** — *Origine :* D-O.
  - *À faire / vérifier :* Ce que le restaurant voit d'un incident (échec, litige) et comment il régularise (aujourd'hui : contacter Locadely, relance uniquement par un admin).
  - *Terminé quand (preuve requise) :* Parcours défini et implémenté.
  - *Statut :* OUVERT · *Preuve :* aucune · *Historique :* créé le 2026-09-21.
- **WEB-07 · À TESTER** — *Origine :* R80.
  - *À faire / vérifier :* Pages `/merchant/settlements` et `/admin/settlements` : `next build` non exécuté, jamais rendues dans un navigateur ; vérifier rôles (admin/non-admin), états, tous les états d'affichage, responsive.
  - *Terminé quand (preuve requise) :* Build vert + parcours navigateur réel capturé (restaurant, admin).
  - *Statut :* OUVERT · *Preuve :* `next build` vert (2026-09-22) + appel réel admin 200 ; parcours navigateur réel non capturé · *Historique :* créé le 2026-09-21 (R80) ; 2026-09-22 : contrôle visuel utilisateur (restaurant + admin) sur base vide, « pas de problème apparent » → reste ouvert jusqu'à R90-H avec données. ; 2026-09-22 (R90) : R90 : réponses API restaurant/admin vérifiées sur données réelles (règlement payé, 12 règlements, 2 incidents, 2 créances, 39 constats, 23 Transferts, 4 reversals) ; rendu navigateur avec ces données NON encore vu (H, utilisateur)
- **WEB-08 · À DÉCIDER + À DÉVELOPPER** — *Origine :* R80.
  - *À faire / vérifier :* Admin minimal : motif de rejet via `window.prompt`, aucune pagination/filtre (100 lignes), pas de vue d'audit des actions admin (les identifiants demandeur/approbateur/relance sont stockés en base).
  - *Terminé quand (preuve requise) :* Décision (suffisant ou à étoffer) + audit consultable si retenu.
  - *Statut :* OUVERT · *Preuve :* aucune · *Historique :* créé le 2026-09-21 (R80).
- **WEB-09 [CRITIQUE] · À CONFIGURER** — *Origine :* R80, REV-06, DAT-07.
  - *À faire / vérifier :* Comptes admin : deux comptes de TEST créés sur Supabase dev (`admin.dev@…`, `admin2.dev@…`, rôle dans `app_metadata.role`, mots de passe hors dépôt) pour la double approbation ; production : comptes réels nominatifs, MFA, deux personnes distinctes, procédure de révocation.
  - *Terminé quand (preuve requise) :* Comptes production créés et testés (approbation par 2 personnes), MFA active.
  - *Statut :* OUVERT · *Preuve :* aucune · *Historique :* créé le 2026-09-21 (R80).

### Workers / configuration / secrets (`CFG`)

- **CFG-01 [CRITIQUE] · À ACTIVER + À TESTER** — *Origine :* R40–R70.
  - *À faire / vérifier :* Sept workers désactivés par défaut : `SETTLEMENT_CLOSE_WORKER_ENABLED`, `SETTLEMENT_PRE_NOTIFICATION_WORKER_ENABLED`, `SETTLEMENT_DEBIT_WORKER_ENABLED`, `SETTLEMENT_PAYOUT_WORKER_ENABLED`, `SETTLEMENT_REVERSAL_WORKER_ENABLED`, `SETTLEMENT_WEBHOOK_WORKER_ENABLED`, `SETTLEMENT_RECONCILIATION_WORKER_ENABLED` (+ `STRIPE_PAYMENTS_ENABLED=true`). Le démarrage de l'API avec TOUS les flags actifs (câblage `app.ts`, superRefine de configuration) n'a jamais été exercé.
  - *Terminé quand (preuve requise) :* API démarrée avec tous les flags et secrets requis ; un cycle complet observé ; refus de démarrage constaté quand un secret manque.
  - *Statut :* OUVERT · *Preuve :* aucune · *Historique :* créé le 2026-09-21.
- **CFG-02 [CRITIQUE] · À CONFIGURER** — *Origine :* R41, R30, R70.
  - *À faire / vérifier :* Secrets à fournir par environnement : `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_CONNECT_WEBHOOK_SECRET` (un par destination), `RESEND_API_KEY`, `RESEND_FROM_EMAIL`, `SEPA_CREDITOR_ID`, `SETTLEMENT_SUPPORT_EMAIL`, `SUPABASE_SECRET_KEY`. Un `whsec_` de test a été collé dans une conversation : le considérer comme compromis et le remplacer.
  - *Terminé quand (preuve requise) :* Gestion de secrets en place, secrets live distincts, ancien secret révoqué.
  - *Statut :* OUVERT · *Preuve :* aucune · *Historique :* créé le 2026-09-21.
- **CFG-03 · À TESTER** — *Origine :* D-J, R40–R70.
  - *À faire / vérifier :* Plusieurs instances/processus d'API : baux, `for update skip locked`, index uniques testés avec 2–3 workers dans UN processus de test seulement.
  - *Terminé quand (preuve requise) :* Deux processus distincts sous charge sans doublon (R90).
  - *Statut :* OUVERT · *Preuve :* aucune · *Historique :* créé le 2026-09-21. ; 2026-09-22 (R90) : 2 workers concurrents dans UN processus (débit + pay-run) sans doublon (PaymentIntents/Transferts vérifiés côté Stripe et base) ; l'API R90 (processus distinct, worker webhook) partage la base avec le harnais ; 2 PROCESSUS distincts sur le worker de reversals : 5 demandes réclamées 3+2, 5 réussites, 5 identifiants Stripe distincts, 1 reversal par Transfert (evidence `CFG-03-two-processes-CORRECTION`) ; reste à refaire en 2 processus pour débits et pay-run
- **CFG-04 · À TESTER** — *Origine :* R50, R60, R61.
  - *À faire / vérifier :* Reprise après arrêt brutal : simulée (exceptions injectées) ; à vérifier avec un vrai `kill -9` pendant chaque worker.
  - *Terminé quand (preuve requise) :* Crash réel pendant débit, pay-run, reversal, webhook : reprise sans doublon.
  - *Statut :* OUVERT · *Preuve :* aucune · *Historique :* créé le 2026-09-21.
- **CFG-05 · À CONFIGURER** — *Origine :* R40, R70.
  - *À faire / vérifier :* Fuseau et heure du serveur (calculs Europe/Paris via Intl), horloge NTP, exécution quotidienne de la réconciliation.
  - *Terminé quand (preuve requise) :* Vérification du fuseau/horloge en production + test de changement d'heure.
  - *Statut :* OUVERT · *Preuve :* aucune · *Historique :* créé le 2026-09-21.
- **CFG-06 [CRITIQUE] · À CONFIGURER + À DÉVELOPPER** — *Origine :* R70.
  - *À faire / vérifier :* Supervision : aucun agrégateur de logs/alertes ; les workers journalisent des `errorClass` (jamais de secret). À mettre en place avant tout usage réel (voir WHK-02).
  - *Terminé quand (preuve requise) :* Outil de logs/alertes branché, test d'alerte.
  - *Statut :* OUVERT · *Preuve :* aucune · *Historique :* créé le 2026-09-21.
- **CFG-07 · À CONFIGURER** — *Origine :* D-I, R40.
  - *À faire / vérifier :* Sauvegardes/PITR de la base, procédure d'application des migrations avec contrôle avant/après (empreintes) : 0030–0039 appliquées à la base de dev par `psql` + insertion manuelle dans `schema_migrations`.
  - *Terminé quand (preuve requise) :* Procédure de migration production rejouée sur une copie ; sauvegarde restaurée avec succès.
  - *Statut :* OUVERT · *Preuve :* aucune · *Historique :* créé le 2026-09-21.
- **CFG-08 · À TESTER** — *Origine :* SP6/SP7, config.
  - *À faire / vérifier :* Override `STRIPE_ACCOUNTS_V2_API_VERSION` et version d'API Stripe : politique de version documentée pour le live.
  - *Terminé quand (preuve requise) :* Versions figées et test de non-régression sur la version live.
  - *Statut :* OUVERT · *Preuve :* aucune · *Historique :* créé le 2026-09-21.
- **CFG-09 · À RETESTER** — *Origine :* sécurité (RLS, R10–R70).
  - *À faire / vérifier :* Test `test/security/data-api-lockdown.integration.test.ts` non relancé après les migrations 0030–0039 : toutes les tables de règlement doivent être RLS + `revoke` pour `anon`/`authenticated`.
  - *Terminé quand (preuve requise) :* Test exécuté vert sur base à jour, incluant les nouvelles tables.
  - *Statut :* OUVERT · *Preuve :* aucune · *Historique :* créé le 2026-09-21.
- **CFG-10 · À DÉVELOPPER** — *Origine :* runbook.
  - *À faire / vérifier :* Runbook d'exploitation : quoi faire quand un worker s'arrête, quand un cycle est manqué, comment couper (désactiver les flags), comment reprendre après incident.
  - *Terminé quand (preuve requise) :* Runbook écrit et rejoué lors d'un exercice.
  - *Statut :* OUVERT · *Preuve :* aucune · *Historique :* créé le 2026-09-21.
- **CFG-11 [CRITIQUE] · À CONFIGURER** — *Origine :* R80, LEG-11.
  - *À faire / vérifier :* `SETTLEMENT_DRIVER_SEES_DEBTOR_IDENTITY` (identité légale du restaurant débiteur visible du livreur) : `false` par défaut ; `true` seulement en environnement de TEST ; ne jamais l'activer en production avant la validation juridique/RGPD LEG-11.
  - *Terminé quand (preuve requise) :* Valeur de production `false` tant que LEG-11 n'est pas validé ; activation tracée avec l'avis.
  - *Statut :* OUVERT · *Preuve :* aucune · *Historique :* créé le 2026-09-21 (R80).
- **CFG-12 · À CONFIGURER** — *Origine :* R80 (incident 2026-09-22).
  - *À faire / vérifier :* Le processus API de dev (`tsx watch`) s'est arrêté silencieusement (enfant mort, port 3000 fermé) : la page « Règlements » affichait « Impossible de charger » ; cause non identifiée. Prévoir un superviseur de processus (redémarrage automatique, health check, alerte) en test et en production, et un message d'erreur distinguant « API injoignable » d'une erreur applicative dans les interfaces.
  - *Terminé quand (preuve requise) :* Superviseur en place ; arrêt forcé du processus constaté puis redémarrage automatique ; message d'erreur distinct testé.
  - *Statut :* OUVERT · *Preuve :* aucune · *Historique :* créé le 2026-09-22 (R80).

### Tests et validation (`TST`)

- **TST-01 [CRITIQUE] · À DÉVELOPPER + À EXÉCUTER** — *Origine :* R90 (gate finale actuelle).
  - *À faire / vérifier :* Validation complète Sandbox / données de test avec l'app de développement sur le Pixel : A×5 livreurs, livreur×6/10 restaurants, échec SEPA + relance manuelle, litige après paiement, livreur restreint, crash/reprise, 2 workers, webhook dupliqué/hors ordre, réconciliation ; scénarios financiers ciblés.
  - *Terminé quand (preuve requise) :* Rapport R90 avec preuves (DB + Stripe + captures Pixel) pour chaque scénario.
  - *Statut :* OUVERT · *Preuve :* aucune · *Historique :* créé le 2026-09-21. ; 2026-09-22 (R90) : scénarios ENV, A (clôture, débits, pay-run), B (relance manuelle), C/C2 (litige avant et après paiement), D (livreur restreint), E (reversals), F/F2 (2 workers, crash débit et reversal, bail webhook), REC, H-api faits sur le run `r90-20260922-3` ; restent G/H (utilisateur) et le rapport final — suivi détaillé `docs/work/r90/PROGRESS.md`, preuves `docs/work/r90/evidence/r90-20260922-3.jsonl`
- **TST-02 · À RETESTER** — *Origine :* R61, R70.
  - *À faire / vérifier :* Deux tests intermittents observés pendant R61 (non reproduits ensuite) : `test/http/orders.http.test.ts` (« card payments guard on cash-on-delivery orders », cas 409) et `settlement-schema.integration.test.ts` (« applies the 2 calendar day pre-notification guard: pre-notified 2/5 days before »). Hypothèse : interférence entre fichiers sur la base partagée. À revoir à la validation finale s'ils réapparaissent.
  - *Terminé quand (preuve requise) :* N runs complets consécutifs sans échec, ou cause identifiée et corrigée.
  - *Statut :* OUVERT · *Preuve :* aucune · *Historique :* créé le 2026-09-21.
- **TST-03 · À CORRIGER** — *Origine :* état initial.
  - *À faire / vérifier :* Échecs préexistants hors chantier : `cod-reconciliation` (3 tests) et `merchants.http` « returns the authenticated merchant profile » (fixture en dérive) ; erreurs lint `test/http/merchants.http.test.ts` (`_seedOnboardingCompleted`, `seedMerchantPatch`).
  - *Terminé quand (preuve requise) :* Tests réparés ou retirés avec justification ; lint propre sur tout le dépôt.
  - *Statut :* OUVERT · *Preuve :* aucune · *Historique :* créé le 2026-09-21.
- **TST-04 · À RETESTER** — *Origine :* campagne R10–R12.
  - *À faire / vérifier :* Deux mutants survivants de la campagne R10–R12 (aucune trace de résolution dans la mémoire) : borne basse de période (`period lower bound`) et triggers différés du ledger (`ledger deferred triggers`) ; le mutant « pré-notification 2 jours » était un motif non trouvé (script), pas un survivant. Les campagnes de mutation ont ensuite été arrêtées à la demande de l'utilisateur ; aucune mutation sur R40–R70.
  - *Terminé quand (preuve requise) :* Mutation ponctuelle sur ces deux gardes et sur les gardes critiques (charge `succeeded`, mandat, incident, préavis par tentative) détectée par un test, ou test ajouté.
  - *Statut :* OUVERT · *Preuve :* aucune · *Historique :* créé le 2026-09-21.
- **TST-05 [CRITIQUE] · À DÉVELOPPER** — *Origine :* SP1–SP7, R50–R70.
  - *À faire / vérifier :* Les scripts Sandbox (SP1–SP7, `r50/r60/r61/r70-sandbox.mts`, harnais) vivent dans le scratchpad temporaire de la session, HORS dépôt : ils seront perdus. Créer un harnais R90 versionné (horloge simulée, base de test, scénarios) et conserver les scripts utiles.
  - *Terminé quand (preuve requise) :* Harnais commité, exécutable par une commande documentée.
  - *Statut :* OUVERT · *Preuve :* aucune · *Historique :* créé le 2026-09-21. Décision utilisateur 2026-09-21 : outillage de dates simulées validé pour R90 (à construire) + objets Sandbox tagués par `run_id` (TST-11).
- **TST-06 · À TESTER** — *Origine :* R11, R40.
  - *À faire / vérifier :* Calendrier/DST : tests sur quelques dates seulement ; ajouter passages mars/octobre, années bissextiles, fériés mobiles.
  - *Terminé quand (preuve requise) :* Cas DST/fériés ajoutés et verts.
  - *Statut :* OUVERT · *Preuve :* aucune · *Historique :* créé le 2026-09-21.
- **TST-07 · À TESTER** — *Origine :* R90.
  - *À faire / vérifier :* Aucun test de charge/volume (nombre de restaurants, de livreurs, de lignes par période).
  - *Terminé quand (preuve requise) :* Test de volume défini et exécuté avec objectifs de durée.
  - *Statut :* OUVERT · *Preuve :* aucune · *Historique :* créé le 2026-09-21.
- **TST-08 · À CONSERVER** — *Origine :* règle de fonctionnement.
  - *À faire / vérifier :* Base isolée `settlements_r10` (`docs/work/r10-testdb.sh`, `source` jamais dans un pipe) : les tests de règlement s'y exécutent ; ne jamais les lancer sur la base de dev partagée (ils tronquent des tables).
  - *Terminé quand (preuve requise) :* Règle rappelée dans le plan/CLAUDE.md ; aucun run destructif sur la base de dev.
  - *Statut :* OUVERT · *Preuve :* aucune · *Historique :* créé le 2026-09-21.
- **TST-09 · À DÉCIDER** — *Origine :* R41–R70.
  - *À faire / vérifier :* Toutes les intégrations Stripe/Resend sont testées avec des fakes + des scripts Sandbox jetables : décider des tests d'intégration Sandbox automatisés (CI) à conserver.
  - *Terminé quand (preuve requise) :* Suite Sandbox automatisée ou décision consignée.
  - *Statut :* OUVERT · *Preuve :* aucune · *Historique :* créé le 2026-09-21.
- **TST-10 · À DÉCIDER** — *Origine :* R80.
  - *À faire / vérifier :* Aucun test UI automatisé (web/mobile) : couverture = typecheck, lint, lectures PostgreSQL et routes HTTP ; décider si des tests de composants/E2E navigateur sont nécessaires.
  - *Terminé quand (preuve requise) :* Décision consignée ou tests ajoutés.
  - *Statut :* OUVERT · *Preuve :* aucune · *Historique :* créé le 2026-09-21 (R80).
- **TST-11 · À DÉVELOPPER** — *Origine :* R90 (demande utilisateur).
  - *À faire / vérifier :* Objets Sandbox de la campagne R90 identifiables sans nettoyage global du compte Sandbox : `run_id` en métadonnée (Stripe) et en base pour chaque objet créé par R90, afin de distinguer ces objets du bruit historique (constats `stripe_transfer_orphan`, WHK-03).
  - *Terminé quand (preuve requise) :* Rapport R90 filtrant par `run_id` ; constats de réconciliation attribuables à la campagne.
  - *Statut :* OUVERT · *Preuve :* aucune · *Historique :* créé le 2026-09-21 (R80). ; 2026-09-22 (R90) : objets R90 identifiables par leurs COMPTES Stripe tagués `run_id` (restaurants = customer_account, livreurs = destination, SetupIntents/mandats) ; PaymentIntents et Transferts créés par le code applicatif ne portent PAS `run_id` (à ajouter si un marqueur d'environnement est décidé, cf. WHK-03)
- **TST-12 [CRITIQUE] · À TESTER** — *Origine :* D-R (demande utilisateur 2026-09-22).
  - *À faire / vérifier :* Fresh install : base vide → migrations 0001…dernière → schéma complet, seed, application démarre et suite de tests verte. À répéter à chaque nouvelle migration.
  - *Terminé quand (preuve requise) :* Script de recréation exécuté sans erreur sur base vide (`docs/work/r90-testdb.sh`) + comptage des objets attendus, dernière exécution datée.
  - *Statut :* TERMINÉ pour 0001–0039 (2026-09-22) — À REJOUER à chaque nouvelle migration · *Preuve :* `source docs/work/r90-testdb.sh reset` (drop + create + 0001→0039 + seed, sans erreur) puis 6 empreintes IDENTIQUES entre la base fraîche et la base de dev (colonnes 504, triggers 26, contraintes 278, index 129, fonctions 24, RLS 36 tables) ; l'instance API démarre dessus · *Historique :* créé le 2026-09-22 ; vérifié le 2026-09-22 (début R90).
- **TST-13 [CRITIQUE] · À DÉVELOPPER + À TESTER** — *Origine :* D-R (demande utilisateur 2026-09-22).
  - *À faire / vérifier :* Upgrade : base à l'ancienne version contenant des données financières (périodes closes, débits, Transfers, reversals) → nouvelles migrations → historique intact (checksums de lignes/agrégats avant/après), guards actives, application fonctionnelle. Les évolutions de schéma passent par de NOUVELLES migrations, jamais par la réécriture d'une migration appliquée. Prévoir une procédure versionnée avant toute nouvelle migration touchant les tables de règlement.
  - *Terminé quand (preuve requise) :* Procédure d'upgrade exécutée sur une base peuplée (ex. fin de run R90) avec comparaison avant/après consignée.
  - *Statut :* OUVERT · *Preuve :* aucune · *Historique :* créé le 2026-09-22.

- **TST-14 · À REJOUER** — *Origine :* R90 (limites constatées).
  - *À faire / vérifier :* Limites de R90 à couvrir avant toute production : (1) crash/reprise du PAYOUT (Transfer créé puis crash avant l'écriture en base) non rejoué en Sandbox car le calendrier simulé doit rester dans le passé réel (gardes PostgreSQL sur `now()` réel) et aucune période n'avait plus de `payrun_at` passé exigible — à rejouer avec un `go_live_at` plus ancien ; (2) restriction Stripe réelle d'un livreur non simulable (état posé en base) ; (3) e-mails de pré-notification simulés ; (4) `settlement_periods.closed_at` = `now()` réel (pas l'horloge injectée) ; (5) noms d'événements de test.
  - *Terminé quand (preuve requise) :* Chaque limite rejouée ou acceptée par décision consignée.
  - *Statut :* OUVERT · *Preuve :* aucune · *Historique :* créé le 2026-09-22 (R90).
### Juridique / comptabilité / RGPD (`LEG`)

- **LEG-01 [CRITIQUE] · À VALIDER COMPTABLEMENT** — *Origine :* D-B, plan §6.
  - *À faire / vérifier :* TVA sur les frais Locadely de 20 % (assiette, taux, facturation au livreur).
  - *Terminé quand (preuve requise) :* Avis comptable écrit.
  - *Statut :* OUVERT · *Preuve :* aucune · *Historique :* créé le 2026-09-21.
- **LEG-02 [CRITIQUE] · À VALIDER JURIDIQUEMENT** — *Origine :* plan §6.
  - *À faire / vérifier :* Statut DSP2 / établissement de paiement : flux de fonds Locadely (encaisse les restaurants, reverse aux livreurs via Stripe Connect) et exemptions applicables.
  - *Terminé quand (preuve requise) :* Avis juridique écrit.
  - *Statut :* OUVERT · *Preuve :* aucune · *Historique :* créé le 2026-09-21.
- **LEG-03 [CRITIQUE] · À VALIDER JURIDIQUEMENT** — *Origine :* plan §6, R41.
  - *À faire / vérifier :* Créancier apparent / identité du créancier SEPA (Stripe vs Locadely) et information du débiteur.
  - *Terminé quand (preuve requise) :* Avis + texte du mandat/e-mails validés.
  - *Statut :* OUVERT · *Preuve :* aucune · *Historique :* créé le 2026-09-21.
- **LEG-04 · À VALIDER JURIDIQUEMENT** — *Origine :* plan §6.
  - *À faire / vérifier :* DAC7 (déclaration des vendeurs/prestataires des plateformes numériques).
  - *Terminé quand (preuve requise) :* Avis + obligations calendrier.
  - *Statut :* OUVERT · *Preuve :* aucune · *Historique :* créé le 2026-09-21.
- **LEG-05 [CRITIQUE] · À VALIDER JURIDIQUEMENT** — *Origine :* plan §6, ADR 0004.
  - *À faire / vérifier :* Mandat de facturation / auto-facturation des livreurs (le statement est l'ancre).
  - *Terminé quand (preuve requise) :* Contrat/mandat rédigé et validé.
  - *Statut :* OUVERT · *Preuve :* aucune · *Historique :* créé le 2026-09-21.
- **LEG-06 [CRITIQUE] · À VALIDER JURIDIQUEMENT** — *Origine :* SP4, D-O, REV-03.
  - *À faire / vérifier :* Compensation sur gains futurs (soldes négatifs Stripe, créances livreur) : autorisée ou non, modalités.
  - *Terminé quand (preuve requise) :* Avis juridique + politique appliquée.
  - *Statut :* OUVERT · *Preuve :* aucune · *Historique :* créé le 2026-09-21.
- **LEG-07 · À VALIDER JURIDIQUEMENT** — *Origine :* plan §6, D-F.
  - *À faire / vérifier :* Conservation des fonds dus à un livreur dont le compte est restreint/bloqué (durée, sort des fonds).
  - *Terminé quand (preuve requise) :* Avis + règle.
  - *Statut :* OUVERT · *Preuve :* aucune · *Historique :* créé le 2026-09-21.
- **LEG-08 · À VALIDER COMPTABLEMENT** — *Origine :* D-O, SEPA-10.
  - *À faire / vérifier :* Traitement comptable de la perte restaurant (litige après paiement du livreur assumé par Locadely), frais Stripe d'échec/litige, provisions.
  - *Terminé quand (preuve requise) :* Écritures et politique de provision validées.
  - *Statut :* OUVERT · *Preuve :* aucune · *Historique :* créé le 2026-09-21.
- **LEG-09 [CRITIQUE] · À VALIDER JURIDIQUEMENT** — *Origine :* D-N, D-O.
  - *À faire / vérifier :* Définition contractuelle de « jour ouvré » (FR ∪ TARGET) et de la promesse « paiement sous 15 jours ouvrés après clôture, sous réserve du règlement du restaurant ».
  - *Terminé quand (preuve requise) :* Clause contractuelle validée.
  - *Statut :* OUVERT · *Preuve :* aucune · *Historique :* créé le 2026-09-21.
- **LEG-10 [CRITIQUE] · À VALIDER JURIDIQUEMENT** — *Origine :* R41, SEPA-02/06.
  - *À faire / vérifier :* Pré-notification : délai, forme, contenu (dont droit de contestation).
  - *Terminé quand (preuve requise) :* Avis écrit.
  - *Statut :* OUVERT · *Preuve :* aucune · *Historique :* créé le 2026-09-21.
- **LEG-11 [CRITIQUE] · À VALIDER JURIDIQUEMENT** — *Origine :* D-O, ADR 0004.
  - *À faire / vérifier :* Identité du restaurant débiteur (nom, SIRET, adresse) visible du livreur pour mise en demeure : base RGPD/contrat, finalité, limitation.
  - *Terminé quand (preuve requise) :* Base légale documentée ; affichage conforme.
  - *Statut :* OUVERT · *Preuve :* aucune · *Historique :* créé le 2026-09-21. R80 (2026-09-21) : affichage implémenté derrière `SETTLEMENT_DRIVER_SEES_DEBTOR_IDENTITY` (false par défaut), pour l'environnement de test seulement ; validation juridique/RGPD toujours requise avant production. ; 2026-09-22 (R90) : l'API livreur ne renvoie aucune identité légale/coordonnée/Stripe (`identityVisible=false`, `debtor` absent de la liste des clés sensibles) ; le nom commercial du restaurant par statement reste affiché ; validation juridique toujours à faire
- **LEG-12 · À VALIDER** — *Origine :* R41.
  - *À faire / vérifier :* RGPD : conservation de l'e-mail destinataire et des références de mandat dans `settlement_pre_notifications`, durée de conservation du ledger (obligations comptables), sous-traitants (Stripe, Resend, Supabase), registre des traitements.
  - *Terminé quand (preuve requise) :* Politique de rétention et registre à jour.
  - *Statut :* OUVERT · *Preuve :* aucune · *Historique :* créé le 2026-09-21. R80 : la page web « Règlements » affiche au restaurant les 4 derniers caractères de l'IBAN et la référence de mandat ; l'admin voit des identités (noms) de restaurants et livreurs.
- **LEG-13 · À VALIDER COMPTABLEMENT** — *Origine :* D-E.
  - *À faire / vérifier :* Facturation du restaurant et frais de 20 % sur une course `RETURNED` (rémunérée).
  - *Terminé quand (preuve requise) :* Avis comptable.
  - *Statut :* OUVERT · *Preuve :* aucune · *Historique :* créé le 2026-09-21.
- **LEG-14 [CRITIQUE] · À VALIDER JURIDIQUEMENT** — *Origine :* D-D, D-K, REV-07.
  - *À faire / vérifier :* CGU/contrats restaurants et livreurs : mandat SEPA, prélèvement hebdomadaire, politique d'impayé/blocage, règles de reversal, information sur le solde négatif Stripe.
  - *Terminé quand (preuve requise) :* Documents contractuels finalisés et acceptés dans le parcours.
  - *Statut :* OUVERT · *Preuve :* aucune · *Historique :* créé le 2026-09-21.
- **LEG-15 · À VALIDER JURIDIQUEMENT** — *Origine :* D-P.
  - *À faire / vérifier :* Statut des livreurs : micro-entrepreneurs (`individual`) et sociétés (`company`) : obligations, vérifications KYC, responsabilités Express.
  - *Terminé quand (preuve requise) :* Avis écrit.
  - *Statut :* OUVERT · *Preuve :* aucune · *Historique :* créé le 2026-09-21.

### Données et passage Sandbox → Live (`DAT`)

- **DAT-01 [CRITIQUE] · À DÉCIDER + À FAIRE** — *Origine :* D-I, D-Q, D-R, R40.
  - *À faire / vérifier :* `settlement_settings.go_live_at` : IMMUABLE une fois posé, y compris vers `null` (aucune valeur posée aujourd'hui, ni en dev ni ailleurs). Trigger `guard_settlement_settings` à NE PAS modifier pour R90. Stratégie D-R proposée (2026-09-22, accord utilisateur en attente) : R90 sur base jetable `settlements_r90` où une valeur de test est posée une seule fois ; la base de dev partagée reste à `null`. Pour la production : valeur réelle posée seulement après purge complète des données de test (base de production distincte).
  - *Terminé quand (preuve requise) :* Valeur de test posée dans `settlements_r90` et tracée (run_id) ; preuve que la base de dev garde `go_live_at is null` ; trigger inchangé (checksum de la migration 0030) ; valeur réelle posée en production avec preuve de purge.
  - *Statut :* OUVERT · *Preuve :* aucune · *Historique :* créé le 2026-09-21 ; 2026-09-22 (R90) : `go_live_at = 2026-09-20T22:00:00Z` (lundi 21/09 00:00 Paris) posé UNE fois dans `settlements_r90` via `docs/work/r90-testdb.sh go-live`, refus `go_live_at est immuable une fois défini` constaté sur un `update … set null` ; base de dev : `go_live_at` = NULL vérifié ; migration 0030 md5 `4dbd5a0d…` inchangée, trigger actif (partie test/dev prouvée ; production reste ouverte) ; 2026-09-22 : la formule « poser puis remettre à null » était impossible (corrigée), stratégie D-R proposée.
- **DAT-02 [CRITIQUE] · À NETTOYER** — *Origine :* D-I, mémoire cleanup-simulation-orders.
  - *À faire / vérifier :* Purger les données de test de la base de dev avant tout passage réel : commandes/livreurs/restaurants de test (fixture marchand 22222222…), tables de règlement, objets Stripe Sandbox, comptes jetables ; la base dev sert aussi d'environnement de démo.
  - *Terminé quand (preuve requise) :* Comptages à zéro/attendus après purge, exclusion `created_at < go_live_at` vérifiée (compteur d'exclusions à la première clôture).
  - *Statut :* OUVERT · *Preuve :* aucune · *Historique :* créé le 2026-09-21.
- **DAT-03 [CRITIQUE] · À FAIRE** — *Origine :* R10–R70.
  - *À faire / vérifier :* Appliquer 0030–0039 à la base de production avec contrôle avant/après (empreintes de tables), vérifier RLS, triggers et index ; conserver l'ordre et l'historique de migrations.
  - *Terminé quand (preuve requise) :* Migrations appliquées, empreintes contrôlées, tests de sécurité RLS verts.
  - *Statut :* OUVERT · *Preuve :* aucune · *Historique :* créé le 2026-09-21.
- **DAT-04 [CRITIQUE] · À FAIRE** — *Origine :* R91 (reporté).
  - *À faire / vérifier :* Bascule des clés Stripe en live (`STRIPE_PAYMENTS_ENABLED`, `sk_live_`, webhooks live), gardes `livemode`, retrait des tunnels/URLs de dev (ngrok, `localhost`).
  - *Terminé quand (preuve requise) :* Aucune référence de dev en production ; run de smoke live sans divergence `livemode`.
  - *Statut :* OUVERT · *Preuve :* aucune · *Historique :* créé le 2026-09-21.
- **DAT-05 [CRITIQUE] · À TESTER LIVE** — *Origine :* R91 (reporté), SP1–SP6.
  - *À faire / vérifier :* Canary live à petit montant : cut-off réel, T+6, `available_on`, `source_type`, délai de payout, e-mails de pré-notification (doublon Stripe), échec/litige réels, premier pay-run réel. Mesurer et corriger les paramètres (heure de démarrage, `payrun_delay_business_days`).
  - *Terminé quand (preuve requise) :* Rapport de canary avec mesures et paramètres validés ; aucun écart financier.
  - *Statut :* OUVERT · *Preuve :* aucune · *Historique :* créé le 2026-09-21.
- **DAT-06 · À FAIRE** — *Origine :* R41.
  - *À faire / vérifier :* Domaine d'envoi Resend vérifié en production (SPF/DKIM/DMARC) et adresse d'expéditeur/de support définitives.
  - *Terminé quand (preuve requise) :* Test de délivrabilité vers plusieurs fournisseurs.
  - *Statut :* OUVERT · *Preuve :* aucune · *Historique :* créé le 2026-09-21.
- **DAT-07 · À FAIRE** — *Origine :* R80/R90.
  - *À faire / vérifier :* Comptes de production : compte `admin` Supabase (pas d'admin aujourd'hui), politiques de rôles, séparation demandeur/approbateur.
  - *Terminé quand (preuve requise) :* Comptes créés, droits testés.
  - *Statut :* OUVERT · *Preuve :* aucune · *Historique :* créé le 2026-09-21. R80 : deux comptes admin de TEST créés sur Supabase dev (voir WEB-09).
- **DAT-08 · À FAIRE** — *Origine :* CFG-10.
  - *À faire / vérifier :* Plan de retour arrière : couper les workers (flags), traiter les débits/Transfers en cours, restaurer une sauvegarde.
  - *Terminé quand (preuve requise) :* Exercice de retour arrière réussi.
  - *Statut :* OUVERT · *Preuve :* aucune · *Historique :* créé le 2026-09-21.
- **DAT-09 · À SURVEILLER** — *Origine :* R91 (reporté).
  - *À faire / vérifier :* Suivi des premières semaines : revue quotidienne des constats de réconciliation, incidents, `dead_letter`, blocages ; comparaison quotidienne ledger ↔ Stripe.
  - *Terminé quand (preuve requise) :* Journal de suivi tenu, aucun constat non expliqué.
  - *Statut :* OUVERT · *Preuve :* aucune · *Historique :* créé le 2026-09-21.
- **DAT-10 · À CONSERVER** — *Origine :* règle de fonctionnement.
  - *À faire / vérifier :* Ne jamais toucher les comptes protégés du POC (`acct_1UHTim…`, comptes A/B Direct Charge) ; objets Sandbox jetables uniquement ; comptes de test à purger avant un éventuel live.
  - *Terminé quand (preuve requise) :* Aucun objet protégé modifié (vérifié par les gardes des scripts).
  - *Statut :* OUVERT · *Preuve :* aucune · *Historique :* créé le 2026-09-21.
- **DAT-11 [CRITIQUE] · À FAIRE** — *Origine :* D-R, R90.
  - *À faire / vérifier :* Environnement R90 isolé : script versionné de création de `settlements_r90` (migrations 0001–0039 + seed), 2ᵉ instance API (autre port, workers activés, `DATABASE_URL` R90), routage des webhooks Sandbox vers cette seule instance (jamais vers l'API de dev partagée), acteurs de test = utilisateurs Supabase Auth de dev (aucune clé étrangère vers `auth.users` dans les migrations, à confirmer par un smoke test), Pixel/web repointés via `EXPO_PUBLIC_API_URL` / `NEXT_PUBLIC_API_URL`, puis suppression de la base et retour des URL à la base de dev.
  - *Terminé quand (preuve requise) :* Smoke test vert (login + lecture « Mes paiements » via l'instance R90), aucune ligne R90 dans la base de dev (comptages), `drop database` exécuté en fin de run, objets Stripe du run listés par `run_id`.
  - *Statut :* OUVERT · *Preuve :* aucune · *Historique :* créé le 2026-09-22 ; smoke test R90 OK le 2026-09-22 (login Supabase livreur/restaurant/admin + « Mes paiements » via l'API R90 port 3100 ; contrôles d'accès 401/403), instantané de la base de dev avant/après : aucune table `public` de règlement/commande/marchand modifiée, aucune ligne R90, `go_live_at` NULL (seuls diffs : maintenance pg-boss de l'API de dev et `driver_locations` GPS de l'app) ; reste : Pixel/web sur l'API R90, `drop database` final. ; 2026-09-22 (R90) : API R90 (3100) + base jetable + comptes Auth R90 + monde Stripe tagué `run_id` opérationnels ; tout le pilotage passe par `docs/work/r90-testdb.sh`, `docs/work/r90-api.sh`, `docs/work/r90/*.mts` ; reste : Pixel/web repointés, `drop database`, suppression des comptes Auth R90

### Journal de la checklist (append-only)
- 2026-09-22 (R90 en cours) — ajout de TST-14 (limites R90 à rejouer) ; REV-06 passé TERMINÉ EN DEV/SANDBOX (preuve : API admin + 2 JWT admin réels) ; historiques complétés : TST-01, CFG-03, REV-01, REV-02, WHK-01, WHK-02, WHK-03, TST-11, SEPA-05, PAY-05, LEG-11, PAY-01, PAY-02, MOB-13, WEB-07, DAT-11. Total : 143 points.
- 2026-09-22 (GO R90, D-R validée) — ajout de TST-12 (Fresh install) et TST-13 (Upgrade) ; principe « base jetable pour les gros tests financiers » consigné (apps/api/CLAUDE.md, memory `financial-tests-disposable-db`). Total : 142 points (57 critiques).
- 2026-09-22 (R80 validé) — ajout de DAT-11 (environnement R90 isolé) ; DAT-01 réécrit (go_live_at non remettable à null, stratégie D-R proposée) ; historiques MOB-13 et WEB-07 complétés (contrôle visuel sur base vide, aucun point résolu). Total : 140 points (55 critiques).
- 2026-09-22 (R80) — ajout de CFG-12 (supervision du processus API, incident « API arrêtée »). Total : 139 points (54 critiques).
- 2026-09-21 (R80) — ajout de MOB-13, MOB-14, WEB-07, WEB-08, WEB-09, CFG-11, PAY-13, TST-10, TST-11 ; historiques LEG-11, LEG-12, DAT-07, TST-05 complétés. Total : 138 points (54 critiques), aucun terminé.
- 2026-09-21 — création de la section : 129 points ouverts, 52 critiques ; aucun point terminé. R90 = gate finale actuelle, R91/live reporté (D-Q).

