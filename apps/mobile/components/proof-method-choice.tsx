import { Camera, PenTool } from 'lucide-react-native';
import { Pressable, Text, View } from 'react-native';
import { EMERALD_600, WHITE } from '../lib/colors';

type Props = {
  onChooseSignature: () => void;
  onChoosePhoto: () => void;
};

export function ProofMethodChoice({ onChooseSignature, onChoosePhoto }: Props) {
  return (
    <View className="gap-6">
      <View className="gap-2">
        <Text className="text-center font-sans-bold text-h3 text-stone-800">Méthode alternative</Text>
        <Text className="text-center font-sans text-body-lg text-stone-500">
          Le code n'est pas disponible. Choisissez une autre preuve de livraison.
        </Text>
      </View>

      <Pressable
        onPress={onChooseSignature}
        className="h-touch-comfortable flex-row items-center justify-center gap-2 rounded-lg bg-primary-600 active:bg-primary-700"
      >
        <PenTool size={20} color={WHITE} />
        <Text className="font-sans-bold text-body-lg text-white">Signature</Text>
      </Pressable>

      <Pressable
        onPress={onChoosePhoto}
        className="h-touch-comfortable flex-row items-center justify-center gap-2 rounded-lg border-2 border-primary-600 active:bg-primary-50"
      >
        <Camera size={20} color={EMERALD_600} />
        <Text className="font-sans-bold text-body-lg text-primary-700">Photo</Text>
      </Pressable>
    </View>
  );
}
