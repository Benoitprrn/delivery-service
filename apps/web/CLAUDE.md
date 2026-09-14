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
  merchant/
    new/            créer une livraison (CTA principal)
    orders/         historique en cours + passées
    account/        données fiscales, Stripe Connect, clé API
    notifications/  alertes non-prise, annulation livreur, litige
  admin/            back-office opérateur (Phase 4)
public/             Phase 1 uniquement — pages HTML statiques de démo
```

## Règles spécifiques web

- Mobile-first pour `/merchant/*` : sidebar réductible en desktop,
  navigation bottom/hamburger en mobile. Desktop-first pour `/admin/*`
  (sidebar 280px → 60px icônes).
- Consommer exclusivement les endpoints publics de l'API
  (`/api/v1/...`) — jamais d'appel direct à Supabase depuis le navigateur.
- Statuts commande : utiliser la palette et les labels exacts du design
  system Terrain (`design-system/terrain/tokens/colors.css`,
  section "Système de statuts" du readme).
- Phase 1 : aucune page Next.js applicative — deux pages HTML brutes dans
  `public/` (formulaire commerçant, liste livreur) consommant l'API en
  fetch simple.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
