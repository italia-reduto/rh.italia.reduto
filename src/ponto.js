import { rotasEquipes } from "./equipes.js";
const OFFSET = -3 * 3600;      // Brasília (UTC-3)
const LIMITE = 12 * 3600;      // ponto aberto há mais de 12h é encerrado sozinho
const LIMITE_PAUSA = 30 * 60;  // pausa acima de 30 min encerra o ponto
const MAX_PAUSAS = 8;          // pausas por turno
const ESPERA_ENTRADA = 60;     // segundos de espera depois de encerrar
const MIN_SESSAO = 5;          // segundos mínimos antes de encerrar (evita toque duplo)
const ESPERA_PAUSA = 10;       // segundos entre iniciar/retornar e pausar
const MIN_SEQUENCIA = 600;     // dia só entra na sequência com 10 min ou mais
const META_DIA = 2 * 3600;     // meta diária (2h)
const MAX_DIAS = 120;          // período máximo do histórico

const diaLocal = (t) => Math.floor((t + OFFSET) / 86400);
const inicioDia = (t) => diaLocal(t) * 86400 - OFFSET;
const inicioSemana = (t) => inicioDia(t) - ((diaLocal(t) + 3) % 7) * 86400; // segunda-feira
const sobre = (ini, fim, de, ate) => Math.max(0, Math.min(fim, ate) - Math.max(ini, de));

function lerDia(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ""));
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3];
  if (y < 2000 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return Date.UTC(y, mo - 1, d) / 1000 - OFFSET;
}

function mapaPausas(linhas) {
  const m = {};
  for (const x of linhas) (m[x.registro_id] = m[x.registro_id] || []).push({ inicio: x.inicio, fim: x.fim });
  return m;
}

function pausaTotal(s, pausas, now) {
  const fim = s.saida === null ? now : s.saida;
  let t = 0;
  for (const pa of pausas || []) {
    const pf = pa.fim === null ? now : pa.fim;
    t += sobre(Math.max(pa.inicio, s.entrada), Math.min(pf, fim), 0, Infinity);
  }
  return t;
}

// Tempo trabalhado (sem pausas) dentro de uma janela [de, ate].
function tempoNaJanela(s, pausas, de, ate, now) {
  const fim = s.saida === null ? now : s.saida;
  let t = sobre(s.entrada, fim, de, ate);
  for (const pa of pausas || []) {
    const pf = pa.fim === null ? now : pa.fim;
    t -= sobre(Math.max(pa.inicio, s.entrada), Math.min(pf, fim), de, ate);
  }
  return Math.max(0, t);
}

function montarSessao(s, pausas, now) {
  const fim = s.saida === null ? now : s.saida;
  const pt = pausaTotal(s, pausas, now);
  return {
    entrada: s.entrada, saida: s.saida, nota: s.nota,
    pausas: (pausas || []).map((x) => ({ inicio: x.inicio, fim: x.fim })),
    pausa_total: pt,
    trabalhado: Math.max(0, fim - s.entrada - pt),
  };
}

function calcularSequencia(sessoes, mp, now) {
  const dias = new Set();
  for (const s of sessoes) {
    const fim = s.saida === null ? now : s.saida;
    if (fim - s.entrada - pausaTotal(s, mp[s.id], now) >= MIN_SEQUENCIA) dias.add(diaLocal(s.entrada));
  }
  let d = diaLocal(now);
  if (!dias.has(d)) d -= 1;
  let n = 0;
  while (dias.has(d)) { n++; d--; }
  return n;
}

function calcularDiasMeta(sessoes, mp, now) {
  const sem = inicioSemana(now);
  let n = 0;
  for (let i = 0; i < 7; i++) {
    const de = sem + i * 86400;
    if (de > now) break;
    let t = 0;
    for (const s of sessoes) t += tempoNaJanela(s, mp[s.id], de, de + 86400, now);
    if (t >= META_DIA) n++;
  }
  return n;
}

// Encerra sozinho: pausa acima de 30 min e ponto esquecido aberto por mais de 12h.
async function manter(env, now) {
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE ponto_registros SET saida = (SELECT pa.inicio FROM ponto_pausas pa WHERE pa.registro_id = ponto_registros.id AND pa.fim IS NULL), nota = 'Encerrado automaticamente (pausa acima de 30 min)' WHERE saida IS NULL AND id IN (SELECT registro_id FROM ponto_pausas WHERE fim IS NULL AND inicio < ?)"
    ).bind(now - LIMITE_PAUSA),
    env.DB.prepare("UPDATE ponto_pausas SET fim = inicio WHERE fim IS NULL AND inicio < ?").bind(now - LIMITE_PAUSA),
    env.DB.prepare(
      "UPDATE ponto_pausas SET fim = MAX(inicio, (SELECT entrada FROM ponto_registros r WHERE r.id = ponto_pausas.registro_id) + ?) WHERE fim IS NULL AND registro_id IN (SELECT id FROM ponto_registros WHERE saida IS NULL AND entrada < ?)"
    ).bind(LIMITE, now - LIMITE),
    env.DB.prepare(
      "UPDATE ponto_registros SET saida = entrada + ?, nota = 'Encerrado automaticamente (limite de 12h)' WHERE saida IS NULL AND entrada < ?"
    ).bind(LIMITE, now - LIMITE),
  ]);
}

export async function rotasPonto(request, env, p, metodo, h) {
  if (!p.startsWith("/api/ponto") && !p.startsWith("/api/admin/ponto")) return await rotasEquipes(request, env, p, metodo, h);
  const { json, quemSou, exigirAdmin, lerCorpo, agora, auditar } = h;
  const ip = request.headers.get("CF-Connecting-IP");
  const now = agora();

  // ---------- Membro ----------
  if (p.startsWith("/api/ponto")) {
    const eu = await quemSou(request, env);
    if (!eu || eu.trocar_senha) return json({ erro: "Não autenticado" }, 401);
    await manter(env, now);

    if (metodo === "GET" && p === "/api/ponto") {
      const desde = now - 60 * 86400;
      const rs = await env.DB.prepare(
        "SELECT id, entrada, saida, nota FROM ponto_registros WHERE membro_id = ? AND (entrada >= ? OR saida IS NULL) ORDER BY entrada"
      ).bind(eu.id, desde).all();
      const ps = await env.DB.prepare(
        "SELECT registro_id, inicio, fim FROM ponto_pausas WHERE registro_id IN (SELECT id FROM ponto_registros WHERE membro_id = ? AND (entrada >= ? OR saida IS NULL))"
      ).bind(eu.id, desde).all();
      const sessoes = rs.results, mp = mapaPausas(ps.results);
      const ini = inicioDia(now), sem = inicioSemana(now);
      let hoje = 0, semana = 0, aberto = null, ultimaSaida = 0;
      const hojeReg = [];
      for (const s of sessoes) {
        hoje += tempoNaJanela(s, mp[s.id], ini, now, now);
        semana += tempoNaJanela(s, mp[s.id], sem, now, now);
        if (s.saida === null) {
          const pausas = mp[s.id] || [];
          const emPausa = pausas.find((x) => x.fim === null);
          aberto = {
            entrada: s.entrada,
            pausa_total: pausas.filter((x) => x.fim !== null).reduce((a, x) => a + (x.fim - x.inicio), 0),
            pausa_inicio: emPausa ? emPausa.inicio : null,
            pausas: pausas.length,
          };
        } else ultimaSaida = Math.max(ultimaSaida, s.saida);
        if (s.entrada >= ini) hojeReg.push(montarSessao(s, mp[s.id], now));
      }
      return json({
        ok: true, agora: now,
        estado: aberto ? (aberto.pausa_inicio !== null ? "pausado" : "servico") : "fora",
        aberto, hoje, semana,
        sequencia: calcularSequencia(sessoes, mp, now),
        dias_meta: calcularDiasMeta(sessoes, mp, now),
        meta: META_DIA,
        espera: aberto ? 0 : Math.max(0, ESPERA_ENTRADA - (now - ultimaSaida)),
        hoje_registros: hojeReg.reverse(),
      });
    }

    if (metodo === "GET" && p === "/api/ponto/historico") {
      const url = new URL(request.url);
      const de = lerDia(url.searchParams.get("de"));
      const ate = lerDia(url.searchParams.get("ate"));
      if (de === null || ate === null || ate < de) return json({ erro: "Período inválido" }, 400);
      const fimJ = ate + 86400;
      if ((fimJ - de) / 86400 > MAX_DIAS) return json({ erro: "Período máximo: " + MAX_DIAS + " dias" }, 400);
      const rs = await env.DB.prepare(
        "SELECT id, entrada, saida, nota FROM ponto_registros WHERE membro_id = ? AND entrada >= ? AND entrada < ? ORDER BY entrada DESC LIMIT 500"
      ).bind(eu.id, de, fimJ).all();
      const ps = await env.DB.prepare(
        "SELECT registro_id, inicio, fim FROM ponto_pausas WHERE registro_id IN (SELECT id FROM ponto_registros WHERE membro_id = ? AND entrada >= ? AND entrada < ?)"
      ).bind(eu.id, de, fimJ).all();
      const mp = mapaPausas(ps.results);
      const lista = rs.results.map((s) => montarSessao(s, mp[s.id], now));
      const dias = new Set();
      let trabalhado = 0, pausado = 0;
      rs.results.forEach((s, i) => {
        dias.add(diaLocal(s.entrada));
        trabalhado += lista[i].trabalhado;
        pausado += lista[i].pausa_total;
      });
      return json({
        ok: true, agora: now,
        de: url.searchParams.get("de"), ate: url.searchParams.get("ate"),
        resumo: { trabalhado, pausado, inicios: lista.length, dias: dias.size },
        sessoes: lista,
      });
    }

    if (metodo === "POST" && p === "/api/ponto/entrar") {
      const m = await env.DB.prepare("SELECT status FROM membros WHERE id = ?").bind(eu.id).first();
      if (m && m.status === "Suspenso") return json({ erro: "Conta suspensa: você não pode bater ponto." }, 403);
      const ult = await env.DB.prepare(
        "SELECT saida FROM ponto_registros WHERE membro_id = ? ORDER BY id DESC LIMIT 1"
      ).bind(eu.id).first();
      if (ult && ult.saida !== null && now - ult.saida < ESPERA_ENTRADA) {
        const espera = ESPERA_ENTRADA - (now - ult.saida);
        return json({ erro: "Aguarde " + espera + "s para iniciar um novo ponto.", espera }, 429);
      }
      try {
        await env.DB.prepare("INSERT INTO ponto_registros (membro_id, entrada) VALUES (?, ?)").bind(eu.id, now).run();
      } catch (e) {
        if (String((e && e.message) || "").includes("UNIQUE")) return json({ erro: "Você já está em serviço." }, 409);
        throw e;
      }
      return json({ ok: true, entrada: now });
    }

    if (metodo === "POST" && p === "/api/ponto/pausar") {
      const aberto = await env.DB.prepare(
        "SELECT id, entrada FROM ponto_registros WHERE membro_id = ? AND saida IS NULL"
      ).bind(eu.id).first();
      if (!aberto) return json({ erro: "Você não está em serviço." }, 409);
      const info = await env.DB.prepare(
        "SELECT COUNT(*) AS n, MAX(COALESCE(fim, inicio)) AS ultimo FROM ponto_pausas WHERE registro_id = ?"
      ).bind(aberto.id).first();
      if (info.n >= MAX_PAUSAS) return json({ erro: "Limite de pausas por turno atingido." }, 429);
      if (now - Math.max(aberto.entrada, info.ultimo || 0) < ESPERA_PAUSA)
        return json({ erro: "Aguarde alguns segundos para pausar." }, 429);
      try {
        await env.DB.prepare("INSERT INTO ponto_pausas (registro_id, inicio) VALUES (?, ?)").bind(aberto.id, now).run();
      } catch (e) {
        if (String((e && e.message) || "").includes("UNIQUE")) return json({ erro: "Você já está em pausa." }, 409);
        throw e;
      }
      return json({ ok: true });
    }

    if (metodo === "POST" && p === "/api/ponto/retomar") {
      const aberto = await env.DB.prepare(
        "SELECT id FROM ponto_registros WHERE membro_id = ? AND saida IS NULL"
      ).bind(eu.id).first();
      if (!aberto) return json({ erro: "Você não está em serviço." }, 409);
      const r = await env.DB.prepare("UPDATE ponto_pausas SET fim = ? WHERE registro_id = ? AND fim IS NULL")
        .bind(now, aberto.id).run();
      if (!r.meta.changes) return json({ erro: "Você não está em pausa." }, 409);
      return json({ ok: true });
    }

    if (metodo === "POST" && p === "/api/ponto/sair") {
      const aberto = await env.DB.prepare(
        "SELECT id, entrada FROM ponto_registros WHERE membro_id = ? AND saida IS NULL"
      ).bind(eu.id).first();
      if (!aberto) return json({ erro: "Você não está em serviço." }, 409);
      if (now - aberto.entrada < MIN_SESSAO) return json({ erro: "Aguarde alguns segundos antes de encerrar o ponto." }, 429);
      const res = await env.DB.batch([
        env.DB.prepare("UPDATE ponto_pausas SET fim = ? WHERE registro_id = ? AND fim IS NULL").bind(now, aberto.id),
        env.DB.prepare("UPDATE ponto_registros SET saida = ? WHERE id = ? AND saida IS NULL").bind(now, aberto.id),
      ]);
      if (!res[1].meta.changes) return json({ erro: "Você não está em serviço." }, 409);
      const pz = await env.DB.prepare(
        "SELECT COUNT(*) AS n, COALESCE(SUM(fim - inicio), 0) AS t FROM ponto_pausas WHERE registro_id = ?"
      ).bind(aberto.id).first();
      return json({
        ok: true, espera: ESPERA_ENTRADA,
        duracao: Math.max(0, now - aberto.entrada - pz.t), pausa: pz.t, pausas: pz.n,
      });
    }
    return null;
  }

  // ---------- Comando ----------
  const adm = await exigirAdmin(request, env);
  if (!adm) return json({ erro: "Sem permissão" }, 403);
  await manter(env, now);

  if (metodo === "GET" && p === "/api/admin/ponto") {
    const online = await env.DB.prepare(
      "SELECT p.id, p.entrada, m.nome, m.matricula, m.cargo, EXISTS(SELECT 1 FROM ponto_pausas pa WHERE pa.registro_id = p.id AND pa.fim IS NULL) AS pausado FROM ponto_registros p JOIN membros m ON m.id = p.membro_id WHERE p.saida IS NULL ORDER BY p.entrada"
    ).all();
    return json({ ok: true, agora: now, online: online.results });
  }

  if (metodo === "GET" && p === "/api/admin/ponto/ranking") {
    const sem = inicioSemana(now);
    const a = await env.DB.prepare(
      "SELECT m.id AS membro_id, m.nome, m.matricula, SUM(MAX(0, MIN(COALESCE(p.saida, ?), ?) - MAX(p.entrada, ?))) AS seg FROM ponto_registros p JOIN membros m ON m.id = p.membro_id WHERE COALESCE(p.saida, ?) > ? GROUP BY m.id"
    ).bind(now, now, sem, now, sem).all();
    const b = await env.DB.prepare(
      "SELECT p.membro_id, SUM(MAX(0, MIN(COALESCE(pa.fim, ?), COALESCE(p.saida, ?), ?) - MAX(pa.inicio, p.entrada, ?))) AS seg FROM ponto_pausas pa JOIN ponto_registros p ON p.id = pa.registro_id WHERE COALESCE(pa.fim, ?) > ? GROUP BY p.membro_id"
    ).bind(now, now, now, sem, now, sem).all();
    const pausa = {};
    b.results.forEach((x) => { pausa[x.membro_id] = x.seg || 0; });
    const ranking = a.results
      .map((x) => ({ nome: x.nome, matricula: x.matricula, seg: Math.max(0, (x.seg || 0) - (pausa[x.membro_id] || 0)) }))
      .sort((x, y) => y.seg - x.seg)
      .slice(0, 10);
    return json({ ok: true, ranking }, 200, { "Cache-Control": "private, max-age=120" });
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
    await env.DB.batch([
      env.DB.prepare("UPDATE ponto_pausas SET fim = ? WHERE registro_id = ? AND fim IS NULL").bind(now, id),
      env.DB.prepare("UPDATE ponto_registros SET saida = ?, nota = 'Encerrado pelo comando' WHERE id = ? AND saida IS NULL").bind(now, id),
    ]);
    await auditar(env, adm.id, "ponto_encerrado", "Matrícula " + s.matricula, ip);
    return json({ ok: true });
  }

  return null;
        }
