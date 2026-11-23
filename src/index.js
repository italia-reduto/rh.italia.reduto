import { rodarEscala } from "./equipes.js";
import { rotasFrequencia } from "./frequencia.js";
import { rotasFicha } from "./ficha.js";

import { rotasComunicados } from "./comunicados.js";
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
const agora = () => Math.floor(Date.now() / 1000);
const texto = (v, max) => String(v ?? "").trim().slice(0, max);

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

const ALFA = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
function sortear(n) {
  const bytes = crypto.getRandomValues(new Uint8Array(n));
  return [...bytes].map((b) => ALFA[b % ALFA.length]).join("");
}
const gerarCodigo = () => sortear(12).match(/.{4}/g).join("-");
const gerarSenhaTemp = () => sortear(10);

function pegarCookie(request, nome) {
  const c = request.headers.get("Cookie") || "";
  for (const parte of c.split(";")) {
    const [k, ...v] = parte.trim().split("=");
    if (k === nome) return v.join("=");
  }
  return null;
}
const cookie = (nome, valor, seg) =>
  `${nome}=${valor}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${seg}`;

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

const buscarMembro = (env, matricula) =>
  env.DB.prepare("SELECT * FROM membros WHERE matricula = ?").bind(matricula).first();

const BLOQUEADA = "Conta bloqueada por tentativas erradas. Tente novamente mais tarde.";
const FALHA = { erro: "Não foi possível recuperar com esses dados" };

async function registrarFalha(env, m, ip, acao, detalhe) {
  const falhas = m.tentativas_falhas + 1;
  if (falhas >= 5) {
    await env.DB.prepare("UPDATE membros SET tentativas_falhas = 0, bloqueado_ate = ? WHERE id = ?")
      .bind(agora() + 900, m.id).run();
    await auditar(env, m.id, "conta_bloqueada", "5 tentativas erradas (" + acao + ")", ip);
  } else {
    await env.DB.prepare("UPDATE membros SET tentativas_falhas = ? WHERE id = ?").bind(falhas, m.id).run();
    await auditar(env, m.id, acao, detalhe, ip);
  }
}

async function definirSenha(env, membroId, senha, trocar) {
  const salt = aleatorio(16);
  const h = await hashSenha(senha, salt);
  await env.DB.prepare(
    "UPDATE membros SET senha_hash = ?, senha_salt = ?, trocar_senha = ?, tentativas_falhas = 0, bloqueado_ate = 0 WHERE id = ?"
  ).bind(h, salt, trocar, membroId).run();
}

const apagarSessoes = (env, membroId) =>
  env.DB.prepare("DELETE FROM sessoes WHERE membro_id = ?").bind(membroId).run();

async function aparelhoValido(request, env, membroId) {
  const token = pegarCookie(request, "aparelho");
  if (!token) return false;
  const r = await env.DB.prepare(
    "SELECT id FROM aparelhos_autorizados WHERE token_hash = ? AND membro_id = ? AND revogado = 0 AND expira_em > ?"
  ).bind(await sha256(token), membroId, agora()).first();
  return !!r;
}

async function quemSou(request, env) {
  const token = pegarCookie(request, "sessao");
  if (!token) return null;
  return await env.DB.prepare(
  "SELECT m.id, m.nome, m.cargo, m.nivel, m.trocar_senha, m.matricula FROM sessoes s JOIN membros m ON m.id = s.membro_id WHERE s.token_hash = ? AND s.expira_em > ? AND m.ativo = 1"
).bind(await sha256(token), agora()).first();
}

async function exigirAdmin(request, env) {
  const eu = await quemSou(request, env);
  return eu && eu.nivel >= 50 && !eu.trocar_senha ? eu : null;
}

function ipDiscreto(ip) {
  if (!ip) return "";
  if (ip.includes(".")) return ip.split(".").slice(0, 3).join(".") + ".x";
  return ip.split(":").slice(0, 3).join(":") + "::x";
}
async function login(request, env) {
  const ip = request.headers.get("CF-Connecting-IP");
  const d = await lerCorpo(request);
  if (!d) return json({ erro: "Pedido inválido" }, 400);
  const matricula = texto(d.matricula, 40);
  const senha = String(d.senha || "").slice(0, 200);
  const GENERICO = { erro: "Matrícula ou senha incorretos" };
  if (!matricula || !senha) return json(GENERICO, 401);

  const m = await buscarMembro(env, matricula);
  if (!m || !m.ativo) {
    await hashSenha(senha, "0000000000000000");
    await auditar(env, null, "login_falha", "Matrícula inexistente ou inativa: " + matricula, ip);
    return json(GENERICO, 401);
  }
  if (m.bloqueado_ate > agora()) {
    await auditar(env, m.id, "login_bloqueado", null, ip);
    return json({ erro: BLOQUEADA }, 423);
  }
  const h = await hashSenha(senha, m.senha_salt);
  if (!iguais(h, m.senha_hash)) {
    await registrarFalha(env, m, ip, "login_falha", "Senha incorreta");
    return json(GENERICO, 401);
  }

  await env.DB.prepare("UPDATE membros SET tentativas_falhas = 0, bloqueado_ate = 0 WHERE id = ?").bind(m.id).run();
  const token = aleatorio(32);
  const duracao = 8 * 3600;
  await env.DB.prepare(
    "INSERT INTO sessoes (token_hash, membro_id, aparelho, expira_em) VALUES (?, ?, ?, ?)"
  ).bind(await sha256(token), m.id, (request.headers.get("User-Agent") || "").slice(0, 120), agora() + duracao).run();
  await env.DB.prepare("UPDATE membros SET ultimo_ip = ? WHERE id = ?").bind(ipDiscreto(ip), m.id).run();
await auditar(env, m.id, "login_ok", null, ip);

  return json(
    { ok: true, nome: m.nome, cargo: m.cargo, trocar_senha: m.trocar_senha },
    200,
    { "Set-Cookie": cookie("sessao", token, duracao) }
  );
}
async function autorizarAparelho(request, env) {
  const ip = request.headers.get("CF-Connecting-IP");
  const eu = await quemSou(request, env);
  if (!eu || eu.trocar_senha) return json({ erro: "Não autenticado" }, 401);
  const d = await lerCorpo(request);
  const pin = texto(d && d.pin, 20);
  if (!/^\d{6}$/.test(pin)) return json({ erro: "O PIN precisa ter 6 números" }, 400);

  const salt = aleatorio(16);
  const h = await hashSenha(pin, salt);
  await env.DB.prepare("UPDATE membros SET pin_rec_hash = ?, pin_rec_salt = ? WHERE id = ?").bind(h, salt, eu.id).run();

  const token = aleatorio(32);
  const dias30 = 30 * 86400;
  await env.DB.prepare(
    "INSERT INTO aparelhos_autorizados (membro_id, token_hash, descricao, expira_em) VALUES (?, ?, ?, ?)"
  ).bind(eu.id, await sha256(token), (request.headers.get("User-Agent") || "").slice(0, 120), agora() + dias30).run();
  await env.DB.prepare(
    "UPDATE aparelhos_autorizados SET revogado = 1 WHERE membro_id = ? AND revogado = 0 AND id NOT IN (SELECT id FROM aparelhos_autorizados WHERE membro_id = ? AND revogado = 0 ORDER BY id DESC LIMIT 2)"
  ).bind(eu.id, eu.id).run();
  await auditar(env, eu.id, "aparelho_autorizado", null, ip);
  return json({ ok: true }, 200, { "Set-Cookie": cookie("aparelho", token, dias30) });
}

async function recuperarAparelho(request, env) {
  const ip = request.headers.get("CF-Connecting-IP");
  const d = await lerCorpo(request);
  if (!d) return json({ erro: "Pedido inválido" }, 400);
  const matricula = texto(d.matricula, 40);
  const pin = texto(d.pin, 20);
  const nova = String(d.nova_senha || "").slice(0, 200);
  if (!matricula || !/^\d{6}$/.test(pin) || nova.length < 8)
    return json({ erro: "Preencha matrícula, PIN de 6 números e senha nova com 8 ou mais caracteres" }, 400);

  const m = await buscarMembro(env, matricula);
  if (!m || !m.ativo || !m.pin_rec_hash) return json(FALHA, 401);
  if (m.bloqueado_ate > agora()) return json({ erro: BLOQUEADA }, 423);
  if (!(await aparelhoValido(request, env, m.id))) {
    await auditar(env, m.id, "recuperacao_sem_aparelho", null, ip);
    return json(FALHA, 401);
  }
  const h = await hashSenha(pin, m.pin_rec_salt);
  if (!iguais(h, m.pin_rec_hash)) {
    await registrarFalha(env, m, ip, "pin_falha", "PIN incorreto");
    return json(FALHA, 401);
  }
  await definirSenha(env, m.id, nova, 0);
  await apagarSessoes(env, m.id);
  await auditar(env, m.id, "senha_recuperada_aparelho", null, ip);
  return json({ ok: true });
}

async function recuperarCodigo(request, env) {
  const ip = request.headers.get("CF-Connecting-IP");
  const d = await lerCorpo(request);
  if (!d) return json({ erro: "Pedido inválido" }, 400);
  const matricula = texto(d.matricula, 40);
  const codigo = texto(d.codigo, 40).toUpperCase().replace(/[^A-Z0-9]/g, "");
  const nova = String(d.nova_senha || "").slice(0, 200);
  if (!matricula || codigo.length !== 12 || nova.length < 8)
    return json({ erro: "Preencha matrícula, código de recuperação e senha nova com 8 ou mais caracteres" }, 400);

  const m = await buscarMembro(env, matricula);
  if (!m || !m.ativo || !m.codigo_rec_hash) return json(FALHA, 401);
  if (m.bloqueado_ate > agora()) return json({ erro: BLOQUEADA }, 423);
  if (!iguais(await sha256(codigo), m.codigo_rec_hash)) {
    await registrarFalha(env, m, ip, "codigo_falha", "Código de recuperação incorreto");
    return json(FALHA, 401);
  }
  await definirSenha(env, m.id, nova, 0);
  const novo = gerarCodigo();
  await env.DB.prepare("UPDATE membros SET codigo_rec_hash = ? WHERE id = ?")
    .bind(await sha256(novo.replace(/-/g, "")), m.id).run();
  await apagarSessoes(env, m.id);
  await auditar(env, m.id, "senha_recuperada_codigo", null, ip);
  return json({ ok: true, novo_codigo: novo });
}

async function pedirRecuperacao(request, env) {
  const ip = request.headers.get("CF-Connecting-IP");
  const d = await lerCorpo(request);
  const matricula = texto(d && d.matricula, 40);
  const resposta = { ok: true, mensagem: "Se a matrícula existir, o pedido foi enviado ao comando." };
  if (!matricula) return json(resposta);
  const m = await buscarMembro(env, matricula);
  if (m && m.ativo) {
    const aberto = await env.DB.prepare(
      "SELECT id FROM pedidos_recuperacao WHERE membro_id = ? AND status = 'pendente'"
    ).bind(m.id).first();
    if (!aberto) {
      const conhecido = (await aparelhoValido(request, env, m.id)) ? 1 : 0;
      await env.DB.prepare("INSERT INTO pedidos_recuperacao (membro_id, aparelho_conhecido) VALUES (?, ?)")
        .bind(m.id, conhecido).run();
      await auditar(env, m.id, "pedido_recuperacao", null, ip);
    }
  }
  return json(resposta);
}

async function listarPedidos(request, env) {
  if (!(await exigirAdmin(request, env))) return json({ erro: "Sem permissão" }, 403);
  const r = await env.DB.prepare(
    "SELECT p.id, p.criado_em, p.aparelho_conhecido, m.matricula, m.nome FROM pedidos_recuperacao p JOIN membros m ON m.id = p.membro_id WHERE p.status = 'pendente' ORDER BY p.id LIMIT 50"
  ).all();
  return json({ ok: true, pedidos: r.results });
}

async function resolverPedido(request, env) {
  const ip = request.headers.get("CF-Connecting-IP");
  const adm = await exigirAdmin(request, env);
  if (!adm) return json({ erro: "Sem permissão" }, 403);
  const d = await lerCorpo(request);
  const id = Number(d && d.id);
  const acao = d && d.acao;
  if (!Number.isInteger(id) || (acao !== "aprovar" && acao !== "negar"))
    return json({ erro: "Pedido inválido" }, 400);

  const p = await env.DB.prepare(
    "SELECT p.id, p.membro_id, m.matricula FROM pedidos_recuperacao p JOIN membros m ON m.id = p.membro_id WHERE p.id = ? AND p.status = 'pendente'"
  ).bind(id).first();
  if (!p) return json({ erro: "Pedido não encontrado" }, 404);

  if (acao === "negar") {
    await env.DB.prepare("UPDATE pedidos_recuperacao SET status = 'negado', resolvido_por = ?, resolvido_em = ? WHERE id = ?")
      .bind(adm.id, agora(), id).run();
    await auditar(env, adm.id, "pedido_negado", "Matrícula " + p.matricula, ip);
    return json({ ok: true });
  }
  const temp = gerarSenhaTemp();
  await definirSenha(env, p.membro_id, temp, 1);
  await apagarSessoes(env, p.membro_id);
  await env.DB.prepare("UPDATE pedidos_recuperacao SET status = 'aprovado', resolvido_por = ?, resolvido_em = ? WHERE id = ?")
    .bind(adm.id, agora(), id).run();
  await auditar(env, adm.id, "pedido_aprovado", "Matrícula " + p.matricula, ip);
  return json({ ok: true, matricula: p.matricula, senha_temporaria: temp });
}

async function trocarSenha(request, env) {
  const ip = request.headers.get("CF-Connecting-IP");
  const eu = await quemSou(request, env);
  if (!eu) return json({ erro: "Não autenticado" }, 401);
  const d = await lerCorpo(request);
  const atual = String((d && d.senha_atual) || "").slice(0, 200);
  const nova = String((d && d.nova_senha) || "").slice(0, 200);
  if (nova.length < 8 || nova === atual)
    return json({ erro: "A senha nova precisa ter 8 ou mais caracteres e ser diferente da atual" }, 400);

  const m = await env.DB.prepare("SELECT senha_hash, senha_salt FROM membros WHERE id = ?").bind(eu.id).first();
  if (!iguais(await hashSenha(atual, m.senha_salt), m.senha_hash)) {
    await auditar(env, eu.id, "troca_senha_falha", null, ip);
    return json({ erro: "Senha atual incorreta" }, 401);
  }
  await definirSenha(env, eu.id, nova, 0);
  const token = pegarCookie(request, "sessao");
  await env.DB.prepare("DELETE FROM sessoes WHERE membro_id = ? AND token_hash != ?")
    .bind(eu.id, await sha256(token)).run();
  await auditar(env, eu.id, "senha_trocada", null, ip);
  return json({ ok: true });
}

async function cadastrarMembro(request, env) {
  const ip = request.headers.get("CF-Connecting-IP");
  const adm = await exigirAdmin(request, env);
  if (!adm) return json({ erro: "Sem permissão" }, 403);

  const d = await lerCorpo(request);
  if (!d) return json({ erro: "Pedido inválido" }, 400);

  const matricula = texto(d.matricula, 40);
  const nome = texto(d.nome, 100);
  const cargo = texto(d.cargo, 50);
  const nivel = parseInt(d.nivel, 10) || 10;
  const senhaTemp = String(d.senha || gerarSenhaTemp()).slice(0, 200);

  if (!matricula || !nome || !cargo) return json({ erro: "Preencha todos os campos obrigatórios" }, 400);
  if (nivel < 1 || nivel > adm.nivel) return json({ erro: "Você não pode criar uma conta com nível maior que o seu" }, 403);
  if (senhaTemp.length < 8) return json({ erro: "A senha temporária precisa ter 8 ou mais caracteres" }, 400);

  const codigoRec = gerarCodigo();
  const codigoHash = await sha256(codigoRec.replace(/-/g, ""));
  
  const salt = aleatorio(16);
  const senhaHash = await hashSenha(senhaTemp, salt);

  try {
    const info = await env.DB.prepare(
      "INSERT INTO membros (matricula, nome, cargo, nivel, ativo, trocar_senha, codigo_rec_hash, senha_hash, senha_salt) VALUES (?, ?, ?, ?, 1, 1, ?, ?, ?) RETURNING id"
    ).bind(matricula, nome, cargo, nivel, codigoHash, senhaHash, salt).first();

    if (!info) throw new Error("Falha ao inserir");
    
    await auditar(env, adm.id, "membro_criado", "Matrícula: " + matricula, ip);

    return json({ ok: true, matricula: matricula, senha: senhaTemp, codigo_rec: codigoRec });
  } catch (e) {
    return json({ erro: "Matrícula já existe ou erro no banco." }, 400);
  }
}

async function abrirTicket(request, env) {
  const ip = request.headers.get("CF-Connecting-IP");
  const eu = await quemSou(request, env);
  if (!eu || eu.trocar_senha) return json({ erro: "Não autenticado" }, 401);

  const d = await lerCorpo(request);
  if (!d) return json({ erro: "Pedido inválido" }, 400);

  const assunto = texto(d.assunto, 100);
  const mensagem = texto(d.mensagem, 1000);

  if (!assunto || !mensagem) return json({ erro: "Preencha o assunto e a mensagem." }, 400);

  await env.DB.prepare(
    "INSERT INTO tickets (membro_id, assunto, mensagem) VALUES (?, ?, ?)"
  ).bind(eu.id, assunto, mensagem).run();

  await auditar(env, eu.id, "ticket_aberto", assunto, ip);
  return json({ ok: true, mensagem: "Ticket enviado ao comando!" });
}

async function meusTickets(request, env) {
  const eu = await quemSou(request, env);
  if (!eu || eu.trocar_senha) return json({ erro: "Não autenticado" }, 401);

  const r = await env.DB.prepare(
    "SELECT id, assunto, mensagem, status, resposta, criado_em FROM tickets WHERE membro_id = ? ORDER BY id DESC"
  ).bind(eu.id).all();

  return json({ ok: true, tickets: r.results });
}

async function adminListarTickets(request, env) {
  if (!(await exigirAdmin(request, env))) return json({ erro: "Sem permissão" }, 403);
  const r = await env.DB.prepare(
    "SELECT t.id, t.assunto, t.mensagem, t.status, t.resposta, t.criado_em, t.atualizado_em, m.matricula, m.nome FROM tickets t JOIN membros m ON m.id = t.membro_id ORDER BY CASE t.status WHEN 'aberto' THEN 0 ELSE 1 END, t.id DESC LIMIT 100"
  ).all();
  return json({ ok: true, tickets: r.results });
}

async function adminResponderTicket(request, env) {
  const ip = request.headers.get("CF-Connecting-IP");
  const adm = await exigirAdmin(request, env);
  if (!adm) return json({ erro: "Sem permissão" }, 403);
  const d = await lerCorpo(request);
  const id = Number(d && d.id);
  const resposta = texto(d && d.resposta, 1500);
  const status = "respondido";
  if (!Number.isInteger(id) || !resposta) return json({ erro: "Escreva a resposta" }, 400);
  const r = await env.DB.prepare(
    "UPDATE tickets SET resposta = ?, status = ?, atualizado_em = ? WHERE id = ?"
  ).bind(resposta, status, agora(), id).run();
  if (!r.meta.changes) return json({ erro: "Ticket não encontrado" }, 404);
  await auditar(env, adm.id, "ticket_respondido", "Ticket " + id, ip);
  return json({ ok: true });
}


async function pedirAusencia(request, env) {
  const ip = request.headers.get("CF-Connecting-IP");
  const eu = await quemSou(request, env);
  if (!eu || eu.trocar_senha) return json({ erro: "Não autenticado" }, 401);

  const d = await lerCorpo(request);
  if (!d) return json({ erro: "Pedido inválido" }, 400);

  const inicio = texto(d.data_inicio, 20);
  const fim = texto(d.data_fim, 20);
  const motivo = texto(d.motivo, 500);

  if (!inicio || !fim || !motivo) return json({ erro: "Preencha todos os campos" }, 400);

  await env.DB.prepare(
    "INSERT INTO ausencias (membro_id, data_inicio, data_fim, motivo) VALUES (?, ?, ?, ?)"
  ).bind(eu.id, inicio, fim, motivo).run();

  await auditar(env, eu.id, "ausencia_pedida", inicio + " a " + fim, ip);
  return json({ ok: true, mensagem: "Ausência solicitada!" });
}

async function minhasAusencias(request, env) {
  const eu = await quemSou(request, env);
  if (!eu || eu.trocar_senha) return json({ erro: "Não autenticado" }, 401);

  const r = await env.DB.prepare(
    "SELECT id, data_inicio, data_fim, motivo, status, criado_em FROM ausencias WHERE membro_id = ? ORDER BY id DESC"
  ).bind(eu.id).all();

  return json({ ok: true, ausencias: r.results });
}

async function adminListarAusencias(request, env) {
  if (!(await exigirAdmin(request, env))) return json({ erro: "Sem permissão" }, 403);
  const r = await env.DB.prepare(
    "SELECT a.id, a.data_inicio, a.data_fim, a.motivo, a.status, a.criado_em, m.nome, m.matricula FROM ausencias a JOIN membros m ON m.id = a.membro_id ORDER BY CASE a.status WHEN 'pendente' THEN 0 ELSE 1 END, a.id DESC LIMIT 100"
  ).all();
  return json({ ok: true, ausencias: r.results });
}

async function adminResolverAusencia(request, env) {
  const ip = request.headers.get("CF-Connecting-IP");
  const adm = await exigirAdmin(request, env);
  if (!adm) return json({ erro: "Sem permissão" }, 403);

  const d = await lerCorpo(request);
  const id = Number(d && d.id);
  const acao = d && d.acao; // 'aprovar' ou 'negar'

if (!Number.isInteger(id) || (acao !== "aprovar" && acao !== "negar"))
    return json({ erro: "Pedido inválido" }, 400);

  const novoStatus = acao === "aprovar" ? "aprovada" : "negada";
  
  const resultado = await env.DB.prepare(
    "UPDATE ausencias SET status = ? WHERE id = ? AND status = 'pendente'"
  ).bind(novoStatus, id).run();
  if (!resultado.meta.changes) return json({ erro: "Pedido já resolvido ou não encontrado" }, 404);

  await auditar(env, adm.id, "ausencia_" + acao, "ID: " + id, ip);
  return json({ ok: true });
}
async function salvarFotoPerfil(request, env) {
  const eu = await quemSou(request, env);
  if (!eu) return json({ erro: "Não autenticado" }, 401);

if (eu.trocar_senha) return json({ erro: "Não autenticado" }, 401);
if (Number(request.headers.get("Content-Length") || 0) > 200000) return json({ erro: "Imagem muito grande" }, 413);

  if (!d || typeof d.imagem !== "string") return json({ erro: "Imagem inválida" }, 400);
if (!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+\/=]+$/.test(d.imagem)) return json({ erro: "Formato inválido (use JPG, PNG ou WebP)" }, 400);
if (d.imagem.length > 150000) return json({ erro: "Imagem muito grande" }, 400);
  await env.DB.prepare("UPDATE membros SET avatar_base64 = ? WHERE id = ?")
    .bind(d.imagem, eu.id).run();

  return json({ ok: true, mensagem: "Foto atualizada!" });
}
async function salvarFotoSegura(request, env) {
  const eu = await quemSou(request, env);
  if (!eu || eu.trocar_senha) return json({ erro: "Não autenticado" }, 401);
  if (Number(request.headers.get("Content-Length") || 0) > 200000) return json({ erro: "Imagem muito grande" }, 413);

  let d;
  try { d = await request.json(); } catch (e) { return json({ erro: "Formato inválido" }, 400); }

  const img = d && d.imagem;
  if (typeof img !== "string") return json({ erro: "Imagem inválida" }, 400);
  if (img.length > 150000) return json({ erro: "Imagem muito grande" }, 400);
  if (!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+\/=]+$/.test(img)) return json({ erro: "Formato inválido (use JPG, PNG ou WebP)" }, 400);

  try {
    await env.DB.prepare("UPDATE membros SET avatar_base64 = ? WHERE id = ?").bind(img, eu.id).run();
  } catch (e) {
    console.error("Erro ao salvar foto:", e && e.message);
    return json({ erro: "Não foi possível salvar a foto. Tente de novo." }, 500);
  }
  return json({ ok: true, mensagem: "Foto atualizada!" });
    }
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const p = url.pathname;
    const metodo = request.method;
    if (!p.startsWith("/api/")) return new Response("Não encontrado", { status: 404 });
    try {
      if (metodo === "POST") {
        const origem = request.headers.get("Origin");
        if (origem && new URL(origem).host !== url.host)
          return json({ erro: "Origem inválida" }, 403);
      }
      if (metodo === "POST") {
        if (p === "/api/login") return await login(request, env);
        if (p === "/api/aparelho/autorizar") return await autorizarAparelho(request, env);
        if (p === "/api/recuperar/aparelho") return await recuperarAparelho(request, env);
        if (p === "/api/recuperar/codigo") return await recuperarCodigo(request, env);
        if (p === "/api/recuperar/pedido") return await pedirRecuperacao(request, env);
        if (p === "/api/admin/pedidos/resolver") return await resolverPedido(request, env);
        if (p === "/api/admin/cadastrar-membro") return await cadastrarMembro(request, env);
        if (p === "/api/tickets/abrir") return await abrirTicket(request, env);
        if (p === "/api/admin/tickets/responder") return await adminResponderTicket(request, env);
        const resFreq = await rotasFrequencia(request, env, p, metodo, { json, quemSou, exigirAdmin, lerCorpo, texto, agora, auditar });
if (resFreq) return resFreq;
        if (p === "/api/ausencias/pedir") return await pedirAusencia(request, env);
        if (p === "/api/admin/ausencias/resolver") return await adminResolverAusencia(request, env);
        if (p === "/api/senha/trocar") return await trocarSenha(request, env);
        if (p === "/api/perfil/foto") return await salvarFotoSegura(request, env);
        if (p === "/api/logout") {
          const token = pegarCookie(request, "sessao");
          if (token) await env.DB.prepare("DELETE FROM sessoes WHERE token_hash = ?").bind(await sha256(token)).run();
          return json({ ok: true }, 200, { "Set-Cookie": cookie("sessao", "", 0) });
        }
      }
      if (metodo === "GET") {
        if (p === "/api/me") {
          const eu = await quemSou(request, env);
          if (!eu) return json({ erro: "Não autenticado" }, 401);
const fr = await env.DB.prepare("SELECT avatar_base64 FROM membros WHERE id = ?").bind(eu.id).first();
return json({ ok: true, ...eu, avatar_base64: fr ? fr.avatar_base64 : null });
        }
        if (p === "/api/admin/pedidos") return await listarPedidos(request, env);
        if (p === "/api/tickets/meus") return await meusTickets(request, env);
        if (p === "/api/admin/tickets") return await adminListarTickets(request, env);
        if (p === "/api/ausencias/minhas") return await minhasAusencias(request, env);
        if (p === "/api/admin/ausencias") return await adminListarAusencias(request, env);
        (p === "/api/membros/status") {
          const r = await env.DB.prepare(`
            SELECT m.id, m.nome, m.matricula, m.cargo, p.entrada 
            FROM membros m 
            LEFT JOIN ponto_registros p ON p.membro_id = m.id AND p.saida IS NULL 
            WHERE m.ativo = 1
            ORDER BY CASE WHEN p.entrada IS NOT NULL THEN 0 ELSE 1 END, m.nome ASC
          `).all();
          
          const online = r.results.filter(m => m.entrada !== null);
          const offline = r.results.filter(m => m.entrada === null);
          
          return json({ ok: true, online, offline, total_online: online.length });
        }
      }
      }
      const extra = await rotasComunicados(request, env, p, metodo, { json, quemSou, exigirAdmin, lerCorpo, texto, agora, auditar });
if (extra) return extra;

const resFicha = await rotasFicha(request, env, p, metodo, { json, quemSou, exigirAdmin, lerCorpo, texto, agora, auditar });
if (resFicha) return resFicha;

      return json({ erro: "Não encontrado" }, 404);
    } catch (e) {
      console.error("Erro interno:", e && e.message);
      return json({ erro: "Erro interno" }, 500);
    }
  },
};
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const p = url.pathname;
    const metodo = request.method;
    if (!p.startsWith("/api/")) return new Response("Não encontrado", { status: 404 });
    try {
      if (metodo === "POST") {
        const origem = request.headers.get("Origin");
        if (origem && new URL(origem).host !== url.host)
          return json({ erro: "Origem inválida" }, 403);
      }
      if (metodo === "POST") {
        if (p === "/api/login") return await login(request, env);
        if (p === "/api/aparelho/autorizar") return await autorizarAparelho(request, env);
        if (p === "/api/recuperar/aparelho") return await recuperarAparelho(request, env);
        if (p === "/api/recuperar/codigo") return await recuperarCodigo(request, env);
        if (p === "/api/recuperar/pedido") return await pedirRecuperacao(request, env);
        if (p === "/api/admin/pedidos/resolver") return await resolverPedido(request, env);
        if (p === "/api/admin/cadastrar-membro") return await cadastrarMembro(request, env);
        if (p === "/api/tickets/abrir") return await abrirTicket(request, env);
        if (p === "/api/admin/tickets/responder") return await adminResponderTicket(request, env);
        
        const resFreq = await rotasFrequencia(request, env, p, metodo, { json, quemSou, exigirAdmin, lerCorpo, texto, agora, auditar });
        if (resFreq) return resFreq;
        
        if (p === "/api/ausencias/pedir") return await pedirAusencia(request, env);
        if (p === "/api/admin/ausencias/resolver") return await adminResolverAusencia(request, env);
        if (p === "/api/senha/trocar") return await trocarSenha(request, env);
        if (p === "/api/perfil/foto") return await salvarFotoSegura(request, env);
        if (p === "/api/logout") {
          const token = pegarCookie(request, "sessao");
          if (token) await env.DB.prepare("DELETE FROM sessoes WHERE token_hash = ?").bind(await sha256(token)).run();
          return json({ ok: true }, 200, { "Set-Cookie": cookie("sessao", "", 0) });
        }
      }
      if (metodo === "GET") {
        if (p === "/api/me") {
          const eu = await quemSou(request, env);
          if (!eu) return json({ erro: "Não autenticado" }, 401);
          const fr = await env.DB.prepare("SELECT avatar_base64 FROM membros WHERE id = ?").bind(eu.id).first();
          return json({ ok: true, ...eu, avatar_base64: fr ? fr.avatar_base64 : null });
        }
        if (p === "/api/admin/pedidos") return await listarPedidos(request, env);
        if (p === "/api/tickets/meus") return await meusTickets(request, env);
        if (p === "/api/admin/tickets") return await adminListarTickets(request, env);
        if (p === "/api/ausencias/minhas") return await minhasAusencias(request, env);
        if (p === "/api/admin/ausencias") return await adminListarAusencias(request, env);
        
        if (p === "/api/membros/status") {
          const r = await env.DB.prepare(`
            SELECT m.id, m.nome, m.matricula, m.cargo, p.entrada 
            FROM membros m 
            LEFT JOIN ponto_registros p ON p.membro_id = m.id AND p.saida IS NULL 
            WHERE m.ativo = 1
            ORDER BY CASE WHEN p.entrada IS NOT NULL THEN 0 ELSE 1 END, m.nome ASC
          `).all();
          
          const online = r.results.filter(m => m.entrada !== null);
          const offline = r.results.filter(m => m.entrada === null);
          
          return json({ ok: true, online, offline, total_online: online.length });
        }
      }
      
      const extra = await rotasComunicados(request, env, p, metodo, { json, quemSou, exigirAdmin, lerCorpo, texto, agora, auditar });
      if (extra) return extra;

      const resFicha = await rotasFicha(request, env, p, metodo, { json, quemSou, exigirAdmin, lerCorpo, texto, agora, auditar });
      if (resFicha) return resFicha;

      return json({ erro: "Não encontrado" }, 404);
    } catch (e) {
      console.error("Erro interno:", e && e.message);
      return json({ erro: "Erro interno" }, 500);
    }
  },
};
