import { initializeApp } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-app.js";
import { getAuth, GoogleAuthProvider, onAuthStateChanged, signInWithPopup, signOut } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-auth.js";
import { getFirestore, doc, getDoc } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-firestore.js";
import { getStorage, ref, getDownloadURL, uploadBytes } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-storage.js";
import { firebaseConfig } from "./firebase-config.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const storage = getStorage(app);
const state = { person: null, category: null, user: null, role: null };
const labels = { emilka: "Emilka", kasia: "Kasia", sniadanie: "Śniadanie", obiad: "Obiad", kolacja_przekaska: "Kolacja / Przekąska" };

const show = (screen) => document.querySelectorAll(".screen").forEach((item) => item.classList.toggle("hidden", item.id !== `${screen}-screen`));
const setLoginMessage = (text) => { document.getElementById("login-message").textContent = text; };

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
document.getElementById("show-results").addEventListener("click", () => {
  document.getElementById("result-summary").textContent = `${labels[state.person]} · ${labels[state.category]}`;
  show("results");
});
document.querySelectorAll("[data-back]").forEach((button) => button.addEventListener("click", () => show(button.dataset.back)));
