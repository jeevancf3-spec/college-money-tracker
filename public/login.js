const form = document.getElementById('loginForm');
const errorMessage = document.getElementById('errorMessage');
const submitButton = document.getElementById('submitButton');
const signupForm = document.getElementById('signupForm');
const signupError = document.getElementById('signupError');
const signupButton = document.getElementById('signupButton');

fetch('/api/auth/me').then(response => response.json()).then(result => {
  if (result.authenticated) window.location.replace('/');
}).catch(() => {});

document.getElementById('showSignup').addEventListener('click', () => {
  form.hidden = true;
  signupForm.hidden = false;
  document.getElementById('newUsername').focus();
});
document.getElementById('showLogin').addEventListener('click', () => {
  signupForm.hidden = true;
  form.hidden = false;
  document.getElementById('username').focus();
});

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
    submitButton.innerHTML = 'Log in <span aria-hidden="true">→</span>';
  }
});

signupForm.addEventListener('submit', async event => {
  event.preventDefault();
  signupError.style.display = 'none';
  const username = document.getElementById('newUsername').value.trim();
  const password = document.getElementById('newPassword').value;
  const confirmation = document.getElementById('confirmPassword').value;
  if (password !== confirmation) {
    signupError.textContent = 'The passwords do not match.';
    signupError.style.display = 'block';
    return;
  }
  signupButton.disabled = true;
  signupButton.textContent = 'Creating account…';
  try {
    const response = await fetch('/api/auth/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || 'Unable to create account. Please try again.');
    window.location.replace('/');
  } catch (error) {
    signupError.textContent = error.message || 'Unable to create account. Please try again.';
    signupError.style.display = 'block';
    signupButton.disabled = false;
    signupButton.innerHTML = 'Create account <span aria-hidden="true">→</span>';
  }
});
