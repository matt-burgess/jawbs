// Jawbridge — every chart on one screen. Wraps the shared chart module,
// passes the full CHARTS list as the "selected" set, and offers the same
// archive-stale callback as the Jawboard so Lines-in-Water works the same.
import { renderDashboardCharts, CHARTS, defaultLinks } from '../archive/dashboardCharts.js';
import { els, send } from '../lib/pageBoot.js';

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
