'use strict';

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

function formatDuration(ms) {
  const seconds = Math.round(ms / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/** Fields of a certificate that are safe to show anyone holding the link. */
function publicCertificate(certificate, url) {
  return {
    id: certificate.id,
    url,
    createdAt: certificate.createdAt,
    pageUrl: certificate.pageUrl,
    consent: certificate.consent,
    lead: { phoneLast4: certificate.lead.phoneLast4 },
    recording: {
      sha256: certificate.recording.sha256,
      bytes: certificate.recording.bytes,
      eventCount: certificate.recording.eventCount,
      durationMs: certificate.recording.durationMs,
    },
  };
}

function row(label, value) {
  return `<tr><th>${escapeHtml(label)}</th><td>${value}</td></tr>`;
}

function certificatePage(certificate, nonce) {
  const c = certificate;
  const checkbox = { true: '✅ Checked', false: '❌ Not checked', null: '—' }[String(c.consent.checkboxChecked)];
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Consent certificate ${escapeHtml(c.id)}</title>
<link rel="stylesheet" href="/vendor/rrweb-player.css">
<style nonce="${nonce}">
  :root { --ink:#1f2328; --muted:#59636e; --line:#d1d9e0; --bg:#f6f8fa; --ok:#1a7f37; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; color: var(--ink); background: var(--bg); }
  main { max-width: 1100px; margin: 0 auto; padding: 24px 16px 48px; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  .sub { color: var(--muted); margin: 0 0 20px; }
  .card { background: #fff; border: 1px solid var(--line); border-radius: 12px; padding: 16px 20px; margin-bottom: 16px; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; vertical-align: top; padding: 8px 0; border-bottom: 1px solid var(--line); }
  th { width: 200px; color: var(--muted); font-weight: 600; }
  tr:last-child th, tr:last-child td { border-bottom: 0; }
  code { font-size: 13px; word-break: break-all; }
  blockquote { margin: 0; padding: 10px 14px; background: var(--bg); border-left: 3px solid var(--line); border-radius: 6px; }
  .ok { color: var(--ok); font-weight: 600; }
  #player { display: flex; justify-content: center; min-height: 200px; color: var(--muted); }
  @media (max-width: 640px) { th { width: 120px; } }
</style>
</head>
<body>
<main>
  <h1>Consent certificate</h1>
  <p class="sub">Certificate <code>${escapeHtml(c.id)}</code> · recorded ${escapeHtml(new Date(c.createdAt).toUTCString())}</p>

  <section class="card">
    <table>
      ${row('Page', `<a href="${escapeHtml(c.pageUrl)}" rel="noopener noreferrer nofollow">${escapeHtml(c.pageUrl)}</a>`)}
      ${row('Consent text shown', c.consent.text ? `<blockquote>${escapeHtml(c.consent.text)}</blockquote>` : '—')}
      ${row('Consent checkbox', escapeHtml(checkbox))}
      ${row('Phone', c.lead.phoneLast4 ? `•••-•••-${escapeHtml(c.lead.phoneLast4)}` : '—')}
      ${row('Session length', escapeHtml(formatDuration(c.recording.durationMs)))}
      ${row('Recording SHA-256', `<code>${escapeHtml(c.recording.sha256)}</code> <span class="ok" id="integrity"></span>`)}
    </table>
  </section>

  <section class="card">
    <div id="player">Loading recording…</div>
  </section>
</main>
<script src="/vendor/rrweb-player.min.js"></script>
<script nonce="${nonce}">
(async function () {
  const el = document.getElementById('player');
  try {
    const res = await fetch(${JSON.stringify(`/c/${c.id}/recording`)});
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const events = await res.json();
    document.getElementById('integrity').textContent = '✓ verified by the server';
    el.textContent = '';
    const Player = window.rrwebPlayer.default || window.rrwebPlayer;
    new Player({ target: el, props: { events, width: Math.min(1024, el.clientWidth || 1024), autoPlay: false } });
  } catch (err) {
    el.textContent = 'The recording could not be loaded.';
  }
})();
</script>
</body>
</html>`;
}

function notFoundPage() {
  return '<!doctype html><meta charset="utf-8"><meta name="robots" content="noindex"><title>Not found</title><h1>Certificate not found</h1>';
}

module.exports = { certificatePage, notFoundPage, publicCertificate, escapeHtml };
