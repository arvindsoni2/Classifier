// Login handler (served as same-origin script under the self-only CSP).
// The token is posted as JSON and never appears in a URL; if scripting is
// unavailable the form falls back to POST with form encoding (415), never
// a GET that would leak the token into the address bar.
document.getElementById('login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const token = document.getElementById('token').value;
  let ok = false;
  try {
    const response = await fetch('/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
      credentials: 'same-origin',
    });
    ok = response.ok || response.status === 302;
  } catch {
    ok = false;
  }
  if (ok) {
    window.location.assign('/app/');
    return;
  }
  document.getElementById('login-error').hidden = false;
});
