const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const clamp = (n, a, b) => Math.min(b, Math.max(a, n));
const vagasDe = (e) => (e.modo_posicao === "sorteio" && e.posicoes ? e.posicoes.split(",").length : e.limite);
const listaPosicoes = (e) =>
  e.modo_posicao === "sorteio" ? (e.posicoes || "").split(",").filter(Boolean)
  : e.modo_posicao === "ordem" ? Array.from({ length: e.limite }, (_, i) => "P" + (i + 1))
  : [];

// Número aleatório de 0 a n-1, sem viés.
function sorteioInt(n) {
  if (n <= 1) return 0;
  const buf = new Uint32Array(1);
  const teto = Math.floor(4294967296 / n) * n;
  do { crypto.getRandomValues(buf); } while (buf[0] >= teto);
  return buf[0] % n;
}

async function ocupacaoAtual(env) {
  const r = await env.DB.prepare(
    "SELECT em.equipe_id, em.posicao FROM equipe_membros em JOIN ponto_registros r ON r.id = em.registro_id WHERE r.saida IS NULL"
  ).all();
  const o = {};
  for (const x of r.results) {
    const e = (o[x.equipe_id] = o[x.equipe_id] || { n: 0, pos: new Set() });
    e.n++;
    if (x.posicao) e.pos.add(x.posicao);
  }
  return o;
}

// Inserção atômica: só entra se ainda houver vaga e a posição estiver livre.
const SQL_ATRIBUIR =
  "INSERT INTO equipe_membros (registro_id, equipe_id, membro_id, posicao) SELECT ?, ?, ?, ? " +
  "WHERE (SELECT COUNT(*) FROM equipe_membros em JOIN ponto_registros r ON r.id = em.registro_id WHERE r.saida IS NULL AND em.equipe_id = ?) < ? " +
  "AND (? IS NULL OR NOT EXISTS (SELECT 1 FROM equipe_membros em JOIN ponto_registros r ON r.id = em.registro_id WHERE r.saida IS NULL AND em.equipe_id = ? AND em.posicao = ?))";

// Coloca em equipe, por ordem de entrada, todo mundo que está em serviço e ainda não tem equipe.
async function sincronizar(env) {
  const pend = (await env.DB.prepare(
    "SELECT r.id AS registro_id, r.membro_id FROM ponto_registros r JOIN membros m ON m.id = r.membro_id LEFT JOIN equipe_membros em ON em.registro_id = r.id WHERE r.saida IS NULL AND em.registro_id IS NULL AND m.ativo = 1 AND COALESCE(m.status, 'Ativo') = 'Ativo' ORDER BY r.entrada, r.id"
  ).all()).results;
  if (!pend.length) return;
  const eqs = (await env.DB.prepare(
    "SELECT id, limite, posicoes, modo_posicao FROM equipes WHERE ativa = 1 ORDER BY ordem, id"
  ).all()).results;
  if (!eqs.length) return;

  for (const s of pend) {
    for (let tentativa = 0; tentativa < 3; tentativa++) {
      const occ = await ocupacaoAtual(env);
      const livres = (e) => vagasDe(e) - (occ[e.id] ? occ[e.id].n : 0);
      const cand = eqs.filter((e) => livres(e) > 0);
      if (!cand.length) return; // todas cheias: os demais esperam abrir vaga

      // Rodízio: evita repetir a equipe do turno anterior, se houver alternativa.
      const ult = await env.DB.prepare(
        "SELECT equipe_id FROM equipe_membros WHERE membro_id = ? AND registro_id < ? ORDER BY registro_id DESC LIMIT 1"
      ).bind(s.membro_id, s.registro_id).first();
      let pool = cand.filter((e) => !ult || e.id !== ult.equipe_id);
      if (!pool.length) pool = cand;

      // Sorteio ponderado pelas vagas livres.
      const pesos = pool.map(livres);
      let r = sorteioInt(pesos.reduce((a, b) => a + b, 0));
      let i = 0;
      while (r >= pesos[i]) { r -= pesos[i]; i++; }
      const e = pool[i];

      const usadas = occ[e.id] ? occ[e.id].pos : new Set();
      const posLivres = listaPosicoes(e).filter((x) => !usadas.has(x));
      let posicao = null;
      if (e.modo_posicao === "ordem") posicao = posLivres[0] || null;           // 1º a entrar = P1, 2º = P2...
      else if (e.modo_posicao === "sorteio") posicao = posLivres.length ? posLivres[sorteioInt(posLivres.length)] : null;
      if (e.modo_posicao !== "nenhum" && !posicao) continue;

      const res = await env.DB.prepare(SQL_ATRIBUIR)
        .bind(s.registro_id, e.id, s.membro_id, posicao, e.id, vagasDe(e), posicao, e.id, posicao).run();
      if (res.meta.changes) break;
    }
  }
}

export async function rotasEquipes(request, env, p, metodo, h) {
  if (p !== "/api/equipe" && !p.startsWith("/api/admin/equipes")) return null;
  const { json, quemSou, exigirAdmin, lerCorpo, texto, agora, auditar } = h;
  const ip = request.headers.get("CF-Connecting-IP");

  // ---------- Membro: minha escala ----------
  if (metodo === "GET" && p === "/api/equipe") {
    const eu = await quemSou(request, env);
    if (!eu || eu.trocar_senha) return json({ erro: "Não autenticado" }, 401);
    await sincronizar(env);
    const now = agora();
    const aberto = await env.DB.prepare(
      "SELECT id, entrada FROM ponto_registros WHERE membro_id = ? AND saida IS NULL"
    ).bind(eu.id).first();
    if (!aberto) return json({ ok: true, agora: now, estado: "fora" });

    const pausas = await env.DB.prepare("SELECT inicio, fim FROM ponto_pausas WHERE registro_id = ?").bind(aberto.id).all();
    let pausaTotal = 0, pausaInicio = null;
    for (const x of pausas.results) {
      if (x.fim === null) pausaInicio = x.inicio; else pausaTotal += x.fim - x.inicio;
    }
    const base = { ok: true, agora: now, entrada: aberto.entrada, pausa_total: pausaTotal, pausa_inicio: pausaInicio };

    const minha = await env.DB.prepare("SELECT equipe_id, posicao FROM equipe_membros WHERE registro_id = ?").bind(aberto.id).first();
    if (!minha) return json({ ...base, estado: "sem_vaga" });

    const e = await env.DB.prepare(
      "SELECT e.nome, e.funcao, e.posto, e.limite, e.posicoes, e.modo_posicao, e.turno_inicio, e.turno_fim, r.nome AS responsavel FROM equipes e LEFT JOIN membros r ON r.id = e.responsavel_id WHERE e.id = ?"
    ).bind(minha.equipe_id).first();
    const integ = await env.DB.prepare(
      "SELECT m.id AS membro_id, m.nome, m.matricula, r.entrada, em.posicao FROM equipe_membros em JOIN ponto_registros r ON r.id = em.registro_id AND r.saida IS NULL JOIN membros m ON m.id = em.membro_id WHERE em.equipe_id = ? ORDER BY r.entrada"
    ).bind(minha.equipe_id).all();
    return json({
      ...base, estado: "escala",
      equipe: {
        nome: e.nome, funcao: e.funcao, posto: e.posto, turno_inicio: e.turno_inicio, turno_fim: e.turno_fim,
        responsavel: e.responsavel, vagas: vagasDe(e), ocupadas: integ.results.length,
      },
      minha_posicao: minha.posicao,
      integrantes: integ.results.map((x) => ({
        nome: x.nome, matricula: x.matricula, desde: x.entrada, posicao: x.posicao, voce: x.membro_id === eu.id,
      })),
    });
  }

  // ---------- Comando: visão geral e ajustes ----------
  const adm = await exigirAdmin(request, env);
  if (!adm) return json({ erro: "Sem permissão" }, 403);

  if (metodo === "GET" && p === "/api/admin/equipes") {
    await sincronizar(env);
    const eqs = await env.DB.prepare(
      "SELECT e.id, e.nome, e.funcao, e.posto, e.limite, e.posicoes, e.modo_posicao, e.turno_inicio, e.turno_fim, e.ativa, r.matricula AS responsavel_matricula, r.nome AS responsavel FROM equipes e LEFT JOIN membros r ON r.id = e.responsavel_id ORDER BY e.ordem, e.id"
    ).all();
    const atuais = await env.DB.prepare(
      "SELECT em.equipe_id, em.posicao, r.entrada, m.nome, m.matricula FROM equipe_membros em JOIN ponto_registros r ON r.id = em.registro_id AND r.saida IS NULL JOIN membros m ON m.id = em.membro_id ORDER BY em.posicao, r.entrada"
    ).all();
    const semVaga = await env.DB.prepare(
      "SELECT m.nome, m.matricula FROM ponto_registros r JOIN membros m ON m.id = r.membro_id LEFT JOIN equipe_membros em ON em.registro_id = r.id WHERE r.saida IS NULL AND em.registro_id IS NULL ORDER BY r.entrada"
    ).all();
    return json({
      ok: true, agora: agora(),
      equipes: eqs.results.map((e) => ({
        ...e, vagas: vagasDe(e),
        membros: atuais.results.filter((x) => x.equipe_id === e.id)
          .map((x) => ({ nome: x.nome, matricula: x.matricula, posicao: x.posicao, desde: x.entrada })),
      })),
      sem_vaga: semVaga.results,
    });
  }

  if (metodo === "POST" && p === "/api/admin/equipes/editar") {
    const d = await lerCorpo(request);
    const id = Number(d && d.id);
    if (!Number.isInteger(id)) return json({ erro: "Pedido inválido" }, 400);
    const e = await env.DB.prepare("SELECT id, nome, posto, limite, modo_posicao FROM equipes WHERE id = ?").bind(id).first();
    if (!e) return json({ erro: "Equipe não encontrada" }, 404);
    const ini = String(d.turno_inicio || ""), fim = String(d.turno_fim || "");
    if (!HHMM.test(ini) || !HHMM.test(fim)) return json({ erro: "Horário inválido (use HH:MM)" }, 400);
    const posto = texto(d.posto, 60) || e.posto;
    const limite = e.modo_posicao === "sorteio" ? e.limite : clamp(parseInt(d.limite, 10) || e.limite, 1, 30);
    let resp = null;
    const mat = texto(d.responsavel, 40);
    if (mat) {
      const r = await env.DB.prepare("SELECT id FROM membros WHERE matricula = ? AND ativo = 1").bind(mat).first();
      if (!r) return json({ erro: "Responsável não encontrado" }, 404);
      resp = r.id;
    }
    await env.DB.prepare(
      "UPDATE equipes SET posto = ?, turno_inicio = ?, turno_fim = ?, limite = ?, ativa = ?, responsavel_id = ? WHERE id = ?"
    ).bind(posto, ini, fim, limite, d.ativa ? 1 : 0, resp, id).run();
    await auditar(env, adm.id, "equipe_editada", e.nome, ip);
    return json({ ok: true });
  }

  return null;
                                       }
