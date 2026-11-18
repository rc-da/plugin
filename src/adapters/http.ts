// Minimal HTTP abstraction so the GitHub adapter can be tested in Node.
// The real implementation (obsidian-http.ts) wraps Obsidian's requestUrl.

export interface HttpRequest {
  url: string;
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  headers: Record<string, string>;
  body?: string | ArrayBuffer;
}

export interface HttpResponse {
  /** 0 when there was no response at all. */
  status: number;
  /** Header names lower-cased. */
  headers: Record<string, string>;
  body: ArrayBuffer;
}

/** Resolves for every HTTP status (including 4xx/5xx). Rejects only when no response arrived. */
export type HttpClient = (req: HttpRequest) => Promise<HttpResponse>;

export function lowerCaseHeaders(h: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) out[k.toLowerCase()] = v;
  return out;
}
