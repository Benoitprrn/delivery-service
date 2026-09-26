import { Check } from 'lucide-react-native';
import { Pressable, Text, View } from 'react-native';
import { WHITE } from '../lib/colors';

type CheckboxProps = {
  checked: boolean;
  onToggle: () => void;
  label: string;
  accessibilityLabel: string;
};

// Case à cocher générique (consentement CGU, futurs consentements similaires
// — mandat, contrat de partenariat). Cible tactile ≥52px, texte ≥16px
// (règle mobile CLAUDE.md), pas seulement la case elle-même.
export function Checkbox({ checked, onToggle, label, accessibilityLabel }: CheckboxProps) {
  return (
    <Pressable
      onPress={onToggle}
      accessibilityRole="checkbox"
      accessibilityState={{ checked }}
      accessibilityLabel={accessibilityLabel}
      className="min-h-touch-comfortable flex-row items-center gap-3 py-2"
    >
      <View
        className={`h-6 w-6 items-center justify-center rounded border-[1.5px] ${
          checked ? 'border-primary-600 bg-primary-600' : 'border-border bg-surface'
        }`}
      >
        {checked && <Check size={16} color={WHITE} />}
      </View>
      <Text className="flex-1 font-sans text-body-lg text-stone-800">{label}</Text>
    </Pressable>
  );
}
