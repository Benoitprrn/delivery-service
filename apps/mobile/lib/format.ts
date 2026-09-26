export function formatDistanceKm(distanceM: number): string {
  return `${(distanceM / 1000).toFixed(1).replace('.', ',')} km`;
}

export function formatDurationMin(durationS: number): string {
  return `${Math.round(durationS / 60)} min`;
}

export function formatPriceEuros(priceCents: number): string {
  const sign = priceCents < 0 ? '-' : '';
  const absoluteCents = Math.abs(priceCents);
  return `${sign}${Math.trunc(absoluteCents / 100)},${String(absoluteCents % 100).padStart(2, '0')} €`;
}

function parisDateParts(isoDate: string): { day: string; month: string; year: string } | null {
  // Les bornes de période sont des jours calendaires (`YYYY-MM-DD`) : les
  // interpréter à midi UTC évite qu’un décalage Europe/Paris les fasse basculer.
  const calendarMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  const date = calendarMatch === null
    ? new Date(isoDate)
    : new Date(Date.UTC(Number(calendarMatch[1]), Number(calendarMatch[2]) - 1, Number(calendarMatch[3]), 12));
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat('fr-FR', {
    timeZone: 'Europe/Paris', day: 'numeric', month: 'long', year: 'numeric'
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return typeof values.day === 'string' && typeof values.month === 'string' && typeof values.year === 'string'
    ? { day: values.day, month: values.month, year: values.year }
    : null;
}

export function formatSettlementDate(isoDate: string): string {
  const parts = parisDateParts(isoDate);
  return parts === null ? 'date inconnue' : `${parts.day} ${parts.month} ${parts.year}`;
}

export function formatSettlementPeriod(periodStart: string, periodEnd: string): string {
  const start = parisDateParts(periodStart);
  // La fin d'une période est EXCLUSIVE (lundi 00:00 Paris suivant) : le dernier jour affiché est la veille.
  const endTime = new Date(periodEnd).getTime();
  const end = parisDateParts(Number.isNaN(endTime) ? periodEnd : new Date(endTime - 12 * 3_600_000).toISOString());
  if (start === null || end === null) return 'Période clôturée';
  return start.month === end.month && start.year === end.year
    ? `du ${start.day} au ${end.day} ${end.month}`
    : `du ${start.day} ${start.month} au ${end.day} ${end.month}`;
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

// Estimation livraison utilisable avant ET après collecte : réelle (depuis collectedAt) une
// fois collectée, sinon projetée depuis l'heure de collecte prévue/création (même commande
// avant acceptation, écran dispatch-offer).
export function formatDeliveryTimeEstimate(
  pickupScheduledAt: string | null,
  createdAt: string,
  collectedAt: string | null,
  durationS: number
): string {
  const real = formatEstimatedDelivery(collectedAt, durationS);
  if (real !== null) return real.replace('vers ', '');

  const collectionAt = pickupScheduledAt ?? createdAt;
  const estimatedAtMs = new Date(collectionAt).getTime() + durationS * 1_000;
  if (Number.isNaN(estimatedAtMs)) return `+ ${formatDurationMin(durationS)}`;

  const time = new Date(estimatedAtMs).toLocaleTimeString('fr-FR', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Europe/Paris'
  });
  return time.replace(':', 'h');
}

// Le domaine Order n'a pas de deadline de collecte — seulement createdAt.
// On affiche donc une ancienneté relative plutôt qu'un délai inventé.
export function formatRelativeMinutes(isoDate: string): string {
  const minutes = Math.max(0, Math.round((Date.now() - new Date(isoDate).getTime()) / 60_000));
  if (minutes < 1) return "à l'instant";
  if (minutes === 1) return 'il y a 1 min';
  return `il y a ${minutes} min`;
}
