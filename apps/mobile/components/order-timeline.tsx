import { Check, CircleX, MapPin, Package, Store, Undo2 } from 'lucide-react-native';
import { Pressable, Text, View } from 'react-native';
import { EMERALD_600, STONE_500 } from '../lib/colors';
import type { DriverOrder } from '../lib/orders-types';

type TimelineNodeKind = 'pickup' | 'delivery' | 'return' | 'cancelled';
type TimelineNodeState = 'done' | 'current' | 'upcoming' | 'cancelled';

type TimelineNode = {
  id: string;
  order: DriverOrder;
  kind: TimelineNodeKind;
  state: TimelineNodeState;
  at: number;
  title: string;
  address: string;
  connector: 'solid' | 'dotted' | 'none';
  isAnchor: boolean;
};

const ASAP_PICKUP_DELAY_MS = 15 * 60 * 1_000;

function getPickupTime(order: DriverOrder, now: number): number {
  if (order.pickupScheduledAt === null) return now + ASAP_PICKUP_DELAY_MS;
  const scheduledAt = new Date(order.pickupScheduledAt).getTime();
  return Number.isNaN(scheduledAt) ? now + ASAP_PICKUP_DELAY_MS : scheduledAt;
}

function formatTime(timestamp: number): string {
  return new Date(timestamp)
    .toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris' })
    .replace(':', 'h');
}

/**
 * Construit une séquence affichable à partir des commandes déjà assignées au
 * livreur. La valeur `now` est capturée une seule fois par rendu : toutes les
 * commandes ASAP restent donc cohérentes entre elles pour le tri et l'heure.
 */
function buildTimelineNodes(orders: DriverOrder[], now: number): TimelineNode[] {
  const sortedOrders = [...orders].sort((first, second) => getPickupTime(first, now) - getPickupTime(second, now));
  const currentOrderId =
    sortedOrders.find((order) => order.status === 'COLLECTED' || order.status === 'RETURNING')?.id ??
    sortedOrders.find((order) => order.status === 'ASSIGNED')?.id;
  const fallbackOrderId = currentOrderId === undefined
    ? [...sortedOrders].sort(
      (first, second) =>
        new Date(second.completedAt ?? second.updatedAt).getTime() - new Date(first.completedAt ?? first.updatedAt).getTime()
    )[0]?.id
    : undefined;

  const nodes: TimelineNode[] = [];
  for (const [index, order] of sortedOrders.entries()) {
    const pickupAt = getPickupTime(order, now);
    const deliveryAt = pickupAt + order.durationS * 1_000;
    const hasNextOrder = index < sortedOrders.length - 1;
    const isCurrent = order.id === currentOrderId;

    if (order.status === 'CANCELLED') {
      nodes.push({
        id: `${order.id}:cancelled`,
        order,
        kind: 'cancelled',
        state: 'cancelled',
        at: pickupAt,
        title: 'Commande annulée',
        address: order.pickupAddress,
        connector: hasNextOrder ? 'dotted' : 'none',
        isAnchor: order.id === fallbackOrderId
      });
      continue;
    }

    const pickupState: TimelineNodeState =
      order.status === 'COMPLETED' || order.status === 'RETURNED' || order.status === 'RETURNING' || order.status === 'COLLECTED'
        ? 'done'
        : isCurrent
          ? 'current'
          : 'upcoming';

    nodes.push({
      id: `${order.id}:pickup`,
      order,
      kind: 'pickup',
      state: pickupState,
      at: pickupAt,
      title: order.merchantName,
      address: order.pickupAddress,
      connector: 'solid',
      isAnchor: pickupState === 'current'
    });

    if (order.status === 'RETURNING' || order.status === 'RETURNED') {
      nodes.push({
        id: `${order.id}:return`,
        order,
        kind: 'return',
        state: order.status === 'RETURNED' ? 'done' : isCurrent ? 'current' : 'upcoming',
        at: deliveryAt,
        title: 'Retour au commerce',
        address: order.pickupAddress,
        connector: hasNextOrder ? 'dotted' : 'none',
        isAnchor: order.id === fallbackOrderId || (order.status === 'RETURNING' && isCurrent)
      });
    } else {
      nodes.push({
        id: `${order.id}:delivery`,
        order,
        kind: 'delivery',
        // Une commande ASSIGNED est encore au stade collecte : seul son
        // nœud pickup est courant. La livraison ne devient mise en avant
        // qu'après la transition COLLECTED.
        state: order.status === 'COMPLETED' ? 'done' : order.status === 'COLLECTED' && isCurrent ? 'current' : 'upcoming',
        at: deliveryAt,
        title: 'Livraison',
        address: order.deliveryAddress,
        connector: hasNextOrder ? 'dotted' : 'none',
        isAnchor: order.id === fallbackOrderId || (order.status === 'COLLECTED' && isCurrent)
      });
    }
  }
  return nodes;
}

function NodeIcon({ kind, state }: Pick<TimelineNode, 'kind' | 'state'>) {
  if (state === 'done') return <Check size={15} color="#FFFFFF" strokeWidth={3} />;
  if (kind === 'return') return <Undo2 size={15} color="#FFFFFF" />;
  if (kind === 'cancelled') return <CircleX size={15} color="#FFFFFF" />;
  return kind === 'pickup' ? <Store size={15} color="#FFFFFF" /> : <Package size={15} color="#FFFFFF" />;
}

function nodeColors(kind: TimelineNodeKind, state: TimelineNodeState): { dot: string; time: string; title: string } {
  if (state === 'cancelled') return { dot: '#A8A29E', time: '#78716C', title: '#78716C' };
  // Une étape validée reste présente et tappable, mais son vert désaturé
  // évite de la confondre avec l'étape réellement en cours.
  if (state === 'done') return { dot: '#8BAF9C', time: '#5F7A6C', title: '#5F7A6C' };
  if (state === 'current') return kind === 'return'
    ? { dot: '#EA580C', time: '#C2410C', title: '#9A3412' }
    : { dot: kind === 'pickup' ? EMERALD_600 : '#2563EB', time: '#1D4ED8', title: '#1E3A8A' };
  if (kind === 'return') return { dot: '#F97316', time: '#C2410C', title: '#9A3412' };
  return kind === 'pickup'
    ? { dot: EMERALD_600, time: '#44403C', title: '#292524' }
    : { dot: '#3B82F6', time: '#44403C', title: '#292524' };
}

function TimelineItem({
  node,
  onPress,
  onCurrentNodeLayout
}: {
  node: TimelineNode;
  onPress: (order: DriverOrder) => void;
  onCurrentNodeLayout?: ((y: number) => void) | undefined;
}) {
  const colors = nodeColors(node.kind, node.state);
  const connectorStyle = node.connector === 'solid' ? { backgroundColor: colors.dot } : { borderColor: '#A8A29E' };
  const isCurrent = node.state === 'current';

  return (
    <View
      className="flex-row"
      onLayout={node.isAnchor ? (event) => onCurrentNodeLayout?.(event.nativeEvent.layout.y) : undefined}
    >
      <View className="w-14 items-center">
        <View style={{ backgroundColor: colors.dot }} className="h-7 w-7 items-center justify-center rounded-full">
          <NodeIcon kind={node.kind} state={node.state} />
        </View>
        {node.connector !== 'none' && (
          <View
            style={connectorStyle}
            className={`min-h-8 w-0.5 flex-1 ${node.connector === 'dotted' ? 'border-l-2 border-dashed bg-transparent' : ''}`}
          />
        )}
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${node.title}, ${node.address}`}
        onPress={() => onPress(node.order)}
        className={`mb-3 min-h-touch-comfortable flex-1 rounded-xl border px-3 py-2.5 active:opacity-75 ${
          isCurrent ? 'border-primary-600 bg-primary-50' : 'border-border bg-surface'
        }`}
      >
        <View className="flex-row items-baseline gap-2">
          <Text style={{ color: colors.time }} className="font-sans-bold text-body-lg">{formatTime(node.at)}</Text>
          <Text style={{ color: colors.title }} className="flex-1 font-sans-semibold text-body-lg" numberOfLines={1}>
            {node.kind === 'pickup' ? node.title : node.kind === 'delivery' ? 'Livraison' : node.title}
          </Text>
          {isCurrent && <Text className="font-sans-bold text-body text-primary-700">▶</Text>}
        </View>
        <View className="mt-1 flex-row items-start gap-1.5">
          <MapPin size={16} color={node.kind === 'pickup' ? EMERALD_600 : STONE_500} />
          <Text className="flex-1 font-sans text-body text-stone-600">{node.address}</Text>
        </View>
      </Pressable>
    </View>
  );
}

export function OrderTimeline({
  orders,
  onPressOrder,
  onCurrentNodeLayout
}: {
  orders: DriverOrder[];
  onPressOrder: (order: DriverOrder) => void;
  onCurrentNodeLayout?: (y: number) => void;
}) {
  const nodes = buildTimelineNodes(orders, Date.now());
  return (
    <View className="pt-4">
      {nodes.map((node) => (
        <TimelineItem key={node.id} node={node} onPress={onPressOrder} onCurrentNodeLayout={onCurrentNodeLayout} />
      ))}
    </View>
  );
}
