import type { CardData } from "./shared.js";

export function baseCardData(over: Partial<CardData> = {}): CardData {
  return {
    beforeDataUri: "data:image/jpeg;base64,AAAA",
    afterDataUri: "data:image/jpeg;base64,BBBB",
    title: "Nettoyage de la plage",
    commune: "Bab Ezzouar",
    wilaya: "Alger",
    dateIso: "2026-08-12T09:00:00.000Z",
    participants: 8,
    bags: 12,
    cleanedCount: 3,
    nationalCleaned: 0,
    organizerName: "Sara",
    locale: "fr",
    ...over,
  };
}

/** Very small tag-stripper for asserting on rendered copy. */
export function textOf(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
