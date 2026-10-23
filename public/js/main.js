import { startHost } from './host.js';
import { startPlayer } from './player.js';
import { $ } from './ui.js';

const SECRET_KEY = 'tiletop-host-secret';
const normalize = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const isCode = (s) => /^[A-HJ-NP-Z2-9]{6}$/.test(s);

function savedSecret() {
  try {
    return localStorage.getItem(SECRET_KEY);
  } catch {
    return null;
  }
}

async function host(secret) {
  const btn = $('#hostForm button');
  btn.disabled = true;
  $('#hostError').textContent = '';
  try {
    await startHost(secret);
    try {
      localStorage.setItem(SECRET_KEY, secret);
    } catch {}
  } catch (e) {
    if (e.status === 401) {
      try {
        localStorage.removeItem(SECRET_KEY);
      } catch {}
    }
    $('#home').hidden = false;
    $('#table').hidden = true;
    $('#hostDetails').open = true;
    $('#hostError').textContent = e.message;
  } finally {
    btn.disabled = false;
  }
}

function init() {
  const fromUrl = normalize(location.hash.slice(1) || new URLSearchParams(location.search).get('join'));
  if (isCode(fromUrl)) return startPlayer(fromUrl);

  // The game master reloaded during a session: go straight back to it.
  if (sessionStorage.getItem('tiletop-host-session') && savedSecret()) return host(savedSecret());

  $('#home').hidden = false;
  $('#code').addEventListener('input', (e) => (e.target.value = normalize(e.target.value).slice(0, 6)));
  $('#joinForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const code = normalize($('#code').value);
    if (!isCode(code)) {
      $('#joinError').textContent = 'Codes have 6 letters and digits, e.g. K7RX2M.';
      return;
    }
    history.replaceState(null, '', '#' + code); // a reload rejoins the same game
    startPlayer(code);
  });

  if (savedSecret()) $('#secret').value = savedSecret();
  $('#hostForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const secret = $('#secret').value;
    if (secret) host(secret);
  });
}

init();
