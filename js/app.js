/* App bootstrap: starts initial render/load after all split files are loaded. */
(function bootstrap() {
  const todayStr = new Date().toISOString().split('T')[0];
  const dateInput = document.getElementById('dateInput');
  if (dateInput) dateInput.value = todayStr;
  currentDate = todayStr;

  renderDateStrip(todayStr);
  if (typeof loadFinalizedMap === 'function') {
    loadFinalizedMap().then(() => renderDateStrip(currentDate));
  }

  document.querySelectorAll('.modal-overlay').forEach(m => m.classList.remove('open'));
  loadRecipes().then(() => loadDay());
})();
