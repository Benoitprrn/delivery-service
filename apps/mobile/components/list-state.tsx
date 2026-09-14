import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { EMERALD_600 } from '../lib/colors';

export function LoadingState() {
  return (
    <View className="flex-1 items-center justify-center gap-3 py-20">
      <ActivityIndicator size="large" color={EMERALD_600} />
      <Text className="font-sans text-body-lg text-stone-500">Chargement…</Text>
    </View>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <View className="flex-1 items-center justify-center gap-4 px-page-mobile py-20">
      <Text className="text-center font-sans text-body-lg text-status-cancelled-text">{message}</Text>
      <Pressable
        onPress={onRetry}
        className="h-touch-comfortable flex-row items-center justify-center rounded-lg bg-primary-600 px-6 active:bg-primary-700"
      >
        <Text className="font-sans-bold text-body-lg text-white">Réessayer</Text>
      </Pressable>
    </View>
  );
}

export function EmptyState({ message }: { message: string }) {
  return (
    <View className="flex-1 items-center justify-center px-page-mobile py-20">
      <Text className="text-center font-sans text-body-lg text-stone-500">{message}</Text>
    </View>
  );
}
