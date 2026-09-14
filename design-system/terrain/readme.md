# Terrain Design System

Direction visuelle **B — Terrain** : Rapide · Humain · Direct.

Design system complet pour un service de livraison last-mile B2B couvrant trois surfaces :
- **Espace commerçant** — web app mobile-first (restaurateurs, commerçants)
- **App livreur** — React Native iOS + Android (livreurs à vélo, en conditions réelles)
- **Admin back-office** — web desktop-first (opérateurs)

Implémentable avec **shadcn/ui + Tailwind CSS** (web) et **NativeWind** (React Native).

---

## Sources

Projet créé de zéro à partir d'un brief détaillé (pas de Figma ni codebase fourni).
Références visuelles : Stripe, Linear, Deliveroo, Shipday.

---

## Visual Foundations

### Couleurs
- **Primaire** : Emerald 600 `#059669` — couleur de livraison, confiance, action
- **Accent** : Amber 500 `#F59E0B` — urgence, temps, notification
- **Neutrals** : Stone (warm) — fonds légèrement chauds `#FDFCF8`, pas de gris froids
- **Background** : `#FDFCF8` (blanc cassé chaud), jamais blanc pur
- **Sémantiques** : success=vert primaire, warning=amber, error=rouge, info=bleu

### Typographie
- **Famille unique** : DM Sans (Google Fonts) — ronde, lisible, humaine
- Tous les niveaux de `Display 48px` à `Caption 11px` avec la même famille
- Poids : Regular 400, Medium 500, Semibold 600, Bold 700
- Espacement négatif sur les titres (`-0.02em`) pour la densité mobile

### Espacements
- Base 4px. Tous les espacements sont multiples de 4.
- Marges page : 16px mobile, 24px tablette, 32px desktop
- Touch targets minimum : 44×44px (WCAG AA)

### Bordures et coins
- **Radius principal** : `14px` (boutons, cards mobiles)
- **Radius secondaire** : `10px` (inputs, badges, éléments imbriqués)
- **Radius petits éléments** : `6px` (tags, petits badges)
- Pas de coins carrés. Pas de pilules sur les boutons principaux.

### Ombres
- Subtiles, teintées warm stone `rgba(41,37,36,…)` — jamais grises froides
- 5 niveaux : xs → xl. Cards = `shadow-md`. Modals = `shadow-xl`.

### Animations
- Easing custom `cubic-bezier(0.16, 1, 0.3, 1)` — settle rapide, départ doux
- Spring pour les éléments interactifs (sliders, bottom sheets)
- Durées : fast 120ms, base 200ms, slow 350ms
- Hover : assombrissement léger (`--color-primary-700`)
- Press : légère réduction de scale (`scale(0.98)`)

### Backgrounds & texture
- Fonds plats, jamais de gradients sur les grandes surfaces
- Cards : fond blanc `#fff` sur fond `#FDFCF8` — contraste subtil
- Séparateurs : `#E7E0D5` (bord warm)
- Accent de couleur : barre top ou bord gauche sur les cards importantes

### Iconographie
Pas d'icon set intégré fourni. Recommandations :
- **Lucide Icons** pour le web (cohérent avec shadcn/ui)
- **Lucide React Native** pour l'app livreur
- Trait fin (1.5px stroke), style outline, taille minimum 20px
- Emoji : jamais dans l'UI de production (sauf notifications push)

---

## Content Fundamentals

- **Voix** : directe, courte, active — "Commander un livreur" pas "Lancer une demande de livraison"
- **Casse** : Majuscule uniquement en début de phrase + noms propres. Pas de TOUT MAJUSCULE sauf labels de statut.
- **Chiffres** : toujours en chiffres arabes (`3 livraisons`, jamais `trois`)
- **Durées** : format court `~12 min`, `2h30`
- **Adresses** : abréviées quand l'espace manque (`12 r. de la Paix`)
- **Statuts** : première lettre majuscule, pas d'abréviation (`En attente`, pas `Att.`)
- **Ton** : rassurant mais efficace — un restaurant doit se sentir en confiance en 2 secondes

---

## Système de statuts

| Statut             | Background               | Texte                    | Dot           |
|--------------------|--------------------------|--------------------------|---------------|
| En attente         | Amber 100 `#FEF3C7`      | Amber 800 `#92400E`      | Amber 500     |
| Livreur attribué   | Blue 100 `#DBEAFE`       | Blue 700 `#1D4ED8`       | Blue 600      |
| En cours           | Emerald 600 `#059669`    | Blanc `#FFFFFF`          | Blanc         |
| Livré              | Emerald 50 `#ECFDF5`     | Emerald 800 `#065F46`    | Emerald 600   |
| Payé               | Emerald 100 `#D1FAE5`    | Emerald 800 `#065F46`    | Emerald 700   |
| Retour restaurant  | Orange 100 `#FFEDD5`     | Orange 700 `#C2410C`     | Orange 500    |
| Annulé             | Red 100 `#FEE2E2`        | Red 700 `#B91C1C`        | Red 500       |

---

## Règles d'usage par surface

### Espace commerçant (mobile-first)
- Radius : 14px primary
- Density : légère, gros boutons (height: 52px)
- Bottom sheet pour les actions contextuelles
- Bottom navigation masquée, retours via header
- Cards : shadow-md, coins 16px

### App livreur (React Native)
- Touch targets : 52px minimum
- Texte : jamais sous 16px (lisibilité en plein soleil)
- Slider "glisser pour prendre" — interaction principale
- Bottom navigation fixe : 3 onglets
- Contraste renforcé : fond très sombre ou très clair

### Admin back-office (desktop)
- Density : compacte, grille dense, sidebar fixe
- Boutons : height 36px (sm)
- Tables avec row hover
- Sidebar rétractable (280px → 60px icônes)

---

## Intentional additions

- `DeliverySlider` — composant "glisser pour confirmer" spécifique livreur, absent des libs standard
- `MapMarker` — marqueur carte avec badge quantité et variantes couleur par type

---

## Composants disponibles dans le projet Claude Design

Source : `https://claude.ai/design/p/8082e53d-2af2-4f09-abb9-ea1fd8514d5a`

```
components/
  core/          Badge, Button, Input, Toast
  navigation/    BottomNav, Sidebar
  delivery/      DeliverySlider, MapMarker, OrderCard
guidelines/      colors-neutral, colors-primary, colors-semantic, effects, spacing, status-system, typography-scale
```

Chaque composant a un `.jsx`, un `.d.ts` (types) et un `.prompt.md` (spec de génération) dans le projet Claude Design.
Non téléchargés dans ce repo à ce stade — à récupérer via le MCP `DesignSync` (`get_file`) au moment de construire les écrans concernés en Phase 2/3, pour rester synchronisé avec la dernière version publiée.

## Structure du projet (Claude Design)

```
styles.css              ← entry point global
tokens/                 ← CSS custom properties (copiés ici)
  colors.css
  typography.css
  spacing.css
  effects.css
components/
  core/                 ← Button, Badge, Input, Toast
  navigation/           ← BottomNav, Sidebar
  delivery/             ← OrderCard, DeliverySlider, MapMarker
guidelines/             ← cards de foundation
tailwind.config.ts      ← config Tailwind complète (copié ici)
globals.css             ← variables shadcn/ui (copié ici)
```
