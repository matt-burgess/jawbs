// Jawbridge — every chart on one screen. Wraps the shared chart module,
// passes the full CHARTS list as the "selected" set, and offers the same
// archive-stale callback as the Jawboard so Lines-in-Water works the same.
import { renderDashboardCharts, CHARTS, defaultLinks } from '../archive/dashboardCharts.js';

const $ = (id) => document.getElementById(id);
const els = new Proxy({}, { get: (_, id) => $(id) });

async function send(type, payload = {}) {
  const response = await chrome.runtime.sendMessage({ type, ...payload });
  if (!response) throw new Error('No response from service worker');
  if (!response.ok) throw new Error(response.error || 'Unknown error');
  return response;
}

async function load() {
  els.bridgeStatus.textContent = 'Loading…';
  try {
    const r = await send('list-jobs');
    const jobs = r.data || [];
    els.bridgeCount.textContent = `${jobs.length} job${jobs.length === 1 ? '' : 's'}`;
    if (!jobs.length) {
      els.bridgeDashboard.hidden = true;
      els.bridgeEmpty.hidden = false;
      els.bridgeStatus.textContent = '';
      return;
    }
    els.bridgeEmpty.hidden = true;
    els.bridgeDashboard.hidden = false;
    renderDashboardCharts(els.bridgeDashboard, jobs, {
      selectedIds: CHARTS.map((c) => c.id),
      onArchiveStale: async (jobIds) => {
        for (const id of jobIds) {
          await send('update-job-status', {
            jobId: id, status: 'notMovingForward',
            note: 'Auto-archived from stale-aging chart (Jawbridge)',
          });
        }
        await load();
      },
      links: defaultLinks(),
    });
    els.bridgeStatus.textContent = '';
  } catch (e) {
    els.bridgeStatus.textContent = `Load failed: ${e.message}`;
  }
}

load();
