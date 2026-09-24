# ADR 0007 — Connecteur SUPER PDP (transmission électronique)

Statut : validé — 2026-09-23. Chantier : `docs/work/invoicing-preparation-plan.md` §9-§10.
Amende ADR 0006 uniquement en ajoutant une couche de transmission ; aucun invariant de 0006 n'est
remis en cause.

## Contexte

Le moteur interne de facturation (ADR 0006) est la source de vérité. Super PDP (Plateforme Agréée
française) sert uniquement à convertir, transmettre, router et suivre le cycle de vie réglementaire
des documents déjà émis en interne — jamais à décider s'ils existent ou combien ils valent.

## Décision

1. **Deux ports séparés, jamais fusionnés** : `EInvoiceProvider` (`submitInvoice`,
   `submitCreditNote`, `getStatus`, `listEvents`, `getDocument`) pour les documents, et
   `EInvoiceMandateProvider` (`createMandate`, `getMandate`, `downloadMandate`) pour les mandats.
   Cycle de vie, PDF et validation manuelle d'un mandat sont d'une nature différente de la
   transmission d'un document facturé — un seul port mélangerait deux responsabilités. Le domaine
   `invoices` ne connaît jamais directement Super PDP, CII/UBL/Factur-X, ou OAuth : seul
   l'adaptateur `SuperPdpEInvoiceProvider`/`SuperPdpEInvoiceMandateProvider` en a connaissance.

2. **`DriverEInvoiceReadiness` (nouvelle garde) bloque uniquement la TRANSMISSION, jamais la
   course ni l'émission interne.** Distincte de `DriverInvoiceReadiness` (identité de facturation
   Locadely, ADR 0006 §9). Un livreur sans mandat `verified` continue de recevoir des courses, sa
   facture interne continue d'être émise normalement (avec le mandat associé si présent, sinon en
   attente de mandat) — seule sa transmission externe attend. Justification : la vérification
   manuelle du mandat par le support Super PDP n'a aucun SLA public ; bloquer le revenu du livreur
   pour un délai hors de son contrôle serait disproportionné.

3. **Adresse électronique EN16931 du vendeur (BT-34) : donnée de configuration, jamais une
   constante en dur dans le domaine.** Le schéma (`0225:<SIREN>`, hypothèse Peppol France) n'est
   pas confirmé par la spec JSON elle-même — `SUPERPDP_ELECTRONIC_ADDRESS_SCHEME` (env, défaut
   `0225`) doit pouvoir changer sans nouvelle migration si le sandbox le contredit. La valeur
   (SIREN, déjà connu) et le schéma sont snapshotés sur `invoices.seller_electronic_address_*` à
   l'émission, comme le reste du contenu légal — immuables ensuite.

4. **Conditions de paiement (BT-20/BT-81) : constantes métier réelles, pas une hypothèse.** 100 %
   des commandes sont payées par prélèvement SEPA — `payment_terms_text`/`payment_means_type_code`
   sont des valeurs fixes sur chaque facture (§9.I). BT-9/BT-89/BT-90/BT-91 (échéance précise,
   référence de mandat SEPA) restent volontairement absents : non calculables à l'émission sans
   fragiliser l'invariant « facture ≠ paiement » (ADR 0006 §3) — la période de règlement n'est pas
   encore close et `settlement_line_id` pas encore rattaché à ce stade.

5. **Idempotence : jamais de renvoi automatique après un résultat ambigu.** Aucun mécanisme
   documenté par Super PDP pour retrouver une facture par notre `external_id` (§9.L, vérifié
   directement dans la spec — pas d'hypothèse). `invoice_provider_submissions.submission_status`
   inclut un état `unknown_outcome`, distinct de `retryable`/`failed` : un timeout après envoi ne
   déclenche jamais un second `POST`, seulement une résolution manuelle (ou une recherche
   contrôlée si un mécanisme fournisseur venait à être confirmé).

6. **`status_code` Super PDP n'est pas une machine à états — jamais projeté comme tel.** La
   projection interne se calcule sur l'ENSEMBLE des événements connus d'une soumission, jamais sur
   le seul dernier événement reçu (§9.M).

7. **Mandat livreur : une table unique `driver_einvoice_mandates`**, contenu légal figé à
   l'acceptation (snapshot SIREN, texte/hash versionné, preuve technique d'acceptation, PDF signé)
   immuable ensuite, seuls le suivi fournisseur et la révocation sont mutables — jamais une
   pollution de `drivers`, jamais fusionné avec `invoice_provider_submissions` (nature différente,
   §9.D). Un livreur a au plus un mandat courant (non révoqué) à la fois — un nouveau mandat
   révoque l'ancien plutôt que de le remplacer en place.

8. **Document rendu (Factur-X) : jamais une copie permanente par défaut.** Téléchargé à la demande
   tant que le statut n'est pas terminal (accepté/refusé) ; une copie privée
   (`invoice_provider_submissions.document_storage_path`, bucket privé `einvoice-documents`) n'est
   conservée qu'une fois un statut terminal atteint — compromis entre l'UX (« faire remonter les
   factures dans Locadely ») et le fait que Locadely n'est jamais le service légal d'archivage du
   restaurant/livreur (responsabilité qui leur reste propre).

9. **Sandbox vs production : même adaptateur, configuration différente.** Un seul host Super PDP
   (`https://api.superpdp.tech`, confirmé dans la spec — aucune URL sandbox distincte) ; la
   distinction se fait par les identifiants OAuth utilisés (`client_credentials`, compte
   sandbox vs production), jamais une bascule d'URL codée en dur. `SUPERPDP_ENABLED=false` par
   défaut : aucun secret exigé, aucun appel réseau possible tant que non activé explicitement.

10. **Super PDP ne devient jamais la source de vérité.** Une panne, un rejet, ou l'absence de
    mandat/annuaire ne modifient jamais une facture interne déjà émise — au pire ils empêchent sa
    transmission, jamais son existence ni son contenu (ADR 0006 §4, réaffirmé ici).

## Conséquences

- Migration `0048_superpdp_integration.sql` : colonnes `invoices.seller_electronic_address_*`
  (nullable, snapshot), `invoices.payment_means_type_code`/`payment_terms_text` (constantes,
  immuables, désormais couvertes par `guard_invoice_immutable`), `invoice_provider_submissions`
  enrichie (`prepared|submitting|submitted|accepted|rejected|retryable|failed|unknown_outcome`,
  bail/tentatives), `einvoice_provider_event_cursors` (curseur global de polling par provider),
  `driver_einvoice_mandates` (append-only sur le contenu accepté, mutable sur le suivi provider).
- Bucket Storage privé `einvoice-documents` (mandats signés + futures copies Factur-X), même
  patron que `account-documents` (Étape 3) — jamais public.
- Aucun appel réseau réel tant que `SUPERPDP_CLIENT_ID`/`SUPERPDP_CLIENT_SECRET` ne sont pas
  fournis et `SUPERPDP_ENABLED=true` — le connecteur doit pouvoir se construire et se tester
  entièrement avec un provider fake tant que ces secrets manquent.
