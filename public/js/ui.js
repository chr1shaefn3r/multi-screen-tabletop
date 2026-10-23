// Small DOM helpers shared by the host and player pages.

export const $ = (s, root = document) => root.querySelector(s);

// Game codes are 8 digits, shown in two groups: 48152342 -> 4815 2342
export const formatCode = (s) => String(s).replace(/^(\d{4})(\d)/, '$1 $2');

export function h(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'class') e.className = v;
    else if (v === true) e.setAttribute(k, '');
    else if (v !== false && v != null) e.setAttribute(k, v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) e.append(k instanceof Node ? k : String(k));
  return e;
}

export function showOverlay(msg, { spinner = true, actions = [] } = {}) {
  $('#overlay').hidden = false;
  $('#overlayMsg').textContent = msg;
  $('#overlay .spinner').hidden = !spinner;
  $('#overlayActions').replaceChildren(...actions.map(([label, fn]) => h('button', { onclick: fn }, label)));
}

export function hideOverlay() {
  $('#overlay').hidden = true;
}

export function getDeviceId() {
  let id = null;
  try {
    id = localStorage.getItem('tiletop-device');
  } catch {}
  if (!id) {
    id = Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, '0')).join('');
    try {
      localStorage.setItem('tiletop-device', id);
    } catch {}
  }
  return id;
}

// Name plus a first guess of the screen's pixel density (CSS px per mm).
// The guess is fine-tuned in the align step.
export function deviceInfo() {
  const ua = navigator.userAgent;
  const iPad = /iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  const name = iPad ? 'iPad' : /iPhone/.test(ua) ? 'iPhone' : /Android/.test(ua) ? (/Mobile/.test(ua) ? 'Android phone' : 'Android tablet') : 'Computer';
  const cssPpi = iPad ? 132 : name === 'Computer' ? 96 : 160;
  return { name, scale: cssPpi / 25.4, w: innerWidth, h: innerHeight };
}

let wantFullscreen = false; // the user switched fullscreen on and hasn't switched it off
const isFullscreen = () => !!(document.fullscreenElement || document.webkitFullscreenElement);

function enterFullscreen() {
  const el = document.documentElement;
  const fn = el.requestFullscreen || el.webkitRequestFullscreen;
  if (fn) Promise.resolve(fn.call(el)).catch(() => {});
  return !!fn;
}

export function toggleFullscreen() {
  const d = document;
  if (isFullscreen()) {
    wantFullscreen = false;
    return (d.exitFullscreen || d.webkitExitFullscreen).call(d);
  }
  wantFullscreen = true;
  if (!enterFullscreen()) {
    wantFullscreen = false;
    alert('Fullscreen is not available in this browser.\n\nOn iPhone: tap Share → "Add to Home Screen" and open Tiletop from there.');
  }
}

// A swipe from one phone onto the next enters the second screen at its edge, which phones
// with gesture navigation take as the system "back" gesture. Websites can't turn that off,
// so make it harmless: keep an extra history entry so "back" stays on the page, and bring
// fullscreen back with the next tap (browsers only allow entering fullscreen on a tap).
// `notify(text)` shows what happened.
export function guardAgainstBack(notify) {
  const tip = 'Tip: Android\'s 3-button navigation (or a lower back sensitivity) avoids this.';
  history.pushState({ tiletop: true }, '');
  addEventListener('popstate', () => {
    history.pushState({ tiletop: true }, '');
    notify(`The phone's back gesture was triggered, staying in the game. ${tip}`);
  });
  const onChange = () => {
    if (!isFullscreen() && wantFullscreen) notify(`The back gesture closed fullscreen. Tap the screen to return to it. ${tip}`);
  };
  document.addEventListener('fullscreenchange', onChange);
  document.addEventListener('webkitfullscreenchange', onChange);
  addEventListener('pointerup', () => wantFullscreen && !isFullscreen() && enterFullscreen(), true);
}

// Keep the screen from going to sleep during a game.
export function keepAwake() {
  let lock = null;
  const request = async () => {
    if (lock || document.visibilityState !== 'visible' || !('wakeLock' in navigator)) return;
    try {
      lock = await navigator.wakeLock.request('screen');
      lock.addEventListener('release', () => (lock = null));
    } catch {}
  };
  request();
  document.addEventListener('visibilitychange', request);
  addEventListener('pointerdown', request);
}

// Corner buttons: fullscreen and connection details for everyone, settings for the game master.
export function setupHud(onSettings, onDetails) {
  const hud = $('#hud');
  const buttons = [
    h('button', { class: 'hud-btn', 'aria-label': 'Fullscreen', onclick: toggleFullscreen }, '⛶'),
    h('button', { class: 'hud-btn', 'aria-label': 'Connection details', onclick: onDetails }, 'i'),
  ];
  if (onSettings) buttons.unshift(h('button', { class: 'hud-btn', 'aria-label': 'Game master panel', onclick: onSettings }, '⚙'));
  hud.replaceChildren(...buttons);
  hud.hidden = false;
}

// Bottom bar with the buttons for the current step.
export function updateToolbar(screen, host) {
  const bar = $('#toolbar');
  const refresh = () => updateToolbar(screen, host);
  const btn = (label, fn, cls = '') =>
    h('button', { class: cls, onclick: () => { fn(); refresh(); } }, label);
  let items = [];
  if (screen.mode === 'layout' && host) {
    items = [
      btn('⟲ 90°', () => host.editor.rotate(-1)),
      btn('⟳ 90°', () => host.editor.rotate(1)),
      btn('In a row', () => host.editor.arrange()),
      btn('Done: align →', () => host.setMode('align'), 'primary'),
    ];
  } else if (screen.mode === 'align') {
    const swipe = screen.alignTool === 'swipe';
    items = [
      btn(swipe ? 'Tool: swipe' : 'Tool: drag', () => {
        screen.alignTool = swipe ? 'drag' : 'swipe';
        screen.cardMode = false;
        screen.dirty = true;
      }),
    ];
    if (!swipe) {
      items.push(
        btn(screen.allowResize ? 'Resize: on' : 'Resize: off', () => {
          screen.allowResize = !screen.allowResize;
          screen.dirty = true;
        }),
        btn(screen.cardMode ? 'Card: done' : 'Card size', () => {
          screen.cardMode = !screen.cardMode;
          screen.dirty = true;
        }),
      );
    }
    if (host) items.push(btn('Manual layout', () => host.setMode('layout')), btn('Play →', () => host.setMode('play'), 'primary'));
  }
  bar.replaceChildren(...items);
  bar.hidden = !items.length;
}
