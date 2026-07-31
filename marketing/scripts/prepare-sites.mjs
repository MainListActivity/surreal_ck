import { mkdir, readdir, rename, writeFile } from "node:fs/promises";

const dist = new URL("../dist/", import.meta.url);
const client = new URL("./client/", dist);
const server = new URL("./server/", dist);

await mkdir(client, { recursive: true });

for (const entry of await readdir(dist, { withFileTypes: true })) {
  if (entry.name === "client" || entry.name === "server") continue;
  await rename(new URL(entry.name, dist), new URL(entry.name, client));
}

await mkdir(server, { recursive: true });
await writeFile(
  new URL("index.js", server),
  `const PLACEHOLDER_ORIGIN = "https://site.invalid";

export default {
  async fetch(request, env) {
    const response = await env.ASSETS.fetch(request);
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("text/html")) return response;

    const origin = new URL(request.url).origin;
    const body = (await response.text()).replaceAll(PLACEHOLDER_ORIGIN, origin);
    const headers = new Headers(response.headers);
    headers.delete("content-length");
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  },
};
`,
  "utf8",
);
