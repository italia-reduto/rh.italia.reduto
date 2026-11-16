export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      return Response.json({ erro: "Em construção" }, { status: 501 });
    }
    return new Response("Não encontrado", { status: 404 });
  },
};
