// Les messages transitoires du système (ToastAndroid) sont volontairement
// désactivés : ils ne respectent pas le design system et affichent le chrome
// du development build. Les écrans portent désormais leur propre retour
// visuel quand une action le nécessite.
export function showToast(_message: string) {
  // no-op
}
