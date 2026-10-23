// A player's device: join with the code and become one screen of the table.
import { join, transport, sleep } from './net.js';
import { Screen } from './screen.js';
import { $, showOverlay, hideOverlay, getDeviceId, deviceInfo, keepAwake, setupHud, updateToolbar } from './ui.js';

export async function startPlayer(code) {
  $('#home').hidden = true;
  const canvas = $('#table');
  canvas.hidden = false;
  const deviceId = getDeviceId();
  let link = null;
  const screen = new Screen(canvas, (m) => link?.send(m));
  screen.onMode = () => updateToolbar(screen, null);
  setupHud(null);
  keepAwake();

  const leave = () => {
    location.href = '/';
  };
  let failures = 0;
  for (;;) {
    try {
      showOverlay(failures ? 'Reconnecting…' : 'Joining game ' + code + '…', { actions: [['Cancel', leave]] });
      const { pc, dc } = await join(code, (msg) => showOverlay(msg, { actions: [['Cancel', leave]] }));
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
      link.close();
      link = null;
    } catch (e) {
      failures++;
      if (e.status === 404 || e.status === 400) {
        showOverlay(e.message, { spinner: false, actions: [['Back', leave]] });
        return;
      }
      const why = e.status === 403 ? 'The lobby is closed. Ask the game master to open it.' : e.message;
      showOverlay(why + ' Trying again…', { actions: [['Cancel', leave]] });
      await sleep(Math.min(3000 * failures, 15000));
    }
  }
}
