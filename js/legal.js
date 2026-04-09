(function () {
  // Theme loader - runs immediately to prevent flash
  const savedTheme = localStorage.getItem('anvi-theme') || 'dark';
  document.documentElement.setAttribute('data-theme', savedTheme);

  // Theme toggle - runs after DOM is ready
  document.addEventListener('DOMContentLoaded', function () {
    const btn = document.getElementById('theme-toggle-btn');
    if (btn) {
      btn.addEventListener('click', function () {
        const current = document.documentElement.getAttribute('data-theme') || 'light';
        const next = current === 'light' ? 'dark' : 'light';
        document.documentElement.setAttribute('data-theme', next);
        localStorage.setItem('anvi-theme', next);
      });
    }
  });
})();
