const state = { person: null, category: null, ingredient: "", recipes: [] };
const labels = { emilka: "Emilka", kasia: "Kasia", sniadanie: "Śniadanie", obiad: "Obiad", kolacja_przekaska: "Kolacja / Przekąska" };

const show = (name) => {
  document.querySelectorAll(".screen").forEach((screen) => screen.classList.add("hidden"));
  document.getElementById(`${name}-screen`).classList.remove("hidden");
};

async function loadRecipes() {
  try {
    const response = await fetch("recipes-test.json");
    if (!response.ok) throw new Error("Nie udało się pobrać danych");
    state.recipes = (await response.json()).recipes;
  } catch (error) {
    document.getElementById("recipe-list").innerHTML = '<p class="empty">Nie udało się wczytać bazy testowej.</p>';
  }
}

function filteredRecipes() {
  const phrase = state.ingredient.trim().toLocaleLowerCase("pl");
  return state.recipes.filter((recipe) => {
    const categoryMatches = recipe.category === state.category;
    const ingredientMatches = !phrase || [recipe.title, recipe.titlePl, ...recipe.ingredients].filter(Boolean).join(" ").toLocaleLowerCase("pl").includes(phrase);
    return categoryMatches && ingredientMatches;
  });
}

function renderResults() {
  const recipes = filteredRecipes();
  const term = state.ingredient ? ` · ${state.ingredient}` : "";
  document.getElementById("result-summary").textContent = `${labels[state.person]} · ${labels[state.category]}${term} · ${recipes.length} wyników`;
  const list = document.getElementById("recipe-list");
  if (!recipes.length) {
    list.innerHTML = '<p class="empty">Brak pasujących przepisów w obecnej bazie testowej.</p>';
    return;
  }
  list.innerHTML = recipes.map((recipe) => `
    <a class="recipe" href="${recipe.source.url}" target="_blank" rel="noopener noreferrer">
      <h2>${recipe.titlePl || recipe.title}</h2>
      <div class="recipe-meta"><span class="tag">${recipe.source.publisher}</span>${recipe.timeMinutes ? `<span>${recipe.timeMinutes} min</span>` : ""}</div>
      <p class="status">Do sprawdzenia przez reguły diety · otwórz źródło ↗</p>
    </a>`).join("");
}

document.querySelectorAll("[data-person]").forEach((button) => button.addEventListener("click", () => {
  state.person = button.dataset.person;
  state.category = null;
  document.getElementById("search-title").textContent = labels[state.person];
  document.querySelectorAll(".category").forEach((item) => item.classList.remove("selected"));
  document.getElementById("show-results").disabled = true;
  show("search");
}));

document.querySelectorAll(".category").forEach((button) => button.addEventListener("click", () => {
  state.category = button.dataset.category;
  document.querySelectorAll(".category").forEach((item) => item.classList.toggle("selected", item === button));
  document.getElementById("show-results").disabled = false;
}));

document.getElementById("ingredient").addEventListener("input", (event) => { state.ingredient = event.target.value; });
document.getElementById("show-results").addEventListener("click", () => { renderResults(); show("results"); });
document.querySelectorAll("[data-back]").forEach((button) => button.addEventListener("click", () => show(button.dataset.back)));
loadRecipes();
