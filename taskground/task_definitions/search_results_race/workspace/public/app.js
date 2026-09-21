const input = document.querySelector('#search');
const status = document.querySelector('#status');
const results = document.querySelector('#results');

function render(items) {
  results.replaceChildren(...items.map(item => {
    const card = document.createElement('li');
    const category = document.createElement('small');
    category.textContent = item.category;
    const title = document.createElement('strong');
    title.textContent = item.name;
    card.append(category, title);
    return card;
  }));
}

async function search() {
  const query = input.value.trim();
  if (!query) {
    render([]);
    status.textContent = 'Start typing to explore the library.';
    return;
  }
  render([]);
  status.textContent = 'Searching…';
  try {
    const response = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
    if (!response.ok) throw new Error('Search unavailable');
    const { items } = await response.json();
    render(items);
    status.textContent = items.length ? `${items.length} results for “${query}”` : `No results for “${query}”`;
  } catch (error) {
    render([]);
    status.textContent = 'Search unavailable. Please try again.';
  }
}

input.addEventListener('input', search);
document.querySelector('#clear').addEventListener('click', () => {
  input.value = '';
  input.focus();
  search();
});
