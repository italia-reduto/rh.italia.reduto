const clamp = (n, a, b) => Math.min(b, Math.max(a, n));
const OFFSET = -3 * 3600;   // horário de Brasília (UTC-3, fixo)
const BLOCO = 3 * 3600;     // turnos de 3 em 3 horas: 00-03, 03-06, ... 21-00
const inicioBloco = (t) => Math.floor((t + OFFSET) / BLOCO) * BLOCO - OFFSET;
const dois = (n) => String(n).padStart(2, "0");
function hhmm(t) {
  const l = (((t + OFFSET) % 86400) + 86400) % 86400;
  return dois(Math.floor(l / 3600)) + ":" + dois(Math.floor((l % 3600) / 60));
}
function lerDia(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ""));
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3];
  if (y < 2000 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return Date.UTC(y, mo - 1, d) / 1000 - OFFSET;
}
const infoBloco = (now) => {
  const i = inicioBloco(now);
  return { inicio_ts: i, fim_ts: i + BLOCO, turno_inicio: hhmm(i), turno_fim: hhmm(i + BLOCO) };
};

const vagasDe = (e) => (e.modo_posicao === "sorteio" && e.posicoes ? e.posicoes.split(",").length : e.limite);
const posicaoFixa = (e) => (e.posicoes || "").split(",")[0] || null;
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

// Inserção atômica: só entra se ainda houver vaga e a posição (quando exclusiva) estiver livre.
const SQL_ATRIBUIR =
  "INSERT INTO equipe_membros (registro_id, bloco_inicio, equipe_id, membro_id, posicao) SELECT ?, ?, ?, ?, ? " +
  "WHERE (SELECT COUNT(*) FROM equipe_membros em JOIN ponto_registros r ON r.id = em.registro_id WHERE r.saida IS NULL AND em.bloco_inicio = ? AND em.equipe_id = ?) < ? " +
  "AND (? IS NULL OR NOT EXISTS (SELECT 1 FROM equipe_membros em JOIN ponto_registros r ON r.id = em.registro_id WHERE r.saida IS NULL AND em.bloco_inicio = ? AND em.equipe_id = ? AND em.posicao = ?))";

// Coloca em equipe, no bloco atual, todo mundo que está em serviço e ainda não tem equipe neste bloco.
// Faz poucas consultas (limite do plano grátis) e grava tudo de uma vez.
export async function sincronizar(env) {
  const now = Math.floor(Date.now() / 1000);
  const bloco = inicioBloco(now);
  const pend = (await env.DB.prepare(
    "SELECT r.id AS registro_id, r.membro_id FROM ponto_registros r JOIN membros m ON m.id = r.membro_id LEFT JOIN equipe_membros em ON em.registro_id = r.id AND em.bloco_inicio = ? WHERE r.saida IS NULL AND em.registro_id IS NULL AND m.ativo = 1 AND COALESCE(m.status, 'Ativo') = 'Ativo' ORDER BY r.entrada, r.id"
  ).bind(bloco).all()).results;
  if (!pend.length) return;
  const eqs = (await env.DB.prepare(
    "SELECT id, limite, posicoes, modo_posicao FROM equipes WHERE ativa = 1 ORDER BY ordem, id"
  ).all()).results;
  if (!eqs.length) return;

  const occ = {};
  const ro = await env.DB.prepare(
    "SELECT em.equipe_id, em.posicao FROM equipe_membros em JOIN ponto_registros r ON r.id = em.registro_id WHERE r.saida IS NULL AND em.bloco_inicio = ?"
  ).bind(bloco).all();
  for (const x of ro.results) {
    const o = (occ[x.equipe_id] = occ[x.equipe_id] || { n: 0, pos: new Set() });
    o.n++;
    if (x.posicao) o.pos.add(x.posicao);
  }

  // Rodízio: equipe em que cada um esteve nos blocos recentes.
  const ids = [...new Set(pend.map((s) => s.membro_id))];
  const rp = await env.DB.prepare(
    "SELECT membro_id, equipe_id FROM equipe_membros WHERE bloco_inicio < ? AND bloco_inicio >= ? AND membro_id IN (" +
      ids.map(() => "?").join(",") + ") ORDER BY bloco_inicio"
  ).bind(bloco, bloco - 4 * BLOCO, ...ids).all();
  const anterior = {};
  for (const x of rp.results) anterior[x.membro_id] = x.equipe_id; // a mais recente prevalece

  const inserts = [];
  for (const s of pend) {
    const livres = (e) => vagasDe(e) - (occ[e.id] ? occ[e.id].n : 0);
    const cand = eqs.filter((e) => livres(e) > 0);
    if (!cand.length) break; // todas cheias: os demais esperam abrir vaga
    let pool = cand.filter((e) => anterior[s.membro_id] !== e.id);
    if (!pool.length) pool = cand;
    const pesos = pool.map(livres);
    let r = sorteioInt(pesos.reduce((a, b) => a + b, 0));
    let i = 0;
    while (r >= pesos[i]) { r -= pesos[i]; i++; }
    const e = pool[i];

    const o = (occ[e.id] = occ[e.id] || { n: 0, pos: new Set() });
    let posicao = null, unica = null;
    if (e.modo_posicao === "ordem") {                       // 1º a entrar = P1, 2º = P2...
      posicao = listaPosicoes(e).find((x) => !o.pos.has(x)) || null;
      unica = posicao;
    } else if (e.modo_posicao === "sorteio") {              // Monitoramento: P1/P3 sorteado
      const l = listaPosicoes(e).filter((x) => !o.pos.has(x));
      posicao = l.length ? l[sorteioInt(l.length)] : null;
      unica = posicao;
    } else if (e.modo_posicao === "fixo") posicao = posicaoFixa(e); // Vendas: sempre P2
    if ((e.modo_posicao === "ordem" || e.modo_posicao === "sorteio") && !posicao) continue;

    o.n++;
    if (unica) o.pos.add(unica);
    inserts.push(env.DB.prepare(SQL_ATRIBUIR)
      .bind(s.registro_id, bloco, e.id, s.membro_id, posicao, bloco, e.id, vagasDe(e), unica, bloco, e.id, unica));
  }
  if (inserts.length) await env.DB.batch(inserts);
}

// Chamado pelo agendador da Cloudflare a cada 3 horas (virada do bloco).
export async function rodarEscala(env) {
  await sincronizar(env);
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
    const bloco = inicioBloco(now);
    const aberto = await env.DB.prepare(
      "SELECT id, entrada FROM ponto_registros WHERE membro_id = ? AND saida IS NULL"
    ).bind(eu.id).first();
    if (!aberto) return json({ ok: true, agora: now, estado: "fora" });

    const pausas = await env.DB.prepare("SELECT inicio, fim FROM ponto_pausas WHERE registro_id = ?").bind(aberto.id).all();
    let pausaTotal = 0, pausaInicio = null;
    for (const x of pausas.results) {
      if (x.fim === null) pausaInicio = x.inicio; else pausaTotal += x.fim - x.inicio;
    }
    const base = {
      ok: true, agora: now, entrada: aberto.entrada, pausa_total: pausaTotal, pausa_inicio: pausaInicio,
      bloco: infoBloco(now),
    };

    const minha = await env.DB.prepare(
      "SELECT equipe_id, posicao FROM equipe_membros WHERE registro_id = ? AND bloco_inicio = ?"
    ).bind(aberto.id, bloco).first();
    if (!minha) return json({ ...base, estado: "sem_vaga" });

    const e = await env.DB.prepare(
      "SELECT e.nome, e.funcao, e.posto, e.limite, e.posicoes, e.modo_posicao, r.nome AS responsavel FROM equipes e LEFT JOIN membros r ON r.id = e.responsavel_id WHERE e.id = ?"
    ).bind(minha.equipe_id).first();
    const integ = await env.DB.prepare(
      "SELECT m.id AS membro_id, m.nome, m.matricula, r.entrada, em.posicao FROM equipe_membros em JOIN ponto_registros r ON r.id = em.registro_id AND r.saida IS NULL JOIN membros m ON m.id = em.membro_id WHERE em.bloco_inicio = ? AND em.equipe_id = ? ORDER BY r.entrada"
    ).bind(bloco, minha.equipe_id).all();
    return json({
      ...base, estado: "escala",
      equipe: {
        nome: e.nome, funcao: e.funcao, posto: e.posto, responsavel: e.responsavel,
        vagas: vagasDe(e), ocupadas: integ.results.length,
      },
      minha_posicao: minha.posicao,
      integrantes: integ.results.map((x) => ({
        nome: x.nome, matricula: x.matricula, desde: x.entrada, posicao: x.posicao, voce: x.membro_id === eu.id,
      })),
    });
  }

  // ---------- Comando ----------
  const adm = await exigirAdmin(request, env);
  if (!adm) return json({ erro: "Sem permissão" }, 403);

  if (metodo === "GET" && p === "/api/admin/equipes") {
    await sincronizar(env);
    const now = agora();
    const bloco = inicioBloco(now);
    const eqs = await env.DB.prepare(
      "SELECT e.id, e.nome, e.funcao, e.posto, e.limite, e.posicoes, e.modo_posicao, e.ativa, r.matricula AS responsavel_matricula, r.nome AS responsavel FROM equipes e LEFT JOIN membros r ON r.id = e.responsavel_id ORDER BY e.ordem, e.id"
    ).all();
    const atuais = await env.DB.prepare(
      "SELECT em.equipe_id, em.posicao, r.entrada, m.nome, m.matricula FROM equipe_membros em JOIN ponto_registros r ON r.id = em.registro_id AND r.saida IS NULL JOIN membros m ON m.id = em.membro_id WHERE em.bloco_inicio = ? ORDER BY em.posicao, r.entrada"
    ).bind(bloco).all();
    const semVaga = await env.DB.prepare(
      "SELECT m.nome, m.matricula FROM ponto_registros r JOIN membros m ON m.id = r.membro_id LEFT JOIN equipe_membros em ON em.registro_id = r.id AND em.bloco_inicio = ? WHERE r.saida IS NULL AND em.registro_id IS NULL ORDER BY r.entrada"
    ).bind(bloco).all();
    return json({
      ok: true, agora: now, bloco: infoBloco(now),
      equipes: eqs.results.map((e) => ({
        ...e, vagas: vagasDe(e),
        membros: atuais.results.filter((x) => x.equipe_id === e.id)
          .map((x) => ({ nome: x.nome, matricula: x.matricula, posicao: x.posicao, desde: x.entrada })),
      })),
      sem_vaga: semVaga.results,
    });
  }

  // Histórico de turnos: quem esteve em qual equipe em cada bloco de 3h (e de onde veio).
  if (metodo === "GET" && p === "/api/admin/equipes/historico") {
    const dia = lerDia(new URL(request.url).searchParams.get("dia"));
    if (dia === null) return json({ erro: "Data inválida" }, 400);
    const r = await env.DB.prepare(
      "SELECT em.bloco_inicio, em.posicao, m.nome, m.matricula, e.nome AS equipe, (SELECT e2.nome FROM equipe_membros em2 JOIN equipes e2 ON e2.id = em2.equipe_id WHERE em2.membro_id = em.membro_id AND em2.bloco_inicio < em.bloco_inicio ORDER BY em2.bloco_inicio DESC LIMIT 1) AS anterior FROM equipe_membros em JOIN membros m ON m.id = em.membro_id JOIN equipes e ON e.id = em.equipe_id WHERE em.bloco_inicio >= ? AND em.bloco_inicio < ? ORDER BY em.bloco_inicio DESC, e.ordem, em.posicao, m.nome LIMIT 400"
    ).bind(dia, dia + 86400).all();
    return json({ ok: true, agora: agora(), bloco_seg: BLOCO, itens: r.results });
  }

  if (metodo === "POST" && p === "/api/admin/equipes/editar") {
    const d = await lerCorpo(request);
    const id = Number(d && d.id);
    if (!Number.isInteger(id)) return json({ erro: "Pedido inválido" }, 400);
    const e = await env.DB.prepare("SELECT id, nome, posto, limite, modo_posicao FROM equipes WHERE id = ?").bind(id).first();
    if (!e) return json({ erro: "Equipe não encontrada" }, 404);
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
      "UPDATE equipes SET posto = ?, limite = ?, ativa = ?, responsavel_id = ? WHERE id = ?"
    ).bind(posto, limite, d.ativa ? 1 : 0, resp, id).run();
    await auditar(env, adm.id, "equipe_editada", e.nome, ip);
    return json({ ok: true });
  }

  return null;
}
