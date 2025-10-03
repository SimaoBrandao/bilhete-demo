// Importa o inicializador do WebAssembly (gera xdados.wasm -> xdados.js wrapper)
import initWasm, * as wasm from './xdados.js';
// Importa a lib ZXing compilada para JS (leitura de QRCode por câmera)
import './zxing.min.js';

export class LeitorQRCode {
  constructor({
    botaoIniciar,
    botaoResetar,
    video,
    status = null,
    container = null,
    timeoutCamera = 10000
  } = {}) {
    // validação dos elementos obrigatórios
    if (!video) throw new Error('video é obrigatório');
    if (!botaoIniciar) throw new Error('O botão iniciar é obrigatório');
    if (!botaoResetar) throw new Error('O botão resetar é obrigatório');

    // guarda referências de UI
    this.botaoIniciar = botaoIniciar;
    this.botaoResetar = botaoResetar;
    this.video = video;
    this.status = status;
    this.container = container || document;
    this.timeoutCamera = timeoutCamera;

    // instancia leitor ZXing
    this.leitorCodigo = new ZXing.BrowserMultiFormatReader();

    // flags de controle
    this._iniciado = false;
    this._cameraAtiva = false;
    this._timeoutId = null;
    this._eventListeners = {};
  }

  // sistema de eventos customizados (status, error, processado etc.)
  on(eventName, callback) {
    if (!this._eventListeners[eventName]) this._eventListeners[eventName] = [];
    this._eventListeners[eventName].push(callback);
  }

  _emit(eventName, data) {
    if (!this._eventListeners[eventName]) return;
    for (const cb of this._eventListeners[eventName]) {
      try { cb(data); } catch (e) { console.error(`Erro no listener ${eventName}:`, e); }
    }
  }

  // exibe status no HTML + emite evento
  atualizarStatus(mensagem) {
    if (this.status) this.status.textContent = mensagem;
    this._emit('status', mensagem);
  }

  // inicializa WASM + configura botões
  async inicializar() {
    try {
      await initWasm(); // carrega módulo WASM (xdados)
      this._iniciado = true;
    } catch (erro) {
      this.atualizarStatus('Erro ao inicializar WASM: ' + erro);
      this._emit('error', erro);
      throw erro;
    }

    // compatibilidade iOS (playsinline evita fullscreen automático)
    this.video.setAttribute("playsinline", true);
    this.video.setAttribute("autoplay", true);
    this.video.setAttribute("muted", true);

    // liga eventos de clique
    this.botaoIniciar.addEventListener('click', () => this.iniciarLeitura());
    this.botaoResetar.addEventListener('click', () => this.resetarLeitura());
  }

  // tenta abrir câmera com constraints (facingMode: environment etc.)
  async tentarIniciarComModoCamera(constraints) {
    return this.leitorCodigo.decodeFromConstraints(
      { video: { ...constraints }, audio: false },
      this.video,
      async (resultado, erro) => {
        if (resultado) {
          try {
            clearTimeout(this._timeoutId);
            this._timeoutId = null;
            this.atualizarStatus('Código detectado: ' + resultado.text);
            await this.processar(resultado.text);
          } catch (err) {
            this._emit('error', err);
          } finally {
            this.liberarCamera();
          }
        }
        // erro de leitura normal não derruba (NotFoundException é esperado)
        if (erro && !(erro instanceof ZXing.NotFoundException)) {
          this._emit('errorLeitura', erro);
        }
      }
    ).then(async () => {
      // força autoplay do vídeo
      if (this.video.srcObject) {
        try { await this.video.play(); } catch (e) {
          console.warn("Falha ao dar play no vídeo", e);
        }
      }
    });
  }

  // rotina principal de leitura de QR via câmera
  async iniciarLeitura() {
    if (!this._iniciado) throw new Error('Lib não inicializada. Chame inicializar() primeiro.');
    if (this._cameraAtiva) return;

    this._cameraAtiva = true;
    this.atualizarStatus('Iniciando leitura da câmera...');
    this._showVideo(true);
    this._toggleBotoes({ iniciar: false, resetar: true });

    // timeout de fallback
    this._timeoutId = setTimeout(() => {
      this.atualizarStatus('Timeout: não foi possível abrir a câmera.');
      this._emit('error', new Error('Timeout de abertura da câmera'));
      this.liberarCamera();
    }, this.timeoutCamera);

    try {
      // tenta abrir com facingMode padrão
      await this.tentarIniciarComModoCamera({ facingMode: 'environment' });
    } catch {
      try {
        // tenta modo mais estrito
        await this.tentarIniciarComModoCamera({ facingMode: { exact: 'environment' } });
      } catch {
        try {
          // fallback: lista dispositivos
          const dispositivos = await this.leitorCodigo.listVideoInputDevices();
          if (dispositivos.length === 0) throw new Error('Nenhuma câmera disponível');

          // tenta escolher traseira
          let cameraTraseira = dispositivos.find(d => /back|rear|traseira/i.test(d.label));
          if (!cameraTraseira) cameraTraseira = dispositivos.find(d => d.facingMode === 'environment');
          if (!cameraTraseira) cameraTraseira = dispositivos[0];

          await this.leitorCodigo.decodeFromVideoDevice(
            cameraTraseira.deviceId,
            this.video,
            async (resultado, erro) => {
              if (resultado) {
                clearTimeout(this._timeoutId);
                this._timeoutId = null;
                this.atualizarStatus('Código detectado: ' + resultado.text);
                await this.processar(resultado.text);
                this.liberarCamera();
              }
              if (erro && !(erro instanceof ZXing.NotFoundException)) {
                this._emit('errorLeitura', erro);
              }
            }
          );
          if (this.video.srcObject) {
            try { await this.video.play(); } catch (e) { console.warn("play falhou", e); }
          }
        } catch (erro) {
          // falhou todas tentativas
          clearTimeout(this._timeoutId);
          this._timeoutId = null;
          this.atualizarStatus('Erro ao abrir câmera: ' + erro.message);
          this._emit('error', erro);
          this.liberarCamera();
        }
      }
    }
  }

  // reseta leitura e recursos
  resetarLeitura() {
    this.atualizarStatus('Resetando leitura...');
    try { this.leitorCodigo.reset(); } catch {}
    this.liberarCamera();
    this._emit('reset');
  }

  // libera câmera e tracks
  liberarCamera() {
    try { this.leitorCodigo.reset(); } catch (e) { this.atualizarStatus('Erro ao resetar leitor: ' + e); }

    if (!this.video.paused) this.video.pause();
    if (this.video.srcObject) {
      this.video.srcObject.getTracks().forEach(t => t.stop());
      this.video.srcObject = null;
    }
    this._showVideo(false);
    this._toggleBotoes({ iniciar: true, resetar: false });
    this.atualizarStatus('Câmera liberada.');
    this._cameraAtiva = false;

    if (this._timeoutId) {
      clearTimeout(this._timeoutId);
      this._timeoutId = null;
    }
  }

  // decodifica QR a partir de imagem (upload ou <img>)
  async decodificarImagem(imagem) {
    this.atualizarStatus('Decodificando QR Code da imagem...');
    try {
      let imgElem;
      if (imagem instanceof File) {
        // converte File -> objeto URL -> <img>
        const url = URL.createObjectURL(imagem);
        imgElem = new Image();
        await new Promise((res, rej) => {
          imgElem.onload = () => { URL.revokeObjectURL(url); res(); };
          imgElem.onerror = rej;
          imgElem.src = url;
        });
      } else if (imagem instanceof HTMLImageElement) {
        imgElem = imagem;
      } else throw new Error('Parâmetro deve ser File ou HTMLImageElement');

      const resultado = await this.leitorCodigo.decodeFromImage(imgElem);
      this.atualizarStatus('Código detectado');
      await this.processar(resultado.text);
    } catch (erro) {
      this.atualizarStatus('Erro ao decodificar imagem: ' + erro.message);
      throw erro;
    }
  }

  // valida string antes de mandar para o WASM
  validarEntrada(texto, maxLength = 2048) {
    if (typeof texto !== 'string') throw new Error('Entrada não é uma string.');
    if (texto.length > maxLength) throw new Error(`Entrada muito longa. Máximo permitido: ${maxLength} caracteres.`);

    // valida UTF-8
    try {
      const encoder = new TextEncoder();
      const decoder = new TextDecoder('utf-8', { fatal: true });
      decoder.decode(encoder.encode(texto));
    } catch { throw new Error('Texto contém bytes inválidos UTF-8.'); }

    // valida caracteres de controle
    if (/[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(texto)) throw new Error('Entrada contém caracteres de controle inválidos.');

    // regex de whitelist
    const whitelistRegex = /^[\w\sÀ-ÖØ-öø-ÿ.,;:?!@#%&*()\-_=+\[\]{}|\\/<> "'´`^~ªº§¼½¾€$£¥€¢µ¿¡§]+$/u;
    if (!whitelistRegex.test(texto)) throw new Error('Entrada contém caracteres inválidos.');

    return this.sanitizeTexto(texto);
  }

  // sanitize contra XSS
  sanitizeTexto(t) {
    return t.replace(/&/g, '&amp;').replace(/</g, '&lt;')
            .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;').replace(/\//g, '&#x2F;');
  }

  // processa QR com parser do WASM
  async processar(texto) {
    try {
      this.validarEntrada(texto);
    } catch (erroValidacao) {
      this.atualizarStatus('Entrada inválida: ' + erroValidacao.message);
      throw erroValidacao;
    }

    this.atualizarStatus('Processando com WebAssembly...');
    try {
      const dadosExtraidos = wasm.extrair_dados_documento(texto);
      const json = Object.fromEntries(dadosExtraidos.entries());

      // FIX: Safari/Chrome mobile requer async repaint
      setTimeout(() => {
        this.preencherCampos(json);
        this._emit('processado', json);
        this.atualizarStatus('Dados processados localmente.');
      }, 0);

    } catch (erro) {
      this.atualizarStatus('Erro ao processar QR Code: ' + erro.message);
      throw erro;
    }
  }

  // preenche automaticamente os campos (data-json)
  preencherCampos(dados) {
    if (!dados) return;
    this.container.querySelectorAll('input[data-json], select[data-json], textarea[data-json]').forEach(el => {
      const chave = el.dataset.json;
      if (chave in dados) {
        if ('value' in el) {
          el.value = dados[chave]?.toString().trim() || '';
          // FIX: garante atualização em mobile (Safari/Chrome)
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        } else {
          el.textContent = dados[chave]?.toString().trim() || '';
        }
      }
    });
  }

  // helpers de UI
  _showVideo(mostrar) { this.video.style.display = mostrar ? 'block' : 'none'; }
  _toggleBotoes({ iniciar, resetar }) {
    if (this.botaoIniciar) this.botaoIniciar.style.display = iniciar ? 'inline-block' : 'none';
    if (this.botaoResetar) this.botaoResetar.style.display = resetar ? 'inline-block' : 'none';
  }
}
