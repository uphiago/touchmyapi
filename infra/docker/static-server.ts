const port = Number(process.env.PORT ?? 8080);
const root = process.env.STATIC_ROOT ?? "/app/public";

function safePath(pathname: string): string | undefined {
  const decoded = decodeURIComponent(pathname);
  if (decoded.includes("\0") || decoded.split("/").includes("..")) return undefined;
  return `${root}${decoded === "/" ? "/index.html" : decoded}`;
}

Bun.serve({
  hostname: "0.0.0.0",
  port,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return Response.json({ status: "ok", boundary: "static" });
    }
    const path = safePath(url.pathname);
    if (!path) return new Response("Not Found", { status: 404 });
    const asset = Bun.file(path);
    if (await asset.exists()) return new Response(asset);
    if (url.pathname.includes(".")) return new Response("Not Found", { status: 404 });
    return new Response(Bun.file(`${root}/index.html`));
  },
});
