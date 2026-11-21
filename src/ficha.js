const TIPOS = ["adv", "elo", "promo", "nota"];
const STATUS_OK = ["Ativo", "Suspenso", "Exonerado"];
const TREINO_OK = ["Pendente", "Concluído"];
const CAMPOS = "id, matricula, nome, cargo, advertencias, elogios, treinamento_status, criado_em, discord_id, game_id, status, trust_score, badges";

// Contadores e índice são sempre calculados a partir dos eventos válidos (não anulados).
const SQL_RECALCULAR =
  "UPDATE membros SET " +
  "advertencias = (SELECT COUNT(*) FROM ficha_eventos WHERE membro_id = ? AND tipo = 'adv' AND anulado = 0), " +
  "elogios = (SELECT COUNT(*) FROM ficha_eventos WHERE membro_id = ? AND tipo = 'elo' AND anulado = 0), " +
  "trust_score = MAX(0, MIN(100, 100 - 10 * (SELECT COUNT(*) FROM ficha_eventos WHERE membro_id = ? AND tipo = 'adv' AND anulado = 0) + 5 * (SELECT COUNT(*) FROM ficha_eventos WHERE membro_id = ? AND tipo = 'elo' AND anulado = 0))) " +
  "WHERE id = ?";
const recalcular = (env, id) => env.DB.prepare(SQL_RECALCULAR).bind(id, id, id, id, id);

async function contagens(env, id) {
  const t = await env.DB.prepare("SELECT COUNT(*) AS total FROM tickets WHERE membro_id = ?").bind(id).first();
  const a = await env.DB.prepare("SELECT COUNT(*) AS total FROM ausencias WHERE membro_id = ?").bind(id).first();
  return { tickets: t ? t.total : 0, ausencias: a ? a.total : 0 };
}

async function listarEventos(env, id, comAutor) {
  const r = await env.DB.prepare(
    "SELECT e.id, e.tipo, e.texto, e.criado_em, e.anulado, a.nome AS autor FROM ficha_eventos e LEFT JOIN membros a ON a.id = e.autor_id WHERE e.membro_id = ? ORDER BY e.id DESC LIMIT 60"
  ).bind(id).all();
  return r.results.map((e) => ({
    id: e.id, tipo: e.tipo, texto: e.texto, criado_em: e.criado_em, anulado: e.anulado,
    autor: comAutor ? e.autor : null,
  }));
}

const buscarAlvo = (env, matricula) =>
  env.DB.prepare(
    "SELECT id, matricula, nome, nivel, status, treinamento_status, badges, game_id, discord_id, observacoes FROM membros WHERE matricula = ?"
  ).bind(matricula).first();

// Regra de hierarquia: só mexe em quem tem nível MENOR e nunca em si mesmo.
const podeMexer = (adm, alvo) => alvo.id !== adm.id && alvo.nivel < adm.nivel;

export async function rotasFicha(request, env, p, metodo, h) {
  const { json, quemSou, exigirAdmin, lerCorpo, texto, agora, auditar } = h;
  const ip = request.headers.get("CF-Connecting-IP");

  // Ficha do próprio membro: sem notas do comando e sem IP.
  if (metodo === "GET" && p === "/api/ficha") {
    const eu = await quemSou(request, env);
    if (!eu || eu.trocar_senha) return json({ erro: "Não autenticado" }, 401);
    const membro = await env.DB.prepare("SELECT " + CAMPOS + " FROM membros WHERE id = ?").bind(eu.id).first();
    if (!membro) return json({ erro: "Ficha não encontrada" }, 404);
    delete membro.id;
    return json({
      ok: true,
      ficha: membro,
      stats: await contagens(env, eu.id),
      eventos: await listarEventos(env, eu.id, false),
      pode_editar: false,
    });
  }

  // Ficha de outro membro: só comando, e só de nível igual ou menor que o do consultante.
  if (metodo === "GET" && p === "/api/admin/ficha") {
    const adm = await exigirAdmin(request, env);
    if (!adm) return json({ erro: "Sem permissão" }, 403);
    const matricula = texto(new URL(request.url).searchParams.get("matricula"), 40);
    if (!matricula) return json({ erro: "Matrícula não informada" }, 400);

    const membro = await env.DB.prepare(
      "SELECT " + CAMPOS + ", nivel, observacoes, ultimo_ip FROM membros WHERE matricula = ?"
    ).bind(matricula).first();
    if (!membro) return json({ erro: "Membro não encontrado" }, 404);
    if (membro.nivel > adm.nivel) return json({ erro: "Sem permissão para ver esta ficha" }, 403);

    const id = membro.id;
    delete membro.id;
    if (id !== adm.id) await auditar(env, adm.id, "ficha_consultada", "Matrícula: " + matricula, ip);
    return json({
      ok: true,
      ficha: membro,
      stats: await contagens(env, id),
      eventos: await listarEventos(env, id, true),
      pode_editar: podeMexer(adm, { id, nivel: membro.nivel }),
    });
  }

  // Editar dados cadastrais (contadores e índice NÃO se editam: vêm dos eventos).
  if (metodo === "POST" && p === "/api/admin/ficha/editar") {
    const adm = await exigirAdmin(request, env);
    if (!adm) return json({ erro: "Sem permissão" }, 403);
    const d = await lerCorpo(request);
    if (!d) return json({ erro: "Pedido inválido" }, 400);

    const alvo = await buscarAlvo(env, texto(d.matricula, 40));
    if (!alvo) return json({ erro: "Membro não encontrado" }, 404);
    if (alvo.id === adm.id) return json({ erro: "Você não pode editar a própria ficha" }, 403);
    if (!podeMexer(adm, alvo)) return json({ erro: "Sem permissão: nível igual ou superior ao seu" }, 403);

    const status = STATUS_OK.includes(d.status) ? d.status : alvo.status || "Ativo";
    const treino = TREINO_OK.includes(d.treinamento_status) ? d.treinamento_status : alvo.treinamento_status || "Pendente";
    const badges = texto(d.badges, 100);
    const gameId = texto(d.game_id, 30);
    const discordId = texto(d.discord_id, 40);
    const obs = texto(d.observacoes, 400);
    const ativo = status === "Exonerado" ? 0 : 1;

    const mudou = [];
    if (status !== (alvo.status || "Ativo")) mudou.push("situação " + (alvo.status || "Ativo") + " → " + status);
    if (treino !== (alvo.treinamento_status || "Pendente")) mudou.push("treinamento");
    if (badges !== (alvo.badges || "")) mudou.push("distintivos");
    if (gameId !== (alvo.game_id || "")) mudou.push("game id");
    if (discordId !== (alvo.discord_id || "")) mudou.push("discord");
    if (obs !== (alvo.observacoes || "")) mudou.push("notas");

    const comandos = [
      env.DB.prepare(
        "UPDATE membros SET status = ?, treinamento_status = ?, badges = ?, game_id = ?, discord_id = ?, observacoes = ?, ativo = ? WHERE id = ?"
      ).bind(status, treino, badges, gameId, discordId, obs, ativo, alvo.id),
    ];
    if (ativo === 0) comandos.push(env.DB.prepare("DELETE FROM sessoes WHERE membro_id = ?").bind(alvo.id));
    await env.DB.batch(comandos);

    await auditar(env, adm.id, "ficha_editada", "Matrícula " + alvo.matricula + ": " + (mudou.join(", ") || "sem mudanças"), ip);
    return json({ ok: true, mensagem: "Ficha atualizada!" });
  }

  // Registrar evento (advertência, elogio, promoção ou anotação).
  if (metodo === "POST" && p === "/api/admin/ficha/evento") {
    const adm = await exigirAdmin(request, env);
    if (!adm) return json({ erro: "Sem permissão" }, 403);
    const d = await lerCorpo(request);
    if (!d) return json({ erro: "Pedido inválido" }, 400);

    const tipo = d.tipo;
    const txt = texto(d.txt, 120);
    if (!TIPOS.includes(tipo) || !txt) return json({ erro: "Escolha o tipo e escreva o texto" }, 400);

    const alvo = await buscarAlvo(env, texto(d.matricula, 40));
    if (!alvo) return json({ erro: "Membro não encontrado" }, 404);
    if (alvo.id === adm.id) return json({ erro: "Você não pode registrar eventos na própria ficha" }, 403);
    if (!podeMexer(adm, alvo)) return json({ erro: "Sem permissão: nível igual ou superior ao seu" }, 403);

    await env.DB.batch([
      env.DB.prepare("INSERT INTO ficha_eventos (membro_id, tipo, texto, autor_id) VALUES (?, ?, ?, ?)")
        .bind(alvo.id, tipo, txt, adm.id),
      recalcular(env, alvo.id),
    ]);
    await auditar(env, adm.id, "ficha_evento_" + tipo, "Matrícula " + alvo.matricula, ip);
    return json({ ok: true });
  }

  // Anular evento: o registro continua no histórico, mas deixa de contar.
  if (metodo === "POST" && p === "/api/admin/ficha/evento/anular") {
    const adm = await exigirAdmin(request, env);
    if (!adm) return json({ erro: "Sem permissão" }, 403);
    const d = await lerCorpo(request);
    const id = Number(d && d.id);
    if (!Number.isInteger(id)) return json({ erro: "Pedido inválido" }, 400);

    const ev = await env.DB.prepare(
      "SELECT e.id, e.tipo, e.anulado, m.id AS membro_id, m.nivel, m.matricula FROM ficha_eventos e JOIN membros m ON m.id = e.membro_id WHERE e.id = ?"
    ).bind(id).first();
    if (!ev) return json({ erro: "Registro não encontrado" }, 404);
    if (ev.anulado) return json({ erro: "Registro já anulado" }, 409);
    if (!podeMexer(adm, { id: ev.membro_id, nivel: ev.nivel })) return json({ erro: "Sem permissão" }, 403);

    await env.DB.batch([
      env.DB.prepare("UPDATE ficha_eventos SET anulado = 1, anulado_por = ?, anulado_em = ? WHERE id = ? AND anulado = 0")
        .bind(adm.id, agora(), id),
      recalcular(env, ev.membro_id),
    ]);
    await auditar(env, adm.id, "ficha_evento_anulado", "Matrícula " + ev.matricula + ", registro " + id, ip);
    return json({ ok: true });
  }

  return null;
  }
