/* ------------------------------------------------------------------ *
 * FLUCTLIGHT — AI voice chat layer
 *
 * - Text replies: OpenRouter chat completions (free model).
 * - Voice out: browser SpeechSynthesis (free, no key, no server).
 * - Voice in: browser SpeechRecognition (free, no key; Chrome/Edge only).
 * - The orb reacts to speech via window.Fluctlight (see main.js) — this
 *   file never touches Three.js directly.
 *
 * ⚠️ SECURITY NOTE
 * The API key below ships inside client-side JS, so it is visible to
 * anyone who opens dev tools or views source on the deployed page —
 * there is no backend here to hide it behind. That's an accepted
 * trade-off for a personal/demo project, but:
 *   - don't reuse a key you care about elsewhere
 *   - expect it to eventually get scraped/abused if the site is public
 *   - rotate it on openrouter.ai if that happens
 * The proper fix is a tiny server-side proxy that holds the key and
 * forwards requests — ask if you'd like that added later.
 * ------------------------------------------------------------------ */

const OPENROUTER_API_KEY = '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';
const MODEL = 'nvidia/nemotron-3-nano-30b-a3b:free';

const SYSTEM_PROMPT =
  'Ты — Fluctlight, вежливый и тёплый ИИ-собеседник, живущий внутри 3D-визуализации ' +
  'квантового поля светового куба. Отвечай живо, по-человечески и по делу, 2-4 предложения. ' +
  'Отвечай на языке собеседника (по умолчанию — русский). Ты произносишь ответы вслух, ' +
  'поэтому избегай списков, markdown, эмодзи и длинных предложений — пиши так, как говорят. ' +
  'В ответе — только финальная реплика, без рассуждений вслух и без пометок о том, как ты думаешь.';

const $ = (id) => document.getElementById(id);
const chatLog = $('chatLog');
const chatForm = $('chatForm');
const chatInput = $('chatInput');
const micBtn = $('micBtn');
const chatStatus = $('chatStatus');
const chatStatusText = $('chatStatusText');

const history = [{ role: 'system', content: SYSTEM_PROMPT }];
let busy = false;

function setStatus(state, text) {
  chatStatus.dataset.state = state;
  chatStatusText.textContent = text;
}

// Builds a message bubble and returns its live text node — updated via
// .data (never innerHTML), since replies come from a remote model.
function addMessage(role, text) {
  const el = document.createElement('div');
  el.className = 'msg ' + (role === 'user' ? 'msg--user' : 'msg--ai');
  const textNode = document.createTextNode(text);
  el.appendChild(textNode);
  chatLog.appendChild(el);
  chatLog.scrollTop = chatLog.scrollHeight;
  return { el, textNode };
}

/* ------------------------------ voices ------------------------------ */

let voices = [];
function loadVoices() {
  voices = 'speechSynthesis' in window ? window.speechSynthesis.getVoices() : [];
}
if ('speechSynthesis' in window) {
  loadVoices();
  window.speechSynthesis.onvoiceschanged = loadVoices;
}

function pickVoice(langPrefix) {
  const pool = voices.filter((v) => v.lang && v.lang.toLowerCase().startsWith(langPrefix));
  const preferred = pool.find((v) => /google|natural|online/i.test(v.name)) || pool[0];
  return preferred || voices[0] || null;
}

function detectLang(text) {
  return /[а-яё]/i.test(text) ? 'ru' : 'en';
}

/* ------------------------------ speak -------------------------------- *
 * Reveals `text` word-by-word via onProgress, timed to speechSynthesis's
 * own boundary events, and pings window.Fluctlight.pulse() on each word
 * so the orb keeps rhythm with the voice. Some engines never fire
 * `boundary` (notably some mobile ones) — a slow fallback pulse keeps the
 * orb alive in that case, and onProgress still gets the full text at end.
 * ------------------------------------------------------------------- */
function speak(text, onProgress) {
  return new Promise((resolve) => {
    if (!('speechSynthesis' in window)) {
      window.Fluctlight?.setThinking(false);
      onProgress?.(text);
      resolve();
      return;
    }
    window.speechSynthesis.cancel();

    const utter = new SpeechSynthesisUtterance(text);
    const lang = detectLang(text);
    const voice = pickVoice(lang);
    if (voice) utter.voice = voice;
    utter.lang = voice ? voice.lang : lang === 'ru' ? 'ru-RU' : 'en-US';
    utter.rate = 1.0;
    utter.pitch = 1.03;
    utter.volume = 1;

    let boundaryFired = false;

    utter.onstart = () => {
      setStatus('speaking', 'Говорит…');
      window.Fluctlight?.setThinking(false);
      window.Fluctlight?.setSpeaking(true);
    };
    utter.onboundary = (e) => {
      boundaryFired = true;
      const idx = Math.min(text.length, (e.charIndex || 0) + (e.charLength || 1));
      onProgress?.(text.slice(0, idx));
      window.Fluctlight?.pulse(0.5);
    };
    const finish = () => {
      clearInterval(fallback);
      onProgress?.(text);
      window.Fluctlight?.setSpeaking(false);
      setStatus('idle', 'Спросите что-нибудь');
      resolve();
    };
    utter.onend = finish;
    utter.onerror = finish;

    // gentle pulse loop for engines that don't emit boundary events
    const fallback = setInterval(() => {
      if (!window.speechSynthesis.speaking) { clearInterval(fallback); return; }
      if (!boundaryFired) window.Fluctlight?.pulse(0.28);
    }, 260);

    window.speechSynthesis.speak(utter);
  });
}

/* ------------------------------ AI call ------------------------------ */

/* --------------------------- reply sanitising -------------------------- *
 * `nemotron-3-nano` is a reasoning model: by default OpenRouter can let its
 * chain-of-thought spill into `message.content` instead of keeping it in
 * the separate `message.reasoning` field (this is what caused replies like
 * "Хорошо, пользователь ответил..." to appear instead of a real answer).
 * Two layers of defence:
 *   1. `reasoning: { exclude: true }` in the request — ask OpenRouter/the
 *      model to drop the thinking tokens server-side.
 *   2. A local cleanup pass, in case a leak slips through anyway — strips
 *      <think>/<thinking> blocks and any inline emoji the model added
 *      despite being told not to (emoji look fine in a text chat, but
 *      they're meaningless once spoken aloud).
 * ------------------------------------------------------------------- */
const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F1E6}-\u{1F1FF}]/gu;

function sanitizeReply(text) {
  if (!text) return text;
  let out = text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
    .replace(EMOJI_RE, '')
    .trim();
  return out;
}

async function askAI(userText) {
  history.push({ role: 'user', content: userText });
  setStatus('thinking', 'Думает…');
  window.Fluctlight?.setThinking(true);

  const { el: aiEl, textNode } = addMessage('ai', '');
  const cursor = document.createElement('span');
  cursor.className = 'cursor';
  aiEl.appendChild(cursor);

  try {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
        'HTTP-Referer': location.href,
        'X-Title': 'Fluctlight',
      },
      body: JSON.stringify({
        model: MODEL,
        messages: history,
        max_tokens: 260,
        temperature: 0.8,
        // keep the model's chain-of-thought out of `content` entirely
        reasoning: { exclude: true },
      }),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);

    const data = await res.json();
    const reply = sanitizeReply(data?.choices?.[0]?.message?.content?.trim());
    if (!reply) throw new Error('empty reply');

    // history keeps the clean reply too, so a leaked-reasoning turn never
    // pollutes the model's own context for follow-up messages
    history.push({ role: 'assistant', content: reply });

    await speak(reply, (partial) => {
      textNode.data = partial;
      chatLog.scrollTop = chatLog.scrollHeight;
    });
  } catch (err) {
    console.error('Fluctlight AI error:', err);
    textNode.data = 'Не получилось получить ответ. Проверьте связь и попробуйте ещё раз.';
    setStatus('idle', 'Спросите что-нибудь');
    window.Fluctlight?.setThinking(false);
  } finally {
    cursor.remove();
  }
}

/* ------------------------------ send flow ----------------------------- */

async function submitMessage(text) {
  text = text.trim();
  if (!text || busy) return;
  busy = true;
  chatInput.value = '';
  addMessage('user', text);
  await askAI(text);
  busy = false;
}

chatForm.addEventListener('submit', (e) => {
  e.preventDefault();
  submitMessage(chatInput.value);
});

/* ------------------------------ voice input --------------------------- */

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognition = null;
let listening = false;

if (SR) {
  recognition = new SR();
  recognition.continuous = false;
  recognition.interimResults = true;
  recognition.lang = 'ru-RU';

  recognition.onstart = () => {
    listening = true;
    micBtn.setAttribute('aria-pressed', 'true');
    setStatus('listening', 'Слушаю…');
    window.Fluctlight?.setListening(true);
  };

  recognition.onresult = (e) => {
    let interim = '', final = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const t = e.results[i][0].transcript;
      if (e.results[i].isFinal) final += t;
      else interim += t;
    }
    chatInput.value = (final + interim).trim();
    if (final.trim()) {
      recognition.stop();
      submitMessage(final);
    }
  };

  const stopListening = () => {
    listening = false;
    micBtn.setAttribute('aria-pressed', 'false');
    window.Fluctlight?.setListening(false);
    if (!busy) setStatus('idle', 'Спросите что-нибудь');
  };
  recognition.onend = stopListening;
  recognition.onerror = stopListening;

  micBtn.addEventListener('click', () => {
    if (busy) return;
    if (listening) { recognition.stop(); return; }
    window.speechSynthesis?.cancel();
    chatInput.value = '';
    try { recognition.start(); } catch (_) { /* already running */ }
  });
} else {
  micBtn.disabled = true;
  micBtn.title = 'Голосовой ввод не поддерживается этим браузером (нужен Chrome/Edge)';
}
