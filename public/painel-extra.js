(async () => {
  function numero(inicio, valor) {
    if (valor === null || valor === undefined) return;
    document.querySelectorAll(".cx").forEach((cx) => {
      const r = cx.querySelector(".rot");
      const n = cx.querySelector(".num");
      if (r && n && r.textContent.trim().toLowerCase().startsWith(inicio)) {
        n.textContent = String(valor);
        n.style.color = "var(--texto)";
      }
    });
  }
  try {
    const [rc, rr] = await Promise.all([fetch("/api/comunicados"), fetch("/api/resumo")]);
    const box = document.querySelector(".destaque");
    if (box) {
      box.style.cursor = "pointer";
      box.onclick = () => { location.href = "/comunicados.html"; };
    }
    if (rc.ok && box) {
      const d = await rc.json();
      const lista = d.comunicados || [];
      const ban = lista.find((x) => x.destaque) || lista[0];
      if (ban) {
        const h2 = box.querySelector("h2");
        const p = box.querySelector("p");
        if (h2) h2.textContent = ban.titulo;
        if (p) p.textContent = ban.corpo.length > 90 ? ban.corpo.slice(0, 90) + "…" : ban.corpo;
        const l = box.querySelector(".l");
        if (l && !ban.lido && !l.querySelector(".chipnovo")) {
          const chip = document.createElement("span");
          chip.className = "chipnovo";
          chip.textContent = "Novo";
          chip.style.cssText = "margin-left:auto;background:#06281A;color:#35E08A;padding:2px 9px;border-radius:20px;font-size:11px";
          l.appendChild(chip);
        }
      }
    }
    if (rr.ok) {
      const r = await rr.json();
      numero("tickets", r.tickets_abertos);
      numero("ausência", r.ausencias_pendentes);
    }
  } catch (e) {}
})();
