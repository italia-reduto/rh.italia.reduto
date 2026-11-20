(async function () {
  const script = document.currentScript;
  const isHome = script && script.getAttribute("data-home") === "true";
  const ALTURA_INICIAL = 74;

  // Reserva o espaço da barra já no início, para o conteúdo não "pular" quando ela carregar.
  if (document.body) document.body.style.setProperty("padding-top", ALTURA_INICIAL + "px", "important");

  function tirarReserva() {
    if (document.body) document.body.style.removeProperty("padding-top");
  }

  try {
    const r = await fetch("/api/me");
    if (!r.ok) { tirarReserva(); return; }
    const d = await r.json();

    // A barra fica dentro de um Shadow DOM e presa ao topo do documento:
    // nem o CSS nem o layout da página conseguem mexer nela.
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
      .barra { display:flex; align-items:center; gap:12px; max-width:440px; margin:0 auto;
               padding:calc(16px + env(safe-area-inset-top, 0px)) 16px 12px; box-sizing:border-box;
               font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; color:#F2F2EE; }
      .avatar { width:46px; height:46px; border-radius:14px; background:#12261D; border:1.5px solid #35E08A;
                color:#35E08A; display:flex; align-items:center; justify-content:center; font-size:18px;
                font-weight:600; flex:none; overflow:hidden; cursor:pointer; box-sizing:border-box; }
      .avatar img { width:100%; height:100%; object-fit:cover; display:block; }
      .quem { flex:1; min-width:0; }
      .quem b { display:block; font-size:17px; font-weight:600; line-height:1.3; overflow:hidden;
                text-overflow:ellipsis; white-space:nowrap; }
      .quem span { display:block; margin-top:1px; font-size:12px; color:#8C9690; overflow:hidden;
                   text-overflow:ellipsis; white-space:nowrap; }
      .sino { width:44px; height:44px; border-radius:14px; background:#171C19; border:0; color:#F2F2EE;
              display:flex; align-items:center; justify-content:center; flex:none; cursor:pointer; padding:0; }
      .sino svg { width:20px; height:20px; fill:none; stroke:currentColor; stroke-width:1.8;
                  stroke-linecap:round; stroke-linejoin:round; }
    `;

    const barra = document.createElement("div");
    barra.className = "barra";

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
    sino.innerHTML =
      '<svg viewBox="0 0 24 24"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/></svg>';

    barra.appendChild(avatar);
    barra.appendChild(quem);
    barra.appendChild(sino);
    root.appendChild(estilo);
    root.appendChild(barra);
    document.body.insertAdjacentElement("afterbegin", host);

    // Zera qualquer espaço/margem de cima que a página tenha e reserva só a altura da barra.
    const ajustar = () => {
      const h = Math.ceil(host.getBoundingClientRect().height) || ALTURA_INICIAL;
      document.documentElement.style.setProperty("margin-top", "0", "important");
      document.documentElement.style.setProperty("padding-top", "0", "important");
      document.body.style.setProperty("margin-top", "0", "important");
      document.body.style.setProperty("padding-top", h + "px", "important");
    };
    ajustar();
    if (window.ResizeObserver) new ResizeObserver(ajustar).observe(host);
    window.addEventListener("load", ajustar);
  } catch (e) {
    tirarReserva();
    console.error("Erro ao carregar topbar", e);
  }
})();
