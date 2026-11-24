import { initializeApp } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-app.js";
import { getAuth, GoogleAuthProvider, onAuthStateChanged, signInWithPopup, signOut } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-auth.js";
import { getFirestore, collection, doc, getDoc, getDocs, query, where, limit, writeBatch, setDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-firestore.js";
import { getStorage, ref, getDownloadURL, uploadBytes } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-storage.js";
import { firebaseConfig } from "./firebase-config.js";
import { recipeSeed } from "./recipe-seed.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const storage = getStorage(app);
const state = { person: null, category: null, user: null, role: null, histamineProducts: null, ingredientRules: null, rulesReturnScreen: "people", queueRecipeId: null };
const labels = { emilka: "Emilka", kasia: "Kasia", sniadanie: "Śniadanie", obiad: "Obiad", kolacja_przekaska: "Kolacja / Przekąska" };
const recipeCategoryKeys = ["sniadanie", "obiad", "kolacja_przekaska"];
const histamineSourceUrl = "https://raw.githubusercontent.com/Endriaczi/Histamina/main/script0.js";

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("service-worker.js").catch(() => {
      // Aplikacja nadal działa online, jeżeli przeglądarka nie obsługuje PWA.
    });
  });
}

const show = (screen) => document.querySelectorAll(".screen").forEach((item) => item.classList.toggle("hidden", item.id !== `${screen}-screen`));
const setLoginMessage = (text) => { document.getElementById("login-message").textContent = text; };
const normalize = (text) => text.toLocaleLowerCase("pl-PL").trim();
const foldText = (text) => (text || "").toLowerCase().normalize("NFD")
  .replace(/[\u0300-\u036f]/g, "").replace(/ł/g, "l").replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
const eggWords = ["jajko", "jajka", "jaja", "jajo", "jajek", "jajkiem", "jajem"];
const glutenTerms = ["gluten", "pszen", "zyt", "jeczm", "orkisz", "bulgur", "kuskus", "semolina"];
const caseinTerms = ["mleko", "maslo", "jogurt", "ser", "smiet", "twarog", "ricotta", "mascarpone", "kefir", "serwatka"];
const saltTerms = ["sol", "sol morska", "salt"];
const ratingLabels = { "0": "DOBRZE TOLEROWANE", "1": "UMIARKOWANA", "2": "NIEZGODNE", "3": "BARDZO ŹLE", "?": "BRAK DANYCH" };
const ruleStatusLabels = { allowed: "Dopuszczony", conditional: "Dopuszczony warunkowo", substitute: "Zamień na", excluded: "Nie używamy" };
const isReviewer = () => ["admin", "reviewer"].includes(state.role);

function words(text) {
  return foldText(text).split(" ").filter(Boolean).map((word) => eggWords.includes(word) ? "jajko" : word);
}

function searchStem(word) {
  if (word === "jajko") return word;
  const suffixes = ["owie", "ami", "ach", "ów", "ow", "om", "ie", "y", "i", "a", "e"];
  const suffix = suffixes.find((item) => word.endsWith(item) && word.length - item.length >= 4);
  return suffix ? word.slice(0, -suffix.length) : word;
}

function searchWords(text) {
  return words(text).map(searchStem).filter(Boolean);
}

function ingredientMatchesPhrase(ingredient, phrase) {
  const phraseWords = searchWords(phrase);
  if (!phraseWords.length) return true;
  const ingredientWords = searchWords(ingredient);
  return phraseWords.every((phraseWord) => ingredientWords.some((ingredientWord) =>
    ingredientWord === phraseWord || ingredientWord.startsWith(phraseWord) || phraseWord.startsWith(ingredientWord)
  ));
}

function hasTerm(ingredient, terms) {
  const value = foldText(ingredient);
  return terms.some((term) => value.includes(term));
}

function isPlainSalt(ingredient) {
  const value = foldText(ingredient);
  return saltTerms.some((term) => value === term || value.startsWith(`${term} `));
}

function hasCasein(ingredient) {
  const value = foldText(ingredient);
  if (value.includes("maslo") && (value.includes("nerkow") || value.includes("orzech"))) return false;
  return caseinTerms.some((term) => value.includes(term));
}

function bestProductMatches(products, ingredient) {
  const ingredientWords = [...new Set(words(ingredient).filter((word) => word.length >= 3))];
  if (!ingredientWords.length) return [];
  const candidates = products.map((product) => {
    const productWords = [...new Set(words(product.polishName).filter((word) => word.length >= 3))];
    const matchCount = ingredientWords.filter((word) => productWords.some((candidate) =>
      word === candidate || (word.length >= 5 && candidate.length >= 5 && (word.startsWith(candidate) || candidate.startsWith(word)))
    )).length;
    return { product, matchCount, coverage: productWords.length ? matchCount / productWords.length : 0 };
  }).filter((candidate) => candidate.matchCount > 0);
  if (!candidates.length) return [];
  const bestMatchCount = Math.max(...candidates.map((candidate) => candidate.matchCount));
  const byMatchCount = candidates.filter((candidate) => candidate.matchCount === bestMatchCount);
  const bestCoverage = Math.max(...byMatchCount.map((candidate) => candidate.coverage));
  return byMatchCount.filter((candidate) => candidate.coverage === bestCoverage).map((candidate) => candidate.product);
}

async function getHistamineProducts() {
  if (state.histamineProducts) return state.histamineProducts;
  const snapshot = await getDocs(collection(db, "histamineProducts"));
  state.histamineProducts = snapshot.docs.map((item) => item.data());
  return state.histamineProducts;
}

async function getIngredientRules() {
  if (state.ingredientRules) return state.ingredientRules;
  const snapshot = await getDocs(collection(db, "ingredientRules"));
  state.ingredientRules = snapshot.docs.map((item) => ({ id: item.id, ...item.data() }));
  return state.ingredientRules;
}

function ruleForIngredient(rules, ingredient) {
  const key = searchWords(ingredient).join(" ");
  return rules.find((rule) => rule.key === key) || null;
}

function familyRuleMessage(ingredient, rule) {
  const note = rule.note ? ` — ${rule.note}` : "";
  if (rule.status === "substitute") return `${ingredient} → zamień na: ${rule.replacement || "ustalony zamiennik"}${note}`;
  if (rule.status === "conditional") return `${ingredient} — tylko warunkowo${note}`;
  if (rule.status === "allowed") return `${ingredient} — dopuszczone${note}`;
  return `${ingredient} — nie używamy${note}`;
}

function recipeForFamily(recipe) {
  const familyRecipe = recipe.familyRecipe;
  if (familyRecipe?.title && Array.isArray(familyRecipe.ingredients) && Array.isArray(familyRecipe.instructions)) {
    return {
      ...recipe,
      title: familyRecipe.title,
      ingredients: familyRecipe.ingredients,
      instructions: familyRecipe.instructions,
      familyNote: familyRecipe.note || ""
    };
  }
  if (state.person !== "emilka") return recipe;
  const replacements = new Map((recipe.familyIngredients || []).map((item) => [item.source, item.display]));
  return {
    ...recipe,
    ingredients: recipe.ingredients.map((ingredient) => replacements.get(ingredient) || ingredient)
  };
}

function recipeCategories(recipe) {
  const saved = Array.isArray(recipe.categories) ? recipe.categories : [recipe.category];
  return [...new Set(saved.filter((category) => recipeCategoryKeys.includes(category)))];
}

function recipeCategoryLabel(recipe) {
  return recipeCategories(recipe).map((category) => labels[category]).join(" · ") || "Bez kategorii";
}

function evaluateRecipeFor(person, recipe, products, familyRules) {
  if (person === "kasia") {
    const gluten = recipe.ingredients.filter((ingredient) =>
      hasTerm(ingredient, glutenTerms) && !foldText(ingredient).includes("bezgluten")
    );
    return gluten.length ? { visible: false, canOverride: false, reasons: [`gluten: ${gluten.join(", ")}`] } : { visible: true, canOverride: false, warnings: [] };
  }

  const blocked = [];
  const warnings = [];
  const familyNotes = [];
  const unknown = [];
  const ratings = [];
  recipe.ingredients.forEach((ingredient) => {
    const familyRule = ruleForIngredient(familyRules, ingredient);
    if (familyRule) {
      const message = familyRuleMessage(ingredient, familyRule);
      if (familyRule.status === "excluded") blocked.push(message);
      else familyNotes.push(message);
      return;
    }
    if (isPlainSalt(ingredient)) return; // Zasada rodziny: sól oznacza sól niejodowaną.
    if (hasTerm(ingredient, glutenTerms) && !foldText(ingredient).includes("bezgluten")) blocked.push(`${ingredient} — gluten`);
    if (hasCasein(ingredient)) blocked.push(`${ingredient} — kazeina`);
    const matches = bestProductMatches(products, ingredient);
    if (!matches.length) {
      unknown.push(ingredient);
      return;
    }
    const productRatings = [...new Set(matches.map((product) => product.rating).filter(Boolean))];
    ratings.push(...productRatings);
    const excludedRatings = productRatings.filter((rating) => rating === "2" || rating === "3");
    if (excludedRatings.length) {
      blocked.push(`${ingredient} — ocena ${excludedRatings.map((rating) => ratingLabels[rating]).join(", ")}`);
      return;
    }
    if (productRatings.includes("1")) warnings.push(`${ingredient} — OCENA PRODUKTU: UMIARKOWANA`);
    if (productRatings.includes("?")) warnings.push(`${ingredient} — OCENA PRODUKTU: BRAK DANYCH`);
    const symbols = matches.flatMap((product) => Object.values(product.symbols || {}));
    if (symbols.includes("H!")) warnings.push(`${ingredient} — H! użyj bardzo świeżego i spożyj od razu`);
    if (symbols.includes("?")) warnings.push(`${ingredient} — ?`);
  });
  if (blocked.length) return { visible: false, canOverride: false, reasons: blocked, familyNotes };
  if (unknown.length) return { visible: false, canOverride: true, reasons: unknown.map((item) => `${item} — brak potwierdzenia w bazie`), familyNotes };
  const strongestRating = ["1", "?", "0"].find((rating) => ratings.includes(rating));
  return { visible: true, canOverride: false, warnings, familyNotes, ratingLabel: strongestRating ? ratingLabels[strongestRating] : "BRAK DANYCH" };
}

const reviewLabels = { approved: "Dopuszczone", excluded: "Wykluczone", check: "Wymaga sprawdzenia" };
function reviewControls(recipeId, canApprove = true, reasons = [], ingredients = [], title = "") {
  if (!["admin", "reviewer"].includes(state.role)) return "";
  const encodedDetails = encodeURIComponent(JSON.stringify({
    recipeId,
    title,
    reasons: reasons.length ? reasons : ["Ten przepis wymaga sprawdzenia przez Kasię."],
    ingredients
  }));
  return `<div class="review-actions">
    ${canApprove ? `<button type="button" data-review="approved" data-recipe-id="${recipeId}" data-publish-details="${encodedDetails}">Opublikuj</button>` : ""}
    <button type="button" data-review="check" data-recipe-id="${recipeId}" data-review-details="${encodedDetails}">Sprawdź</button>
    <button type="button" data-review="excluded" data-recipe-id="${recipeId}">Nie publikuj</button>
  </div>`;
}

function recipeCard(recipe, evaluation, review) {
  const ingredients = recipe.ingredients.map((item) => `<li>${escapeHtml(item)}</li>`).join("");
  const instructions = (recipe.instructions || []).map((item) => `<li>${escapeHtml(item)}</li>`).join("");
  const rawNote = recipe.note || "Sprawdź składniki przed przygotowaniem.";
  const note = /obsługiwane przez zasadę rodzinną|obsługiwane przez ustalenie dietetyczne/i.test(rawNote) ? "" : rawNote;
  const familyNotes = (evaluation.familyNotes || []).map(escapeHtml).join("<br>");
  const recipeStatus = recipe.needsRepublish ? "Wymaga ponownej publikacji" : review?.status === "approved" ? "Dopuszczony przez Kasię" : "Wymaga oceny Kasi";
  const time = recipe.timeMinutes ? `<span>${recipe.timeMinutes} min</span>` : "";
  const controls = reviewControls(recipe.id, true, evaluation.warnings || [], recipe.ingredients, recipe.title);
  const editorView = isReviewer();
  const familyVersion = encodeURIComponent(JSON.stringify({
    id: recipe.id,
    title: recipe.title,
    ingredients: recipe.ingredients,
    familyIngredients: recipe.familyIngredients || [],
    familyRecipe: recipe.familyRecipe || null,
    instructions: recipe.instructions || [],
    note: recipe.note || "",
    categories: recipeCategories(recipe)
  }));
  const familyPreview = recipe.familyRecipe ? encodeURIComponent(JSON.stringify({
    recipeId: recipe.id,
    title: recipe.familyRecipe.title,
    categories: recipeCategories(recipe),
    ingredients: recipe.familyRecipe.ingredients,
    instructions: recipe.familyRecipe.instructions,
    note: recipe.familyRecipe.note || "",
    reasons: evaluation.warnings || []
  })) : "";
  return `<article class="recipe-card">
    <div class="recipe-card__top"><h2>${escapeHtml(recipe.title)}</h2>${time}</div>
    ${editorView ? `<p class="review">${recipeStatus}</p>` : ""}
    ${editorView && evaluation.warnings?.length ? `<section class="ingredient-alert"><span>Do sprawdzenia przed decyzją Kasi</span><p>${evaluation.warnings.map(escapeHtml).join("<br>")}</p></section>` : ""}
    ${editorView && familyNotes ? `<section class="kasia-assessment"><span>Podpowiedzi dla Kasi</span><p>Na podstawie wcześniejszych ustaleń:</p><ul><li>${familyNotes.replaceAll("<br>", "</li><li>")}</li></ul></section>` : ""}
    ${editorView && note ? `<p class="recipe-note">${escapeHtml(note)}</p>` : ""}
    ${!editorView && recipe.familyNote ? `<p class="family-note"><b>Wskazówka Kasi:</b> ${escapeHtml(recipe.familyNote)}</p>` : ""}
    <details><summary>Składniki</summary><ul>${ingredients}</ul></details>
    ${instructions ? `<details><summary>Przygotowanie</summary><ol>${instructions}</ol></details>` : ""}
    ${editorView ? (recipe.sourceUrl ? `<p class="recipe-source">Źródło: <a href="${recipe.sourceUrl}" target="_blank" rel="noopener noreferrer">${escapeHtml(recipe.publisher)}</a></p>` : `<p class="recipe-source">Źródło: ${escapeHtml(recipe.sourceLabel || recipe.publisher || "Prywatna biblioteka rodzinna")}</p>`) : ""}
    ${editorView ? `<button class="family-version-button" type="button" data-family-version="${familyVersion}">Edytuj wersję dla rodziny</button>${familyPreview ? `<button class="family-preview-button" type="button" data-family-preview="${familyPreview}">Podgląd dla rodziny</button>` : ""}` : ""}
    ${editorView ? controls : ""}
  </article>`;
}

function reviewQueue(items) {
  if (!["admin", "reviewer"].includes(state.role) || !items.length) return "";
  const cards = items.map(({ recipe, evaluation }) => `<li><b>${recipe.title}</b><br>${evaluation.reasons.join("; ")}${reviewControls(recipe.id, evaluation.canOverride, evaluation.reasons, recipe.ingredients, recipe.title)}</li>`).join("");
  return `<details class="admin-diagnostics"><summary>Przepisy wymagające oceny (${items.length})</summary><ul>${cards}</ul></details>`;
}

async function getRecipeReviews() {
  const snapshot = await getDocs(collection(db, "recipeReviews"));
  return Object.fromEntries(snapshot.docs.map((item) => [item.id, item.data()]));
}

async function getQueueRecipes() {
  const [recipesSnapshot, reviews] = await Promise.all([getDocs(collection(db, "recipes")), getRecipeReviews()]);
  return recipesSnapshot.docs.map((item) => item.data()).filter((recipe) => !recipe.familyReady && reviews[recipe.id]?.status !== "excluded");
}

async function refreshQueueCount() {
  if (!isReviewer()) return;
  const button = document.getElementById("review-queue-button");
  try {
    const recipes = await getQueueRecipes();
    button.textContent = `Kolejka (${recipes.length})`;
    button.hidden = false;
  } catch {
    button.hidden = true;
  }
}

async function renderReviewQueue() {
  const list = document.getElementById("queue-list");
  list.innerHTML = "<p class=\"message\">Pobieram kolejkę…</p>";
  try {
    const recipes = await getQueueRecipes();
    if (!recipes.length) {
      list.innerHTML = "<p class=\"empty\">Nie ma przepisów oczekujących na opracowanie.</p>";
      return;
    }
    list.innerHTML = recipes.sort((left, right) => left.title.localeCompare(right.title, "pl")).map((recipe) => `<article class="queue-card">
      <h2>${escapeHtml(recipe.title)}</h2>
      <p>${recipeCategoryLabel(recipe)}</p>
      <button class="primary" type="button" data-queue-recipe-id="${recipe.id}" data-queue-category="${recipeCategories(recipe)[0] || "sniadanie"}">Opracuj przepis</button>
    </article>`).join("");
  } catch {
    list.innerHTML = "<p class=\"empty\">Nie udało się pobrać kolejki.</p>";
  }
}

async function searchRecipes() {
  const list = document.getElementById("recipe-list");
  list.className = "empty";
  list.textContent = "Szukam przepisów…";
  try {
    const recipeQuery = isReviewer()
      ? query(collection(db, "recipes"))
      : query(collection(db, "recipes"), where("familyReady", "==", true));
    const snapshot = await getDocs(recipeQuery);
    const phrase = normalize(document.getElementById("ingredient").value);
    const found = snapshot.docs.map((item) => item.data()).filter((recipe) =>
      recipeCategories(recipe).includes(state.category) && (state.queueRecipeId ? recipe.id === state.queueRecipeId : (!phrase || recipe.ingredients.some((ingredient) => ingredientMatchesPhrase(ingredient, phrase))) )
    );
    const products = isReviewer() && state.person === "emilka" ? await getHistamineProducts() : [];
    const familyRules = state.person === "emilka" ? await getIngredientRules() : [];
    const reviews = isReviewer() ? await getRecipeReviews() : {};
    const evaluated = found.map((recipe) => {
      if (!isReviewer()) return {
        recipe,
        displayRecipe: recipeForFamily(recipe),
        evaluation: { visible: true, warnings: [], familyNotes: [] },
        review: null
      };
      const evaluation = evaluateRecipeFor(state.person, recipe, products, familyRules);
      const review = reviews[recipe.id];
      if (review?.status === "excluded") return { recipe, evaluation: { visible: false, canOverride: false, reasons: ["wykluczony decyzją Kasi"] }, review };
      if (review?.status === "approved" && evaluation.canOverride) {
        return { recipe, evaluation: { ...evaluation, visible: true, warnings: [...(evaluation.warnings || []), "dopuszczony decyzją Kasi"], ratingLabel: "DOPUSZCZONY" }, review };
      }
      return { recipe, evaluation, review };
    });
    const recipes = evaluated.filter((item) => item.evaluation.visible).sort((left, right) => left.recipe.title.localeCompare(right.recipe.title, "pl"));
    if (!recipes.length) {
      const baseMessage = !isReviewer()
        ? "Kasia nie opublikowała jeszcze gotowego przepisu w tej kategorii."
        : phrase
        ? "Nie znaleziono przepisu z tym składnikiem w tej kategorii."
        : "W tej kategorii nie ma jeszcze przepisów testowych.";
      if (state.person === "emilka" && found.length) {
        const message = `Nie pokazano ${found.length} przepisów: zawierają produkt z oceną „NIEZGODNE” lub „BARDZO ŹLE”, gluten, kazeinę albo składnik bez bezpośredniego potwierdzenia w bazie Histamina.`;
        if (["admin", "reviewer"].includes(state.role)) {
          list.className = "recipe-list";
          list.innerHTML = `<p class="filter-note">${message}</p>${reviewQueue(evaluated)}`;
        } else {
          list.className = "empty";
          list.textContent = message;
        }
      } else {
        list.className = "empty";
        list.textContent = baseMessage;
      }
      return;
    }
    list.className = "recipe-list";
    const excluded = evaluated.length - recipes.length;
    const reviewItems = evaluated.filter((item) => !item.evaluation.visible);
    list.innerHTML = `${isReviewer() && state.person === "emilka" && excluded ? `<p class="filter-note">Ukryto ${excluded} przepisów niespełniających zasad Emilki.</p>` : ""}${recipes.map((item) => recipeCard(item.displayRecipe || item.recipe, item.evaluation, item.review)).join("")}${reviewQueue(reviewItems)}`;
  } catch {
    list.className = "empty";
    list.textContent = "Nie udało się pobrać prywatnej bazy. Spróbuj ponownie.";
  }
}

async function getAccess(user) {
  if (!user.email) return false;
  const access = await getDoc(doc(db, "allowedUsers", user.email));
  return access.exists() ? access.data() : null;
}

async function loadPortrait(person) {
  const portrait = document.getElementById(`portrait-${person}`);
  for (const filename of [`${person}.jpg`, `${person}.jpeg`, `${person}.png`]) {
    try {
      const url = await getDownloadURL(ref(storage, `portraits/${filename}`));
      portrait.style.backgroundImage = `url("${url}")`;
      portrait.classList.add("has-image");
      portrait.textContent = "";
      return;
    } catch {
      // Try the next accepted image extension.
    }
  }
  // The portrait has not been uploaded yet; leave the neutral placeholder visible.
}

onAuthStateChanged(auth, async (user) => {
  if (!user) { state.user = null; show("login"); return; }
  setLoginMessage("Sprawdzam dostęp…");
  try {
    const access = await getAccess(user);
    if (!access) {
      await signOut(auth);
      setLoginMessage("Ten adres Google nie ma dostępu do aplikacji.");
      return;
    }
    state.user = user;
    state.role = access.role;
    document.getElementById("account-name").textContent = user.email;
    document.getElementById("portrait-admin").hidden = access.role !== "admin";
    document.getElementById("family-rules-button").hidden = !["admin", "reviewer"].includes(access.role);
    await refreshQueueCount();
    loadPortrait("emilka");
    loadPortrait("kasia");
    show("people");
  } catch {
    await signOut(auth);
    setLoginMessage("Nie udało się sprawdzić dostępu. Spróbuj ponownie.");
  }
});

document.getElementById("login-button").addEventListener("click", async () => {
  setLoginMessage("");
  try { await signInWithPopup(auth, new GoogleAuthProvider()); }
  catch (error) { setLoginMessage(error.code === "auth/popup-closed-by-user" ? "Logowanie zostało anulowane." : "Nie udało się zalogować. Spróbuj ponownie."); }
});

document.getElementById("logout-button").addEventListener("click", () => signOut(auth));
function escapeHtml(text) {
  return String(text || "").replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]);
}

function ruleId(ingredient) {
  return `rule-${foldText(ingredient).replace(/\s+/g, "-")}`;
}

async function saveIngredientRule(rule) {
  await setDoc(doc(db, "ingredientRules", ruleId(rule.ingredient)), {
    ...rule,
    key: searchWords(rule.ingredient).join(" "),
    updatedBy: state.user.email,
    updatedAt: serverTimestamp()
  });
  state.ingredientRules = null;
}

async function renderIngredientRules() {
  const list = document.getElementById("rules-list");
  list.textContent = "Pobieram zasady…";
  try {
    const rules = await getIngredientRules();
    if (!rules.length) {
      list.innerHTML = "<p class=\"message\">Nie ma jeszcze zapisanych zasad. Możesz dodać własną albo wczytać ustalone przykłady.</p>";
      return;
    }
    list.innerHTML = rules.sort((left, right) => left.ingredient.localeCompare(right.ingredient, "pl")).map((rule) => `<article class="rule-card">
      <h2>${escapeHtml(rule.ingredient)}</h2>
      <p class="rule-card__status">${ruleStatusLabels[rule.status] || "Ustalono"}${rule.replacement ? `: ${escapeHtml(rule.replacement)}` : ""}</p>
      ${rule.note ? `<p>${escapeHtml(rule.note)}</p>` : ""}
      <button class="secondary" type="button" data-edit-rule="${escapeHtml(rule.id)}">Edytuj</button>
    </article>`).join("");
  } catch {
    list.textContent = "Nie udało się pobrać zasad składników.";
  }
}

async function openRulesScreen(returnScreen = "people", ingredient = "") {
  state.rulesReturnScreen = returnScreen;
  document.querySelector("#rules-screen [data-back]").dataset.back = returnScreen;
  document.getElementById("ingredient-rule-form").reset();
  document.getElementById("rule-message").textContent = ingredient ? `Ustal zasadę dla składnika: ${ingredient}.` : "";
  document.getElementById("rule-ingredient").value = ingredient;
  show("rules");
  await renderIngredientRules();
  if (ingredient) document.getElementById("rule-ingredient").focus();
}

document.getElementById("family-rules-button").addEventListener("click", async () => {
  await openRulesScreen();
});
document.getElementById("review-queue-button").addEventListener("click", async () => {
  show("queue");
  await renderReviewQueue();
});
document.getElementById("queue-list").addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-queue-recipe-id]");
  if (!button || !isReviewer()) return;
  state.person = "emilka";
  state.category = button.dataset.queueCategory;
  state.queueRecipeId = button.dataset.queueRecipeId;
  document.getElementById("results-title").textContent = "Opracowanie przepisu";
  document.getElementById("result-summary").textContent = `Emilka · ${labels[state.category]}`;
  show("results");
  await searchRecipes();
});
document.getElementById("ingredient-rule-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!["admin", "reviewer"].includes(state.role)) return;
  const message = document.getElementById("rule-message");
  const rule = {
    ingredient: document.getElementById("rule-ingredient").value.trim(),
    status: document.getElementById("rule-status").value,
    replacement: document.getElementById("rule-replacement").value.trim(),
    note: document.getElementById("rule-note").value.trim()
  };
  if (!rule.ingredient) return;
  message.textContent = "Zapisuję zasadę…";
  try {
    await saveIngredientRule(rule);
    event.target.reset();
    message.textContent = "Ustalenie dietetyczne Emilki zostało zapisane.";
    await renderIngredientRules();
  } catch {
    message.textContent = "Nie udało się zapisać zasady.";
  }
});
document.getElementById("rules-list").addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-edit-rule]");
  if (!button) return;
  const rule = (await getIngredientRules()).find((item) => item.id === button.dataset.editRule);
  if (!rule) return;
  document.getElementById("rule-ingredient").value = rule.ingredient;
  document.getElementById("rule-status").value = rule.status;
  document.getElementById("rule-replacement").value = rule.replacement || "";
  document.getElementById("rule-note").value = rule.note || "";
  document.getElementById("rule-ingredient").focus();
  window.scrollTo({ top: 0, behavior: "smooth" });
});
document.getElementById("seed-agreed-rules").addEventListener("click", async () => {
  if (!["admin", "reviewer"].includes(state.role)) return;
  const message = document.getElementById("rule-message");
  const agreedRules = [
    { ingredient: "masło", status: "substitute", replacement: "masło klarowane", note: "Zwykłego masła nie używamy." },
    { ingredient: "masło klarowane", status: "allowed", replacement: "", note: "Dopuszczone przez dietetyka." },
    { ingredient: "mleko", status: "substitute", replacement: "mleko kokosowe", note: "Zwykłe mleko zastępujemy mlekiem kokosowym." },
    { ingredient: "sól", status: "substitute", replacement: "sól niejodowana", note: "Używamy soli niejodowanej." }
  ];
  message.textContent = "Zapisuję ustalone zasady…";
  try {
    for (const rule of agreedRules) await saveIngredientRule(rule);
    message.textContent = "Dodano cztery ustalenia dietetyczne Emilki.";
    await renderIngredientRules();
  } catch {
    message.textContent = "Nie udało się dodać ustalonych zasad.";
  }
});
function openReviewDialog(details) {
  const reasons = details.reasons || ["Ten przepis wymaga sprawdzenia przez Kasię."];
  document.getElementById("review-dialog-reasons").textContent = reasons.join("; ");
  const ingredientsList = document.getElementById("review-dialog-ingredients");
  ingredientsList.replaceChildren(...(details.ingredients || []).map((ingredient) => {
    const item = document.createElement("li");
    item.textContent = ingredient;
    if (reasons.some((reason) => reason.startsWith(`${ingredient} —`))) {
      item.classList.add("is-questionable");
      const ruleButton = document.createElement("button");
      ruleButton.type = "button";
      ruleButton.className = "rule-from-review";
      ruleButton.dataset.ruleIngredient = ingredient;
      ruleButton.textContent = "Ustal zasadę";
      item.append(document.createElement("br"), ruleButton);
    }
    return item;
  }));
  document.getElementById("review-dialog").dataset.recipeId = details.recipeId || "";
  document.getElementById("review-dialog").dataset.publishDetails = encodeURIComponent(JSON.stringify(details));
  document.getElementById("review-dialog").showModal();
}

function openPublishDialog(details) {
  const dialog = document.getElementById("publish-dialog");
  const checks = document.getElementById("publish-dialog-checks");
  const confirmation = document.getElementById("publish-dialog-confirmation");
  document.getElementById("publish-dialog-recipe").textContent = details.title || "Wybrany przepis";
  checks.replaceChildren();
  const addCheck = (text, attention = false) => {
    const item = document.createElement("li");
    item.textContent = text;
    if (attention) item.classList.add("needs-attention");
    checks.append(item);
  };
  addCheck(`Składniki w przepisie: ${(details.ingredients || []).length}.`);
  if (details.reasons?.length) details.reasons.forEach((reason) => addCheck(`Wymaga świadomej decyzji Kasi: ${reason}`, true));
  else addCheck("Nie wykryto automatycznych wątpliwości wymagających decyzji.");
  addCheck("Przed publikacją potwierdź, że zamienniki i warunki są już gotowe dla rodziny.");
  confirmation.checked = false;
  document.getElementById("publish-dialog-confirm").disabled = true;
  dialog.dataset.recipeId = details.recipeId || "";
  dialog.showModal();
}

async function publishRecipe(recipeId) {
  await setDoc(doc(db, "recipeReviews", recipeId), {
    status: "approved",
    reviewedBy: state.user.email,
    reviewedAt: serverTimestamp()
  });
  await setDoc(doc(db, "recipes", recipeId), {
    familyReady: true,
    needsRepublish: false,
    publishedBy: state.user.email,
    publishedAt: serverTimestamp()
  }, { merge: true });
}

document.getElementById("review-dialog").addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-rule-ingredient]");
  if (!button || !["admin", "reviewer"].includes(state.role)) return;
  document.getElementById("review-dialog").close();
  await openRulesScreen("results", button.dataset.ruleIngredient);
});

async function openFamilyVersionDialog(details) {
  const dialog = document.getElementById("family-version-dialog");
  const familyRecipe = details.familyRecipe || {};
  const saved = new Map((details.familyIngredients || []).map((item) => [item.source, item.display]));
  const categories = details.categories?.length ? details.categories : ["kolacja_przekaska"];
  document.getElementById("family-version-recipe").textContent = details.title;
  document.getElementById("family-version-message").textContent = "";
  document.getElementById("family-version-recipe-title").value = familyRecipe.title || details.title;
  const initialIngredients = Array.isArray(familyRecipe.ingredients)
    ? familyRecipe.ingredients
    : details.ingredients.map((ingredient) => saved.get(ingredient) || ingredient);
  document.getElementById("family-version-ingredients").value = initialIngredients.join("\n");
  document.getElementById("family-version-instructions").value = (familyRecipe.instructions || details.instructions || []).join("\n");
  document.getElementById("family-version-note").value = familyRecipe.note || "";
  const categoryOptions = document.getElementById("family-version-category-options");
  categoryOptions.replaceChildren(...recipeCategoryKeys.map((category) => {
    const label = document.createElement("label");
    label.className = "family-category-option";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.value = category;
    input.checked = categories.includes(category);
    input.name = "recipe-category";
    label.append(input, document.createTextNode(labels[category]));
    return label;
  }));
  dialog.dataset.recipeId = details.id;
  dialog.showModal();
}

function openFamilyPreviewDialog(details) {
  const dialog = document.getElementById("family-preview-dialog");
  document.getElementById("family-preview-categories").textContent = details.categories.map((category) => labels[category]).join(" · ");
  document.getElementById("family-preview-recipe-title").textContent = details.title;
  document.getElementById("family-preview-ingredients").replaceChildren(...details.ingredients.map((ingredient) => {
    const item = document.createElement("li");
    item.textContent = ingredient;
    return item;
  }));
  document.getElementById("family-preview-instructions").replaceChildren(...details.instructions.map((instruction) => {
    const item = document.createElement("li");
    item.textContent = instruction;
    return item;
  }));
  const note = document.getElementById("family-preview-note");
  note.textContent = details.note ? `Wskazówka Kasi: ${details.note}` : "";
  note.hidden = !details.note;
  dialog.dataset.publishDetails = encodeURIComponent(JSON.stringify(details));
  dialog.showModal();
}

document.getElementById("recipe-list").addEventListener("click", async (event) => {
  const familyPreviewButton = event.target.closest("button[data-family-preview]");
  if (familyPreviewButton && isReviewer()) {
    openFamilyPreviewDialog(JSON.parse(decodeURIComponent(familyPreviewButton.dataset.familyPreview || "{}")));
    return;
  }
  const familyVersionButton = event.target.closest("button[data-family-version]");
  if (familyVersionButton && isReviewer()) {
    await openFamilyVersionDialog(JSON.parse(decodeURIComponent(familyVersionButton.dataset.familyVersion || "{}")));
    return;
  }
  const button = event.target.closest("button[data-review]");
  if (!button || !["admin", "reviewer"].includes(state.role)) return;
  if (button.dataset.review === "check") {
    openReviewDialog(JSON.parse(decodeURIComponent(button.dataset.reviewDetails || "{}")));
    return;
  }
  if (button.dataset.review === "approved") {
    openPublishDialog(JSON.parse(decodeURIComponent(button.dataset.publishDetails || "{}")));
    return;
  }
  button.disabled = true;
  try {
    await setDoc(doc(db, "recipeReviews", button.dataset.recipeId), {
      status: button.dataset.review,
      reviewedBy: state.user.email,
      reviewedAt: serverTimestamp()
    });
    await setDoc(doc(db, "recipes", button.dataset.recipeId), {
      familyReady: button.dataset.review === "approved",
      publishedBy: state.user.email,
      publishedAt: serverTimestamp()
    }, { merge: true });
    await searchRecipes();
    await refreshQueueCount();
  } finally {
    button.disabled = false;
  }
});
document.getElementById("review-dialog-later").addEventListener("click", () => document.getElementById("review-dialog").close());
document.getElementById("review-dialog-actions").addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-dialog-review]");
  if (!button) return;
  const dialog = document.getElementById("review-dialog");
  const recipeId = dialog.dataset.recipeId;
  if (!recipeId) return;
  if (button.dataset.dialogReview === "approved") {
    dialog.close();
    openPublishDialog(JSON.parse(decodeURIComponent(dialog.dataset.publishDetails || "{}")));
    return;
  }
  button.disabled = true;
  try {
    await setDoc(doc(db, "recipeReviews", recipeId), {
      status: button.dataset.dialogReview,
      reviewedBy: state.user.email,
      reviewedAt: serverTimestamp()
    });
    await setDoc(doc(db, "recipes", recipeId), {
      familyReady: button.dataset.dialogReview === "approved",
      publishedBy: state.user.email,
      publishedAt: serverTimestamp()
    }, { merge: true });
    dialog.close();
    await searchRecipes();
    await refreshQueueCount();
  } finally {
    button.disabled = false;
  }
});
document.getElementById("publish-dialog-confirmation").addEventListener("change", (event) => {
  document.getElementById("publish-dialog-confirm").disabled = !event.target.checked;
});
document.getElementById("publish-dialog-back").addEventListener("click", () => document.getElementById("publish-dialog").close());
document.getElementById("publish-dialog-confirm").addEventListener("click", async (event) => {
  const dialog = document.getElementById("publish-dialog");
  const recipeId = dialog.dataset.recipeId;
  if (!recipeId) return;
  event.target.disabled = true;
  try {
    await publishRecipe(recipeId);
    dialog.close();
    await searchRecipes();
    await refreshQueueCount();
  } finally {
    event.target.disabled = false;
  }
});
document.getElementById("family-version-close").addEventListener("click", () => document.getElementById("family-version-dialog").close());
document.getElementById("family-preview-close").addEventListener("click", () => document.getElementById("family-preview-dialog").close());
document.getElementById("family-preview-publish").addEventListener("click", () => {
  const dialog = document.getElementById("family-preview-dialog");
  dialog.close();
  openPublishDialog(JSON.parse(decodeURIComponent(dialog.dataset.publishDetails || "{}")));
});
document.getElementById("family-version-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const dialog = document.getElementById("family-version-dialog");
  const recipeId = dialog.dataset.recipeId;
  const message = document.getElementById("family-version-message");
  if (!recipeId) return;
  const title = document.getElementById("family-version-recipe-title").value.trim();
  const ingredients = document.getElementById("family-version-ingredients").value.split("\n").map((item) => item.trim()).filter(Boolean);
  const instructions = document.getElementById("family-version-instructions").value.split("\n").map((item) => item.trim()).filter(Boolean);
  const note = document.getElementById("family-version-note").value.trim();
  const categories = [...document.querySelectorAll("#family-version-category-options input:checked")].map((input) => input.value);
  if (!title || !ingredients.length || !instructions.length || !categories.length) {
    message.textContent = "Uzupełnij nazwę, składniki, przygotowanie oraz przynajmniej jedną kategorię.";
    return;
  }
  message.textContent = "Zapisuję wersję dla rodziny…";
  try {
    await setDoc(doc(db, "recipes", recipeId), {
      familyRecipe: { title, ingredients, instructions, note },
      categories,
      category: categories[0],
      familyReady: false,
      needsRepublish: true,
      updatedBy: state.user.email,
      updatedAt: serverTimestamp()
    }, { merge: true });
    dialog.close();
    await searchRecipes();
  } catch {
    message.textContent = "Nie udało się zapisać wersji dla rodziny.";
  }
});
document.getElementById("seed-recipes").addEventListener("click", async () => {
  const message = document.getElementById("portrait-message");
  if (state.role !== "admin") return;
  message.textContent = "Sprawdzam prywatną bazę przepisów…";
  try {
    const existing = await getDocs(query(collection(db, "recipes")));
    const existingIds = new Set(existing.docs.map((recipe) => recipe.id));
    const missingRecipes = recipeSeed.filter((recipe) => !existingIds.has(recipe.id));
    if (!missingRecipes.length) {
      message.textContent = "Masz już aktualną pulę kandydatów do oceny.";
      return;
    }
    const batch = writeBatch(db);
    missingRecipes.forEach((recipe) => batch.set(doc(db, "recipes", recipe.id), recipe));
    await batch.commit();
    message.textContent = `Dodano ${missingRecipes.length} nowych kandydatów do prywatnej bazy.`;
  } catch {
    message.textContent = "Nie udało się uzupełnić bazy. Spróbuj ponownie.";
  }
});
document.getElementById("private-recipe-import").addEventListener("change", async (event) => {
  const input = event.target;
  const file = input.files[0];
  const message = document.getElementById("portrait-message");
  if (!file || state.role !== "admin") return;
  message.textContent = "Sprawdzam prywatny plik przepisów…";
  try {
    const imported = JSON.parse(await file.text());
    if (!Array.isArray(imported) || !imported.length || imported.some((recipe) => !recipe.id || !recipe.title || !Array.isArray(recipe.ingredients))) throw new Error("invalid import");
    for (let offset = 0; offset < imported.length; offset += 400) {
      const batch = writeBatch(db);
      imported.slice(offset, offset + 400).forEach((recipe) => batch.set(doc(db, "recipes", recipe.id), recipe));
      await batch.commit();
    }
    message.textContent = `Dodano ${imported.length} prywatnych przepisów do bazy.`;
  } catch {
    message.textContent = "Nie udało się wczytać pliku przepisów. Wybierz właściwy plik JSON.";
  } finally {
    input.value = "";
  }
});
document.getElementById("import-histamine").addEventListener("click", async () => {
  const message = document.getElementById("portrait-message");
  if (state.role !== "admin") return;
  message.textContent = "Sprawdzam prywatną bazę Histamina…";
  try {
    const existing = await getDocs(query(collection(db, "histamineProducts"), limit(1)));
    if (!existing.empty) {
      message.textContent = "Baza Histamina jest już zaimportowana.";
      return;
    }
    const response = await fetch(histamineSourceUrl);
    if (!response.ok) throw new Error("source unavailable");
    const source = await response.text();
    const start = source.indexOf("const data=") + "const data=".length;
    const end = source.indexOf("];\r\nfunction foldText") >= 0
      ? source.indexOf("];\r\nfunction foldText")
      : source.indexOf("];\nfunction foldText");
    if (start < "const data=".length || end < start) throw new Error("source format changed");
    const products = JSON.parse(source.slice(start, end + 1));
    for (let offset = 0; offset < products.length; offset += 400) {
      const batch = writeBatch(db);
      products.slice(offset, offset + 400).forEach((product, index) => {
        const id = `histamine-${String(offset + index + 1).padStart(4, "0")}`;
        batch.set(doc(db, "histamineProducts", id), {
          polishName: product.polska_nazwa || "",
          englishName: product.angielska_nazwa || "",
          rating: product.ocena || "",
          symbols: product.symbol_columns || {},
          note: product.adnotacja_PL || "",
          sourcePage: product.strona || null
        });
      });
      await batch.commit();
      message.textContent = `Importuję bazę Histamina: ${Math.min(offset + 400, products.length)} z ${products.length} produktów…`;
    }
    message.textContent = `Zaimportowano prywatnie ${products.length} produktów z bazy Histamina.`;
  } catch {
    message.textContent = "Import bazy Histamina nie powiódł się. Spróbuj ponownie.";
  }
});
document.querySelectorAll("[data-portrait-upload]").forEach((input) => input.addEventListener("change", async () => {
  const person = input.dataset.portraitUpload;
  const file = input.files[0];
  const message = document.getElementById("portrait-message");
  if (!file) return;
  if (state.role !== "admin") return;
  if (!file.type.startsWith("image/") || file.size >= 5 * 1024 * 1024) {
    message.textContent = "Wybierz zdjęcie JPG lub PNG mniejsze niż 5 MB.";
    input.value = "";
    return;
  }
  message.textContent = `Przesyłam zdjęcie: ${labels[person]}…`;
  try {
    await uploadBytes(ref(storage, `portraits/${person}.jpg`), file, { contentType: file.type });
    await loadPortrait(person);
    message.textContent = `Zdjęcie ${labels[person]} zostało zapisane prywatnie.`;
  } catch {
    message.textContent = "Nie udało się przesłać zdjęcia. Spróbuj ponownie.";
  } finally {
    input.value = "";
  }
}));
document.querySelectorAll("[data-person]").forEach((button) => button.addEventListener("click", () => {
  state.person = button.dataset.person;
  state.category = null;
  state.queueRecipeId = null;
  document.getElementById("search-title").textContent = labels[state.person];
  document.querySelectorAll(".category").forEach((item) => item.classList.remove("selected"));
  document.getElementById("show-results").disabled = true;
  show("search");
}));
document.querySelectorAll(".category").forEach((button) => button.addEventListener("click", () => {
  state.category = button.dataset.category;
  state.queueRecipeId = null;
  document.querySelectorAll(".category").forEach((item) => item.classList.toggle("selected", item === button));
  document.getElementById("show-results").disabled = false;
}));
document.getElementById("show-results").addEventListener("click", async () => {
  document.getElementById("result-summary").textContent = `${labels[state.person]} · ${labels[state.category]}`;
  show("results");
  await searchRecipes();
});
document.querySelectorAll("[data-back]").forEach((button) => button.addEventListener("click", () => show(button.dataset.back)));
