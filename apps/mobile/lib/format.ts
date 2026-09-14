export function formatDistanceKm(distanceM: number): string {
  return `${(distanceM / 1000).toFixed(1).replace('.', ',')} km`;
}

export function formatDurationMin(durationS: number): string {
  return `${Math.round(durationS / 60)} min`;
}

export function formatPriceEuros(priceCents: number): string {
  return `${(priceCents / 100).toFixed(2).replace('.', ',')} €`;
}

// Historique du wallet : une commande terminée il y a plusieurs jours n'a
// pas besoin d'une ancienneté relative (voir formatRelativeMinutes) — une
// date+heure absolue est plus lisible pour un relevé de gains.
export function formatEarningDate(isoDate: string): string {
  const date = new Date(isoDate);
  const day = date.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' });
  const time = date.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  return `${day} à ${time}`;
}

export function formatFullDate(isoDate: string): string {
  const date = new Date(isoDate);
  const dateLabel = date.toLocaleDateString('fr-FR', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'Europe/Paris'
  });
  const timeLabel = date.toLocaleTimeString('fr-FR', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Europe/Paris'
  }).replace(':', 'h');
  return `${dateLabel.charAt(0).toLocaleUpperCase('fr-FR')}${dateLabel.slice(1)} à ${timeLabel}`;
}

// pickupScheduledAt est toujours résolu côté API (jamais NULL pour une
// commande créée après cette fonctionnalité) — NULL signale seulement une
// commande antérieure à la migration, non rétro-remplie. Une commande "dès
// que possible" a un pickupScheduledAt réel mais quasi identique à
// createdAt (résolu à NOW() côté serveur) : on la détecte par tolérance
// plutôt que d'afficher une heure qui serait essentiellement "maintenant".
const ASAP_TOLERANCE_MS = 60_000;

export function formatPickupLabel(pickupScheduledAt: string | null, createdAt: string): string {
  if (pickupScheduledAt === null) return 'Dès que possible';
  const scheduledMs = new Date(pickupScheduledAt).getTime();
  const createdMs = new Date(createdAt).getTime();
  if (Math.abs(scheduledMs - createdMs) <= ASAP_TOLERANCE_MS) return 'Dès que possible';
  const time = new Date(pickupScheduledAt).toLocaleTimeString('fr-FR', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Europe/Paris'
  });
  return time.replace(':', 'h');
}

export function formatEstimatedDelivery(collectedAt: string | null, durationS: number): string | null {
  if (collectedAt === null) return null;

  const collectedAtMs = new Date(collectedAt).getTime();
  if (Number.isNaN(collectedAtMs)) return null;

  const time = new Date(collectedAtMs + durationS * 1_000).toLocaleTimeString('fr-FR', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Europe/Paris'
  });
  return `vers ${time.replace(':', 'h')}`;
}

// Le domaine Order n'a pas de deadline de collecte — seulement createdAt.
// On affiche donc une ancienneté relative plutôt qu'un délai inventé.
export function formatRelativeMinutes(isoDate: string): string {
  const minutes = Math.max(0, Math.round((Date.now() - new Date(isoDate).getTime()) / 60_000));
  if (minutes < 1) return "à l'instant";
  if (minutes === 1) return 'il y a 1 min';
  return `il y a ${minutes} min`;
}
