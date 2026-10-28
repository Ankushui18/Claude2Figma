"use strict";
(() => {
  // ../ui/src/router.ts
  function createRouter(root2, initial) {
    const listeners = [];
    function screens() {
      return Array.from(root2.querySelectorAll("[data-screen]"));
    }
    function apply(id) {
      for (const screen2 of screens()) {
        screen2.classList.toggle("is-active", screen2.dataset.screen === id);
      }
    }
    const available = screens();
    const initialExists = available.some((s) => s.dataset.screen === initial);
    let active = initialExists ? initial : available[0]?.dataset.screen ?? initial;
    apply(active);
    return {
      go(id) {
        if (id === active) return;
        const exists = screens().some((s) => s.dataset.screen === id);
        if (!exists) return;
        active = id;
        apply(id);
        for (const fn of listeners) fn(id);
      },
      current: () => active,
      onChange(fn) {
        listeners.push(fn);
      }
    };
  }

  // ../ui/src/loader.ts
  function createMessageRotator(o) {
    const interval = o.intervalMs ?? 2e3;
    let timer = null;
    let index = 0;
    return {
      start() {
        if (o.messages.length === 0 || timer !== null) return;
        index = 0;
        o.onTick(o.messages[0]);
        timer = setInterval(() => {
          index = (index + 1) % o.messages.length;
          o.onTick(o.messages[index]);
        }, interval);
      },
      stop() {
        if (timer !== null) {
          clearInterval(timer);
          timer = null;
        }
      }
    };
  }

  // ../ui/src/i18n/pt-BR.ts
  var ptBR = {
    common: {
      back: "Voltar",
      cancel: "Cancelar",
      retry: "Tentar de novo",
      close: "Fechar",
      account: "Conta",
      continue: "Continuar",
      home: "In\xEDcio",
      decks: "Decks"
    },
    login: {
      title: "Entrar",
      pitch: "Seus slides do Claude Design viram camadas edit\xE1veis no Figma.",
      subtitle: "Enviamos um c\xF3digo de 6 d\xEDgitos para o seu e-mail.",
      emailLabel: "E-mail",
      emailPlaceholder: "voce@empresa.com",
      sendCode: "Enviar c\xF3digo",
      codeLabel: "C\xF3digo",
      codePlaceholder: "000000",
      verify: "Entrar",
      changeEmail: "Usar outro e-mail",
      resend: "Reenviar c\xF3digo",
      resendSent: "Novo c\xF3digo enviado.",
      invalidEmail: "Digite um e-mail v\xE1lido.",
      invalidCode: "C\xF3digo inv\xE1lido ou expirado.",
      disposableEmail: "Esse servi\xE7o de e-mail tempor\xE1rio n\xE3o \xE9 aceito. Use um endere\xE7o permanente."
    },
    home: {
      title: "Capturar deck",
      deckDetected: "Deck detectado nesta aba",
      noDeck: "Abra um deck do Claude para capturar.",
      noDeckBody: "A extens\xE3o captura o deck que estiver aberto nesta aba. Abra o seu no Claude Design e volte aqui.",
      openClaudeDesign: "Abrir o Claude Design",
      slides: "slides",
      // Singular à parte: o card mostra a contagem REAL da aba, e "1 slides"
      // é a marca de um número que ninguém conferiu.
      slide: "slide",
      capture: "Capturar deck",
      // Diz "importações" de propósito: o contador fica logo abaixo do botão
      // "Capturar deck", e desde que a cota passou a ser debitada no import
      // confirmado (P-09) capturar NÃO consome nada. Sem a palavra, a leitura
      // natural do número é "capturas restantes", que é falsa.
      usage: "{used} de {limit} importa\xE7\xF5es este m\xEAs",
      unlimited: "Importa\xE7\xF5es ilimitadas",
      untitledDeck: "Deck sem t\xEDtulo"
    },
    capturing: {
      title: "Capturando"
    },
    success: {
      title: "Deck enviado",
      body: "Abra o plugin no Figma para importar.",
      captureAnother: "Capturar outro"
    },
    decks: {
      title: "Decks recentes",
      empty: "Nenhum deck ainda",
      // Título da lista vazia para quem entrou pelo plugin e NUNCA entrou
      // pela extensão. É a única ação possível dessa pessoa: sem a
      // extensão não existe deck para importar. Ver `hasExtension` em
      // `shared/api-types.ts`.
      emptyNeedsExtension: "Instale a extens\xE3o do Chrome",
      emptyBody: "Capture um deck pela extens\xE3o no Chrome.",
      // Mesma tela, lida de DENTRO da extensão: mandar "use a extensão no
      // Chrome" para quem já está nela é instrução circular.
      emptyBodyCapture: "Abra um deck do Claude e capture pela aba In\xEDcio.",
      import: "Importar",
      slides: "slides",
      delete: "Excluir",
      confirmDelete: "Excluir do hist\xF3rico?",
      confirmDeleteYes: "Excluir",
      deleted: "Deck exclu\xEDdo."
    },
    importing: {
      title: "Importando",
      // Estado do botão entre o clique em cancelar e a confirmação da thread
      // do plugin. Sem ele, os primeiros segundos pareciam um botão quebrado.
      cancelling: "Cancelando\u2026"
    },
    result: {
      title: "Pronto",
      imported: "{count} slides importados",
      importAnother: "Importar outro",
      missingFonts: "Fontes n\xE3o encontradas: {fonts}",
      failedImages: "{count} imagens n\xE3o carregaram",
      sampleTitle: "Amostra de 3 slides",
      sampleBody: "Voc\xEA usou seus {limit} decks este m\xEAs. Estes 3 slides s\xE3o uma amostra \u2014 o Pro traz o deck inteiro.",
      sampleCta: "Assinar o Pro",
      throttled: "Voc\xEA passou do limite de uso individual deste ciclo. Suas importa\xE7\xF5es continuam funcionando, s\xF3 podem ficar mais lentas.",
      reviewAsk: "Importados {count} slides. Se isso te economizou tempo, uma avalia\xE7\xE3o na Figma Community ajuda muito.",
      reviewCta: "Avaliar na Figma Community"
    },
    account: {
      title: "Conta",
      plan: "Plano",
      planFree: "Gratuito",
      planPro: "Pro",
      usage: "Importa\xE7\xF5es do m\xEAs",
      resets: "Renova em {date}",
      upgrade: "Assinar o Pro",
      manage: "Gerenciar assinatura",
      language: "Idioma",
      logout: "Sair"
    },
    // Tela de benefícios: parada obrigatória entre QUALQUER botão de upgrade e
    // o checkout do Stripe. Antes dela, o clique levava direto para uma página
    // de pagamento que nunca dizia o que estava sendo comprado.
    //
    // PREÇO: os valores abaixo são cópia dos que `site/index.html` anuncia, e
    // `shared/site-pricing.test.ts` varre ESTE arquivo junto com o site para as
    // duas cópias não derivarem. Mudar preço aqui sem mudar lá (ou vice-versa)
    // é falha vermelha, não vigilância.
    plans: {
      title: "Claude Design Importer Pro",
      subtitle: "O que muda quando voc\xEA assina",
      freeTitle: "No gratuito",
      freeBody: "{limit} importa\xE7\xF5es de deck por m\xEAs",
      priceFull: "US$ 9",
      price: "US$ 4,80",
      pricePeriod: "/m\xEAs",
      foundingNote: "Founding price: US$ 4,80/m\xEAs para os 100 primeiros assinantes, travado por 12 meses. Depois, US$ 9/m\xEAs.",
      benefits: [
        "Importa\xE7\xF5es ilimitadas*",
        "Reconstru\xE7\xE3o completa e fiel do slide, sem amostra de 3 slides",
        "Cancele quando quiser, pelo portal do Stripe"
      ],
      fairUse: "*Uso individual, com teto de 300 importa\xE7\xF5es de deck por m\xEAs.",
      cta: "Assinar o Pro",
      payNote: "O pagamento acontece no Stripe, numa aba nova.",
      back: "Agora n\xE3o"
    },
    paywall: {
      title: "Limite atingido",
      body: "Voc\xEA usou suas {limit} importa\xE7\xF5es gratuitas deste m\xEAs.",
      // Esta tela é de CONTA, não bloqueio: as duas superfícies pousam aqui
      // no boot quando a cota grátis acabou, mas a tabbar continua saindo
      // daqui, capturar segue livre e importar segue entregando a amostra de
      // 3 slides completos (P-08). Sem esta linha a tela dizia o contrário do
      // que o produto faz — e ela é um dos cinco prints da Chrome Web Store.
      stillWorks: "Capturar continua liberado, e importar ainda traz uma amostra de 3 slides completos.",
      cta: "Assinar o Pro",
      resetNote: "Seu limite gratuito zera em {date}."
    },
    loader: {
      messages: [
        "Convencendo os pixels a cooperar\u2026",
        "Alinhando tudo com r\xE9gua e esquadro\u2026",
        "Dobrando os cantos com carinho\u2026",
        "Procurando as fontes certas\u2026",
        "Empilhando as camadas na ordem\u2026",
        "Dando o \xFAltimo ajuste fino\u2026"
      ]
    },
    errors: {
      offline: "Sem conex\xE3o",
      offlineBody: "Verifique sua internet e tente de novo.",
      // Usada quando o `fetch` falhou mas o navegador se diz online — o caso
      // comum, e o que a copy antiga descrevia errado. Menciona filtro de rede
      // porque foi exatamente isso que travou o primeiro teste em produção.
      // Deck no modo de slides do Claude cujos controles de navegação não foram
      // encontrados. A saída acionável é pedir o deck em página única — por isso
      // a copy diz o que fazer, não só o que falhou.
      slidesMode: "N\xE3o consegui percorrer os slides",
      slidesModeBody: "Pe\xE7a ao Claude para colocar todos os slides numa p\xE1gina s\xF3 e capture de novo.",
      unreachable: "N\xE3o alcan\xE7amos o servidor",
      unreachableBody: "Pode ser sua conex\xE3o, uma VPN ou um filtro de rede. Tente de novo.",
      generic: "Algo deu errado",
      sessionExpired: "Sua sess\xE3o expirou. Entre novamente.",
      tooLarge: "Deck grande demais",
      tooLargeBody: "Esse deck passa do tamanho m\xE1ximo que conseguimos capturar de uma vez. Imagens em alta resolu\xE7\xE3o s\xE3o o que costuma levar um deck a esse tamanho.",
      deckCapTitle: "Muitos decks esperando",
      deckCapBody: "Voc\xEA tem {active} decks capturados esperando importa\xE7\xE3o. Importe alguns no Figma para capturar mais."
    },
    time: {
      justNow: "agora",
      minutes: "h\xE1 {n} min",
      hours: "h\xE1 {n} h",
      days: "h\xE1 {n} d"
    },
    howTo: {
      title: "Como usar",
      step1Title: "1. No Chrome",
      step1Body: 'Abra o deck no Claude Design, clique no \xEDcone da extens\xE3o e em "Capturar deck".',
      step2Title: "2. No Figma",
      step2Body: 'Abra o plugin, escolha o deck na lista e clique em "Importar". Cada slide chega como um frame edit\xE1vel.',
      needsPlugin: "Voc\xEA tamb\xE9m precisa do plugin do Figma \u2014 \xE9 ele que reconstr\xF3i o deck em camadas.",
      needsExtension: "Voc\xEA tamb\xE9m precisa da extens\xE3o do Chrome \u2014 \xE9 ela que captura o deck no Claude Design.",
      install: "Instalar",
      done: "Entendi",
      link: "Como usar"
    }
  };

  // ../ui/src/i18n/en.ts
  var en = {
    common: {
      back: "Back",
      cancel: "Cancel",
      retry: "Try again",
      close: "Close",
      account: "Account",
      continue: "Continue",
      home: "Home",
      decks: "Decks"
    },
    login: {
      title: "Sign in",
      pitch: "Your Claude Design slides become editable layers in Figma.",
      subtitle: "We sent a 6-digit code to your email.",
      emailLabel: "Email",
      emailPlaceholder: "you@company.com",
      sendCode: "Send code",
      codeLabel: "Code",
      codePlaceholder: "000000",
      verify: "Sign in",
      changeEmail: "Use another email",
      resend: "Resend code",
      resendSent: "New code sent.",
      invalidEmail: "Enter a valid email.",
      invalidCode: "Invalid or expired code.",
      disposableEmail: "Temporary email services aren\u2019t accepted. Please use a permanent address."
    },
    home: {
      title: "Capture deck",
      deckDetected: "Deck detected on this tab",
      noDeck: "Open a Claude deck to capture.",
      noDeckBody: "The extension captures the deck open in this tab. Open yours in Claude Design and come back here.",
      openClaudeDesign: "Open Claude Design",
      slides: "slides",
      // Separate singular: the card shows the tab's REAL count, and "1 slides"
      // is the tell of a number nobody checked.
      slide: "slide",
      capture: "Capture deck",
      // Says "imports" on purpose: the counter sits right under the "Capture
      // deck" button, and since quota moved to the confirmed import (P-09)
      // capturing does NOT consume anything. Without the word, the natural
      // reading of the number is "captures left", which is false.
      usage: "{used} of {limit} imports this month",
      unlimited: "Unlimited imports",
      untitledDeck: "Untitled deck"
    },
    capturing: {
      title: "Capturing"
    },
    success: {
      title: "Deck sent",
      body: "Open the plugin in Figma to import.",
      captureAnother: "Capture another"
    },
    decks: {
      title: "Recent decks",
      empty: "No decks yet",
      emptyNeedsExtension: "Install the Chrome extension",
      emptyBody: "Capture a deck using the Chrome extension.",
      emptyBodyCapture: "Open a Claude deck and capture it from the Home tab.",
      import: "Import",
      slides: "slides",
      delete: "Delete",
      confirmDelete: "Delete from history?",
      confirmDeleteYes: "Delete",
      deleted: "Deck deleted."
    },
    importing: {
      title: "Importing",
      cancelling: "Cancelling\u2026"
    },
    result: {
      title: "Done",
      imported: "{count} slides imported",
      importAnother: "Import another",
      missingFonts: "Fonts not found: {fonts}",
      failedImages: "{count} images failed to load",
      sampleTitle: "3-slide sample",
      sampleBody: "You've used your {limit} decks this month. These 3 slides are a sample \u2014 Pro brings in the whole deck.",
      sampleCta: "Subscribe to Pro",
      throttled: "You've passed this cycle's individual-use limit. Your imports keep working, they may just get slower.",
      reviewAsk: "Imported {count} slides. If this saved you time, a review on Figma Community helps a lot.",
      reviewCta: "Review on Figma Community"
    },
    account: {
      title: "Account",
      plan: "Plan",
      planFree: "Free",
      planPro: "Pro",
      usage: "Imports this month",
      resets: "Renews on {date}",
      upgrade: "Subscribe to Pro",
      manage: "Manage subscription",
      language: "Language",
      logout: "Sign out"
    },
    plans: {
      title: "Claude Design Importer Pro",
      subtitle: "What changes when you subscribe",
      freeTitle: "On the free plan",
      freeBody: "{limit} deck imports per month",
      priceFull: "$9",
      price: "$4.80",
      pricePeriod: "/month",
      foundingNote: "Founding price: $4.80/month for the first 100 subscribers, locked for 12 months. $9/month after that.",
      benefits: [
        "Unlimited imports*",
        "Full, faithful slide rebuild \u2014 no 3-slide sample",
        "Cancel anytime from the Stripe portal"
      ],
      fairUse: "*Individual use, capped at 300 deck imports per month.",
      cta: "Subscribe to Pro",
      payNote: "Payment happens on Stripe, in a new tab.",
      back: "Not now"
    },
    paywall: {
      title: "Limit reached",
      body: "You've used your {limit} free imports this month.",
      // This is an ACCOUNT screen, not a wall — see the pt-BR comment.
      stillWorks: "Capturing still works, and importing still brings a 3-slide sample, complete.",
      cta: "Subscribe to Pro",
      resetNote: "Your free allowance resets on {date}."
    },
    loader: {
      messages: [
        "Convincing pixels to cooperate\u2026",
        "Straightening every edge\u2026",
        "Folding corners neatly\u2026",
        "Hunting down the right fonts\u2026",
        "Stacking layers in order\u2026",
        "Adding the finishing touch\u2026"
      ]
    },
    errors: {
      offline: "You're offline",
      offlineBody: "Check your connection and try again.",
      slidesMode: "Couldn't step through the slides",
      slidesModeBody: "Ask Claude to put every slide on a single page, then capture again.",
      unreachable: "Couldn't reach the server",
      unreachableBody: "It may be your connection, a VPN, or a network filter. Try again.",
      generic: "Something went wrong",
      sessionExpired: "Your session expired. Sign in again.",
      tooLarge: "Deck too large",
      tooLargeBody: "This deck is over the maximum size we can capture at once. High-resolution images are usually what pushes a deck past it.",
      deckCapTitle: "Too many decks waiting",
      deckCapBody: "You have {active} captured decks waiting to be imported. Import some in Figma to capture more."
    },
    time: {
      justNow: "just now",
      minutes: "{n} min ago",
      hours: "{n} h ago",
      days: "{n} d ago"
    },
    howTo: {
      title: "How to use",
      step1Title: "1. In Chrome",
      step1Body: 'Open the deck in Claude Design, click the extension icon, then "Capture deck".',
      step2Title: "2. In Figma",
      step2Body: 'Open the plugin, pick the deck from the list, and click "Import". Each slide arrives as an editable frame.',
      needsPlugin: "You also need the Figma plugin \u2014 it's what rebuilds the deck in layers.",
      needsExtension: "You also need the Chrome extension \u2014 it's what captures the deck in Claude Design.",
      install: "Install",
      done: "Got it",
      link: "How to use"
    }
  };

  // ../ui/src/i18n/index.ts
  var LOCALES = ["pt-BR", "en"];
  var DEFAULT_LOCALE = "en";
  function dictFor(locale) {
    return locale === "pt-BR" ? ptBR : en;
  }
  function localeFlag(locale) {
    return locale === "pt-BR" ? "\u{1F1E7}\u{1F1F7}" : "\u{1F1FA}\u{1F1F8}";
  }
  function interpolate(template, values) {
    return template.replace(
      /\{(\w+)\}/g,
      (match, key) => key in values ? String(values[key]) : match
    );
  }

  // ../ui/src/locale-store.ts
  var VALID_LOCALES = LOCALES;
  function resolveInitialLocale(o) {
    const trimmed = o.stored?.trim();
    if (trimmed && VALID_LOCALES.includes(trimmed)) {
      return trimmed;
    }
    return DEFAULT_LOCALE;
  }

  // ../ui/src/components.ts
  function escapeHtml(value) {
    return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function button(o) {
    const classes = ["btn", `btn--${o.variant ?? "primary"}`];
    if (o.full) classes.push("btn--full");
    const id = o.id ? ` id="${escapeHtml(o.id)}"` : "";
    const disabled = o.disabled ? " disabled" : "";
    return `<button type="button" class="${classes.join(" ")}"${id}${disabled}>${escapeHtml(o.label)}</button>`;
  }
  function input(o) {
    const attrs = [
      `id="${escapeHtml(o.id)}"`,
      `type="${escapeHtml(o.type ?? "text")}"`,
      `class="input__field"`
    ];
    if (o.placeholder) attrs.push(`placeholder="${escapeHtml(o.placeholder)}"`);
    if (o.value) attrs.push(`value="${escapeHtml(o.value)}"`);
    if (o.inputmode) attrs.push(`inputmode="${escapeHtml(o.inputmode)}"`);
    if (o.maxlength) attrs.push(`maxlength="${o.maxlength}"`);
    return `
    <div class="input">
      <label class="input__label" for="${escapeHtml(o.id)}">${escapeHtml(o.label)}</label>
      <input ${attrs.join(" ")} />
    </div>`;
  }
  function card(o) {
    const classes = ["card"];
    if (o.interactive) classes.push("card--interactive");
    const id = o.id ? ` id="${escapeHtml(o.id)}"` : "";
    return `<div class="${classes.join(" ")}"${id}>${o.body}</div>`;
  }
  function badge(o) {
    return `<span class="badge badge--${o.tone ?? "neutral"}">${escapeHtml(o.label)}</span>`;
  }
  function progressBar(o) {
    const pct = Math.max(0, Math.min(100, Math.round(o.percent)));
    const id = o.id ? ` id="${escapeHtml(o.id)}"` : "";
    return `
    <div class="progress" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"${id}>
      <div class="progress__fill" style="width: ${pct}%"></div>
    </div>`;
  }
  function skeleton(o = {}) {
    const lines = o.lines ?? 3;
    return `<div class="skeleton">${Array.from({ length: lines }, () => `<div class="skeleton__line"></div>`).join("")}</div>`;
  }
  function emptyState(o) {
    return `
    <div class="empty">
      <div class="empty__icon">${escapeHtml(o.icon ?? "\u{1F4C4}")}</div>
      <p class="empty__title">${escapeHtml(o.title)}</p>
      <p class="empty__body">${escapeHtml(o.body)}</p>
      ${o.action ? `<div class="empty__action">${o.action}</div>` : ""}
    </div>`;
  }
  function toast(o) {
    return `<div class="toast toast--${o.tone ?? "neutral"}">${escapeHtml(o.message)}</div>`;
  }
  function languageToggle(o) {
    const id = o.id ? ` id="${escapeHtml(o.id)}"` : "";
    return `<button type="button" class="lang"${id} aria-label="language">${localeFlag(o.locale)}</button>`;
  }

  // ../ui/src/screens/booting.ts
  function renderBooting() {
    return `<div class="booting">${skeleton({ lines: 4 })}</div>`;
  }

  // ../ui/src/screens/passos.ts
  function slideIcon() {
    return `<svg viewBox="0 0 40 40" width="40" height="40" style="flex-shrink: 0" aria-hidden="true" focusable="false">
    <rect x="3" y="3" width="34" height="34" rx="6" fill="var(--surface-2)" stroke="var(--border)" stroke-width="1.5"/>
    <rect x="9" y="11" width="20" height="5" rx="2" fill="var(--accent)"/>
    <rect x="9" y="20" width="22" height="3" rx="1.5" fill="var(--surface-3)"/>
    <rect x="9" y="26" width="14" height="3" rx="1.5" fill="var(--surface-3)"/>
  </svg>`;
  }
  function layersIcon() {
    return `<svg viewBox="0 0 40 40" width="40" height="40" style="flex-shrink: 0" aria-hidden="true" focusable="false">
    <rect x="3" y="9" width="26" height="20" rx="5" fill="var(--surface-2)" stroke="var(--border)" stroke-width="1.5"/>
    <rect x="8" y="14" width="26" height="20" rx="5" fill="var(--surface-3)" stroke="var(--border)" stroke-width="1.5"/>
    <rect x="13" y="19" width="24" height="18" rx="5" fill="var(--accent)" opacity="0.85"/>
  </svg>`;
  }
  function step(icon, title, body) {
    return card({
      body: `
      <div class="row">
        ${icon}
        <div>
          <strong>${escapeHtml(title)}</strong>
          <p class="screen__meta">${escapeHtml(body)}</p>
        </div>
      </div>`
    });
  }

  // ../ui/src/screens/login.ts
  function renderLogin(o) {
    const errorHtml = o.error ? toast({ message: o.error, tone: "danger" }) : "";
    if (o.step === "email") {
      const explicacao = o.surface === "plugin" ? `
      <p class="screen__subtitle">${escapeHtml(o.dict.login.pitch)}</p>
      <div class="stack">
        ${step(slideIcon(), o.dict.howTo.step1Title, o.dict.howTo.step1Body)}
        ${step(layersIcon(), o.dict.howTo.step2Title, o.dict.howTo.step2Body)}
      </div>` : "";
      return `
      <h2 class="screen__title">${escapeHtml(o.dict.login.title)}</h2>
      ${explicacao}
      ${input({ id: "login-email", label: o.dict.login.emailLabel, placeholder: o.dict.login.emailPlaceholder, type: "email" })}
      ${errorHtml}
      ${button({ label: o.dict.login.sendCode, id: "login-send", full: true })}`;
    }
    return `
    <h2 class="screen__title">${escapeHtml(o.dict.login.title)}</h2>
    <p class="screen__subtitle">${escapeHtml(o.dict.login.subtitle)}</p>
    <p class="screen__meta">${escapeHtml(o.email ?? "")}</p>
    ${input({ id: "login-code", label: o.dict.login.codeLabel, placeholder: o.dict.login.codePlaceholder, inputmode: "numeric", maxlength: 6 })}
    ${errorHtml}
    ${button({ label: o.dict.login.verify, id: "login-verify", full: true })}
    ${button({ label: o.dict.login.resend, id: "login-resend", variant: "ghost", full: true })}
    ${button({ label: o.dict.login.changeEmail, id: "login-change", variant: "ghost", full: true })}`;
  }

  // ../ui/src/format.ts
  var EN_MONTHS = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec"
  ];
  function formatResetDate(iso, locale) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
    if (!match) return iso;
    const [, year, month, day] = match;
    const monthIndex = Number(month) - 1;
    if (monthIndex < 0 || monthIndex > 11) return iso;
    if (locale === "pt-BR") return `${day}/${month}`;
    return `${EN_MONTHS[monthIndex]} ${Number(day)}`;
  }
  function relativeTime(o) {
    const elapsed = Math.max(0, o.nowMs - o.fromMs);
    const minutes = Math.floor(elapsed / 6e4);
    if (minutes < 1) return o.dict.time.justNow;
    if (minutes < 60) return interpolate(o.dict.time.minutes, { n: minutes });
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return interpolate(o.dict.time.hours, { n: hours });
    return interpolate(o.dict.time.days, { n: Math.floor(hours / 24) });
  }
  function formatUsage(o) {
    if (o.limit === null) return o.dict.home.unlimited;
    return interpolate(o.dict.home.usage, { used: o.used, limit: o.limit });
  }

  // ../ui/src/screens/account.ts
  function renderAccount(o) {
    const isPro = o.account.plan === "pro";
    const planLabel = isPro ? o.dict.account.planPro : o.dict.account.planFree;
    const planCard = card({
      body: `
      <div class="row row--between">
        <span class="muted">${escapeHtml(o.dict.account.plan)}</span>
        ${badge({ label: planLabel, tone: isPro ? "accent" : "neutral" })}
      </div>
      <div class="row row--between">
        <span class="muted">${escapeHtml(o.dict.account.usage)}</span>
        <strong>${escapeHtml(formatUsage({ used: o.account.used, limit: o.account.limit, dict: o.dict }))}</strong>
      </div>
      <p class="screen__meta">${escapeHtml(interpolate(o.dict.account.resets, { date: formatResetDate(o.account.resetsOn, o.locale) }))}</p>`
    });
    return `
    <div class="row row--between">
      <h2 class="screen__title">${escapeHtml(o.dict.account.title)}</h2>
      ${languageToggle({ locale: o.locale, id: "account-lang" })}
    </div>
    <p class="screen__meta">${escapeHtml(o.account.email)}</p>
    ${planCard}
    ${isPro ? button({ label: o.dict.account.manage, id: "account-manage", variant: "ghost", full: true }) : button({ label: o.dict.account.upgrade, id: "account-upgrade", full: true })}
    ${button({ label: o.dict.account.logout, id: "account-logout", variant: "danger", full: true })}`;
  }

  // ../ui/src/screens/paywall.ts
  function renderPaywall(o) {
    return `
    <!-- \xCDcone deliberadamente N\xC3O \xE9 cadeado: nada aqui est\xE1 trancado.
         Capturar segue livre e importar segue entregando a amostra de 3
         slides (P-08) \u2014 um cadeado sobre "Limite atingido" contradizia o
         produto na tela que tamb\xE9m \xE9 print de loja. -->
    <div class="paywall__icon">\u2728</div>
    <h2 class="screen__title">${escapeHtml(o.dict.paywall.title)}</h2>
    <p class="screen__subtitle">${escapeHtml(interpolate(o.dict.paywall.body, { limit: o.limit }))}</p>
    <p class="screen__subtitle">${escapeHtml(o.dict.paywall.stillWorks)}</p>
    ${button({ label: o.dict.paywall.cta, id: "paywall-upgrade", full: true })}
    <p class="screen__meta">${escapeHtml(interpolate(o.dict.paywall.resetNote, { date: formatResetDate(o.resetsOn, o.locale) }))}</p>`;
  }

  // ../ui/src/screens/decks.ts
  function renderDecks(o) {
    const convidaInstalar = o.canImport && o.needsExtension === true;
    const acaoInstalar = convidaInstalar && o.storeUrl ? `<a id="install-extension-empty-list" class="btn btn--primary" href="${escapeHtml(o.storeUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(o.dict.howTo.install)}</a>` : void 0;
    const list = o.decks.length === 0 ? emptyState({
      title: convidaInstalar ? o.dict.decks.emptyNeedsExtension : o.dict.decks.empty,
      body: convidaInstalar ? o.dict.howTo.needsExtension : o.canImport ? o.dict.decks.emptyBody : o.dict.decks.emptyBodyCapture,
      icon: convidaInstalar ? "\u{1F9E9}" : "\u{1F5C2}\uFE0F",
      action: acaoInstalar
    }) : o.decks.map((deck) => {
      const confirming = o.confirmingDeleteId === deck.id;
      const actions = confirming ? `${button({ label: o.dict.decks.confirmDeleteYes, id: `delete-confirm-${deck.id}`, variant: "danger" })}
               ${button({ label: o.dict.common.cancel, id: `delete-cancel-${deck.id}`, variant: "ghost" })}` : `${o.canImport ? button({ label: o.dict.decks.import, id: `import-${deck.id}` }) : ""}
               ${button({ label: o.dict.decks.delete, id: `delete-${deck.id}`, variant: "ghost" })}`;
      return card({
        interactive: true,
        id: `deck-${deck.id}`,
        body: `
              <div class="row row--between">
                <div>
                  <strong>${escapeHtml(deck.title)}</strong>
                  <p class="screen__meta">${escapeHtml(confirming ? o.dict.decks.confirmDelete : `${deck.slideCount} ${o.dict.decks.slides}`)} \xB7 ${escapeHtml(relativeTime({ fromMs: deck.capturedAtMs, nowMs: o.nowMs, dict: o.dict }))}</p>
                </div>
                <div class="row">${actions}</div>
              </div>`
      });
    }).join("");
    return `
    <h2 class="screen__title">${escapeHtml(o.dict.decks.title)}</h2>
    <div class="stack">${list}</div>`;
  }

  // ../ui/src/screens/plans.ts
  function renderPlans(o) {
    const beneficios = o.dict.plans.benefits.map((item) => `<li class="plans__benefit">${escapeHtml(item)}</li>`).join("");
    const precoCard = card({
      body: `
      <p class="plans__price">
        <s class="plans__price-strike">${escapeHtml(o.dict.plans.priceFull)}</s>
        <strong>${escapeHtml(o.dict.plans.price)}</strong>
        <small>${escapeHtml(o.dict.plans.pricePeriod)}</small>
      </p>
      <p class="screen__meta">${escapeHtml(o.dict.plans.foundingNote)}</p>
      <ul class="plans__benefits">${beneficios}</ul>
      <p class="screen__meta">${escapeHtml(o.dict.plans.fairUse)}</p>`
    });
    return `
    <div class="plans">
      <h2 class="screen__title">${escapeHtml(o.dict.plans.title)}</h2>
      <p class="screen__subtitle">${escapeHtml(o.dict.plans.subtitle)}</p>
      <p class="screen__meta">${escapeHtml(o.dict.plans.freeTitle)}: ${escapeHtml(interpolate(o.dict.plans.freeBody, { limit: o.freeLimit }))}</p>
      ${precoCard}
      ${button({ label: o.dict.plans.cta, id: "plans-subscribe", full: true })}
      <p class="screen__meta">${escapeHtml(o.dict.plans.payNote)}</p>
      ${button({ label: o.dict.plans.back, id: "plans-back", variant: "ghost", full: true })}
    </div>`;
  }

  // ../ui/src/screens/error.ts
  function semRede() {
    return typeof navigator !== "undefined" && navigator.onLine === false;
  }
  function renderError(o) {
    const copy = {
      offline: semRede() ? { title: o.dict.errors.offline, body: o.dict.errors.offlineBody, icon: "\u{1F4E1}" } : { title: o.dict.errors.unreachable, body: o.dict.errors.unreachableBody, icon: "\u{1F4E1}" },
      generic: { title: o.dict.errors.generic, body: "", icon: "\u26A0\uFE0F" },
      slidesMode: { title: o.dict.errors.slidesMode, body: o.dict.errors.slidesModeBody, icon: "\u{1F39E}\uFE0F" },
      sessionExpired: { title: o.dict.errors.sessionExpired, body: "", icon: "\u{1F511}" },
      tooLarge: { title: o.dict.errors.tooLarge, body: o.dict.errors.tooLargeBody, icon: "\u{1F4E6}" },
      // Teto de decks ATIVOS (não expirados) capturados esperando importação -
      // limite de STORAGE, não de plano (um Pro também tem teto, só que maior).
      // Por isso NUNCA aponta pro paywall, e nunca promete apagar deck: não
      // existe `DELETE /decks/:deckId` na API. A única saída real é importar
      // no Figma o que já foi capturado, ou esperar o TTL de 7 dias.
      deck_cap: {
        title: o.dict.errors.deckCapTitle,
        body: interpolate(o.dict.errors.deckCapBody, { active: o.active ?? 0 }),
        icon: "\u{1F5C4}\uFE0F"
      }
    }[o.kind];
    return `
    ${emptyState({ title: copy.title, body: copy.body, icon: copy.icon })}
    ${button({ label: o.dict.common.retry, id: "error-retry", full: true })}`;
  }

  // ../ui/src/screens/how-to.ts
  function renderHowTo(o) {
    const t = o.dict.howTo;
    const notice = o.surface === "extension" ? t.needsPlugin : t.needsExtension;
    const noticeHtml = o.storeUrl ? `<p class="screen__meta">${escapeHtml(notice)} <a id="install-extension-how-to" href="${escapeHtml(o.storeUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(t.install)}</a></p>` : `<p class="screen__meta">${escapeHtml(notice)}</p>`;
    return `
    <h2 class="screen__title">${escapeHtml(t.title)}</h2>
    ${step(slideIcon(), t.step1Title, t.step1Body)}
    ${step(layersIcon(), t.step2Title, t.step2Body)}
    ${noticeHtml}
    ${button({ label: t.done, id: "how-to-done", full: true })}`;
  }

  // src/popup/screens/home.ts
  function renderHome(o) {
    const acaoAbrirClaude = o.claudeDesignUrl ? `<a class="btn btn--primary" href="${escapeHtml(o.claudeDesignUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(o.dict.home.openClaudeDesign)}</a>` : void 0;
    const deckHtml = o.deck ? card({ body: corpoDoDeck(o.deck, o.dict) }) : emptyState({
      title: o.dict.home.noDeck,
      body: o.dict.home.noDeckBody,
      icon: "\u{1F5C2}\uFE0F",
      action: acaoAbrirClaude
    });
    return `
    <h2 class="screen__title">${escapeHtml(o.dict.home.title)}</h2>
    ${deckHtml}
    ${button({
      label: o.dict.home.capture,
      id: "home-capture",
      full: true,
      // Crédito esgotado NÃO desabilita o botão aqui: só o servidor é a
      // autoridade sobre a cota (ver `server/src/services/decks.ts`) — decidir
      // isso no cliente inverteria essa regra (I1 da revisão da Fase 4).
      // O 402 do servidor, quando de fato recusado, é quem leva o usuário
      // ao paywall.
      disabled: o.deck === null
    })}
    <p class="screen__meta">${escapeHtml(formatUsage({ used: o.account.used, limit: o.account.limit, dict: o.dict }))}</p>
    ${o.account.limit !== null ? button({ label: o.dict.account.upgrade, id: "home-upgrade", variant: "ghost", full: true }) : ""}`;
  }
  function corpoDoDeck(deck, dict) {
    const nome = deck.title.trim() || dict.home.untitledDeck;
    const contagem = deck.slideCount === void 0 ? "" : badge({
      label: `${deck.slideCount} ${deck.slideCount === 1 ? dict.home.slide : dict.home.slides}`
    });
    const rotulo = (deck.primeiroRotulo ?? "").trim();
    const linhaRotulo = rotulo && rotulo !== nome ? `<p class="screen__meta">${escapeHtml(rotulo)}</p>` : "";
    return `
          <p class="screen__meta">${escapeHtml(dict.home.deckDetected)}</p>
          <div class="row row--between">
            <strong>${escapeHtml(nome)}</strong>
            ${contagem}
          </div>
          ${linhaRotulo}`;
  }

  // src/popup/screens/capturing.ts
  function renderCapturing(o) {
    return `
    <h2 class="screen__title">${escapeHtml(o.dict.capturing.title)}</h2>
    ${progressBar({ percent: o.percent, id: "capturing-progress" })}
    <p class="screen__subtitle" id="capturing-message">${escapeHtml(o.message)}</p>`;
  }

  // src/popup/screens/success.ts
  function renderSuccess(o) {
    return `
    <div class="success__check">\u2713</div>
    <h2 class="screen__title">${escapeHtml(o.dict.success.title)}</h2>
    <p class="screen__meta">${escapeHtml(o.deckTitle)}</p>
    <p class="screen__subtitle">${escapeHtml(o.dict.success.body)}</p>
    ${button({ label: o.dict.success.captureAnother, id: "success-again", variant: "ghost", full: true })}`;
  }

  // ../shared/api-client.ts
  function defaultFetch() {
    return globalThis.fetch;
  }
  function numberField(data, key) {
    if (typeof data !== "object" || data === null) return void 0;
    const value = data[key];
    return typeof value === "number" ? value : void 0;
  }
  async function readJson(response) {
    try {
      return await response.json();
    } catch {
      return null;
    }
  }
  function createApiClient(options) {
    const { baseUrl, getToken, onUnauthorized } = options;
    const fetchImpl = options.fetchImpl ?? defaultFetch();
    async function request(method, path, body) {
      let token;
      let response;
      try {
        token = await getToken();
        const headers = {};
        if (body !== void 0) headers["content-type"] = "application/json";
        if (token) headers.authorization = `Bearer ${token}`;
        const init2 = {
          method,
          headers,
          body: body !== void 0 ? JSON.stringify(body) : void 0
        };
        response = await fetchImpl(`${baseUrl}${path}`, init2);
      } catch {
        return { ok: false, error: { kind: "offline" } };
      }
      if (response.status === 401) {
        if (token) await onUnauthorized();
        return { ok: false, error: { kind: "unauthorized", status: 401 } };
      }
      if (response.status === 402) {
        const data = await readJson(response);
        const error = {
          kind: "quota",
          used: numberField(data, "used"),
          limit: numberField(data, "limit"),
          status: 402
        };
        return { ok: false, error };
      }
      if (response.status === 422) {
        const data = await readJson(response);
        const reason = typeof data === "object" && data !== null ? data.error : void 0;
        if (reason === "disposable_email") {
          return { ok: false, error: { kind: "disposable_email", status: 422 } };
        }
        return { ok: false, error: { kind: "server", status: 422 } };
      }
      if (response.status === 413) {
        return { ok: false, error: { kind: "too_large", status: 413 } };
      }
      if (response.status === 429) {
        const data = await readJson(response);
        const error = {
          kind: "deck_cap",
          active: numberField(data, "active"),
          cap: numberField(data, "cap"),
          status: 429
        };
        return { ok: false, error };
      }
      if (response.status >= 500) {
        return { ok: false, error: { kind: "server", status: response.status } };
      }
      if (response.status === 204) {
        return { ok: true, value: void 0 };
      }
      if (response.status >= 200 && response.status < 300) {
        const data = await readJson(response);
        return { ok: true, value: data };
      }
      return { ok: false, error: { kind: "server", status: response.status } };
    }
    return {
      requestCode(email) {
        return request("POST", "/auth/request-code", { email });
      },
      verifyCode(o) {
        return request("POST", "/auth/verify", o);
      },
      me() {
        return request("GET", "/me");
      },
      logout() {
        return request("POST", "/auth/logout");
      },
      submitDeck(o) {
        return request("POST", "/decks", o);
      },
      listDecks() {
        return request("GET", "/decks");
      },
      getDeck(id) {
        return request("GET", `/decks/${encodeURIComponent(id)}`);
      },
      deleteDeck(id) {
        return request("DELETE", `/decks/${encodeURIComponent(id)}`);
      },
      confirmImport(o) {
        const { deckId, ...body } = o;
        return request(
          "POST",
          `/decks/${encodeURIComponent(deckId)}/imported`,
          body
        );
      },
      deleteAccount() {
        return request("DELETE", "/me");
      },
      createCheckoutUrl(locale) {
        return request("POST", "/billing/checkout", locale ? { locale } : void 0);
      },
      createPortalUrl() {
        return request("POST", "/billing/portal");
      },
      sendEvents(o) {
        return request("POST", "/events", o);
      }
    };
  }

  // ../shared/events.ts
  var MAX_EVENTS_PER_REQUEST = 20;
  var MAX_EVENT_BODY_BYTES = 8 * 1024;

  // ../shared/telemetry.ts
  var CHAVE_DEVICE = "telemetry:device-id";
  var CHAVE_FILA = "telemetry:queue";
  var CHAVE_DESCARTADOS = "telemetry:dropped";
  var MAX_QUEUE = 200;
  function loteRecusado(status) {
    return status !== void 0 && status >= 400 && status < 500 && status !== 429;
  }
  function uuidV4Padrao() {
    const c = globalThis.crypto;
    if (c?.randomUUID) return c.randomUUID();
    const bytes = new Uint8Array(16);
    c?.getRandomValues?.(bytes);
    bytes[6] = bytes[6] & 15 | 64;
    bytes[8] = bytes[8] & 63 | 128;
    const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  function createTelemetry(o) {
    const agora = o.now ?? (() => /* @__PURE__ */ new Date());
    const novoUuid = o.uuid ?? uuidV4Padrao;
    let cadeia = Promise.resolve();
    function serializar(operacao) {
      cadeia = cadeia.then(operacao, operacao);
      return cadeia;
    }
    async function deviceId() {
      const guardado = await o.storage.getText(CHAVE_DEVICE);
      if (guardado) return guardado;
      const novo = novoUuid();
      await o.storage.setText(CHAVE_DEVICE, novo);
      return novo;
    }
    async function lerFila() {
      const cru = await o.storage.getText(CHAVE_FILA);
      if (!cru) return [];
      try {
        const parsed = JSON.parse(cru);
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    }
    async function lerDescartados() {
      const cru = await o.storage.getText(CHAVE_DESCARTADOS);
      const n = Number(cru);
      return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
    }
    return {
      track(name, props) {
        return serializar(async () => {
          try {
            const fila = await lerFila();
            const excedente = Math.max(0, fila.length + 1 - MAX_QUEUE);
            const descartados = await lerDescartados() + excedente;
            const propsFinal = descartados > 0 ? { ...props ?? {}, dropped: descartados } : props;
            fila.push({ name, at: agora().toISOString(), props: propsFinal });
            if (excedente > 0) fila.splice(0, excedente);
            await o.storage.setText(CHAVE_FILA, JSON.stringify(fila));
            if (excedente > 0) await o.storage.setText(CHAVE_DESCARTADOS, String(descartados));
          } catch {
          }
        });
      },
      flush() {
        return serializar(async () => {
          try {
            const fila = await lerFila();
            if (fila.length === 0) return;
            const lote = fila.slice(0, MAX_EVENTS_PER_REQUEST);
            const resto = fila.slice(MAX_EVENTS_PER_REQUEST);
            const resultado = await o.send({ deviceId: await deviceId(), events: lote });
            if (resultado.ok || resultado.recusado) {
              await o.storage.setText(CHAVE_FILA, JSON.stringify(resto));
            }
          } catch {
          }
        });
      }
    };
  }

  // ../shared/stores.ts
  var FIGMA_COMMUNITY_URL = "https://www.figma.com/community/plugin/1674169407347533342";
  var CLAUDE_DESIGN_URL = "https://claude.ai/design";

  // ../shared/auth.ts
  var LOGIN_CODE_TTL_MS = 10 * 60 * 1e3;

  // src/config.ts
  var API_BASE_URL = "https://www.claudefigmaplugin.com/api";

  // src/storage.ts
  var TOKEN_KEY = "auth-token";
  var LOCALE_KEY = "locale";
  var PENDING_LOGIN_KEY = "pending-login";
  async function readString(key) {
    const result = await chrome.storage.local.get(key);
    const value = result[key];
    return typeof value === "string" ? value : null;
  }
  async function writeString(key, value) {
    await chrome.storage.local.set({ [key]: value });
  }
  async function remove(key) {
    await chrome.storage.local.remove(key);
  }
  async function readPendingLogin() {
    const raw = await readString(PENDING_LOGIN_KEY);
    if (raw === null) return null;
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
    if (typeof parsed !== "object" || parsed === null) return null;
    const { email, requestedAtMs } = parsed;
    if (typeof email !== "string" || typeof requestedAtMs !== "number") return null;
    return { email, requestedAtMs };
  }
  function createStorage() {
    return {
      getToken: () => readString(TOKEN_KEY),
      setToken: (token) => writeString(TOKEN_KEY, token),
      clearToken: () => remove(TOKEN_KEY),
      getLocale: () => readString(LOCALE_KEY),
      setLocale: (locale) => writeString(LOCALE_KEY, locale),
      // Prefixo `flag:` para uma flag nunca colidir com TOKEN_KEY/LOCALE_KEY,
      // e para o conjunto de flags ser inspecionável de fora sem uma lista
      // fixa de nomes aqui dentro.
      getFlag: async (name) => await readString(`flag:${name}`) === "1",
      setFlag: (name) => writeString(`flag:${name}`, "1"),
      getText: (key) => readString(key),
      setText: (key, value) => writeString(key, value),
      getPendingLogin: readPendingLogin,
      setPendingLogin: (pending) => writeString(PENDING_LOGIN_KEY, JSON.stringify(pending)),
      clearPendingLogin: () => remove(PENDING_LOGIN_KEY)
    };
  }

  // src/popup/deck.ts
  function countSlides(root2) {
    if (root2.type !== "FRAME") return 1;
    if (root2.role === "slide") return 1;
    let node = root2;
    while (node.role !== "deck" && node.children?.length === 1 && node.children[0].type === "FRAME") {
      node = node.children[0];
    }
    if (node.role === "deck") return node.children?.length ?? 1;
    const looksLikeDeck = node !== root2 && node.children !== void 0 && node.children.length >= 2 && node.children.every((c) => c.type === "FRAME" && c.rect.w >= 200 && c.rect.h >= 150);
    return looksLikeDeck ? node.children.length : 1;
  }

  // src/popup/popup.ts
  var state = {
    // Chute inicial síncrono a partir do idioma do navegador — só até `init()`
    // (assíncrono, lê o storage) resolver a escolha explícita salva, se houver
    // uma. Evita depender de uma Promise ainda pendente no primeiro render.
    locale: DEFAULT_LOCALE,
    loginStep: "email",
    email: "",
    loginError: "",
    account: null,
    deck: null,
    tabDeck: null,
    decks: null,
    confirmingDeleteId: null,
    loaderPercent: 0,
    loaderMessage: "",
    errorKind: "offline",
    errorActive: void 0,
    plansReturnTo: "home"
  };
  var root = document.getElementById("root");
  var router = createRouter(root, "booting");
  var storage = createStorage();
  var api = createApiClient({
    baseUrl: API_BASE_URL,
    getToken: () => storage.getToken(),
    onUnauthorized: () => storage.clearToken()
  });
  var telemetry = createTelemetry({
    storage,
    send: async (o) => {
      const r = await api.sendEvents(o);
      return r.ok ? { ok: true } : { ok: false, recusado: loteRecusado(r.error.status) };
    }
  });
  void telemetry.flush();
  var emptyAccount = { email: "", plan: "free", used: 0, limit: 5, resetsOn: "", hasExtension: true };
  var loader = null;
  function stopLoader() {
    if (!loader) return;
    loader.rotator.stop();
    loader = null;
  }
  function setLoaderPercent(percent) {
    state.loaderPercent = percent;
    const bar = document.getElementById("capturing-progress")?.querySelector(".progress__fill");
    if (bar) bar.style.width = `${percent}%`;
  }
  function isOutOfCredits(account) {
    return account.limit !== null && account.used >= account.limit;
  }
  async function openBilling(kind, screenId) {
    const dict = dictFor(state.locale);
    const result = kind === "checkout" ? await api.createCheckoutUrl(state.locale) : await api.createPortalUrl();
    if (!result.ok) {
      flashToast(screenId, dict.errors.generic, "danger");
      return;
    }
    await chrome.tabs.create({ url: result.value.url });
  }
  function goPlans(from) {
    state.plansReturnTo = from;
    router.go("plans");
  }
  function screen(id) {
    return root.querySelector(`[data-screen="${id}"]`);
  }
  function flashToast(screenId, message, tone = "neutral") {
    const container = screen(screenId);
    if (!container) return;
    const wrapper = document.createElement("div");
    wrapper.innerHTML = toast({ message, tone });
    const node = wrapper.firstElementChild;
    if (!node) return;
    container.prepend(node);
    setTimeout(() => node.remove(), 2500);
  }
  function deckDaSonda(sonda) {
    if (!sonda || !sonda.ok) return null;
    if (sonda.formato === "slides") {
      return { title: sonda.title, slideCount: sonda.slides, primeiroRotulo: sonda.rotulos[0] };
    }
    return { title: sonda.title };
  }
  async function sondarAba() {
    try {
      state.tabDeck = await chrome.runtime.sendMessage({ type: "probe" });
    } catch {
      state.tabDeck = { ok: false };
    }
    renderAll();
    if (router.current() !== "paywall") {
      void telemetry.track("home_viewed", { has_deck: deckDaSonda(state.tabDeck) !== null });
      void telemetry.flush();
    }
  }
  function renderAll() {
    const dict = dictFor(state.locale);
    const account = state.account ?? emptyAccount;
    const homeDeck = state.deck ?? deckDaSonda(state.tabDeck);
    screen("login").innerHTML = renderLogin({
      dict,
      step: state.loginStep,
      email: state.email,
      error: state.loginError || void 0
    });
    screen("home").innerHTML = renderHome({ dict, deck: homeDeck, account, claudeDesignUrl: CLAUDE_DESIGN_URL });
    screen("decks").innerHTML = state.decks === null ? skeleton({ lines: 3 }) : renderDecks({
      dict,
      decks: state.decks.map((deck) => ({
        id: deck.id,
        title: deck.title,
        slideCount: deck.slideCount,
        capturedAtMs: Date.parse(deck.createdAt)
      })),
      nowMs: Date.now(),
      // A extensão captura; importar é do plugin. Mesma tela, sem o
      // botão que aqui não teria o que fazer.
      canImport: false,
      confirmingDeleteId: state.confirmingDeleteId
    });
    screen("capturing").innerHTML = renderCapturing({ dict, percent: state.loaderPercent, message: state.loaderMessage });
    screen("success").innerHTML = renderSuccess({ dict, deckTitle: state.deck?.title ?? dict.home.untitledDeck });
    screen("account").innerHTML = renderAccount({ dict, locale: state.locale, account });
    screen("error").innerHTML = renderError({ dict, kind: state.errorKind, active: state.errorActive });
    screen("paywall").innerHTML = renderPaywall({ dict, locale: state.locale, limit: account.limit ?? 0, resetsOn: account.resetsOn });
    screen("plans").innerHTML = renderPlans({ dict, freeLimit: account.limit ?? 0 });
    screen("how-to").innerHTML = renderHowTo({ dict, surface: "extension", storeUrl: FIGMA_COMMUNITY_URL });
    const langButton = document.getElementById("top-lang");
    if (langButton) langButton.textContent = localeFlag(state.locale);
    const tabHome = document.getElementById("tab-home");
    if (tabHome) tabHome.textContent = dict.common.home;
    const tabDecks = document.getElementById("tab-decks");
    if (tabDecks) tabDecks.textContent = dict.common.decks;
    const tabAccount = document.getElementById("tab-account");
    if (tabAccount) tabAccount.textContent = dict.common.account;
    const tabHowTo = document.getElementById("tab-how-to");
    if (tabHowTo) tabHowTo.textContent = dict.howTo.link;
  }
  async function maybeShowHowTo() {
    if (router.current() !== "home") return;
    const howToSeen = await storage.getFlag("howToSeen");
    if (!howToSeen) {
      router.go("how-to");
      void telemetry.track("how_to_viewed", { surface: "extension" });
      void telemetry.flush();
      await storage.setFlag("howToSeen");
    }
  }
  function goErrorScreen(kind, active) {
    state.errorKind = kind;
    state.errorActive = active;
    renderAll();
    router.go("error");
  }
  function goSessionExpired() {
    state.account = null;
    state.deck = null;
    void storage.clearPendingLogin();
    state.loginStep = "email";
    state.loginError = dictFor(state.locale).errors.sessionExpired;
    renderAll();
    router.go("login");
  }
  async function refreshAccount() {
    const result = await api.me();
    if (result.ok) {
      state.account = result.value;
      return { status: "ok" };
    }
    if (result.error.kind === "unauthorized") {
      goSessionExpired();
      return { status: "unauthorized" };
    }
    return { status: "error", kind: result.error.kind === "offline" ? "offline" : "generic" };
  }
  async function loadDecks() {
    state.decks = null;
    state.confirmingDeleteId = null;
    renderAll();
    const result = await api.listDecks();
    if (!result.ok) {
      if (result.error.kind === "unauthorized") return;
      goErrorScreen(result.error.kind === "offline" ? "offline" : "generic");
      return;
    }
    state.decks = result.value;
    renderAll();
  }
  async function deleteDeck(deckId) {
    const result = await api.deleteDeck(deckId);
    if (!result.ok) {
      if (result.error.kind === "unauthorized") {
        goSessionExpired();
        return;
      }
      if (result.error.kind === "offline") {
        goErrorScreen("offline");
        return;
      }
    }
    flashToast("decks", dictFor(state.locale).decks.deleted, "success");
    await loadDecks();
  }
  async function restorePendingLogin() {
    const pending = await storage.getPendingLogin();
    if (!pending) return;
    if (Date.now() - pending.requestedAtMs >= LOGIN_CODE_TTL_MS) {
      await storage.clearPendingLogin();
      return;
    }
    state.email = pending.email;
    state.loginStep = "code";
  }
  async function init() {
    const storedLocale = await storage.getLocale();
    state.locale = resolveInitialLocale({ stored: storedLocale });
    const token = await storage.getToken();
    void telemetry.track("popup_opened", { logged_in: Boolean(token) });
    void telemetry.flush();
    if (!token) {
      await restorePendingLogin();
      renderAll();
      router.go("login");
      if (state.loginStep === "code") focusCodeInput();
      return;
    }
    const outcome = await refreshAccount();
    if (outcome.status === "unauthorized") return;
    if (outcome.status === "error") {
      goErrorScreen(outcome.kind);
      return;
    }
    renderAll();
    router.go(isOutOfCredits(state.account) ? "paywall" : "home");
    void sondarAba();
    await maybeShowHowTo();
  }
  function focusCodeInput() {
    const field = document.getElementById("login-code");
    if (field instanceof HTMLInputElement) field.focus();
  }
  function emailLooksValid(value) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
  }
  async function handleLoginSend() {
    const dict = dictFor(state.locale);
    const value = document.getElementById("login-email")?.value.trim() ?? "";
    if (!emailLooksValid(value)) {
      state.loginError = dict.login.invalidEmail;
      renderAll();
      return;
    }
    state.email = value;
    void telemetry.track("login_started", { surface: "extension" });
    void telemetry.flush();
    const result = await api.requestCode(value);
    if (!result.ok) {
      if (result.error.kind === "disposable_email") state.loginError = dict.login.disposableEmail;
      else if (result.error.kind === "offline") state.loginError = dict.errors.offline;
      else state.loginError = dict.errors.generic;
      renderAll();
      return;
    }
    await storage.setPendingLogin({ email: value, requestedAtMs: Date.now() });
    state.loginStep = "code";
    state.loginError = "";
    renderAll();
    focusCodeInput();
  }
  async function handleLoginResend() {
    const dict = dictFor(state.locale);
    const result = await api.requestCode(state.email);
    if (!result.ok) {
      if (result.error.kind === "disposable_email") state.loginError = dict.login.disposableEmail;
      else if (result.error.kind === "offline") state.loginError = dict.errors.offline;
      else state.loginError = dict.errors.generic;
      renderAll();
      return;
    }
    await storage.setPendingLogin({ email: state.email, requestedAtMs: Date.now() });
    flashToast("login", dict.login.resendSent, "success");
  }
  async function handleLoginVerify() {
    const dict = dictFor(state.locale);
    const code = document.getElementById("login-code")?.value.trim() ?? "";
    const result = await api.verifyCode({ email: state.email, code, surface: "extension" });
    if (!result.ok) {
      if (result.error.kind === "offline") state.loginError = dict.errors.offline;
      else if (result.error.kind === "server") state.loginError = dict.errors.generic;
      else state.loginError = dict.login.invalidCode;
      renderAll();
      return;
    }
    await storage.setToken(result.value.token);
    await storage.clearPendingLogin();
    state.loginError = "";
    void telemetry.track("login_completed", { surface: "extension" });
    void telemetry.flush();
    const outcome = await refreshAccount();
    if (outcome.status === "unauthorized") return;
    if (outcome.status === "error") {
      goErrorScreen(outcome.kind);
      return;
    }
    renderAll();
    router.go(isOutOfCredits(state.account) ? "paywall" : "home");
    await maybeShowHowTo();
  }
  function handleLoginChange() {
    state.loginStep = "email";
    state.loginError = "";
    void storage.clearPendingLogin();
    renderAll();
  }
  async function handleLogout() {
    void api.logout();
    await storage.clearToken();
    await storage.clearPendingLogin();
    state.account = null;
    state.deck = null;
    state.loginStep = "email";
    state.email = "";
    state.loginError = "";
    renderAll();
    router.go("login");
  }
  function toggleLocale() {
    state.locale = state.locale === "pt-BR" ? "en" : "pt-BR";
    void storage.setLocale(state.locale);
    renderAll();
  }
  function registrarFalhaDeCaptura(reason, extras) {
    void telemetry.track("capture_failed", { reason, ...extras });
    void telemetry.flush();
  }
  var MOTIVOS_DE_ENVIO = ["quota", "deck_cap", "too_large", "offline", "unauthorized"];
  function motivoDoEnvio(kind) {
    return MOTIVOS_DE_ENVIO.includes(kind) ? kind : "server";
  }
  async function runCapture() {
    if (loader) return;
    if (!state.account) {
      router.go("paywall");
      return;
    }
    void telemetry.track("capture_started");
    void telemetry.flush();
    const dict = dictFor(state.locale);
    state.loaderMessage = "";
    setLoaderPercent(8);
    renderAll();
    router.go("capturing");
    const rotator = createMessageRotator({
      messages: [...dict.loader.messages],
      onTick: (message) => {
        state.loaderMessage = message;
        const label = document.getElementById("capturing-message");
        if (label) label.textContent = message;
      }
    });
    loader = { rotator };
    rotator.start();
    const ouvirProgresso = (msg) => {
      const m = msg;
      if (m?.type !== "capture-progress" || !m.payload?.total) return;
      const fracao = (m.payload.feitos ?? 0) / m.payload.total;
      setLoaderPercent(8 + Math.round(fracao * 42));
    };
    chrome.runtime.onMessage.addListener(ouvirProgresso);
    let response;
    try {
      response = await chrome.runtime.sendMessage({ type: "capture" });
    } catch {
      chrome.runtime.onMessage.removeListener(ouvirProgresso);
      stopLoader();
      registrarFalhaDeCaptura("tab_unreachable");
      goErrorScreen("generic");
      return;
    }
    chrome.runtime.onMessage.removeListener(ouvirProgresso);
    if (!response?.ok) {
      stopLoader();
      if (response?.error) console.error("[extension] captura falhou:", response.error);
      registrarFalhaDeCaptura(response?.kind === "slides-mode" ? "slides_mode" : "capture");
      goErrorScreen(response?.kind === "slides-mode" ? "slidesMode" : "generic");
      return;
    }
    setLoaderPercent(55);
    let tree;
    try {
      tree = JSON.parse(response.json);
    } catch {
      stopLoader();
      registrarFalhaDeCaptura("parse");
      goErrorScreen("generic");
      return;
    }
    let slideCount;
    try {
      slideCount = countSlides(tree);
    } catch {
      stopLoader();
      registrarFalhaDeCaptura("count");
      goErrorScreen("generic");
      return;
    }
    const capturedTitle = response.title?.trim();
    const title = capturedTitle && capturedTitle.length > 0 ? capturedTitle : dict.home.untitledDeck;
    const result = await api.submitDeck({ title, slideCount, payload: tree });
    if (!result.ok) {
      stopLoader();
      registrarFalhaDeCaptura(motivoDoEnvio(result.error.kind), {
        size_kb: Math.round(response.json.length / 1024)
      });
      if (result.error.kind === "quota") {
        const outcome = await refreshAccount();
        if (outcome.status === "unauthorized") return;
        renderAll();
        router.go("paywall");
        return;
      }
      if (result.error.kind === "deck_cap") {
        goErrorScreen("deck_cap", result.error.active);
        return;
      }
      if (result.error.kind === "too_large") {
        goErrorScreen("tooLarge");
        return;
      }
      if (result.error.kind === "offline") {
        goErrorScreen("offline");
        return;
      }
      if (result.error.kind === "unauthorized") {
        goSessionExpired();
        return;
      }
      goErrorScreen("generic");
      return;
    }
    setLoaderPercent(100);
    stopLoader();
    state.deck = { title, slideCount };
    renderAll();
    router.go("success");
  }
  document.addEventListener("click", (event) => {
    const target = event.target.closest("[id]");
    if (!target) return;
    if (target.id.startsWith("delete-confirm-")) {
      void deleteDeck(target.id.slice("delete-confirm-".length));
      return;
    }
    if (target.id.startsWith("delete-cancel-")) {
      state.confirmingDeleteId = null;
      renderAll();
      return;
    }
    if (target.id.startsWith("delete-")) {
      state.confirmingDeleteId = target.id.slice("delete-".length);
      renderAll();
      return;
    }
    switch (target.id) {
      case "login-send":
        void handleLoginSend();
        break;
      case "login-resend":
        void handleLoginResend();
        break;
      case "login-verify":
        void handleLoginVerify();
        break;
      case "login-change":
        handleLoginChange();
        break;
      case "home-capture":
        void runCapture();
        break;
      case "success-again":
        stopLoader();
        router.go("home");
        break;
      // Os três CTAs de upgrade abrem os BENEFÍCIOS, nunca o checkout. Só
      // `plans-subscribe` fala com o Stripe — um caminho só, sem exceção que
      // alguém esquece de manter (e sem ninguém pagando sem saber o quê).
      case "home-upgrade":
        goPlans("home");
        break;
      case "account-upgrade":
        goPlans("account");
        break;
      case "account-manage":
        void openBilling("portal", "account");
        break;
      case "error-retry":
        stopLoader();
        void init();
        break;
      case "paywall-upgrade":
        goPlans("paywall");
        break;
      case "plans-subscribe":
        void openBilling("checkout", "plans");
        break;
      case "plans-back":
        router.go(state.plansReturnTo);
        break;
      case "tab-home":
        stopLoader();
        if (state.account) {
          router.go("home");
          void refreshAccount().then((outcome) => {
            if (outcome.status === "ok") renderAll();
          });
        } else {
          router.go("login");
        }
        break;
      case "tab-decks":
        stopLoader();
        if (state.account) {
          router.go("decks");
          void loadDecks();
        } else {
          router.go("login");
        }
        break;
      case "tab-account":
      case "top-account":
        stopLoader();
        router.go(state.account ? "account" : "login");
        break;
      case "tab-how-to":
        if (state.account) router.go("how-to");
        else router.go("login");
        break;
      case "how-to-done":
        router.go("home");
        void storage.setFlag("howToSeen");
        break;
      case "account-logout":
        stopLoader();
        void handleLogout();
        break;
      case "top-lang":
      case "account-lang":
        toggleLocale();
        break;
    }
  });
  window.addEventListener("focus", () => {
    if (!state.account) return;
    void refreshAccount().then((outcome) => {
      if (outcome.status === "ok") renderAll();
    });
  });
  screen("booting").innerHTML = renderBooting();
  renderAll();
  void init().catch((err) => {
    console.error("[extension] falha no boot:", err);
    router.go("login");
  });
})();
