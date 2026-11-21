const OFFSET = -3 * 3600;        // Brasília (UTC-3)
const LIMITE = 12 * 3600;        // ponto esquecido aberto é encerrado após 12h
const MIN_SEQUENCIA = 600;       // dia só conta na sequência com 10 min ou mais
const ESPERA_ENTRADA = 30;       // segundos entre uma saída e a próxima entrada
const MIN_SESSAO = 60;           // segundos mínimos antes de bater a saída

const diaLocal = (t) => Math.floor((t + OFFSET) / 86400);
const inicioDia = (t) => diaLocal(t) * 86400 - OFFSET;
const inicioSemana = (t) => inicioDia(t) - ((diaLocal(t) + 3) % 7) * 86400; // semana começa na segunda
const sobreposicao = (ini, fim, de, ate) => Math.max(0, Math.min(fim, ate) - Math.max(ini, de));

async function fecharEsquecidas(env, now) {
  await env.DB.prepare(
    "UPDATE ponto_registros SET saida = entrada + ?, nota = 'Encerrado automaticamente (limite de 12h)' WHERE saida IS NULL AND entrada < ?"
  ).bind(LIMITE, now - LIMITE).run();
}

function calcularSequencia(sessoes, now) {
  const dias = new Set();
  sessoes.forEach((s) => {
    const fim = s.saida === null ? now : s.saida;
    if (fim - s.entrada >= MIN_SEQUENCIA) dias.add(diaLocal(s.entrada));
  });
  let d = diaLocal(now);
  if (!dias.has(d)) d -= 1;
  let n = 0;
  while (dias.has(d)) { n++; d--; }
  return n;
}

export async function rotasPonto(request, env, p, metodo, h) {
  if (!p.startsWith("/api/ponto") && !p.startsWith("/api/admin/ponto")) return null;
  const { json, quemSou, exigirAdmin, lerCorpo, agora, auditar } = h;
  const ip = request.headers.get("CF-Connecting-IP");

  // ---------- Membro ----------
  if (p.startsWith("/api/ponto")) {
    const eu = await quemSou(request, env);
    if (!eu || eu.trocar_senha) return json({ erro: "Não autenticado" }, 401);
    const now = agora();
    await fecharEsquecidas(env, now);

    if (metodo === "GET" && p === "/api/ponto") {
      const janela = await env.DB.prepare(
        "SELECT entrada, saida FROM ponto_registros WHERE membro_id = ? AND (entrada >= ? OR saida IS NULL)"
      ).bind(eu.id, now - 60 * 86400).all();
      const ini = inicioDia(now), sem = inicioSemana(now);
      let hoje = 0, semana = 0, aberto = null;
      for (const s of janela.results) {
        const fim = s.saida === null ? now : s.saida;
        hoje += sobreposicao(s.entrada, fim, ini, now);
        semana += sobreposicao(s.entrada, fim, sem, now);
        if (s.saida === null) aberto = { entrada: s.entrada };
      }
      const hist = await env.DB.prepare(
        "SELECT entrada, saida, nota FROM ponto_registros WHERE membro_id = ? ORDER BY id DESC LIMIT 30"
      ).bind(eu.id).all();
      return json({
        ok: true, agora: now, aberto, hoje, semana,
        sequencia: calcularSequencia(janela.results, now),
        historico: hist.results,
      });
    }

    if (metodo === "POST" && p === "/api/ponto/entrar") {
      const m = await env.DB.prepare("SELECT status FROM membros WHERE id = ?").bind(eu.id).first();
      if (m && m.status === "Suspenso") return json({ erro: "Conta suspensa: você não pode bater ponto." }, 403);
      const ult = await env.DB.prepare(
        "SELECT saida FROM ponto_registros WHERE membro_id = ? ORDER BY id DESC LIMIT 1"
      ).bind(eu.id).first();
      if (ult && ult.saida !== null && now - ult.saida < ESPERA_ENTRADA)
        return json({ erro: "Aguarde alguns segundos para bater a entrada de novo." }, 429);
      try {
        await env.DB.prepare("INSERT INTO ponto_registros (membro_id, entrada) VALUES (?, ?)").bind(eu.id, now).run();
      } catch (e) {
        if (String((e && e.message) || "").includes("UNIQUE")) return json({ erro: "Você já está em serviço." }, 409);
        throw e;
      }
      return json({ ok: true, entrada: now });
    }

    if (metodo === "POST" && p === "/api/ponto/sair") {
      const aberto = await env.DB.prepare(
        "SELECT id, entrada FROM ponto_registros WHERE membro_id = ? AND saida IS NULL"
      ).bind(eu.id).first();
      if (!aberto) return json({ erro: "Você não está em serviço." }, 409);
      if (now - aberto.entrada < MIN_SESSAO) return json({ erro: "Aguarde 1 minuto antes de bater a saída." }, 429);
      const r = await env.DB.prepare("UPDATE ponto_registros SET saida = ? WHERE id = ? AND saida IS NULL")
        .bind(now, aberto.id).run();
      if (!r.meta.changes) return json({ erro: "Você não está em serviço." }, 409);
      return json({ ok: true, duracao: now - aberto.entrada });
    }
    return null;
  }

  // ---------- Comando ----------
  const adm = await exigirAdmin(request, env);
  if (!adm) return json({ erro: "Sem permissão" }, 403);
  const now = agora();
  await fecharEsquecidas(env, now);

  if (metodo === "GET" && p === "/api/admin/ponto") {
    const online = await env.DB.prepare(
      "SELECT p.id, p.entrada, m.nome, m.matricula, m.cargo FROM ponto_registros p JOIN membros m ON m.id = p.membro_id WHERE p.saida IS NULL ORDER BY p.entrada"
    ).all();
    const sem = inicioSemana(now);
    const rank = await env.DB.prepare(
      "SELECT m.nome, m.matricula, SUM(MIN(COALESCE(p.saida, ?), ?) - MAX(p.entrada, ?)) AS seg FROM ponto_registros p JOIN membros m ON m.id = p.membro_id WHERE COALESCE(p.saida, ?) > ? GROUP BY p.membro_id ORDER BY seg DESC LIMIT 10"
    ).bind(now, now, sem, now, sem).all();
    return json({ ok: true, agora: now, online: online.results, ranking: rank.results });
  }

  if (metodo === "POST" && p === "/api/admin/ponto/encerrar") {
    const d = await lerCorpo(request);
    const id = Number(d && d.id);
    if (!Number.isInteger(id)) return json({ erro: "Pedido inválido" }, 400);
    const s = await env.DB.prepare(
      "SELECT p.id, m.id AS membro_id, m.nivel, m.matricula FROM ponto_registros p JOIN membros m ON m.id = p.membro_id WHERE p.id = ? AND p.saida IS NULL"
    ).bind(id).first();
    if (!s) return json({ erro: "Ponto não encontrado ou já encerrado" }, 404);
    if (s.membro_id === adm.id || s.nivel >= adm.nivel) return json({ erro: "Sem permissão para encerrar este ponto" }, 403);
    await env.DB.prepare(
      "UPDATE ponto_registros SET saida = ?, nota = 'Encerrado pelo comando' WHERE id = ? AND saida IS NULL"
    ).bind(now, id).run();
    await auditar(env, adm.id, "ponto_encerrado", "Matrícula " + s.matricula, ip);
    return json({ ok: true });
  }

  return null;
  }
