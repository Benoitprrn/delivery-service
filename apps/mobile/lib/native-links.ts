import { Linking, Platform } from 'react-native';

export async function openPhone(phone: string): Promise<void> {
  const normalizedPhone = phone.replace(/[^+\d]/g, '');
  await Linking.openURL(`tel:${normalizedPhone}`);
}

type MapLocation = {
  latitude: number;
  longitude: number;
  label: string;
};

export async function openMaps({ latitude, longitude, label }: MapLocation): Promise<void> {
  const coordinates = `${latitude},${longitude}`;
  const encodedLabel = encodeURIComponent(label);
  const url = Platform.OS === 'ios'
    ? `https://maps.apple.com/?ll=${coordinates}&q=${encodedLabel}`
    : `geo:${coordinates}?q=${coordinates}(${encodedLabel})`;

  await Linking.openURL(url);
}
