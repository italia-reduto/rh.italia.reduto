(async function () {
  const script = document.currentScript;
  const isHome = script && script.getAttribute("data-home") === "true";
  const ALTURA_TOPO = 88;

  // Reserva o espaço do topo já no início, para o conteúdo não "pular" quando a barra carregar.
  if (document.body) document.body.style.setProperty("padding-top", ALTURA_TOPO + "px", "important");
  function tirarReserva() {
    if (document.body) document.body.style.removeProperty("padding-top");
  }

  const svg = (p) => '<svg viewBox="0 0 24 24">' + p + "</svg>";
  const ITENS = [
    { rot: "Painel", href: "/painel.html", paginas: ["/painel.html"],
      ico: '<path d="M3 11l9-8 9 8"/><path d="M5 10v10h14V10"/>' },
    { rot: "Tickets", href: "/tickets.html", paginas: ["/tickets.html", "/admin-tickets.html"],
      ico: '<path d="M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2Z"/><path d="M13 5v2M13 11v2M13 17v2"/>' },
    { rot: "Ponto", breve: "O ponto chega em breve", paginas: ["/ponto.html"],
      ico: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>' },
    { rot: "Ficha", href: "/ficha.html", paginas: ["/ficha.html"],
      ico: '<rect width="18" height="14" x="3" y="5" rx="2"/><circle cx="9" cy="11" r="2"/><path d="M14 10h4M14 14h4M6 17c.5-1.5 1.5-2 3-2s2.5.5 3 2"/>' },
    { rot: "Mais", breve: "O menu Mais chega em breve", paginas: [],
      ico: '<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>' }
  ];

  function montarTopo(d) {
    const host = document.createElement("div");
    host.id = "topbar-host";
    host.style.cssText =
      "position:absolute;top:0;left:0;right:0;width:auto;margin:0;padding:0;border:0;" +
      "background:none;transform:none;float:none;display:block;z-index:90";
    const root = host.attachShadow({ mode: "open" });

    const estilo = document.createElement("style");
    estilo.textContent = `
      :host { all: initial; }
      * { -webkit-tap-highlight-color: transparent; }
      .barra { max-width:440px; margin:0 auto; box-sizing:border-box;
               padding:calc(12px + env(safe-area-inset-top, 0px)) 16px 10px;
               font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; color:#F2F2EE; }
      .cartao { display:flex; align-items:center; gap:12px; background:#171C19;
                border:1px solid rgba(255,255,255,.06); border-radius:22px; padding:10px 12px; }
      .avatar { width:46px; height:46px; border-radius:14px; background:#12261D; border:1.5px solid #35E08A;
                color:#35E08A; display:flex; align-items:center; justify-content:center; font-size:18px;
                font-weight:600; flex:none; overflow:hidden; cursor:pointer; box-sizing:border-box; }
      .avatar img { width:100%; height:100%; object-fit:cover; display:block; }
      .quem { flex:1; min-width:0; }
      .quem b { display:block; font-size:17px; font-weight:600; line-height:1.3; overflow:hidden;
                text-overflow:ellipsis; white-space:nowrap; }
      .quem span { display:block; margin-top:1px; font-size:12px; color:#8C9690; overflow:hidden;
                   text-overflow:ellipsis; white-space:nowrap; }
      .sino { width:44px; height:44px; border-radius:14px; background:#1F2A24; border:0; color:#F2F2EE;
              display:flex; align-items:center; justify-content:center; flex:none; cursor:pointer; padding:0; }
      .sino svg { width:20px; height:20px; fill:none; stroke:currentColor; stroke-width:1.8;
                  stroke-linecap:round; stroke-linejoin:round; }
    `;

    const barra = document.createElement("div");
    barra.className = "barra";
    const cartao = document.createElement("div");
    cartao.className = "cartao";

    const avatar = document.createElement("div");
    avatar.className = "avatar";
    avatar.onclick = () => { window.location.href = "/perfil.html"; };
    const foto =
      typeof d.avatar_base64 === "string" &&
      /^data:image\/(png|jpe?g|webp);base64,[A-Za-z0-9+\/=]+$/.test(d.avatar_base64)
        ? d.avatar_base64
        : null;
    if (foto) {
      const img = document.createElement("img");
      img.src = foto;
      img.alt = "Perfil";
      avatar.appendChild(img);
    } else {
      avatar.textContent = d.nome ? String(d.nome).charAt(0).toUpperCase() : "?";
    }

    const quem = document.createElement("div");
    quem.className = "quem";
    const nome = document.createElement("b");
    nome.textContent = isHome ? "Bem-vindo, " + d.nome : d.nome;
    const info = document.createElement("span");
    info.textContent = "Mat. " + d.matricula + " · " + d.cargo;
    quem.appendChild(nome);
    quem.appendChild(info);

    const sino = document.createElement("button");
    sino.className = "sino";
    sino.setAttribute("aria-label", "Avisos");
    sino.onclick = () => { window.location.href = "/comunicados.html"; };
    sino.innerHTML = svg('<path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/>');

    cartao.appendChild(avatar);
    cartao.appendChild(quem);
    cartao.appendChild(sino);
    barra.appendChild(cartao);
    root.appendChild(estilo);
    root.appendChild(barra);
    document.body.insertAdjacentElement("afterbegin", host);
    return host;
  }

  function montarRodape() {
    const host = document.createElement("div");
    host.id = "bottomnav-host";
    host.style.cssText =
      "position:fixed;left:0;right:0;bottom:0;margin:0;padding:0;border:0;background:none;" +
      "transform:none;display:block;z-index:50";
    const root = host.attachShadow({ mode: "open" });

    const estilo = document.createElement("style");
    estilo.textContent = `
      :host { all: initial; }
      * { -webkit-tap-highlight-color: transparent; }
      .fundo { position:relative; padding:18px 16px calc(12px + env(safe-area-inset-bottom, 0px));
               background:linear-gradient(to top, #0E1110 72%, rgba(14,17,16,0));
               font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; }
      .nav { max-width:440px; margin:0 auto; display:flex; background:#171C19;
             border:1px solid rgba(255,255,255,.06); border-radius:26px; padding:8px; box-sizing:border-box; }
      .it { flex:1; display:flex; align-items:center; justify-content:center; gap:6px; padding:10px 0;
            color:#8C9690; border:0; background:none; border-radius:20px; cursor:pointer;
            text-decoration:none; font:inherit; font-size:12px; font-weight:600; }
      .it.ativa { flex:1.5; background:#35E08A; color:#06281A; }
      .it svg { width:20px; height:20px; fill:none; stroke:currentColor; stroke-width:1.8;
                stroke-linecap:round; stroke-linejoin:round; flex:none; }
      .aviso { position:absolute; left:50%; bottom:calc(100% - 4px); transform:translateX(-50%);
               background:#F2F2EE; color:#0E1110; padding:10px 16px; border-radius:20px; font-size:13px;
               opacity:0; pointer-events:none; transition:opacity .2s; white-space:nowrap; }
      .aviso.on { opacity:1; }
    `;

    const fundo = document.createElement("div");
    fundo.className = "fundo";
    const nav = document.createElement("div");
    nav.className = "nav";
    const aviso = document.createElement("div");
    aviso.className = "aviso";
    let timer;
    const mostrar = (msg) => {
      aviso.textContent = msg;
      aviso.classList.add("on");
      clearTimeout(timer);
      timer = setTimeout(() => aviso.classList.remove("on"), 1800);
    };

    const ativo = ITENS.find((i) => i.paginas.includes(location.pathname));
    ITENS.forEach((i) => {
      const el = document.createElement(i.href ? "a" : "button");
      el.className = "it" + (i === ativo ? " ativa" : "");
      el.setAttribute("aria-label", i.rot);
      el.innerHTML = svg(i.ico);
      if (i === ativo) {
        const t = document.createElement("span");
        t.textContent = i.rot;
        el.appendChild(t);
      }
      if (i.href) el.href = i.href;
      else el.onclick = () => mostrar(i.breve);
      nav.appendChild(el);
    });

    fundo.appendChild(nav);
    fundo.appendChild(aviso);
    root.appendChild(estilo);
    root.appendChild(fundo);
    document.body.appendChild(host);
    return host;
  }

  function removerBarraAntiga() {
    document.querySelectorAll(".navwrap").forEach((e) => e.remove());
  }

  try {
    const r = await fetch("/api/me");
    if (!r.ok) { tirarReserva(); return; }
    const d = await r.json();

    const topo = montarTopo(d);
    const rodape = montarRodape();
    removerBarraAntiga();
    document.addEventListener("DOMContentLoaded", removerBarraAntiga);

    const ajustar = () => {
      const h = Math.ceil(topo.getBoundingClientRect().height) || ALTURA_TOPO;
      const f = Math.ceil(rodape.getBoundingClientRect().height) || 90;
      document.documentElement.style.setProperty("margin-top", "0", "important");
      document.documentElement.style.setProperty("padding-top", "0", "important");
      document.body.style.setProperty("margin-top", "0", "important");
      document.body.style.setProperty("padding-top", h + "px", "important");
      const atual = parseFloat(getComputedStyle(document.body).paddingBottom) || 0;
      if (atual < f + 16) document.body.style.setProperty("padding-bottom", f + 16 + "px", "important");
    };
    ajustar();
    if (window.ResizeObserver) {
      const ro = new ResizeObserver(ajustar);
      ro.observe(topo);
      ro.observe(rodape);
    }
    window.addEventListener("load", ajustar);
  } catch (e) {
    tirarReserva();
    console.error("Erro ao carregar topbar", e);
  }
})();
