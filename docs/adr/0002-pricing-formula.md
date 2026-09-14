# ADR 0002 — Formule de tarification

Statut : validé — 2026-09-11

## Contexte

La v6 des specs imposait "pas de float, centimes entiers" sans préciser la
règle d'arrondi exacte depuis les mètres/secondes renvoyés par OSRM. Deux
implémentations pouvaient produire deux prix différents pour la même
commande. Cet ADR fige la formule.

## Décision

```
price_cents = 100
  + floor(distance_m / 1000 * 37)
  + floor(duration_s / 60 * 22)

if price_cents < 400:
    price_cents = 400
```

- `100` = frais de collecte fixes (100 centimes).
- `37` = centimes par kilomètre (vélo, profil OSRM bicycle).
- `22` = centimes par minute (vélo, profil OSRM bicycle).
- **`floor()` appliqué séparément à la composante distance et à la
  composante durée**, jamais au total, jamais sur les entrées brutes
  (mètres/secondes) avant conversion.
- Minimum absolu : 400 centimes, appliqué après le calcul, jamais avant.
- Jamais de `float`/`number` fractionnaire stocké ou manipulé — toutes les
  variables intermédiaires sont des entiers en centimes ou des entiers en
  mètres/secondes.

## Exemples de vérification (tests unitaires obligatoires)

| Distance | Durée | Calcul | Résultat |
|---|---|---|---|
| 3 000 m | 720 s (12 min) | 100 + floor(3×37) + floor(12×22) = 100+111+264 | 475 |
| 500 m | 180 s (3 min) | 100 + floor(0.5×37)=18 + floor(3×22)=66 → 184 | **400** (plancher) |
| 7 000 m | 1500 s (25 min) | 100 + floor(7×37)=259 + floor(25×22)=550 | 909 |

`merchant_price_cents` et `driver_earning_cents` reçoivent la même valeur
(barème unique, pas de marge opérateur au lancement). Le prix est figé sur
la commande au moment du calcul et n'est jamais recalculé après coup.

## Conséquences

- Toute évolution du barème (nouvelle zone, marge opérateur future) passe
  par une nouvelle version de cette formule, versionnée sur la commande
  (champ à prévoir en Phase 2 : quelle règle tarifaire était active).
- Les tests de non-régression sur ces 3 exemples doivent passer avant tout
  merge touchant `modules/pricing/`.
