-- Étape 5, Tranche 4c (docs/work/invoicing-preparation-plan.md §15.14/§15.20) : le texte légal
-- réel du mandat V1 est maintenant validé par l'utilisateur. Deux changements distincts, dans la
-- même migration comme 0040/0051 l'ont déjà fait pour un besoin de tranche équivalent :

-- 1. Snapshot du prénom/nom civils du livreur (le mandat V1 les affiche séparément de la raison
--    sociale/nom professionnel déjà figé depuis 0051 sous `grantor_name_snapshot`, qui reste le nom
--    du SIGNATAIRE et n'est pas réutilisable ici). `not null` direct : `driver_einvoice_mandates`
--    reste vérifiée à zéro ligne dans tous les environnements réels avant cette migration (aucun
--    code n'a jamais écrit dedans depuis 0048, l'acceptation V1 réelle commence avec cette tranche).
alter table public.driver_einvoice_mandates
  add column grantor_first_name_snapshot text not null,
  add column grantor_last_name_snapshot text not null;

-- Étend le trigger d'immutabilité existant (0048/0051) aux deux nouvelles colonnes de contenu.
create or replace function public.guard_driver_einvoice_mandate_immutable() returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then raise exception 'un mandat de facturation ne peut jamais être supprimé'; end if;
  if (new.id, new.driver_id, new.grantor_siren, new.grantor_legal_name_snapshot, new.mandate_template_version,
      new.mandate_text_hash, new.accepted_at, new.acceptance_method, new.acceptance_evidence,
      new.signed_pdf_storage_path, new.signed_pdf_sha256,
      new.grantor_name_snapshot, new.grantor_professional_name_snapshot, new.grantor_siret_snapshot,
      new.grantor_legal_address_line1_snapshot, new.grantor_legal_address_line2_snapshot,
      new.grantor_legal_address_postal_code_snapshot, new.grantor_legal_address_city_snapshot,
      new.grantor_legal_address_country_code_snapshot, new.grantor_vat_number_snapshot,
      new.grantor_vat_regime_snapshot, new.grantor_legal_form_snapshot,
      new.grantor_first_name_snapshot, new.grantor_last_name_snapshot)
     is distinct from
     (old.id, old.driver_id, old.grantor_siren, old.grantor_legal_name_snapshot, old.mandate_template_version,
      old.mandate_text_hash, old.accepted_at, old.acceptance_method, old.acceptance_evidence,
      old.signed_pdf_storage_path, old.signed_pdf_sha256,
      old.grantor_name_snapshot, old.grantor_professional_name_snapshot, old.grantor_siret_snapshot,
      old.grantor_legal_address_line1_snapshot, old.grantor_legal_address_line2_snapshot,
      old.grantor_legal_address_postal_code_snapshot, old.grantor_legal_address_city_snapshot,
      old.grantor_legal_address_country_code_snapshot, old.grantor_vat_number_snapshot,
      old.grantor_vat_regime_snapshot, old.grantor_legal_form_snapshot,
      old.grantor_first_name_snapshot, old.grantor_last_name_snapshot) then
    raise exception 'le contenu accepté d’un mandat est immuable — une nouvelle version révoque l’ancien mandat';
  end if;
  if old.revoked_at is not null and new.revoked_at is distinct from old.revoked_at then
    raise exception 'un mandat révoqué ne peut pas être « dé-révoqué »';
  end if;
  return new;
end;
$$;

-- 2. Texte V1 validé par l'utilisateur (2026-09-24), inséré UNE seule fois, jamais dupliqué en
--    dur côté TypeScript (source de vérité unique, `mandate_templates` reste append-only, 0051).
--    Le hash est calculé par Postgres lui-même à partir de la même valeur insérée (CTE `t.body`
--    référencée deux fois) : jamais une deuxième copie du texte qui pourrait diverger du premier,
--    jamais un hash recalculé côté client avec un risque d'encodage différent.
insert into public.mandate_templates (version, text, text_sha256)
select 1, t.body, encode(digest(t.body, 'sha256'), 'hex')
from (values ($mandate$MANDAT DE FACTURATION

Entre les soussignés :

LE MANDANT

Nom et prénom :
{{driver_first_name}} {{driver_last_name}}

Nom / raison sociale :
{{driver_legal_name}}

SIREN :
{{driver_siren}}

SIRET :
{{driver_siret}}

Adresse :
{{driver_legal_address}}

Numéro de TVA intracommunautaire :
{{driver_vat_number_or_not_applicable}}

Ci-après dénommé « le Mandant »,

Et :

LE MANDATAIRE

Benoit Perrin, entrepreneur individuel
Nom commercial : Locadely
SIREN : 877 508 994
Adresse :
{{platform_legal_address}}

Ci-après dénommé « le Mandataire ».

ARTICLE 1 — OBJET DU MANDAT

Le Mandant donne mandat au Mandataire, qui l’accepte, afin d’établir en son nom et pour son compte les factures relatives aux prestations de livraison réalisées par le Mandant par l’intermédiaire de la plateforme Locadely.

Le présent mandat est conclu conformément à l’article 289, I-2 du Code général des impôts.

Le Mandataire est également autorisé à établir, lorsque cela est nécessaire, les factures rectificatives et avoirs relatifs à ces prestations.

Le présent mandat ne concerne aucune prestation réalisée par le Mandant en dehors de la plateforme Locadely.

ARTICLE 2 — ÉTABLISSEMENT DES FACTURES

Locadely établit les factures à partir des informations relatives aux prestations réalisées par le Mandant et des informations légales et fiscales communiquées par celui-ci.

Les factures sont établies au nom et pour le compte du Mandant.

Elles comportent les mentions obligatoires applicables et peuvent mentionner qu’elles ont été établies par Locadely au nom et pour le compte du Mandant.

Le Mandant demeure responsable de ses obligations fiscales et de facturation.

ARTICLE 3 — EXACTITUDE DES INFORMATIONS

Le Mandant s’engage à fournir à Locadely des informations exactes et à jour concernant notamment :

- son identité ;
- son entreprise ;
- son SIREN et son SIRET ;
- son adresse ;
- son régime de TVA ;
- son numéro de TVA intracommunautaire lorsqu’il en dispose.

Le Mandant s’engage à informer Locadely de toute modification de ces informations.

En cas de modification d’informations ayant servi à établir le présent mandat, Locadely peut demander la signature d’un nouveau mandat avant de poursuivre l’émission électronique des factures.

ARTICLE 4 — NUMÉROTATION

Les factures établies par Locadely au nom et pour le compte du Mandant utilisent une numérotation chronologique et continue permettant leur identification et leur traçabilité.

Locadely prend les mesures nécessaires pour éviter les doublons dans la série de factures qu’elle établit dans le cadre du présent mandat.

ARTICLE 5 — MISE À DISPOSITION ET ACCEPTATION DES FACTURES

Chaque facture établie au nom et pour le compte du Mandant est mise à sa disposition dans son espace Locadely.

Le Mandant peut consulter les factures établies et signaler toute erreur ou contestation à Locadely.

Sauf contestation du Mandant dans un délai de 7 jours suivant la mise à disposition de la facture, celle-ci est réputée acceptée.

En cas d’erreur justifiée, Locadely procède aux opérations de rectification nécessaires et, le cas échéant, à l’établissement d’une facture rectificative ou d’un avoir.

ARTICLE 6 — FACTURATION ÉLECTRONIQUE

Le Mandant autorise Locadely à effectuer les opérations techniques nécessaires à l’émission et à la transmission électronique des factures couvertes par le présent mandat.

À cette fin, Locadely peut transmettre les factures et les informations nécessaires à une Plateforme Agréée ou à tout autre prestataire technique intervenant dans le processus de facturation électronique, dans le respect de la réglementation applicable.

Le Mandant autorise également Locadely à transmettre le présent mandat à la Plateforme Agréée utilisée par Locadely afin de permettre la vérification du mandat et l’émission des factures en son nom et pour son compte.

ARTICLE 7 — CONSERVATION ET ACCÈS AUX DOCUMENTS

Locadely met à disposition du Mandant les factures établies dans le cadre du présent mandat ainsi que, lorsqu’elle est disponible, leur représentation électronique.

Le Mandant demeure responsable du respect de ses propres obligations de conservation comptable et fiscale.

Locadely peut conserver les documents et données nécessaires au fonctionnement du service, à la traçabilité des opérations et au respect de ses propres obligations légales.

ARTICLE 8 — DURÉE ET FIN DU MANDAT

Le présent mandat est conclu pour une durée indéterminée à compter de son acceptation électronique par le Mandant.

Le Mandant peut demander à tout moment la cessation du mandat.

À compter de la prise d’effet de cette cessation, Locadely n’établit plus de nouvelles factures au nom et pour le compte du Mandant, sous réserve du traitement des opérations déjà réalisées avant cette date et nécessitant une facturation ou une rectification.

La cessation du mandat n’affecte pas la validité des factures régulièrement établies avant sa prise d’effet.

ARTICLE 9 — ACCEPTATION ÉLECTRONIQUE DU MANDAT

Le Mandant déclare :

- avoir pris connaissance du présent mandat ;
- avoir vérifié les informations le concernant ;
- autoriser Locadely à établir des factures en son nom et pour son compte dans le périmètre défini ci-dessus ;
- accepter la transmission électronique du présent mandat et des factures correspondantes.

Le présent mandat est accepté électroniquement depuis le compte Locadely du Mandant.

Signataire :
{{signer_first_name}} {{signer_last_name}}

Date et heure de signature :
{{signed_at}}

Version du mandat :
{{mandate_version}}

Référence du mandat :
{{mandate_reference}}

Signature du Mandant :

{{handwritten_signature}}

Document accepté et signé électroniquement via Locadely.$mandate$)) as t(body);
