import { Redirect } from 'expo-router'

// Garantit toujours une route valide au lancement à froid (pas de
// app/index.tsx sinon = flash d'écran "introuvable" avant que la garde du
// layout racine ne redirige). Le layout racine renvoie ensuite vers les
// onglets si une session livreur valide existe déjà.
export default function Index() {
  return <Redirect href="/login" />
}
