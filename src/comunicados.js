async function contar(env, sql, ...binds) {
  try {
    const r = await env.DB.prepare(sql).bind(...binds).first();
    return r ? r.n : null;
  } catch (e) {
    return null;
  }
}

export async function rotasComunicados(request, env, p, metodo, h) {
  const { json, quemSou, exigirAdmin, lerCorpo, texto, agora, auditar } = h;
  const ip = request.headers.get("CF-Connecting-IP");

  const doMembro = ["/api/comunicados", "/api/comunicados/ler", "/api/resumo"];
  if (doMembro.includes(p)) {
    const eu = await quemSou(request, env);
    if (!eu || eu.trocar_senha) return json({ erro: "Não autenticado" }, 401);

    if (metodo === "GET" && p === "/api/comunicados") {
      const r = await env.DB.prepare(
        "SELECT c.id, c.titulo, c.corpo, c.destaque, c.criado_em, m.nome AS autor, (SELECT COUNT(*) FROM comunicados_leituras l WHERE l.comunicado_id = c.id AND l.membro_id = ?) AS lido FROM comunicados c LEFT JOIN membros m ON m.id = c.autor_id ORDER BY c.id DESC LIMIT 30"
      ).bind(eu.id).all();
      return json({ ok: true, comunicados: r.results, admin: eu.nivel >= 50 });
    }

    if (metodo === "POST" && p === "/api/comunicados/ler") {
      const d = await lerCorpo(request);
      if (d && d.todos) {
        await env.DB.prepare(
          "INSERT OR IGNORE INTO comunicados_leituras (comunicado_id, membro_id) SELECT id, ? FROM comunicados"
        ).bind(eu.id).run();
        return json({ ok: true });
      }
      const id = Number(d && d.id);
      if (!Number.isInteger(id)) return json({ erro: "Pedido inválido" }, 400);
      await env.DB.prepare("INSERT OR IGNORE INTO comunicados_leituras (comunicado_id, membro_id) VALUES (?, ?)")
        .bind(id, eu.id).run();
      return json({ ok: true });
    }

    if (metodo === "GET" && p === "/api/resumo") {
      const naoLidos = await contar(
        env,
        "SELECT COUNT(*) AS n FROM comunicados c WHERE NOT EXISTS (SELECT 1 FROM comunicados_leituras l WHERE l.comunicado_id = c.id AND l.membro_id = ?)",
        eu.id
      );
      const tickets = await contar(
        env,
        "SELECT COUNT(*) AS n FROM tickets WHERE membro_id = ? AND status = 'aberto'",
        eu.id
      );
      const ausencias = await contar(
        env,
        "SELECT COUNT(*) AS n FROM ausencias WHERE membro_id = ? AND status = 'pendente'",
        eu.id
      );
      return json({ ok: true, comunicados_nao_lidos: naoLidos, tickets_abertos: tickets, ausencias_pendentes: ausencias });
    }
  }

  if (metodo === "POST" && p === "/api/admin/comunicados") {
    const adm = await exigirAdmin(request, env);
    if (!adm) return json({ erro: "Sem permissão" }, 403);
    const d = await lerCorpo(request);
    const titulo = texto(d && d.titulo, 80);
    const corpo = texto(d && d.corpo, 1200);
    const destaque = d && d.destaque ? 1 : 0;
    if (!titulo || !corpo) return json({ erro: "Preencha o título e o texto" }, 400);
    if (destaque) await env.DB.prepare("UPDATE comunicados SET destaque = 0 WHERE destaque = 1").run();
    await env.DB.prepare("INSERT INTO comunicados (titulo, corpo, autor_id, destaque) VALUES (?, ?, ?, ?)")
      .bind(titulo, corpo, adm.id, destaque).run();
    await auditar(env, adm.id, "comunicado_publicado", titulo, ip);
    return json({ ok: true });
  }

  if (metodo === "POST" && p === "/api/admin/comunicados/apagar") {
    const adm = await exigirAdmin(request, env);
    if (!adm) return json({ erro: "Sem permissão" }, 403);
    const d = await lerCorpo(request);
    const id = Number(d && d.id);
    if (!Number.isInteger(id)) return json({ erro: "Pedido inválido" }, 400);
    await env.DB.batch([
      env.DB.prepare("DELETE FROM comunicados_leituras WHERE comunicado_id = ?").bind(id),
      env.DB.prepare("DELETE FROM comunicados WHERE id = ?").bind(id),
    ]);
    await auditar(env, adm.id, "comunicado_apagado", "Comunicado " + id, ip);
    return json({ ok: true });
  }

  return null;
  }
