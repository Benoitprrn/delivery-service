import { CircleAlert, CircleCheck, FileText } from 'lucide-react-native';
import { Text, View } from 'react-native';
import { EMERALD_600 } from '../lib/colors';
import type { MandateTone, MandateUi } from '../lib/mandate-status';

const TONE_STYLES: Record<MandateTone, { box: string; title: string }> = {
  success: { box: 'border-primary-600/30 bg-primary-100', title: 'text-primary-700' },
  warning: { box: 'border-amber-300 bg-amber-100', title: 'text-amber-800' },
  danger: { box: 'border-red-300 bg-red-50', title: 'text-red-700' },
  neutral: { box: 'border-border bg-surface', title: 'text-stone-800' }
};

function ToneIcon({ tone }: { tone: MandateTone }) {
  if (tone === 'success') return <CircleCheck size={24} color={EMERALD_600} />;
  if (tone === 'danger') return <CircleAlert size={24} color="#B91C1C" />;
  if (tone === 'warning') return <CircleAlert size={24} color="#B45309" />;
  return <FileText size={24} color="#78716C" />;
}

// Même patron que PayoutStatusCard (lib/payout-status.ts) : un seul rendu, jamais de jargon provider.
export function MandateStatusCard({ ui }: { ui: MandateUi }) {
  const style = TONE_STYLES[ui.tone];
  return (
    <View className="gap-3">
      <View className={`flex-row items-start gap-3 rounded-2xl border p-4 ${style.box}`}>
        <ToneIcon tone={ui.tone} />
        <View className="flex-1 gap-1">
          <Text className={`font-sans-bold text-h3 ${style.title}`}>{ui.title}</Text>
          <Text className="font-sans text-body-lg text-stone-700">{ui.description}</Text>
        </View>
      </View>
      {ui.driftNote === null ? null : (
        <View className="flex-row items-start gap-3 rounded-2xl border border-amber-300 bg-amber-50 p-4">
          <CircleAlert size={20} color="#B45309" />
          <Text className="flex-1 font-sans text-body text-amber-800">{ui.driftNote}</Text>
        </View>
      )}
    </View>
  );
}
