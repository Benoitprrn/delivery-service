# delivery-service

Service de livraison last-mile B2B, modèle marketplace (le livreur choisit sa
course, aucun dispatch automatique). Lancement pilote : Bourg-en-Bresse.

Monorepo npm workspaces. Un seul Claude Code lancé à la racine — jamais dans
un sous-dossier. Précise toujours l'app cible dans tes instructions
("Dans apps/api, ..." / "Dans apps/mobile, ...").

## Stack globale

- Node 24 LTS · TypeScript strict partout
- **API** : Fastify · Supabase CLI (Postgres+PostGIS, port 54322/Studio 54323) ·
  Valkey 8.x (port 6379) · pg-boss (Phase 2+) · Socket.io (websocket only) ·
  OSRM (port 5000, bbox Bourg-en-Bresse uniquement)
- **Web** : Next.js 14+ App Router · Tailwind CSS · shadcn/ui
- **Mobile** : React Native + Expo · NativeWind · MapLibre React Native
- **IA/externe** : Mistral Small 4 (OCR, structured output) · OpenCage
  (géocodage) · Stripe (paiement, destination charges) · Twilio (SMS) ·
  Resend (email)
- **Design system** : Terrain (`design-system/terrain/`) — voir ce dossier
  avant de construire un écran web ou mobile.

## Règles absolues — jamais d'exception

- Jamais de float pour de l'argent. Toujours des centimes entiers (`integer`).
- Jamais de logique métier dans les routes HTTP. Les routes appellent des
  use cases, rien d'autre.
- Jamais d'import entre modules API sauf via leur `public.ts`.
- Jamais de transaction PostgreSQL traversant un appel réseau externe
  (Twilio, Stripe, Mistral, etc.).
- Jamais de GPS dans le bus d'événements métier — c'est un flux technique,
  pas un événement de domaine.
- Tous les timestamps en UTC (`timestamptz`). Conversion Europe/Paris
  côté client uniquement.
- API versionnée `/api/v1/`.
- **Valkey 8.x, jamais Redis 8+** — Redis est repassé sous licence AGPL,
  incompatible avec notre règle BSD/MIT/Apache uniquement.
- Chaque transition d'état commande = une seule transaction : `UPDATE` +
  `INSERT order_events` + `INSERT outbox_event` + `COMMIT`. Le worker
  outbox publie les effets externes après coup, jamais dans la transaction.
- State machine commande : implémentation custom TypeScript uniquement
  (pas de librairie type XState). Voir `docs/adr/0001-order-states.md`.

## Structure du monorepo

```
apps/
  api/      Backend Fastify — voir apps/api/CLAUDE.md
  web/      Next.js commerçant + admin — voir apps/web/CLAUDE.md
  mobile/   App livreur RN/Expo — voir apps/mobile/CLAUDE.md
packages/
  shared/   Types et schémas partagés entre api/web/mobile
supabase/
  migrations/   Schéma SQL — source de vérité
design-system/
  terrain/  Tokens, composants et guidelines du design system Terrain
docs/
  adr/      Décisions d'architecture courtes et datées
```

## Commandes racine

```bash
npm run dev:api      # apps/api en hot reload
npm run dev:web      # apps/web en hot reload
npm run dev:mobile   # apps/mobile via Expo (QR code)
npm test             # tests de tous les workspaces
npm run typecheck    # typecheck de tous les workspaces
npm run lint         # lint de tous les workspaces
```

## Où trouver quoi

- Règles backend détaillées (modules, outbox, pg-boss) → `apps/api/CLAUDE.md`
- Règles web détaillées (routes, layout) → `apps/web/CLAUDE.md`
- Règles mobile détaillées (écrans, dev build) → `apps/mobile/CLAUDE.md`
- États commande et transitions autorisées → `docs/adr/0001-order-states.md`
- Formule de tarification → `docs/adr/0002-pricing-formula.md`

## État du projet

Phase 1 en cours : flux vertical minimal (commerçant crée → livreur voit →
prend → collecte → livre), sans auth, sans photos, sans paiement réel.
