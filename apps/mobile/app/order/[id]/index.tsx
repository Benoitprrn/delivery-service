import { useLocalSearchParams, useRouter } from 'expo-router';
import {
  Bike,
  CircleX,
  Clock,
  Euro,
  Package,
  PackageCheck,
  Route,
  Undo2,
  X,
  CreditCard,
} from 'lucide-react-native';
import { ActivityIndicator, Alert, Linking, Pressable, ScrollView, Text, View } from 'react-native';
import { useEffect, useState } from 'react';
import { SafeAreaView } from 'react-native-safe-area-context';
import { ApiError, api, type DriverOrderDocuments } from '../../../lib/api';
import { BLUE_500, EMERALD_600, STONE_500, WHITE } from '../../../lib/colors';
import { DetailsSection, PickupDeliverySummary, RecipientCard, SenderCard } from '../../../components/order-detail-sections';
import { HoldActionButton } from '../../../components/hold-action-button';
import { documentStatusLabel } from '../../../lib/document-status';
import {
  formatDeliveryTimeEstimate,
  formatDistanceKm,
  formatDurationMin,
  formatPickupLabel,
  formatPriceEuros,
} from '../../../lib/format';
import { openMaps, openPhone } from '../../../lib/native-links';
import type { DriverOrder, OrderStatus } from '../../../lib/orders-types';
import { showToast } from '../../../lib/toast';

const RECIPIENT_VISIBLE_STATUSES = new Set(['COLLECTED', 'RETURNING', 'RETURNED']);

function StatusBadge({ status }: { status: OrderStatus }) {
  if (status === 'ASSIGNED') {
    return (
      <View className="flex-row items-center gap-1.5 self-start rounded-full bg-status-assigned-bg px-3 py-1.5">
        <Bike size={16} color="#1D4ED8" />
        <Text className="font-sans-semibold text-body-lg text-status-assigned-text">
          En route vers collecte
        </Text>
      </View>
    );
  }
  if (status === 'COLLECTED') {
    return (
      <View className="flex-row items-center gap-1.5 self-start rounded-full bg-status-active-bg px-3 py-1.5">
        <PackageCheck size={16} color="#FFFFFF" />
        <Text className="font-sans-semibold text-body-lg text-status-active-text">
          Colis récupéré
        </Text>
      </View>
    );
  }
  if (status === 'RETURNING' || status === 'RETURNED') {
    return (
      <View className="flex-row items-center gap-1.5 self-start rounded-full bg-status-return-bg px-3 py-1.5">
        <Undo2 size={16} color="#C2410C" />
        <Text className="font-sans-semibold text-body-lg text-status-return-text">
          {status === 'RETURNING' ? 'Retour en cours' : 'Retourné'}
        </Text>
      </View>
    );
  }
  if (status === 'COMPLETED') {
    return (
      <View className="flex-row items-center gap-1.5 self-start rounded-full bg-status-delivered-bg px-3 py-1.5">
        <PackageCheck size={16} color="#059669" />
        <Text className="font-sans-semibold text-body-lg text-status-delivered-text">Livrée</Text>
      </View>
    );
  }
  if (status === 'CANCELLED') {
    return (
      <View className="flex-row items-center gap-1.5 self-start rounded-full bg-status-cancelled-bg px-3 py-1.5">
        <CircleX size={16} color="#B91C1C" />
        <Text className="font-sans-semibold text-body-lg text-status-cancelled-text">Annulée</Text>
      </View>
    );
  }
  return (
    <View className="self-start rounded-full bg-status-pending-bg px-3 py-1.5">
      <Text className="font-sans-semibold text-body-lg text-status-pending-text">Disponible</Text>
    </View>
  );
}

function parseOrder(raw: string | string[] | undefined): DriverOrder | null {
  if (typeof raw !== 'string') return null;
  try {
    return JSON.parse(raw) as DriverOrder;
  } catch {
    return null;
  }
}

export default function OrderDetailModal() {
  const router = useRouter();
  const { order: orderParam } = useLocalSearchParams<{
    id: string;
    order?: string;
  }>();
  const order = parseOrder(orderParam);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [documents, setDocuments] = useState<DriverOrderDocuments | null>(null);
  const [expandedSection, setExpandedSection] = useState<'order' | 'driver' | null>(null);

  useEffect(() => {
    if (order === null || order.status !== 'COMPLETED') return;
    void api.getOrderDocuments(order.id).then(setDocuments).catch(() => setDocuments(null));
  }, [order?.id, order?.status]);

  async function openFacturX(documentId: string, kind: 'invoice' | 'credit_note') {
    if (order === null) return;
    try {
      const { url } = await api.getInvoiceDocumentFacturXUrl(order.id, documentId, kind);
      await Linking.openURL(url);
    } catch (err) {
      showToast(err instanceof ApiError && err.status === 409 ? 'Le document n’est pas encore prêt. Réessayez plus tard.' : 'Impossible d’ouvrir le document.');
    }
  }

  async function handleCollect() {
    if (order === null) return;
    setIsSubmitting(true);
    try {
      await api.collectOrder(order.id, order.version);
      showToast('Collecte confirmée ✓');
      router.back();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Impossible de confirmer la collecte.');
    } finally {
      setIsSubmitting(false);
    }
  }

  function handleComplete() {
    if (order === null) return;
    router.push({
      pathname: '/order/[id]/proof',
      params: {
        id: order.id,
        publicReference: order.publicReference,
        version: String(order.version),
        ...(order.cashOnDelivery?.required === true && order.cashOnDelivery.amountCents !== null
          ? { codAmountCents: String(order.cashOnDelivery.amountCents) }
          : {}),
      },
    });
  }

  async function handleUnassign() {
    if (order === null) return;
    setIsSubmitting(true);
    try {
      await api.unassignOrder(order.id, order.version);
      showToast('Course annulée');
      router.back();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Impossible d’annuler la course.');
    } finally {
      setIsSubmitting(false);
    }
  }

  function confirmUnassign() {
    Alert.alert(
      'Annuler cette course ?',
      'Elle repartira dans la recherche de livreur. Cette action est irréversible.',
      [
        { text: 'Retour', style: 'cancel' },
        { text: 'Annuler la course', style: 'destructive', onPress: () => void handleUnassign() },
      ],
    );
  }

  async function handleConfirmReturn() {
    if (order === null) return;
    setIsSubmitting(true);
    try {
      await api.confirmReturn(order.id, order.version);
      showToast('Retour confirmé ✓');
      router.back();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Impossible de confirmer le retour.');
    } finally {
      setIsSubmitting(false);
    }
  }

  if (order === null) {
    return (
      <SafeAreaView className="flex-1 items-center justify-center gap-4 bg-background px-page-mobile">
        <Text className="text-center font-sans text-body-lg text-stone-500">
          Détail de la commande indisponible.
        </Text>
        <Pressable
          onPress={() => router.back()}
          className="h-touch-comfortable items-center justify-center rounded-lg bg-primary-600 px-6 active:bg-primary-700"
        >
          <Text className="font-sans-bold text-body-lg text-white">Retour</Text>
        </Pressable>
      </SafeAreaView>
    );
  }

  const recipientVisible = RECIPIENT_VISIBLE_STATUSES.has(order.status);

  return (
    <SafeAreaView className="flex-1 bg-background">
      <View className="flex-row items-center justify-between px-page-mobile py-3">
        <Text className="font-sans text-body-lg text-stone-400">#{order.publicReference}</Text>
        <View className="flex-row items-center gap-1">
          {order.status === 'ASSIGNED' && (
            <Pressable
              onPress={confirmUnassign}
              disabled={isSubmitting}
              className="h-touch-comfortable items-center justify-center px-2 disabled:opacity-50"
            >
              <Text className="font-sans-semibold text-body text-red-600">Annuler</Text>
            </Pressable>
          )}
          <Pressable
            accessibilityLabel="Fermer le détail de la commande"
            onPress={() => router.back()}
            className="h-touch-comfortable w-touch-comfortable items-center justify-center"
          >
            <X size={24} color="#57534E" />
          </Pressable>
        </View>
      </View>

      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: 16,
          paddingBottom: 24,
          gap: 20,
        }}
      >
        <StatusBadge status={order.status} />

        <PickupDeliverySummary
          pickupLabel={formatPickupLabel(order.pickupScheduledAt, order.createdAt)}
          deliveryLabel={formatDeliveryTimeEstimate(order.pickupScheduledAt, order.createdAt, order.collectedAt, order.durationS)}
        />

        {order.cashOnDelivery?.required === true && order.cashOnDelivery.amountCents !== null && (
          <View className="flex-row items-center gap-3 rounded-xl border border-accent-200 bg-accent-100 p-4">
            <View className="h-11 w-11 items-center justify-center rounded-full bg-accent-200">
              <CreditCard size={22} color="#B45309" />
            </View>
            <View className="flex-1 gap-0.5">
              <Text className="font-sans-semibold text-body text-accent-800">Encaissement à la livraison</Text>
              <Text className="font-sans text-body text-accent-700">
                {order.cashOnDelivery.collected ? 'Encaissé par carte.' : 'À encaisser par carte au moment de la remise.'}
              </Text>
            </View>
            <Text className="font-sans-bold text-body-lg text-accent-800">{formatPriceEuros(order.cashOnDelivery.amountCents)}</Text>
          </View>
        )}

        <SenderCard
          merchantName={order.merchantName}
          merchantPhone={order.merchantPhone}
          pickupAddress={order.pickupAddress}
          onOpenPhone={(phone) => void openPhone(phone)}
          onOpenMaps={() =>
            void openMaps({ latitude: order.pickupLat, longitude: order.pickupLng, label: order.merchantName })
          }
        />

        <RecipientCard
          masked={!recipientVisible}
          customerName={order.customerName}
          customerPhone={order.customerPhone}
          deliveryAddress={order.deliveryAddress}
          deliveryAddressComplement={order.deliveryAddressComplement}
          onOpenPhone={(phone) => void openPhone(phone)}
          onOpenMaps={() =>
            void openMaps({ latitude: order.deliveryLat, longitude: order.deliveryLng, label: order.deliveryAddress })
          }
        />

        <DetailsSection
          title="Détails commande"
          icon={<Package size={20} color={EMERALD_600} />}
          expanded={expandedSection === 'order'}
          onToggle={() => setExpandedSection((current) => (current === 'order' ? null : 'order'))}
        >
          {order.orderDetails !== null && order.orderDetails.trim().length > 0 && (
            <Text className="font-sans text-body-lg text-stone-800">{order.orderDetails}</Text>
          )}
        </DetailsSection>

        <DetailsSection
          title="Informations livreur"
          icon={<Route size={20} color={BLUE_500} />}
          expanded={expandedSection === 'driver'}
          onToggle={() => setExpandedSection((current) => (current === 'driver' ? null : 'driver'))}
        >
          <View className="gap-1">
            <Text className="font-sans-semibold text-body text-stone-500">Référence</Text>
            <Text className="font-sans text-body-lg text-stone-800">#{order.publicReference}</Text>
          </View>
          {order.deliveryInstructions !== null && order.deliveryInstructions.trim().length > 0 && (
            <View className="gap-1">
              <Text className="font-sans-semibold text-body text-stone-500">Consignes de livraison</Text>
              <Text className="rounded-lg bg-stone-100 p-3 font-sans text-body text-stone-700">
                {order.deliveryInstructions}
              </Text>
            </View>
          )}
        </DetailsSection>

        {documents !== null && documents.invoices[0] !== undefined && (
          <View className="gap-3 rounded-2xl border border-border bg-surface p-4">
            <Text className="font-sans-semibold text-body-lg text-stone-500">Facturation</Text>
            {documents.invoices.map((invoice) => (
              <View key={invoice.id} className="flex-row items-center gap-2">
                <View className="flex-1">
                  <Text className="font-sans-bold text-h3 text-stone-800">Facture {invoice.number}</Text>
                  <Text className="font-sans text-body-lg text-stone-600">Statut : {documentStatusLabel(invoice)}</Text>
                </View>
                {invoice.facturXAvailable && (
                  <Pressable onPress={() => void openFacturX(invoice.id, 'invoice')} className="min-h-touch-comfortable justify-center px-2">
                    <Text className="font-sans-bold text-body-lg text-primary-700">Voir</Text>
                  </Pressable>
                )}
              </View>
            ))}
            {documents.creditNotes.map((credit) => (
              <View key={credit.id} className="flex-row items-center gap-2">
                <View className="flex-1">
                  <Text className="font-sans text-body-lg text-stone-600">
                    Avoir {credit.number} (facture {credit.originalInvoiceNumber})
                  </Text>
                  <Text className="font-sans text-body text-stone-500">{documentStatusLabel(credit)}</Text>
                </View>
                {credit.facturXAvailable && (
                  <Pressable onPress={() => void openFacturX(credit.id, 'credit_note')} className="min-h-touch-comfortable justify-center px-2">
                    <Text className="font-sans-bold text-body-lg text-primary-700">Voir</Text>
                  </Pressable>
                )}
              </View>
            ))}
          </View>
        )}
        <View className="flex-row gap-3 rounded-2xl border border-border bg-surface p-4">
          <View className="flex-1 gap-1">
            <Route size={20} color={STONE_500} />
            <Text className="font-sans-semibold text-body text-stone-500">Distance</Text>
            <Text className="font-sans-bold text-body-lg text-stone-800">{formatDistanceKm(order.distanceM)}</Text>
          </View>
          <View className="flex-1 gap-1 border-l border-border pl-3">
            <Clock size={20} color={BLUE_500} />
            <Text className="font-sans-semibold text-body text-stone-500">Durée</Text>
            <Text className="font-sans-bold text-body-lg text-stone-800">{formatDurationMin(order.durationS)}</Text>
          </View>
          <View className="flex-1 gap-1 border-l border-border pl-3">
            <Euro size={20} color={EMERALD_600} />
            <Text className="font-sans-semibold text-body text-stone-500">Gain</Text>
            <Text className="font-sans-bold text-body-lg text-primary-700">
              {formatPriceEuros(order.deliveryCents ?? order.priceCents)}
            </Text>
          </View>
        </View>
      </ScrollView>

      {order.status === 'ASSIGNED' && (
        <View className="flex-row px-page-mobile pb-6 pt-2">
          <HoldActionButton
            label="J&apos;ai collecté le colis"
            variant="primary"
            disabled={isSubmitting}
            onComplete={handleCollect}
          />
        </View>
      )}
      {order.status === 'COLLECTED' && (
        <View className="flex-row px-page-mobile pb-6 pt-2">
          <HoldActionButton
            label="Livraison effectuée"
            variant="primary"
            disabled={isSubmitting}
            onComplete={async () => handleComplete()}
          />
        </View>
      )}
      {order.status === 'RETURNING' && (
        <View className="px-page-mobile pb-6 pt-2">
          <Pressable
            onPress={() => void handleConfirmReturn()}
            disabled={isSubmitting}
            className="h-touch-comfortable items-center justify-center rounded-lg bg-red-600 active:bg-red-700 disabled:opacity-50"
          >
            {isSubmitting ? (
              <ActivityIndicator color={WHITE} />
            ) : (
              <Text className="font-sans-bold text-body-lg text-white">
                J&apos;ai retourné le colis
              </Text>
            )}
          </Pressable>
        </View>
      )}
    </SafeAreaView>
  );
}
