import * as ImageManipulator from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';
import { useState } from 'react';
import { ActivityIndicator, Image, Pressable, Text, View } from 'react-native';
import { ApiError, type DeliveryProof } from '../lib/api';
import { WHITE } from '../lib/colors';
import { showToast } from '../lib/toast';

type Props = {
  onSubmit: (proof: DeliveryProof) => Promise<void>;
};

// Règle apps/mobile/CLAUDE.md : compression obligatoire avant upload,
// JPEG 80%, max 1920px, <500Ko (limite backend, voir migration 0008).
const MAX_DIMENSION = 1920;
const JPEG_QUALITY = 0.8;

export function ProofPhoto({ onSubmit }: Props) {
  const [previewUri, setPreviewUri] = useState<string | null>(null);
  const [base64, setBase64] = useState<string | null>(null);
  const [isCapturing, setIsCapturing] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function capture() {
    setIsCapturing(true);
    try {
      const permission = await ImagePicker.requestCameraPermissionsAsync();
      if (!permission.granted) {
        showToast('Autorisation caméra refusée.');
        return;
      }
      const result = await ImagePicker.launchCameraAsync({ quality: 1 });
      if (result.canceled) return;
      const asset = result.assets[0];
      if (asset === undefined) return;

      const manipulated = await ImageManipulator.manipulateAsync(
        asset.uri,
        [{ resize: { width: MAX_DIMENSION } }],
        { compress: JPEG_QUALITY, format: ImageManipulator.SaveFormat.JPEG, base64: true }
      );
      if (manipulated.base64 === undefined) {
        showToast('Impossible de traiter la photo.');
        return;
      }
      setPreviewUri(manipulated.uri);
      setBase64(manipulated.base64);
    } finally {
      setIsCapturing(false);
    }
  }

  async function submit() {
    if (base64 === null) return;
    setIsSubmitting(true);
    try {
      await onSubmit({ method: 'photo', imageBase64: base64 });
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : 'Une erreur est survenue.');
    } finally {
      setIsSubmitting(false);
    }
  }

  function retake() {
    setPreviewUri(null);
    setBase64(null);
  }

  return (
    <View className="flex-1 gap-4">
      <Text className="text-center font-sans-bold text-h3 text-stone-800">Photo de livraison</Text>

      <View className="flex-1 items-center justify-center overflow-hidden rounded-2xl border-2 border-border bg-surface">
        {previewUri !== null ? (
          <Image source={{ uri: previewUri }} style={{ width: '100%', height: '100%' }} resizeMode="cover" />
        ) : (
          <Text className="font-sans text-body-lg text-stone-400">Aucune photo prise</Text>
        )}
      </View>

      {previewUri === null ? (
        <Pressable
          onPress={() => void capture()}
          disabled={isCapturing}
          className="h-touch-comfortable items-center justify-center rounded-lg bg-primary-600 active:bg-primary-700 disabled:opacity-50"
        >
          {isCapturing ? (
            <ActivityIndicator color={WHITE} />
          ) : (
            <Text className="font-sans-bold text-body-lg text-white">Prendre la photo</Text>
          )}
        </Pressable>
      ) : (
        <View className="flex-row gap-3">
          <Pressable
            onPress={retake}
            disabled={isSubmitting}
            className="h-touch-comfortable flex-1 items-center justify-center rounded-lg border-2 border-border disabled:opacity-50"
          >
            <Text className="font-sans-bold text-body-lg text-stone-600">Reprendre</Text>
          </Pressable>
          <Pressable
            onPress={() => void submit()}
            disabled={isSubmitting}
            className="h-touch-comfortable flex-1 items-center justify-center rounded-lg bg-primary-600 active:bg-primary-700 disabled:opacity-50"
          >
            {isSubmitting ? (
              <ActivityIndicator color={WHITE} />
            ) : (
              <Text className="font-sans-bold text-body-lg text-white">Valider</Text>
            )}
          </Pressable>
        </View>
      )}
    </View>
  );
}
