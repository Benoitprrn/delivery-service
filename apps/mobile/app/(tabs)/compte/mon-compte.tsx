import { useFocusEffect, useRouter } from 'expo-router';
import * as DocumentPicker from 'expo-document-picker';
import { ChevronLeft, FileUp, Mail, Trash2, TriangleAlert } from 'lucide-react-native';
import { useCallback, useState } from 'react';
import { ActivityIndicator, BackHandler, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { apiRequest, uploadMultipart } from '../../../lib/api';
import { EMERALD_600 } from '../../../lib/colors';
import { showToast } from '../../../lib/toast';
import { useAuth } from '../../../lib/auth-context';

type DocumentType = 'identity_document' | 'business_registration_document';
type DocumentList = { documents: { documentType: DocumentType; originalFilename: string | null; uploadedAt: string }[] };
type VatRegime = 'assujetti' | 'franchise_en_base' | 'exonere';
type Missing = 'first_name' | 'last_name' | 'phone' | 'legal_form' | 'professional_name' | 'siret' | 'legal_address_line1' | 'legal_address_postal_code' | 'legal_address_city' | 'vat_regime' | 'vat_number' | DocumentType;
type CompanyProfile = { firstName: string | null; lastName: string | null; phone: string | null; legalForm: string | null; professionalName: string | null; siret: string | null; legalAddress: { line1: string | null; postalCode: string | null; city: string | null }; vatNumber: string | null; vatRegime: VatRegime | null };
type Response = { profile: CompanyProfile; status: { complete: boolean; missing: Missing[] } };

function Field({ label, value, onChange, required = true }: { label: string; value: string; onChange: (value: string) => void; required?: boolean }) {
  return <View className="gap-1.5"><Text className="font-sans-semibold text-body text-stone-600">{label}{required && <Text className="text-red-600"> *</Text>}</Text><TextInput value={value} onChangeText={onChange} className="h-touch-comfortable rounded-lg border border-border bg-stone-50 px-3 font-sans text-body-lg text-stone-700" /></View>;
}

export default function MyAccountScreen() {
  const router = useRouter();
  const { user } = useAuth();
  const [profile, setProfile] = useState<CompanyProfile>({ firstName: null, lastName: null, phone: null, legalForm: null, professionalName: null, siret: null, legalAddress: { line1: null, postalCode: null, city: null }, vatNumber: null, vatRegime: null });
  const [documents, setDocuments] = useState<DocumentList['documents']>([]);
  const [missing, setMissing] = useState<Missing[] | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState<Partial<Record<DocumentType, string>>>({});
  const update = <K extends keyof CompanyProfile>(key: K, value: CompanyProfile[K]) => setProfile(current => ({ ...current, [key]: value }));
  const text = (value: string | null) => value ?? '';
  // Ne jamais avaler l'échec ici : l'appelant doit savoir si le rafraîchissement a réellement
  // réussi (notamment après un upload de document — sinon un rechargement raté peut être masqué
  // par un message de succès alors que la liste affichée n'a pas changé).
  const load = useCallback(async () => { const [company, docs] = await Promise.all([apiRequest<Response>('/api/v1/drivers/me/company-profile'), apiRequest<DocumentList>('/api/v1/drivers/me/documents')]); setProfile(company.profile); setMissing(company.status.missing); setDocuments(docs.documents); }, []);
  useFocusEffect(useCallback(() => { void load().catch(() => setFeedback('Impossible de charger vos données.')); const subscription = BackHandler.addEventListener('hardwareBackPress', () => { router.replace('/compte'); return true; }); return () => subscription.remove(); }, [load, router]));
  async function save() { setSaving(true); setFeedback(null); try { const result = await apiRequest<Response>('/api/v1/drivers/me/company-profile', { method: 'PATCH', body: JSON.stringify(profile) }); setProfile(result.profile); setMissing(result.status.missing); setFeedback('Informations enregistrées.'); } catch { setFeedback('Erreur : veuillez réessayer.'); } finally { setSaving(false); } }
  async function pick(documentType: DocumentType) {
    let result: DocumentPicker.DocumentPickerResult;
    try {
      result = await DocumentPicker.getDocumentAsync({ type: ['application/pdf', 'image/jpeg', 'image/png'], copyToCacheDirectory: true });
    } catch {
      setFeedback('Erreur : veuillez réessayer.');
      return;
    }
    if (result.canceled || result.assets[0] === undefined) return;
    const asset = result.assets[0]; const name = asset.name || 'Document sélectionné'; const extension = name.split('.').pop()?.toLowerCase(); const contentType = asset.mimeType === 'application/pdf' || asset.mimeType === 'image/jpeg' || asset.mimeType === 'image/png' ? asset.mimeType : extension === 'pdf' ? 'application/pdf' : extension === 'png' ? 'image/png' : 'image/jpeg';
    setUploading(current => ({ ...current, [documentType]: name })); setFeedback(null);
    const form = new FormData(); form.append('documentType', documentType); form.append('file', { uri: asset.uri, name, type: contentType } as unknown as Blob);
    try { await uploadMultipart('/api/v1/drivers/me/documents', form); await load(); setFeedback('Document ajouté.'); } catch { setFeedback('Erreur : veuillez réessayer.'); } finally { setUploading(current => ({ ...current, [documentType]: undefined })); }
  }
  async function remove(documentType: DocumentType) { try { await apiRequest(`/api/v1/drivers/me/documents/${documentType}`, { method: 'DELETE' }); await load(); } catch { showToast('Suppression impossible.'); } }
  const document = (type: DocumentType, label: string) => { const current = documents.find(item => item.documentType === type); const uploadingName = uploading[type]; return <View className="gap-2"><Text className="font-sans-semibold text-body text-stone-600">{label}<Text className="text-red-600"> *</Text></Text>{uploadingName ? <View className="flex-row items-center gap-2 rounded-lg bg-primary-100 px-3 py-2"><ActivityIndicator size="small" color={EMERALD_600}/><Text className="flex-1 font-sans text-body text-primary-700" numberOfLines={1}>Envoi de {uploadingName}…</Text></View> : current ? <Text className="font-sans text-body text-stone-500" numberOfLines={1}>{current.originalFilename ?? 'Document ajouté'} · Déposé le {new Date(current.uploadedAt).toLocaleDateString('fr-FR')}</Text> : <Text className="font-sans text-body text-stone-500">Aucun document ajouté</Text>}<View className="flex-row gap-2"><Pressable disabled={uploadingName !== undefined} onPress={() => void pick(type)} className="h-touch-comfortable flex-1 flex-row items-center justify-center gap-2 rounded-lg border-2 border-primary-600 disabled:opacity-60"><FileUp size={18} color={EMERALD_600}/><Text className="font-sans-semibold text-primary-700">{current ? 'Modifier' : 'Ajouter'}</Text></Pressable>{current && !uploadingName && <Pressable onPress={() => void remove(type)} className="h-touch-comfortable w-touch-comfortable items-center justify-center rounded-lg border border-red-300"><Trash2 size={18} color="#DC2626"/></Pressable>}</View></View>; };
  return <SafeAreaView className="flex-1 bg-background" edges={['top']}><View className="flex-row items-center gap-2 px-page-mobile py-3"><Pressable onPress={() => router.replace('/compte')} className="h-touch-comfortable w-touch-comfortable items-center justify-center"><ChevronLeft size={24} color="#44403C"/></Pressable><Text className="font-sans-bold text-h3 text-stone-800">Mon entreprise</Text></View><ScrollView contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 24, gap: 20 }}>{missing !== null && missing.length > 0 && <View className="flex-row items-center gap-2 rounded-xl border border-amber-300 bg-amber-50 p-3"><TriangleAlert size={20} color="#B45309"/><Text className="flex-1 font-sans-semibold text-body text-amber-900">Complétez votre compte pour terminer votre inscription</Text></View>}{feedback && <View className="rounded-lg bg-stone-100 px-3 py-2"><Text className="font-sans text-body text-stone-700">{feedback}</Text></View>}<View className="gap-4 rounded-2xl border border-border bg-surface p-4"><Text className="font-sans-bold text-h3 text-stone-800">Mes informations</Text><Field label="Prénom" value={text(profile.firstName)} onChange={value => update('firstName', value || null)}/><Field label="Nom" value={text(profile.lastName)} onChange={value => update('lastName', value || null)}/><View className="gap-1.5"><Text className="font-sans-semibold text-body text-stone-600">E-mail</Text><View className="h-touch-comfortable flex-row items-center gap-2 rounded-lg border border-border bg-stone-100 px-3"><Mail size={18} color="#78716C"/><Text className="flex-1 font-sans text-body-lg text-stone-600" numberOfLines={1}>{user?.email ?? 'E-mail indisponible'}</Text></View></View><Field label="Téléphone" value={text(profile.phone)} onChange={value => update('phone', value || null)}/>{document('identity_document', "Document d'identité")}</View><View className="gap-4 rounded-2xl border border-border bg-surface p-4"><Text className="font-sans-bold text-h3 text-stone-800">Mon entreprise</Text><Field label="Forme juridique" value={text(profile.legalForm)} onChange={value => update('legalForm', value || null)}/><Field label="Raison sociale" value={text(profile.professionalName)} onChange={value => update('professionalName', value || null)}/><Field label="SIRET" value={text(profile.siret)} onChange={value => update('siret', value || null)}/><Field label="Adresse légale" value={text(profile.legalAddress.line1)} onChange={value => update('legalAddress', { ...profile.legalAddress, line1: value || null })}/><Field label="Code postal" value={text(profile.legalAddress.postalCode)} onChange={value => update('legalAddress', { ...profile.legalAddress, postalCode: value || null })}/><Field label="Ville" value={text(profile.legalAddress.city)} onChange={value => update('legalAddress', { ...profile.legalAddress, city: value || null })}/><Field label="N° de TVA intracommunautaire" required={profile.vatRegime === 'assujetti'} value={text(profile.vatNumber)} onChange={value => update('vatNumber', value || null)}/><Text className="font-sans-semibold text-body text-stone-600">Régime de TVA<Text className="text-red-600"> *</Text></Text><View className="flex-row gap-2">{(['assujetti', 'franchise_en_base'] as const).map(value => <Pressable key={value} onPress={() => update('vatRegime', value)} className={`min-h-touch-comfortable flex-1 items-center justify-center rounded-lg border px-2 ${profile.vatRegime === value ? 'border-primary-600 bg-primary-100' : 'border-border bg-stone-50'}`}><Text className="font-sans-semibold text-body text-stone-700">{value === 'assujetti' ? 'Assujetti' : 'Franchise'}</Text></Pressable>)}</View>{document('business_registration_document', 'Extrait Kbis')}</View><Pressable disabled={saving} onPress={() => void save()} className="h-touch-comfortable flex-row items-center justify-center gap-2 rounded-lg bg-primary-600 disabled:opacity-60">{saving && <ActivityIndicator color="#FFFFFF"/>}<Text className="font-sans-bold text-body-lg text-white">{saving ? 'Enregistrement…' : 'Enregistrer'}</Text></Pressable></ScrollView></SafeAreaView>;
}
