@AGENTS.md

# apps/web

Espace commerçant (`/merchant/*`) + admin back-office (`/admin/*`), même
projet Next.js.

## Stack

Next.js 14+ App Router · Tailwind CSS · shadcn/ui · design system Terrain
(`design-system/terrain/` à la racine — tokens, tailwind.config.ts,
globals.css à réutiliser tels quels, composants à récupérer via le MCP
Claude Design au moment de construire chaque écran).

## Commandes

```bash
npm run dev -w apps/web     # port 4000
npm run build -w apps/web
npm run lint -w apps/web
```

## Structure

```
app/
  signup/           inscription commerçant (nom, e-mail, mot de passe)
  login/             connexion commerçant
  merchant/
    new/            créer une livraison (CTA principal)
    orders/         historique en cours + passées
    account/        finalisation du compte (adresse, téléphone, logo) + email/mdp
    settlements/    « Règlements » (R80) : semaines clôturées, prélèvement annoncé/en cours/rejeté, détail des courses ; montants restaurant uniquement
    notifications/  alertes non-prise, annulation livreur, litige
  admin/settlements back-office MINIMAL (R80), rôle `admin` seulement (layout serveur + revérification côté API) : règlements, relance de débit, incidents,
                    créances, constats de réconciliation, statements bloqués, reversals (demande + double approbation), événements en échec
public/             legacy Phase 1 — pages HTML statiques de démo, plus le
                    flux principal (superseded par l'app Next.js ci-dessus)
```

## Règles spécifiques web

- Mobile-first pour `/merchant/*` : sidebar réductible en desktop,
  navigation bottom/hamburger en mobile. Desktop-first pour `/admin/*`
  (sidebar 280px → 60px icônes).
- Consommer exclusivement les endpoints publics de l'API (`/api/v1/...`)
  pour les données métier — jamais d'appel direct à Supabase depuis le
  navigateur, à l'exception de l'authentification elle-même
  (`supabase.auth.signInWithPassword`/`signUp` côté client via
  `lib/supabase/client.ts`, seule exception admise à cette règle).
- Statuts commande : utiliser la palette et les labels exacts du design
  system Terrain (`design-system/terrain/tokens/colors.css`,
  section "Système de statuts" du readme).
- `/signup` et `/login` : blocs shadcn `signup-04`/`login-04` utilisés
  uniquement comme référence de structure/layout (jamais `npx shadcn add`
  exécuté dans ce repo) — composants Terrain existants (`components/ui/`)
  et `components/auth-map-placeholder.tsx` (panneau droit partagé,
  destiné à accueillir la vraie carte plus tard). Marque affichée :
  "Locadely" (le nom "Terminus" ne subsiste que dans `apps/mobile`, hors
  scope de ce chantier).
- Temporairement, un commerçant `onboardingCompleted: false` (champ renvoyé
  par `GET /api/v1/merchants/me`) reste pleinement fonctionnel sur
  `/merchant/new`, y compris le bouton « Demander une livraison » : le
  parcours d'onboarding global est encore en construction. La garde UI et la
  garde backend doivent être réactivées ensemble une fois ce parcours achevé;
  les prérequis opérationnels réels restent toutefois contrôlés par l'API.
- `/merchant/account` doit tolérer `address`/`lat`/`lng` nulles (compte pas
  encore finalisé) — c'est l'écran où un commerçant les renseigne pour la
  première fois, pas seulement où il les modifie. Il envoie uniquement
  l'adresse : l'autocomplétion est une aide UX, tandis que le serveur géocode
  et choisit la zone de manière souveraine.
- La section « Informations légales et facturation » utilise des champs
  postaux structurés, pas `AddressAutocomplete` ni OpenCage : ces adresses ne
  sont pas opérationnelles. La recherche SIRET passe exclusivement par l'API
  Locadely; Sirene préremplit sans sauvegarder automatiquement et les champs
  restent modifiables, y compris lors d'une indisponibilité du fournisseur.
- Le Payment Element SEPA ne collecte aucun IBAN dans l’UI Locadely. Les
  informations légales déjà sauvegardées alimentent les `billing_details`
  Stripe (adresse de facturation, sinon légale) et l’e-mail de compte est
  affiché pour les notifications de prélèvement.
  Les erreurs d’intégration sont affichées dans les toasts sans sérialiser ni
  exposer d’objet Stripe complet : l’UI ne lit que le code stable `error` de
  l’API (jamais un message brut) et le traduit en français
  (`noticeForCode`). Les erreurs de saisie du Payment Element restent affichées
  par Stripe lui-même.
  Le chargement initial est différé dans l’effet client pour respecter les
  règles React sur les mises à jour d’état asynchrones. Le composant lit
  `getAccessToken` via une ref : la page Compte le recrée à chaque rendu, ce qui
  relancerait sinon le chargement à chaque frappe des autres sections.
  Le formulaire propose « Annuler » (retire l’Element sans nouvelle tentative :
  la tentative `setup_pending` sera reprise). Un mandat encore en validation
  (`SetupProcessing`) ferme le formulaire et déclenche un rafraîchissement
  périodique (6 × 5 s) jusqu’à ce que le webhook l’active. Les boutons sont
  désactivés tant que les informations légales n’ont pas été enregistrées.
  L’apparence du Payment Element recopie les tokens Terrain (couleurs, DM Sans,
  rayon), car l’iframe Stripe n’hérite pas des variables CSS.
  Le Payment Element masque nom, e-mail et adresse (`fields.billingDetails:
  'never'`) : Stripe.js exige alors TOUS les sous-champs de l’adresse à
  `confirmSetup` (`line1`, `line2`, `city`, `state`, `postal_code`, `country`,
  vides inclus), sinon il lève une `IntegrationError` avant tout appel réseau
  (aucun SetupIntent confirmé, donc rien côté Stripe). `lib/stripe-billing-details.ts`
  construit cet objet (`state` vide, `line2` absente → `''`). Aucun `return_url`
  n’est requis pour le SEPA avec `redirect: 'if_required'` (vérifié en Sandbox).
  Le `catch` du composant journalise `nom: message` dans la console : sans cette
  trace le toast générique rend l’échec indiagnosticable.
  L’erreur renvoyée par `confirmSetup` n’est affichée telle quelle que si son
  `type` est `validation_error` ou `card_error` (rédigée par Stripe pour le
  client); tout autre type donne un message générique.
- CSP (`next.config.ts`, exigée par Stripe dès que Stripe.js est chargé) :
  appliquée en production, en `Content-Security-Policy-Report-Only` en
  développement (les violations apparaissent dans la console sans bloquer le
  rechargement à chaud). Les origines autorisées viennent de l’environnement
  (`NEXT_PUBLIC_API_URL` + son WebSocket, `NEXT_PUBLIC_SUPABASE_URL`) plus Stripe
  (`js.stripe.com`, `*.js.stripe.com`, `hooks.stripe.com`, `api.stripe.com`),
  OpenCage et Google Fonts. Toute nouvelle origine externe doit y être ajoutée
  avant la mise en production; jamais `default-src *`.
- Identités légales et documents (Étape 3, `docs/work/invoicing-preparation-plan.md` §5) :
  `app/merchant/account/page.tsx` a trois nouvelles sections — « Responsable du compte » (avant
  la section légale), forme juridique/régime TVA ajoutés à « Informations légales et
  facturation », « Documents » (pièce d'identité du responsable, justificatif d'entreprise
  générique — libellé UI « Kbis / RCS / extrait K / attestation SIRENE », jamais le mot Kbis
  comme type technique). Consomme `GET/PATCH /api/v1/merchants/me/account-contact` et
  `GET/POST/DELETE /api/v1/merchants/me/documents...`. La liste de documents renvoie
  `{ documents: [...] }` (objet, pas un tableau nu) ; aucun bouton « voir » un document n'est
  construit (pas demandé, évite d'exposer une URL signée dans le DOM sans besoin réel).
- Modèle économique livraison/frais de service (SF10, ADR 0005, 2026-09-23) : le devis
  (`/merchant/new`, `components/price-card.tsx`), le détail d'une commande
  (`components/order-modal.tsx`) et le détail par course des règlements
  (`app/merchant/settlements/page.tsx`) affichent tous le total HT en premier
  (`lib/orders.ts` → `orderTotalCents()` = `deliveryCents + serviceFeeCents`), avec un bouton
  « Détail » dépliant la décomposition livraison/service. **Jamais un montant présenté comme
  une soustraction au livreur** — le frais de service est additif, propriété de Locadely,
  jamais retiré du livreur. `lib/orders.ts` → `hasChargeablePrice()` : seule `CANCELLED` n'a
  donné lieu à aucun paiement ; `RETURNED` reste facturé et affiche son prix. L'API expose
  `deliveryCents`/`serviceFeeCents` sur `Order` (commande créée) et sur
  `MerchantSettlementView`/`MerchantSettlementLineView` (règlements, période et par course) —
  ajout backend additif signalé et validé avant d'être fait (aucune logique nouvelle, colonnes
  déjà calculées depuis SF5/SF6). Aucun framework de test frontend dans ce dépôt : vérification
  par `typecheck`/`lint` + relecture + contrôle du serveur de dev, pas de test automatisé de
  composant.
- Documents de facturation (Étape 4, `docs/work/invoicing-preparation-plan.md` §8, enrichi Étape 5
  Tranche 5 révisée §16) : `components/order-modal.tsx`, section « Documents » (commande
  `COMPLETED` uniquement, `lib/invoices.ts` → `getOrderDocuments`) — affiche les deux factures
  (livreur + Locadely, libellé clair, jamais le mot « Locadely » présenté comme une charge déduite
  du livreur) et les avoirs éventuels (avec la référence de la facture d'origine,
  `originalInvoiceNumber` — jamais un UUID interne), montant HT + statut sans jargon
  (`transmissionStatusLabel` combine `transmissionStatus`+`submissionStatus` : « À transmettre »/
  « En cours d'envoi »/« Traitement en cours »/« Transmise »/« Rejetée »/« Action requise »/
  « Statut inconnu — vérification nécessaire », fail-closed). Bouton « Voir le document » par
  facture/avoir quand `facturXAvailable` (`getInvoiceDocumentFacturXUrl`, `GET .../documents/
  :documentId/factur-x?kind=...` → URL signée courte durée, ouverte dans un nouvel onglet — jamais
  d'URL publique persistante). `getOrderDocuments` renvoie `null` en cas d'erreur/absence plutôt
  que de lever — la section ne s'affiche simplement pas.
- Annuaire électronique + éligibilité de transmission (Étape 5 Tranche 3,
  `docs/work/invoicing-preparation-plan.md` §14) : `app/merchant/account/page.tsx`, section
  « Informations légales et facturation », affiche un message sans jargon sous le champ SIRET
  (« Facturation électronique disponible » / « Votre entreprise n'est pas encore adressable pour la
  facturation électronique. » / rien tant que le statut est `unknown`) dérivé du champ
  `electronicInvoicingStatus` renvoyé à la racine par `GET`/`PATCH /api/v1/merchants/me/legal-information`
  (présent même quand `legalInformation` est `null`). Nouveau champ optionnel « Référence acheteur /
  code de routage de facturation électronique » (`buyerReference`, texte libre, concept EN16931
  BT-10 **séparé** de l'adresse électronique — jamais fusionné dans l'UI ni dans le code), juste
  avant le bouton d'enregistrement.
