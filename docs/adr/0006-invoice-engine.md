# ADR 0006 — Moteur de facturation interne (livraison, service, avoirs)

Statut : validé — 2026-09-23. Chantier : `docs/work/invoicing-preparation-plan.md` §6-§8.

## Contexte

Locadely doit pouvoir représenter légalement chaque livraison facturable par deux documents
distincts (facture livreur→restaurant, facture Locadely→restaurant), avant tout raccordement à
un Plateforme Agréée (Super PDP, §7). Le moteur interne reste la source de vérité métier ; un
futur fournisseur de transmission n'est qu'une frontière de transport.

## Décision

1. **Une livraison finalisée = deux factures**, juridiquement indépendantes :
   - Facture livreur → restaurant, émise par Locadely au nom et pour le compte du livreur
     (mandat de facturation), montant = `orders.delivery_cents`, `invoice_type_code` futur
     `389`.
   - Facture Locadely → restaurant, montant = `orders.service_fee_cents`, `invoice_type_code`
     futur `380`.
   Les deux sont créées dans **une seule transaction PostgreSQL locale**, sans aucun appel
   réseau. Anti-doublon : `unique(order_id, issuer_kind)`.

2. **Déclencheur canonique unique : `order.completed.v1`** (outbox existant). `order.returned.v1`
   n'émet **aucune** facture sur la même commande. **Ceci amende §6.9/§6.3 du plan** (qui
   traitaient `RETURNED` comme facturable au même titre que `COMPLETED`) : décision utilisateur
   du 2026-09-23, un retour devient une **nouvelle commande distincte** (nouvel `order_id`,
   nouvelle `public_reference`, nouvelle tarification, futures factures) — le chantier créant
   cette nouvelle commande de retour reste hors scope. Limite acceptée et documentée : tant que
   ce chantier n'existe pas, une commande `RETURNED` est réglée (`settlement_lines.final_status
   = 'RETURNED'`, le livreur est payé pour son travail réel) mais ne produit aujourd'hui aucune
   facture légale. `CANCELLED` n'a jamais produit de règlement ni de facture.

3. **Facture ≠ paiement.** Une facture est émise indépendamment du sort du prélèvement SEPA
   (R50) ou du Transfer livreur (R60/R61) : aucune colonne de statut de paiement n'est stockée
   sur la facture elle-même ; le statut de paiement se dérive en lecture depuis les settlements
   (`settlement_line_id`, rattaché nullable puis figé une seule fois, jamais requis à
   l'émission). Un retry Stripe ne recrée jamais une facture.

4. **Facture émise = immuable.** Contenu légal (montants, lignes, snapshots identité, numéro)
   verrouillé par trigger dès l'insertion. Seules deux exceptions mutables, hors du périmètre
   immuable : `transmission_status` (dimension future PA, générique, sans détail fournisseur) et
   `settlement_line_id` (NULL → valeur, une seule fois). Toute correction passe exclusivement par
   un avoir (`credit_notes`/`credit_note_lines`), jamais par une modification ni une suppression
   de facture. Les factures et leurs lignes sont append-only (aucun `UPDATE`/`DELETE` du contenu,
   aucune ligne jamais effacée).

5. **Montants figés, jamais recalculés.** Une ligne de facture copie une valeur déjà figée sur
   la commande (`delivery_cents`/`service_fee_cents`) — aucune règle tarifaire n'est relue à
   l'émission. Une commande sans montants figés (antérieure à SF5, `delivery_cents`/
   `service_fee_cents` `NULL`) est refusée par contrainte plutôt que facturée à zéro.

6. **Numérotation légale (BT-1)** : Locadely fournit toujours le numéro (Super PDP ne le génère
   pas, §7.4). Deux séries indépendantes, **continues, sans réinitialisation annuelle** (choix
   MVP : évite les bascules d'année, plus simple à garantir sans rupture ; réversible plus tard
   par nouvelle décision + migration, jamais en modifiant l'historique) :
   - une série par livreur (`DRV-<SIREN>-######`) — le livreur est l'émetteur légal ;
   - une série unique Locadely (`LOC-######`).
   Avoirs : deux séries symétriques distinctes (`AVD-<SIREN>-######`, `AVL-######`) — un avoir
   n'emprunte jamais la série des factures. Allocation atomique par upsert verrouillant la ligne
   de compteur dans la même transaction que l'insertion (`assign_document_number`, SQL) :
   sûr sous concurrence, testé par deux émissions concurrentes.

7. **Snapshots légaux immuables.** À l'émission, identité vendeur et acheteur sont copiées
   depuis `driver_legal_information`/`merchant_legal_information` (Étape 3) et depuis l'identité
   légale propre de Locadely (`platform_legal_identity`, singleton, à renseigner avant toute
   émission). Modifier un profil après coup ne modifie jamais une facture déjà émise. Aucun
   document d'identité (CNI/Kbis) n'est snapshotté, seulement les champs texte nécessaires à la
   facture.

8. **TVA.** MVP : TVA sur encaissements, pas d'option débits. Taux/montant de ligne
   déterministes et vérifiés par contrainte SQL : `line_vat_cents = floor(line_ht_cents ×
   vat_rate_bps / 10000)` (division entière Postgres, cohérent avec le reste du projet —
   `pricing`, ex-`settlement_lines.fee_cents`). Le régime TVA de Locadely est indépendant de
   celui de chaque livreur (jamais partagé/dérivé l'un de l'autre).

9. **Garde livreur « invoice readiness ».** Un livreur sans identité de facturation complète
   (prénom/nom, `driver_legal_information` complet, régime TVA, numéro TVA si `assujetti`) ne
   se voit proposer aucune course et ne peut en accepter aucune — garde distincte de D-F
   (paiement Stripe, `DriverEligibility`), jamais fondée sur Super PDP.

10. **Avoir = décision métier, jamais un mouvement Stripe automatique.** Un `reversal`
    (livreur) ou un `service_refund` (Locadely) sont des mouvements financiers Stripe distincts
    de l'avoir comptable ; l'avoir se crée sur décision documentée (référence + motif), lié à la
    facture d'origine et à sa ligne, jamais généré automatiquement par un webhook Stripe. Un
    avoir ne peut jamais dépasser, cumulativement, le montant HT de la ligne facturée d'origine
    (contrainte SQL).

11. **Super PDP ne devient jamais la source de vérité documentaire.** Le rattachement à un
    fournisseur de transmission vit dans une table séparée (`invoice_provider_submissions`),
    jamais par colonnes `superpdp_*` directement sur `invoices`/`credit_notes`. Cette tranche ne
    fait **aucun appel réseau** à Super PDP.

## Conséquences

- Nouvelles tables (migration `0047_invoice_engine.sql`) : `platform_legal_identity`,
  `invoice_number_sequences`, `invoices`, `invoice_lines`, `credit_notes`,
  `credit_note_lines`, `invoice_provider_submissions`. Aucune table `settlements`/`orders`
  existante modifiée.
- Le worker outbox consommant `order.completed.v1` doit ignorer silencieusement toute commande
  déjà facturée (replay) et toute commande sans montants figés/legal info incomplète (log +
  retry, jamais de facture partielle).
- La synthèse comptable hebdomadaire, le groupage tarifaire avancé et F10 restent hors scope
  (inchangé, voir plan §6.11/§0).
