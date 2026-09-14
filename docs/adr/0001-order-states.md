# ADR 0001 — États de la commande et transitions autorisées

Statut : validé — 2026-09-11

## Contexte

Cet ADR remplace et révise l'ADR 0001 initial. Il fige le flux de commande
validé et constitue la source de vérité pour la machine à états
(`apps/api/src/modules/orders/domain/order-state-machine.ts`).

## Décision

Implémentation **custom TypeScript**, pas de librairie (XState jugée trop
complexe pour ce cas backend).

### Flux nominal

```
CREATED → AVAILABLE → ASSIGNED → COLLECTED → COMPLETED
```

### Flux alternatifs

```
CREATED   → CANCELLED              (acteur: commerçant)
AVAILABLE → CANCELLED              (acteur: commerçant)
ASSIGNED  → AVAILABLE              (acteur: livreur, annule avant collecte)
COLLECTED → RETURNING → RETURNED   (client absent à la livraison, uniquement)
```

La transition `ASSIGNED → AVAILABLE` remplace
`DRIVER_CANCELLED_BEFORE_PICKUP` : le livreur qui annule avant collecte
remet directement la commande dans le pool des commandes disponibles, sans
statut intermédiaire dédié.

Une commande ne peut plus jamais être annulée (`CANCELLED`) une fois
`COLLECTED`. Au-delà de ce point, seule la voie `RETURNING → RETURNED`
existe, dans le cas où le client est absent. `CANCELLED` reste réservé aux
commandes où aucun trajet n'a encore eu lieu (`CREATED` ou `AVAILABLE`),
jamais après.

### Table de transitions autorisées

| État actuel | Transitions autorisées |
|---|---|
| CREATED | AVAILABLE, CANCELLED |
| AVAILABLE | ASSIGNED, CANCELLED |
| ASSIGNED | COLLECTED, AVAILABLE |
| COLLECTED | COMPLETED, RETURNING |
| COMPLETED | *(aucune -- état terminal)* |
| CANCELLED | *(aucune -- état terminal)* |
| RETURNING | RETURNED |
| RETURNED | *(aucune -- état terminal)* |

Toute transition hors de cette table doit être rejetée par la machine à
états avant même d'atteindre la base de données.

## Conséquences

- Une seule source de vérité pour les états : ce fichier + le fichier
  TypeScript qui l'implémente. Toute divergence entre les deux est un bug.
- Chaque transition doit être testée unitairement (transition valide,
  transition interdite, conflit de `version`) dès la Phase 1.
- `IN_TRANSIT` a été retiré : aucun événement/requête/trigger n'en dépend ;
  la collecte porte déjà le fait métier pertinent (SMS/email/suivi GPS
  déclenchés à la collecte, pas à un "démarrage de trajet" distinct). Le
  suivi GPS reste un flux technique, jamais un événement de domaine.
- `AT_DELIVERY` a été retiré : aucun chemin d'écriture légitime n'existe
  pour cet état dans le flux réel (l'arrivée devant le client se fait hors
  app, par appel/sonnette, pas par une action app qui écrirait en base).
- `PROOF_COLLECTION` et `PAYMENT_PENDING` ont été retirés : ce sont des
  étapes d'écran (code/signature/photo puis paiement) validées en une seule
  fois avant la transition finale vers `COMPLETED`, pas des statuts persistés
  distincts -- aucune donnée de preuve/paiement n'est stockée qui justifierait
  une reprise après crash ou une visibilité multi-appareil à ce stade.
- `DRIVER_CANCELLED_BEFORE_PICKUP` a été retiré : remplacé par la transition
  directe `ASSIGNED → AVAILABLE` (le livreur qui annule avant collecte remet
  simplement la commande dans le pool disponible, sans état transitoire
  dédié).
