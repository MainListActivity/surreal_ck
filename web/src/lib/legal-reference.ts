import type { ContentPage } from "./content-reader";
import { getSurreal } from "./surreal";

export type LegalReferenceInput = { page: ContentPage; locator: string | null; note: string };

/** Only a pointer and the user's own note enter the workspace database. */
export function legalReferenceData(input: LegalReferenceInput) {
  if (!input.page.canCite) throw new Error("content-cite-not-authorized");
  if (input.note.length > 4000) throw new Error("annotation-too-long");
  return {
    content_public_id: input.page.publicId,
    content_version_id: input.page.versionId,
    title: input.page.title,
    source_url: input.page.sourceUrl,
    published_on: input.page.publishedAt?.slice(0, 10) ?? undefined,
    locator: input.locator ?? undefined,
    note: input.note.trim() || undefined,
  };
}

export async function saveLegalReference(input: LegalReferenceInput): Promise<void> {
  await getSurreal().createRecord("legal_reference", legalReferenceData(input));
}
