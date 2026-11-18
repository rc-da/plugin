import { requestUrl } from "obsidian";
import { lowerCaseHeaders, type HttpClient } from "./http";

// HttpClient over Obsidian's requestUrl (§2: plain fetch is CORS-blocked in the
// mobile WebView). `throw: false` makes 4xx/5xx resolve so we can classify them;
// requestUrl still rejects when there is no response at all (offline, DNS).
// Typings: node_modules/obsidian/obsidian.d.ts, RequestUrlParam / RequestUrlResponse.

export const obsidianHttp: HttpClient = async req => {
  const headers = { ...req.headers };
  let contentType: string | undefined;
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === "content-type") { contentType = headers[k]; delete headers[k]; }
  }
  const res = await requestUrl({
    url: req.url,
    method: req.method,
    headers,
    contentType,
    body: req.body,
    throw: false,
  });
  return { status: res.status, headers: lowerCaseHeaders(res.headers ?? {}), body: res.arrayBuffer };
};
