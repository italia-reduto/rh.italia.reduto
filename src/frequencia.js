export async function rotasFrequencia(request, env, p, metodo, h) {
  const { json, quemSou, exigirAdmin, lerCorpo, texto, agora, auditar } = h;

  // 1. O PRÓPRIO MEMBRO VÊ SUAS FALTAS E PRESENÇAS
  if (metodo === "GET" && p === "/api/frequencia/minha") {
    const eu = await quemSou(request, env);
    if (!eu || eu.trocar_senha) return json({ erro: "Não autenticado" }, 401);

    const r = await env.DB.prepare(
      "SELECT id, data, tipo, status, observacao FROM frequencia WHERE membro_id = ? ORDER BY data DESC, id DESC LIMIT 50"
    ).bind(eu.id).all();
    
    return json({ ok: true, frequencias: r.results });
  }

  // 2. O ADMIN LANÇA UMA FALTA/PRESENÇA
  if (metodo === "POST" && p === "/api/admin/frequencia/lancar") {
    const ip = request.headers.get("CF-Connecting-IP");
    const adm = await exigirAdmin(request, env);
    if (!adm) return json({ erro: "Sem permissão" }, 403);

    const d = await lerCorpo(request);
    const matricula = texto(d.matricula, 40);
    const tipo = texto(d.tipo, 50); // Ex: Ponto, Meta, Reunião
    const status = texto(d.status, 20) || "Falta";
    const obs = texto(d.observacao, 200);
    const data = texto(d.data, 10) || new Date().toISOString().split("T")[0];

    if (!matricula || !tipo) return json({ erro: "Preencha matrícula e tipo." }, 400);

    const membro = await env.DB.prepare("SELECT id FROM membros WHERE matricula = ?").bind(matricula).first();
    if (!membro) return json({ erro: "Membro não encontrado." }, 404);

    await env.DB.prepare(
      "INSERT INTO frequencia (membro_id, data, tipo, status, observacao, registrado_por) VALUES (?, ?, ?, ?, ?, ?)"
    ).bind(membro.id, data, tipo, status, obs, adm.id).run();

    await auditar(env, adm.id, "frequencia_lancada", "Alvo: " + matricula + " | " + tipo + ": " + status, ip);
    return json({ ok: true, mensagem: "Registrado com sucesso!" });
  }

  // 3. O ADMIN VÊ QUEM ESTÁ ATIVO NO PONTO (Bate-ponto aberto)
  if (metodo === "GET" && p === "/api/admin/membros-ativos") {
    if (!(await exigirAdmin(request, env))) return json({ erro: "Sem permissão" }, 403);

    // Puxa os dados do ponto (tabela criada pelo Claude)
    const r = await env.DB.prepare(
      "SELECT p.id, p.entrada, m.nome, m.matricula, m.cargo FROM ponto_registros p JOIN membros m ON m.id = p.membro_id WHERE p.saida IS NULL ORDER BY p.entrada ASC"
    ).all();

    return json({ ok: true, ativos: r.results });
  }
// 4. O ADMIN VÊ QUEM BATEU PONTO EM UM DIA ESPECÍFICO
if (metodo === "GET" && p === "/api/admin/frequencia/dia") {
  const adm = await exigirAdmin(request, env);
  if (!adm) return json({ erro: "Sem permissão" }, 403);
  
  const url = new URL(request.url);
  const data = url.searchParams.get("data"); // Formato YYYY-MM-DD
  if (!data) return json({ erro: "Data não informada" }, 400);

  // Puxa os membros que têm registro de ponto naquele dia (usando a data do timestamp)
  const r = await env.DB.prepare(`
    SELECT m.id, m.nome, m.matricula, p.entrada, p.saida 
    FROM membros m
    JOIN ponto_registros p ON p.membro_id = m.id
    WHERE DATE(p.entrada, 'unixepoch', 'localtime') = ?
    GROUP BY m.id
  `).bind(data).all();
  
  // Puxa os registros de frequência já lançados nesse dia
  const freq = await env.DB.prepare(`
    SELECT membro_id, tipo, status, observacao 
    FROM frequencia 
    WHERE data = ?
  `).bind(data).all();

  return json({ ok: true, membros: r.results, frequencias: freq.results });
}
  return null;
}
