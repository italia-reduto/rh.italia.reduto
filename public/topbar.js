(async function () {
  const script = document.currentScript;
  const isHome = script && script.getAttribute("data-home") === "true";

  if (!document.getElementById("topbar-css")) {
    const link = document.createElement("link");
    link.id = "topbar-css";
    link.rel = "stylesheet";
    link.href = "/topbar.css";
    document.head.appendChild(link);
  }

  try {
    const r = await fetch("/api/me");
    if (!r.ok) return;
    const d = await r.json();

    const barra = document.createElement("div");
    barra.className = "global-topbar";

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
    document.body.insertAdjacentElement("afterbegin", barra);

    const cs = getComputedStyle(document.body);
    if (cs.display === "flex" && cs.flexDirection === "row") {
      document.body.style.flexWrap = "wrap";
      document.body.style.alignContent = "flex-start";
    }
  } catch (e) {
    console.error("Erro ao carregar topbar", e);
  }
})();
