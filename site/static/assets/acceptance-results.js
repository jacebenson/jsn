(() => {
  function initialize() {
    document.querySelectorAll('[data-sortable-checks]').forEach((table) => {
      if (table.dataset.sortInitialized) return;
      table.dataset.sortInitialized = 'true';
      const body = table.tBodies[0];
      const originalOrder = new Map(Array.from(body.rows, (row, index) => [row, index]));
      table.querySelectorAll('button[data-sort-key]').forEach((button) => {
        button.addEventListener('click', () => {
          const heading = button.closest('th');
          const direction = heading.getAttribute('aria-sort') === 'ascending' ? 'descending' : 'ascending';
          const key = button.dataset.sortKey;
          const rows = Array.from(body.rows);
          rows.sort((a, b) => {
            const left = a.dataset[key];
            const right = b.dataset[key];
            const comparison = key === 'duration' ? Number(left) - Number(right) : left.localeCompare(right, 'en');
            return (direction === 'ascending' ? comparison : -comparison) || originalOrder.get(a) - originalOrder.get(b);
          });
          rows.forEach((row) => body.appendChild(row));
          table.querySelectorAll('th').forEach((header) => {
            header.setAttribute('aria-sort', header === heading ? direction : 'none');
            header.querySelector('[data-sort-indicator]').textContent = header === heading ? (direction === 'ascending' ? ' ↑' : ' ↓') : ' ↕';
          });
        });
      });
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize);
  else initialize();
})();
