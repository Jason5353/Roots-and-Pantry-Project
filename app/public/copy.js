// Copy-to-clipboard buttons: <button data-copy="textarea-id">. Falls back to selecting the text.
document.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-copy]');
  if (!btn) return;
  const box = document.getElementById(btn.dataset.copy);
  const done = btn.parentElement.querySelector('[data-copied]');
  try { await navigator.clipboard.writeText(box.value); } catch { box.select(); document.execCommand('copy'); }
  if (done) { done.hidden = false; setTimeout(() => { done.hidden = true; }, 3000); }
});
