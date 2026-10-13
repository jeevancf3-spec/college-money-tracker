const form = document.getElementById('loginForm');
const errorMessage = document.getElementById('errorMessage');
const submitButton = document.getElementById('submitButton');

fetch('/api/auth/me').then(response => response.json()).then(result => {
  if (result.authenticated) window.location.replace('/');
}).catch(() => {});

form.addEventListener('submit', async event => {
  event.preventDefault();
  errorMessage.style.display = 'none';
  submitButton.disabled = true;
  submitButton.textContent = 'Signing in…';
  try {
    const response = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: document.getElementById('username').value.trim(),
        password: document.getElementById('password').value
      })
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || 'Unable to sign in. Please try again.');
    window.location.replace('/');
  } catch (error) {
    errorMessage.textContent = error.message || 'Unable to sign in. Please try again.';
    errorMessage.style.display = 'block';
    submitButton.disabled = false;
    submitButton.textContent = 'Log in →';
  }
});
