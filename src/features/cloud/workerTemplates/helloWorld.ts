export const helloWorldWorkerTemplate = `export default {
  async fetch(request) {
    const url = new URL(request.url);
    const greeting = url.searchParams.get("name") || "World";
    return new Response("Hello, " + greeting + "!", {
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  },
};`;
