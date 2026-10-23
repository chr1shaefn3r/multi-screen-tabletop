// A player's device: join with the code and become one screen of the table.
import { join, transport, sleep } from './net.js';
import { Screen } from './screen.js';
import { log, logError, showDetails } from './diag.js';
import { $, formatCode, showOverlay, hideOverlay, getDeviceId, deviceInfo, keepAwake, guardAgainstBack, setupHud, updateToolbar } from './ui.js';

export async function startPlayer(code) {
  $('#home').hidden = true;
  const canvas = $('#table');
  canvas.hidden = false;
  const deviceId = getDeviceId();
  let link = null;
  const screen = new Screen(canvas, (m) => link?.send(m));
  screen.onMode = () => updateToolbar(screen, null);
  setupHud(null, showDetails);
  keepAwake();
  guardAgainstBack((text) => {
    log(text);
    screen.toast = { text, until: performance.now() + 5000 };
    screen.dirty = true;
  });

  const leave = () => {
    location.href = '/';
  };
  const actions = [['Connection details', showDetails], ['Cancel', leave]];
  let failures = 0;
  for (;;) {
    try {
      showOverlay(failures ? 'Reconnecting…' : 'Joining game ' + formatCode(code) + '…', { actions });
      const { pc, dc } = await join(code, (msg) => showOverlay(msg, { actions }));
      failures = 0;
      link = transport(dc, pc);
      const closed = new Promise((resolve) => {
        dc.addEventListener('close', resolve);
        pc.addEventListener('connectionstatechange', () => ['failed', 'closed'].includes(pc.connectionState) && resolve());
      });
      dc.addEventListener('message', (e) => {
        try {
          screen.receive(JSON.parse(e.data));
        } catch (err) {
          console.warn(err);
        }
      });
      link.send({ t: 'hello', deviceId, ...deviceInfo() });
      hideOverlay();
      await closed;
      log('Connection to the game master lost, reconnecting');
      link.close();
      link = null;
    } catch (e) {
      failures++;
      if (e.status === 404 || e.status === 400) {
        logError(e.message);
        showOverlay(e.message, { spinner: false, actions: [['Connection details', showDetails], ['Back', leave]] });
        return;
      }
      const why = e.status === 403 ? 'The lobby is closed. Ask the game master to open it.' : e.message;
      const wait = Math.min(3000 * failures, 15000);
      logError(`Attempt ${failures} failed: ${why} Trying again in ${wait / 1000}s`);
      showOverlay(`${why} Trying again in ${wait / 1000}s…`, { actions });
      await sleep(wait);
    }
  }
}
