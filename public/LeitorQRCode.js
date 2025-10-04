// Importa o inicializador do WebAssembly e as funções expostas
import initWasm, * as wasm from './xdados.js';
// Importa a lib ZXing compilada para JS
import './zxing.min.js';

/**
 * LeitorQRCode - biblioteca reutilizável para leitura de QR Code com WASM e ZXing
 * Faz:
 *  - Abertura de câmera (com fallback de modos e dispositivos)
 *  - Decodificação de QRCode em tempo real ou por imagem
 *  - Processamento local via WebAssembly (xdados.js)
 *  - Preenchimento automático de formulários via atributos data-json
 */
export class LeitorQRCode {
  constructor({
    botaoIniciar,
    botaoResetar,
    video,
    status = null,
    container = null,
    timeoutCamera = 40000
  } = {}) {
    // parâmetros obrigatórios
    if (!video) throw new Error('video é obrigatório');
    if (!botaoIniciar) throw new Error('O botão iniciar é obrigatório');
    if (!botaoResetar) throw new Error('O botão resetar é obrigatório');

    // elementos da UI
    this.botaoIniciar = botaoIniciar;
    this.botaoResetar = botaoResetar;
    this.video = video;
    this.status = status;
    this.container = container || document;

    // timeout padrão de 10s para abrir câmera
    this.timeoutCamera = timeoutCamera;

    // leitor do ZXing
    this.leitorCodigo = new ZXing.BrowserMultiFormatReader();

    // flags de controle
    this._iniciado = false;
    this._cameraAtiva = false;
    this._timeoutId = null;
    this._eventListeners = {};
  }

  /** Registra eventos customizados (status, error, reset, errorLeitura) */
  on(eventName, callback) {
    if (!this._eventListeners[eventName]) this._eventListeners[eventName] = [];
    this._eventListeners[eventName].push(callback);
  }

  /** Dispara eventos internos */
  _emit(eventName, data) {
    if (!this._eventListeners[eventName]) return;
    for (const cb of this._eventListeners[eventName]) {
      try { cb(data); } catch (e) { console.error(`Erro no listener ${eventName}:`, e); }
    }
  }

  /** Atualiza status visual e emite evento */
  atualizarStatus(mensagem) {
    if (this.status) this.status.textContent = mensagem;
    this._emit('status', mensagem);
  }

  /** Inicializa WASM e configura botões */
  async inicializar() {
    try {
      await initWasm();
      this._iniciado = true;
    } catch (erro) {
      this.atualizarStatus('Erro ao inicializar WASM: ' + erro);
      this._emit('error', erro);
      throw erro;
    }

    // garante compatibilidade iOS (sem fullscreen forçado)
    this.video.setAttribute("playsinline", true);
    this.video.setAttribute("autoplay", true);
    this.video.setAttribute("muted", true);

    // liga botões de controle
    this.botaoIniciar.addEventListener('click', () => this.iniciarLeitura());
    this.botaoResetar.addEventListener('click', () => this.resetarLeitura());
  }

  /** Tenta abrir câmera com constraints passados (environment etc.) */
  async tentarIniciarComModoCamera(constraints) {
    return this.leitorCodigo.decodeFromConstraints(
      { video: { ...constraints }, audio: false }, // FIX: constraints corretos
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
        // erro de leitura (não achou QR não conta como erro fatal)
        if (erro && !(erro instanceof ZXing.NotFoundException)) {
          this._emit('errorLeitura', erro);
        }
      }
    ).then(async () => {
      // forçar autoplay do vídeo após obter stream
      if (this.video.srcObject) {
        try { await this.video.play(); } catch (e) {
          console.warn("Falha ao dar play no vídeo", e);
        }
      }
    });
  }

  /** Rotina principal de leitura do QR via câmera */
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
      // 1ª tentativa: câmera traseira padrão
      await this.tentarIniciarComModoCamera({ facingMode: 'environment' });
    } catch {
      try {
        // 2ª tentativa: com exact
        await this.tentarIniciarComModoCamera({ facingMode: { exact: 'environment' } });
      } catch {
        try {
          // 3ª tentativa: escolhe manualmente dentre dispositivos
          const dispositivos = await this.leitorCodigo.listVideoInputDevices();
          if (dispositivos.length === 0) throw new Error('Nenhuma câmera disponível');

          // tenta achar a traseira pelo nome ou facingMode
          let cameraTraseira = dispositivos.find(d => /back|rear|traseira/i.test(d.label));
          if (!cameraTraseira) cameraTraseira = dispositivos.find(d => d.facingMode === 'environment');
          if (!cameraTraseira) cameraTraseira = dispositivos[0]; // fallback

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

  /** Reseta leitura e libera recursos */
  resetarLeitura() {
    this.atualizarStatus('Resetando leitura...');
    try { this.leitorCodigo.reset(); } catch {}
    this.liberarCamera();
    this._emit('reset');
  }

  /** Libera câmera e stream de vídeo */
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

  /** Decodifica QR a partir de uma imagem (File ou <img>) */
  async decodificarImagem(imagem) {
    this.atualizarStatus('Decodificando QR Code da imagem...');
    try {
      let imgElem;
      if (imagem instanceof File) {
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

  /** Valida string do QRCode (UTF-8, tamanho, caracteres permitidos) */
  validarEntrada(texto, maxLength = 2048) {
    if (typeof texto !== 'string') throw new Error('Entrada não é uma string.');
    if (texto.length > maxLength) throw new Error(`Entrada muito longa. Máximo permitido: ${maxLength} caracteres.`);

    try {
      const encoder = new TextEncoder();
      const decoder = new TextDecoder('utf-8', { fatal: true });
      decoder.decode(encoder.encode(texto));
    } catch { throw new Error('Texto contém bytes inválidos UTF-8.'); }

    if (/[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(texto)) throw new Error('Entrada contém caracteres de controle inválidos.');

    const whitelistRegex = /^[\w\sÀ-ÖØ-öø-ÿ.,;:?!@#%&*()\-_=+\[\]{}|\\/<> "'´`^~ªº§¼½¾€$£¥€¢µ¿¡§]+$/u;
    if (!whitelistRegex.test(texto)) throw new Error('Entrada contém caracteres inválidos.');

    return this.sanitizeTexto(texto);
  }

  /** Sanitiza texto contra XSS */
  sanitizeTexto(t) {
    return t.replace(/&/g, '&amp;').replace(/</g, '&lt;')
            .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;').replace(/\//g, '&#x2F;');
  }

  /** Processa texto bruto do QR chamando o parser em WASM */
  async processar(texto) {
    try {
      this.validarEntrada(texto);
    } catch (erroValidacao) {
      this.atualizarStatus('Entrada inválida: ' + erroValidacao.message);
      throw erroValidacao;
    }

    this.atualizarStatus('Processando com WebAssembly...');
    try {
      // chama função exposta pelo módulo WASM
      const dadosExtraidos = wasm.extrair_dados_documento(texto);
      const json = Object.fromEntries(dadosExtraidos.entries());
      this.preencherCampos(json);
      this.atualizarStatus('Dados processados localmente.');
    } catch (erro) {
      this.atualizarStatus('Erro ao processar QR Code: ' + erro.message);
      throw erro;
    }
  }

  /** Preenche campos de formulário com atributo data-json */
  preencherCampos(dados) {
    if (!dados) return;
    this.container.querySelectorAll('input[data-json], select[data-json], textarea[data-json]').forEach(el => {
      const chave = el.dataset.json;
      if (chave in dados) {
        if ('value' in el) el.value = dados[chave]?.toString().trim() || '';
        else el.textContent = dados[chave]?.toString().trim() || '';
      }
    });
  }

  /** Utilitário: mostra/esconde vídeo */
  _showVideo(mostrar) { this.video.style.display = mostrar ? 'block' : 'none'; }

  /** Utilitário: troca visibilidade dos botões */
  _toggleBotoes({ iniciar, resetar }) {
    if (this.botaoIniciar) this.botaoIniciar.style.display = iniciar ? 'inline-block' : 'none';
    if (this.botaoResetar) this.botaoResetar.style.display = resetar ? 'inline-block' : 'none';
  }
}

