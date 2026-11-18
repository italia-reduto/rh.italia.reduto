(async function() {
  // Verifica se é a tela do painel principal (para colocar o "Bem-vindo")
  // Se o script for chamado com <script src="/topbar.js" data-home="true"></script>, ele mostra o "Bem-vindo".
  // Caso contrário, mostra apenas o nome.
  const script = document.currentScript;
  const isHome = script && script.getAttribute('data-home') === 'true';

  try {
    const r = await fetch("/api/me");
    if (!r.ok) return; // Se não estiver logado, o próprio HTML lida com o redirecionamento

    const d = await r.json();
    const nomeExibicao = isHome ? "Bem-vindo, " + d.nome : d.nome;
    const inicial = d.nome ? d.nome.charAt(0).toUpperCase() : "?";

    const html = `
      <div class="global-topbar">
        <div class="avatar">${inicial}</div>
        <div class="quem">
          <b>${nomeExibicao}</b>
          <span>${d.cargo} · Mat: ${d.matricula}</span>
        </div>
        <button class="sino" onclick="alert('Avisos em breve')">
          <svg viewBox="0 0 24 24"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/></svg>
        </button>
      </div>
    `;

    // Insere a topbar no início do container principal (.caixa ou body)
    const container = document.querySelector('.caixa') || document.body;
    container.insertAdjacentHTML('afterbegin', html);

  } catch (e) {
    console.error("Erro ao carregar topbar", e);
  }
})();
