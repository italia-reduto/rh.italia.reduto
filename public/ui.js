function criarModal() {
  if (document.getElementById('modal-custom')) return;
  const div = document.createElement('div');
  div.id = 'modal-custom';
  div.className = 'modal-overlay';
  div.innerHTML = `
    <div class="modal-box">
      <h3 id="modal-titulo">Aviso</h3>
      <p id="modal-msg">Mensagem</p>
      <div class="modal-botoes">
        <button id="modal-btn-cancelar" class="modal-btn modal-btn-cancelar">Cancelar</button>
        <button id="modal-btn-ok" class="modal-btn modal-btn-ok">OK</button>
      </div>
    </div>
  `;
  document.body.appendChild(div);
}

window.customAlert = function(msg, titulo = 'Aviso') {
  criarModal();
  return new Promise((resolve) => {
    const overlay = document.getElementById('modal-custom');
    const btnOk = document.getElementById('modal-btn-ok');
    const btnCancelar = document.getElementById('modal-btn-cancelar');
    
    document.getElementById('modal-titulo').textContent = titulo;
    document.getElementById('modal-msg').textContent = msg;
    btnCancelar.style.display = 'none';
    btnOk.className = 'modal-btn modal-btn-ok';
    
    btnOk.onclick = () => { overlay.classList.remove('ativo'); resolve(true); };
    overlay.classList.add('ativo');
  });
};

window.customConfirm = function(msg, titulo = 'Confirmação', perigo = false) {
  criarModal();
  return new Promise((resolve) => {
    const overlay = document.getElementById('modal-custom');
    const btnOk = document.getElementById('modal-btn-ok');
    const btnCancelar = document.getElementById('modal-btn-cancelar');
    
    document.getElementById('modal-titulo').textContent = titulo;
    document.getElementById('modal-msg').textContent = msg;
    btnCancelar.style.display = 'block';
    btnOk.className = 'modal-btn modal-btn-ok' + (perigo ? ' btn-perigo' : '');
    
    btnOk.onclick = () => { overlay.classList.remove('ativo'); resolve(true); };
    btnCancelar.onclick = () => { overlay.classList.remove('ativo'); resolve(false); };
    overlay.classList.add('ativo');
  });
};
