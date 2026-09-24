# Plan — Préparation facturation / auto-facturation (chantier F-PREP)

Statut 2026-09-24 : Étapes 1-4 DONE (moteur de facturation interne livré et testé, §8). Étape 5
(intégration Super PDP) EN COURS, tranche par tranche (§11 plan, §12-§15 exécution) : socle technique
codé et validé en sandbox réel (§9-§10), Tranche 1 (persistance soumissions) DONE (§12), Tranche 2
(soumission + polling réellement branchés sur Postgres/HTTP) DONE (§13), Tranche 3 (annuaire
électronique français + éligibilité de transmission) DONE (§14). Tranche 4 (mandat livreur) : plan
§15 VALIDÉ par l'utilisateur (2026-09-24), découpé en 4a/4b/4c/4d (§15.14) — **Tranche 4a DONE**
(§15.18, fondations backend : migration `0051`, acceptation/snapshot/PDF/Storage). **Tranche 4b
DONE (2026-09-24, §15.19, soumission/polling Super PDP câblés). Tranche 4c DONE (2026-09-24,
§15.20, texte V1 réel + parcours mobile complet). Tranche 4d DONE (2026-09-24, §15.21, validation
sandbox réelle bout en bout via le vrai code applicatif). TRANCHE 4 COMPLÈTE.** PAS opérationnelle en
production : ni mandat livreur transmis à Super PDP, ni Factur-X UI, ni
avoir sandbox. **Tranche 4 (mandat livreur) COMPLÈTE (4a+4b+4c+4d, 2026-09-24) — §15.18-§15.21.
Tranche 5 révisée (documents/Factur-X consultables commerçant+livreur) DONE (2026-09-24) — §16.**
Chantier F-PREP / Super PDP intégralement DONE de bout en bout. Ce
fichier est le seul document de reprise du chantier ; toute nouvelle session (Claude Code ou Codex)
doit pouvoir repartir d'ici sans relire de conversation.

Audit complet de l'Étape 1 (toutes les données, table par table, écran par écran) : document Claude
(`claude.ai/code/artifact/adc0e9a6-1352-4982-8f4b-4a427e3c11a7`), non versionné dans le dépôt. Ce fichier
n'en reprend que les constats structurants.

## Maintenance de ce document (obligatoire)

Ce fichier est la SOURCE DE VÉRITÉ du chantier F-PREP, à partir de maintenant.

- Mis à jour après chaque analyse, décision, ou future modification de code liée à ce chantier.
- Si une étape change après vérification du code réel, le plan est mis à jour — jamais laissé à décrire une
  architecture qui n'est plus celle réellement implémentée.
- Un choix technique ou terminologique qui diffère de ce qui était prévu ici est documenté ici (raison, à
  quelle étape, ce qui change) — notamment le vocabulaire juridique (voir §3 nuances).
- Codex peut signaler ce qui doit être mis à jour dans ce plan. **Claude Code reste seul responsable de la
  mise à jour finale du fichier `.md`.**
- Chaque étape du tableau §0 porte son état réel : `todo` | `doing` | `review` | `done`.

## 0. Vision globale — 5 étapes

| # | Étape | État |
| --- | --- | --- |
| 1 | Audit des données existantes | **done** (2026-09-23) |
| 2 | Référence humaine + fiche livraison | **done** (2026-09-23, §4) |
| 3 | Identités légales commerçant/livreur | **done** (2026-09-23, §5.9) |
| 4 | Moteur de facturation interne (factures/avoirs) | **done** (2026-09-23, §8) |
| 5 | Intégration Super PDP (transmission réelle) | **done** (2026-09-24) — connecteur, mandat livreur (4a-4d, sandbox-validé), documents/Factur-X consultables (§16) |

Objectif final permanent (fil conducteur de tout le chantier) :

```
livraison → facture → avoir → refund/reversal → réclamation
```

avec une référence de livraison humaine stable et visible côté livreur, commerçant et admin, distincte des
UUID techniques. Modèle économique sous-jacent déjà validé et implémenté (SF1-SF13, voir
`docs/work/pricing-service-fee-plan.md`) : `delivery_cents` (100% livreur) + `service_fee_cents` (100%
Locadely, additif).

## 1. Étape 1 — Audit des données (DONE)

Méthode : Claude Code a inspecté le dépôt (migrations, `apps/api/src/modules/{orders,merchants,drivers,
settlements}`, `apps/web`, `apps/mobile`) et mené ses propres recherches web légales. Codex a reçu le même
contexte métier, sans les conclusions de Claude, et a produit sa propre inspection + ses propres recherches
web. Comparaison faite, deux affirmations de code de Codex revérifiées par grep direct (confirmées exactes) :
aucun désaccord matériel.

### Données livraison disponibles

Historique de statuts complet et fiable (`order_events`, append-only, trigger anti-mutation). Montants
`delivery_cents`/`service_fee_cents`/`price_cents`/`pricing_rule_version` figés et immuables dès l'insertion
(triggers `0042`/`0043`). Adresses/GPS collecte+livraison, destinataire (nom/tél obligatoires, email
optionnel), distance/durée (figées, calculées via OSRM à la création). Preuve de livraison (code SMS /
signature / photo) existante mais liée à une politique de rétention opérationnelle courte (voir §3).
Manque : nature/quantité/poids structurés (`order_details` est du texte libre), lien vers un bon de commande
externe.

### Données commerçant

Table légale complète (`merchant_legal_information` : SIRET/SIREN, raison sociale, adresse légale,
adresse de facturation, TVA optionnelle, vérification Sirene). Mandat SEPA et compte Stripe. Manque :
représentant légal, forme sociale, RCS, capital ; et surtout **aucun snapshot figé par document** — ces
tables sont un état courant mutable.

### Données livreur

Nettement moins complet que le commerçant (constat vérifié dans le code, pas supposé) : `Driver` = `{id,
name, phone, zoneId, isAvailable}` uniquement. Aucune table légale équivalente à celle du commerçant :
pas de SIRET/SIREN/TVA/adresse/régime fiscal en base applicative — tout ce qui existe (KYC, identité) est
chez Stripe Connect (`driver_connect_accounts`, `entity_type: individual|company`). L'écran mobile « Mon
compte » a déjà un champ « Numéro SIRET » mais il est en lecture seule (`editable={false}`), sans backend
(`apps/mobile/app/(tabs)/compte/mon-compte.tsx`).

### Identifiants actuels

Tout est UUID technique (commande, événement, statement, settlement, Transfer, PaymentIntent, reversal).
Aucune numérotation séquentielle nulle part. La seule chose visible à l'utilisateur aujourd'hui est un
pseudo-repère non fiable : `#` + 6 derniers caractères de `order.id` (web `order-modal.tsx:100`, mobile
`order/[id]/index.tsx:150`) — **non unique garanti, non séquentiel, à ne pas considérer comme une solution
définitive.**

### Écrans actuels

Côté commerçant : détail commande riche (statut, timeline, prix ventilé, preuve, tracking) ; Mon Compte
complet côté légal. Côté livreur : détail course opérationnel, wallet par période, mais champs
entreprise/SIRET non enregistrables. Côté admin : seulement `apps/web/app/admin/settlements` (règlements,
incidents, reversals) — pas d'écran admin commandes ni profils séparé.

### Gaps identifiés (classés)

- **Bloquant future facture** : identité légale livreur absente ; aucun mandat écrit ; aucune numérotation
  séquentielle ; pas de traitement TVA explicite ; identités mutables sans snapshot par document.
- **Bloquant futur bon de livraison** : nature/quantité/poids non structurés ; destination/destinataire/prix
  obligatoires dès la création (bloque le cas destination inconnue, voir ci-dessous).
- **Utile non bloquant** : pas de référence humaine pérenne ; pas de lien bon de commande externe.
- **Futur seulement** : intégration plateforme agréée, e-reporting, génération de facture/avoir (Étape 4).

### Cas futur — destination inconnue au départ

Bloqué aujourd'hui par des contraintes `NOT NULL` bien identifiées et limitées : `delivery_address/lat/lng`,
`customer_name/phone`, `distance_m/duration_s/price_cents` (calculés par le routeur avant l'insert),
`zone_id`. Le schéma sait déjà gérer des champs remplis progressivement (livreur, dates, preuve, `order_
details`, `delivery_instructions` sont déjà nullable) — seule la destination/le destinataire/la tarification
sont aujourd'hui rigidement exigés dès la création. Techniquement peu coûteux à lever plus tard ; **pas
conçu ni implémenté à ce stade.**

## 2. Nuances validées par l'utilisateur (corrections au vocabulaire/portée)

**Conservation des preuves de livraison** — Ne pas considérer automatiquement les photos/signatures/preuves
comme des pièces comptables devant être conservées 10 ans (art. L123-22 du Code de commerce). Ce sont pour
l'instant des **preuves opérationnelles**, avec leur politique actuelle (suppression à 7 jours), sauf
décision future explicite. Les entreprises concernées (commerçants, livreurs) conservent leurs propres
factures selon leurs obligations légales ; la politique d'archivage documentaire éventuelle de Locadely sera
traitée plus tard, avec la facturation (Étape 4).

**Facturation par Locadely au nom du livreur** — Ne pas figer trop tôt le terme juridique
« autofacturation ». L'intention métier est : Locadely génère la facture du livreur → restaurant, au nom et
pour le compte du livreur, sous mandat. Le vocabulaire juridique final (autofacturation au sens de l'art.
242 nonies du CGI, ou autre montage) et les mentions exactes seront verrouillés à l'Étape 4, avec avis
juridique si nécessaire — pas avant.

**Facturation périodique** — Orientation retenue (non figée en détail avant l'Étape 4) : clôture
hebdomadaire (déjà le rythme des settlements, R40) ; une facture périodique regroupe plusieurs livraisons
du même livreur vers le même restaurant ; chaque ligne de facture devra identifier clairement la livraison
correspondante (d'où le besoin d'une référence humaine par livraison, Étape 2).

**Traçabilité** — Objectif permanent, non négociable à chaque étape suivante : `livraison → facture → avoir
→ refund/reversal → réclamation`, via une référence de livraison humaine stable et visible.

## 3. Étape 2 — Référence humaine + fiche livraison (analyse)

État : **done** (analyse) — analyse et plan terminés (Claude + Codex indépendants, comparés), décision de
format reçue le 2026-09-23 (voir note dans §3.1). Implémentation : §4.

Méthode : Claude Code a analysé seul (lecture repo + réflexion conception). Codex a reçu le même contexte
métier, sans les conclusions de Claude, a inspecté le dépôt lui-même et fait ses propres recherches web
(UPS, DHL Express, FedEx, Stuart, Uber Direct). Comparaison faite : convergence complète sur la fiche
livraison et les contraintes de compatibilité future ; un désaccord de fond sur le *format* de la référence
(sequentiel vs opaque), documenté ci-dessous plutôt que tranché arbitrairement.

### 3.1 Référence humaine de livraison

**Consensus (les deux analyses, aucun désaccord) :**
- Distincte du `tracking_token` UUID existant (`orders.tracking_token`, migration `0014`) — le token reste
  le seul secret d'accès au lien de suivi public ; la référence humaine n'est *jamais* utilisée comme clé
  d'accès.
- Attribuée dans la même transaction que la création **minimale** de la commande, avant tout calcul
  d'itinéraire/prix et avant que la destination soit connue — compatible par construction avec le futur cas
  « destination inconnue au départ ».
- Immuable une fois attribuée ; jamais réattribuée, y compris après annulation (même logique qu'un numéro de
  facture jamais réutilisé).
- Remplace le repère actuel `#` + 6 derniers caractères de l'UUID (`order-modal.tsx:100`,
  `order/[id]/index.tsx:150`), qui n'est ni unique garanti ni pérenne et ne doit plus être considéré comme
  une solution définitive.
- Générée par trigger SQL à l'insertion (même pattern que `price_cents`/`pricing_rule_version`,
  `0042_order_pricing_model.sql`), pas côté application.

**Décision requise avant code — format de la référence :**

| Option | Format exemple | Avantage | Risque |
| --- | --- | --- | --- |
| Séquentielle (proposition Claude, proche de l'exemple donné par l'utilisateur `#15526622`) | `#000482` ou `LCD-000482`, offset de départ non-nul | Courte, lisible, dictable au téléphone pour le support | Révèle le volume d'affaires à qui la voit — mais elle n'est **jamais publique** (visible seulement des acteurs authentifiés : commerçant, livreur, admin, et futurs documents envoyés à ces mêmes parties qui connaissent déjà l'échelle du pilote) |
| Opaque (proposition Codex) | `LCD-26-K7M3Q-8W9XF` (préfixe + année + 10 car. Crockford Base32) | Aucune fuite de volume même en cas de fuite d'un document | Nettement moins lisible/dictable ; s'éloigne de l'exemple `#15526622` donné par l'utilisateur comme cible |

Recommandation Claude : la référence n'étant exposée qu'aux parties déjà en relation contractuelle avec
Locadely (jamais sur le lien de suivi public, qui reste le `tracking_token` opaque), le risque de fuite de
volume est faible dans ce contexte B2B pilote mono-zone — privilégier la lisibilité (séquentielle) pour un
usage support/téléphone, quitte à démarrer la séquence à un offset non-nul.

**Décision utilisateur reçue le 2026-09-23** : numérique, 8 chiffres, **aléatoire** (pas de compteur
séquentiel strict — proche de l'exemple `#15526622`, mais chaque référence est un tirage aléatoire à 8
chiffres plutôt qu'un compteur incrémental). Détail définitif et implémentation : §4.

### 3.2 Fiche livraison structurée

Ce n'est pas nécessairement une nouvelle table isolée : une agrégation/vue au-dessus de `orders` +
`order_events` + preuve + (plus tard) ligne de règlement, organisée par moment de connaissance et règle de
gel :

| Bloc | Connu à | Règle de gel | Visibilité |
| --- | --- | --- | --- |
| Référence humaine, `tracking_token`, commerçant, zone/adresse de collecte, créneau | Création minimale | Figé dès la création | Réf. humaine : tous · token : commerçant seulement · admin : tout |
| Statut + historique d'événements | Progressivement | Append-only, horodatages non réécrits | Tous, détail complet côté admin |
| Livreur assigné | À l'assignation | Figé après finalisation de la course | Commerçant/admin ; le livreur voit son propre rattachement |
| Destinataire (nom, téléphone, email) | Aujourd'hui : création · demain : potentiellement après collecte | Mutable tant que non communiqué au livreur ; figé dès la collecte | Livreur seulement après collecte (filtrage déjà en place, `DriverOrder`) ; commerçant/admin toujours |
| Destination (adresse, GPS, consignes) | Idem | Mutable jusqu'au gel de l'itinéraire/prix ; correction ensuite tracée, jamais écrasée silencieusement | Livreur après collecte ; commerçant/admin |
| Marchandise | Création, collecte ou complétée progressivement | Ligne confirmée à la collecte = figée | Livreur : besoin opérationnel · commerçant/admin : complet |
| Référence externe restaurant (bon de commande, facultative) | Dès création ou plus tard | Figée dès première utilisation sur un document | Commerçant/admin |
| Route et prix (`distance_m`, `duration_s`, `pricing_rule_version`, `delivery_cents`, `service_fee_cents`) | Dès tarification possible | Déjà figés par trigger (`0042`/`0043`) | Livreur : sa part seulement · commerçant : ventilation + total · admin : complet |
| Paiement à la livraison (COD) | Création ou avant remise | Snapshot figé, encaissement horodaté une fois | Tous |
| Résultat final (complétée/retour/annulation, motif, preuve) | Fin de course | Statut/motif/horodatage figés ; preuve reste une **preuve opérationnelle** à rétention courte actuelle, non assimilée à une pièce comptable (voir §2 nuances) | Commerçant/admin ; livreur selon besoin |
| Dossier réclamation (futur) | Après incident | Relation séparée, ne modifie jamais la livraison d'origine | Commerçant/admin, livreur si impliqué |

Aucun écran admin des commandes n'existe aujourd'hui (seul `apps/web/app/admin/settlements`) — la colonne
« admin » ci-dessus décrit une exigence de conception, pas une interface existante.

### 3.3 Contraintes de compatibilité future (facture / avoir / réclamation / export)

- La référence humaine devra être portée par chaque future ligne de facture, avoir, reversal et réclamation
  — l'UUID technique reste une clé interne, jamais montrée sur un document.
- Une ligne facturable doit pouvoir restituer sans recalcul : référence, date de finalisation, commerçant,
  livreur, statut final, `delivery_cents`, `service_fee_cents`, version tarifaire — déjà le cas aujourd'hui
  (`postgres-order-repository.ts`).
- Granularité « une livraison = une unité traçable » à préserver, même si une facture hebdomadaire regroupe
  plusieurs livraisons (voir §2 orientation facturation périodique).
- Valeurs inconnues (cas destination inconnue) explicites (`null`), jamais de valeur de substitution
  fictive pour forcer la génération d'un document.
- Ne jamais écraser les faits ayant servi au calcul/à l'exécution ; une rectification doit être tracée sans
  altérer rétroactivement un document déjà émis.
- La fiche ne fige pas l'identité légale du commerçant/livreur (ce sera un snapshot propre à l'Étape 3/4,
  pas à anticiper ici) — elle contient seulement les liens + les faits opérationnels.

### 3.4 Points de vigilance — cas « destination inconnue au départ »

- La référence naît avec l'objet minimal (commerçant, point de collecte, date) sans dépendre de la
  destination ni du prix.
- La fiche doit pouvoir rester dans un état « incomplet » distinguable d'une livraison complète : pas de
  dispatch, pas de tarification définitive, pas de facturation tant que les champs requis manquent.
- Un jalon de gel explicite doit être défini (avant remise au livreur, ou au plus tard avant le calcul
  tarifaire définitif) — lequel reste à décider (§3.5), pas conçu ici.
- Le masquage actuel du destinataire au livreur avant `COLLECTED` doit être préservé quel que soit le
  jalon retenu.
- Aucune implémentation de ce cas dans l'Étape 2 — seule la non-régression de la conception ci-dessus est
  garantie.

### 3.5 Reste à décider avant de coder (Étape 2 → implémentation)

1. **Format exact de la référence humaine** (séquentielle vs opaque, voir tableau §3.1) — décision
   utilisateur requise.
2. Jalon exact de gel des données de course (collecte ? définition de destination ? tarification ?).
3. Qui peut compléter/corriger destination, destinataire, marchandise, référence externe, et jusqu'à quel
   statut.
4. Niveau minimal des lignes marchandise structurées (description/quantité seules, ou aussi unité/poids/
   contraintes).
5. Motifs normalisés d'annulation/retour/litige et visibilité du futur dossier réclamation au livreur.
6. Référence externe restaurant : facultative et unique par commerçant, ou librement réutilisable ?

Une fois ces points tranchés (notamment le #1), l'implémentation de l'Étape 2 peut être conçue en détail
(schéma, migration, endpoints, écrans) — non commencée à ce stade.

## 4. Étape 2 — Implémentation

État : **done** (2026-09-23, détails en §4.5). Décision utilisateur : format **numérique, 8 chiffres,
aléatoire**
(ex. `#15526622`), tranchant le point §3.5.1 en faveur de la lisibilité plutôt que de l'opacité.

### 4.1 Décision finale du format

- Colonne `orders.public_reference` : `text`, exactement 8 chiffres (`^[0-9]{8}$`), zero-paddé (plage
  00000000-99999999, entropie complète — pas de restriction du premier chiffre).
- Affichage : `#` ajouté côté UI uniquement ; jamais stocké avec le `#`.
- Générée en base par trigger `BEFORE INSERT` (jamais côté application, jamais acceptée en entrée API).
- Unicité garantie par contrainte `UNIQUE` Postgres (`orders_public_reference_key`) — la boucle de
  génération (jusqu'à 30 tentatives, vérifiant `NOT EXISTS`) réduit juste la probabilité de collision ; la
  contrainte reste la garantie réelle. Concurrence : en cas de collision de dernière seconde entre deux
  transactions concurrentes (fenêtre de temps entre le `NOT EXISTS` et le commit), l'`INSERT` échoue avec
  une violation `23505` sur `orders_public_reference_key` — géré par une **relance applicative** de
  l'insertion complète côté backend (le trigger régénère un nouveau candidat à chaque tentative).
- Immuable après attribution (trigger `guard_order_public_reference_immutable`, même régime que
  `distance_m`/`duration_s`/`price_cents`) ; jamais réattribuée après annulation.
- Indépendante de `orders.id` (UUID technique interne, inchangé) et de `orders.tracking_token` (reste
  l'unique secret d'accès au suivi public, inchangé) — jamais utilisée comme mécanisme d'accès ou
  d'authentification.

### 4.2 Scope exact

- Migration `supabase/migrations/0045_order_public_reference.sql` : colonne, génération, backfill des
  commandes existantes, contraintes, immuabilité.
- Backend : exposition de `publicReference` dans les DTO/domaine `orders` (création, lecture, listes
  commerçant/livreur), sans changement de logique métier ni de règles financières.
- Web commerçant : remplacement de `#` + 6 derniers caractères de l'UUID par la référence humaine (liste +
  détail commande).
- Mobile livreur : même remplacement (liste des courses, détail course, écrans paiement/preuve).
- Fiche livraison : confirmée comme une agrégation des données déjà existantes (pas de nouvelle table), la
  référence humaine s'y ajoute comme champ d'identification principal.

### 4.3 Hors-scope (explicitement, documenté ici comme demandé)

Non traité dans cette tranche — chantiers séparés, contraintes actuelles volontairement laissées en l'état :

- Le futur cas « livreur envoyé au restaurant avant de connaître destination/destinataire/marchandise ».
  Aucune contrainte `NOT NULL` liée à la destination n'est modifiée ; aucun changement du workflow de
  création, du calcul OSRM, ni des règles de gel destination/tarification.
- Le modèle de marchandise structuré (quantité/poids/volume).
- Les motifs normalisés de retour/annulation et le futur workflow de réclamation.
- L'affichage de la référence humaine sur les lignes de règlement (`/merchant/settlements`) : cet écran
  n'affiche aujourd'hui **aucun** identifiant de commande (ni UUID ni pseudo-référence) — rien à
  « remplacer ». L'ajouter serait une fonctionnalité nouvelle, pas un remplacement ; laissé pour une
  tranche ultérieure afin de ne pas toucher inutilement le module `settlements`.
- Aucun écran admin commandes n'est créé pour cette tâche (aucun n'existe aujourd'hui, seul
  `/admin/settlements`) — les DTO/domaine restent néanmoins compatibles avec un futur usage admin.
- Aucun PDF, aucune facture, aucun snapshot juridique.

### 4.4 Découpage d'implémentation et répartition

| Lot | Contenu | Qui |
| --- | --- | --- |
| 1 | Migration SQL (schéma, génération, backfill, contraintes, immuabilité) | Claude Code |
| 2 | Validation migration (fresh-install + upgrade sur bases jetables, concurrence/collision, format) | Claude Code |
| 3 | Backend TypeScript (domaine `Order`, repository, DTO, routes — exposition `publicReference`, retry sur collision) | Codex |
| 4 | Mobile livreur (liste courses, détail course, écrans paiement/preuve) | Codex |
| 5 | Web commerçant (liste commandes, détail commande) | Claude Code |
| 6 | Revue complète des lots 3-4 par Claude Code, corrections si nécessaire | Claude Code |
| 7 | Tests (ciblés commandes, typecheck, non-régression settlements/pricing) | Claude Code + Codex |
| 8 | Documentation finale (ce fichier + `CLAUDE.md` concernés) | Claude Code |

### 4.5 Résultats

État final : **done**. Étape 2 implémentée, testée, documentée.

**Migration** : `supabase/migrations/0045_order_public_reference.sql` (colonne, génération par
trigger, backfill, contraintes, immuabilité). Validée par Claude Code sur bases jetables avant
application à la base de dev partagée :
- Fresh-install : toutes les migrations 0001→0045 sur base vide, 500 commandes insérées en
  masse → 500 références uniques, format `^[0-9]{8}$` respecté à 100%.
- Upgrade : 50 commandes créées sur schéma pré-0045 (sans la colonne), puis migration 0045
  appliquée par-dessus → 50 références rétro-attribuées, toutes uniques, aucune perte de
  données.
- Immuabilité vérifiée (`UPDATE` sur `public_reference` refusé par trigger).
- Appliquée à la base de dev partagée via `npx supabase migration up --local` : 19 commandes
  existantes rétro-attribuées avec succès (dont des références commençant par un zéro,
  confirmant que le zero-padding texte est préservé de bout en bout).

**Backend** (Codex, revu et corrigé par Claude Code) :
- `apps/api/src/modules/orders/domain/order.ts` : `publicReference: string` sur `Order`
  (hérité par `MerchantOrder`/`DriverOrder`/`DriverHistoryOrder`/`AvailableOrder`).
- `apps/api/src/modules/orders/infrastructure/postgres-order-repository.ts` : `OrderRow` +
  `mapOrder` + colonne ajoutée à `driverOrderSelect` (seule requête à liste explicite de
  colonnes, le reste utilise `select *`/`o.*`) ; `create()` relance l'insertion complète
  jusqu'à 3 fois sur violation `23505` de `orders_public_reference_key` uniquement.
- `apps/api/test/dispatch/notify-next-candidate.test.ts` : fixture mise à jour.
- **Correction Claude Code après revue** : l'indentation de `create()` était cassée après
  l'ajout de la boucle de relance (Codex n'a pas pu exécuter `prettier` dans son bac à sable,
  aucun réseau). Reformatée avec la config réelle de ce dépôt (pas de `.prettierrc` commité :
  `apps/api` = guillemets simples/sans point-virgule, `apps/mobile` = guillemets simples/avec
  point-virgule, déduit de l'usage existant) — jamais les valeurs par défaut de `prettier`, qui
  auraient introduit guillemets doubles + points-virgules incohérents avec tout le reste du
  fichier.

**Mobile** (Codex, revu par Claude Code) :
- `apps/mobile/lib/orders-types.ts`, `components/order-card.tsx`,
  `app/order/[id]/{index,proof,payment}.tsx`. `proof.tsx`/`payment.tsx` ne reçoivent que
  l'UUID en paramètre de route : `publicReference` leur est transmis en paramètre
  supplémentaire depuis `index.tsx` (même mécanisme que `version`/`codAmountCents` déjà en
  place), pas de nouvel appel API.

**Web** (Claude Code) :
- `apps/web/lib/orders.ts` (`Order.publicReference`), `components/order-modal.tsx` (titre de la
  fiche), `app/merchant/orders/page.tsx` (recherche, qui filtrait auparavant sur l'UUID
  tronqué). `components/order-card.tsx` (liste web) n'affichait déjà aucun identifiant —
  rien à remplacer là.

**Tests** :
- `npm run typecheck -w apps/api` / `-w apps/web` / `-w apps/mobile` : tous verts.
- Suite complète `apps/api` (Claude Code, contre la base de dev locale — le bac à sable Codex
  n'a pas d'accès réseau à Postgres) : 839 tests passés, 6 échecs, **aucun dans le module
  `orders`** ni lié à `public_reference`. Les 4 fichiers en échec sont préexistants et sans
  rapport : `test/http/merchants.http.test.ts` (la ligne commerçant seed `22222222…` a été
  modifiée par une activité de test/dev antérieure — nom et adresse ne correspondent plus au
  seed d'origine ; **non corrigé**, hors scope de cette tranche, signalé ici plutôt que
  silencieusement ignoré) ; `test/cash-on-delivery/cod-reconciliation.integration.test.ts` et
  `test/realtime/outbox-worker.test.ts` (×2, assertions de timing/concurrence, caractère
  intermittent déjà connu de ce type de test).

**Nettoyage des commandes de simulation (`merchant 22222222…`) — bloqué, pas seulement
oublié** : la règle d'hygiène habituelle (mémoire `cleanup-simulation-orders`) demandait de
désactiver le trigger d'immuabilité `order_events` pour purger ces lignes. Cette méthode
contredit maintenant la règle D-R d'`apps/api/CLAUDE.md` (2026-09-22) : jamais de garde
PostgreSQL désactivée pour faciliter un nettoyage/test. Tentative de suppression sans désactiver
le trigger constatée en échec propre (transaction annulée dans son ensemble, aucune donnée
perdue) : `orders` a aussi des enfants `NO ACTION` (`dispatch_offers`,
`order_delivery_completion_sessions`, `order_cash_on_delivery_payments`, `settlement_lines`,
`driver_transfer_reversals`, `driver_reversal_service_refunds`) en plus d'`order_events`. La
base de dev partagée accumule donc ces commandes de test sans mécanisme de purge conforme aux
règles actuelles — mémoire mise à jour en conséquence ; décision de purge (et comment) à
reprendre avec l'utilisateur si le volume devient gênant.

**Hors-scope confirmé non touché** : contraintes `NOT NULL` destination, workflow de création,
calcul OSRM, règles de gel, modèle marchandise, motifs retour/annulation, réclamation,
`/merchant/settlements` (aucun identifiant de commande n'y est affiché aujourd'hui — rien à
remplacer), écran admin commandes (n'existe pas), `modules/settlements`, `modules/pricing`.

**Documentation mise à jour** : ce fichier, `apps/api/CLAUDE.md` (nouvelle entrée
`public_reference`). `docs/work/invoicing-preparation-plan.md` reste la source de vérité du
chantier F-PREP pour la suite (Étape 3 : identités légales commerçant/livreur — non commencée).

## 5. Étape 3 — Identités légales et documents (analyse + plan)

État : **review** — analyse Claude + analyse Codex indépendante (même contexte métier, sans mes
conclusions, inspection propre + recherche web propre) comparées, aucun désaccord matériel.
Objectif de l'étape (formulation exacte) : « permettre à Locadely de collecter et stocker
proprement les informations personnelles, professionnelles et les justificatifs nécessaires
pour les livreurs et les commerçants » — sans vérification administrative. Aucun code, aucune
migration, aucune UI, aucun bucket créés à ce stade.

**Hors-scope explicite de cette tranche** (à ne pas construire) : interface admin de
vérification, workflow `pending/verified/rejected`, contrôle manuel des documents, validation
automatique Kbis/CNI, OCR, reconnaissance faciale, comparaison document↔champs, blocage de
compte selon statut de vérification, génération de facture, snapshot juridique, facturation
électronique, Étape 4 en général.

### 5.1 État actuel

**Livreur** : `drivers` = `id, name, zone_id, is_available, phone (nullable), push_token`. Ni
prénom/nom séparés, ni e-mail, ni donnée professionnelle, ni document. Backend : `GET
/api/v1/drivers/me` uniquement — **aucun endpoint de modification de profil n'existe**. E-mail
déjà disponible sans nouvelle colonne (`AuthenticatedUser.email` du JWT Supabase, non lu
aujourd'hui dans les routes). **Incohérence trouvée** : l'écran mobile `mon-compte.tsx` affiche
prénom/nom/téléphone depuis `user.user_metadata` (Auth), pas depuis `drivers.name`/`phone` (la
source métier réelle, utilisée côté commerçant/dispatch) — deux sources qui peuvent diverger.
Champ « Date de naissance » et badge « Non vérifié » présents dans l'UI sans justification ni
backend. Champs SIRET/entreprise et boutons Kbis/CNI déjà en UI mais désactivés (toasts
« bientôt disponible »).

**Commerçant** : `merchants` (opérationnel) + `merchant_legal_information` (1:1, migration
`0020`) déjà solide (SIRET/SIREN, raison sociale, adresse légale + facturation structurées,
TVA optionnelle, statut Sirene). Routes `GET/PATCH /api/v1/merchants/me/legal-information` à
mirrorer pour le livreur. **Manque réellement vérifié** : ni `legal_form` ni `vat_regime` dans
`merchant_legal_information` (pas seulement un manque côté livreur). Aucun champ « responsable
du compte » nulle part. Aucune section document dans `apps/web/app/merchant/account/page.tsx`
(3 sections actuelles : commerce / légal-facturation / compte). Validation Zod actuelle faible
sur `vat_number`/code postal (pas de contrôle de format strict).

**Stockage documents** : bucket `merchant-logos` (Supabase Storage) **public**, URL permanente,
upload par `fetch` + clé service role — mécanisme réutilisable, mode d'accès à ne pas reprendre.
`order_proof_assets` : `bytea` direct en PostgreSQL, transitoire (7 jours) — adapté à une preuve
opérationnelle petite, pas à un justificatif durable (poids sauvegardes/restaurations, risque
d'exposition accidentelle). `supabase/config.toml` : Storage local actuellement désactivé.
Tables `public` déjà verrouillées côté Data API (migration `0026`) ; aucune policy Storage
privée n'existe encore. **Conclusion : bucket Supabase Storage privé neuf, jamais le pattern
`merchant-logos`, jamais `bytea`.**

### 5.2 Modèle proposé

- **`driver_legal_information`** (1:1, symétrique à `merchant_legal_information`) :
  `driver_id` (PK/FK) · `first_name`, `last_name` · `professional_name` · `siret`/`siren`
  (dérivation serveur identique) · adresse légale structurée · adresse de facturation
  structurée optionnelle (même contrainte tout-ou-rien) · `vat_number` optionnel ·
  `vat_regime` (enum `subject_to_vat | vat_exempt | franchise_in_base`, jamais déduit du
  numéro de TVA) · `legal_form` optionnel.
- **`merchant_legal_information`** : ALTER additif, `legal_form` + `vat_regime`.
- **`merchant_account_contact`** (1:1, nouveau) : `merchant_id` (PK/FK) · `first_name`,
  `last_name`, `phone`. E-mail du responsable = e-mail du compte Auth existant, renvoyé
  explicitement par l'API, jamais dupliqué en base.
- **Livreur, pas de duplication** : e-mail = JWT Auth (`request.authUser.email`, zéro nouvelle
  colonne) ; téléphone = `drivers.phone` reste la source (route de modification à ajouter) ;
  `drivers.name` conservé comme libellé opérationnel, prénom/nom structurés affichés dès qu'ils
  existent — pas de troisième source de vérité. Pas de date de naissance.
- **`account_documents`** (table générique unique) : `id` · propriétaire exclusif (`driver_id`
  XOR `merchant_id`, CHECK) · `document_type` (`identity_document | kbis`) · `storage_path`
  (unique) · `original_filename` · `content_type` · `size_bytes` · `uploaded_at` ·
  `replaced_at` (nullable) · `storage_deleted_at` (nullable). Une seule version courante par
  `(propriétaire, document_type)` via index unique partiel `where replaced_at is null`. Aucune
  colonne `verified`/`rejected`/statut de workflow.
- **Validations Zod** : SIREN 9 chiffres, SIRET 14 chiffres + SIREN dérivé cohérent, TVA FR
  (`FR` + clé 2 + 9 chiffres) si renseignée, code postal 5 chiffres si `countryCode=FR`, pays
  ISO alpha-2. Fichiers : `application/pdf`/`image/jpeg`/`image/png` uniquement, 10 Mio max,
  signature binaire vérifiée côté serveur (pas seulement le `content-type` déclaré).

### 5.3 Sécurité

Bucket privé neuf (`account-documents`), jamais de préfixe `/public/`. Chemins non devinables
et cloisonnés par propriétaire (`drivers/{driverId}/{identity|kbis}/{documentId}.{ext}`,
`merchants/{merchantId}/...`). Toute opération passe par l'API Fastify authentifiée (rôle +
`authUser.id` + ligne de métadonnées vérifiés avant upload/lecture/remplacement/suppression) —
jamais d'accès direct navigateur→Storage. Policies Storage en défense en profondeur : accès
propriétaire à son seul préfixe, futur rôle `admin` explicitement prévu, aucun accès `anon`,
aucun `list` global. Lecture = URL signée courte (~5 min), générée à la demande, jamais
persistée ni renvoyée dans un endpoint de liste. Remplacement : upload du nouveau → transaction
DB (ancien `replaced_at`, nouveau courant) → suppression de l'ancien objet Storage ; échec de
suppression = objet rendu inaccessible immédiatement, repris par nettoyage différé. Jamais de
buffer/nom de fichier complet/URL signée/en-tête `Authorization` dans les logs.

### 5.4 UX proposée

**App livreur** (`mon-compte.tsx` adapté, pas réécrit) : Informations personnelles → Informations
professionnelles → Documents (état neutre « Déposé le … » / « À déposer », remplacement).
Badge « Non vérifié » et champ date de naissance supprimés.

**Dashboard commerçant** (3 sections existantes conservées) : nouvelle section **Responsable du
compte** insérée avant « Informations légales » → section légale existante étendue
(forme/régime TVA) → nouvelle section **Documents** (CNI du responsable, Kbis entreprise).

Aucun blocage de compte/courses/paiement lié au dépôt documentaire à ce stade.

### 5.5 Cadre CNIL/RGPD (décision ouverte, à valider avant code)

Principe de minimisation CNIL : une copie de CNI n'est conservée que si une simple saisie des
champs ne suffit pas à la finalité déclarée — conservation justifiée, proportionnée, durée
définie ([CNIL — minimisation](https://www.cnil.fr/fr/definition/minimisation), [CNIL —
NS-058](https://www.cnil.fr/sites/cnil/files/atoms/files/ns-058.pdf)). Aucune durée CNIL
universelle ne s'applique automatiquement ; la base légale (contrat vs obligation légale) doit
être arrêtée explicitement — rien ne permet de conclure que la collecte CNI/Kbis de ce périmètre
relève d'une obligation légale automatique. Le Kbis/RNE a un statut différent (registre en
principe public, art. L123-52 Code de commerce) mais cela n'exempte pas des règles RGPD s'il
porte des données personnelles. **Décision à prendre avant implémentation finale (pas
bloquante pour l'analyse) : durée de conservation et base légale exacte, à valider
juridique/DPO.** CNI/Kbis privés dès la conception (§5.3) dans tous les cas.

### 5.6 Tests courts prévus

Données : enregistrer infos perso/pro (livreur + commerçant) · relecture après rechargement ·
modification d'un champ autorisé · rejet SIREN/SIRET invalide · rejet TVA/téléphone/code
postal/pays non conformes. Documents : upload CNI · upload Kbis · refus format non admis ·
refus fichier trop gros · relecture de ses propres documents · isolation (un autre
livreur/commerçant ne peut ni lister ni obtenir d'URL signée) · remplacement propre. Front :
Mon Compte recharge les données enregistrées · documents existants affichés comme déposés ·
aucune URL privée exposée durablement. Régression minimale : `typecheck`, `lint`, tests ciblés
backend (domain/Zod + HTTP driver/merchant/documents + isolation).

### 5.7 Compatibilité facturation future (vérification, pas conception)

Le modèle fournit à l'Étape 4 : côté livreur — identité personnelle structurée, identité
professionnelle, SIREN/SIRET, adresse (+ facturation), TVA/régime, forme juridique, pièces
déposées ; côté commerçant — identité légale existante + forme/régime TVA ajoutés, adresse
légale/facturation, SIREN/SIRET, responsable de compte, pièces déposées. Aucun snapshot
juridique, aucune facture, rien de généré à ce stade.

### 5.8 Plan d'implémentation (ordonné, non commencé)

1. Décision préalable non-technique : finalité, base légale par finalité, durée de
   conservation/purge, notice d'information — validées juridique/DPO avant tout code touchant
   les documents.
2. Migration additive : `driver_legal_information`, `merchant_account_contact`, ALTER
   `merchant_legal_information` (+`legal_form`/`vat_regime`), `account_documents`.
3. Activer/configurer Supabase Storage (bucket privé `account-documents`, limites MIME/taille,
   policies propriétaire + futur admin).
4. Backend : ports/repositories/use cases + routes `GET/PATCH` profils légaux livreur
   (symétrique au merchant existant) + endpoint de modification profil driver manquant.
5. Backend : port de stockage documentaire (upload contrôlé, métadonnées, URL signée courte,
   remplacement + purge de l'ancien objet).
6. Tests DB/API (validation, isolation, remplacement) avant les écrans.
7. Mobile (Codex) : 3 sections dans `mon-compte.tsx`, retrait badge/DOB factices.
8. Web (Claude Code) : section responsable + documents dans `merchant/account/page.tsx`,
   sections légales existantes étendues.
9. `typecheck`/`lint`/tests ciblés + vérification manuelle qu'aucune URL privée n'est
   durablement exposée.
10. Mise à jour finale de ce fichier avec ce qui a été réellement implémenté.

Répartition confirmée pour l'implémentation future : Claude Code = SQL/migrations/policies
Storage/web/revue-correction Codex ; Codex = backend TypeScript/mobile (voir mémoire
`backend-dev-goes-to-codex`).

### 5.9 Résultats

État final : **done**. Étape 3 implémentée, revue en profondeur, corrigée, testée. Aucun
workflow admin, aucune vérification, aucune facture — hors-scope intact (vérifié en revue).

**Migration** : `supabase/migrations/0046_account_legal_information_and_documents.sql`
(`drivers.first_name`/`last_name`, `driver_legal_information`, ALTER
`merchant_legal_information` +`legal_form`/`vat_regime`, `merchant_account_contact`,
`account_documents`). Validée fresh-install (500 lignes en masse, formats/contraintes/
remplacement/immutabilité testés en SQL direct) + upgrade (données pré-existantes intactes)
sur bases jetables avant application à la base de dev partagée.

**Storage** : bucket privé `account-documents` créé sur le **projet Supabase hébergé réel**
(`SUPABASE_URL` — ce dépôt n'a que Postgres en local, port 54322 ; Auth et Storage tournent
sur le projet hébergé, le Storage local du CLI reste désactivé à dessein, voir
`supabase/config.toml` et la nouvelle note dans `apps/api/CLAUDE.md`), `public: false`, 10 MiB,
MIME `application/pdf`/`image/jpeg`/`image/png`. Vérifié par appels HTTP réels (upload, URL
signée, refus d'accès public, suppression) avant toute écriture de code applicatif.

**Modèle final** : `driver_legal_information` (1:1, symétrique à `merchant_legal_information`,
sans vérification Sirene pour le livreur) ; `merchant_legal_information` étendue
(`legal_form`, `vat_regime` — jamais déduit de `vat_number`) ; `merchant_account_contact`
(1:1, responsable du compte, e-mail = compte Auth jamais dupliqué) ; `account_documents`
(table générique, propriétaire exclusif driver XOR merchant, `document_type` générique
`identity_document`/`business_registration_document` — jamais le mot « Kbis » comme type
technique, seulement comme libellé UI « Kbis / RCS / extrait K / attestation SIRENE »).

**Upload / remplacement / suppression** : upload → validation de la signature binaire réelle
(PDF/JPEG/PNG, pas seulement le `content-type` déclaré) + taille ≤ 10 MiB → objet Storage écrit
→ transaction DB (ancien courant marqué `replaced_at`, nouveau inséré) → **ancien objet Storage
supprimé après coup, best-effort, jamais bloquant** (bug trouvé en revue : la première version
de Codex ne supprimait jamais l'ancien objet, corrigé — voir « Problèmes trouvés »). Suppression
sans remplacement : même principe (`replaced_at` posé, objet Storage supprimé best-effort). Un
seul document courant par (propriétaire, type), garanti par index unique partiel en base.

**Sécurité** : propriétaire toujours dérivé de `request.authUser.id` + rôle (JWT), jamais d'ID
accepté en entrée nulle part ; aucune route ne permet à un compte d'agir sur les documents d'un
autre. URL signée 5 minutes, générée à la demande, jamais persistée, jamais dans la liste des
documents (type/nom/date uniquement). Jamais d'URL `/storage/v1/object/public/...`.

**Backend** (Codex, deux passes + corrections Claude Code) : `PATCH /api/v1/drivers/me`
(prénom/nom/téléphone, `drivers.name` recalculé dans la même requête — résout l'incohérence
`user_metadata` vs `drivers.name/phone`) ; `GET/PATCH /api/v1/drivers/me/legal-information` ;
`GET/PATCH /api/v1/merchants/me/account-contact` ; nouveau module `modules/documents`
(`GET/POST /api/v1/{drivers,merchants}/me/documents`, `GET .../documents/:type/signed-url`,
`DELETE .../documents/:type`). E-mail toujours lu depuis le JWT (`request.authUser.email`),
jamais une colonne dédiée. SIRET/adresse dupliqués localement dans `drivers` plutôt qu'importés
depuis `merchants` (règle absolue du projet : aucun import cross-module hors `public.ts`).
Limite globale `@fastify/multipart` relevée de 2 à 10 MiB.

**Mobile** (Codex) : `mon-compte.tsx` restructuré en 3 sections (personnelles/
professionnelles/documents), badge « Non vérifié » et date de naissance factices retirés,
`expo-document-picker` ajouté (Kbis/RCS souvent en PDF, `expo-image-picker` seul ne l'aurait
pas permis).

**Web** (Claude Code) : `merchant/account/page.tsx` — nouvelle section « Responsable du
compte » avant la section légale, champs forme juridique/régime TVA ajoutés à la section
légale existante, nouvelle section « Documents » (dépôt/remplacement/suppression, état
« À déposer »/« Déposé le … », jamais de bouton « voir » — pas demandé, évite d'exposer une
URL signée inutilement dans le DOM). Sections existantes non réécrites.

**Problèmes trouvés et corrigés en revue** (Claude Code) :
- **Bug réel** : l'ancien objet Storage n'était jamais supprimé lors d'un remplacement
  (`UploadAccountDocumentUseCase` n'avait aucun moyen de connaître l'ancien `storage_path`) —
  corrigé : `AccountDocumentRepository.replace()` renvoie désormais le chemin remplacé, l'objet
  est supprimé après coup en best-effort avec un `warn` structuré en cas d'échec.
- Contrat web/backend incohérent : la liste des documents renvoie `{ documents: [...] }`, le
  web attendait un tableau nu — corrigé côté web.
- `merchant_account_contact` non implémenté dans la première passe, mobile sans support PDF,
  typecheck mobile non relancé — trois manques signalés par Codex lui-même, complétés dans une
  seconde passe.
- Import manquant (`expo-document-picker` ajouté à `package.json` mais jamais installé) et une
  erreur de typage (`headers: undefined` explicite, refusé par `exactOptionalPropertyTypes`)
  faisaient échouer le vrai typecheck mobile malgré le rapport de Codex — corrigés, `npm
  install` exécuté, typecheck reconfirmé vert indépendamment.
- Imports morts et 4 `any` non typés (lint) — corrigés avec des types explicites plutôt que des
  suppressions de règle.
- Donnée de test dérivée trouvée en cours de route : le commerçant seed
  (`22222222-...`) avait été modifié par une activité de test antérieure (nom/adresse
  différents du seed d'origine), faisant échouer `merchants.http.test.ts` sans rapport avec
  cette étape — restauré aux valeurs de `supabase/seed.sql`.

**Tests exécutés et résultats** : 4 nouveaux fichiers de tests ciblés (Claude Code, Codex n'en
avait écrit aucun faute d'accès DB dans son bac à sable) — `test/drivers/legal-information.
test.ts` (SIRET/SIREN dérivé, `vatRegime` jamais déduit automatiquement), `test/documents/
account-documents.test.ts` (signature binaire PDF/JPEG/PNG, taille, remplacement sans orphelin
Storage — couvre directement le bug corrigé ci-dessus), `test/http/documents.http.test.ts`
(isolation par rôle, propriétaire toujours dérivé du JWT, aucune fuite de `storage_path`/id
dans les réponses), `test/merchants/account-contact.test.ts` (upsert, pas d'accumulation) — 24
tests, tous verts. Suite complète `apps/api` (contre la base de dev réelle) : ré-exécutée après
correction du seed, **89/90 tests verts sur le périmètre drivers/merchants/documents** (le
seul échec restant, une fois isolé, s'est révélé être le seed déjà corrigé ci-dessus — retesté
seul, vert). Sur la suite complète du dépôt (977 tests), les échecs restants (`cash-on-delivery`
timeouts de connexion, tests de concurrence outbox) sont confirmés environnementaux — contention
de 115 workers Vitest sur une seule base Postgres partagée, reproduits absents en réexécution
ciblée, sans rapport avec cette étape. `npm run typecheck`/`lint` verts sur les trois apps.
Serveur `apps/api` démarré réellement : les trois nouvelles routes répondent 401 (protégées,
jamais 404/500) — confirme le câblage réel du module en dehors des tests.

**Hors-scope confirmé non touché** : aucune interface admin de vérification, aucun statut
`pending/verified/rejected`, aucun OCR, aucune comparaison automatique, aucun blocage de compte,
aucune génération de facture/avoir/snapshot, aucune facturation électronique, Étape 4 non
commencée.

## 6. Étape 4 — Moteur de facturation interne (analyse + plan)

État : **review** — analyse Claude + analyse Codex indépendante, deux passes successives
(1re passe le 2026-09-23 : facture périodique hebdomadaire par `settlement_statement`/
`merchant_settlement` ; 2e passe le 2026-09-23, MÊME JOUR, après réévaluation utilisateur :
**modèle remplacé par « 1 livraison finalisée = 1 facture livreur + 1 facture Locadely »**,
voir §6.3 et §6.9-6.11). Aucun désaccord matériel entre Claude et Codex sur aucune des deux
passes. Aucun code, aucune migration, aucune facture générée. Le §6.2 (cadre juridique) reste
valable dans son ensemble ; seul le point « facture périodique » y est marqué superseded.

### 6.1 Situation actuelle vérifiée dans le code

`orders.delivery_cents`/`service_fee_cents`/`pricing_rule_version` figés à l'insertion (trigger,
`0042`), jamais recalculés. Le ledger (`0043`) copie sans recalcul :
`settlement_lines.delivery_cents/service_fee_cents` (1 ligne = 1 commande, `order_id` unique) →
`settlement_statements.due_cents = Σ delivery_cents` (**1 statement = 1 livreur × 1 restaurant ×
1 période**) → `merchant_settlements.amount_cents = driver_amount_cents + service_fee_cents`
(**1 règlement = 1 restaurant × 1 période, tous livreurs confondus**). `debit_attempts` débite le
restaurant une fois par période pour le total tous livreurs ; `driver_transfers` verse chaque
livreur séparément (`source_transaction`) ; `driver_transfer_reversals` (faute livreur/erreur
Locadely) et `driver_reversal_service_refunds` (remboursement service automatique, cumulatif)
liés respectivement au transfert et à la commande. `orders.public_reference` (`0045`) et les
identités légales (`0046`, driver + merchant) sont réutilisables telles quelles.

**Aucune table facture/avoir n'existe. Aucune TVA n'est calculée nulle part** —
`delivery_cents`/`service_fee_cents` sont HT au sens produit (affichage web/mobile) mais rien ne
le formalise en base (pas de taux, pas de mention, pas de régime appliqué à l'émission).

**Constat structurant, vérifié indépendamment par les deux analyses** :
`settlement_statement` = unité naturelle de la **facture livreur** (jamais `merchant_settlement`,
qui mélange plusieurs livreurs) ; `merchant_settlement` = unité naturelle de la **facture
Locadely** (tous livreurs de ce restaurant pour la période).

### 6.2 Cadre juridique confirmé (sources, avec distinction obligation/interprétation/décision)

- **[Obligation]** Le mécanisme n'est **pas l'« autofacturation »** au sens strict (réservée au
  cas où le *client* établit lui-même la facture). Locadely est un **tiers mandaté** par le
  livreur (fournisseur) — le bon terme est *facturation par un tiers mandaté*, même fondement
  légal (art. 289 CGI, art. 242 nonies annexe II) mais terminologie distincte.
  ([CGI art. 289](https://www.legifrance.gouv.fr/codes/article_lc/LEGIARTI000048827413/2026-05-08),
  [BOFiP](https://bofip.impots.gouv.fr/bofip/13244-PGP.html/identifiant=BOI-TVA-DECLA-30-20-10-30-20220629))
- **[Obligation]** Mandat écrit préalable requis ; le livreur (mandant) reste responsable de sa
  facture et de sa TVA ; délai de contestation à prévoir dans le mandat. Mention recommandée :
  « Facture établie par Locadely au nom et pour le compte de [livreur] ».
  ([BOFiP](https://bofip.impots.gouv.fr/bofip/1525-PGP.html/identifiant=BOI-TVA-DECLA-30-20-10-20140113))
- *[Interprétation]* Un mandat dans les CGU peut suffire s'il est explicite, tracé et accepté
  individuellement (jamais un simple silence) — **{décision produit, forme + délai de
  contestation, validation juridique requise avant conception détaillée}**.
- *[SUPERSEDED §6.9]* **[Obligation]** Facture périodique/récapitulative autorisée pour
  plusieurs prestations à un même client dont la TVA devient exigible **au cours d'un même mois
  civil**, émise au plus tard fin de ce mois — pertinent seulement si un regroupement
  hebdomadaire était retenu ; **le modèle validé §6.3 (une facture par livraison) n'en a plus
  besoin, cette contrainte disparaît.**
  ([CGI art. 289](https://www.legifrance.gouv.fr/codes/article_lc/LEGIARTI000048827413/2026-05-08),
  [BOFiP](https://bofip.impots.gouv.fr/bofip/13245-PGP.html/identifiant=BOI-TVA-DECLA-30-20-10-40-20210813))
- **[Obligation]** Une facture NORMALE (non périodique) doit être émise dès la réalisation de la
  prestation, sans délai imposé en principe ; tolérance de quelques jours pour raisons de
  gestion administrative, au plus tard le 15 du mois suivant le fait générateur. C'est le régime
  qui s'applique au modèle validé (une facture = une livraison). Le moment d'émission de la
  facture est distinct de l'exigibilité de la TVA (encaissement) : émettre avant paiement ne
  pose aucun problème.
  ([BOFiP — date d'émission](https://bofip.impots.gouv.fr/bofip/13245-PGP.html/identifiant=BOI-TVA-DECLA-30-20-10-40-20210813))
- **[Obligation]** Numérotation unique/chronologique/continue, **propre à chaque mandant** quand
  un tiers mandaté émet pour plusieurs fournisseurs — jamais une séquence partagée entre
  livreurs. ([CGI annexe II art. 242 nonies A](https://www.legifrance.gouv.fr/codes/article_lc/LEGIARTI000050811276/2025-01-01),
  [BOFiP](https://bofip.impots.gouv.fr/bofip/140-PGP.html/identifiant=BOI-TVA-DECLA-30-20-20-10-20131018))
- **[Obligation]** TVA 20% (taux normal, prestation de transport/livraison, aucun taux réduit
  applicable) ; franchise en base ⇒ mention « TVA non applicable, art. 293 B du CGI », jamais de
  TVA facturée ; régime par défaut d'une prestation de service = **TVA sur encaissement**, sauf
  option expresse pour les débits.
  ([BOFiP taux](https://bofip.impots.gouv.fr/bofip/1376-PGP.html/identifiant=BOI-TVA-LIQ-20-20140919),
  [CGI art. 269](https://www.legifrance.gouv.fr/codes/article_lc/LEGIARTI000044983827))
- **[Obligation]** Avoir : référence obligatoire numéro + date de la facture d'origine, montant
  HT du rabais + TVA correspondante.
  ([CGI art. 289 I-5](https://www.legifrance.gouv.fr/codes/article_lc/LEGIARTI000048827413/2026-05-08))
- **[Obligation]** Conservation 10 ans (Code de commerce L123-22), authenticité/intégrité/
  lisibilité garanties. Le mandant (livreur) garde sa propre responsabilité malgré la délégation
  matérielle à Locadely. (Pratique quasi nécessaire, pas une obligation directe) Locadely
  archive aussi les factures livreur qu'elle génère + les preuves de mandat/contestation.
- **[Obligation, au 23/09/2026]** Réception facture électronique obligatoire pour tous dès le
  1er septembre 2026 ; émission grandes entreprises/ETI dès le 1er septembre 2026, PME/TPE
  (livreurs et restaurants du pilote, très probablement) au 1er septembre 2027. Formats
  Factur-X/UBL/CII, transmission via Plateforme Agréée (PA) uniquement.
  ([AIFE](https://aife.economie.gouv.fr/nos-applications/facturation-electronique-b2b/),
  [impots.gouv.fr](https://www.impots.gouv.fr/facturation-electronique-et-plateformes-agreees))

### 6.3 Modèle conceptuel VALIDÉ (2026-09-23, remplace la version « facture périodique »)

**Principe** : « 1 livraison finalisée = 1 facture livreur → restaurant + 1 facture Locadely →
restaurant », deux documents juridiquement indépendants, jamais un regroupement hebdomadaire.

- **Facture livreur → restaurant** : émetteur juridique = livreur, une facture par `order_id`,
  ligne unique « Prestation de livraison — Réf. `#public_reference` », montant HT figé =
  `orders.delivery_cents`. Matériellement générée par Locadely au nom et pour le compte du
  livreur (tiers mandaté, §6.2).
- **Facture Locadely → restaurant** : émetteur = Locadely, une facture par `order_id`, ligne
  unique « Frais de service Locadely — Livraison `#public_reference` », montant HT figé =
  `orders.service_fee_cents`. Jamais présentée comme une commission sur le livreur.
- **Déclencheur** : l'événement de domaine déjà construit et déjà publié par le mécanisme outbox
  existant — **`order.completed.v1` uniquement** (`apps/api/src/modules/orders/domain/order-
  events.ts`, inséré dans `order_events` + `outbox_event` en une seule transaction par
  `insertTransitionEvent`, relayé hors HTTP par `platform/outbox-relay.ts`). **Jamais dans le
  handler HTTP de complétion.** ~~`RETURNED` est facturable au même titre que `COMPLETED`~~ —
  **amendé le 2026-09-23, voir §8.1** : `order.returned.v1` n'émet plus aucune facture (un retour
  devient une nouvelle commande distincte, hors scope pour l'instant). `RETURNED` reste réglé
  côté settlement (le livreur est payé, `settlement_lines.final_status in
  ('COMPLETED','RETURNED')`) mais ne produit aujourd'hui aucune facture légale — limite acceptée
  et documentée. `CANCELLED` n'est jamais réglé ni facturé.
- **Atomicité** : les deux factures (livreur + Locadely) d'une même livraison sont créées dans
  **une seule transaction locale** du worker consommant l'événement outbox — aucun appel réseau
  à ce stade (PDF/PA viennent après, hors transaction). Élimine par construction le cas « facture
  livreur réussit, facture Locadely échoue » : soit les deux existent, soit aucune.
- **Idempotence / anti-doublon** : contrainte DB `unique (order_id, issuer_kind)` sur les
  factures d'origine (`issuer_kind ∈ {driver, locadely}`) — garantit qu'une livraison n'est
  jamais facturée deux fois, sans empêcher plusieurs avoirs sur la même facture. Le numéro de
  facture est réservé **dans la même transaction** que sa création, jamais avant.
- **Rattachement** : `order_id` obligatoire dès l'émission (montants lus uniquement depuis
  `orders.delivery_cents`/`service_fee_cents`, jamais `pricing_settings`). `settlement_line_id`
  **nullable à l'émission, rapproché plus tard** — la facture n'attend plus la clôture de
  période (`settlement_periods`/`settlement_statements`/`merchant_settlements`), elle en devient
  indépendante dans le temps ; le rapprochement se fait a posteriori sur `order_id`.
- **TVA par ligne** : `net_cents` (déjà figé), `vat_rate_bps`, `vat_cents` (arrondi déterministe),
  `gross_cents`, régime lu depuis `{driver,merchant}_legal_information.vat_regime` **au moment de
  l'émission** puis snapshoté. Pas de support de l'option TVA sur les débits au MVP (décision
  utilisateur) — TVA sur encaissement standard pour tous.
- **Numérotation** : une séquence par livreur (factures livreur), une séquence Locadely,
  réservation par livraison (plus de sélection de lignes en lot). Toujours propre à chaque
  émetteur (§6.2), jamais partagée entre livreurs. `public_reference` ≠ numéro de facture ≠ UUID
  interne — trois identifiants distincts.
- **Cycle de vie — 4 dimensions orthogonales, jamais un seul champ** : statut économique
  (`eligible → invoiced → credited_partially/fully`, **n'attend plus `included_in_settlement`**
  puisque l'émission ne dépend plus de la clôture) ; statut de paiement (`not_due → due →
  collection_processing → paid/failed/…`, indépendant du document — un débit SEPA échoué après
  émission ne modifie jamais la facture, seulement ce statut) ; statut documentaire (`draft →
  issued → credited_…`, **jamais modifié après `issued`**) ; statut de transmission électronique
  future (`not_applicable → … → accepted/paid_reported`).
- **Avoirs** : un mouvement Stripe (`driver_transfer_reversal`, `driver_reversal_service_refund`)
  **ne crée jamais automatiquement un avoir** (décision utilisateur confirmée) — l'avoir est une
  décision de correction documentée, référençant `invoice_line_id` + `order_id`, avec référence
  optionnelle au mouvement Stripe l'ayant motivé. `driver_transfer_reversals.order_id` existe
  mais est nullable (obligatoire seulement pour les motifs `order_stolen`/`order_lost`/
  `order_damaged`, migration `0038`) ; `driver_reversal_service_refunds.order_id` est NOT NULL
  (migration `0044`) — aucun des deux n'est une clé universelle fiable pour générer un avoir.
  Plusieurs avoirs partiels successifs autorisés, cumul jamais supérieur au montant facturé.
- **Visibilité** : restaurant voit les deux factures + avoirs éventuels d'une livraison ; livreur
  voit **uniquement** ses propres documents (sa facture, son avoir), jamais ceux de Locadely.
- **Snapshot/immutabilité** : niveau facture (identité complète émetteur/client, SIREN/SIRET,
  TVA, adresses, mandat) + niveau ligne (`order_id`, `public_reference`, date, HT/taux/TVA/TTC
  figés). `UPDATE`/`DELETE` interdits après `issued` (trigger, même régime que
  `order_events`/`settlement_lines`).

### 6.4 Prestataires externes (aucun choix définitif)

Super PDP (PA immatriculée 22/12/2025, API-first, gratuit ≤1000 factures/mois) + alternatives de
la liste officielle DGFiP à évaluer sur : gestion multi-émetteurs mandatés (critère central pour
notre cas), SLA, archivage inclus, réversibilité, coût réel. La PA reste une frontière de
transmission — le moteur interne garde la source de vérité (facture, numérotation, snapshots,
avoirs, traçabilité).

### 6.5 Tests ciblés prévus

Facture normale (1/plusieurs livraisons, plusieurs restaurants/livreurs) · TVA (franchise/
assujetti/arrondis déterministes) · numérotation (séquence correcte, concurrence sans doublon,
idempotence) · snapshot (changement d'adresse après émission n'affecte pas l'ancienne facture) ·
avoir (total/partiel/successifs, cumul jamais dépassé) · paiement (facture émise + débit échoué
≠ facture modifiée, pas de double facture au retry) · traçabilité complète
`#public_reference → settlement_line → invoice_line → invoice/credit_note →
debit/transfer/reversal/refund`, dans les deux sens.

### 6.6 Désaccords Claude/Codex (les deux passes)

**Aucun désaccord matériel, sur aucune des deux passes.** 1re passe : convergence sur les unités
`settlement_statement`/`merchant_settlement`, devenue obsolète avec le nouveau modèle. 2e passe
(modèle par livraison) : convergence complète et indépendante — déclencheur outbox
`order.completed.v1`/~~`order.returned.v1`~~ (déclencheur unique depuis §8.1), transaction unique pour les deux factures,
`order_id` comme lien canonique, `settlement_line_id` nullable/rapproché plus tard, et surtout
**la même garde manquante trouvée indépendamment par deux chemins de code différents** (Claude
via `orders/ports/driver-eligibility.ts`, Codex via `assign-order.ts` +
`postgres-driver-payout-readiness.ts` + `dispatch/public.ts`) : rien n'empêche aujourd'hui un
livreur sans identité légale/régime TVA de prendre des courses.

### 6.7 Analyse Claude — résumé (2e passe)

Le modèle par livraison est strictement plus simple que la facture périodique : il élimine
entièrement la contrainte du mois civil (une facture normale s'émet « dès la réalisation »,
sans regroupement), rend l'émission indépendante de la clôture de période, et simplifie
numérotation/idempotence/traçabilité en les ramenant à l'échelle d'une seule commande. Le risque
principal n'est plus juridique mais opérationnel : une garde de facturabilité livreur doit être
créée avant toute émission réelle, elle n'existe pas aujourd'hui.

### 6.8 Analyse Codex — résumé (2e passe)

Confirme avec du code cité précisément (événements de domaine déjà construits, outbox déjà
fonctionnel, colonnes exactes de `driver_transfer_reversals`/`driver_reversal_service_refunds`).
Apport propre : détail des edge cases (course finalisée avant traitement outbox → état
d'affichage « documents en cours de génération » ; numéro réservé dans la même transaction que
la facture ; séparation stricte des droits de consultation restaurant/livreur).

### 6.9 Décisions déjà validées par l'utilisateur (2026-09-23, ne plus rouvrir)

- Locadely génère matériellement les factures du livreur au nom et pour son compte, sous mandat
  (tiers mandaté).
- Pas de support de l'option TVA sur les débits au MVP — TVA sur encaissement standard.
- Un mouvement Stripe seul ne crée jamais automatiquement un avoir.
- Synthèse comptable hebdomadaire pour le restaurant : idée validée fonctionnellement, **hors
  scope**, non conçue, non implémentée à ce stade.
- **Modèle de facturation : une facture par livraison finalisée (livreur + Locadely), pas de
  regroupement périodique.** Résout de facto l'ancienne décision bloquante « mois civil vs
  clôture hebdomadaire » (§6.2, point superseded).

### 6.10 Décisions non-techniques restant à trancher

1. Validation juridique du texte exact du mandat de facturation par tiers (forme, délai de
   contestation, mentions contractuelles).
2. Forme exacte de la nouvelle garde « driver invoice readiness » (identité légale complète +
   régime TVA + mandat accepté) : quels points de contrôle exactement (dispatch ? assignation ?
   les deux ?) et traitement des livreurs déjà actifs sans ces informations au jour de
   l'activation.
3. Libellé commercial exact d'une facture livreur pour une livraison `RETURNED` (même montant
   qu'une `COMPLETED`, formulation à valider).
4. Matrice précise incident Stripe (reversal/refund) → avoir ou non — principe validé (§6.9),
   règles détaillées non écrites.

### 6.11 Plan d'implémentation proposé (ordonné, non commencé)

1. Décisions §6.10 restantes.
2. ADR métier (facture par livraison, deux relations indépendantes, déclencheur outbox,
   séparation document/paiement/Stripe, garde livreur).
3. Schéma détaillé (`invoices`, `invoice_lines`, `credit_notes`, `credit_note_lines`,
   `invoice_number_sequences`, snapshots) sans toucher aux tables settlements/orders existantes ;
   contraintes `unique(order_id, issuer_kind)` sur les factures d'origine.
4. Garde de facturabilité livreur (nouveau port, consommé par dispatch/liste/assignation).
5. Worker consommant `order.completed.v1` (seul déclencheur, §8.1) depuis l'outbox existant,
   création atomique des deux factures en une transaction locale.
6. Modèle TVA par ligne + arrondis, validés comptable.
7. Machine de statuts à 4 dimensions et transitions autorisées.
8. Matrice incident→avoir détaillée (décision humaine documentée, jamais automatique).
9. Conception export/rendu documentaire immuable (cohérent avec le Storage privé de l'Étape 3),
   état « documents en cours de génération » pour la latence outbox.
10. Tests DB concurrence/unicité/immutabilité/traçabilité avant toute UI/PDF.
11. Cas d'usage internes d'émission/avoir, puis interfaces de consultation (droits de
    consultation restaurant vs livreur séparés).
12. Intégration PA derrière une interface dédiée, en tout dernier, sans jamais lui transférer la
    source de vérité. Synthèse comptable hebdomadaire : reste hors scope, à reprendre séparément.

## 7. Super PDP — fournisseur cible (analyse, 2026-09-23)

État : **review**. Analyse Claude (spec OpenAPI officielle récupérée directement) + analyse Codex
indépendante comparées, puis complétées par plusieurs pages narratives officielles transmises par
l'utilisateur (SPA illisibles directement par les outils automatisés) — **la question centrale
(§7.3), initialement un point de divergence Claude/Codex, est désormais confirmée par la
documentation officielle**. Ne remplace ni ne modifie le modèle métier §6 — Super PDP reste une
frontière de transmission, jamais la source de vérité.

### 7.1 Source

Spec OpenAPI officielle récupérée directement (leur documentation web est une SPA illisible par
simple fetch ; l'URL du JSON, `https://api.superpdp.tech/openapi/superpdp.json`, est visible dans
le code source de la page, chargée par le viewer Scalar). **Version observée : `1.34.0.beta`**
(changelog complet jusqu'au 2026-09-22). Codex a observé `v1.30.0.beta` sur l'en-tête HTML de la
même page le même jour — la page affiche probablement un cache obsolète, le JSON brut direct fait
foi. **Cette divergence de version observée le même jour, sur la même page, est en soi un signal
de risque** (§7.7) : exiger un contrat de version figée avant tout engagement.

### 7.2 `company_mandates` — mécanisme confirmé

Endpoint ajouté en **v1.31.0.beta (2026-08-04) — fonctionnalité très récente**, ~7 semaines avant
cette analyse. Schéma `company_mandate` :
```
id, created_at, direction (in|out), grantee_id (lecture seule),
grantor_number, grantor_number_scheme (sandbox|fr_siren|be_numero_entreprise),
grantor_formal_name (lecture seule, dérivé), grantor_identifier (requis seulement si direction=in),
verification_status (verified|not_verified, lecture seule)
```
`GET/POST /v1.beta/company_mandates`, `GET/DELETE /v1.beta/company_mandates/{id}`,
`GET /v1.beta/company_mandates/{id}/download`. Création : requête multipart, objet JSON **+ PDF
obligatoire** (« le mandat réellement signé par le grantor »), **« doit être vérifié par notre
équipe support avant utilisation »** (vérification humaine, aucun SLA public). Pour
`direction=out` (notre cas) : `grantee` = Locadely, `grantor` = livreur, identifié **uniquement
par son SIREN** — aucune référence de compte.

### 7.3 Question centrale — un livreur a-t-il besoin de son propre compte/OAuth Super PDP ?

**Niveau de confiance : CONFIRMÉ (2026-09-23, révisé).** Réponse : **non, le livreur n'a besoin
ni de compte, ni d'OAuth, ni de KYC/KYB individuelle.** Source : page narrative officielle
« Mandat de facturation » (`/documentation`, transmise par l'utilisateur — page SPA illisible
directement par outil automatisé, contenu lu depuis le texte collé), section « Gestion des
mandats », procédure textuelle explicite :

> 1. ajouter dans SUPER PDP **son entreprise, le mandataire** [Locadely]
> 2. cliquer « Nouveau mandat de facturation… »
> 3. **saisir le SIREN du mandant** [le livreur — une simple saisie de texte, pas un compte]
> 4. téléverser le mandat (PDF signé par le mandant)
> 5. écrire au support pour faire vérifier le mandat
>
> Une fois le mandat vérifié, l'entreprise mandataire pourra émettre des factures au nom du
> mandant.

Aucune étape ne mentionne un compte, un OAuth ou une KYC/KYB du mandant. Confirmé aussi par le
**scénario de test bac à sable officiel** (même page) : Burger Queen (mandataire) tente d'envoyer
une facture avec Tricatel (mandant) comme vendeur → erreur « le vendeur n'est pas bon » sans
mandat → création d'un `company_mandate` `direction=out` + passage en `verified` → réémission
réussie. Confirme aussi le **mécanisme de sélection automatique par SIREN du seller** que je
n'avais pu que supposer précédemment (aucun `mandate_id` explicite sur la facture — le
rapprochement se fait par identité du vendeur dans le document contre les mandats vérifiés).

La page distingue aussi explicitement ce cas d'un cas voisin à ne pas confondre (« Erreur
fréquente ») : un simple logiciel de gestion/ERP qui envoie des factures **pour le compte de son
propre utilisateur** (délégation OAuth du compte de CET utilisateur) n'est **pas** un tiers
facturant — ce n'est pas notre cas. Locadely est bien un vrai tiers mandaté au sens mandat, pas
un logiciel délégué.

**Fait nouveau critique pour le modèle (§6.3)** : la même page précise, pour le cas
auto-facture/tiers mandaté — *« Il faut bien penser à mettre le code 389 en BT-3 »* —
**`invoice_type_code` (BT-3) doit valoir `389` (facture auto-facturée / par tiers mandaté) pour
la facture livreur, pas le code commercial standard `380`.** À intégrer dans le modèle de
génération de document (§6.3/§7.9) : la facture Locadely→restaurant (pas sous mandat) garde le
code standard, seule la facture livreur→restaurant (sous mandat) utilise `389`.

### 7.4 API invoice / avoir — faits confirmés dans le schéma

- `POST /v1.beta/invoices` accepte **XML CII, XML UBL, PDF Factur-X, ou multipart — jamais de
  JSON EN16931 direct** (vérifié dans le schéma de requête). Le JSON structuré passe par
  `POST /v1.beta/invoices/convert` (JSON → CII/UBL/Factur-X) — **flux en deux temps nécessaire**.
- `external_id` (36 caractères max) : identifiant libre, **non documenté comme idempotent** —
  l'anti-doublon reste géré côté Locadely (cohérent avec §6.3, déjà prévu ainsi).
- `processing_rule` : `B2B`/`B2BInt`/`B2C`/`B2G`/`B2GInt`/`OutOfScope`/`B2GOutOfScope`/
  `ArchiveOnly`/`NotApplicable` — `B2B` est la valeur pertinente pour la relation restaurant.
- Numéro de facture (`number`, BT-1) : **fourni par Locadely, jamais généré par Super PDP** —
  confirme que la numérotation par émetteur (§6.3) reste entièrement de notre ressort.
- **Pas d'endpoint « credit note » séparé** : un avoir est un `invoice` normal avec
  `invoice_type_code` (BT-3, UNTDID 1001) + `preceding_invoice_reference` (BT-25/BT-26,
  référence + date de la facture d'origine) — se transpose sans friction sur le modèle §6.3.
- `GET /v1.beta/invoices/{id}?format=factur-x` renvoie une version lisible humainement —
  **Locadely peut éviter de générer ses propres PDF**. `GET .../download` existe mais est
  documenté comme déprécié, prévu supprimé en v1 — ne pas s'appuyer dessus.
- `GET /v1.beta/invoice_events` : pagination par id **strictement croissant** (garanti
  atomiquement en base par le fournisseur), `starting_after_id`, booléen `has_after` pour savoir
  s'il faut continuer la synchronisation — page « Synchronisation » officielle confirme
  explicitement ce mécanisme comme LA méthode recommandée pour ne rater aucune facture/événement
  (et déconseille explicitement une synchro par date de création/modification, jugée non fiable).
  15 codes de statut français (`fr:200`-`fr:213`, `fr:220`). **Webhooks confirmés NON DISPONIBLES
  à ce jour** — leur propre page de notes de version les liste sous « En cours de développement »
  (non livré). Le polling par curseur n'est donc pas une simple précaution, c'est **le seul
  mécanisme de synchronisation actuellement disponible**.
- Calcul des totaux par Super PDP ou simple validation : **non confirmé**.
- **E-reporting automatique pour nos factures B2B** : en confiant une facture B2B à Super PDP,
  ils l'acheminent au destinataire (e-invoicing) **et** en envoient automatiquement une copie à
  l'administration fiscale (e-reporting, « Flux 1 ») — rien de plus à faire côté Locadely pour ce
  point, confirmé par leur page « E-reporting ». Les obligations B2C/B2Bi de cette même page ne
  concernent pas notre modèle (restaurants et livreurs sont tous des professionnels).

### 7.5 Tarification — ce qui est confirmé vs non documenté

Confirmé (page tarifs officielle) : Compte gratuit ≤1000 factures/mois ; API 0,01€HT/facture
(≤10k), 0,005€HT (10k-100k), 0,0025€HT au-delà ; **KYC/KYB : 2,00€HT** ; minimum de facturation
10€HT/an. Marque grise possible (Locadely payeur, tarif de gros, marque Super PDP visible à
l'inscription client) ; marque blanche sur devis uniquement.

**Déclencheur exact des 2€HT KYC/KYB : toujours non confirmé formellement, mais nettement plus
probable désormais.** Le changelog officiel date la KYC (identité du représentant légal, via leur
partenaire Datakeen) et la KYB (identité de l'entreprise, via l'INPI pour la France) du
2025-12-21, décrites comme des vérifications liées à la création d'un **compte**. La procédure de
mandat (§7.3) ne mentionne à aucun moment une KYC/KYB du mandant — seulement une saisie de SIREN
et une revue humaine du PDF par le support. **Interprétation renforcée (pas une confirmation
explicite)** : les 2€HT sont vraisemblablement liés à la création d'un compte Super PDP
(représentant + entreprise), et un mandant sans compte propre ne les déclencherait pas. Pas de
calcul de coût pour 1000 livreurs/500 restaurants tant que ce n'est pas confirmé par écrit —
toute estimation resterait une supposition. Question exacte à poser : *Quel événement précis
déclenche les 2€HT KYC/KYB (compte, OAuth, vérification société, vérification représentant,
création de mandat) ? Un grantor sous mandat `out` sans compte individuel est-il concerné ?*

### 7.5bis OAuth — détails confirmés (non requis pour le flux mandat, utile si un jour nécessaire)

Confirmé par leur page « Authentification » officielle (non requis pour notre flux mandataire,
gardé pour référence si un besoin de délégation apparaissait un jour) : `client_credentials` =
accéder à son propre compte (ex. Locadely en bac à sable) ; `authorization_code` = délégation
d'un utilisateur final donnant accès à SON PROPRE compte à un logiciel tiers — pas notre cas.
`access_token` : 30 minutes. `refresh_token` (authorization_code uniquement) : validité glissante
d'1 an, prolongée à chaque usage (rotation obligatoire à chaque utilisation, imposée par OAuth
2.1) — n'expire en pratique qu'en cas de compte abandonné 1 an. Révocation :
`POST /oauth2/revoke` (RFC 7009).

### 7.6 Sandbox — scénario officiel confirmé (remplace le scénario spéculatif précédent)

`env: sandbox`, `generate_test_invoice` (pas de persistance, acheteur sandbox choisi au hasard).
**Scénario de démonstration officiel des mandats** (page « Mandat de facturation », vérifié
fonctionnel par le fournisseur lui-même, deux entreprises fictives créées automatiquement à la
création d'un compte — Burger Queen et Tricatel) :
1. dans les factures de ventes de Tricatel, générer une facture de test ;
2. depuis Burger Queen, tenter de l'envoyer avec Tricatel comme vendeur → erreur attendue
   (« le vendeur n'est pas bon », aucun mandat) ;
3. créer un `company_mandate` `direction=out` autorisant Burger Queen à facturer au nom de
   Tricatel, le passer en `verified` (manuellement, via le compte, pas seulement par API) ;
4. réenvoyer la facture → succès.

Guide « Démarrage rapide » officiel : créer un compte (2 entreprises fictives fournies) → créer
une application OAuth **par entreprise** (Applications → Nouvelle application, noter
`client_id`/`client_secret`, affichés une seule fois) → script d'exemple fourni
(`github.com/superpdp/examples/quick_start.js`, Node.js) qui obtient un token par entreprise,
télécharge une facture de test côté vendeur, l'envoie. Base concrète pour un futur test réel
(non lancé ici).

### 7.7 Risques / dépendances fournisseur

API encore `beta`, versions divergentes selon la page consultée le même jour — exiger une version
contractuellement figée avant engagement. Vérification de mandat manuelle sans SLA public —
latence imprévisible. `external_id` non garanti idempotent. **Webhooks confirmés absents à ce
jour** (« en cours de développement » sur leurs propres notes de version) — le polling par
curseur (`invoice_events`, `starting_after_id`) n'est pas une option prudente mais **le seul
mécanisme réellement disponible aujourd'hui**, à concevoir comme tel dès le départ, pas comme un
repli temporaire. Archivage 10 ans annoncé mais accès post-résiliation/export complet non
documentés. Limites de débit publiques : 30 req/s, 10 connexions simultanées par clé — à
respecter dans le design du futur worker de transmission. **Calendrier officiel Super PDP** (page
« Calendrier ») simplifie la réforme en une seule échéance « Septembre 2027 : obligation pour
toutes les entreprises d'émettre » — sans la distinction grandes entreprises/ETI (Sept. 2026) vs
PME/TPE (Sept. 2027) déjà établie par les sources officielles DGFiP/AIFE (Étape 1/4, §6.2). Ne
pas remplacer ces dernières par le calendrier simplifié du fournisseur — le distinguo par taille
d'entreprise reste la référence retenue pour Locadely et ses restaurants/livreurs.
Fonctionnalités listées comme non livrées en plus des webhooks (leurs propres notes de version,
« en cours de développement ») : raccordement B2G/G2B Chorus Pro (hors scope, B2B uniquement),
logs/messages d'erreur détaillés, délégation d'accès.

### 7.8 Ce qui reste inchangé dans le plan §6 (confirmé, ne pas rediscuter)

Une livraison finalisée = deux factures ; déclencheur outbox `order.completed.v1` (seul
déclencheur, §8.1) ; transaction locale unique ; `order_id`/`public_reference` comme
rattachement canonique ; numérotation, snapshots, TVA, idempotence et avoirs internes à
Locadely ; aucun avoir automatique depuis un mouvement Stripe ; **Super PDP ne devient jamais la
source de vérité métier**.

### 7.9 Ce qui s'ajoute au plan d'implémentation (§6.11), une fois les décisions prises

- Interface conceptuelle `EInvoiceProvider` (`submitInvoice`, `submitCreditNote`,
  `getInvoiceStatus`, `listEvents`, `downloadDocument`) avec adaptateur `SuperPdpEInvoiceProvider`
  — le domaine Locadely ne manipule jamais directement les endpoints Super PDP.
- Table de liaison provider (jamais un remplacement des tables facture) : `superpdp_invoice_id`,
  `external_id` envoyé, `processing_rule`, `superpdp_company_mandate_id` + statut + dates + copie
  du PDF, dernier `invoice_event_id` traité (curseur), historique des tentatives/erreurs, formats
  téléchargés + empreinte.
- Génération JSON interne → conversion CII/UBL/Factur-X via `/invoices/convert` → soumission,
  comme flux en deux étapes (pas de JSON direct accepté sur `/invoices`).
- Contrôle de « readiness PA » avant toute transmission, distinct de la garde de facturabilité
  livreur déjà identifiée (§6.10) — dépend de la réponse à la question centrale (§7.3).
- Traiter les `403`/erreurs de mandat comme des erreurs de transmission réessayables, sans jamais
  annuler ni altérer la facture interne déjà émise et immuable.

### 7.9bis Deux APIs distinctes chez Super PDP (source : page narrative `/documentation/2`,
collée par l'utilisateur — page SPA illisible directement par outil automatisé)

Super PDP expose **deux APIs parallèles**, pas seulement celle analysée en §7.1-7.9 :

- **API SUPER PDP** (propriétaire, JSON) : celle disséquée ci-dessus via le fichier OpenAPI
  (`company_mandates`, `invoices`, etc.) — recommandée par le fournisseur lui-même pour démarrer
  rapidement.
- **API AFNOR / interopérable** (norme XP-Z12-013, « API Flux » + « API Annuaire ») : standard
  bas niveau commun à toutes les Plateformes Agréées qui l'implémentent — permet en théorie de
  changer de PA sans redévelopper. Spécs séparées : `xp-z12-013-flow-1.3.0.json` et
  `xp-z12-013-directory-1.3.0.json` (URLs vues dans le code source de `/openapi/`, non encore
  analysées en détail). Contrainte notable : factures brutes CII/UBL/Factur-X uniquement
  (**pas de JSON**), CDAR (messages de cycle de vie) et e-reporting en XML brut — plus lourd à
  intégrer que l'API propriétaire.
- Les deux APIs partagent les mêmes données (utilisables simultanément). Le fournisseur
  recommande explicitement de démarrer avec l'API propriétaire, une migration/ajout AFNOR restant
  possible plus tard sans perte de travail — **conforte le choix `EInvoiceProvider`** (§7.9) :
  l'interface interne peut être satisfaite par l'une ou l'autre sans changer le modèle Locadely.
- **Limitations documentées de l'API Flux (AFNOR)**, à vérifier avant toute utilisation de cette
  API-là spécifiquement : factures B2B internationales (FRR) non supportées sur
  `GET /flows/{flowId}` à la date de rédaction de leur page, e-reporting correctif/rectificatif
  (codes `MO`/`RE`) non supporté, `processingRule` de `POST /flows` limité à
  `B2B`/`B2C`/`B2BInt` pour les factures. Le texte annonçait leur levée « d'ici l'entrée en
  vigueur de la réforme au 1er septembre 2026 » — **cette échéance est déjà passée au moment de
  cette analyse (23/09/2026)** ; statut réel non vérifié, à confirmer avant toute dépendance à
  l'API AFNOR (non bloquant si l'intégration démarre par l'API propriétaire, comme recommandé).
- **Décision de plan** : si une intégration Super PDP est retenue, démarrer par leur API
  propriétaire (déjà analysée §7.1-7.9), conformément à leur propre recommandation — l'API AFNOR
  reste une option de repli/portabilité future, pas un prérequis.

### 7.10 Questions à poser à Super PDP avant tout engagement

**Question 1 de la version précédente (grantor a-t-il besoin d'un compte/OAuth ?) retirée de
cette liste — désormais confirmée par la documentation officielle, voir §7.3.**

1. Codes d'erreur exacts si mandat absent/non vérifié/SIREN incohérent (le message générique
   « le vendeur n'est pas bon » observé en bac à sable suffit-il en production, ou existe-t-il un
   code d'erreur structuré à traiter automatiquement) ?
2. Délai/SLA de vérification d'un mandat par le support (aucun n'est publié), motif de refus,
   procédure de renouvellement ?
3. Effet d'un `DELETE` sur les factures déjà émises vs futures sous ce mandat ?
4. Déclencheur exact et redevable des 2€HT KYC/KYB en marque grise avec mandats (confirmer
   l'hypothèse §7.5 : compte uniquement, jamais le mandant) ?
5. Tarifs de gros réels, minimums, règles d'agrégation en marque grise ?
6. `external_id` est-il réellement idempotent (à quelle échelle) ?
7. `POST /v1.beta/invoices` accepte-t-il un jour le JSON EN16931 direct (la page « Formats de
   facture » l'annonce comme prévu), ou le passage par `/convert` reste-t-il obligatoire ?
8. Super PDP recalcule-t-il les totaux ou les valide-t-il seulement ?
9. Date de disponibilité prévue des webhooks (confirmés « en cours de développement ») ?
10. Quelle version est contractuellement engageante aujourd'hui, quelle politique de breaking
    changes ?
11. Confirmation explicite du mécanisme de sélection automatique du mandat par SIREN du `seller`
    (déduit du scénario bac à sable §7.6, jamais formulé comme règle générale garantie) : est-ce
    le comportement garanti en production, ou seulement observé en bac à sable ?

## 8. Étape 4 — Implémentation interne (2026-09-23, EN COURS)

État : **schéma SQL fait et vérifié (Claude) ; use cases/API/gardes/mobile pas commencés
(Codex, en cours)**. Aucun appel réseau Super PDP dans cette tranche (interdit explicitement).

### 8.1 Décision amendant §6.3/§6.9 — retour = nouvelle commande, pas de seconde facture

Décision utilisateur du 2026-09-23 (voir ADR `0006-invoice-engine.md` §2) : un retour devient une
**nouvelle commande distincte** (nouvel `order_id`/`public_reference`/tarification/factures), le
chantier créant cette commande de retour restant hors scope. Conséquence directe : le déclencheur
de facturation est **uniquement `order.completed.v1`** — `order.returned.v1` n'émet plus aucune
facture sur la même commande (amende §6.3/§6.9, qui traitaient `RETURNED` comme facturable au même
titre que `COMPLETED`). Limite acceptée et documentée : une commande `RETURNED` reste réglée
(`settlement_lines.final_status = 'RETURNED'`, le livreur est payé) mais ne produit aujourd'hui
aucune facture légale, tant que le chantier « nouvelle commande de retour » n'existe pas.

### 8.2 ADR

`docs/adr/0006-invoice-engine.md` — invariants durables (deux factures indépendantes, déclencheur
unique, facture ≠ paiement, facture émise immuable, montants jamais recalculés, numérotation par
émetteur réel, snapshots légaux figés, TVA déterministe, garde livreur, avoir = décision humaine,
Super PDP jamais source de vérité).

### 8.3 Schéma (migration `0047_invoice_engine.sql`, appliquée à la base de dev le 2026-09-23)

Aucune table `orders`/`settlements` existante modifiée. Nouvelles tables :

- `platform_legal_identity` — identité légale propre de Locadely (singleton `id=true`, même
  patron que `settlement_settings`), toutes colonnes nullable à la création : **doit être
  renseignée manuellement avant toute émission réelle** (aucune valeur bidon insérée).
- `invoice_number_sequences` + fonction `assign_document_number(doc_kind, issuer_kind,
  issuer_driver_id, seller_siren)` : une série par émetteur réel (une par livreur `DRV-<SIREN>-
  ######`, une unique Locadely `LOC-######`), continue, sans réinitialisation annuelle (décision
  MVP, réversible plus tard par nouvelle migration). Allocation atomique par upsert verrouillant
  la ligne de compteur dans la transaction d'émission — testé sous deux allocations successives
  (`DRV-123456789-000001`, `-000002`), comportement sûr sous concurrence par construction
  (verrou de ligne Postgres standard).
- `invoices` — une ligne par facture (livreur ou Locadely), `unique(order_id, issuer_kind)`
  anti-doublon, snapshot vendeur/acheteur figé, `invoice_type_code` verrouillé par émetteur
  (`389` livreur / `380` Locadely, ADR §1/§6), `issue_date`/`service_date` dérivées en colonnes
  générées depuis des `timestamptz` UTC (respecte la règle « tout en UTC », calendrier
  Europe/Paris dérivé). Seules colonnes mutables après émission : `transmission_status`
  (dimension transmission générique, aucun détail fournisseur) et `settlement_line_id`
  (NULL → valeur, une seule fois). Trigger `guard_invoice_immutable` : tout le reste est
  verrouillé, `DELETE` toujours interdit.
- `invoice_lines` — append-only strict (aucun `UPDATE`/`DELETE`, y compris pour corriger une
  erreur — seul un avoir corrige). `line_vat_cents` vérifié par `CHECK` SQL (`floor(line_ht_cents
  × vat_rate_bps / 10000)`, même formule que l'ancien `settlement_lines.fee_cents`). Colonnes
  `vat_exemption_reason_code`/`vat_exemption_reason_text` prévues pour la mention légale
  franchise en base (EN16931 BT-120/BT-121).
- `credit_notes`/`credit_note_lines` — même régime append-only, `original_invoice_line_id`
  obligatoire par ligne, motif + référence de décision obligatoires (`decision_reference`/
  `decision_reason`), numérotation dédiée (`AVD-<SIREN>-######`/`AVL-######`, jamais la série
  des factures). Contrainte critique testée et vérifiée : le cumul des avoirs d'une même ligne
  d'origine ne peut jamais dépasser son `line_ht_cents` (trigger `guard_credit_note_line_within_
  original`, vérifié immédiatement à l'insertion, pas en différé).
- Deux déclencheurs différés par document (facture et avoir) vérifient que les totaux de l'en-tête
  correspondent à la somme des lignes : un déclenché par changement sur les lignes, un second
  déclenché par l'insertion de l'en-tête lui-même — **bug trouvé et corrigé pendant les tests de
  cette tranche** : sans le second déclencheur, une facture/avoir inséré sans aucune ligne (bug
  applicatif, ex. transaction oubliant l'`INSERT` des lignes) ne serait jamais détecté, faute de
  changement sur la table des lignes pour déclencher le premier contrôle. Reproduit et vérifié
  corrigé (base jetable).
- `invoice_provider_submissions` — table de liaison future avec un fournisseur de transmission
  (jamais de colonnes `superpdp_*` sur `invoices`/`credit_notes`, ADR §11), vide et inutilisée
  tant que l'adaptateur réseau n'existe pas.

### 8.4 Tests SQL effectués (base jetable `invoices_r47`, `docs/work/r47-testdb.sh`, D-R respecté)

Fresh install (toutes les migrations dans l'ordre + seed) et upgrade path (migrations jusqu'à
`0046` + données préexistantes — commande `COMPLETED` avec montants figés, infos légales
livreur/restaurant — puis `0047`, données intactes) : les deux passent. Scénario fonctionnel
complet exécuté et vérifié : deux factures pour une commande (livreur franchise en base TVA=0,
Locadely TVA 20%), doublon `(order_id, issuer_kind)` rejeté, `UPDATE`/`DELETE` du contenu légal
rejetés, `transmission_status` modifiable, `settlement_line_id` rattachable une seule fois, avoir
partiel accepté puis second avoir dépassant le cumul rejeté, lignes d'avoir append-only vérifiées.

### 8.5 Livré (Codex : backend TS + mobile, relu et corrigé par Claude ; Claude : web commerçant)

État final : **Étape 4 interne TERMINÉE (2026-09-23)**. Aucun appel réseau Super PDP nulle part
dans le code livré — `invoice_provider_submissions` reste vide.

**Backend (Codex, module `modules/invoices/` + garde dans `modules/orders/`)** :
- `IssueOrderInvoicesUseCase`/`PostgresInvoiceRepository.issueForCompletedOrder(orderId)` :
  une transaction locale (`SELECT ... FOR UPDATE` sur la commande, snapshots légaux lus,
  numérotation via `assign_document_number`, deux `INSERT invoices` + `INSERT invoice_lines`).
  Un conflit `23505` (`unique(order_id, issuer_kind)`) est un no-op réussi (`'already_issued'`) —
  replay sûr. Une commande legacy (`delivery_cents`/`service_fee_cents` `NULL`) ou non
  `COMPLETED` est un no-op silencieux + log (`'legacy_or_not_completed'`). Une identité légale
  incomplète (vendeur livreur, acheteur restaurant, ou Locadely lui-même) lève
  `InvoiceIssuanceDeferredError` — la transaction est annulée (zéro facture partielle), l'event
  outbox reste non publié et **retente indéfiniment** via le mécanisme générique existant
  (`platform/outbox-relay.ts`, pas de plafond de tentatives sur ce chemin — acceptable pour
  cette tranche, à surveiller si des livreurs restent durablement incomplets).
- Câblage : `app.ts` branche `order.completed.v1` sur `invoices.issueForCompletedOrder` **avant**
  le `socketEmitter` générique (`order.completed.v1` n'a aujourd'hui aucun handler socket — pas
  de couplage réel observé, mais à surveiller si un futur handler socket y est ajouté : un échec
  d'émission de facture retarderait alors aussi cet effet, puisque les deux passent par le même
  callback `emit` de l'outbox).
- `CreateCreditNoteUseCase`/`repository.createCreditNote` : cas d'usage interne uniquement
  (aucune route HTTP publique dans cette tranche), valide `decisionReference`/`decisionReason`
  non vides et un montant entier positif, délègue le plafond cumulatif au trigger SQL (jamais
  recalculé côté TS).
- Garde « driver invoice readiness » : nouveau port `DriverInvoiceReadiness`
  (`ports/driver-invoice-readiness.ts`) + `PostgresDriverInvoiceReadinessReader` — vérifie
  `drivers.first_name`/`last_name` non vides, `driver_legal_information` présent, `vat_regime`
  renseigné, `vat_number` si `assujetti`. Câblée EN PLUS de `DriverEligibility` (D-F) aux deux
  points déjà gardés : `ListAvailableOrdersUseCase` (aucune course visible si non prêt) et
  `AssignOrderUseCase` (`DriverInvoiceInformationNotReadyError`, 403, même style que
  `DriverPayoutAccountNotReady`).
- `GET /api/v1/orders/:id/documents` : restaurant (rôle `merchant`) voit ses deux factures +
  avoirs pour sa commande ; livreur (rôle `driver`) voit uniquement sa propre facture et ses
  propres avoirs, jamais la facture Locadely ni celle d'un autre livreur — isolation vérifiée par
  requête SQL scoping (`orders.merchant_id`/`orders.driver_id`), jamais côté application.
  **Corrigé par Claude après relecture** : la route appelait initialement le repository
  directement (violation de la règle « les routes appellent des use cases, rien d'autre ») —
  ajout de `GetOrderDocumentsUseCase`, la route ne connaît plus que ce cas d'usage.
- Mobile (`app/order/[id]/index.tsx`) : pour une commande `COMPLETED`, affiche numéro de
  facture + statut de transmission + avoirs éventuels du livreur — jamais le montant ni
  l'existence de la facture Locadely (type TS `DriverOrderDocuments` contraint déjà
  `issuerKind: 'driver'`, cohérent avec la réponse serveur scopée).

**Web commerçant (Claude, `components/order-modal.tsx` + nouveau `lib/invoices.ts`)** : section
« Documents » (commande `COMPLETED` uniquement), affiche les deux factures avec libellé clair
(« Facture livraison » / « Facture frais de service Locadely »), montant HT et statut de
transmission traduit sans jargon, plus les avoirs éventuels. Pas de bouton téléchargement (le
document Factur-X/PDF réel n'existe pas avant l'intégration Super PDP, cohérent avec la
consigne de ne jamais prétendre transmettre ce qui ne l'est pas encore).

**Corrections apportées par Claude après relecture du travail Codex (trust but verify)** :
1. **Bug de type réel** : `invoices.total_ht_cents`/`total_vat_cents`/`total_ttc_cents` et les
   colonnes miroir de `invoice_lines`/`credit_notes`/`credit_note_lines` étaient déclarées
   `bigint` dans la migration — `node-postgres` renvoie un `bigint` Postgres comme **chaîne de
   caractères** en JavaScript, jamais un `number`, malgré le typage TypeScript `number` du
   repository (aucune perte silencieuse, mais un vrai bug détecté par le test d'intégration :
   `toMatchObject({ totalHtCents: 1000 })` échouait contre `"1000"`). Corrigé en `integer`
   (comme `orders.delivery_cents`/`service_fee_cents`, jamais aucune facture n'approchera la
   limite de 2,1 Md centimes) — migration corrigée avant toute donnée réelle, base de dev
   resynchronisée.
2. **Trou de schéma trouvé PAR CODEX, corrigé par Claude** : rien n'empêchait
   `credit_note_lines.original_invoice_line_id` de référencer une ligne appartenant à une AUTRE
   facture que `credit_notes.original_invoice_id`. Ajout d'une vérification dans le trigger
   `guard_credit_note_line_within_original` (déjà vérifié à l'insertion) — testé (une ligne
   croisée est désormais rejetée).
3. **Régression de test existant** : `test/http/orders.http.test.ts` construisait `buildApp()`
   avec un override `driverEligibility` permissif mais pas le nouvel override
   `driverInvoiceReadiness` — deux tests échouaient car le livreur de seed n'a pas d'identité
   légale de facturation en base (comportement CORRECT de la nouvelle garde, test non mis à
   jour). Corrigé (override permissif ajouté, même discipline D-D que l'existant).
4. Nettoyage : la vérification manuelle m'a fait repérer 21 commandes de test accumulées dans
   la base de dev partagée (`merchant_id = 22222222…`, laissées par des exécutions antérieures de
   la suite HTTP) — supprimées (mémoire `cleanup-simulation-orders.md`).

**Tests** : 8 nouveaux tests d'intégration (`test/invoices/issue-order-invoices.integration.test.ts`,
base isolée `invoices_r47`, `docs/work/r47-testdb.sh`, même discipline D-R que les tests de
règlement — les tables du moteur de facturation sont append-only, un scénario de test ne peut
donc tourner que sur une base jetable) : émission (2 factures, montants/TVA/numéros exacts),
idempotence du replay, commande legacy ignorée, identité livreur incomplète différée sans
facture partielle, identité Locadely incomplète différée, isolation restaurant/livreur, avoir
partiel + rejet du dépassement cumulé, garde de facturabilité livreur (profil complet/incomplet).
Plus 1 test unitaire Codex (`create-credit-note.test.ts`, validation pure). `npm run typecheck`/
`lint` API + mobile + web : verts. Suite complète API (`npm run test -w apps/api`) : 981/986 verts
— 3 échecs `test/realtime/outbox-worker.test.ts` confirmés comme pollution par le serveur de dev
déjà en cours d'exécution sur la même base (relais outbox concurrent, passent isolément), 1 échec
préexistant et sans rapport dans `cash-on-delivery` (module non touché par cette tranche, non
investigué plus avant — hors périmètre).

### 8.6 Compatibilité vérifiée avec l'OpenAPI Super PDP (`en_invoice`, v1.34.0.beta, §7.1)

Vérification champ par champ de notre modèle interne contre le schéma réel (pas contre la
documentation narrative) — objectif : confirmer qu'aucune donnée nécessaire à une future
transmission ne manque à notre modèle interne, sans construire l'adaptateur maintenant.

| Donnée interne Locadely | Champ Super PDP (EN16931) | OK ? |
| --- | --- | --- |
| `invoices.number` | `en_invoice.number` (BT-1) | OK — nous le fournissons toujours, Super PDP ne le génère jamais |
| `invoices.invoice_type_code` (`'380'`/`'389'`) | `en_invoice.type_code` (BT-3, entier) | OK, conversion texte→entier nécessaire à la construction du payload |
| `invoices.issue_date` | `en_invoice.issue_date` (BT-2) | OK |
| `invoices.service_date` | `en_invoice.delivery_information.delivery_date` (BT-72) | OK |
| `seller_siren`/`seller_siret` | `seller.identifiers`/`legal_registration_identifier` (BT-29/BT-30) | OK, à structurer en objet identifiant avec un schéma (SIREN/SIRET), pas une chaîne nue |
| `buyer_siren`/`buyer_siret` | `buyer.identifiers`/`legal_registration_identifier` (BT-46) | OK, même remarque |
| `seller_vat_number` | `seller.vat_identifier` (BT-31) | OK, nullable des deux côtés |
| `buyer_vat_number` | `buyer.vat_identifier` (BT-48) | OK, nullable des deux côtés |
| adresses vendeur/acheteur | `seller.postal_address`/`buyer.postal_address` (BT-35-40/BT-50-55) | OK, correspondance champ à champ (`line1`/`line2`/`city`/`post_code`/`country_code`) |
| `invoice_lines.description` | `invoice_line.item_information.name`/`description` (BT-153/BT-154) | OK, décision à prendre au moment de l'adaptateur (name court vs description) — non bloquant |
| `invoice_lines.quantity` | `invoice_line.invoiced_quantity` (BT-129) | OK |
| `invoice_lines.unit_price_ht_cents` | `invoice_line.price_details.item_net_price` (BT-146, `decimal`) | OK, conversion centimes entiers → chaîne décimale requise |
| `invoice_lines.vat_rate_bps` | `en_invoice.vat_break_down[].vat_category_rate` (BT-119, pourcentage) | OK, conversion bps → pourcentage ; le point de bascule (par ligne chez nous, par ventilation TVA chez Super PDP) est sans friction ici car chaque facture n'a qu'une seule ligne/un seul taux |
| `vat_exemption_reason_text`/`code` | `vat_break_down.vat_exemption_reason`/`_code` (BT-120/BT-121) | OK, même remarque de niveau (ventilation, pas ligne) |
| `total_ht_cents`/`total_vat_cents`/`total_ttc_cents` | `en_invoice.totals.total_without_vat`/`total_vat_amount`/`total_with_vat` (BT-109/-110/-112) | OK, conversion décimale requise |
| conditions de paiement | *(aucun champ interne)* | **MANQUANT** — `en_invoice.payment_terms` (BT-20) n'a pas d'équivalent dans notre modèle ; champ optionnel EN16931, nos modalités réelles (SEPA/mandat) sont opérationnelles hors document — non bloquant, à trancher si un jour jugé utile |
| référence facture précédente (avoir) | `en_invoice.preceding_invoice_references[]` (BT-25/BT-26) | OK — `credit_notes.original_invoice_id` porte l'information, la résolution number+date se fait par jointure au moment de la conversion, pas une donnée manquante |
| `orders.public_reference` | *(aucun champ dédié EN16931)* | OK par construction — déjà intégrée textuellement dans `invoice_lines.description` (« Réf. #12345678 »), c'est un identifiant métier Locadely, pas une donnée légale que Super PDP a besoin de recevoir structurée |

**Conclusion corrigée le 2026-09-23 (Étape 5, §9) : cette ligne était fausse.** Le tableau
ci-dessus vérifiait la PRÉSENCE des champs mappables mais pas le tableau `required` réel des
schémas `seller`/`en_invoice` — `seller.electronic_address` (BT-34/BT-49, `{value, scheme}`) est
en réalité **obligatoire** et n'existe nulle part dans notre modèle (ni `platform_legal_identity`,
ni les snapshots `invoices.seller_*`). Trouvé indépendamment par Codex lors de l'analyse Étape 5,
vérifié par Claude directement contre le schéma (`seller.required = ['name', 'electronic_address',
'postal_address']`). Voir §9.U pour le détail et la correction. Le reste du tableau reste correct.
Toutes les conversions identifiées (texte→entier, centimes→décimal, bps→pourcentage,
identifiants structurés) restent des détails d'implémentation du futur `SuperPdpEInvoiceProvider`
(§7.9), jamais un changement du modèle interne §6.3/§8.

### 8.7 Reste pour la tranche suivante (connexion réelle Super PDP)

- Décisions §6.10 encore ouvertes (texte juridique du mandat, cas `RETURNED` définitivement acté
  ici — voir §8.1 — libellé avoir `RETURNED` devenu sans objet, matrice incident→avoir détaillée).
- `platform_legal_identity` à renseigner manuellement (actuellement toutes colonnes `NULL` en
  base de dev — aucune facture Locadely ne peut être émise tant que ce n'est pas fait,
  volontairement, comme conçu).
- Rattachement `settlement_line_id` (nullable, jamais fait dans cette tranche — à ajouter par un
  petit job de réconciliation séparé si jugé utile, non bloquant).
- Vraie ouverture d'un compte Super PDP sandbox, test du scénario mandat réel (jamais fait,
  §7.6), `EInvoiceProvider`/`SuperPdpEInvoiceProvider` (§7.9), conversion JSON interne → CII/
  UBL/Factur-X → `/invoices` (flux en deux temps), garde « readiness PA » distincte de la garde
  livreur déjà construite, polling `invoice_events` (pas de webhook disponible), 11 questions
  fournisseur (§7.10) à poser avant tout engagement contractuel.

## 9. Étape 5 — Intégration SUPER PDP (analyse + plan, 2026-09-23)

État : **analyse uniquement, aucun code, aucune migration, aucun appel réseau réel**. Méthode :
Claude fait sa propre analyse complète en inspectant le code réel et la spec OpenAPI re-téléchargée
le jour même ; Codex reçoit le même contexte métier (pas les conclusions de Claude) et produit sa
propre analyse indépendante ; Claude compare et arbitre à partir du code réel et de la spec.
**Convergence quasi totale, une correction matérielle trouvée par Codex et vérifiée par Claude
directement contre le schéma** (§9.C/§9.U).

### 9.A État du code actuel (vérifié, pas supposé)

Les deux analyses confirment indépendamment, en lisant le code réel (pas seulement §8) : le
moteur interne est bien livré et câblé (`order.completed.v1` → `invoices.issueForCompletedOrder()`
dans `apps/api/src/app.ts`, transaction locale, deux factures), `invoice_provider_submissions`
existe, vide, jamais appelée. La garde `DriverInvoiceReadiness` (câblée dans
`ListAvailableOrdersUseCase`/`AssignOrderUseCase`) ne concerne que la capacité de facturation
interne — aucun lien avec Super PDP, confirmé par les deux lectures indépendantes du code.

**Documentation corrigée à cette occasion** (dérive trouvée par Codex, vérifiée par Claude) :
§6.3/§6.7/§6.11/§7.8 mentionnaient encore `order.returned.v1` comme codéclencheur alors que §8.1
l'a supprimé le jour même — corrigé en place (amendements inline), le code lui-même était déjà
correct (seul le `.md` avait dérivé).

### 9.B OpenAPI / version utilisée

Re-téléchargée aujourd'hui (`https://api.superpdp.tech/openapi/superpdp.json`) : **`1.34.0.beta`,
inchangée depuis §7.1**. Comparaison programmatique complète des deux copies : mêmes clés
`paths`/`schemas`, `company_mandate` et `/v1.beta/invoices` byte-identiques, changelog identique.
Seule différence sur l'ensemble du document : le path `/v1.beta/b2c_transactions` (hors
périmètre B2C). Le risque de version instable noté en §7.7/§7.1 (1.30 vs 1.34 vu le même jour)
reste théorique, non reproduit une deuxième fois.

### 9.C Données manquantes avant transmission (corrigé — voir §9.U pour l’arbitrage)

Le tableau détaillé est en §9.6-§9.8 (mapping champ par champ). Résumé des manques réels,
convergents entre les deux analyses :
1. **`seller.electronic_address`** (BT-34/BT-49, `{value, scheme}`) — **réellement obligatoire**
   dans le schéma (`seller.required` le liste), absent de `platform_legal_identity` et des
   snapshots `invoices.seller_*`. Corrige §8.6 (voir §9.U).
2. **Conditions de paiement** (BT-20, BT-9, BT-81 à BT-91) — absentes du modèle, confirmé par les
   deux analyses (voir 9.I).
3. `process_control.specification_identifier` (BT-24, obligatoire) — **pas un vrai manque de
   données** : la description du schéma donne la valeur constante attendue
   (`urn:cen.eu:en16931:2017` pour une facture conforme EN16931) — une constante à coder dans le
   futur adaptateur, jamais une donnée à collecter ou à stocker en base.
4. Schémas d'identifiants (quel `scheme` pour le SIREN dans `seller.identifiers[]`) — probable
   (Peppol France `0225` + SIREN, cohérent avec §7 « annuaire », mais **non confirmé par le schéma
   JSON lui-même** — à vérifier en sandbox avant de coder en dur).
5. `buyer.electronic_address` — **optionnel dans le schéma** (`buyer.required` ne le liste pas),
   mais nécessaire EN PRATIQUE pour le routage annuaire — pas un champ facture à ajouter, plutôt
   une donnée de transmission à résoudre via `GET /v1.beta/french_directory/entries` (§9.O) et à
   stocker côté soumission, pas côté facture.

### 9.D Mandats — modèle de données consolidé

Convergence complète sur le principe (table dédiée, jamais `drivers`, jamais fusionnée avec
`invoice_provider_submissions`). Divergence mineure de détail, arbitrée en faveur de la proposition
Codex — plus complète et pensée pour l'historique/audit :

**Table métier `driver_einvoice_mandates`** (append-only par version, jamais un `UPDATE` du texte
accepté) : `id`, `driver_id`, `grantor_siren`/`grantor_legal_name_snapshot`,
`grantee_siren_snapshot`/`grantee_legal_name_snapshot` (Locadely, snapshotés pour audit même si
`platform_legal_identity` change plus tard), `direction` (toujours `out`), `mandate_template_
version`, `mandate_text_hash`, `accepted_at`, `acceptance_method`, `acceptance_evidence_json`
(IP/user-agent/horodatage — preuve technique, PAS une validation juridique, voir 9.E),
`accepted_by_driver_id`, `signed_pdf_storage_path`/`signed_pdf_sha256`/`signed_pdf_created_at`
(même bucket privé que Étape 3), `status` local (`draft | accepted | submitted_to_provider |
not_verified | verified | rejected | revoked | expired`), `valid_from`/`valid_until`/`revoked_at`/
`revocation_reason`.

**Table technique séparée `driver_einvoice_mandate_provider_records`** (liaison fournisseur,
même philosophie que `invoice_provider_submissions` pour les factures — jamais de colonnes
`superpdp_*` sur la table métier) : `mandate_id`, `provider`, `provider_mandate_id` (texte même si
Super PDP le renvoie en entier), `provider_verification_status`, `submitted_at`/`verified_at`/
`last_checked_at`, `last_error`, unicité `(provider, mandate_id)`.

### 9.E Workflow app livreur — technique vs juridique (les deux analyses convergent)

Techniquement trivial (les deux analyses sont d'accord) : texte versionné → case à cocher →
horodatage → génération PDF (texte + identité snapshotée + preuve d'acceptation) → stockage privé
→ soumission backend (jamais le mobile directement) → polling du statut → affichage
`not_verified`/`verified` sans jamais exposer de secret fournisseur au livreur.

**Explicitement NON tranché ici, à soumettre à un juriste avant tout code** (les deux analyses
insistent sur ce point séparément — convergence forte) : une case à cocher horodatée suffit-elle
comme preuve d'acceptation d'un mandat de facturation par tiers (art. 242 nonies CGI), ou une
signature électronique qualifiée/avancée (eIDAS) est-elle requise ? Force probante exacte, texte/
version/durée/révocation/préavis du mandat, droit applicable, et — question opérationnelle
distincte — **une commande peut-elle être facturée avant que le mandat ne soit `verified`** (la
facture interne existe déjà à ce moment, seule sa transmission serait bloquée, cf. 9.K) ? Ces
questions vont dans §9.W, jamais répondues par une hypothèse technique.

### 9.F Mapping facture Locadely → `en_invoice`

| EN16931 | Source Locadely | État |
|---|---|---|
| BT-1 `number` | `invoices.number` (`LOC-######`) | OK |
| BT-2 `issue_date` | `invoices.issue_date` | OK |
| BT-3 `type_code` | `invoices.invoice_type_code` ('380') | OK, conversion texte→entier |
| Devise | `invoices.currency_code` | OK |
| BT-24 `process_control.specification_identifier` | — | Constante fixe, pas une donnée à stocker (voir 9.C.3) |
| BT-27/30/31/35-40 seller (hors électronique) | `platform_legal_identity.*` | OK une fois renseignée |
| **BT-34 seller electronic_address** | — | **Manquant, à ajouter** (9.C.1) |
| BT-44/46/48/50-55 buyer | `invoices.buyer_*` | OK |
| BT-49 buyer electronic_address | — | Résolution annuaire à la transmission, pas un champ facture (9.C.5) |
| BT-72 delivery date | `invoices.service_date` | OK |
| BT-126/129/146/153-154 ligne | `invoice_lines.*` | OK, conversions centimes→décimal, unité à normaliser |
| BT-116/117/119/120/121 TVA | `invoice_lines.vat_rate_bps`/exemption | OK, code catégorie TVA (S/E/…) à choisir au mapping |
| BT-106/109/110/112 totaux | `invoices.total_*` | OK, conversion décimale |
| BT-115 amount due | — | Dérivable du TTC tant qu'aucun paiement anticipé n'existe (jamais le cas ici) |
| BT-20/BT-9/BT-81-91 paiement | — | **Manquant, voir 9.I** |

### 9.G Mapping facture livreur sous mandat

Identique à 9.F pour la structure, différences : BT-1 = `DRV-<SIREN>-######` ; BT-3 = `389`
(verrouillé par CHECK SQL migration 0047, vérifié dans le code par les deux analyses) ; vendeur =
snapshot `driver_legal_information` déjà figé sur `invoices.seller_*` ; **aucun champ `mandate_id`
dans le document lui-même** — le rapprochement se fait par SIREN du vendeur contre un
`company_mandate` `verified` côté Super PDP (confirmé §7.3, non contredit par la lecture de spec
d'aujourd'hui) ; le lien vers `driver_einvoice_mandates` reste un artefact d'audit local, jamais
transmis dans le document.

### 9.H Mapping d'un avoir

`credit_notes`/`credit_note_lines` → même famille d'objet `invoice` chez Super PDP (confirmé à
nouveau), `preceding_invoice_references[].reference`/`.issue_date` = numéro/date de la facture
d'origine via jointure `credit_notes.original_invoice_id` → `invoices`. **Point non tranché,
convergent entre les deux analyses** : le code `invoice_type_code` exact d'un avoir (souvent `381`
en pratique UNTDID, mais **ni confirmé par un enum explicite dans le schéma consulté, ni vérifié
ici**) et la représentation du montant (positif avec code distinctif, vs négatif) — à vérifier
précisément en sandbox avant tout code, pas une hypothèse à faire maintenant. Les snapshots
vendeur/acheteur d'un avoir viennent toujours de la facture d'origine par jointure (nos
`credit_notes` ne les dupliquent pas, décision déjà actée en §8.3).

### 9.I Conditions de paiement — le vrai trou de données

Confirmé par les deux analyses, indépendamment : BT-20 (`payment_terms`), BT-9 (`payment_due_
date`), BT-81 (`payment_means_type_code`), BT-89/90/91 (référence mandat SEPA, identifiant
créancier, compte débité) n'existent nulle part dans le moteur interne actuel. Tension réelle
identifiée par Claude (pas résolue) : la facture s'émet à `order.completed.v1`, **avant** que la
période de règlement ne soit close et qu'une date de prélèvement précise soit connue
(`settlement_line_id` n'est même pas encore rattaché à ce stade) — une vraie `payment_due_date`
précise n'est donc pas calculable au moment de l'émission sans fragiliser l'invariant « facture ≠
paiement » (ADR 0006 §3). Recommandation commune : un texte BT-20 générique (« Paiement par
prélèvement SEPA automatique, dans le cadre du règlement périodique du restaurant ») plutôt qu'une
échéance précise. Pénalités de retard, indemnité forfaitaire 40€, mention « TVA sur les
encaissements » : mentions à rédiger, **jamais sans validation comptable/juridique** (§9.W) — ni
Claude ni Codex n'a rédigé de texte ici. Ne jamais présenter le Stripe Creditor ID comme un
identifiant Locadely (déjà une règle dure du projet, CLAUDE.md).

### 9.J Conversion (`/invoices/convert`)

Confirmé aujourd'hui dans la spec : accepte `application/json`, `application/xml`,
`multipart/form-data` (JSON+PDF pour obtenir un Factur-X avec mise en page). Flux à deux temps
toujours nécessaire (JSON interne → `/convert` → `POST /invoices`, jamais de JSON direct accepté
par `/invoices`). Format de sortie retenu par les deux analyses indépendamment : **Factur-X**
(sert à la fois de document de transmission et de PDF lisible humainement pour restaurant/livreur,
évite de construire un rendu PDF maison) ; conserver aussi le JSON source canonique pour audit.
CII/UBL restent une option si un destinataire ou une exigence d'interopérabilité l'impose un jour
— rien dans la spec ne dit qu'un choix serait universellement supérieur.

### 9.K Soumission (`POST /invoices`)

Confirmé : XML CII/UBL, PDF Factur-X, ou multipart — jamais JSON direct. Params `external_id`,
`disable_pre_check`, `processing_rule` (`B2B` pertinent ici). **Soumission asynchrone** : un 200
retourne l'objet `invoice` complet (avec son id Super PDP entier) mais signifie seulement « accepté
dans la file d'attente », jamais « livré » — le vrai statut ne vient que du polling `invoice_events`
(voir 9.M). **Recommandation nouvelle de cette analyse (trouvée par Claude, pas dans §7)** : appeler
`POST /validation_reports` (confirmé existant dans la spec, accepte un multipart, renvoie un
`validation_report`) AVANT `POST /invoices`, pour détecter les erreurs de structure sans consommer
une vraie tentative de soumission.

**Garde `DriverEInvoiceReadiness` (nouvelle, distincte de `DriverInvoiceReadiness`)** — convergence
totale entre les deux analyses et la préférence déjà exprimée par l'utilisateur, aucune n'a
challengé le principe : elle ne doit bloquer NI la réception d'une course, NI l'acceptation, NI
l'émission interne — seulement la TRANSMISSION externe d'une facture livreur, si le mandat est
absent, `not_verified`, révoqué ou expiré. Une facture interne peut donc exister en attente de
transmission alors que le mandat n'est pas encore `verified` — l'inverse casserait le revenu du
livreur pour une raison hors de son contrôle (délai de vérification manuelle sans SLA côté Super
PDP, §7.7).

### 9.L Idempotence / retries — risque confirmé, pas résolu par la spec

**Convergence forte, trouvée indépendamment par les deux analyses** : `GET /v1.beta/invoices`
(liste) n'a AUCUN paramètre de filtre par `external_id` (seulement `direction`/`date`/`order`/
`starting_after_id`/`ending_before_id`/`limit`/`expand[]`, vérifié aujourd'hui dans la spec). Après
un timeout ambigu sur `POST /invoices` (on ne sait pas si Super PDP a reçu le document), **il
n'existe aucun mécanisme confirmé par la spec pour retrouver la facture par notre propre
identifiant**. Ne jamais renvoyer automatiquement dans ce cas (conforme à la consigne). Modèle
d'état retenu pour `invoice_provider_submissions` (proposition Codex, plus complète que la
proposition initiale de Claude, adoptée) : `prepared → submitting → submitted → accepted/rejected`,
plus `retryable` (échec certain avant réception fournisseur), `failed` (erreur définitive), et
surtout **`unknown_outcome`** (timeout/coupure après envoi — état qui bloque tout nouveau `POST`
automatique tant qu'il n'est pas résolu, manuellement au départ, ou par une recherche
`GET /invoices?date=…&direction=out` suivie d'une comparaison de contenu). Extension de schéma
requise sur `invoice_provider_submissions.submission_status` (aujourd'hui 4 valeurs, à étendre) —
conceptuel seulement, pas de migration écrite ici.

### 9.M Polling `invoice_events`

Confirmé : `GET /v1.beta/invoice_events` (`invoice_id`, `starting_after_id`, `limit`), tri
strictement croissant. **Fait nouveau confirmé aujourd'hui, absent de §7** : la doc du schéma
`status_code` précise explicitement que ce n'est **pas une machine à états** — les statuts sont des
événements cumulatifs (plusieurs peuvent coexister dans l'historique, aucune transition garantie).
Conséquence directe pour la projection interne : jamais calculer le statut comme « dernier
événement reçu », toujours comme une fonction de l'ENSEMBLE des événements connus (ex. un
`fr:213`/`api:rejected` n'importe où dans l'historique = rejeté, même si un événement différent
arrive après). Table de projection consolidée (arbitrée à partir de la proposition Codex, plus
complète, avec la liste officielle des 15 statuts confirmée aujourd'hui) :

| Événements Super PDP | Projection interne |
|---|---|
| aucun / `prepared` local | `not_started` |
| `api:uploaded`, `fr:200` | `provider_received` |
| `api:validated` | `validated` |
| `api:sent`, `fr:201` | `sent` |
| `fr:202`, `fr:203` | `delivered_or_available` |
| `api:accepted`, `fr:205`, `fr:209` | `accepted_or_completed` |
| `fr:206`, `fr:207`, `fr:208` | `exception_open` |
| `api:invalid`, `fr:501` | `invalid` |
| `api:rejected`, `fr:210`, `fr:213` | `rejected_or_refused` |
| `fr:211`, `fr:212` | `payment_event_observed` (ne modifie jamais le statut de paiement interne, déjà dérivé de `settlements`) |

Incohérence notée (mineure, à surveiller) : le changelog `1.33.0.beta` annonce le support de
`fr:220`, absent de la liste énumérée dans la description du schéma `status_code` lue aujourd'hui —
stocker les codes bruts en texte, traiter tout code inconnu comme tel plutôt que de planter.
Fréquence de polling raisonnable : 5-15 minutes (rate limits 30 req/s, 10 connexions/clé — notre
volume Bourg-en-Bresse en est très loin, pas besoin de plus agressif pour un document sans urgence
temps réel).

### 9.N Factur-X / téléchargement

`GET /invoices/{id}?format=factur-x` confirmé (`GET .../download` déprécié, ne pas s'appuyer
dessus). Ne pas mettre en cache une copie permanente tant qu'un statut non terminal — télécharger à
la demande avec un cache court, stocker une copie définitive (`document_storage_path`, déjà
prévue) seulement une fois un statut terminal atteint (accepté/refusé). Panne fournisseur : les
métadonnées de la facture interne (numéro, montants, statut documentaire) restent toujours
affichables (aucune dépendance réseau aujourd'hui) — seul le téléchargement du fichier échoue
proprement.

### 9.O Readiness restaurant (annuaire)

**Confirmé aujourd'hui, endpoint réel identifié — répond à la question 11 laissée ouverte en
§7.10** : `GET /v1.beta/french_directory/entries?number=<SIREN>` (liste les adresses d'annuaire
utilisables pour cette entreprise, champs `identifier`/`is_active`/`is_replyto`) et
`GET /v1.beta/french_directory/companies` (recherche). Absent de l'annuaire = liste vide, jamais
une erreur — traité comme « pas encore adressable », jamais bloquant pour la création de facture
interne ni l'onboarding restaurant (conforme à la préférence déjà exprimée). Vérification à faire
seulement au moment de la TRANSMISSION, jamais à la création de commande ni à l'onboarding ; un
flag `e_invoicing_ready` dérivé et rafraîchi, jamais stocké comme précondition dure.

### 9.P Secrets / configuration

Cohérent avec le pattern Stripe déjà en place (`STRIPE_PAYMENTS_ENABLED` + clés,
`platform/config.ts`) : `SUPERPDP_ENABLED` (défaut `false`), identifiants OAuth (`client_id`/
`client_secret`) exclusivement backend, jamais `NEXT_PUBLIC_*`/`EXPO_PUBLIC_*`, jamais loggés ;
base URL sandbox vs production distinctes à confirmer précisément au moment du code (la spec
distingue déjà un paramètre `env: sandbox`, §7.6, non creusé plus avant ici). OAuth confirmé non
nécessaire au flux mandat lui-même (§7.5bis) — les credentials servent seulement à authentifier le
compte Locadely (`client_credentials`).

### 9.Q Sandbox

Scénario déjà documenté en §7.6 (Burger Queen/Tricatel), confirmé toujours valable (spec
inchangée). Complément : `GET /v1.beta/invoices/generate_test_invoice` (déjà noté en §7.6) donne un
exemple fournisseur mais ne persiste rien et ne remplace pas un test réel de notre propre mapping —
le vrai scénario de test doit passer par notre pipeline JSON→convert→submit→poll, pas par cet
endpoint de commodité. Prérequis avant de lancer quoi que ce soit listés en §9.W.

### 9.R Tests ciblés (conception, pas de code)

Convergence sur les catégories déjà listées dans le brief (mandat, facture Locadely, facture
livreur, avoir, idempotence, polling, isolation, disponibilité du document), plus un cas ajouté par
cette analyse : **test explicite du cas d'ambiguïté réseau** (timeout sur soumission, aucun renvoi
automatique, état `unknown_outcome` posé, résolution manuelle ou par recherche) et un test de
**non-régression** (l'émission interne reste possible même Super PDP désactivé, en panne, mandat
non vérifié, ou restaurant non adressable — invariant central de toute cette tranche).

### 9.S Analyse Claude — résumé

Moteur interne vérifié conforme à §8 dans le code réel. Version OpenAPI stable (identique
caractère pour caractère au changelog déjà connu). Deux apports propres à cette passe : (1)
`GET /v1.beta/french_directory/entries?number=SIREN` identifié comme LA réponse concrète à la
question readiness restaurant, jusque-là seulement déduite ; (2) `InseeSireneProvider` déjà
existant (`modules/merchants`, réutilisable via `public.ts`) identifié comme le bon mécanisme pour
renseigner `platform_legal_identity` avec une source officielle (SIREN 877 508 994), plutôt que de
copier societe.com ou de laisser saisir à l'aveugle — les champs que Sirene NE donne PAS (régime
TVA, numéro TVA) restent à demander explicitement.

### 9.T Analyse Codex — résumé

Moteur interne vérifié indépendamment, mêmes conclusions. Apport propre décisif : lecture complète
des tableaux `required` des schémas `seller`/`buyer`/`en_invoice` (pas seulement la présence des
champs) — a trouvé que `seller.electronic_address` est réellement obligatoire, contredisant la
conclusion de §8.6. A aussi proposé un modèle d'états plus complet pour
`invoice_provider_submissions` (`unknown_outcome` notamment) et une architecture de mandat en deux
tables (métier + liaison provider) plus détaillée que la première ébauche de Claude — adoptée telle
quelle en §9.D/§9.L. A relevé la dérive documentaire `order.returned.v1` dans le `.md` (corrigée).

### 9.U Divergences

**Une seule divergence matérielle, résolue par vérification directe du schéma** : Claude avait
conclu en §8.6 « aucune donnée bloquante manquante » sans avoir vérifié le tableau `required` des
schémas concernés (seulement la présence/absence de champs mappables) ; Codex a trouvé
`seller.electronic_address` obligatoire. **Vérifié par Claude directement contre
`/tmp/superpdp_openapi_fresh.json`** après coup : `seller.required = ['name', 'electronic_address',
'postal_address']`, confirmé. **Codex avait raison, §8.6 corrigé (voir plus haut).** Aucune autre
divergence de fond — les deux analyses convergent sur l'architecture (deux tables mandat, garde
distincte bloquant seulement la transmission, idempotence via un état `unknown_outcome`/`ambiguous`
équivalent, Factur-X comme format cible, readiness restaurant non bloquante).

### 9.V Plan d'implémentation final (ordonné, non commencé)

1. Décisions juridiques/comptables préalables (§9.W) — bloquantes avant tout code touchant
   mandat/paiement.
2. Renseigner `platform_legal_identity` (via `InseeSireneProvider` réutilisé pour SIREN/adresse/
   raison sociale + saisie manuelle pour régime TVA/numéro TVA/adresse électronique) — aucune
   facture Locadely transmissible sans ça.
3. Migrations conceptuelles (Claude) : snapshots de transmission (adresse électronique vendeur/
   acheteur, conditions de paiement) sur les documents ou une table dédiée à ne jamais confondre
   avec les données légales déjà figées ; `driver_einvoice_mandates` +
   `driver_einvoice_mandate_provider_records` ; extension de `invoice_provider_submissions`
   (statuts enrichis, `unknown_outcome`, lease/tentatives, empreintes SHA-256) ; curseur global
   `invoice_events` par compte/provider.
4. ADR complémentaire actant l'architecture `EInvoiceProvider`/`EInvoiceMandateProvider` (ports
   séparés, jamais fusionnés) et la garde `DriverEInvoiceReadiness` (bloque seulement la
   transmission, jamais la course ni l'émission interne).
5. Backend (Codex) : adaptateur Super PDP derrière `EInvoiceProvider`/`EInvoiceMandateProvider`,
   worker de soumission (JSON→`/convert`→`/invoices`, `/validation_reports` avant soumission),
   worker de polling `invoice_events` avec projection de statuts (§9.M), résolution `unknown_
   outcome`, résolution annuaire restaurant (§9.O), mobile mandat (lecture/acceptation/suivi).
6. Web commerçant (Claude) : affichage du vrai document Factur-X téléchargeable une fois
   transmis, statut de transmission lisible sans jargon.
7. Tests ciblés (§9.R), revue complète Claude, sandbox réel une fois les credentials obtenus
   (§9.Q/§9.W).

### 9.W Informations à demander à l'utilisateur avant tout code

1. Identité légale Locadely à faire vérifier via `InseeSireneProvider` (SIREN `877 508 994`) —
   confirmer la raison sociale/adresse retournée, puis fournir explicitement : régime TVA (probable
   franchise en base pour une entreprise individuelle sous les seuils, **jamais supposé**), numéro
   TVA si applicable, adresse électronique EN16931 (voir point 2).
2. Schéma/valeur à utiliser pour l'adresse électronique EN16931 de Locadely et de chaque livreur
   (probable Peppol `0225:<SIREN>` par analogie avec l'annuaire français, **non confirmé par le
   schéma JSON** — à vérifier en sandbox ou directement auprès de Super PDP).
3. Validation juridique du mandat : force probante d'une acceptation mobile (case à cocher
   horodatée vs signature électronique qualifiée), texte définitif, durée, révocation, préavis,
   droit applicable, et si une commande peut être facturée en interne avant vérification du
   mandat (position actuelle : oui, seule la transmission attend — à confirmer/challenger).
4. Décision comptable/juridique sur les conditions de paiement à afficher (BT-20 générique
   proposé en §9.I), pénalités de retard, indemnité forfaitaire 40€, mention TVA sur encaissements.
5. Credentials Super PDP sandbox (puis production), confirmation que le compte Locadely existant
   est bien vérifié côté Super PDP, base URL sandbox/production exactes.
6. Confirmation écrite du fournisseur sur l'idempotence de `external_id` ou la procédure de
   récupération après un timeout ambigu (§9.L) — sans quoi le MVP doit rester en résolution
   manuelle pour ce cas précis.
7. Code exact `invoice_type_code` d'un avoir et représentation du montant (positif/négatif) —
   à vérifier en sandbox avant tout code (§9.H).
8. Politique de rétention/archivage des documents (JSON/XML/Factur-X, durée, accès après un
   éventuel changement de fournisseur) — Super PDP annonce 10 ans mais l'accès post-résiliation
   n'est pas documenté (§7.7).

Onze questions fournisseur supplémentaires déjà listées en §7.10 restent valables et non répétées
ici.

## 10. Étape 5 — Implémentation sandbox (2026-09-23, EN COURS — pas opérationnelle)

État : **fondations codées et testées (SQL, config, ports, adaptateurs, mapping, logique de
worker) ; câblage Postgres réel, mandat bout en bout, mobile et `app.ts` PAS FAITS.** Aucun appel
réseau réel exécuté (`SUPERPDP_CLIENT_ID`/`SUPERPDP_CLIENT_SECRET` inconnus — voir §10.5). À ne
PAS présenter comme une intégration fonctionnelle tant que §10.4 n'est pas résolu.

### 10.1 Livré et testé (Claude : SQL/config/ADR/Storage ; Codex : ports/adaptateurs/mapping/logique de worker, relus et corrigés par Claude)

- ADR `docs/adr/0007-superpdp-connector.md` — invariants (ports séparés, garde transmission-only,
  adresse électronique configurable, idempotence `unknown_outcome`, projection cumulative,
  mandat en table unique, Factur-X jamais une copie permanente par défaut).
- Migration `0048_superpdp_integration.sql` (appliquée à la base de dev, testée fresh-install +
  upgrade-path sur `invoices_r47`, non-régression vérifiée sur le test d'intégration Étape 4
  existant) : `invoices.seller_electronic_address_scheme`/`_value` (nullable, snapshot),
  `invoices.payment_means_type_code`/`payment_terms_text` (constantes avec défaut SQL conservé —
  jamais retiré, pour ne pas casser l'émission Étape 4 existante qui ne les connaît pas), trigger
  d'immutabilité étendu à ces colonnes, `invoice_provider_submissions` enrichie (statuts
  `prepared|submitting|submitted|accepted|rejected|retryable|failed|unknown_outcome`, bail,
  tentatives, unicité par `(provider, invoice_id/credit_note_id)`),
  `einvoice_provider_event_cursors` (curseur global de polling), `driver_einvoice_mandates`
  (append-only sur le contenu accepté, mutable sur le suivi provider et la révocation, un seul
  mandat courant par livreur).
- Bucket Storage privé `einvoice-documents` créé et vérifié (upload/sign/delete via curl, accès
  public refusé) — même discipline que `account-documents` (Étape 3).
- `apps/api/src/platform/config.ts` : `SUPERPDP_ENABLED` (défaut `false`), `SUPERPDP_API_BASE_URL`
  (défaut `https://api.superpdp.tech` — un seul host confirmé dans la spec, sandbox/production se
  distinguent par les identifiants, jamais une URL différente), `SUPERPDP_CLIENT_ID`/
  `SUPERPDP_CLIENT_SECRET`, `SUPERPDP_ELECTRONIC_ADDRESS_SCHEME` (défaut `0225`, configurable sans
  migration), 3 flags worker indépendants (défaut `false`), `SUPERPDP_POLL_INTERVAL_SECONDS`.
  `test/setup.ts` force `SUPERPDP_ENABLED=false` — même contrat hors ligne que Stripe.
- `apps/api/src/modules/invoices/` : ports `EInvoiceProvider`/`EInvoiceMandateProvider` (jamais
  fusionnés, ADR 0007 §1) ; `SuperPdpOAuthClient` (`client_credentials`, cache mémoire process,
  expiration lue depuis la réponse réelle, jamais loggé) ; `SuperPdpEInvoiceProvider`/
  `SuperPdpEInvoiceMandateProvider` (implémentations réelles, jamais appelées sans
  `SUPERPDP_ENABLED=true`) ; `en16931-mapper.ts` (JSON interne → `en_invoice`) ;
  `DriverEInvoiceReadiness` (isolée dans le module, jamais câblée dans `orders` — bloque
  uniquement la transmission, ADR 0007 §2) ; `RunEInvoiceSubmissionsUseCase`/logique de polling
  (orchestration, derrière un port `EInvoiceWorkRepository` PAS ENCORE implémenté en Postgres).
- **Deux bugs réels trouvés en relecture, corrigés par Claude avant la 2e tranche Codex** :
  1. Le mapping n'incluait `legal_registration_identifier` (SIREN, ISO 6523 ICD `0002`) ni côté
     vendeur ni acheteur — sans lui, le mécanisme de rapprochement automatique du mandat livreur
     par SIREN (§7.3) n'aurait rien à rapprocher. Ajouté sur `seller`/`buyer`.
  2. La soumission convertissait vers `to=factur-x` puis renvoyait ce résultat en JSON à
     `POST /invoices` — or cet endpoint n'accepte jamais de JSON (confirmé dans le schéma de
     requête : XML CII/UBL, PDF Factur-X, ou multipart seulement), et produire un Factur-X via
     `/convert` exige de fournir nous-mêmes un gabarit PDF (multipart `pdf`+`invoice` requis
     ensemble), que nous n'avons pas. **Corrigé : conversion vers `to=cii` (réponse
     `application/xml`, clairement documentée), soumission de ce XML.** Le rendu Factur-X lisible
     humainement se récupère séparément via `GET /invoices/{id}?format=factur-x` — Super PDP le
     génère côté serveur à partir du document déjà soumis, jamais besoin de notre propre gabarit
     PDF. `getDocument` corrigé pour ne plus utiliser `/download` (documenté déprécié).
- Tests (fakes uniquement, aucun réseau) : mapping (codes 380/389/381 hypothèse avoir isolée,
  adresse électronique calculée à la volée pour une facture legacy sans jamais la persister,
  projection cumulative tolérante aux doublons/désordre/codes inconnus), garde
  `DriverEInvoiceReadiness`, worker de soumission (succès avec hash SHA-256, erreur réseau avant
  envoi → `retryable`, timeout ambigu → `unknown_outcome` jamais retenté, livreur sans mandat
  vérifié → aucun appel fournisseur, annuaire acheteur absent → attente réessayable). 13 tests
  verts, typecheck/lint API+mobile verts (vérifié indépendamment par Claude, pas seulement le
  self-report Codex).

### 10.2 Hypothèse non confirmée, isolée exprès

`CREDIT_NOTE_TYPE_CODE = 381` (UNTDID 1001, avoir standard) — la spec ne donne aucune enum
explicite liant un code juridique à un avoir dans le schéma consulté. Isolée dans une seule
constante (`en16931-mapper.ts`) pour rester facile à corriger sans chercher dans plusieurs
fichiers si le sandbox la rejette un jour.

### 10.3 PAS fait (écart explicitement reconnu par Codex, pas caché)

- Aucun câblage PostgreSQL réel du worker de soumission/polling (`EInvoiceWorkRepository` = un
  port sans implémentation Postgres — les workers ne peuvent pas encore tourner contre la base).
- L'adaptateur `SuperPdpEInvoiceProvider` lève encore des `Error` génériques sur un échec HTTP,
  jamais les erreurs typées (`EInvoiceNetworkBeforeSendError`/`EInvoiceUnknownOutcomeError`) que
  le worker de soumission sait distinguer — tant que ce n'est pas raccordé, un vrai échec réseau
  tomberait à tort en `failed` (permanent) plutôt qu'en `retryable`. **À corriger avant tout test
  sandbox réel.**
- Use cases/routes HTTP/câblage Storage du mandat (acceptation, soumission, suivi) : rien encore.
- Écran mobile « Mandat de facturation » : rien encore.
- Câblage `app.ts` (workers derrière les 3 flags, providers réels vs `Unavailable*`) : rien encore.
- Aucun test tourné contre une vraie base Postgres pour cette tranche (à faire par Claude,
  `docs/work/r47-testdb.sh` ou équivalent étendu, une fois le câblage Postgres écrit).

### 10.4 Pourquoi arrêté ici

Deux tranches Codex ont chacune livré une partie (ports/adaptateurs/mapping, puis logique de
worker) mais se sont arrêtées avant le câblage Postgres/HTTP/mobile complet, explicitement signalé
à chaque fois plutôt que présenté comme fini. **Aucun credential Super PDP n'est disponible côté
utilisateur aujourd'hui** (compte sandbox existant, mais `client_id`/`client_secret` pas encore
localisés dans l'interface) — décision explicite : ne pas continuer à empiler des tranches de
code non testable en conditions réelles tant que ce blocage n'est pas levé ; reprendre le câblage
restant (§10.3) une fois les credentials obtenus, pour pouvoir le valider en conditions réelles au
fur et à mesure plutôt qu'à l'aveugle.

### 10.5bis Premier test sandbox réel (2026-09-23) — RÉUSSI pour le socle facture, en cours pour le mandat

Credentials sandbox configurés localement (application Burger Queen, confidentielle) : `credentials
sandbox configurés localement` — jamais commités, jamais loggés en clair, jamais dans ce fichier.

**Validé en conditions réelles, bout en bout** :
1. `POST /oauth2/token` (`grant_type=client_credentials`, corps `application/x-www-form-urlencoded`
   avec `client_id`/`client_secret`) → 200, `access_token`/`expires_in=1799`/`token_type=bearer` —
   confirme exactement l'implémentation `SuperPdpOAuthClient` telle quelle, aucune correction
   nécessaire.
2. `GET /v1.beta/companies/me` → confirme le contexte (`env: "sandbox"`, entreprise "Burger Queen",
   `number_scheme: "sandbox"`, `number: "000000002"` — **pas un SIREN réel en sandbox**, confirme
   qu'il faut utiliser `grantor_number_scheme=sandbox` pour les mandats de test, jamais un SIREN
   fabriqué).
3. `GET /v1.beta/invoices/generate_test_invoice?format=en16931` → a produit une facture de test
   réelle (Burger Queen vendeur, Tricatel acheteur) qui a révélé **deux vrais bugs dans notre
   mapping, corrigés immédiatement** :
   - `totals.total_vat_amount` (BT-110) est un OBJET `{value, currency_code}` (schéma `amount`),
     pas une simple chaîne décimale comme les autres totaux — nous envoyions une chaîne.
   - La TVA par ligne utilise le schéma `line_vat_information`
     (`invoiced_item_vat_category_code`/`invoiced_item_vat_rate`/`exemption_reason`), jamais
     `vat_category_code`/`vat_category_rate` (ces noms n'existent qu'au niveau document, dans
     `vat_break_down`) — nous utilisions les mauvais noms de champs au niveau ligne.
   - Confirmé au passage : `legal_registration_identifier` avec `scheme: "0002"` — la correction
     de Claude de la veille (ISO 6523 ICD SIREN) était exactement juste.
4. `POST /v1.beta/invoices/convert?from=en16931&to=cii` avec cette facture de test → 200,
   `content-type: application/xml`, XML CII valide (16 Ko) — confirme exactement le choix
   `to=cii` (jamais `to=factur-x` en JSON, cf. §10.1 bug 2).
5. `POST /v1.beta/invoices?processing_rule=B2B&external_id=…` avec ce XML
   (`content-type: application/xml`) → 200, `id=711803`, `company_id=105734`, premier événement
   `api:uploaded` déjà présent dans la réponse.
6. `GET /v1.beta/invoice_events?invoice_id=711803` quelques secondes plus tard → progression réelle
   `api:uploaded` → `fr:200` (déposée/validée) → `fr:201` (émise par la plateforme) → `fr:202`
   (reçue par la plateforme) — **le document a été réellement délivré à Tricatel en quelques
   secondes**, confirme le polling et la sémantique cumulative des événements.
7. `GET /v1.beta/invoices/711803?format=factur-x` → 200, `content-type: application/pdf`, vrai PDF
   Factur-X 8 pages — confirme la récupération du document lisible sans jamais avoir fourni de
   gabarit PDF nous-mêmes.
8. `GET /v1.beta/french_directory/entries?number=000000001` (Tricatel, numéro sandbox) → liste
   vide — attendu, l'annuaire français ne connaît que des SIREN réels (`fr_siren`), pas les
   numéros `sandbox` fictifs ; ne pas s'inquiéter de ce résultat en sandbox.

**Les 8 étapes du socle demandé sont validées.**

**Non résolu — mandat** : `POST /v1.beta/company_mandates` (multipart, `object` en JSON +
`pdf` en binaire, `direction=out`, `grantor_number_scheme=sandbox`, `grantor_number="000000001"`)
a échoué 3 fois de suite (curl deux variantes + construction manuelle Python du multipart,
formats structurellement corrects vérifiés) avec la même erreur générique 400 : *"the body of
this request must be a multipart with the json payload and the mandate in pdf"*. Piste possible,
non vérifiée : le schéma `company_mandate` liste `id`/`created_at`/`grantee_id` comme `required`
alors qu'ils sont aussi marqués `readOnly` (probablement un schéma de réponse réutilisé tel quel
pour la requête, incohérence de spec plutôt qu'une vraie exigence) — pas la cause identifiée avec
certitude. À reprendre en rejouant précisément le scénario officiel documenté (Burger Queen/
Tricatel, formulaire UI) plutôt qu'en devinant davantage le format multipart exact.

### 10.5 Action pour débloquer la suite — **FAIT (2026-09-23)**

`credentials sandbox configurés localement` (application "Burger Queen", confidentielle) —
jamais commités, jamais loggés, jamais dans ce fichier.

### 10.6 Debug ciblé `company_mandates` (2026-09-23) — RÉSOLU, cause confirmée en conditions réelles

**Symptôme** : `POST /v1.beta/company_mandates` retournait systématiquement
`400 "the body of this request must be a multipart with the json payload and the mandate in
pdf"`, quel que soit le contenu JSON envoyé.

**Méthode** : Claude a mené sa propre investigation par appels réseau réels successifs (chaque
tentative suivant une hypothèse précise, jamais aléatoire) ; Codex a mené une investigation
indépendante en parallèle (spec/doc uniquement — **son environnement n'avait pas de sortie DNS
vers `api.superpdp.tech`, aucun appel réseau n'a donc pu aboutir de son côté**, il l'a signalé
honnêtement plutôt que d'inventer un résultat).

**Cause racine confirmée, par élimination avec preuves serveur à chaque étape** :
1. PDF invalide (texte brut renommé `.pdf`, pas d'en-tête `%PDF`) → même erreur générique quel
   que soit le nom des champs testés (`object`, `metadata`). **Un vrai PDF minimal valide seul ne
   suffit pas non plus** (voir 3).
2. Numéro de mandant invalide/inexistant → erreur CLAIRE et différente
   (`"Mandant non trouvé"`) — confirme que le parsing multipart réussit dès que ses conditions
   sont réunies ; l'erreur générique n'apparaît QUE quand la structure de la requête elle-même
   est rejetée avant validation métier.
3. **Cause définitive** : la partie `object` (JSON) doit porter explicitmenent
   `Content-Type: application/json`. Un champ texte simple (`-F 'object={...}'` sans `;type=`, ou
   l'équivalent `FormData.set('object', <string>)` en JavaScript, qui envoie `text/plain` par
   défaut) est rejeté avec le même message générique et trompeur — **prouvé par une paire de
   requêtes identiques ne différant que par ce Content-Type, la seule sans lui échouant**.
   Isolé du problème de PDF invalide : les deux causes sont indépendantes et cumulatives (il faut
   corriger les deux).

**Format multipart exact qui fonctionne** (confirmé par une vraie création de mandat, `id=13504`,
puis par un round-trip complet `GET`/`list`/`download`, puis par le test automatisé
`test/invoices/superpdp-sandbox.test.ts` via le vrai code de production) :
- part `object` : JSON (`{"direction":"out","grantor_number_scheme":"...","grantor_number":"..."}`),
  **`Content-Type: application/json` explicite obligatoire**.
- part `pdf` : PDF binaire valide (en-tête `%PDF` réel), `Content-Type: application/pdf`.
- Noms de champs confirmés corrects tels quels (`object`/`pdf`) — **l'hypothèse d'un nom de champ
  différent (`metadata`, suggérée par l'incohérence `encoding.metadata` vs `schema.properties.
  object` de la spec) était fausse**, vérifiée et écartée par un test dédié.

**Bug réel corrigé dans le code** : `superpdp-einvoice-mandate-provider.ts` envoyait `object` en
`FormData.set('object', JSON.stringify(...))` (chaîne simple, donc `text/plain`) — corrigé en un
`Blob` typé `application/json`, comme la partie `pdf` l'était déjà correctement. **Sans cette
correction, l'adaptateur de production aurait échoué exactement comme les tests manuels
initiaux**, quel que soit le PDF fourni par un futur appelant.

**Trouvailles supplémentaires en conditions réelles, pendant la validation du flux facture complet
(`convert`+`submit`), 3 vrais rejets Schematron corrigés dans `en16931-mapper.ts`** :
- BR-23 : `invoiced_quantity_code` (BT-130, unité de mesure) ne doit jamais être omis — `"C62"`
  (UN/CEFACT, « unité ») par défaut, cohérent avec l'exemple officiel Super PDP.
- BR-E-02 : une ligne exonérée (`vat_category_code='E'`, cas franchise en base) exige l'identifiant
  TVA ET/OU l'identifiant d'enregistrement fiscal (BT-32, distinct de BT-30) du vendeur — ajouté
  `seller.tax_registration_identifier = SIREN`, jamais un faux numéro de TVA pour un vendeur qui
  n'en a structurellement pas.
- BR-FR-05 : trois mentions légales obligatoires (indemnité forfaitaire 40€, pénalités de retard,
  absence d'escompte, codes `PMT`/`PMD`/`AAB`) doivent figurer dans `notes` (BG-1) — absentes de
  notre mapping, ajoutées avec le texte exact du propre générateur de facture de test Super PDP
  (source fiable, déjà validée par leur moteur), pas rédigées depuis zéro.
- BR-FR-08 : `process_control.business_process_type` (BT-23) ne peut pas être vide — `"M1"` par
  défaut (valeur de l'exemple officiel).

**Résultat final vérifié par le test automatisé opt-in** (`SUPERPDP_SANDBOX_TESTS=1 npm run test
-w apps/api -- test/invoices/superpdp-sandbox.test.ts`, 3/3 verts, réseau réel) : auth OAuth,
création de mandat sandbox (multipart correct, erreur métier propre si déjà existant), soumission
complète d'une facture réelle (`convert`→`submit`→événements), **plus aucun rejet de validation**.

**Divergence Claude/Codex** : aucune divergence de fond — Codex n'a simplement pas pu tester
(DNS bloqué dans son environnement), sa seule piste (`object.direction=out` aplati plutôt qu'un
JSON imbriqué) n'a jamais été vérifiée et est **contredite par la preuve empirique** ci-dessus
(le format JSON imbriqué avec `object`/`pdf` fonctionne réellement, à condition du Content-Type).
Conservée ici uniquement comme piste alternative si jamais le comportement serveur changeait.

**Aucun changement de schéma/migration** — conforme à la consigne, uniquement du code applicatif
(`superpdp-einvoice-mandate-provider.ts`, `en16931-mapper.ts`, messages d'erreur enrichis dans
`superpdp-einvoice-provider.ts` pour inclure le corps de réponse, jamais seulement le code HTTP).

### 10.7 Reste après ce debug

Le socle facture ET le socle mandat fonctionnent maintenant réellement en sandbox. Reste
inchangé par rapport à §10.3 : câblage PostgreSQL des workers, use cases/HTTP/Storage du mandat
livreur, écran mobile, câblage `app.ts`. Prochaine étape logique : reprendre §10.3 dans l'ordre,
sans plus aucun doute sur la mécanique HTTP/multipart elle-même.

## 11. Analyse complète du câblage restant (2026-09-23) — ANALYSE UNIQUEMENT, aucun code

Hors scope strict de cette section (non traité, conforme à la consigne) : production, calendrier
de réforme, contrat/tarification/KYC-KYB Super PDP, stratégie commerciale.

### 11.A Résumé exécutif

Le socle HTTP Super PDP (auth, mandat, facture, avoir un jour) est réellement validé en sandbox
(§10.5bis/§10.6). Le moteur interne de facturation fonctionne en production locale (§8). Mais la
couche applicative Super PDP écrite jusqu'ici (ports, adaptateurs, mapping, use cases de worker)
n'est **branchée nulle part** : aucun repository Postgres derrière les ports de travail, aucune
ligne jamais créée dans `invoice_provider_submissions`, rien construit dans `app.ts`, aucun use
case HTTP/Storage pour le mandat, aucun écran mobile. Un vrai trou de schéma est aussi confirmé
(§11.10) : la projection cumulative des événements (ADR 0007 §6) est impossible avec le schéma
actuel, qui ne conserve qu'un curseur global, jamais les événements individuels.

### 11.B État actuel réel (vérifié dans le code par les deux analyses, convergentes)

- `EInvoiceWorkRepository`/`EInvoiceEventsRepository` : ports seuls, aucune implémentation
  Postgres (`apps/api/src/modules/invoices/ports/einvoice-work-repository.ts`).
- `PostgresInvoiceRepository.insertInvoice`/`createCreditNote` n'insèrent jamais dans
  `invoice_provider_submissions` — la table reste vide, rien n'est jamais réclamable par un
  worker, même une fois Super PDP activé.
- `RunEInvoiceSubmissionsUseCase`/`PollEInvoiceEventsUseCase` : logique pure déjà écrite et
  testée par fakes, jamais construits dans `createInvoicesModule`/`app.ts`, pas exportés par
  `public.ts`.
- `SuperPdpEInvoiceProvider`/`SuperPdpEInvoiceMandateProvider` lèvent encore des `Error`
  génériques (avec corps de réponse, corrigé lors du debug §10.6) — le worker attend des erreurs
  typées (`EInvoiceNetworkBeforeSendError`/`EInvoiceUnknownOutcomeError`) que rien ne produit
  encore côté adaptateur réel.
- `SuperPdpEInvoiceMandateProvider.createMandate` force `grantor_number_scheme: 'fr_siren'` en
  dur, sans paramètre — confirmé bloquant pour tout test sandbox avec un mandant `sandbox`
  (`test/invoices/superpdp-sandbox.test.ts` accepte aujourd'hui l'échec « Mandant non trouvé »
  comme un succès de format, faute de mieux).
- `driver_einvoice_mandates` (migration 0048) existe et est complète pour représenter l'état
  métier/provider d'un mandat, mais n'a ni bail, ni compteur de tentatives, ni `next_attempt_at`
  — insuffisante telle quelle pour un worker de soumission de mandat robuste aux reprises
  concurrentes (elle suffit pour le stockage, pas pour l'orchestration).
- `DriverEInvoiceReadiness` (ADR 0007) : classe + port seuls, aucun lecteur Postgres, aucun
  câblage — jamais utilisée nulle part aujourd'hui (correctement, elle ne doit jamais l'être dans
  `orders`).
- `projectSubmissionStatus` (`en16931-mapper.ts`) : orpheline en production, seulement testée.
- Aucun use case n'appelle jamais `EInvoiceProvider.getDocument` ; `invoice_provider_submissions.
  document_storage_path` n'est jamais écrit.
- `GET /api/v1/orders/:id/documents` ne renvoie que des métadonnées, jamais un fichier.
- `app.ts` ne construit que `createInvoicesModule(pool)` — aucun `SuperPdpOAuthClient`/provider/
  worker Super PDP n'existe dans le service qui tourne réellement, malgré les 3 flags déjà
  présents dans `config.ts` (`SUPERPDP_MANDATE_WORKER_ENABLED`/`SUPERPDP_SUBMISSION_WORKER_
  ENABLED`/`SUPERPDP_POLLING_WORKER_ENABLED`).

### 11.C Analyse Claude — apports propres

- `insertInvoice` ne renseigne pas non plus `invoices.seller_electronic_address_scheme`/`_value`
  (colonnes nullables de la migration 0048, prévues pour ça) — à faire au même moment que la
  création de la ligne `invoice_provider_submissions`, dans la même transaction d'émission,
  jamais après coup (immuabilité du contenu légal, ADR 0006 §4).
- Le motif de composition déjà établi pour Stripe (`config.X_ENABLED && config.X_KEY !==
  undefined ? new RealProvider(...) : new UnavailableProvider()`, `apps/api/src/app.ts:135/152`)
  et l'arrêt propre via `onClose` (`stopOutboxRelay`, workers settlements) sont directement
  réutilisables pour Super PDP sans invention — aucun nouveau motif à créer.
- Recommandation d'ordonnancement : plutôt qu'une tranche « composition root » séparée et
  tardive, câbler chaque pièce dans `app.ts` AU FUR ET À MESURE de la tranche qui la construit
  (chaque tranche livre son bout ET son branchement) — réduit le risque d'intégration en fin de
  parcours et permet de vérifier réellement chaque worker dans le service qui tourne dès qu'il
  existe, plutôt que d'accumuler du code jamais exécuté jusqu'à une grande tranche finale.

### 11.D Analyse Codex — apports propres (vérifiés par Claude, confirmés exacts)

- **`en16931-mapper.ts` : `euro()` fait `(cents / 100).toFixed(2)`, une division en flottant
  JavaScript — contraire à la règle absolue « jamais de float pour de l'argent ». Vérifié exact.**
  Le stockage reste entier partout, seule cette fonction de formatage sortant est concernée ;
  correction proposée pour la prochaine tranche qui touche ce fichier : construire la chaîne
  décimale par arithmétique entière (division/modulo entiers, jamais une division flottante),
  jamais un correctif « juste au cas où » en dehors d'une tranche qui touche déjà ce fichier.
- **Trou de schéma confirmé et nouveau** : la projection cumulative des événements (ADR 0007 §6,
  « jamais le dernier événement seul ») est IMPOSSIBLE avec le schéma actuel — `0048` ne stocke
  qu'un curseur global (`einvoice_provider_event_cursors`) et `last_invoice_event_id` par
  soumission, jamais les événements individuels. Une table d'événements bruts dédupliqués
  (`(provider, event_id)` unique, rattachée à la soumission) est nécessaire — **signalé, pas
  créé**, conforme à la consigne.
- `EInvoiceWorkRepository.resolveBuyerElectronicAddress` mélange un port DB et un appel réseau
  annuaire — incohérence architecturale réelle, à corriger par un port séparé
  (`BuyerElectronicAddressResolver`, implémenté par l'adaptateur Super PDP, jamais par un
  repository Postgres).
- Le `continue` du worker sur un livreur non prêt (mandat non vérifié) ne libère ni ne
  reprogramme explicitement le bail déjà posé par `claimDue` — repose uniquement sur l'expiration
  silencieuse du bail. À remplacer par une décision explicite de la politique d'éligibilité
  (§11.F point 9).
- `SuperPdpEInvoiceMandateProvider.createMandate` : le SIREN forcé en dur empêche structurellement
  tout test sandbox avec un mandant `sandbox` — le port doit accepter le schéma en paramètre.

### 11.E Divergences

**Aucune divergence de fond.** Les deux analyses convergent sur l'état réel du code (vérifié
indépendamment aux mêmes lignes), sur la nature des trous, et sur l'architecture cible. Seule
nuance, pas un désaccord : Claude propose de répartir le câblage `app.ts` tranche par tranche
plutôt qu'une tranche « composition root » séparée en fin de parcours (§11.C) — retenue dans le
plan de tranches ci-dessous.

### 11.F Architecture cible (consolidée)

1. **Création atomique de la soumission** : chaque `INSERT invoices`/`INSERT credit_notes` crée,
   dans la MÊME transaction locale, une ligne `invoice_provider_submissions` `prepared` avec un
   `external_id` déterministe — jamais après coup, jamais dépendant d'un worker séparé qui
   pourrait crasher entre les deux.
2. **`claimDue`** : transaction courte, `FOR UPDATE SKIP LOCKED` sur les lignes `prepared`/
   `retryable` échues ou `submitting` dont le bail a expiré (même patron que
   `platform/outbox-relay.ts`), passage à `submitting` + `locked_until` + `attempts`+1.
3. **Résolution annuaire acheteur** : port séparé de la persistance (`BuyerElectronicAddressResolver`,
   implémenté par l'adaptateur Super PDP), appelé HORS transaction, jamais un cache obligatoire
   pour le MVP sandbox/local.
4. **Erreurs typées produites à la frontière HTTP** (dans l'adaptateur, pas dans le worker) :
   erreur avant envoi effectif → `retryable` ; timeout/coupure après envoi → `unknown_outcome`,
   jamais de renvoi automatique ; réponse de validation déterministe → `failed`.
5. **Événements** : table dédiée (à créer dans une future migration, pas maintenant) stockant
   chaque événement brut dédupliqué par `(provider, event_id)`, jamais un simple curseur seul —
   condition sine qua non de la projection cumulative déjà écrite (`projectSubmissionStatus`).
6. **`invoices.transmission_status`/`credit_notes.transmission_status`** restent une projection
   UI générique dérivée de `invoice_provider_submissions.submission_status` (mapping proposé :
   `prepared/submitting/retryable/failed/unknown_outcome → not_submitted`, `submitted →
   submitted`, `accepted → confirmed`, `rejected → rejected`) — jamais écrits indépendamment par
   deux chemins de code différents ; une future interface plus détaillée (restaurant/admin) devra
   pouvoir lire l'état technique complet, pas seulement la projection à 4 valeurs.
7. **Règle d'éligibilité pure** (`canSubmitElectronicInvoice` ou équivalent, pas de nom figé) :
   Locadely (380) toujours soumettable sans mandat ; livreur (389) seulement si
   `DriverEInvoiceReadiness` (mandat courant `verified`) ; un avoir hérite de l'émetteur de sa
   facture d'origine, jamais un mandat propre. Résultat explicite consommé par le worker, jamais
   un simple `continue` silencieux.
8. **Mandat backend** : use cases (lecture statut courant, acceptation avec preuve versionnée,
   génération/hash/upload PDF privé dans `einvoice-documents`, soumission provider, suivi
   `getMandate`), preuve d'acceptation modélisée comme un objet versionné/discriminé distinct du
   mandat lui-même (méthode, instant, version de texte, hash, acteur authentifié — extensible à
   une signature qualifiée plus tard sans réécrire le mandat), jamais un choix juridique figé en
   dur dans la contrainte SQL actuelle (`acceptance_method` limité à `mobile_checkbox`).
9. **Composition root** : construit incrémentalement (§11.C) — `SuperPdpOAuthClient`/providers
   seulement si `SUPERPDP_ENABLED` (motif Stripe existant), `Unavailable*` sinon, chaque worker
   derrière son propre flag, arrêt propre via `onClose`.
10. **Factur-X** : endpoint HTTP dédié (jamais confondu avec `/documents`, qui reste des
    métadonnées), récupéré à la demande tant que le statut n'est pas terminal, copie privée
    stockée seulement une fois accepté/rejeté, autorisations restaurant (ses deux documents) /
    livreur (les siens uniquement) déjà conformes au modèle existant de `get-order-documents.ts`.
11. **Mobile** : lit toujours l'état depuis le backend (jamais un état optimiste local durable),
    ne génère ni ne stocke de PDF, ne voit jamais de secret fournisseur.

### 11.G Plan par tranches (ordonné par dépendances réelles)

**Tranche 1 — Socle de persistance transmission.** Objectif : toute facture/avoir émis crée
atomiquement sa soumission, réclamable sans double traitement. Fichiers : `postgres-invoice-
repository.ts` (insert `invoice_provider_submissions` + colonnes adresse électronique vendeur),
nouveau repository Postgres pour `EInvoiceWorkRepository`, migration pour la table d'événements
bruts (si retenue à ce stade). Tests : intégration Postgres (concurrence, bail, retry, unicité).
Fini : deux factures + tout avoir → exactement une soumission chacun ; aucun double claim possible.

**Tranche 2 — Sémantique provider et polling.** Objectif : classification fiable, projection
cumulative réelle. Fichiers : erreurs typées produites dans l'adaptateur (pas seulement le
worker), repository d'événements, worker de polling branché. Tests : fetch fake par classe
d'erreur ; intégration curseur/déduplication/projection. Fini : aucun renvoi automatique après
ambiguïté ; un statut déjà terminal ne régresse jamais.

**Tranche 3 — Annuaire et éligibilité.** Objectif : router sans appel réseau en transaction, sans
jamais bloquer le dispatch existant. Fichiers : port `BuyerElectronicAddressResolver`, règle pure
d'éligibilité, `DriverEInvoiceReadiness` (lecteur Postgres, jamais câblé ailleurs que dans le
worker de soumission). Tests : adresse absente (attente, pas d'erreur), livreur non vérifié
(décision explicite), 380 vs 389. Fini : seuls les documents réellement éligibles partent ;
l'émission interne et le dispatch restent intacts dans tous les cas.

**Tranche 4 — Mandat backend + stockage.** Objectif : cycle de vie mandat durable côté serveur,
sans mobile. Fichiers : use cases/repository/transport/adaptateur Storage `invoices`, correction
`SuperPdpEInvoiceMandateProvider` (schéma configurable), worker mandat, `public.ts`, extension de
schéma bail/retry si nécessaire (signalé, pas créée ici). Tests : acceptation, immuabilité,
reprise, autorisations, provider fake + un test sandbox réel avec `grantor_number_scheme=sandbox`.
Fini : mandat accepté → PDF privé hashé → soumis → suivi, jamais via le client.

**Tranche 5 — Factur-X et mobile mandat.** Objectif : consultation reprenable et document
téléchargeable avec autorisations. Fichiers : nouvel endpoint documents `invoices`, API mobile,
écran(s) Compte > Facturation électronique. Tests : droits restaurant/livreur, fermeture/
réouverture app, tous les états provider affichés sans jargon. Fini : mobile relit toujours le
backend ; aucun secret/chemin Storage brut exposé au client.

**Tranche 6 — Validation sandbox des cas séparés.** Objectif : valider chaque flux distinct, dont
l'avoir. Fichiers : `test/invoices/superpdp-sandbox.test.ts` étendu. Tests : mandat avec le vrai
schéma sandbox, facture Locadely, facture livreur (mandat vérifié requis), avoir (code/signe des
montants à confirmer réellement, jamais supposés). Fini : chaque scénario reproductible en
sandbox, aucun visant la production.

Le câblage `app.ts`/composition root n'est plus une tranche séparée : chaque tranche 1-5 câble sa
propre pièce au fur et à mesure (§11.C/§11.F.9), vérifiable dans le service réel dès qu'elle
existe.

### 11.H Risques

Conservation de la note float (§11.D) tant que `en16931-mapper.ts` n'est pas retouché ; absence
actuelle de la table d'événements rend toute tentative de brancher le polling aujourd'hui
structurellement incomplète (à ne pas faire avant la tranche 2) ; le `continue` silencieux sur
readiness manquante, si câblé tel quel, laisserait des soumissions bloquées sans diagnostic clair
jusqu'à expiration du bail ; le mandat sandbox reste non validé de bout en bout tant que le schéma
n'est pas paramétrable dans le provider.

### 11.I Décisions techniques tranchables sans l'utilisateur

Insertion atomique des soumissions à l'émission ; `FOR UPDATE SKIP LOCKED` + bail pour les
workers (patron déjà établi) ; table d'événements bruts dédupliqués ; séparation du port annuaire
de la persistance ; taxonomie des erreurs provider ; endpoint dédié Factur-X ; `DriverEInvoiceReadiness`
strictement transmission-only ; composition root incrémentale par tranche.

### 11.J Décisions produit/juridiques nécessitant un choix utilisateur

Valeur probante acceptable de l'acceptation mandat (case à cocher vs signature avancée/qualifiée) ;
texte/version/durée/révocation/préavis définitifs du mandat ; politique de présentation UI des
états `retryable`/`unknown_outcome`/`failed` (déjà esquissée en §11.F.6, à valider) ; politique de
conservation des documents (JSON/XML/Factur-X) et d'accès après un éventuel changement de
fournisseur ; périmètre de déclenchement (préparer une soumission pour TOUTES les factures dès
qu'émises, ou seulement un périmètre sandbox explicitement sélectionné le temps de la validation).

### 11.K Blocages externes réels

Schéma sandbox du mandant non paramétrable dans le code actuel (corrigible sans l'utilisateur,
listé en 11.I par erreur de tri initial — techniquement tranchable, mais le TEST qui le prouvera
dépend de rejouer le scénario sandbox, déjà possible dès la tranche 4) ; validation sandbox de
l'avoir encore jamais faite ; absence de documentation fournisseur confirmée sur la récupération
après un résultat de soumission ambigu (§10.5bis/§9.L, déjà noté, toujours vrai).

### 11.L Ordre recommandé pour commencer le code (prochaine session)

Tranche 1, dans cet ordre précis : (a) ajouter l'insertion `invoice_provider_submissions` +
adresse électronique vendeur dans `postgres-invoice-repository.ts` ; (b) écrire la migration de la
table d'événements bruts (nécessaire dès la tranche 2, autant la poser maintenant avec le reste du
socle de persistance) ; (c) repository Postgres `EInvoiceWorkRepository`/`EInvoiceEventsRepository` ;
(d) tests d'intégration sur base isolée. Rien de tout cela ne dépend d'un choix produit/juridique
encore ouvert (§11.J) — peut démarrer immédiatement sur instruction explicite de coder.

## 12. Étape 5 — Tranche 1 : socle de persistance transmission — **DONE (2026-09-23)**

Uniquement la Tranche 1 (§11.G). Aucune autre tranche commencée. Répartition : Claude (SQL/
migration/repository Postgres/tests/revue), conforme à « Claude propriétaire SQL/migrations » —
le repository de travail a été écrit directement par Claude (code fortement couplé au schéma
conçu dans la même tranche, pas de délégation Codex nécessaire cette fois).

### 12.1 Résumé de ce qui a changé

Chaque facture/avoir créé prépare désormais atomiquement sa soumission future
(`invoice_provider_submissions`, `prepared`) dans la MÊME transaction que son émission — jamais
après coup. L'adresse électronique vendeur (BT-34) est systématiquement renseignée à l'émission.
Un repository Postgres complet permet à un futur worker de réserver du travail par bail
(`FOR UPDATE SKIP LOCKED`), sans jamais perdre une ligne après un crash, sans jamais double-traiter
la même soumission. Les événements Super PDP peuvent désormais être conservés individuellement,
sans perte, de façon idempotente — condition nécessaire à la projection cumulative déjà écrite
(`projectSubmissionStatus`). Deux corrections annexes triviales faites en même temps (`euro()`,
`grantor_number_scheme`).

### 12.2 Migration créée

`supabase/migrations/0049_einvoice_work_persistence.sql` — table `einvoice_events` (append-only,
unicité `(provider, provider_event_id)`, index `(submission_id, provider_event_id)`). Aucun
ajout de colonne : `invoice_provider_submissions` (0047/0048) avait déjà `created_at`
(nécessaire pour trier `claimDue`), le bail/retry et les identifiants fournisseur — vérifié
suffisante, documenté explicitement dans la migration plutôt que supposé. Testée fresh-install +
upgrade-path sur base jetable (`invoices_r47`), non-régression vérifiée sur les 8 tests
d'intégration Étape 4 existants avant d'écrire le moindre nouveau code. Appliquée à la base de
dev.

### 12.3 Repositories/ports créés ou modifiés

- `PostgresInvoiceRepository` (existant, modifié) : `insertInvoice`/`createCreditNote` créent
  désormais la ligne `invoice_provider_submissions` correspondante dans leur transaction ;
  nouveau paramètre constructeur `electronicAddressScheme: string`.
- `PostgresEInvoiceWorkRepository`/`PostgresEInvoiceEventsRepository` (nouveaux,
  `infrastructure/postgres-einvoice-work-repository.ts`) : implémentent les ports déjà écrits
  (`EInvoiceWorkRepository`/`EInvoiceEventsRepository`) sans les modifier, sauf `EInvoiceEventsRepository.
  applyEvents` élargi pour porter `statusText`/`createdAt` par événement (absents du port
  d'origine, nécessaires à `occurred_at` — corrigé en même temps que `poll-einvoice-events.ts`,
  qui les perdait avant même d'atteindre un repository).
- `EInvoiceMandateProvider.createMandate`/`SuperPdpEInvoiceMandateProvider` : `grantorNumberScheme`
  optionnel ajouté (§12.7).
- `createInvoicesModule`/`app.ts` : câblage minimal du paramètre de configuration (pas de
  provider ni de worker Super PDP construit — hors périmètre de cette tranche).

### 12.4 Modèle de locking/bail retenu

`FOR UPDATE SKIP LOCKED` sur une sélection des lignes `prepared`/`retryable` échues OU
`submitting` dont le bail (`locked_until`) a expiré, dans une transaction courte qui pose
`submitting` + `locked_until` + incrémente `attempts` — exactement le patron déjà en place pour
`platform/outbox-relay.ts`, aucune invention. Le verrou n'est jamais tenu pendant un appel
réseau (la construction du `SubmissionWork` complet se fait dans des requêtes SEPARÉES, hors la
transaction de claim). Un bail expiré redevient automatiquement réclamable par un futur worker
sans aucune intervention manuelle — vérifié par test (bail d'1 seconde, réclamé de nouveau après
expiration).

### 12.5 Modèle d'événements retenu

Table dédiée `einvoice_events`, une ligne par événement individuel (jamais un curseur seul),
unicité `(provider, provider_event_id)` garantissant l'idempotence d'un rejeu de polling. Champs
volontairement minimaux (pas de copie brute de la réponse fournisseur) : identifiants, code de
statut, texte, horodatage provider (`occurred_at`) et de réception (`received_at`). Le curseur
global (`einvoice_provider_event_cursors`, 0048) n'avance que dans la même transaction que
l'insertion des événements du lot, jamais avant, et seulement vers l'avant
(`greatest(last_invoice_event_id, …)`).

### 12.6 Adresse électronique vendeur — source → persistance → mapper

Source : SIREN déjà connu (`driver_legal_information`/`platform_legal_identity`) + un schéma de
configuration (`SUPERPDP_ELECTRONIC_ADDRESS_SCHEME`, déjà dans `config.ts`, défaut `"0225"`).
Persistance : `invoices.seller_electronic_address_scheme`/`_value`, renseignées à l'émission par
`PostgresInvoiceRepository` (le repository reçoit la chaîne de configuration en paramètre
constructeur, câblée par `app.ts` — **aucune dépendance à Super PDP dans le domaine facture**,
conforme à la consigne). Mapper : `en16931-mapper.ts` lit ces colonnes si renseignées, sinon les
calcule à la volée pour une facture legacy sans jamais les persister rétroactivement
(comportement déjà écrit, inchangé, vérifié par test).

### 12.7 Corrections annexes

- `euro()` (`en16931-mapper.ts`) : division flottante (`cents/100`) remplacée par une conversion
  entièrement en `BigInt` (division/modulo entiers). Testé sur 1, 10, 101, 199, 1000 centimes.
- `SuperPdpEInvoiceMandateProvider.createMandate`/`EInvoiceMandateProvider` : `grantorNumberScheme`
  optionnel (`'fr_siren'` défaut, `'sandbox'` pour les tests) — correction triviale, nécessaire
  au test sandbox existant, sans commencer le reste de la Tranche 4 (mandat).

### 12.8 Tests exécutés et résultats

- `test/invoices/einvoice-work-repository.integration.test.ts` (nouveau, base isolée) : 8/8
  verts — préparation idempotente, aucun double claim concurrent, bail expiré récupérable après
  crash simulé, reconstruction complète vendeur/acheteur/lignes (facture ET avoir), transitions
  `submitted`/`retryable`/`failed` protégées par l'état attendu, `unknownOutcome` jamais reprise
  automatiquement, événements idempotents `(provider, provider_event_id)`, curseur strictement
  croissant.
- `test/invoices/issue-order-invoices.integration.test.ts` (existant) : 8/8 verts, non-régression
  confirmée.
- `test/invoices/superpdp-mapping.test.ts` : 12/12 verts (7 existants + 5 nouveaux sur `euro()`).
- `test/invoices` complet : 34/37 (3 `skip` = test sandbox réseau réel, hors périmètre hors-ligne).
- **Bug de course trouvé et corrigé pendant cette tranche** : les deux fichiers d'intégration
  `modules/invoices` tournent en parallèle (vitest) sur la même base isolée et se disputaient les
  mêmes tables append-only (`TRUNCATE` concurrent d'un fichier effaçant les données de l'autre en
  plein test) — corrigé par un verrou consultatif partagé (`test/support/invoice-tables-lock.ts`,
  même mécanique que `settlement-singleton-lock.ts`), reproduit deux fois sans flakiness après
  correction.
- `npm run typecheck -w apps/api` : vert. `npm run lint -w apps/api` : vert.
- `npm run test -w apps/api -- test/http` (126 tests, app.ts modifié) : vert, aucune régression.

### 12.9 check:boundaries

2 violations `no-circular` détectées (`merchants/application/account-contact.ts` ↔
`merchants/ports/merchant-repository.ts`, `drivers/application/legal-information.ts` ↔
`drivers/ports/driver-repository.ts`) — **préexistantes, de l'Étape 3, aucun fichier de cette
tranche n'y figure** : zéro régression de boundaries introduite par la Tranche 1.

### 12.10 Questions produit restantes

Aucune nouvelle par rapport à §11.J (préexistantes, non traitées ici, pas nécessaires à cette
tranche).

### 12.11 Questions juridiques rencontrées

Aucune nouvelle. N'a pas bloqué le développement (aucune ne l'exigeait techniquement).

### 12.12 Confirmation

**TRANCHE 1 DONE.** Tous les critères de définition de fini (§11.G) sont satisfaits : soumissions
réellement persistées et idempotentes, modèle compatible avec un futur worker sans refonte,
événements conservés sans perte, réservation sans double traitement, crash non bloquant (bail
récupérable), adresse électronique vendeur disponible au mapping, tests ciblés verts, typecheck/
lint verts, aucune régression de boundaries. Rien branché au-delà du périmètre autorisé (pas
d'appel Super PDP automatique, pas de polling réel, pas d'annuaire, pas de mandat mobile, pas de
Factur-X UI, pas de validation avoir) — conforme à la consigne. Tranche 2 non commencée.

## 13. Étape 5 — Tranche 2 : soumission + polling réellement branchés — **DONE (2026-09-23)**

Répartition respectée (correction explicite de l'utilisateur après la Tranche 1) : Claude a rédigé le
brief de délégation, Codex a implémenté tout le backend TypeScript (aucune migration, aucun SQL touché),
Claude a relu, corrigé un bug réel, revérifié typecheck/lint/boundaries et rejoué les tests plusieurs
fois avant de documenter.

### 13.1 Modèle d'erreurs provider

`SuperPdpEInvoiceProvider.submitInvoice` classe désormais chaque échec (`ports/einvoice-provider.ts`) :

- `EInvoiceNetworkBeforeSendError` : DNS/refus de connexion (`ENOTFOUND`/`ECONNREFUSED` avant l'envoi),
  429, tout 5xx, échec OAuth ou échec de la conversion `to=cii` — situations où Super PDP n'a certainement
  reçu aucune facture. Reprise automatique possible.
- `EInvoiceUnknownOutcomeError` : timeout (`AbortController`, 20 s) ou coupure réseau survenant PENDANT ou
  après l'envoi du `POST /v1.beta/invoices` — Super PDP a peut-être déjà reçu la facture, aucune certitude.
  Jamais retentée automatiquement (idempotence non prouvée par l'API — cf. ADR 0007).
- Toute autre erreur (4xx déterministe, ex. 422 Schematron) : erreur générique, non retentable
  automatiquement, marque la soumission `failed`.

### 13.2 Politique retry/backoff

`retryAt(attempts, now)` (exporté, `run-einvoice-submissions.ts`) : 1 min → 2 min → 4 min → ... doublement,
plafonné à 6 h, SANS plafond de nombre d'essais (aucun `dead_letter` dans cette tranche — hors périmètre,
non demandé). Seules les soumissions `EInvoiceNetworkBeforeSendError` sont replanifiées ainsi
(`retryable`) ; `unknown_outcome` en est exclu de `claimDue`.

### 13.3 Traitement `unknown_outcome`

Un `EInvoiceUnknownOutcomeError` pose `submission_status = 'unknown_outcome'` SANS `next_attempt_at` :
`claimDue` (Tranche 1) ne la reprend jamais seule. Aucune résolution automatique construite dans cette
tranche (pas de recherche par `external_id` documentée côté Super PDP) — nécessite une intervention
humaine future, conforme à l'ADR 0007 et à la consigne de ne rien inventer.

### 13.4 Worker de soumission

`startEInvoiceSubmissionWorker` (`infrastructure/einvoice-workers.ts`) : boucle non chevauchante (même
patron que `outbox-relay.ts`), cadence `SUPERPDP_SUBMISSION_INTERVAL_SECONDS` (défaut 30 s), arrêt propre
via `onClose`. Chaque cycle : `claimDue` (bail `FOR UPDATE SKIP LOCKED`, Tranche 1) → conversion `to=cii`
→ `submitInvoice` → `submitted`/`retryable`/`failed`/`unknownOutcome` selon la classification ci-dessus.
Garde `DriverEInvoiceReadiness` appliquée avant tout envoi d'une facture ISSUE d'un livreur (jamais pour
Locadely) — bloque uniquement la transmission, jamais la course ni l'émission interne (ADR 0007 §2).

### 13.5 Worker de polling

`startEInvoicePollingWorker` : cadence `SUPERPDP_POLL_INTERVAL_SECONDS` (défaut 300 s), arrêt propre.
`PollEInvoiceEventsUseCase.execute` consomme TOUTES les pages tant que `hasAfter` est vrai, avec garde
contre une pagination qui ne ferait pas avancer le curseur (boucle infinie impossible). Curseur par
provider (`einvoice_provider_event_cursors`, singleton, Tranche 1), jamais régressif.

### 13.6 Projection des événements

`projectSubmissionStatus` (déjà écrite en Tranche 1, câblée en production ici) recalcule le statut à
partir de TOUS les événements persistés d'une soumission (`einvoice_events`, insensible à l'ordre
d'arrivée et aux doublons) : `api:accepted`/`fr:205`/`fr:209` → `accepted` ; `api:invalid`/`fr:501`/
`api:rejected`/`fr:210`/`fr:213` → `rejected` ; tout autre code connu → reste `submitted` ; code inconnu
conservé (jamais perdu) mais ignoré du calcul. `PostgresEInvoiceEventsRepository.applyProjectedStatus`
répercute une projection TERMINALE (`accepted`/`rejected`) dans `invoice_provider_submissions` PUIS dans
`invoices.transmission_status`/`credit_notes.transmission_status` (`confirmed`/`rejected`), dans la même
méthode.

**Bug trouvé et corrigé par Claude en review** : la première version de `applyProjectedStatus` relisait
la projection sans figer l'état terminal, ce qui permettait à un événement tardif/rejoué de faire
basculer une soumission déjà `accepted` vers `rejected` (ou l'inverse) — en contradiction avec l'ADR 0007
(document immuable une fois transmis). Corrigé : la mise à jour n'a désormais d'effet que depuis
`submission_status = 'submitted'` (`UPDATE ... WHERE submission_status = 'submitted'`, `rowCount = 0` =
no-op) — un état terminal ne redevient jamais un autre état terminal. Verrouillé par un nouveau test
Codex qui rejoue un événement contraire après la première projection terminale et vérifie l'absence de
changement.

### 13.7 Wiring app.ts / composition root

`app.ts` (`createInvoicesModule` déjà en place depuis la Tranche 1) construit désormais, SEULEMENT si
`SUPERPDP_ENABLED=true` ET les deux secrets présents : `SuperPdpEInvoiceProvider` (avec son
`SuperPdpOAuthClient`), puis les deux workers. Sans ces conditions, aucun provider ni worker n'est
instancié — `SuperPdpProvider === null` court-circuite les deux `startEInvoice*Worker` (fonctions
no-op retournées à la place). `PostgresDriverEInvoiceReadinessReader` (nouveau, Tranche 2) injecté dans
`DriverEInvoiceReadiness` uniquement pour le worker de soumission. Aucun import direct hors `public.ts`
du module invoices. `SUPERPDP_SUBMISSION_INTERVAL_SECONDS` ajoutée à `platform/config.ts` (défaut 30).

### 13.8 Tests exécutés et résultats

- `test/invoices/superpdp-einvoice-provider.test.ts` (nouveau) : classification d'erreurs par fake
  `fetch` — 429/500/503 → `EInvoiceNetworkBeforeSendError`, 422 → erreur générique, `ENOTFOUND` →
  retryable, `AbortError` → `EInvoiceUnknownOutcomeError`. Vert.
- `test/invoices/einvoice-composition.test.ts` (nouveau) : `buildApp()` réussit avec `SUPERPDP_ENABLED=
  false`, aucun worker construit. Vert.
- `test/invoices/einvoice-work-repository.integration.test.ts` (étendu, base isolée) : + 1 test sur la
  non-régression terminal→terminal ci-dessus. 9/9 verts, deux exécutions consécutives sans flakiness.
- `test/invoices/superpdp-mapping.test.ts` : couverture `projectSubmissionStatus` mise à jour, verte.
- `test/invoices` complet (base isolée `invoices_r47`, deux exécutions) : 45 passed | 3 skipped (48),
  stable, incluant le test du bug terminal ci-dessus.
- `npm run typecheck -w apps/api` : vert.
- `npm run lint -w apps/api` : vert.
- `npm run test -w apps/api -- test/http` : exécuté 3 fois. Un premier passage a montré 3 failed | 94
  passed | 29 skipped (126), anomalie par rapport à la référence connue (126/126, 0 skip) ; les deux
  passages suivants sont revenus propres (126 passed (126), 15 fichiers). Aucune trace d'un test précis
  en échec n'a pu être capturée (grep sur le run suivant vide). Diagnostic retenu : instabilité
  environnementale, pas une régression du code — deux serveurs de dev tournaient déjà en tâche de fond
  sur la base PostgreSQL partagée (`npm run dev` ×2, PID observés) pendant que la base jetable
  `invoices_r47` venait d'être supprimée (`docs/work/r47-testdb.sh drop`), un schéma de contention déjà
  connu cette session pour `test/realtime/outbox-worker.test.ts`. Aucun fichier de cette tranche ne
  touche `test/http` directement (seul `app.ts`, déjà couvert par `einvoice-composition.test.ts`) et le
  passage anormal n'a pas pu être reproduit une seule fois de plus sur 2 tentatives supplémentaires :
  retenu comme flaky, pas comme régression, mais signalé explicitement plutôt que passé sous silence.

### 13.9 check:boundaries

Mêmes 2 violations `no-circular` préexistantes qu'en Tranche 1 (`merchants`, `drivers`) — aucun fichier
de cette tranche impliqué. Zéro régression de boundaries.

### 13.10 Questions produit restantes

Aucune nouvelle par rapport à §11.J.

### 13.11 Questions juridiques rencontrées

Aucune nouvelle. N'a pas bloqué le développement.

### 13.12 Blocages / points d'attention

- L'anomalie `test/http` (§13.8) reste non reproduite une seconde fois malgré deux tentatives
  supplémentaires : traitée comme un flake connu, à surveiller si elle réapparaît de façon répétée dans
  une tranche future.
- `unknown_outcome` reste sans mécanisme de résolution (recherche par `external_id` non documentée côté
  Super PDP) — situation assumée, conforme à l'ADR 0007, pas un oubli.

### 13.13 Confirmation

**TRANCHE 2 DONE.** Tous les critères de la définition de fini sont satisfaits : soumission réelle
branchée sur la persistance Tranche 1, erreurs provider typées et classées (A/B/C/D), politique de
retry/backoff appliquée, `unknown_outcome` jamais retenté seul, polling réel avec pagination complète et
garde anti-boucle, projection cumulative des événements insensible à l'ordre/doublons, un bug de
régression terminal→terminal trouvé et corrigé avant livraison, wiring `app.ts` minimal et conditionné
par la configuration, tests ciblés verts (provider, composition, intégration, mapping), typecheck/lint
verts, aucune régression de boundaries, répartition Claude/Codex respectée. Rien branché au-delà du
périmètre autorisé (pas d'annuaire acheteur, pas de mandat backend/mobile, pas de Factur-X UI, pas
d'avoir sandbox). Tranche 3 non commencée.

## 14. Étape 5 — Tranche 3 : annuaire électronique français + éligibilité de transmission — **DONE (2026-09-24)**

Répartition respectée : Claude a écrit et testé seul la migration SQL (fresh-install + upgrade-path
sur `invoices_r47`), a construit l'écran « Mon Compte » (web), a rédigé le brief de délégation, a
relu/corrigé/complété les tests DB de Codex (dont Codex ne peut pas exécuter — sandbox sans accès
Postgres) et a revérifié typecheck/lint/boundaries/tests avant de documenter. Codex a implémenté tout
le backend TypeScript (domaine, ports, infrastructure, application, wiring `app.ts`, module
`merchants`), sans toucher SQL/web/mobile, sans commencer la Tranche 4.

### 14.1 Architecture retenue

- `domain/directory-selection.ts` (pur) : `selectBuyerDirectoryEntry(entries)` — 0 entrée active
  → `not_addressable` ; ≥ 2 actives → `ambiguous` (aucune règle de priorité dans le schéma Super PDP
  réel, jamais un choix arbitraire) ; exactement 1 active → coupe son `identifier` (`"scheme:value"`)
  sur le premier `:` pour obtenir `{scheme, value}`, ou `ambiguous` si aucun `:` (identifiant
  inexploitable, jamais deviné).
- `domain/transmission-readiness.ts` (pur) : `canSubmitElectronicInvoice(...)` — ordre de décision :
  identité vendeur (toujours vraie aujourd'hui par construction, gardée pour le futur) → mandat
  livreur (uniquement `issuerKind==='driver'`) → adresse acheteur (`ready`/`ambiguous`/sinon
  `waiting_for_recipient_address`). Résultat structuré à 5 valeurs, jamais un booléen.
- `ports/french-directory-provider.ts` + `infrastructure/superpdp-french-directory-provider.ts` :
  `GET /v1.beta/french_directory/entries?number=<SIREN>` (jamais le SIRET — confirmé littéralement
  par la description du paramètre dans la spec réelle). Erreur générique en cas d'échec (pas la
  taxonomie A/B/C/D de la Tranche 2 : cet appel n'est jamais dans le chemin chaud de soumission).
- `ports/einvoice-directory-cache.ts` + `infrastructure/postgres-einvoice-directory-cache-repository.ts` :
  lecture/écriture de `merchant_einvoice_directory_cache` (upsert), reconstruction stricte de
  `DirectoryResolution` (une ligne `ready` sans adresse persistée fait lever une erreur plutôt que de
  mentir silencieusement).
- `application/resolve-buyer-electronic-address.ts` : `RefreshBuyerElectronicAddressUseCase`
  implémente `BuyerElectronicAddressResolver`. `resolve()` = lit le cache, sert le résultat si le
  SIREN correspond et a moins de 24 h ; sinon délègue à `refresh()`, qui appelle TOUJOURS l'annuaire,
  persiste le résultat (y compris `lookup_failed` sur exception) et le retourne — jamais d'exception
  qui remonte à l'appelant.
- `run-einvoice-submissions.ts` : le worker n'a plus de `if` dispersés — il calcule `driverMandateVerified`
  et `buyerDirectory` (une seule résolution par item, jamais deux) puis appelle
  `canSubmitElectronicInvoice(...)` ; tout statut non `ready` → `retryable` avec `not_ready:<statut>`
  (même backoff `retryAt`, remplace l'ancien `continue` muet du mandat livreur ET l'ancienne branche
  ad hoc de l'adresse acheteur par un seul mécanisme explicite et diagnostiquable).

### 14.2 Identifiant utilisé pour interroger l'annuaire

Toujours le SIREN (9 chiffres), jamais le SIRET — confirmé par la spec Super PDP réelle
(`number`: "Registration number (SIREN) of the company"). Le restaurant continue de saisir un SIRET
dans « Mon Compte » (Étape 3) ; c'est le SIREN déjà dérivé côté serveur (`merchant_legal_information.siren`)
qui est transmis à l'annuaire.

### 14.3 Règle de sélection d'adresse

Une seule entrée active dans la réponse → sélection automatique de son identifiant. Zéro ou plusieurs
entrées actives → jamais de sélection automatique (`not_addressable`/`ambiguous`), jamais une facture
bloquée silencieusement : la soumission reste `retryable` avec une raison explicite, reprise
automatiquement dès que l'annuaire redevient cohérent (une seule entrée active) à la prochaine
résolution.

### 14.4 Cas multiples/absents

Traités uniquement dans `selectBuyerDirectoryEntry` (voir §14.1) — aucune autre couche ne réinterprète
ces cas. Un restaurant non adressable ou ambigu peut être facturé en interne normalement (Étape 4
inchangée) ; seule sa transmission Super PDP reste en attente.

### 14.5 Référence acheteur / code de routage (buyer_reference)

Concept EN16931 BT-10, **séparé** de l'adresse électronique (BT-49) — jamais fusionné en code, en
nom de colonne ni en copie UI. Colonne `merchant_legal_information.buyer_reference` (migration `0050`,
nullable, texte libre, non vide si renseigné). Exposé en lecture/écriture par
`GET/PATCH /api/v1/merchants/me/legal-information` (`buyerReference` dans le corps et la réponse),
jamais requis par `isMerchantLegalInformationComplete`. Champ « Mon Compte » optionnel avec l'aide
« À renseigner uniquement si votre plateforme de facturation ou votre service comptable vous a fourni
une référence spécifique. » — non mappé dans `en16931-mapper.ts` dans cette tranche (le mapper reste
inchangé ; le câblage du champ BT-10 dans la facture EN16931 elle-même est un complément mineur laissé
pour une tranche ultérieure si le besoin se confirme, non bloquant pour la Tranche 3).

### 14.6 Readiness

`canSubmitElectronicInvoice` (§14.1) — résultat à 5 états, consommé exclusivement par le worker de
soumission (jamais par la création de commande, jamais par l'émission interne Étape 4).

### 14.7 Intégration worker

`RunEInvoiceSubmissionsUseCase` prend désormais un `BuyerElectronicAddressResolver` en paramètre
constructeur (avant `electronicAddressScheme`). Câblé dans `app.ts` uniquement si Super PDP est activé
avec ses deux secrets (même garde que la Tranche 2, étendue à `buyerDirectoryResolver !== null`).

### 14.8 Modifications Mon Compte (web, Claude)

`apps/web/app/merchant/account/page.tsx`, section « Informations légales et facturation » :
- Message de statut sans jargon sous le champ SIRET : « Facturation électronique disponible »
  (vert/primaire) si `electronicInvoicingStatus === 'available'`, « Votre entreprise n'est pas encore
  adressable pour la facturation électronique. » si `'unavailable'`, rien affiché si `'unknown'`
  (avant toute résolution).
- Nouveau champ « Référence acheteur / code de routage de facturation électronique (optionnel) » avec
  l'aide utilisateur ci-dessus, juste avant le bouton d'enregistrement.
- `electronicInvoicingStatus` est désormais un champ de premier niveau de la réponse (à côté de
  `legalInformation`/`merchantLegalInformationCompleted`), présent même quand `legalInformation` est
  `null`.
- `npm run typecheck -w apps/web` et `npm run lint -w apps/web` verts (mêmes 3 warnings préexistants
  sans rapport, `no-img-element`/`exhaustive-deps`). Aucun framework de test frontend dans ce dépôt :
  vérification par typecheck/lint + relecture, conforme à la convention déjà établie du dossier.

### 14.9 Migration SQL

`supabase/migrations/0050_einvoice_buyer_directory.sql` (Claude, testée fresh-install + upgrade-path
sur `invoices_r47` avant délégation à Codex) :
- `merchant_legal_information.buyer_reference` (texte nullable, CHECK non vide si renseigné).
- `merchant_einvoice_directory_cache` (cache de transmission, PAS une donnée légale, PAS append-only —
  upsertable) : `merchant_id` (PK), `siren`, `resolution_status`
  (`ready`/`not_addressable`/`ambiguous`/`lookup_failed`), `electronic_address_scheme`/`_value`
  (nullable), `active_entry_count`, `checked_at`, `updated_at`. CHECK : `ready` ⇔ adresse non nulle.

### 14.10 Tests + résultats

- Purs (aucune base) : `directory-selection.test.ts`, `transmission-readiness.test.ts`,
  `resolve-buyer-electronic-address.test.ts`, `einvoice-workers.test.ts` (étendu : mandat livreur non
  vérifié → `retryable`/`not_ready:waiting_for_mandate`, adresse non résolue → une seule résolution
  par item, aucun envoi), `merchants/legal-information.test.ts` (étendu : déclenchement exactement une
  fois par sauvegarde réussie, aucun déclenchement avant validation/échec SIRET, `buyerReference`
  undefined-conserve/valeur-remplace/`null`-efface) — **28/28 verts** (5 fichiers).
- Intégration base isolée (`invoices_r47`, `docs/work/r47-testdb.sh`, exécutées et vérifiées par Claude
  — Codex n'a pas accès à Postgres dans son sandbox) : `einvoice-work-repository.integration.test.ts`
  étendu par Claude après revue (Codex avait laissé deux trous signalés honnêtement dans son propre
  compte-rendu) — `buyerMerchantId` vérifié aussi pour un AVOIR (pas seulement une facture, cas non
  couvert par Codex), et `getElectronicInvoicingStatus` vérifié en aller-retour réel contre la table
  (`unknown` sans ligne → `unavailable` après `not_addressable` → `available` après `ready`) — **11/11
  verts**, deux exécutions consécutives sans flakiness. `npm run test -w apps/api -- test/invoices
  test/merchants` complet : **94 passed | 3 skipped (97)**, stable sur deux runs.
- Régression large : `npm run test -w apps/api -- test/http` (`app.ts`/routes merchants modifiés) :
  **126/126 verts**, aucune régression.
- `npm run typecheck -w apps/api` et `-w apps/web` : verts. `npm run lint -w apps/api` et `-w apps/web` :
  verts (warnings préexistants sans rapport uniquement).

### 14.11 check:boundaries

Mêmes 2 violations `no-circular` préexistantes (`merchants`/`drivers`) — aucun fichier de cette tranche
impliqué. Zéro régression de boundaries.

### 14.12 Questions restantes

- Produit : le mapping du BT-10 (`buyer_reference`) dans la facture EN16931 elle-même n'est pas encore
  câblé dans `en16931-mapper.ts` (la donnée est collectée et persistée, mais pas encore transmise dans
  le document envoyé à Super PDP) — signalé, non bloquant, à trancher/planifier avant la Tranche 6
  (validation sandbox) si le besoin se confirme pour un restaurant réel.
- Aucune question juridique nouvelle. Aucun blocage externe : la spec French Directory réelle a
  répondu à toutes les questions ouvertes en §11 (identifiant SIREN, absence de champ de priorité
  entre entrées actives — la supposition antérieure d'un champ `is_replyto` en §9.O était erronée,
  corrigée ici : le schéma réel `french_directory_entry` n'a que `company`/`identifier`/`is_active`).

### 14.13 Confirmation

**TRANCHE 3 DONE.** Tous les critères de la définition de fini (§11 brief) sont satisfaits : annuaire
interrogeable via un port dédié, adresse acheteur résolue avec règle déterministe et cas
ambigus/absents jamais devinés, `buyer_reference` prévu et séparé de l'adresse électronique, readiness
centrale à 5 états expliquant toujours le blocage, worker soumettant uniquement les documents
éligibles sans forêt de `if`, facturation interne jamais affectée par l'annuaire, reprise automatique
dès que les conditions deviennent vraies (cache à 24 h + résolution avant chaque tentative), « Mon
Compte » affiche un statut compréhensible, tests ciblés + intégration verts, typecheck/lint verts,
aucune régression de boundaries. Tranche 4 non commencée.

## 15. Étape 5 — Tranche 4 : mandat livreur — ANALYSE + PLAN CONSOLIDÉ (2026-09-24, AUCUN CODE)

Analyse indépendante Claude (frontend/UX/architecture globale) + Codex (backend, `codex resume
01a0d067-be3d-79e0-b637-4afc33061a21`), consolidée et vérifiée ligne à ligne par Claude directement
contre le vrai dépôt (migrations, ports, adaptateurs, tests existants). **Aucune divergence trouvée
entre les deux analyses** — Codex a livré une analyse solide, chaque affirmation factuelle vérifiée
(numéros de colonnes, contraintes, requête SQL exacte du lecteur de readiness, absence de toute
écriture sur `revoked_at`/`revocation_reason`, pattern `pricing_settings`) s'est révélée exacte. Ce
paragraphe REMPLACE, pour le mandat, l'ancienne Tranche 4 (backend seul) et la partie mandat mobile
de l'ancienne Tranche 5 du plan initial (§11.G) — la partie restante de l'ancienne Tranche 5
(Factur-X téléchargeable) devient une Tranche 5 révisée, traitée après celle-ci. **Aucun code, aucune
migration créée dans cette tâche — analyse et plan uniquement, validation utilisateur requise avant
implémentation.**

### 15.1 État actuel réel (vérifié dans le vrai dépôt)

- `driver_einvoice_mandates` (migration `0048`) existe déjà : ensemble immuable (`id`, `driver_id`,
  `grantor_siren`, `grantor_legal_name_snapshot`, `mandate_template_version`, `mandate_text_hash`,
  `accepted_at`, `acceptance_method` — CHECK limité à `'mobile_checkbox'` aujourd'hui —,
  `acceptance_evidence jsonb` (vide, jamais rempli), `signed_pdf_storage_path`, `signed_pdf_sha256`)
  et ensemble mutable de suivi fournisseur (`provider`, `provider_mandate_id`,
  `provider_verification_status` déjà `not_submitted|submitted|not_verified|verified|rejected`,
  `submitted_at`, `verified_at`, `last_checked_at`, `last_error`, `revoked_at`, `revocation_reason`).
  Trigger `guard_driver_einvoice_mandate_immutable` déjà posé. Index unique « un seul mandat courant
  non révoqué par livreur ».
  **Snapshot légal INCOMPLET** : seuls SIREN + nom sont figés, jamais SIRET/adresse/TVA/forme
  juridique — insuffisant pour représenter fidèlement `driver_legal_information` (migration `0046` :
  `professional_name`, `siret`, `siren`, adresse légale structurée, `vat_number`, `vat_regime`,
  `legal_form`) au moment de la signature.
- `EInvoiceMandateProvider` (`ports/einvoice-mandate-provider.ts`) + `SuperPdpEInvoiceMandateProvider`
  (`infrastructure/superpdp-einvoice-mandate-provider.ts`) existent déjà et sont **validés en sandbox
  réel** (§10.6) : `createMandate`/`getMandate`/`downloadMandate`, multipart `object`
  (`Content-Type: application/json` explicite) + `pdf`, `grantorNumberScheme` optionnel. **Aucune
  classification d'erreur typée aujourd'hui** — toute erreur HTTP devient une `Error` générique
  (`superpdp-einvoice-mandate-provider.ts`, méthode `parse`) : à corriger en Tranche 4b avec la même
  taxonomie que `ports/einvoice-provider.ts` (`EInvoiceNetworkBeforeSendError`/
  `EInvoiceUnknownOutcomeError`), pas une nouvelle taxonomie dédiée.
- `PostgresDriverEInvoiceReadinessReader.hasVerifiedMandate` (déjà câblé dans le worker de soumission
  de factures Tranche 2/3) lit exactement `revoked_at is null and provider_verification_status =
  'verified'` — **ne nécessite AUCUNE modification** pour cette tranche : dès qu'un mandat passe
  `verified`, la transmission des factures livreur reprend automatiquement.
- Bucket Storage privé `einvoice-documents` créé et vérifié (upload/sign/delete testés), **totalement
  inutilisé par du code aujourd'hui**.
- Aucune librairie de génération PDF dans le dépôt (vérifié : aucune trace de `pdf-lib`/`pdfkit`/
  `react-pdf`/`puppeteer`/`jspdf` dans un `package.json`) — décision entièrement neuve pour cette
  tranche.
- Mobile : `react-native-signature-canvas` (5.1.1) **déjà installée et déjà utilisée en production**
  dans `apps/mobile/components/proof-signature.tsx` pour la signature de preuve de livraison (feature
  différente, sans rapport) — sortie `data:image/png;base64,...`, boutons Terrain Effacer/Valider,
  `onEmpty`/`onBegin` pour activer/désactiver le bouton. Envoi actuel au serveur en JSON simple
  (`{method:'signature', imageBase64}`, `apps/mobile/lib/api.ts` → `DeliveryProof`), jamais en
  multipart côté mobile — c'est le serveur qui décode le base64.
- `modules/documents` (générique, migration `0046`) : bucket `account-documents` **codé en dur**
  (`ports/document-storage.ts` → `ACCOUNT_DOCUMENTS_BUCKET`), `Owner`/`DocumentType` restreints à
  l'identité livreur/commerçant — **ne peut pas être réutilisé tel quel pour un mandat** (bucket et
  types différents). Son pattern (validation de signature binaire par octets magiques, URL signée
  300 s générée à la demande jamais persistée, chemin non devinable) reste la référence à reproduire,
  pas à importer.
- `pricing_settings` (migration `0040`) est le précédent exact de versionnement en base append-only
  (`rule_version` clé primaire, trigger interdisant `UPDATE`/`DELETE`) — bon modèle pour un futur
  `mandate_templates`.

### 15.2 Architecture cible

Nouveau contenu du module `modules/invoices/` (aucun nouveau module — le mandat reste un concept de
transmission facturation, cohérent avec ADR 0007) :

- `domain/mandate-acceptance.ts` (pur) : validation de la preuve d'acceptation, comparaison de dérive
  identité (snapshot du mandat vs `driver_legal_information` courant).
- `domain/mandate-template.ts` (pur) : invariants version/texte/hash.
- `ports/driver-einvoice-mandate-repository.ts`, `ports/mandate-template-repository.ts`,
  `ports/mandate-pdf-renderer.ts`, `ports/einvoice-mandate-storage.ts`.
- `application/accept-driver-einvoice-mandate.ts`, `application/get-driver-einvoice-mandate-status.ts`,
  `application/run-einvoice-mandate-submissions.ts`, `application/poll-einvoice-mandates.ts`.
- `infrastructure/postgres-driver-einvoice-mandate-repository.ts`,
  `infrastructure/postgres-mandate-template-repository.ts`,
  `infrastructure/pdf-lib-mandate-pdf-renderer.ts`, `infrastructure/supabase-einvoice-mandate-storage.ts`,
  extension d'`infrastructure/einvoice-workers.ts` (ou nouveau fichier jumeau) pour les deux nouveaux
  workers.
- `transport/http/mandate-routes.ts` : routes fines (`POST` acceptation, `GET` statut, `GET` URL
  signée du PDF) appelant uniquement les cas d'usage ci-dessus.
- `public.ts`/`app.ts` : wiring, exactement selon le patron déjà établi (construction conditionnée
  par `SUPERPDP_ENABLED` pour les workers, jamais pour la lecture de statut).

Mobile (`apps/mobile/`) :
- Nouvel écran unique `app/mandat/index.tsx` (mandat = parcours court, contrairement à `paiements/`
  qui a plusieurs sous-écrans à cause des composants Stripe embarqués) avec une machine à états
  interne (`'loading' | 'read' | 'signing' | 'submitting' | 'result'`), même style que
  `app/order/[id]/proof.tsx`.
- Nouveau composant `components/mandate-signature-pad.tsx` — **copie dédiée**, pas une réutilisation
  de `proof-signature.tsx` (textes/comportement différents, feature existante non touchée) — même
  technique `react-native-signature-canvas` déjà éprouvée (aucune nouvelle dépendance).
- Point d'entrée dans **Compte uniquement** (`app/(tabs)/compte/index.tsx` ou `mon-compte.tsx`),
  **jamais sur l'écran Carte** : contrairement à `PayoutBanner` (D-F, bloque le dispatch), le mandat
  ne bloque QUE la transmission Super PDP (ADR 0007 §2) — un bandeau sur Carte laisserait croire à
  tort que le livreur ne peut pas travailler. Statuts dérivés par une fonction pure dans `lib/`, même
  patron que `lib/payout-status.ts` → `derivePayoutUi`.
- Aucun travail web : le mandat ne concerne que l'app livreur (`apps/mobile`), jamais `apps/web`
  (commerçant/admin uniquement, racine `CLAUDE.md`). La mention « souris sur web si besoin » du brief
  est sans objet ici — `react-native-signature-canvas` fonctionnerait aussi à la souris si un jour un
  portail web livreur existait, mais aucun n'existe.

### 15.3 Parcours utilisateur exact

1. Le livreur ouvre « Mandat de facturation » depuis Compte.
2. `GET` unique (nouvelle route, regroupe statut + aperçu des données prérempies + texte du mandat en
   vigueur + drapeau de dérive) — évite 2-3 appels séparés côté mobile.
3. Écran `read` : texte du mandat, données personnelles/professionnelles préremplies en lecture seule
   (source `driver_legal_information`, jamais resaisies), case d'acceptation.
4. Bouton « Signer et accepter » → écran `signing` (zone de signature tactile, boutons Effacer/Valider,
   désactivé tant que le tracé est vide).
5. Confirmation → écran `submitting` (état intermédiaire court) → `POST` du PNG base64 (JSON simple,
   même convention que `DeliveryProof`, jamais de multipart côté mobile).
6. Backend : valide le PNG (octets magiques, même garde que `modules/documents`), snapshote l'identité
   légale courante, rend le PDF final (`pdf-lib`), le hash, l'upload dans `einvoice-documents`, insère
   la ligne immuable `driver_einvoice_mandates` — **dans une seule transaction locale**, aucun appel
   réseau Super PDP dans cette requête.
7. Écran `result` : « Mandat enregistré, envoi à Super PDP en cours ». Un worker séparé (jamais dans la
   requête) soumet ensuite le mandat ; un second worker interroge périodiquement son statut jusqu'à
   `verified`/`rejected`. Le mobile relit le statut à chaque retour sur l'écran (`useFocusEffect`,
   même patron que `paiements/index.tsx`), jamais un état optimiste local durable.

### 15.4 Données DB nécessaires (migration non créée, listée pour validation)

Sur `driver_einvoice_mandates` (colonnes immuables ajoutées, jamais dans une nouvelle table — ADR
0007 §7 : une seule table mandat) :
`grantor_name_snapshot`, `grantor_professional_name_snapshot`, `grantor_siret_snapshot`,
`grantor_legal_address_line1/2_snapshot`, `grantor_legal_address_postal_code_snapshot`,
`grantor_legal_address_city_snapshot`, `grantor_legal_address_country_code_snapshot`,
`grantor_vat_number_snapshot`, `grantor_vat_regime_snapshot`, `grantor_legal_form_snapshot`.
`acceptance_method` CHECK étendu avec `'mobile_drawn_signature'` (jamais retirer `'mobile_checkbox'`,
conservé pour compatibilité conceptuelle future). Colonnes mutables de travail pour le worker de
soumission (même patron que `invoice_provider_submissions`) : statut technique de soumission
(distinct de `provider_verification_status`, voir §15.9), `attempts`, `last_attempt_at`,
`next_attempt_at`, `locked_until`. Contrainte `unique (driver_id, signed_pdf_sha256)` (anti double
mandat pour un même PDF accepté) et `unique (provider, provider_mandate_id)` partielle (non nul).
Trigger d'immutabilité étendu à chaque nouvelle colonne snapshot.

Nouvelle table `mandate_templates` (append-only, même patron que `pricing_settings`) :
`version integer primary key`, `text`, `text_sha256`, `created_at`. Seule source de vérité du texte
et de la version du mandat — jamais un texte réécrit en dur dans le code TypeScript à chaque
modification.

`acceptance_evidence jsonb` (déjà présente) reçoit désormais un objet structuré et versionné (voir
Codex §1 ci-dessus pour la forme JSON exacte proposée : méthode, horodatage, identité du signataire,
version/hash du gabarit, texte de consentement exact, référence de la signature et du PDF avec leurs
hash) — jamais la simple image comme seule preuve (brief §2), conforme à l'architecture déjà décidée
en ADR 0007/plan §11.F.8 (« preuve d'acceptation modélisée comme un objet versionné/discriminé »).

### 15.5 Migration (à créer seulement après validation du plan)

Une seule migration `00XX_driver_einvoice_mandate_signing.sql` regroupant : colonnes snapshot,
extension `acceptance_method`, colonnes de travail worker, contraintes d'unicité, table
`mandate_templates`, extension du trigger d'immutabilité. Testée fresh-install + upgrade-path sur
`invoices_r47` avant toute implémentation, comme chaque migration précédente de ce chantier.

### 15.6 Format signature

PNG (base64 data URL côté mobile, décodé en `Buffer` côté serveur), via `react-native-signature-canvas`
déjà installée et déjà éprouvée en production sur une autre fonctionnalité de ce même dépôt — **zéro
nouvelle dépendance**, zéro SDK externe, zéro prestataire payant. Validation octets magiques PNG côté
serveur avant tout traitement (même garde que `modules/documents`), taille maximale raisonnable (même
ordre de grandeur que la limite documents, 10 Mio, largement suffisant pour un tracé de signature).

### 15.7 Génération PDF

`pdf-lib` (pur JavaScript, sans dépendance native, embarque texte + image PNG) — candidat recommandé
par les deux analyses, aucune alternative plus lourde (Puppeteer, service externe) justifiée pour un
document mono-page à gabarit fixe. Génération strictement côté serveur, jamais côté mobile/web.
Toutes les entrées (texte du gabarit figé par version, snapshot identité, image de signature,
horodatage d'acceptation, référence/numéro du mandat) sont fixées AVANT le rendu ; le hash SHA-256 est
calculé sur les octets finaux du PDF généré, jamais avant. Déterminisme à garantir par un test dédié
(mêmes entrées → même PDF byte-à-byte ou au moins même hash). Point de vigilance technique (pas un
risque bloquant) : `pdf-lib` est bas niveau, la mise en page/le retour à la ligne du texte du mandat
doivent être gérés explicitement par le code de rendu — un test doit vérifier l'absence de troncature
silencieuse plutôt que de la découvrir en production.

### 15.8 Stockage

Bucket privé `einvoice-documents` déjà créé/vérifié. Nouvel adaptateur DÉDIÉ dans `modules/invoices`
(pas de réutilisation directe de `modules/documents`, dont le bucket et les types `Owner`/`DocumentType`
sont spécifiques à l'identité) reproduisant le même patron : chemin non devinable
(`drivers/{driverId}/einvoice-mandates/{mandateId}/mandate.pdf` et `.../signature.png`, `mandateId`
généré serveur), validation par octets magiques, URL signée générée à la demande (jamais persistée).
Différence assumée avec `account_documents` : un mandat signé n'est **jamais remplacé ni supprimé** —
un nouveau mandat révoque l'ancien (mécanisme déjà en base), l'ancien PDF/signature restent
définitivement accessibles (traçabilité), contrairement au remplacement de document d'identité.

### 15.9 Provider Super PDP

Soumission via un **worker dédié séparé**, jamais dans la requête d'acceptation (même règle absolue
que pour les factures : aucun appel réseau externe dans une transaction, et ici même hors transaction
la soumission ne doit jamais bloquer la confirmation immédiate au livreur que son mandat est
enregistré). Idempotence : une ligne de travail par mandat, contrainte `unique(driver_id,
signed_pdf_sha256)` empêchant deux mandats pour un même PDF accepté, jamais un second `POST`
automatique après une issue ambiguë (`EInvoiceUnknownOutcomeError`, réutilisée depuis
`ports/einvoice-provider.ts` plutôt qu'une taxonomie dédiée au mandat — `superpdp-einvoice-mandate-
provider.ts` doit être corrigé pour classer ses erreurs au lieu de lever une `Error` générique
partout). Polling séparé (`getMandate`) une fois un `provider_mandate_id` connu, même patron non
chevauchant que `startEInvoicePollingWorker`, cadence initiale 5 minutes (alignée sur le polling
factures, ajustable séparément si besoin plus tard).

### 15.10 États métier — trois axes distincts, jamais fusionnés

1. **Acceptation** (dérivé) : aucun mandat courant → PDF/signature stockés (ligne insérée).
2. **Travail de soumission** (nouvelles colonnes mutables, vocabulaire aligné Tranche 2) :
   `prepared`/`submitting`/`retryable`/`unknown_outcome`/`failed`/`submitted`.
3. **Vérification fournisseur** (`provider_verification_status`, déjà en base, INCHANGÉ) :
   `not_submitted`/`submitted`/`not_verified`/`verified`/`rejected`.
`provider_verification_status` ne doit jamais recevoir un état technique de travail (`submitting`,
`retryable`) — ce sont deux dimensions séparées, comme soumission et vérification le sont déjà pour
les factures (Tranche 2).

### 15.11 Readiness

`DriverEInvoiceReadiness`/`PostgresDriverEInvoiceReadinessReader` **inchangés** — dès que le worker de
vérification pose `provider_verification_status = 'verified'`, la transmission des factures livreur
reprend automatiquement au cycle suivant du worker de soumission (Tranche 2/3), sans aucun câblage
supplémentaire. Rappel ADR 0007 §2 : un mandat non `verified` ne bloque JAMAIS l'acceptation de
courses ni l'émission interne des factures — uniquement leur transmission.

### 15.12 Changement d'identité après signature

Mécanisme technique proposé, **jamais une décision juridique automatisée** : `GetDriverEInvoiceMandate
StatusUseCase` compare à la volée le snapshot du mandat courant (une fois les colonnes ajoutées, §15.4)
aux données live de `driver_legal_information`, expose un drapeau dérivé `legalDataDrifted` (booléen)
et la liste des champs concrètement différents. **Jamais de révocation automatique** : `revoked_at`/
`revocation_reason` existent déjà en base mais ne sont écrits par aucun code aujourd'hui (vérifié,
grep exhaustif) — les laisser pilotés par une décision humaine future (produit/support), jamais par ce
mécanisme de détection. Le mobile affiche seulement un bandeau informatif secondaire si dérive
détectée, jamais un blocage.

### 15.13 Fichiers/modules concernés (résumé, détail §15.2)

Backend : ~14 nouveaux fichiers dans `modules/invoices/` (domain ×2, ports ×4, application ×4,
infrastructure ×4-5), plus modifications de `public.ts`, `app.ts`, `platform/config.ts`,
`superpdp-einvoice-mandate-provider.ts` (classification d'erreurs), routes d'enregistrement. Mobile :
`app/mandat/index.tsx` (nouveau), `components/mandate-signature-pad.tsx` (nouveau), `lib/mandate-
status.ts` (nouveau, dérivation d'état pure), `lib/api.ts` (nouvelles fonctions), point d'entrée dans
`app/(tabs)/compte/{index,mon-compte}.tsx`. Migration SQL : un seul nouveau fichier (§15.5).

### 15.14 Plan d'implémentation par sous-tranches (proposé, à valider)

- **Tranche 4a — Fondations backend** : migration, domain/ports, `pdf-lib` renderer, adaptateur
  Storage dédié, `AcceptDriverEInvoiceMandateUseCase` + repository (insertion transactionnelle),
  `GetDriverEInvoiceMandateStatusUseCase` (statut + dérive), routes (acceptation, statut, URL signée
  du PDF). **Pas de soumission Super PDP dans cette sous-tranche** — le mandat reste `prepared`.
- **Tranche 4b — Soumission + polling Super PDP** : classification d'erreurs sur
  `SuperPdpEInvoiceMandateProvider`, worker de soumission, worker de polling, câblage `app.ts`/config,
  conditionné par `SUPERPDP_ENABLED`.
- **Tranche 4c — Mobile** : écran « Mandat de facturation », composant de signature dédié, point
  d'entrée Compte, bandeau de dérive.
- **Tranche 4d (repoussée, fusion avec l'ancienne Tranche 6 §11.G)** : validation sandbox réelle de
  bout en bout (vrai PDF généré, vraie soumission, vrai `grantor_number_scheme=sandbox`, suivi jusqu'à
  un statut réel) — après 4a-4c, jamais avant.

### 15.15 Tests (ciblés, liste resserrée)

Backend : génération PDF déterministe + hash stable, intégration de la signature dans le PDF, exactitude
du snapshot légal (et son immutabilité), unicité anti-double-mandat, retry/idempotence du worker de
soumission (classes d'erreur), transitions de polling jusqu'à `verified`/`rejected` sans régression
terminale (même garde que la Tranche 2), détection de dérive identité sans révocation, contrôle
d'accès Storage (URL signée jamais persistée, chemin non devinable). Mobile : signature dessinée/reset/
validation vide, statuts affichés sans jargon, reprise après fermeture d'app. Sandbox (opt-in réseau
réel, Tranche 4d) : mandat réel bout en bout avec `grantor_number_scheme=sandbox`.

### 15.16 Risques

`pdf-lib` bas niveau — mise en page à tester explicitement (§15.7). Absence de confirmation, côté
Super PDP, d'une vraie valeur `rejected` pour un mandat (le port actuel ne modélise que `verified`/
`not_verified` dans ses tests réels — signalé, pas bloquant, la colonne DB accepte déjà `rejected` par
prudence). Toute soumission Super PDP doit rester hors transaction et jamais dans la requête mobile
(déjà respecté par construction dans le plan ci-dessus).

### 15.17 Questions restantes

**A. Décisions techniques tranchables sans l'utilisateur** : usage de `pdf-lib` ; table `mandate_templates`
append-only plutôt qu'une constante TypeScript ; adaptateur Storage dédié plutôt que réutilisation de
`modules/documents` ; réutilisation de la taxonomie d'erreurs Tranche 2 plutôt qu'une nouvelle ; dérive
identité en simple drapeau jamais auto-révoquant ; readiness inchangée ; écran mandat unique côté
mobile, entrée dans Compte uniquement (jamais Carte).

**B. Décisions produit nécessitant un choix utilisateur (ne bloquent pas le début du développement
technique)** : quels changements de données légales doivent réellement déclencher « un nouveau mandat
peut être requis » côté produit (vs. simple information) ; texte exact du mandat (v1) et sa mise en
page ; faut-il une interface support pour relancer un mandat en échec définitif (hors scope
initialement, comme pour les autres relances manuelles du chantier règlement) ; cadence de polling
dédiée ou alignée sur celle des factures.

**C. Questions juridiques à signaler, jamais bloquantes** : valeur probante d'une signature tactile
dessinée pour ce mandat précis (case à cocher vs signature avancée/qualifiée — déjà identifiée en
§11.J, toujours ouverte) ; texte/durée/révocation/préavis définitifs du mandat ; effet réel d'un
changement de donnée légale sur la validité d'un mandat déjà `verified`.

**Aucune de ces questions ne bloque le début de la Tranche 4a.**

### 15.18 Tranche 4a : fondations mandat livreur — **DONE (2026-09-24)**

Plan §15 validé explicitement par l'utilisateur, GO donné pour enchaîner 4a→4b→4c→4d dans l'ordre.
**4a terminée et vérifiée. 4b (soumission/polling Super PDP)/4c (mobile)/4d (validation sandbox réelle)
NE SONT PAS COMMENCÉES — l'utilisateur a explicitement demandé d'arrêter après 4a** ("on arrête après
4A"). Ne pas reprendre 4b sans nouvelle instruction explicite.

Fait par Claude (SQL/migration, review complète, tests finaux) :
- Migration `0051_driver_einvoice_mandate_signing.sql` : table `mandate_templates` (append-only, même
  patron que `pricing_settings`), colonnes de snapshot légal complet sur `driver_einvoice_mandates`
  (`grantor_name_snapshot`, `grantor_professional_name_snapshot`, `grantor_siret_snapshot`, adresse
  légale structurée, TVA, forme juridique), extension de `acceptance_method` à
  `'mobile_drawn_signature'`, contrainte `unique(driver_id, signed_pdf_sha256)`, extension du trigger
  d'immutabilité à chaque nouvelle colonne snapshot.
- **Bug de conception trouvé et corrigé avant tout usage** : la première version ajoutait ces colonnes
  en `CHECK` de complétude séparé plutôt qu'en `NOT NULL` direct, en pensant protéger les lignes déjà
  en base avec `NOT VALID` — vérifié empiriquement que Postgres réévalue un `CHECK` sur la ligne
  ENTIÈRE à chaque `UPDATE`, `NOT VALID` inclus : cela aurait rendu impossible toute mise à jour future
  des colonnes mutables (statut fournisseur) d'un mandat existant. Corrigé en `NOT NULL` direct,
  légitime ici car `driver_einvoice_mandates` est vérifiée à zéro ligne dans tous les environnements
  réels (aucun code n'a jamais écrit dedans avant cette tranche).
- Testée fresh-install + upgrade-path sur `invoices_r47`, plus des vérifications manuelles ciblées :
  mise à jour d'une colonne mutable sur une ligne neuve (réussit), immutabilité du snapshot (échoue),
  anti-doublon `unique(driver_id, signed_pdf_sha256)` après révocation (échoue), append-only de
  `mandate_templates` (échoue). Appliquée à la base de dev partagée (port 54322) avant la délégation à
  Codex — sans quoi son backend aurait échoué exactement comme lors de la Tranche 3.
- `pdf-lib` vérifiée (licence MIT, version 1.17.1, aucune dépendance native, aucune mention dépréciée),
  installée par Claude (le sandbox de Codex n'a pas d'accès DNS au registre npm, `EAI_AGAIN` — Codex
  a déclaré la dépendance dans `package.json` mais n'a pu ni l'installer ni exécuter le test du rendu
  PDF ; Claude l'a installée et exécuté ce test lui-même).

Livré par Codex (backend TypeScript, relu intégralement par Claude directement dans le vrai dépôt) :
domaine (`mandate-acceptance.ts` — preuve d'acceptation + détection de dérive légale pure,
`mandate-template.ts` — vérification d'intégrité du hash), ports (repository mandat, lecteur
identité légale livreur, lecteur identité légale Locadely, gabarit, rendu PDF, Storage), infrastructure
(`PostgresDriverEInvoiceMandateRepository`, `PostgresMandateTemplateRepository`,
`PostgresPlatformLegalIdentityReader` — requête de complétude identique, copiée à l'exact de
`postgres-invoice-repository.ts`, vérifié —, `PdfLibMandatePdfRenderer`,
`SupabaseEInvoiceMandateStorage` — convention `apikey`+`Authorization: Bearer` correctement reprise
sans qu'il soit besoin de le signaler), cas d'usage (`AcceptDriverEInvoiceMandateUseCase`,
`GetDriverEInvoiceMandateStatusUseCase`, `GetDriverEInvoiceMandatePdfUrlUseCase`), routes HTTP,
wiring `app.ts`/`public.ts` (aucune extension de `drivers/public.ts` nécessaire : `getLegalInformation`
y était déjà exposé).

**Vérifications effectuées par Claude** (toutes passées) :
- Lecture complète de chaque fichier créé/modifié, comparée précisément au brief.
- `npm run typecheck -w apps/api` : **1 vrai bug trouvé et corrigé** (`test/invoices/accept-driver-
  einvoice-mandate.test.ts` : un paramètre de fonction de test avec valeur par défaut voyait son type
  inféré sans `null`, rejetant un appel légitime `setup(null, null)` — annotation de type ajoutée).
  Vert ensuite.
- `npm run lint -w apps/api` : vert.
- `npm run check:boundaries` : 2 violations préexistantes seulement (`merchants`/`drivers`), aucune
  nouvelle.
- Tests purs/fakes (`mandate-acceptance`, `mandate-template`, `pdf-lib-mandate-pdf-renderer`,
  `accept-driver-einvoice-mandate`, `get-driver-einvoice-mandate-status`,
  `supabase-einvoice-mandate-storage`) : 7/7 verts, exécutés par Claude une fois `pdf-lib` installée.
- Déterminisme du rendu PDF **vérifié empiriquement** (pas seulement affirmé) : deux rendus de la même
  entrée produisent un SHA-256 identique ; un texte long déclenche bien une pagination automatique
  sans troncature.
- `driver-einvoice-mandate-repository.integration.test.ts` (base isolée `invoices_r47`) :
  **1 vrai bug trouvé et corrigé** — l'UUID de test du livreur comportait un caractère en trop
  (`dddddddd-dddd-dddd-dddd-ddddddddddddd9`, 14 caractères au lieu de 12 dans le dernier groupe),
  provoquant une erreur Postgres immédiate. Corrigé, puis **un second bug trouvé et corrigé** :
  `afterAll` tentait `DELETE FROM drivers` alors que la ligne de mandat associée reste immuable
  (`DELETE` toujours interdit par le trigger, y compris en test) — corrigé en `TRUNCATE
  driver_einvoice_mandates` avant la suppression du livreur (même patron que les autres tests de
  tables append-only de ce module). Stable sur 3 exécutions consécutives après correction.
- Suite complète `test/invoices` : 65 passed | 3 skipped (68), stable. Régression large
  `test/http test/drivers` (app.ts et usage de `drivers/public.ts` modifiés) : **143/143 verts**,
  aucune régression.
- `apps/api/package.json`/`package-lock.json` : `pdf-lib` correctement déclarée et verrouillée après
  installation par Claude.

**Décisions de portée confirmées telles que spécifiées** : aucun fichier PNG de signature séparé en
Storage (seul son SHA-256 dans `acceptance_evidence`, signature visuellement intégrée au PDF) ;
acceptation idempotente par construction (`findCurrent` en premier, retour tel quel si un mandat
existe déjà, aucun nouveau rendu/upload) ; aucun appel Super PDP dans cette sous-tranche
(`provider_verification_status` reste `not_submitted`) ; `mandate_templates` reste vide (aucune ligne
semée, le texte réel n'étant pas décidé — §15.17.B) — le code échoue proprement
(`MandateTemplateNotConfiguredError`, 503) plutôt que d'employer un texte fictif ; dérive d'identité
légale exposée en simple drapeau (`legalDataDrift`, jamais `false` quand aucun mandat n'existe encore),
jamais de révocation automatique.

**TRANCHE 4a DONE.**

### 15.19 Tranche 4b : soumission/polling Super PDP du mandat — **DONE (2026-09-24)**

Objectif : brancher le cycle backend complet mandat signé → soumission `company_mandates` →
`provider_mandate_id` → polling → `not_verified`→`verified` → readiness livreur mise à jour
automatiquement (déjà vraie sans changement, §15.11). Répartition tenue : Codex = backend
TypeScript (ports/repository/use cases/workers/classification d'erreurs), Claude = migration SQL,
review complète ligne à ligne, correction, tests finaux.

**Migration** `supabase/migrations/0052_driver_einvoice_mandate_submission.sql` (Claude) : sur
`driver_einvoice_mandates`, colonnes de travail du worker — **axe technique distinct**,
volontairement HORS du trigger d'immutabilité (0048/0051), de `provider_verification_status`
(axe fournisseur, inchangé) : `submission_status` (`prepared|submitting|submitted|retryable|
failed|unknown_outcome`), `attempts`/`last_attempt_at`/`next_attempt_at`/`locked_until` (même
patron bail/backoff qu'`invoice_provider_submissions`, 0049). Contrainte
`unique(provider, provider_mandate_id)` (NULL non conflictuel, aucun index partiel nécessaire).
Zéro ligne existante vérifiée avant migration (comme 0051) : les `default` ne masquent aucune
donnée réelle. Testée fresh-install (colonnes/défauts, mutation des colonnes de travail réussie,
mutation d'une colonne snapshot toujours refusée par le trigger existant, doublon
`(provider, provider_mandate_id)` rejeté) + upgrade-path (migration 0001→0051 avec seed, puis 0052
seule par-dessus, sans perte) sur bases jetables avant application à la base de dev partagée.
**Incident CLI trouvé, non causé par cette tranche** : `npx supabase migration up --local`
échoue sur cette base (rejoue 0047 en pensant qu'elle n'est pas appliquée) — l'historique
`supabase_migrations.schema_migrations` s'arrête à 0046 alors que 0047-0051 sont déjà réellement
appliquées au schéma réel (vérifié directement) ; désynchronisation préexistante, pas de
`migration up`, la migration 0052 a donc été appliquée par `psql` direct comme ses
prédécesseurs 0047-0051 l'ont visiblement été. À réconcilier un jour (hors scope ici), ne pas
supposer que `migration up` fonctionne sur cette base tant que ce n'est pas fait.

**Backend** (Codex, relu intégralement par Claude) :
- `ports/einvoice-mandate-work-repository.ts` (`EInvoiceMandateWorkRepository` +
  `EInvoiceMandateVerificationRepository`, deux interfaces séparées comme les deux axes qu'elles
  servent), `infrastructure/postgres-einvoice-mandate-work-repository.ts` (une seule classe
  implémentant les deux, `for update skip locked` identique au patron `PostgresEInvoiceWorkRepository`).
- `application/run-einvoice-mandate-submissions.ts` (`RunEInvoiceMandateSubmissionsUseCase`,
  réutilise `retryAt` exporté de la Tranche 2 factures, aucune seconde fonction de backoff) et
  `application/poll-einvoice-mandates.ts` (`PollEInvoiceMandatesUseCase`, une erreur sur un mandat
  n'interrompt jamais le traitement des suivants dans le même cycle).
- `infrastructure/superpdp-einvoice-mandate-provider.ts` : `createMandate` classe désormais ses
  échecs exactement comme `submitInvoice` (Tranche 2) — réseau avant envoi/429/5xx →
  `EInvoiceNetworkBeforeSendError` (retentable), abandon après envoi → `EInvoiceUnknownOutcomeError`
  (jamais retenté seul), 4xx déterministe → `Error` générique (`failed`). Réutilise les DEUX classes
  d'erreur de `ports/einvoice-provider.ts`, aucune taxonomie dédiée créée.
- `ports/einvoice-mandate-storage.ts`/`infrastructure/supabase-einvoice-mandate-storage.ts` :
  nouvelle méthode `downloadMandatePdf` (`GET` privé sur le bucket `einvoice-documents`, mêmes
  en-têtes service-role que l'upload) — le worker doit relire le PDF déjà stocké en 4a pour le
  soumettre.
- `infrastructure/einvoice-workers.ts` : `startEInvoiceMandateSubmissionWorker`/
  `startEInvoiceMandatePollingWorker`, même patron non chevauchant que les workers factures.
- `platform/config.ts` : `SUPERPDP_MANDATE_GRANTOR_NUMBER_SCHEME` (`'fr_siren'|'sandbox'`, défaut
  `fr_siren`) — le schéma n'est plus jamais implicite dans l'appel provider, conforme à la consigne
  « ne jamais hardcoder `fr_siren` ». `SUPERPDP_MANDATE_WORKER_ENABLED` (déjà présent depuis une
  tranche antérieure, jamais câblé) couvre maintenant les DEUX workers mandat (soumission+polling) —
  un seul flag, pas de flag séparé comme pour les factures (choix technique, non bloquant §15.17.A).
- `app.ts` : `SuperPdpEInvoiceMandateProvider` construit selon le même conditionnel que les deux
  autres providers Super PDP (activé + deux secrets présents) ; les deux workers mandat démarrés
  seulement si `SUPERPDP_MANDATE_WORKER_ENABLED && mandateProvider !== null`, cadence partagée avec
  les workers factures (`SUPERPDP_SUBMISSION_INTERVAL_SECONDS`/`SUPERPDP_POLL_INTERVAL_SECONDS`,
  décision Claude — la cadence dédiée était un point ouvert non bloquant §15.17.B, le partage évite
  deux nouvelles variables d'environnement) ; arrêt propre ajouté au `onClose` existant.
  `DriverEInvoiceReadiness`/`PostgresDriverEInvoiceReadinessReader` intégralement **inchangés** —
  vérifié, aucune ligne modifiée.

**Bug réel trouvé et corrigé par Claude en review** : Codex avait câblé
`grantorNumber: scheme === 'sandbox' ? grantorSiren : grantorSiret` — **le SIRET n'aurait jamais dû
apparaître ici**. Le schéma Super PDP nomme le champ `grantor_number_scheme` avec une valeur
littéralement `fr_siren`, et §7.2 de ce même document l'affirme explicitement : un mandat
`direction=out` identifie son grantor (le livreur) **« uniquement par son SIREN »** — jamais un
SIRET à 14 chiffres. Codex avait lui-même signalé ce point comme non vérifié indépendamment dans
son rapport plutôt que de l'affirmer à tort. Corrigé : `grantorNumber: item.grantorSiren` dans les
deux branches du schéma (le SIREN est le seul identifiant du grantor quel que soit le schéma ;
`sandbox` utilise un numéro de test dédié fourni par un futur appelant de test, jamais dérivé du
SIREN réel du livreur — non exercé par le chemin de production). Le champ `grantorSiret`, devenu
mort, a été retiré du port `MandateSubmissionWork`, de la requête SQL et du test associé plutôt que
laissé en champ mort.

**Vérifications effectuées par Claude** (aucune confiance dans le seul rapport Codex) :
- `npm run typecheck -w apps/api` : **3 vraies erreurs trouvées** (non détectées par le
  `typecheck` que Codex affirmait vert) — un test préexistant de la Tranche 4a
  (`accept-driver-einvoice-mandate.test.ts`) et deux nouveaux tests mandat utilisaient un fake
  `EInvoiceMandateStorage` incomplet (méthode `downloadMandatePdf` manquante, ajoutée à
  l'interface par cette même tranche) ; un fake `applyVerification` omettait le champ `id` du
  type réel. Corrigées, retesté vert indépendamment.
- `npm run lint -w apps/api` : vert. `npm run check:boundaries` : 2 violations préexistantes
  identiques (`merchants`/`drivers`), aucune nouvelle.
- Tests ciblés purs (`einvoice-mandate-workers.test.ts`, `superpdp-einvoice-mandate-provider.test.ts`,
  `accept-driver-einvoice-mandate.test.ts`) : 13/13 verts.
- Suite complète `test/invoices` contre une base jetable fraîche (migrations 0001→0052 + seed,
  `docs/work/r47-testdb.sh reset`, supprimée après) : 76 passés, 3 ignorés (sandbox opt-in),
  aucun échec.
- Non-régression large `test/http`/`test/drivers` (app.ts/config.ts/public.ts modifiés) contre la
  base de dev : **143/143 verts**, nombre identique à celui déjà vérifié après la Tranche 4a —
  aucune régression introduite.

**Hors-scope confirmé non touché** : aucun écran mobile (4c), aucune validation sandbox réseau
réelle du nouveau code (4d — le socle HTTP/multipart lui-même reste validé depuis §10.6, mais le
worker qui l'appelle n'a pas encore été exercé contre le vrai Super PDP), `DriverEInvoiceReadiness`,
routes HTTP du mandat, `AcceptDriverEInvoiceMandateUseCase`.

**TRANCHE 4b DONE.**

### 15.20 Tranche 4c : texte V1 réel + parcours mobile complet — **DONE (2026-09-24)**

Texte légal définitif du mandat V1 validé et fourni par l'utilisateur (14 placeholders
`{{...}}`), remplaçant le texte générique de 4a. Objectif : template inséré, mandat prérempli
sans ressaisie, écran mobile complet (lecture → consentement → signature manuscrite → statuts
lisibles), sans refaire 4a/4b. Répartition tenue : Claude = migration SQL + insertion du texte +
frontend mobile complet + review/tests, Codex = backend TypeScript (substitution, snapshot
civil, renderer réécrit, statut enrichi).

**Découverte structurante avant tout code** : le renderer PDF de 4a construisait SES PROPRES
sections « Bénéficiaire »/« Mandant » et ne faisait qu'insérer le texte du gabarit brut au
milieu — architecture incompatible avec un texte réel conçu comme un document complet avec ses
propres placeholders embarqués (identité, signature, référence). Le renderer a donc été
**réécrit** (substitution de placeholders dans le texte lui-même) plutôt que complété — décision
prise avant de commencer le backend, jamais découverte a posteriori.

**Migration** `0053_mandate_template_v1_and_grantor_name_snapshot.sql` (Claude) : deux
changements distincts dans un seul fichier (même patron que 0040/0051) —
1. `grantor_first_name_snapshot`/`grantor_last_name_snapshot` (`not null`, zéro ligne existante
   vérifiée avant migration comme 0051) : le prénom/nom CIVIL du livreur, distinct du nom du
   SIGNATAIRE déjà présent (`grantor_name_snapshot`, 0048) — le texte V1 les affiche séparément
   (bloc « Mandant » vs bloc « Signataire »). Trigger d'immutabilité étendu.
2. Texte V1 inséré une seule fois, jamais dupliqué en TypeScript : `insert ... select 1, t.body,
   encode(digest(t.body,'sha256'),'hex') from (values ($mandate$...$mandate$)) as t(body)` — le
   texte n'apparaît qu'UNE fois dans le fichier SQL, référencé deux fois via la CTE, le hash est
   calculé par Postgres lui-même à partir de la même valeur insérée (zéro risque de divergence
   texte/hash, zéro recalcul côté client). Vérifié après application : hash Postgres et hash
   `crypto.createHash('sha256')` Node du même texte identiques bit à bit (`17f4ba2e…`), longueur
   5673 caractères.
Testée fresh-install + upgrade-path (0001→0052 puis 0053 seule) sur bases jetables, immutabilité
et append-only revérifiées avec les deux nouvelles colonnes, appliquée à la base de dev partagée.

**14 placeholders** (`driver_first_name`, `driver_last_name`, `driver_legal_name`, `driver_siren`,
`driver_siret`, `driver_legal_address`, `driver_vat_number_or_not_applicable`,
`platform_legal_address`, `signer_first_name`, `signer_last_name`, `signed_at`, `mandate_version`,
`mandate_reference`, `handwritten_signature`) — Locadely (nom/SIREN du Mandataire) est du texte EN
DUR dans le gabarit, jamais un placeholder (seule son adresse l'est).

**Backend** (Codex, relu intégralement par Claude) :
- `domain/mandate-template.ts` : `substituteMandateTemplate(text, fields)` — remplacement global
  pur, placeholder non fourni laissé tel quel (jamais une exception).
- `ports/driver-profile-reader.ts` (nouveau, étroit) : `DriverProfileReader.findDriverProfile`
  — adapté dans `app.ts` depuis `drivers.findDriverById` (déjà exposé), jamais un nouvel accès
  direct à la table `drivers` depuis `modules/invoices`.
- `ports/mandate-pdf-renderer.ts`/`infrastructure/pdf-lib-mandate-pdf-renderer.ts` : nouvelle
  signature `{ templateText, fields, signatureImage, acceptedAt }` — le texte est coupé sur le
  marqueur littéral `{{handwritten_signature}}`, chaque moitié passe par
  `substituteMandateTemplate` puis le rendu existant (`wrapped()`, pagination automatique), la
  signature est dessinée entre les deux. Ancien titre/pied de page codés en dur supprimés (le
  texte réel les porte déjà). Déterminisme revérifié.
- `ports/driver-einvoice-mandate-repository.ts`/`infrastructure/postgres-driver-einvoice-mandate-
  repository.ts` : `firstNameSnapshot`/`lastNameSnapshot` sur le snapshot, `submissionStatus`/
  `lastError` (axe travail, 0052) désormais relus par `findCurrent()` — jamais exposés avant
  cette tranche.
- `application/accept-driver-einvoice-mandate.ts` : exige désormais aussi le profil civil
  (`DriverLegalInformationRequiredError` réutilisée, jamais une nouvelle erreur pour une nuance
  cosmétique) ; `complete`/`joinAddress` exportées et RÉUTILISÉES telles quelles par le cas
  d'usage de statut (Codex a choisi l'export plutôt que la duplication — meilleur que les deux
  options proposées, aucune divergence possible entre les deux vérifications de complétude).
- `application/get-driver-einvoice-mandate-status.ts` : `blockedReason` (4 causes explicites,
  jamais un booléen) et `previewText` — **jamais recalculé une fois le mandat signé**
  (`previewText: null` dès que `mandateExists`, quel que soit l'état de dérive légale : le seul
  document qui compte alors est le PDF réellement signé, jamais une reconstruction depuis des
  données live potentiellement différentes) ; avant signature, les 5 champs qui n'existent qu'à
  la signature (`signer_first_name/last_name`, `signed_at`, `mandate_reference`,
  `handwritten_signature`) sont remplacés par des espaces réservés explicites en français,
  jamais vides silencieusement.

**Bug réel trouvé et corrigé par Claude en review** (typecheck, pas seulement lu) :
`blockedReason` était assigné par une chaîne de ternaires sans annotation de type — TypeScript
élargit ce genre de chaîne en `string` plutôt que l'union littérale attendue, cassant la
compatibilité avec le type `MandateStatus` de la route HTTP (`tsc` a échoué malgré le rapport
Codex affirmant « typecheck passed »). Corrigé par une annotation explicite
`const blockedReason: MandateBlockedReason | null = ...` (type exporté depuis le cas d'usage).

**Second gap réel trouvé et corrigé par Claude** (pas un bug de Codex — un angle mort déjà présent
depuis la Tranche 4a, révélé par la contention accrue d'un fichier de test supplémentaire) :
`test/invoices/driver-einvoice-mandate-repository.integration.test.ts` n'avait pas
`vi.setConfig({ hookTimeout: 60_000 })` alors que TOUS les autres tests d'intégration
`modules/invoices` sérialisés par le même verrou consultatif (`lockInvoiceTables`) l'ont déjà,
précisément pour cette raison (voir `einvoice-work-repository.integration.test.ts`) — sans ce
correctif le `beforeAll` échouait au hasard (`Hook timed out in 10000ms`) selon la charge
concurrente des autres fichiers. Corrigé, stable sur deux exécutions consécutives ensuite.

**Rendu PDF vérifié visuellement** (pas seulement testé par hash) : script ponctuel exécutant le
vrai `PdfLibMandatePdfRenderer` avec le texte réel lu en base et des données plausibles, PDF
généré relu à l'œil — les 9 articles, l'identité Mandant/Mandataire, la référence, la version, la
signature et le texte de scellement final s'affichent tous correctement, aucune troncature,
aucun placeholder orphelin. Script supprimé après vérification (jamais commité).

**Frontend mobile** (Claude, aucun antécédent de test de composant React Native dans ce dépôt —
voir plus bas) :
- `lib/mandate-types.ts` (miroir strict de la réponse API), `lib/mandate-status.ts` →
  `deriveMandateUi` (pur, même patron que `derivePayoutUi`/`lib/payout-status.ts` : jamais de
  jargon `not_verified`/`provider_mandate_id` à l'écran, fail-closed sur un état non reconnu,
  bandeau de dérive légale toujours secondaire jamais bloquant, `unknown_outcome`/`failed` →
  « Action requise », aucun bouton de relance automatique — cohérent avec l'absence de tout
  mécanisme de relance manuelle construit pour l'instant, comme pour les autres relances de ce
  chantier).
- `components/mandate-signature-pad.tsx` (copie dédiée de `proof-signature.tsx`, texte/comportement
  propres, même lib déjà installée, zéro nouvelle dépendance), `components/MandateStatusCard.tsx`
  (même patron que `PayoutStatusCard`).
- `app/mandat/index.tsx` : machine à états locale (`loading|error|status|read|name|signing`) —
  jamais de source de vérité locale durable, `useFocusEffect` relit toujours le statut depuis le
  backend à l'entrée sur l'écran ; aucun appel Super PDP direct depuis le mobile (uniquement
  `getMandateStatus`/`acceptMandate`/`getMandatePdfUrl`) ; case de consentement au texte exact
  demandé, signature obligatoire avant activation du bouton, échec réseau après signature =
  toast + nouvel essai possible (le `POST` est idempotent côté serveur par construction, `findCurrent`
  en premier) ; aperçu = texte brut prérempli renvoyé par le backend (`previewText`), jamais
  reconstruit côté client à partir de fragments — garantit que ce qui est lu est exactement ce
  qui sera signé (même gabarit/version, résolu au moment de la signature réelle par le backend,
  jamais mis en cache côté mobile entre les deux).
- Point d'entrée : nouvelle carte « Mandat de facturation » dans `app/(tabs)/compte/index.tsx`
  (jamais sur Carte — ADR 0007 §2, le mandat ne bloque que la transmission, jamais le dispatch).
- `lib/open-external.ts` : `openMandatePdf` (même patron `Linking.openURL` navigateur système que
  les liens Stripe existants).

**Tests** :
- Backend : `test/invoices/{mandate-template,pdf-lib-mandate-pdf-renderer,get-driver-einvoice-
  mandate-status}.test.ts` (nouveaux/réécrits) + `accept-driver-einvoice-mandate.test.ts`/
  `mandate-acceptance.test.ts` (fixtures étendues) : 8/8 verts. Suite complète `test/invoices` sur
  base jetable fraîche 0001→0053 (avec le correctif `hookTimeout`) : **78 passés, 3 ignorés
  (sandbox opt-in), aucun échec**. Non-régression `test/http`/`test/drivers` : 143/143 (identique
  aux tranches précédentes ; un premier essai a montré 7 échecs de configuration `PGBOSS_
  DATABASE_URL` non reproductibles à la ré-exécution immédiate — confirmé comme un flake
  transitoire, pas une régression).
- Mobile : **aucune infrastructure de test de composant React Native n'existe dans ce dépôt**
  (zéro fichier de test avant cette tranche, aucun `jest`/`testing-library` en dépendance) — décision
  assumée de ne pas en créer une pour ce seul écran plutôt que d'improviser un premier précédent
  sans base. `vitest` ajouté (devDependency + `vitest.config.mts` + script `test`) UNIQUEMENT
  pour la logique pure sans dépendance React Native : `lib/mandate-status.test.ts`, 15 tests
  couvrant chaque état de `deriveMandateUi` (bloqué ×4, à signer, envoi en cours ×3, vérification
  en cours ×2, vérifié, refusé, action requise ×2, bandeau de dérive présent seulement après
  signature, jamais de chaîne technique dans un titre/description). **Non couvert par un test
  automatisé, documenté plutôt que caché** : dessin/effacement de la signature, ouverture/fermeture
  d'écran, reprise après fermeture d'app — comportement React Native jamais testé nulle part
  ailleurs dans ce dépôt ; vérifié uniquement par relecture attentive du code et par un rendu PDF
  réel de bout en bout (voir plus haut), pas par un harnais de test de composant.
- `npm run typecheck`/`lint` verts sur `apps/api` ET `apps/mobile`. `check:boundaries` : 2
  violations préexistantes identiques (`merchants`/`drivers`), aucune nouvelle.

**Incident local sans rapport avec le code** : les types de routes Expo Router générés
(`.expo/types/router.d.ts`, fichier gitignored, jamais commité) étaient obsolètes (ne
connaissaient pas encore `/mandat`) — la régénération normale exige de démarrer le bundler Metro
complet, non praticable dans cet environnement sandboxé sans matériel/simulateur ; corrigé par un
patch manuel ponctuel du fichier généré suivant exactement le même format que les entrées
existantes (`/paiements`), pour permettre au `typecheck` local de passer. Se régénérera
correctement tout seul au prochain vrai démarrage de `expo start`.

**Hors-scope confirmé non touché** : Tranche 4d (validation sandbox réseau réelle de ce nouveau
code — le socle HTTP/multipart lui-même reste validé depuis §10.6, mais ni la soumission réelle
avec un texte de mandat réel, ni le polling réel n'ont encore été exercés contre le vrai Super
PDP), aucun mécanisme de révocation/re-signature après dérive (le bandeau reste purement
informatif, comme conçu dès la Tranche 4a — §15.12), aucune interface admin de relance.

**TRANCHE 4c DONE.**

### 15.21 Tranche 4d : validation sandbox réelle bout en bout — **DONE (2026-09-24)**

Objectif : prouver que le workflow mandat complet (4a+4b+4c) fonctionne réellement contre Super
PDP sandbox, via le VRAI code applicatif (jamais un curl isolé, jamais `createMandate()` appelé
directement sauf pour diagnostic ponctuel). Fait entièrement par Claude (orchestration, écriture
et exécution du test, correction) — pas de délégation Codex sur ce test précis : Codex n'a ni
accès Postgres ni sortie réseau vers `api.superpdp.tech` dans son bac à sable (confirmé déjà en
§10.6), il n'aurait pu ni écrire ce test avec certitude sur les formes de réponse réelles, ni le
faire tourner, ni le corriger de façon itérative — tout le travail utile pour CE test précis
demandait un accès réseau réel de bout en bout.

**Rôles mandant/mandataire confirmés avant tout code** (relecture §7.2/§10.5bis/§10.6) : un
`company_mandate` `direction=out` identifie son grantor **uniquement par son SIREN** ; le scénario
sandbox officiel autorise Burger Queen (notre compte, `grantee`) à facturer au nom de Tricatel
(`grantor`, `000000001`). Un livreur de test a donc été créé avec `driver_legal_information.
siren='000000001'`/`siret='00000000100000'` (Tricatel) — jamais un SIREN inventé, jamais un vrai
SIREN livreur en scheme `sandbox`.

**Deux découvertes réelles avant le premier test vert** :
1. Le compte sandbox n'autorise qu'**un seul mandat par grantor** — un mandat Tricatel (`id=13504`)
   existait déjà depuis le debug de la Tranche 5/§10.6. `DELETE /v1.beta/company_mandates/{id}`
   confirmé fonctionnel (204, vérifié par un appel diagnostic isolé) : le `beforeAll` du nouveau
   test nettoie désormais tout mandat `sandbox`/`000000001` existant avant de lancer le vrai
   worker, rendant le test rejouable indéfiniment sans accumuler de mandats sandbox inutiles
   (consigne explicite de l'utilisateur).
2. **Bug réel trouvé et corrigé par Claude** (pas un bug Codex — un angle mort de bootstrap d'env
   jamais exercé avant cette tranche) : `test/setup.ts` neutralise inconditionnellement
   `SUPABASE_SECRET_KEY` (`??= 'test-service-role-key'`) AVANT que `dotenv` (chargé plus tard par
   `config.ts`) ne lise le vrai `.env` — et `dotenv` ne réécrit jamais une variable déjà présente
   dans `process.env`. Aucun test précédent n'avait jamais exercé un VRAI appel Supabase Storage
   (le test d'intégration du repository de mandat n'insère qu'une ligne Postgres directe, sans
   jamais uploader de PDF), donc ce piège n'avait jamais été révélé. Corrigé par le même mécanisme
   déjà utilisé pour `SUPERPDP_ENABLED`/`SUPERPDP_CLIENT_ID`/`SUPERPDP_CLIENT_SECRET` : la ligne
   n'écrase plus la variable quand `SUPERPDP_SANDBOX_TESTS=1`, laissant `dotenv` peupler la vraie
   valeur pour ce test opt-in précis — zéro impact sur la suite normale (`npm test`, sans ce flag).

**Nouveau test** `test/invoices/mandate-workflow-sandbox.test.ts` (opt-in, `SUPERPDP_SANDBOX_TESTS=1`,
base JETABLE obligatoire — vérifié par la même garde `isolated` que les autres tests d'intégration
`modules/invoices`, jamais exécutable contre la base de dev/partagée puisqu'une ligne
`driver_einvoice_mandates` ne peut plus jamais être supprimée). Chaîne réellement exercée, avec le
vrai code de production, sans mock ni fixture simplifié :
`AcceptDriverEInvoiceMandateUseCase` (vrai template V1, vrai `PdfLibMandatePdfRenderer`, vraie
image de signature PNG de test, vrai upload vers le bucket Storage hébergé réel) →
`RunEInvoiceMandateSubmissionsUseCase` (vrai worker : `claim` → `downloadMandatePdf` réel → vrai
`POST /v1.beta/company_mandates` sandbox) → `PollEInvoiceMandatesUseCase` (vrai `GET` sandbox).
`LIST`/`DELETE` (hors périmètre de toute logique métier réelle de l'application — aucun cas
d'usage n'en a besoin) sont des petits appels `fetch` locaux au fichier de test, jamais ajoutés au
port `EInvoiceMandateProvider` de production : `GET /v1.beta/company_mandates` confirmé retourner
`{ data: [...], has_more: boolean }` (découvert par appel diagnostic réel, jamais deviné).

**Résultat observé en conditions réelles** (id Super PDP `13525`) : `submissionStatus` `prepared`
→ `submitted`, `providerVerificationStatus` `not_submitted` → `submitted` → `not_verified` (jamais
`verified` — vérification humaine côté Super PDP sans SLA, **résultat valide et attendu pour cette
tranche**, conforme à la consigne explicite de ne jamais l'attendre artificiellement). `GET`/`LIST`
confirment tous deux le mandat par son id réel ; `DOWNLOAD` renvoie un PDF valide (`%PDF`) de
taille cohérente avec celui soumis (jamais une égalité byte à byte exigée — Super PDP peut
retimbrer un document, déjà constaté pour les factures en §10.1). Rejouer le worker après succès :
`claimDue` n'a plus rien à réclamer (`submission_status='submitted'` exclu par construction),
confirmé par une deuxième liste sandbox ne comptant toujours qu'un seul mandat pour ce grantor.
Rejouer le polling : deuxième `GET` renvoie le même `not_verified`, aucune régression. Un
`getMandate` en échec simulé (provider fake) ne fait jamais planter `PollEInvoiceMandatesUseCase`
— vérifié par un second test ciblé, sans coût réseau.

**Tests exécutés** : le nouveau test opt-in, 2/2 verts contre le vrai sandbox. Suite complète
`test/invoices` (sans le flag sandbox, base jetable fraîche 0001→0053) : 78 passés, 5 ignorés (les
deux fichiers opt-in désormais présents), aucun échec. Non-régression `test/http`/`test/drivers`
(le seul fichier partagé touché est `test/setup.ts`) : 143/143, identique aux tranches précédentes
— confirme que le correctif `SUPABASE_SECRET_KEY` n'affecte aucun test hors opt-in.
`typecheck`/`lint` verts. `check:boundaries` : 2 violations préexistantes identiques, aucune
nouvelle.

**Hors-scope confirmé non touché** : production, validation support réelle (`verified` manuel côté
Super PDP), SLA, tarifs, calendrier réforme, contrat commercial, signature électronique qualifiée,
Tranche 5 révisée (Factur-X UI/avoir sandbox, §11.G).

**TRANCHE 4d DONE. TRANCHE 4 (mandat livreur, 4a+4b+4c+4d) INTÉGRALEMENT DONE.**

## 16. Étape 5 — Tranche 5 révisée : documents/Factur-X consultables (commerçant + livreur) — **DONE (2026-09-24)**

Objectif : rendre factures/avoirs/statuts Super PDP/Factur-X réellement consultables côté
commerçant et livreur, **sans refaire** le moteur de facturation (Étape 4) ni les workers déjà
terminés (Tranches 1-4). Répartition tenue : Codex = backend TypeScript, Claude = frontend web +
mobile, SQL (aucune nécessaire), review complète, tests DB réels, doc.

### 16.1 État réel vérifié avant tout code (§1 du brief)

- `GET /api/v1/orders/:id/documents` existait (Étape 4) mais renvoyait un modèle pauvre : ni statut
  Super PDP, ni disponibilité Factur-X, et `CreditNoteDocument.originalInvoiceId` exposait un UUID
  interne brut (violation de la règle « jamais d'identifiant technique interne » — trouvé en
  relecture, pas supposé).
- `EInvoiceProvider.getDocument` (Factur-X, Tranche 2) existait et fonctionnait en sandbox depuis
  §10.5bis, mais n'était appelé par **aucun** cas d'usage — confirmé par grep exhaustif avant de
  commencer, pas par la seule lecture du plan.
- `invoice_provider_submissions.document_storage_path`/`document_content_type`/`document_sha256`
  existaient déjà en base (migration 0049) mais n'étaient jamais écrits — schéma déjà suffisant,
  **aucune migration nécessaire** pour toute cette tranche (confirmé avant de commencer, §14 du
  brief : « la Tranche 5 devrait principalement être API/UI »).
- `buyer_reference` (BT-10) : confirmé toujours absent de `en16931-mapper.ts` (grep exhaustif,
  zéro résultat) malgré sa collecte/persistance depuis la Tranche 3 — le compte-rendu de la
  Tranche 3 avait raison de le signaler comme un reste, pas encore fait entre-temps.
- Spec Super PDP re-vérifiée en direct (`https://api.superpdp.tech/openapi/superpdp.json`,
  toujours `1.34.0.beta`) : `en_invoice.buyer_reference` (BT-10) est un champ **top-level** de
  `en_invoice`, optionnel, **jamais imbriqué dans `buyer`** — confirmé avant d'écrire une seule
  ligne de mapping, pas deviné depuis la description théorique du concept EN16931.

### 16.2 Backend (Codex, relu intégralement par Claude)

- `ports/invoice-repository.ts` : `InvoiceDocument`/`CreditNoteDocument` enrichis de
  `submissionStatus` (axe travail worker), `lastError`, `facturXAvailable` (`true` ssi
  `transmissionStatus === 'confirmed'` — jamais un document juste « transmis » ou « soumis »,
  seul l'état terminal accepté a un Factur-X réellement récupérable, §9.N). `originalInvoiceId`
  **retiré**, remplacé par `originalInvoiceNumber` (numéro humain, jamais l'UUID).
- `infrastructure/postgres-invoice-repository.ts` : `list()` fait désormais un `LEFT JOIN
  invoice_provider_submissions` (avec repli `coalesce(..., 'prepared')`, jamais un crash si la
  ligne de soumission manquait pour une raison quelconque) — isolation par rôle **inchangée**,
  seule la requête est enrichie.
- Nouveau : `GetInvoiceDocumentFileUseCase` (`application/get-invoice-document-file.ts`) — revérifie
  l'autorisation de façon **indépendante** de `/documents` (jamais une confiance dans un appel
  précédent), refuse tout document dont `transmissionStatus !== 'confirmed'` (`not_available`,
  aucun appel provider), sert la copie déjà en cache si `document_storage_path` est posé (jamais
  un second appel provider), sinon appelle `EInvoiceProvider.getDocument` **hors transaction**,
  uploade, hash, persiste `document_storage_path` (mise en cache définitive, cohérent avec
  l'immutabilité du document une fois confirmé), puis renvoie une URL signée courte durée —
  jamais une URL publique persistante.
- Nouveaux ports/adaptateurs dédiés : `EInvoiceDocumentStorage`/`SupabaseEInvoiceDocumentStorage`
  (même bucket privé `einvoice-documents`, déjà générique à tout Super PDP et pas seulement au
  mandat — une classe séparée de `EInvoiceMandateStorage`, jamais réutilisée telle quelle car sa
  signature est spécifique au mandat) ; `InvoiceDocumentFileRepository`/
  `PostgresInvoiceDocumentFileRepository` (autorisation + cache, requête d'ownership qui reprend
  exactement la logique déjà éprouvée de `list()` : commande → rôle, et pour un avoir la
  vérification remonte à la facture D'ORIGINE de cet avoir, jamais l'avoir lui-même).
- Nouvelle route `GET /api/v1/orders/:id/documents/:documentId/factur-x?kind=invoice|credit_note`
  (même fichier `routes.ts`, même style d'erreurs `{error, correlationId}` déjà établi) : `200
  {url}` / `404 DocumentNotFound` / `409 DocumentNotAvailable` / `400 ValidationError` / `403
  ForbiddenError`.
- BT-10 câblé : `TransmissionInvoice.buyerReference` (top-level, jamais dans `buyer`),
  `mapToEnInvoice` l'ajoute conditionnellement (`buyer_reference`, omis si `null`, jamais une
  chaîne vide). `postgres-einvoice-work-repository.ts` le lit **à chaque soumission** depuis
  `merchant_legal_information.buyer_reference` (jamais figé à l'émission de la facture — c'est un
  champ de transmission, pas une donnée légale immuable, même philosophie que la résolution de
  l'adresse électronique acheteur déjà résolue fraîche à chaque tentative).

**Bug réel trouvé et corrigé par Claude** (course concurrente, pas un bug Codex au sens strict —
un angle mort de conception) : `SupabaseEInvoiceDocumentStorage.uploadDocument` utilisait un
`POST` simple ; deux requêtes concurrentes pouvaient toutes deux voir `document_storage_path`
encore nul (aucun verrou applicatif sur ce premier accès) et tenter d'écrire le même chemin — la
seconde aurait échoué avec « resource already exists » plutôt que d'écraser un contenu
byte-pour-byte identique (même provider, même document). Corrigé par l'en-tête `x-upsert: true`,
rendant l'upload idempotent.

**Faux positif écarté avant de « corriger »** : la nouvelle route Factur-X n'a pas de bloc
`catch` générique pour une erreur inattendue (contrairement à la route `POST` d'acceptation du
mandat, plus bas dans le même fichier) — vérifié que la route `GET /documents` juste au-dessus
dans ce même fichier a exactement le même comportement depuis l'Étape 4 (aucun `try/catch` du
tout) : cohérent avec l'existant, pas une régression, laissé tel quel.

**Bug réel trouvé et corrigé par Claude au typecheck** (encore un rapport Codex « typecheck
passed » erroné — quatrième fois sur ce chantier) : `test/invoices/einvoice-workers.test.ts`
(fichier de la Tranche 2, non modifié par Codex dans cette tranche) construisait un
`TransmissionInvoice` de test sans le nouveau champ obligatoire `buyerReference` — `tsc` échouait
réellement. Corrigé (`buyerReference: null` ajouté à la fixture), retesté vert.

### 16.3 Frontend (Claude)

**Web** (`apps/web/lib/invoices.ts`, `components/order-modal.tsx`) : types alignés sur le
contrat réel, `transmissionStatusLabel` réécrite pour combiner les DEUX axes de statut
(`transmissionStatus` figé + `submissionStatus` travail worker) en un seul libellé sans jargon
(« À transmettre » / « En cours d'envoi » / « Traitement en cours » / « Transmise » / « Rejetée »
/ « Action requise » / « Statut inconnu — vérification nécessaire », fail-closed sur tout état non
explicitement reconnu — même philosophie que `deriveMandateUi`, Tranche 4c). Bouton « Voir le
document » par facture/avoir quand `facturXAvailable`, ouvre l'URL signée dans un nouvel onglet.
Avoir affiché avec la référence de la facture d'origine (`originalInvoiceNumber`, jamais l'UUID).

**Mobile** (`apps/mobile/lib/document-status.ts` — nouveau, miroir exact de la fonction web —,
`lib/api.ts`, `app/order/[id]/index.tsx`) : l'écran n'affichait auparavant QUE la première facture
(`documents.invoices[0]`) avec un statut technique brut affiché tel quel si différent de
`not_submitted` (`confirmed`/`rejected` littéralement à l'écran — un vrai gap de jargon trouvé en
relecture). Corrigé : toutes les factures/avoirs du livreur affichés, libellé traduit
systématiquement, bouton « Voir » ouvrant l'URL signée via `Linking.openURL` (jamais une WebView,
même convention que `lib/open-external.ts`), erreur `409` traduite explicitement (« pas encore
prêt ») plutôt qu'un message générique.

Aucun framework de test frontend dans ce dépôt (ni web ni mobile pour cet écran) — vérifié par
`typecheck`/`lint` sur les deux apps, aucun test de composant automatisé (cohérent avec l'absence
totale de précédent pour `order-modal.tsx`/`order/[id]/index.tsx`, jamais testés en composant
avant cette tranche non plus).

### 16.4 Tests exécutés et résultats

- Backend ciblé (Codex + Claude) : `get-invoice-document-file.test.ts` (autorisation pure :
  mauvaise commande/rôle/tenant, avoir d'un autre livreur, document non confirmé jamais
  interrogé chez le provider, copie en cache jamais re-téléchargée, premier téléchargement
  cache+hash+signe), `superpdp-mapping.test.ts` (BT-10 présent/absent), `einvoice-workers.test.ts`
  (fixture corrigée) : **27/27 verts**.
- **Nouveau test d'intégration réel** écrit par Claude (`issue-order-invoices.integration.test.ts`,
  base jetable) pour `PostgresInvoiceDocumentFileRepository` — aucun test Codex n'exerçait cette
  classe contre du vrai Postgres (son bac à sable n'a pas accès à la base). Vérifie en conditions
  réelles : commerçant voit ses deux factures, mauvais commerçant/mauvaise commande jamais trouvés,
  livreur voit sa facture mais **jamais** la facture Locadely (fuite la plus sensible de cette
  tranche), un autre livreur ne voit ni la facture ni l'avoir de ce livreur, `cacheDocument`
  persiste réellement `document_storage_path`. Tous les cas passent.
- Suite complète `test/invoices` sur base jetable fraîche (migrations 0001→0053, inchangées) :
  **85 passés, 5 ignorés** (les deux fichiers sandbox opt-in), aucun échec.
- Non-régression `test/http`/`test/drivers` : **143/143** (un premier essai a montré un flake
  `PGBOSS_DATABASE_URL` transitoire déjà observé dans les tranches précédentes, non reproductible
  à la ré-exécution immédiate — confirmé environnemental, pas une régression).
- `typecheck`/`lint` verts sur `apps/api`, `apps/web` **et** `apps/mobile`. `check:boundaries` :
  2 violations préexistantes identiques (`merchants`/`drivers`), aucune nouvelle.

### 16.5 Hors-scope confirmé non touché

Production, tarification Super PDP, calendrier réforme, contrats commerciaux, reporting comptable
avancé, exports comptables, admin (aucun écran admin documents construit — hors scope, non
demandé), refonte du moteur de facturation (Étape 4 intacte), refonte du mandat (Tranche 4
intacte, aucun fichier `*mandate*`/`*einvoice-mandate*` touché).

**TRANCHE 5 (révisée) DONE.** L'ensemble du chantier facturation électronique / SUPER PDP
(Étapes 1-5, mandat 4a-4d, documents/Factur-X) est maintenant consultable de bout en bout côté
commerçant et livreur. Reprendre uniquement sur nouvelle instruction explicite.
