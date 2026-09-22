# ADR 0003 — Paiement carte à la livraison : Stripe Terminal, Direct Charge

Statut : validé — 2026-09-20 (gate lecteur physique G2 encore ouvert)

## Contexte

Le commerçant peut demander qu'un montant soit encaissé par carte à la remise. Le
livreur encaisse dans l'app Locadely avec un lecteur Stripe Terminal ; la commande
ne peut devenir `COMPLETED` que si le paiement est confirmé côté serveur.
Tap to Pay est abandonné : la cible est un lecteur physique (BBPOS WisePad 3, seul
lecteur mobile disponible en France ; le M2 est réservé aux États-Unis).

## Décision

- **Direct Charge** : PaymentIntent, Location et ConnectionToken appartiennent au
  compte du restaurant (`Stripe-Account`). Le restaurant supporte frais Stripe,
  remboursements et litiges ; Locadely ne prélève aucune commission sur ces
  paiements. Rejet de Destination Charge tant que le gate lecteur physique (G2) ne
  l'impose pas (Locadely supporterait frais, remboursements, litiges et solde négatif).
- **Un seul Account v2 par restaurant** : configuration `customer` (SEPA) + ajout de
  `merchant` sur opt-in, avec `dashboard=full`, `fees_collector=stripe`,
  `losses_collector=stripe` (valides ensemble ; non modifiables via l'API ensuite) et
  les capabilities `card_payments` et `cartes_bancaires_payments`.
- **Capture manuelle** : autorisation par le lecteur, capture par le serveur, fenêtre
  de 2 jours. Le serveur relit le PaymentIntent et valide compte, montant, devise,
  absence de frais plateforme/transfert avant de capturer.
- **Finalisation atomique** : une transaction met à jour paiement, session et commande
  (`COMPLETED`, `cash_on_delivery_collected_at`) ; aucune transaction PostgreSQL ne
  traverse un appel Stripe. Un CHECK en base interdit `COMPLETED` sans encaissement.
- **Abstraction lecteur** : le mobile n'utilise que `ReaderAdapter` ; le lecteur simulé
  officiel remplace uniquement le matériel en développement (refusé en production).

## Conséquences

- Après ajout de `merchant`, toute mise à jour d'identité de l'Account par l'API est
  refusée en France (`account_token_required`) : la synchronisation d'identité SEPA
  n'a lieu que tant que `merchant` est absent ; le mandat SEPA vient du
  `billing_details` du PaymentMethod.
- `dashboard=full` donne au restaurant les remboursements/litiges/versements dans
  Stripe. L'accès Dashboard réellement proposé aux comptes n'est pas encore vérifié
  (à résoudre avant toute promesse produit).
- **Gate G2 (obligatoire avant production et avant activation de `merchant` sur de
  vrais restaurants)** : le MÊME WisePad 3 doit pouvoir passer du compte A au compte
  B sous Direct (enregistrement à la Location à la connexion, non prouvé par la
  documentation). Si G2 échoue : Destination Charge avec lecteur/Location plateforme,
  ou un lecteur par restaurant — décision utilisateur requise.
- États de session/paiement persistés séparément de `orders.status` ; l'ADR 0001 n'est
  pas modifié (aucun nouvel état de commande).
