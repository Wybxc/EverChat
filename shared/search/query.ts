export interface SearchDocument {
  messageId: string; version: number; role: 'user' | 'assistant'; content: string; reasoning: string;
}
export interface SearchPage {
  documents: SearchDocument[]; after: number; done: boolean;
}
export interface SearchResult {
  conversationId: string; title: string; messageId: string; field: 'content' | 'reasoning'; excerpt: string;
}
export interface LibrarySearch {
  results: SearchResult[]; cursor: string | null; indexing: boolean; error?: string;
}
export const SEARCH_PAGE_SIZE = 20;
export const SEARCH_QUERY_LIMIT = 200;
export const normalizeSearch = (text: string) => text.toLowerCase().replace(/\s+/gu, ' ').trim();
// GLOB has no ESCAPE clause. Bracket expressions quote its three metacharacters.
export const literalGlob = (text: string) => `*${text.replace(/[\[*?]/gu, (character) => `[${character}]`)}*`;

// DO SQLite limits LIKE/GLOB patterns to 50 UTF-8 bytes, including escaping and the outer stars.
// https://developers.cloudflare.com/durable-objects/platform/limits/
export function searchCandidateGlob(text: string) {
  const encoder = new TextEncoder();
  let prefix = '', bytes = 2;
  for (const character of text) {
    const escaped = /[\[*?]/u.test(character) ? `[${character}]` : character;
    const size = encoder.encode(escaped).byteLength;
    if (bytes + size > 50) break;
    prefix += escaped; bytes += size;
  }
  return `*${prefix}*`;
}
