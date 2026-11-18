export async function rotasFicha(request, env, p, metodo, h) {
  const { json, quemSou, exigirAdmin, lerCorpo, texto, agora, auditar } = h;

  if (metodo === "GET" && p === "/api/ficha") {
    const eu = await quemSou(request, env);
    if (!eu) return json({ erro: "Não autenticado" }, 401);

    const membro = await env.DB.prepare(
      "SELECT matricula, nome, cargo, nivel, advertencias, elogios, treinamento_status, observacoes, criado_em, discord_id, game_id, status FROM membros WHERE id = ?"
    ).bind(eu.id).first();

    const tks = await env.DB.prepare("SELECT COUNT(*) as total FROM tickets WHERE membro_id = ?").bind(eu.id).first();
    const aus = await env.DB.prepare("SELECT COUNT(*) as total FROM ausencias WHERE membro_id = ?").bind(eu.id).first();

    return json({ ok: true, ficha: membro, stats: { tickets: tks.total, ausencias: aus.total } });
  }

  if (metodo === "GET" && p === "/api/admin/ficha") {
    if (!(await exigirAdmin(request, env))) return json({ erro: "Sem permissão" }, 403);
    
    const url = new URL(request.url);
    const matricula = url.searchParams.get("matricula");
    if (!matricula) return json({ erro: "Matrícula não informada" }, 400);

    const membro = await env.DB.prepare(
      "SELECT id, matricula, nome, cargo, nivel, advertencias, elogios, treinamento_status, observacoes, criado_em, discord_id, game_id, status FROM membros WHERE matricula = ?"
    ).bind(matricula).first();
    
    if (!membro) return json({ erro: "Membro não encontrado" }, 404);

    const tks = await env.DB.prepare("SELECT COUNT(*) as total FROM tickets WHERE membro_id = ?").bind(membro.id).first();
    const aus = await env.DB.prepare("SELECT COUNT(*) as total FROM ausencias WHERE membro_id = ?").bind(membro.id).first();

    return json({ ok: true, ficha: membro, stats: { tickets: tks.total, ausencias: aus.total } });
  }

  if (metodo === "POST" && p === "/api/admin/ficha/editar") {
    const ip = request.headers.get("CF-Connecting-IP");
    const adm = await exigirAdmin(request, env);
    if (!adm) return json({ erro: "Sem permissão" }, 403);

    const d = await lerCorpo(request);
    if (!d) return json({ erro: "Pedido inválido" }, 400);

    const matricula = texto(d.matricula, 40);
    const advertencias = parseInt(d.advertencias, 10) || 0;
    const elogios = parseInt(d.elogios, 10) || 0;
    const treinamento_status = texto(d.treinamento_status, 20) || 'Pendente';
    const observacoes = texto(d.observacoes, 1000);
    const discord_id = texto(d.discord_id, 50);
    const game_id = texto(d.game_id, 50);
    const status = texto(d.status, 20) || 'Ativo';

    await env.DB.prepare(
      "UPDATE membros SET advertencias = ?, elogios = ?, treinamento_status = ?, observacoes = ?, discord_id = ?, game_id = ?, status = ? WHERE matricula = ?"
    ).bind(advertencias, elogios, treinamento_status, observacoes, discord_id, game_id, status, matricula).run();

    await auditar(env, adm.id, "ficha_editada", "Matrícula: " + matricula, ip);
    return json({ ok: true, mensagem: "Ficha atualizada!" });
  }

  return null;
}
