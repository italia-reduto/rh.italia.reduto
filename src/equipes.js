const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const clamp = (n, a, b) => Math.min(b, Math.max(a, n));
const vagasDe = (e) => (e.posicoes ? e.posicoes.split(",").length : e.limite);

// Embaralha com sorteio criptográfico, sem viés.
function embaralhar(lista) {
  const a = lista.slice();
  const buf = new Uint32Array(1);
  for (let i = a.length - 1; i > 0; i--) {
    const teto = Math.floor(4294967296 / (i + 1)) * (i + 1);
    do { crypto.getRandomValues(buf); } while (buf[0] >= teto);
    const j = buf[0] % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Distribui um membro por vez entre as equipes; evita repetir a equipe/posição do sorteio anterior.
function distribuir(equipes, pool, anterior, ocupacao) {
  const lista = embaralhar(pool);
  const abertas = {};
  for (const e of equipes) {
    const usada = ocupacao[e.id] || { n: 0, pos: new Set() };
    abertas[e.id] = {
      livres: vagasDe(e) - usada.n,
      posLivres: e.posicoes ? e.posicoes.split(",").filter((x) => !usada.pos.has(x)) : null,
    };
  }
  const resultado = [];
  let progresso = true;
  while (lista.length && progresso) {
    progresso = false;
    for (const e of equipes) {
      if (!lista.length) break;
      const ab = abertas[e.id];
      if (ab.livres <= 0) continue;
      let i = lista.findIndex((m) => !anterior[m.id] || anterior[m.id].equipe_id !== e.id);
      if (i < 0) i = 0;
      const m = lista.splice(i, 1)[0];
      let pos = null;
      if (ab.posLivres && ab.posLivres.length) {
        let k = ab.posLivres.findIndex((x) => !anterior[m.id] || anterior[m.id].posicao !== x);
        if (k < 0) k = 0;
        pos = ab.posLivres.splice(k, 1)[0];
      }
      ab.livres--;
      resultado.push({ equipe_id: e.id, membro_id: m.id, posicao: pos });
      progresso = true;
    }
  }
  return { resultado, sobra: lista };
}

const sorteioAtual = (env) =>
  env.DB.prepare("SELECT id, criado_em FROM sorteios ORDER BY id DESC LIMIT 1").first();

async function escalados(env, sorteioId) {
  const r = await env.DB.prepare(
    "SELECT em.equipe_id, em.membro_id, em.posicao, m.nome, m.cargo FROM equipe_membros em JOIN membros m ON m.id = em.membro_id WHERE em.sorteio_id = ? AND em.removido = 0 ORDER BY em.posicao, m.nome"
  ).bind(sorteioId).all();
  return r.results;
}

async function emServico(env) {
  const r = await env.DB.prepare(
    "SELECT m.id, m.nome, m.cargo FROM ponto_registros p JOIN membros m ON m.id = p.membro_id WHERE p.saida IS NULL AND m.ativo = 1 AND COALESCE(m.status, 'Ativo') = 'Ativo'"
  ).all();
  return r.results;
}

export async function rotasEquipes(request, env, p, metodo, h) {
  if (p !== "/api/equipe" && !p.startsWith("/api/admin/equipes")) return null;
  const { json, quemSou, exigirAdmin, lerCorpo, texto, agora, auditar } = h;
  const ip = request.headers.get("CF-Connecting-IP");

  // ---------- Membro: minha equipe ----------
  if (metodo === "GET" && p === "/api/equipe") {
    const eu = await quemSou(request, env);
    if (!eu || eu.trocar_senha) return json({ erro: "Não autenticado" }, 401);
    const atual = await sorteioAtual(env);
    if (!atual) return json({ ok: true, agora: agora(), equipe: null });
    const minha = await env.DB.prepare(
      "SELECT equipe_id, posicao FROM equipe_membros WHERE sorteio_id = ? AND membro_id = ? AND removido = 0"
    ).bind(atual.id, eu.id).first();
    if (!minha) return json({ ok: true, agora: agora(), equipe: null, sorteio_em: atual.criado_em });
    const e = await env.DB.prepare(
      "SELECT e.nome, e.funcao, e.posto, e.limite, e.posicoes, e.turno_inicio, e.turno_fim, r.nome AS responsavel FROM equipes e LEFT JOIN membros r ON r.id = e.responsavel_id WHERE e.id = ?"
    ).bind(minha.equipe_id).first();
    const todos = await escalados(env, atual.id);
    const colegas = todos
      .filter((x) => x.equipe_id === minha.equipe_id)
      .map((x) => ({ nome: x.nome, cargo: x.cargo, posicao: x.posicao, voce: x.membro_id === eu.id }));
    return json({
      ok: true, agora: agora(), sorteio_em: atual.criado_em,
      equipe: {
        nome: e.nome, funcao: e.funcao, posto: e.posto, turno_inicio: e.turno_inicio, turno_fim: e.turno_fim,
        responsavel: e.responsavel, vagas: vagasDe(e), ocupadas: colegas.length,
      },
      minha_posicao: minha.posicao,
      colegas,
    });
  }

  // ---------- Comando ----------
  const adm = await exigirAdmin(request, env);
  if (!adm) return json({ erro: "Sem permissão" }, 403);

  if (metodo === "GET" && p === "/api/admin/equipes") {
    const sorteio = await env.DB.prepare(
      "SELECT s.id, s.criado_em, a.nome AS autor FROM sorteios s LEFT JOIN membros a ON a.id = s.autor_id ORDER BY s.id DESC LIMIT 1"
    ).first();
    const eqs = await env.DB.prepare(
      "SELECT e.id, e.nome, e.funcao, e.posto, e.limite, e.posicoes, e.turno_inicio, e.turno_fim, e.ativa, r.matricula AS responsavel_matricula, r.nome AS responsavel FROM equipes e LEFT JOIN membros r ON r.id = e.responsavel_id ORDER BY e.ordem, e.id"
    ).all();
    const esc = sorteio ? await escalados(env, sorteio.id) : [];
    const ids = new Set(esc.map((x) => x.membro_id));
    const online = await emServico(env);
    return json({
      ok: true, agora: agora(), sorteio: sorteio || null,
      equipes: eqs.results.map((e) => ({
        ...e, vagas: vagasDe(e),
        membros: esc.filter((x) => x.equipe_id === e.id)
          .map((x) => ({ membro_id: x.membro_id, nome: x.nome, cargo: x.cargo, posicao: x.posicao })),
      })),
      reserva: online.filter((m) => !ids.has(m.id)),
    });
  }

  if (metodo === "POST" && p === "/api/admin/equipes/sortear") {
    const d = await lerCorpo(request);
    const modo = d && d.modo === "completar" ? "completar" : "novo";
    const eqRes = await env.DB.prepare(
      "SELECT id, posicoes, limite FROM equipes WHERE ativa = 1 ORDER BY ordem, id"
    ).all();
    const equipes = eqRes.results;
    if (!equipes.length) return json({ erro: "Nenhuma equipe ativa" }, 400);

    const atual = await sorteioAtual(env);
    const ocupacao = {}, anterior = {}, ja = new Set();
    if (atual) {
      const esc = await escalados(env, atual.id);
      for (const x of esc) {
        if (modo === "completar") {
          const o = (ocupacao[x.equipe_id] = ocupacao[x.equipe_id] || { n: 0, pos: new Set() });
          o.n++;
          if (x.posicao) o.pos.add(x.posicao);
          ja.add(x.membro_id);
        } else anterior[x.membro_id] = { equipe_id: x.equipe_id, posicao: x.posicao };
      }
    } else if (modo === "completar") return json({ erro: "Faça um novo sorteio primeiro." }, 409);

    const pool = (await emServico(env)).filter((m) => !ja.has(m.id));
    if (!pool.length) return json({ erro: "Ninguém em serviço para sortear." }, 409);
    const { resultado, sobra } = distribuir(equipes, pool, anterior, ocupacao);
    if (!resultado.length) return json({ erro: "Não há vagas livres." }, 409);

    let sorteioId;
    if (modo === "novo") {
      const r = await env.DB.prepare("INSERT INTO sorteios (autor_id, total) VALUES (?, ?)").bind(adm.id, resultado.length).run();
      sorteioId = r.meta.last_row_id;
    } else sorteioId = atual.id;
    try {
      await env.DB.batch(resultado.map((x) =>
        env.DB.prepare("INSERT INTO equipe_membros (sorteio_id, equipe_id, membro_id, posicao) VALUES (?, ?, ?, ?)")
          .bind(sorteioId, x.equipe_id, x.membro_id, x.posicao)
      ));
    } catch (e) {
      if (modo === "novo") await env.DB.prepare("DELETE FROM sorteios WHERE id = ?").bind(sorteioId).run();
      throw e;
    }
    await auditar(env, adm.id, modo === "novo" ? "equipes_sorteio" : "equipes_completar",
      resultado.length + " escalados, " + sobra.length + " sem vaga", ip);
    return json({ ok: true, escalados: resultado.length, sem_vaga: sobra.length });
  }

  if (metodo === "POST" && p === "/api/admin/equipes/remover") {
    const d = await lerCorpo(request);
    const membroId = Number(d && d.membro_id);
    if (!Number.isInteger(membroId)) return json({ erro: "Pedido inválido" }, 400);
    const atual = await sorteioAtual(env);
    if (!atual) return json({ erro: "Nenhum sorteio feito" }, 409);
    const r = await env.DB.prepare(
      "UPDATE equipe_membros SET removido = 1 WHERE sorteio_id = ? AND membro_id = ? AND removido = 0"
    ).bind(atual.id, membroId).run();
    if (!r.meta.changes) return json({ erro: "Membro não está em nenhuma equipe" }, 404);
    await auditar(env, adm.id, "equipes_remover", "Membro " + membroId, ip);
    return json({ ok: true });
  }

  if (metodo === "POST" && p === "/api/admin/equipes/editar") {
    const d = await lerCorpo(request);
    const id = Number(d && d.id);
    if (!Number.isInteger(id)) return json({ erro: "Pedido inválido" }, 400);
    const e = await env.DB.prepare("SELECT id, nome, posto, limite, posicoes FROM equipes WHERE id = ?").bind(id).first();
    if (!e) return json({ erro: "Equipe não encontrada" }, 404);
    const ini = String(d.turno_inicio || ""), fim = String(d.turno_fim || "");
    if (!HHMM.test(ini) || !HHMM.test(fim)) return json({ erro: "Horário inválido (use HH:MM)" }, 400);
    const posto = texto(d.posto, 60) || e.posto;
    const limite = e.posicoes ? e.limite : clamp(parseInt(d.limite, 10) || e.limite, 1, 30);
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
