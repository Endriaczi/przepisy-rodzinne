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
const state = { person: null, category: null, user: null, role: null, histamineProducts: null };
const labels = { emilka: "Emilka", kasia: "Kasia", sniadanie: "Śniadanie", obiad: "Obiad", kolacja_przekaska: "Kolacja / Przekąska" };
const histamineSourceUrl = "https://raw.githubusercontent.com/Endriaczi/Histamina/main/script0.js";

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

function words(text) {
  return foldText(text).split(" ").filter(Boolean).map((word) => eggWords.includes(word) ? "jajko" : word);
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

function evaluateRecipeFor(person, recipe, products) {
  if (person === "kasia") {
    const gluten = recipe.ingredients.filter((ingredient) =>
      hasTerm(ingredient, glutenTerms) && !foldText(ingredient).includes("bezgluten")
    );
    return gluten.length ? { visible: false, canOverride: false, reasons: [`gluten: ${gluten.join(", ")}`] } : { visible: true, canOverride: false, warnings: [] };
  }

  const blocked = [];
  const warnings = [];
  const unknown = [];
  const ratings = [];
  recipe.ingredients.forEach((ingredient) => {
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
  if (blocked.length) return { visible: false, canOverride: false, reasons: blocked };
  if (unknown.length) return { visible: false, canOverride: true, reasons: unknown.map((item) => `${item} — brak potwierdzenia w bazie`) };
  const strongestRating = ["1", "?", "0"].find((rating) => ratings.includes(rating));
  return { visible: true, canOverride: false, warnings, ratingLabel: strongestRating ? ratingLabels[strongestRating] : "BRAK DANYCH" };
}

const reviewLabels = { approved: "Dopuszczony przez rodzinę", excluded: "Wykluczony przez rodzinę", check: "Wymaga sprawdzenia przez rodzinę" };
function reviewControls(recipeId, canApprove = true) {
  if (!["admin", "reviewer"].includes(state.role)) return "";
  return `<div class="review-actions">
    ${canApprove ? `<button type="button" data-review="approved" data-recipe-id="${recipeId}">Dopuść</button>` : ""}
    <button type="button" data-review="check" data-recipe-id="${recipeId}">Sprawdź</button>
    <button type="button" data-review="excluded" data-recipe-id="${recipeId}">Wyklucz</button>
  </div>`;
}

function recipeCard(recipe, evaluation, review) {
  const ingredients = recipe.ingredients.map((item) => `<li>${item}</li>`).join("");
  const time = recipe.timeMinutes ? `<span>${recipe.timeMinutes} min</span>` : "";
  const controls = reviewControls(recipe.id);
  return `<article class="recipe-card">
    <div class="recipe-card__top"><h2>${recipe.title}</h2>${time}</div>
    <p class="review">Wymaga weryfikacji diety</p>
    ${evaluation.ratingLabel ? `<p class="product-rating">OCENA PRODUKTU: ${evaluation.ratingLabel}</p>` : ""}
    ${evaluation.warnings?.length ? `<p class="review review--warning">Dopuszczone warunkowo: ${evaluation.warnings.join("; ")}</p>` : ""}
    ${review?.status ? `<p class="family-review">${reviewLabels[review.status]}</p>` : ""}
    <p class="recipe-note">${recipe.note || "Sprawdź składniki przed przygotowaniem."}</p>
    <details><summary>Składniki</summary><ul>${ingredients}</ul></details>
    <p class="recipe-source">Źródło: <a href="${recipe.sourceUrl}" target="_blank" rel="noopener noreferrer">${recipe.publisher}</a></p>
    ${controls}
  </article>`;
}

function reviewQueue(items) {
  if (!["admin", "reviewer"].includes(state.role) || !items.length) return "";
  const cards = items.map(({ recipe, evaluation }) => `<li><b>${recipe.title}</b><br>${evaluation.reasons.join("; ")}${reviewControls(recipe.id, evaluation.canOverride)}</li>`).join("");
  return `<details class="admin-diagnostics"><summary>Przepisy wymagające oceny (${items.length})</summary><ul>${cards}</ul></details>`;
}

async function getRecipeReviews() {
  const snapshot = await getDocs(collection(db, "recipeReviews"));
  return Object.fromEntries(snapshot.docs.map((item) => [item.id, item.data()]));
}

async function searchRecipes() {
  const list = document.getElementById("recipe-list");
  list.className = "empty";
  list.textContent = "Szukam przepisów…";
  try {
    const snapshot = await getDocs(query(collection(db, "recipes"), where("category", "==", state.category)));
    const phrase = normalize(document.getElementById("ingredient").value);
    const found = snapshot.docs.map((item) => item.data()).filter((recipe) =>
      !phrase || recipe.ingredients.some((ingredient) => normalize(ingredient).includes(phrase))
    );
    const products = state.person === "emilka" ? await getHistamineProducts() : [];
    const reviews = await getRecipeReviews();
    const evaluated = found.map((recipe) => {
      const evaluation = evaluateRecipeFor(state.person, recipe, products);
      const review = reviews[recipe.id];
      if (review?.status === "excluded") return { recipe, evaluation: { visible: false, canOverride: false, reasons: ["wykluczony decyzją rodziny"] }, review };
      if (review?.status === "approved" && evaluation.canOverride) {
        return { recipe, evaluation: { ...evaluation, visible: true, warnings: [...(evaluation.warnings || []), "dopuszczony decyzją rodziny"], ratingLabel: "DOPUSZCZONY" }, review };
      }
      return { recipe, evaluation, review };
    });
    const recipes = evaluated.filter((item) => item.evaluation.visible).sort((left, right) => left.recipe.title.localeCompare(right.recipe.title, "pl"));
    if (!recipes.length) {
      const baseMessage = phrase
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
    list.innerHTML = `${state.person === "emilka" && excluded ? `<p class="filter-note">Ukryto ${excluded} przepisów niespełniających zasad Emilki.</p>` : ""}${recipes.map((item) => recipeCard(item.recipe, item.evaluation, item.review)).join("")}${reviewQueue(reviewItems)}`;
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
document.getElementById("recipe-list").addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-review]");
  if (!button || !["admin", "reviewer"].includes(state.role)) return;
  button.disabled = true;
  try {
    await setDoc(doc(db, "recipeReviews", button.dataset.recipeId), {
      status: button.dataset.review,
      reviewedBy: state.user.email,
      reviewedAt: serverTimestamp()
    });
    await searchRecipes();
  } finally {
    button.disabled = false;
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
document.getElementById("show-results").addEventListener("click", async () => {
  document.getElementById("result-summary").textContent = `${labels[state.person]} · ${labels[state.category]}`;
  show("results");
  await searchRecipes();
});
document.querySelectorAll("[data-back]").forEach((button) => button.addEventListener("click", () => show(button.dataset.back)));
