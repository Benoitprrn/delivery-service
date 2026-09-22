# R90 — Bilan final (2026-09-22)

Gate finale Sandbox/dev du chantier règlement livreurs (Stripe Connect). Contexte complet, décisions et
checklist détaillée : mémoire `driver-settlement-progress` (checklist permanente avant production, 144 points
au total, 139 ouverts après R90). Ce document synthétise le verdict par grand thème.

## Classement

**VALIDÉ EN SANDBOX**
- Cycle règlement complet (clôture R40 → pré-notification R41 → débit SEPA R50 → pay-run R60) : rejoué 4 fois
  (run1–4), y compris crash/reprise, 2 workers concurrents, litige avant/après paiement, livreur restreint →
  drip, relance manuelle de débit. Aucun doublon, aucune perte, invariants tenus (Σ Transfers ≤ dû, `paid_cents`
  = Σ Transfers réussis).
- Reversals (B faute livreur / C erreur Locadely), double approbation admin, bucket pending/available : validés
  dev/Sandbox (REV-06 TERMINÉ).
- Lecture R80 (Wallet livreur, Règlements restaurant, admin overview) : vérifiée avec données réelles sur les
  3 rôles (H, run3) ET sur 2 VRAIS comptes Stripe Express onboardés depuis l'app (run4, individual + company).
- **Stripe Connect Express v2 de bout en bout avec 2 vrais comptes onboardés par l'utilisateur** (run4) :
  choix `individual`/`company` verrouillé, onboarding intégré (`ConnectAccountOnboarding`), compte `ready`,
  éligibilité aux courses (D-F levé), commandes réelles, débit SEPA réel, pay-run réel, **Transfer Stripe
  Sandbox réel reçu par chaque livreur, DB = Stripe au centime près** (individual 17,30 €, company 17,98 €),
  affichage Wallet confirmé par l'utilisateur sur les deux comptes.
- Repli lien hébergé de l'onboarding (MOB-02) : ouverture réelle vérifiée sur l'appareil (navigateur système,
  jamais de WebView).
- Pages de retour `/driver/payout-account/{return,refresh}` (MOB-04) : créées, testées en direct sur
  l'appareil (redirection réelle observée).
- Composants embarqués Payouts/Payments (« Mes paiements » > Versements) : confirmés par l'utilisateur.
- Webhooks R70 (déclencheurs, relecture Stripe, dead-letter, réconciliation quotidienne DB↔Stripe) : validés
  dev/Sandbox (F, F2, REC).

**BUG TROUVÉ ET CORRIGÉ** (pendant R90, tous corrigés et revérifiés le jour même)
- **MOB-15** : une fois le compte de paiement `ready`, aucun moyen dans l'app d'atteindre le Dashboard Express
  complet (le seul point d'entrée, le bandeau Carte, se cache dès que le compte est prêt). Corrigé par Codex :
  bouton permanent « Mon espace Stripe complet » ajouté dans le Wallet. Vérifié par l'utilisateur sur Pixel.
- **Page de retour trompeuse** (trouvé en testant MOB-02/04 en direct) : Stripe appelle `return_url` dès que
  l'utilisateur quitte la session hébergée, annulation comprise — la page affirmait à tort « Informations
  envoyées » sans rien soumettre, et n'offrait aucune action (impasse). Corrigé par Claude : texte neutre +
  bouton de retour vers l'app (deep link). Revérifié.
- `WEB_APP_URL` par défaut de l'API (`localhost:3001`) ne correspondait à aucun service réel (web sur :4000) :
  corrigé pour l'environnement R90 (`WEB_APP_URL=http://localhost:4000`) ; **à vérifier explicitement en
  production** que la variable d'environnement réelle est bien configurée (voir RESTE À FAIRE).

**RESTE À FAIRE AVANT PRODUCTION** (voir checklist permanente pour le détail complet, 139 points, 56 critiques)
- Toute la partie **À TESTER LIVE** (impossible à valider hors Live, ~30 points `STR`/`SEPA`/`PAY` critiques) :
  délais SEPA réels (T+6 jours ouvrés), cut-off bancaire, plafond SEPA, restriction Express réelle avec pièce
  d'identité demandée, `debit_negative_balances` réel, etc.
- Confirmations écrites Stripe (top-up EUR, tarifs, plafonds, pré-notification double envoi).
- Validations juridiques/comptables (TVA 20 %, DSP2, DAC7, délai pré-notification 2 j, compensation Stripe des
  soldes négatifs).
- `WEB_APP_URL` en production doit pointer la vraie URL publique du site (pas `localhost`) — vérifier au
  déploiement, pas seulement en R90.
- Volume de commandes/livreurs plus large (R90 = tests ciblés, jamais de campagne massive par consigne).
- R91/canary live : reporté (D-Q), non commencé.

**IMPOSSIBLE À VALIDER HORS LIVE**
- Tout ce qui dépend du calendrier bancaire réel, des vrais délais Stripe Connect, d'une vraie restriction
  Express (pièce d'identité), des vrais tarifs/plafonds — Sandbox n'est pas représentatif sur ces points
  (déjà documenté SP1–SP7).

## Preuves

`docs/work/r90/evidence/r90-20260922-{1,2,3}.jsonl` (runs 1–3, H) et `r90-20260922-4.jsonl` (run 4, G) ;
états `state-r90-20260922-{1,2,3,4}.json`. Scripts : `docs/work/r90/*.mts` (dont `run4-prep.mts`,
`run4-world.mts`, `run4-settle.mts`, nouveaux ce jour).

## Recommandation

Le comportement fonctionnel (règlement, Stripe Connect Express réel individual+company, affichage) est
VALIDÉ en Sandbox sans bug fonctionnel restant non corrigé. Le chantier ne peut PAS passer en production sans
lever les points critiques « À TESTER LIVE » et les validations juridiques/Stripe écrites listées dans la
checklist permanente — aucun raccourci Sandbox ne peut s'y substituer.
