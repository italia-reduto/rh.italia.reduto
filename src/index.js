const ITER = 10000;
const enc = new TextEncoder();
const CAB = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};
const json = (obj, status = 200, extra = {}) =>
  new Response(JSON.stringify(obj), { status, headers: { ...CAB, ...extra } });

const hex = (buf) =>
  [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const aleatorio = (n) => hex(crypto.getRandomValues(new Uint8Array(n)));
const sha256 = async (t) => hex(await crypto.subtle.digest("SHA-256", enc.encode(t)));

async function hashSenha(senha, salt) {
  const chave = await crypto.subtle.importKey("raw", enc.encode(senha), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: enc.encode(salt), iterations: ITER },
    chave,
    256
  );
  return hex(bits);
}

function iguais(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

function gerarCodigo() {
  const alfabeto = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  const letras = [...bytes].map((b) => alfabeto[b % alfabeto.length]).join("");
  return letras.match(/.{4}/g).join("-");
}

function pegarCookie(request, nome) {
  const c = request.headers.get("Cookie") || "";
  for (const parte of c.split(";")) {
    const [k, ...v] = parte.trim().split("=");
    if (k === nome) return v.join("=");
  }
  return null;
}

const cookieSessao = (token, seg) =>
  `sessao=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${seg}`;

async function auditar(env, membroId, acao, detalhe, ip) {
  await env.DB.prepare(
    "INSERT INTO auditoria (membro_id, acao, detalhe, ip) VALUES (?, ?, ?, ?)"
  ).bind(membroId, acao, detalhe || null, ip || null).run();
}

async function lerCorpo(request) {
  try {
    const t = await request.text();
    if (t.length > 2000) return null;
    return JSON.parse(t);
  } catch {
    return null;
  }
}

async function setup(request, env) {
  const ip = request.headers.get("CF-Connecting-IP");
  const d = await lerCorpo(request);
  if (!d || !env.SETUP_KEY) return json({ erro: "Pedido inválido" }, 400);
  if (typeof d.chave !== "string" || !iguais(d.chave, env.SETUP_KEY))
    return json({ erro: "Chave de instalação incorreta" }, 403);
  const total = await env.DB.prepare("SELECT COUNT(*) AS n FROM membros").first();
  if (total.n > 0) return json({ erro: "Instalação já realizada" }, 403);

  const matricula = String(d.matricula || "").trim().slice(0, 40);
  const nome = String(d.nome || "").trim().slice(0, 80);
  const senha = String(d.senha || "");
  if (!matricula || !nome || senha.length < 8)
    return json({ erro: "Preencha tudo. A senha precisa de 8 ou mais caracteres." }, 400);

  const salt = aleatorio(16);
  const senhaHash = await hashSenha(senha, salt);
  const codigo = gerarCodigo();
  const codigoHash = await sha256(codigo.replace(/-/g, ""));

  await env.DB.prepare(
    "INSERT INTO membros (matricula, nome, cargo, nivel, senha_hash, senha_salt, trocar_senha, codigo_rec_hash) VALUES (?, ?, 'Comando', 100, ?, ?, 0, ?)"
  ).bind(matricula, nome, senhaHash, salt, codigoHash).run();

  await auditar(env, null, "setup", "Conta de comando criada: " + matricula, ip);
  return json({ ok: true, codigo_recuperacao: codigo });
}

async function login(request, env) {
  const ip = request.headers.get("CF-Connecting-IP");
  const d = await lerCorpo(request);
  if (!d) return json({ erro: "Pedido inválido" }, 400);
  const matricula = String(d.matricula || "").trim().slice(0, 40);
  const senha = String(d.senha || "").slice(0, 200);
  const GENERICO = { erro: "Matrícula ou senha incorretos" };
  if (!matricula || !senha) return json(GENERICO, 401);

  const agora = Math.floor(Date.now() / 1000);
  const m = await env.DB.prepare("SELECT * FROM membros WHERE matricula = ?").bind(matricula).first();

  if (!m || !m.ativo) {
    await hashSenha(senha, "0000000000000000");
    await auditar(env, null, "login_falha", "Matrícula inexistente ou inativa: " + matricula, ip);
    return json(GENERICO, 401);
  }
  if (m.bloqueado_ate > agora) {
    await auditar(env, m.id, "login_bloqueado", null, ip);
    return json({ erro: "Conta bloqueada por tentativas erradas. Tente novamente mais tarde." }, 423);
  }

  const h = await hashSenha(senha, m.senha_salt);
  if (!iguais(h, m.senha_hash)) {
    const falhas = m.tentativas_falhas + 1;
    if (falhas >= 5) {
      await env.DB.prepare("UPDATE membros SET tentativas_falhas = 0, bloqueado_ate = ? WHERE id = ?")
        .bind(agora + 900, m.id).run();
      await auditar(env, m.id, "conta_bloqueada", "5 tentativas erradas", ip);
    } else {
      await env.DB.prepare("UPDATE membros SET tentativas_falhas = ? WHERE id = ?").bind(falhas, m.id).run();
      await auditar(env, m.id, "login_falha", "Senha incorreta", ip);
    }
    return json(GENERICO, 401);
  }

  await env.DB.prepare("UPDATE membros SET tentativas_falhas = 0, bloqueado_ate = 0 WHERE id = ?").bind(m.id).run();
  const token = aleatorio(32);
  const duracao = 8 * 3600;
  await env.DB.prepare(
    "INSERT INTO sessoes (token_hash, membro_id, aparelho, expira_em) VALUES (?, ?, ?, ?)"
  ).bind(await sha256(token), m.id, (request.headers.get("User-Agent") || "").slice(0, 120), agora + duracao).run();
  await auditar(env, m.id, "login_ok", null, ip);

  return json(
    { ok: true, nome: m.nome, cargo: m.cargo, trocar_senha: m.trocar_senha },
    200,
    { "Set-Cookie": cookieSessao(token, duracao) }
  );
}

async function quemSou(request, env) {
  const token = pegarCookie(request, "sessao");
  if (!token) return null;
  const agora = Math.floor(Date.now() / 1000);
  return await env.DB.prepare(
    "SELECT m.id, m.nome, m.cargo, m.nivel, m.trocar_senha FROM sessoes s JOIN membros m ON m.id = s.membro_id WHERE s.token_hash = ? AND s.expira_em > ? AND m.ativo = 1"
  ).bind(await sha256(token), agora).first();
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const p = url.pathname;
    if (!p.startsWith("/api/")) return new Response("Não encontrado", { status: 404 });
    try {
      if (request.method === "POST") {
        const origem = request.headers.get("Origin");
        if (origem && new URL(origem).host !== url.host)
          return json({ erro: "Origem inválida" }, 403);
      }
      if (p === "/api/setup" && request.method === "POST") return await setup(request, env);
      if (p === "/api/login" && request.method === "POST") return await login(request, env);
      if (p === "/api/me" && request.method === "GET") {
        const eu = await quemSou(request, env);
        return eu ? json({ ok: true, ...eu }) : json({ erro: "Não autenticado" }, 401);
      }
      if (p === "/api/logout" && request.method === "POST") {
        const token = pegarCookie(request, "sessao");
        if (token) await env.DB.prepare("DELETE FROM sessoes WHERE token_hash = ?").bind(await sha256(token)).run();
        return json({ ok: true }, 200, { "Set-Cookie": cookieSessao("", 0) });
      }
      return json({ erro: "Não encontrado" }, 404);
    } catch (e) {
      return json({ erro: "Erro interno" }, 500);
    }
  },
};
