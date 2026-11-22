import { initializeApp } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-app.js";
import { getAuth, GoogleAuthProvider, onAuthStateChanged, signInWithPopup, signOut } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-auth.js";
import { getFirestore, doc, getDoc } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-firestore.js";
import { getStorage, ref, getDownloadURL } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-storage.js";
import { firebaseConfig } from "./firebase-config.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const storage = getStorage(app);
const state = { person: null, category: null, user: null };
const labels = { emilka: "Emilka", kasia: "Kasia", sniadanie: "Śniadanie", obiad: "Obiad", kolacja_przekaska: "Kolacja / Przekąska" };

const show = (screen) => document.querySelectorAll(".screen").forEach((item) => item.classList.toggle("hidden", item.id !== `${screen}-screen`));
const setLoginMessage = (text) => { document.getElementById("login-message").textContent = text; };

async function hasAccess(user) {
  if (!user.email) return false;
  const access = await getDoc(doc(db, "allowedUsers", user.email));
  return access.exists();
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
    if (!await hasAccess(user)) {
      await signOut(auth);
      setLoginMessage("Ten adres Google nie ma dostępu do aplikacji.");
      return;
    }
    state.user = user;
    document.getElementById("account-name").textContent = user.email;
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
