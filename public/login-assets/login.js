(() => {
  const root = document.documentElement;
  const theme = document.querySelector('[data-theme-toggle]');
  const form = document.getElementById('login-form');
  const username = document.getElementById('username');
  const password = document.getElementById('password');
  const reveal = document.getElementById('password-toggle');
  const submit = document.getElementById('login-submit');
  const error = document.getElementById('login-error');
  const caps = document.getElementById('caps-lock');
  const params = new URLSearchParams(location.search);

  function safeDestination(value) {
    if (!value || !value.startsWith('/') || value.startsWith('//') || /[\\\u0000-\u001f\u007f]/.test(value)) return '/';
    try {
      const decoded = decodeURIComponent(value);
      if (decoded.startsWith('//') || /[\\\u0000-\u001f\u007f]/.test(decoded)) return '/';
      const url = new URL(value, location.origin);
      if (url.origin !== location.origin || /^\/(login|auth)(\/|$)/.test(url.pathname)) return '/';
      return url.pathname + url.search + url.hash;
    } catch { return '/'; }
  }
  const next = safeDestination(params.get('next'));
  function updateTheme() {
    theme?.setAttribute('aria-label', `切换到${root.dataset.theme === 'dark' ? '浅' : '深'}色主题`);
  }
  updateTheme();
  theme?.addEventListener('click', () => {
    root.dataset.theme = root.dataset.theme === 'dark' ? 'light' : 'dark';
    try { localStorage.setItem('asher-theme', root.dataset.theme); } catch { /* The current-page theme still works. */ }
    updateTheme();
  });
  reveal?.addEventListener('click', () => {
    const visible = password.type === 'password';
    password.type = visible ? 'text' : 'password';
    reveal.setAttribute('aria-label', visible ? '隐藏密码' : '显示密码');
    reveal.setAttribute('aria-pressed', String(visible));
  });
  password?.addEventListener('keyup', event => { caps.hidden = !event.getModifierState('CapsLock'); });
  password?.addEventListener('blur', () => { caps.hidden = true; });
  if (params.get('reason') === 'logout') document.getElementById('session-message').hidden = false;

  function showError(message, invalid = false) {
    error.textContent = message;
    error.hidden = false;
    username.setAttribute('aria-invalid', String(invalid));
    password.setAttribute('aria-invalid', String(invalid));
  }
  form?.addEventListener('submit', async event => {
    event.preventDefault();
    if (submit.disabled) return;
    error.hidden = true;
    if (!username.value.trim() || !password.value) {
      showError('请输入账号和密码。');
      (!username.value.trim() ? username : password).focus();
      return;
    }
    username.removeAttribute('aria-invalid');
    password.removeAttribute('aria-invalid');
    submit.disabled = true;
    submit.classList.add('is-loading');
    submit.querySelector('.submit-label').textContent = '正在为你打开…';
    form.setAttribute('aria-busy', 'true');
    try {
      const response = await fetch('/auth/login', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username.value.trim(), password: password.value, remember: document.getElementById('remember').checked, next }),
        signal: AbortSignal.timeout(15000),
      });
      const result = await response.json();
      if (response.ok && result.ok === true) {
        password.value = '';
        location.replace(safeDestination(result.redirect || next));
        return;
      }
      if (response.status === 429) showError('尝试次数过多，请稍后再试。');
      else if (response.status === 401) showError('账号或密码不正确，请重新输入。', true);
      else showError('暂时无法登录，请稍后重试。');
    } catch { showError('暂时无法连接，请检查网络后重试。'); }
    finally {
      submit.disabled = false;
      submit.classList.remove('is-loading');
      submit.querySelector('.submit-label').textContent = '进入知识空间';
      form.removeAttribute('aria-busy');
    }
  });
  // A returning session skips the form. Static preview has no auth endpoint.
  void fetch('/auth/session', { credentials: 'same-origin', signal: AbortSignal.timeout(5000) })
    .then(response => response.ok && response.headers.get('content-type')?.includes('application/json') ? response.json() : null)
    .then(session => { if (session?.authenticated === true) location.replace(next); })
    .catch(() => { /* Connection errors leave the login form fully available. */ });
})();
