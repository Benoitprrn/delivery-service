# apps/api

Backend Fastify. API REST `/api/v1/` + WebSocket (Socket.io) + worker outbox.

## Stack

Fastify · TypeScript strict (`strict`, `noUncheckedIndexedAccess`,
`exactOptionalPropertyTypes`) · Zod (validation entrées) · Pino JSON (logs) ·
Supabase CLI Postgres (port 54322, DB `postgres`) · Valkey 8.x (port 6379,
`maxmemory 256mb noeviction`) · pg-boss (Phase 2+ uniquement) · Socket.io
(`transports: ["websocket"]` seulement, jamais long-polling) · OSRM (port
5000, bbox Bourg-en-Bresse).

## Commandes

```bash
npm run dev -w apps/api          # hot reload, port 3000
npm run test -w apps/api         # vitest
npm run test:concurrency -w apps/api   # tests de course/concurrence
npm run typecheck -w apps/api
npm run lint -w apps/api
```

## Structure d'un module

```
src/modules/{name}/
  domain/            entités, value objects, événements — zéro dépendance externe
  application/       use cases (create-order, assign-order, ...)
  ports/             interfaces abstraites (OrderRepository, RoutingProvider, ...)
  infrastructure/    implémentations concrètes des ports
  transport/http/    routes Fastify — appellent un use case, rien d'autre
  public.ts          seul fichier importable par les autres modules
```

Modules : `zones`, `merchants`, `drivers`, `pricing`, `orders`, `marketplace`
(actifs en Phase 1) · `tracking`, `notifications`, `payments`, `integrations`,
`auth` (vides jusqu'à Phase 2/3).

## Règles spécifiques backend

- Deux connexions PostgreSQL distinctes, jamais interchangeables :
  `DATABASE_URL` (Supavisor, transaction mode, pour l'API) et
  `PGBOSS_DATABASE_URL` (connexion directe, session mode, pour pg-boss —
  **non utilisée en Phase 1**, pg-boss n'est pas encore installé).
- Outbox minimal actif dès Phase 1 : table `outbox_event` + relais
  `platform/outbox-relay.ts` (`setInterval` + `SELECT ... FOR UPDATE SKIP
  LOCKED`). Pas de pg-boss tant qu'aucun job différé réel n'existe.
- Machine à états commande : `modules/orders/domain/order-state-machine.ts`,
  table de transitions figée dans `docs/adr/0001-order-states.md` — ne pas
  la modifier sans mettre à jour l'ADR.
- Formule de prix : `modules/pricing/domain/*` — voir
  `docs/adr/0002-pricing-formula.md`. `floor()` par composante, jamais de
  float, jamais d'arrondi au total.
- Chaque requête HTTP porte un `correlationId` propagé dans tous les logs
  Pino et tous les événements émis.
- Assignation d'une commande : `UPDATE ... WHERE status='AVAILABLE' AND
  driver_id IS NULL AND version=$N`. Zéro ligne affectée = conflit, pas une
  erreur serveur.
- OCR (Phase 3) : utiliser le structured output / JSON Schema natif de
  l'API Mistral Small 4, jamais un prompt "retourne du JSON" seul.
- Paiement (Phase 2+) : Stripe Connect, la plateforme possède le lecteur
  Terminal, destination charges vers le compte Connect du commerçant.
