import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAvailability } from '../lib/availability-context';
import { EMERALD_600, STONE_200, STONE_500, WHITE } from '../lib/colors';

// Bouton flottant en haut à droite de la carte, sous le bloc header du
// carrousel (qui occupe déjà toute la largeur — pas de place à lui ajouter
// dedans). Aussi compact que possible tout en respectant le plancher
// Terrain : zone tactile ≥52px, texte ≥16px (apps/mobile/CLAUDE.md) — un
// contrôle actionnable, pas un texte informatif, donc pas d'exception de
// taille ici malgré la demande de le réduire de moitié.
const HEADER_HEIGHT = 56;
const TOP_MARGIN = 8;
const SIDE_MARGIN = 12;
const MIN_HEIGHT = 52;
const MIN_TEXT_SIZE = 16;
const DOT_SIZE = 8;

export function AvailabilityToggle() {
  const insets = useSafeAreaInsets();
  const { available, resolving, updating, toggle } = useAvailability();

  async function handlePress() {
    if (updating || resolving) return;
    await toggle();
  }

  return (
    <View
      className="absolute right-0 z-10"
      style={{ top: insets.top + HEADER_HEIGHT + TOP_MARGIN, right: SIDE_MARGIN }}
    >
      <Pressable
        onPress={() => void handlePress()}
        disabled={updating || resolving}
        className="flex-row items-center gap-1.5 rounded-full px-3 shadow-sm disabled:opacity-70"
        style={{ minHeight: MIN_HEIGHT, backgroundColor: available ? EMERALD_600 : STONE_200 }}
      >
        {updating ? (
          <ActivityIndicator size="small" color={available ? WHITE : STONE_500} />
        ) : (
          <View
            style={{
              width: DOT_SIZE,
              height: DOT_SIZE,
              borderRadius: DOT_SIZE / 2,
              backgroundColor: available ? WHITE : STONE_500
            }}
          />
        )}
        <Text
          className="font-sans-semibold"
          style={{ fontSize: MIN_TEXT_SIZE, color: available ? WHITE : STONE_500 }}
        >
          {available ? 'Disponible' : 'Indisponible'}
        </Text>
      </Pressable>
    </View>
  );
}
