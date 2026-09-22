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

function ToneIcon({ tone }: { tone: PayoutTone }) {
  if (tone === 'success') return <CircleCheck size={24} color={EMERALD_600} />;
  if (tone === 'danger') return <CircleAlert size={24} color="#B91C1C" />;
  if (tone === 'warning') return <CircleAlert size={24} color="#B45309" />;
  return <CreditCard size={24} color="#78716C" />;
}

// Carte d'état des paiements : libellés sans jargon (voir lib/payout-status.ts), même rendu dans le hub et le Wallet.
export function PayoutStatusCard({ ui }: { ui: PayoutUi }) {
  const style = TONE_STYLES[ui.tone];
  return (
    <View className={`flex-row items-start gap-3 rounded-2xl border p-4 ${style.box}`}>
      <ToneIcon tone={ui.tone} />
      <View className="flex-1 gap-1">
        <Text className={`font-sans-bold text-h3 ${style.title}`}>{ui.title}</Text>
        <Text className="font-sans text-body-lg text-stone-700">{ui.description}</Text>
      </View>
    </View>
  );
}
