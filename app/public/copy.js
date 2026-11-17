// Copy-to-clipboard buttons: <button data-copy="textarea-id">. If a <template id="textarea-id-html"> exists,
// the HTML version is copied too, so email programs keep its formatting. Falls back to selecting the text.
document.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-copy]');
  if (!btn) return;
  const box = document.getElementById(btn.dataset.copy);
  const rich = document.getElementById(`${btn.dataset.copy}-html`);
  const done = btn.parentElement.querySelector('[data-copied]');
  try {
    if (rich && window.ClipboardItem) {
      await navigator.clipboard.write([new ClipboardItem({
        'text/html': new Blob([rich.innerHTML], { type: 'text/html' }),
        'text/plain': new Blob([box.value], { type: 'text/plain' }),
      })]);
    } else await navigator.clipboard.writeText(box.value);
  } catch { box.select(); document.execCommand('copy'); }
  if (done) { done.hidden = false; setTimeout(() => { done.hidden = true; }, 3000); }
});
