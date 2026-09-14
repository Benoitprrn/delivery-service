import { Platform, ToastAndroid } from 'react-native';

// Android uniquement pour l'instant (contexte projet) — no-op ailleurs
// (web notamment) plutôt qu'une dépendance de toast cross-platform pour un
// seul message court.
export function showToast(message: string) {
  if (Platform.OS === 'android') {
    ToastAndroid.show(message, ToastAndroid.SHORT);
  } else {
    console.log('[toast]', message);
  }
}
