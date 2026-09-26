import { CircleAlert, CircleCheck, CreditCard } from 'lucide-react-native';
import { Text, View } from 'react-native';
import { EMERALD_600 } from '../lib/colors';
import type { PayoutTone, PayoutUi } from '../lib/payout-status';

const TONE_STYLES: Record<PayoutTone, { box: string; title: string }> = {
  success: { box: 'border-primary-600/30 bg-primary-100', title: 'text-primary-700' },
  warning: { box: 'border-amber-300 bg-amber-100', title: 'text-amber-800' },
  danger: { box: 'border-red-300 bg-red-50', title: 'text-red-700' },
  neutral: { box: 'border-border bg-surface', title: 'text-stone-800' }
};

function ToneIcon({ tone, size }: { tone: PayoutTone; size: number }) {
  if (tone === 'success') return <CircleCheck size={size} color={EMERALD_600} />;
  if (tone === 'danger') return <CircleAlert size={size} color="#B91C1C" />;
  if (tone === 'warning') return <CircleAlert size={size} color="#B45309" />;
  return <CreditCard size={size} color="#78716C" />;
}

// Carte d'état des paiements : libellés sans jargon (voir lib/payout-status.ts), même rendu dans le hub et les paiements.
export function PayoutStatusCard({ ui }: { ui: PayoutUi }) {
  const style = TONE_STYLES[ui.tone];
  const hasDescription = ui.description !== '';
  return (
    <View className={`flex-row gap-2 rounded-xl border p-3 ${style.box} ${hasDescription ? 'items-start' : 'items-center'}`}>
      <ToneIcon tone={ui.tone} size={20} />
      <View className="flex-1 gap-0.5">
        <Text className={`font-sans-semibold text-body-lg ${style.title}`}>{ui.title}</Text>
        {hasDescription && <Text className="font-sans text-body text-stone-700">{ui.description}</Text>}
      </View>
    </View>
  );
}
