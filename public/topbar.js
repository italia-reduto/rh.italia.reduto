(async function() {
  const script = document.currentScript;
  const isHome = script && script.getAttribute('data-home') === 'true';

  try {
    const r = await fetch("/api/me");
    if (!r.ok) return; 

    const d = await r.json();
    const nomeExibicao = isHome ? "Bem-vindo, " + d.nome : d.nome;
    
    let avatarHtml = d.nome ? d.nome.charAt(0).toUpperCase() : "?";
    if (d.avatar_base64) avatarHtml = `<img src="${d.avatar_base64}" alt="Perfil">`;

    const html = `
      <div id="app-topbar-fixed" class="global-topbar">
        <div class="avatar" onclick="window.location.href='/perfil.html'" style="cursor:pointer">${avatarHtml}</div>
        <div class="quem">
          <b>${nomeExibicao}</b>
          <span>Mat. ${d.matricula} · ${d.cargo}</span>
        </div>
        <button class="sino" onclick="window.location.href='/comunicados.html'">
          <svg viewBox="0 0 24 24"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/></svg>
        </button>
      </div>
    `;
    document.body.insertAdjacentHTML('afterbegin', html);
  } catch (e) { console.error("Erro topbar", e); }
})();
